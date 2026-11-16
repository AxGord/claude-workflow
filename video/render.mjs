#!/usr/bin/env node
// Renders the voiced intro video, video/out/intro.mp4 (1920x1080, English narration, burned subtitles), from
// video/script.md (the wording) and video/storyboard.json (what is on screen while each phrase is spoken):
//
//   npm run video [-- --engine kokoro|chatterbox --voice af_heart --sample <file> --fps 20 --only scene --no-burn]
//   npm run video -- --check      validate the two files only: no voice, no browser
//
// 1. every phrase is voiced by video/tts.py into video/cache/<hash>.wav; the hash is of engine + voice + text,
//    so an edited phrase alone is voiced again and the cache survives a UI change;
// 2. the plan: each phrase gets a slot (its audio + the storyboard's gap), a card or a stretch of the replay
//    (`from` plus `speed`, or `from` and `to`, in replay seconds), so the video is exactly as long as the speech;
// 3. the slots are drawn frame by frame (the scene through scripts/scene-capture.mjs, the cards as HTML in the
//    same browser), the phrase audio is laid end to end, intro.srt is written and muxed as a text track, and
//    ffmpeg encodes everything.
//
// Needs what `npm run docs:record` needs (playwright + Chromium, ffmpeg) and the TTS venv of video/README.md.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The narration: `[id] text` lines after the first `##` heading; the preamble, headings and blank lines are for the reader. */
export function parseScript(text) {
  const phrases = [];
  const seen = new Set();
  let body = false;
  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith("## ")) body = true;
    if (!body || line === "" || line.startsWith("#")) return;
    const m = /^\[([A-Za-z0-9_-]+)\]\s+(\S.*)$/.exec(line);
    if (!m) throw new Error(`script.md line ${i + 1}: not a "[id] text" phrase: ${line.slice(0, 60)}`);
    if (seen.has(m[1])) throw new Error(`script.md line ${i + 1}: the id ${m[1]} is used twice`);
    seen.add(m[1]);
    phrases.push({ id: m[1], text: m[2] });
  });
  return phrases;
}

const isNum = v => typeof v === "number" && Number.isFinite(v);

/** The problems of a storyboard against the script (and the replay's length when known); [] when it is sound. */
export function validate(script, storyboard, replayMs) {
  const errors = [];
  const texts = new Map(script.map(p => [p.id, p.text]));
  const used = new Set();
  if (!isNum(storyboard.fps) || storyboard.fps < 1) errors.push("fps must be a positive number");
  if (!isNum(storyboard.gap) || storyboard.gap < 0) errors.push("gap must be a number of seconds, 0 or more");
  const ids = new Set();
  for (const seg of storyboard.segments ?? []) {
    if (ids.has(seg.id)) errors.push(`segment ${seg.id}: the id is used twice`);
    ids.add(seg.id);
    const phrases = seg.phrases ?? [];
    if (phrases.length === 0 && !(isNum(seg.seconds) && seg.seconds > 0)) errors.push(`segment ${seg.id}: no phrases and no seconds`);
    if (phrases.length === 0 && !seg.card) errors.push(`segment ${seg.id}: a silent segment needs a card`);
    for (const ph of phrases) {
      if (!texts.has(ph.id)) errors.push(`segment ${seg.id}: phrase ${ph.id} is not in script.md`);
      if (used.has(ph.id)) errors.push(`segment ${seg.id}: phrase ${ph.id} is placed twice`);
      used.add(ph.id);
      const range = ph.from !== undefined || ph.speed !== undefined || ph.to !== undefined;
      if (seg.card && range) errors.push(`phrase ${ph.id}: a card segment has no replay range`);
      if (!seg.card) {
        const hasSpeed = ph.speed !== undefined;
        if (!isNum(ph.from) || ph.from < 0) errors.push(`phrase ${ph.id}: from (replay seconds) is required`);
        else if (hasSpeed === (ph.to !== undefined)) errors.push(`phrase ${ph.id}: give exactly one of speed and to`);
        else if (hasSpeed && !(isNum(ph.speed) && ph.speed > 0)) errors.push(`phrase ${ph.id}: speed must be positive`);
        else if (ph.to !== undefined && !(isNum(ph.to) && ph.to > ph.from)) errors.push(`phrase ${ph.id}: to must be after from`);
        else if (replayMs !== undefined && Math.max(ph.from, ph.to ?? 0) * 1000 > replayMs) errors.push(`phrase ${ph.id}: past the replay's end (${replayMs / 1000} s)`);
      }
    }
  }
  for (const p of script) if (!used.has(p.id)) errors.push(`phrase ${p.id} is in script.md but in no storyboard segment`);
  return errors;
}

/** The cache key of one voiced phrase: a different engine, voice, speed or text is a different WAV. */
export function phraseHash(voice, text) {
  return createHash("sha256").update(`${voice}\n${text}`).digest("hex").slice(0, 16);
}

/** Seconds of audio in a PCM WAV file. */
export function wavSeconds(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let at = 12;
  let byteRate = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(at + 16);
    if (id === "data") {
      if (byteRate === 0) throw new Error("WAV data before its fmt chunk");
      return Math.min(size, buf.length - at - 8) / byteRate;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("WAV without a data chunk");
}

/**
 * The timeline: one slot per phrase (its audio plus the gap, rounded up to whole frames) or per silent card.
 * `audio` maps a phrase id to the seconds of its WAV. A slot with a replay range carries it, `to` turned into
 * the speed that makes the range last exactly the slot.
 */
export function buildPlan(script, storyboard, audio) {
  const text = new Map(script.map(p => [p.id, p.text]));
  const { fps, gap } = storyboard;
  const slots = [];
  let start = 0;
  const push = slot => {
    slots.push({ ...slot, start, frames: Math.round(slot.dur * fps) });
    start += slot.dur;
  };
  for (const seg of storyboard.segments) {
    if ((seg.phrases ?? []).length === 0) push({ segment: seg.id, card: seg.card, dur: Math.ceil(seg.seconds * fps) / fps });
    for (const ph of seg.phrases ?? []) {
      const speech = audio.get(ph.id);
      if (speech === undefined) throw new Error(`no audio for ${ph.id}`);
      const dur = Math.ceil((speech + gap) * fps) / fps;
      const replay = seg.card ? undefined : { from: ph.from, speed: ph.speed ?? (ph.to - ph.from) / dur };
      push({ segment: seg.id, phrase: ph.id, text: text.get(ph.id), speech, card: seg.card, replay, dur });
    }
  }
  return slots;
}

const stamp = s => {
  const ms = Math.round(s * 1000);
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)},${p(ms % 1000, 3)}`;
};

/** SubRip cues, one per spoken phrase, from the start of its slot to the end of its speech. */
export function toSrt(slots) {
  return slots
    .filter(s => s.text !== undefined)
    .map((s, i) => `${i + 1}\n${stamp(s.start)} --> ${stamp(s.start + s.speech)}\n${s.text}\n`)
    .join("\n");
}

const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A title / end / chapter card as a page of 1920x1080. */
export function cardHtml(card) {
  const lines = (card.lines ?? []).map(l => `<li>${esc(l)}</li>`).join("");
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;width:1920px;height:1080px;background:#0f1117;color:#e8eaf0;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif}
body{display:flex;flex-direction:column;justify-content:center;align-items:center;gap:36px;text-align:center}
h1{font-size:96px;margin:0;font-weight:700;letter-spacing:-1px}
h2{font-size:44px;margin:0;font-weight:400;color:#9aa3b8}
ul{list-style:none;margin:0;padding:0;font-size:46px;line-height:1.7;color:#c9cfdd}
li::before{content:"";display:inline-block;width:14px;height:14px;border-radius:50%;background:#ff6600;margin-right:24px;vertical-align:middle}
</style><h1>${esc(card.title ?? "")}</h1>${card.subtitle ? `<h2>${esc(card.subtitle)}</h2>` : ""}${lines ? `<ul>${lines}</ul>` : ""}`;
}

const CAPTION_STYLE =
  "position:fixed;left:120px;right:120px;bottom:44px;z-index:99999;padding:12px 26px;border-radius:12px;text-align:center;" +
  "font:600 36px/1.3 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#fff;background:rgba(0,0,0,.74)";

function setCaption(page, text) {
  return page.evaluate(
    ([t, style]) => {
      let el = document.getElementById("vo-cap");
      if (!el) {
        el = document.createElement("div");
        el.id = "vo-cap";
        el.style.cssText = style;
        document.body.appendChild(el);
      }
      el.textContent = t;
      el.style.display = t ? "block" : "none";
    },
    [text, CAPTION_STYLE],
  );
}

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const flag = name => process.argv.includes(`--${name}`);

function readInputs() {
  const script = parseScript(fs.readFileSync(path.join(HERE, "script.md"), "utf8"));
  const storyboard = JSON.parse(fs.readFileSync(path.join(HERE, "storyboard.json"), "utf8"));
  const replay = JSON.parse(fs.readFileSync(path.join(HERE, "../docs/public/replay/anyparse.json"), "utf8"));
  return { script, storyboard, replayMs: replay.durationMs };
}

/** The voice that names a WAV: what makes the same text sound different belongs in it. */
function voiceKey(engine, voice, speed, sample) {
  if (engine === "kokoro") return `kokoro:${voice}:${speed}`;
  return `chatterbox:${createHash("sha256").update(fs.readFileSync(sample)).digest("hex").slice(0, 16)}`;
}

function voiceAll(script, engine, voice, speed, sample, cache) {
  const key = voiceKey(engine, voice, speed, sample);
  const hashes = new Map(script.map(p => [p.id, phraseHash(key, p.text)]));
  fs.mkdirSync(cache, { recursive: true });
  const todo = script.filter(p => !fs.existsSync(path.join(cache, `${hashes.get(p.id)}.wav`)));
  console.log(`voice: ${script.length - todo.length} phrases cached, ${todo.length} to voice (${engine})`);
  if (todo.length > 0) {
    const py = path.join(HERE, ".venv/bin/python");
    if (!fs.existsSync(py)) throw new Error("no video/.venv: see video/README.md (python3.12 -m venv video/.venv && video/.venv/bin/pip install -r video/requirements.txt)");
    const jobs = path.join(os.tmpdir(), `video-jobs-${process.pid}.json`);
    fs.writeFileSync(jobs, JSON.stringify(todo.map(p => ({ hash: hashes.get(p.id), text: p.text }))));
    const args = [path.join(HERE, "tts.py"), "--jobs", jobs, "--out", cache, "--engine", engine, "--voice", voice, "--speed", String(speed)];
    if (sample) args.push("--sample", sample);
    const r = spawnSync(py, args, { stdio: "inherit" });
    fs.rmSync(jobs, { force: true });
    if (r.status !== 0) throw new Error("tts.py failed");
  }
  const audio = new Map(script.map(p => [p.id, wavSeconds(fs.readFileSync(path.join(cache, `${hashes.get(p.id)}.wav`)))]));
  return { audio, hashes };
}

async function main() {
  const { script, storyboard, replayMs } = readInputs();
  const errors = validate(script, storyboard, replayMs);
  if (errors.length > 0) {
    console.error(`video: ${errors.length} problem(s):\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  if (flag("check")) {
    console.log(`video: ${script.length} phrases, ${storyboard.segments.length} segments: sound`);
    return;
  }
  const engine = option("engine", "kokoro");
  const voice = option("voice", "af_heart");
  const speed = Number(option("speed", 1));
  const fps = Number(option("fps", storyboard.fps));
  const sample = option("sample", ["wav", "mp3", "m4a", "flac"].map(e => path.join(HERE, `voice-sample.${e}`)).find(f => fs.existsSync(f)));
  if (engine === "chatterbox" && !sample) throw new Error("chatterbox clones a voice: put your sample at video/voice-sample.wav or pass --sample <file>");
  const only = option("only", undefined)?.split(",");
  const cache = path.join(HERE, "cache");
  const out = path.join(HERE, "out");
  fs.mkdirSync(out, { recursive: true });

  const { audio, hashes } = voiceAll(script, engine, voice, speed, sample, cache);
  const all = buildPlan(script, { ...storyboard, fps }, audio);
  let at0 = 0;
  const slots = (only ? all.filter(s => only.includes(s.segment)) : all).map(s => {
    const placed = { ...s, start: at0 };
    at0 += s.dur;
    return placed;
  });
  const total = slots.reduce((t, s) => t + s.dur, 0);
  const name = only ? "partial" : "intro";
  console.log(`plan: ${slots.length} slots, ${total.toFixed(1)} s, ${slots.reduce((n, s) => n + s.frames, 0)} frames at ${fps} fps`);

  const { ffmpeg, openScene, requireFfmpeg, run } = await import("../scripts/scene-capture.mjs");
  requireFfmpeg();
  const frames = fs.mkdtempSync(path.join(os.tmpdir(), "video-frames-"));
  let scene;
  try {
    scene = await openScene();
    const burn = !flag("no-burn");
    const cards = await scene.browser.newPage({ viewport: { width: 1920, height: 1080 } });
    let n = 0;
    const shot = file => scene.page.screenshot({ path: file, clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    for (const slot of slots) {
      const at = () => path.join(frames, `f${String(n++).padStart(6, "0")}.png`);
      const page = slot.card ? cards : scene.page;
      if (slot.card) await cards.setContent(cardHtml(slot.card));
      let shown;
      let last;
      for (let i = 0; i < slot.frames; i++) {
        const caption = burn && slot.text !== undefined && i / fps < slot.speech ? slot.text : "";
        if (caption !== shown) {
          await setCaption(page, caption);
          shown = caption;
          last = undefined;
        }
        if (slot.replay) await scene.page.evaluate(ms => window.__replay.seek(ms), (slot.replay.from + (i / fps) * slot.replay.speed) * 1000);
        const file = at();
        if (slot.card && last) fs.copyFileSync(last, file);
        else {
          await (slot.card ? cards.screenshot({ path: file }) : shot(file));
          last = slot.card ? file : undefined;
        }
      }
      const where = slot.replay ? `replay ${slot.replay.from}-${Math.round(slot.replay.from + slot.dur * slot.replay.speed)} s at ${slot.replay.speed.toFixed(1)}x` : "card";
      console.log(`${slot.phrase ?? slot.segment}: ${slot.dur.toFixed(1)} s, ${where}`);
    }
    await scene.close();
    scene = undefined;

    fs.writeFileSync(path.join(out, `${name}.srt`), toSrt(slots));
    // the audio: each slot's speech padded with silence to the slot's length, end to end
    const inputs = [];
    const chains = slots.map((s, i) => {
      if (s.phrase === undefined) {
        inputs.push("-f", "lavfi", "-t", String(s.dur), "-i", "anullsrc=r=48000:cl=mono");
        return `[${i + 1}:a]aresample=48000[a${i}]`;
      }
      inputs.push("-i", path.join(cache, `${hashes.get(s.phrase)}.wav`));
      return `[${i + 1}:a]aresample=48000,apad=whole_dur=${s.dur},atrim=0:${s.dur}[a${i}]`;
    });
    const graph = `${chains.join(";")};${slots.map((_, i) => `[a${i}]`).join("")}concat=n=${slots.length}:v=0:a=1[aout]`;
    const mp4 = path.join(out, `${name}.mp4`);
    run(
      ffmpeg,
      [
        "-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(frames, "f%06d.png"), ...inputs,
        "-i", path.join(out, `${name}.srt`), "-filter_complex", graph,
        "-map", "0:v", "-map", "[aout]", "-map", `${slots.length + 1}:0`,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-c:a", "aac", "-b:a", "160k", "-c:s", "mov_text",
        "-disposition:s:0", burn ? "0" : "default", "-metadata:s:s:0", "language=eng", "-t", String(total), "-movflags", "+faststart", mp4,
      ],
      "video encode",
    );
    console.log(`${path.relative(process.cwd(), mp4)}: ${total.toFixed(1)} s, ${(fs.statSync(mp4).size / 1048576).toFixed(1)} MB, 1920x1080, ${fps} fps; subtitles in ${name}.srt`);
  } finally {
    await scene?.close();
    fs.rmSync(frames, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
