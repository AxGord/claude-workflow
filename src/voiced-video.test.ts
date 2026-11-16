import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

interface Phrase {
  id: string;
  text: string;
}
interface Slot {
  segment: string;
  phrase?: string;
  text?: string;
  speech?: number;
  start: number;
  dur: number;
  frames: number;
  card?: unknown;
  replay?: { from: number; speed: number };
}
interface Storyboard {
  fps: number;
  gap: number;
  segments: {
    id: string;
    card?: object;
    seconds?: number;
    phrases?: { id: string; from?: number; speed?: number; to?: number }[];
  }[];
}
interface Render {
  parseScript(text: string): Phrase[];
  validate(script: Phrase[], storyboard: Storyboard, replayMs?: number): string[];
  phraseHash(voice: string, text: string): string;
  wavSeconds(buf: Buffer): number;
  buildPlan(script: Phrase[], storyboard: Storyboard, audio: Map<string, number>): Slot[];
  toSrt(slots: Slot[]): string;
  cardHtml(card: { title?: string; subtitle?: string; lines?: string[] }): string;
}
const R = (await import(pathToFileURL(path.join(ROOT, "video/render.mjs")).href)) as Render;

/** A mono 16-bit PCM WAV of the given length. */
function wav(seconds: number, rate = 24000): Buffer {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

const SCRIPT: Phrase[] = [
  { id: "a", text: "First." },
  { id: "b", text: "Second." },
];
const BOARD: Storyboard = {
  fps: 10,
  gap: 0.5,
  segments: [
    { id: "card", card: { title: "T" }, phrases: [{ id: "a" }] },
    { id: "scene", phrases: [{ id: "b", from: 100, to: 160 }] },
    { id: "end", card: { title: "E" }, seconds: 2 },
  ],
};

describe("the narration script", () => {
  it("reads [id] text phrases after the first heading and ignores the preamble, headings and blank lines", () => {
    const text =
      "# Title\nprose that is not a phrase\n\n## One\n[p1] Hello there.\n\n## Two\n[p2]   Second one.\n";
    expect(R.parseScript(text)).toEqual([
      { id: "p1", text: "Hello there." },
      { id: "p2", text: "Second one." },
    ]);
  });

  it("refuses a line that is not a phrase and an id used twice", () => {
    expect(() => R.parseScript("## A\nno id here\n")).toThrow(/line 2/);
    expect(() => R.parseScript("## A\n[x] one\n[x] two\n")).toThrow(/used twice/);
  });
});

describe("the storyboard against the script", () => {
  it("a sound pair has no problem", () => {
    expect(R.validate(SCRIPT, BOARD, 200_000)).toEqual([]);
  });

  it("names a phrase missing from the script, a script phrase on no segment, and a phrase placed twice", () => {
    const board: Storyboard = {
      ...BOARD,
      segments: [{ id: "c", card: {}, phrases: [{ id: "a" }, { id: "a" }, { id: "zz" }] }],
    };
    const errors = R.validate(SCRIPT, board).join("\n");
    expect(errors).toContain("phrase zz is not in script.md");
    expect(errors).toContain("phrase a is placed twice");
    expect(errors).toContain("phrase b is in script.md but in no storyboard segment");
  });

  it("a scene phrase needs from and exactly one of speed and to, inside the replay; a card phrase has no range", () => {
    const seg = (ph: object): Storyboard => ({
      ...BOARD,
      segments: [{ id: "s", phrases: [{ id: "a" }, { id: "b", ...ph }] }],
    });
    const problems = (ph: object): string => R.validate(SCRIPT, seg(ph), 200_000).join("\n");
    expect(problems({ from: 1 })).toContain("exactly one of speed and to");
    expect(problems({ from: 1, speed: 2, to: 9 })).toContain("exactly one of speed and to");
    expect(problems({ from: 5, to: 5 })).toContain("to must be after from");
    expect(problems({ from: 1, speed: 0 })).toContain("speed must be positive");
    expect(problems({ from: 199, to: 300 })).toContain("past the replay's end");
    expect(
      R.validate(SCRIPT, {
        ...BOARD,
        segments: [{ id: "c", card: {}, phrases: [{ id: "a", from: 1, speed: 1 }, { id: "b" }] }],
      }).join("\n"),
    ).toContain("a card segment has no replay range");
  });
});

describe("the voice cache", () => {
  it("a phrase's hash changes with its text and with the voice, and with nothing else", () => {
    expect(R.phraseHash("kokoro:af_heart:1", "Hello")).toBe(
      R.phraseHash("kokoro:af_heart:1", "Hello"),
    );
    expect(R.phraseHash("kokoro:af_heart:1", "Hello")).not.toBe(
      R.phraseHash("kokoro:af_heart:1", "Hello."),
    );
    expect(R.phraseHash("kokoro:af_heart:1", "Hello")).not.toBe(
      R.phraseHash("kokoro:am_adam:1", "Hello"),
    );
  });

  it("reads the seconds of a WAV from its header", () => {
    expect(R.wavSeconds(wav(2.5))).toBeCloseTo(2.5, 3);
    expect(R.wavSeconds(wav(1, 44100))).toBeCloseTo(1, 3);
    expect(() => R.wavSeconds(Buffer.from("not audio at all, really"))).toThrow(/not a WAV/);
  });

  it("tts.py writes <hash>.wav through a .part file and skips a hash already in the cache", () => {
    const py = read("video/tts.py");
    expect(py).toContain('os.path.exists(os.path.join(args.out, j["hash"] + ".wav"))');
    expect(py).toContain('os.replace(path + ".part", path)');
    expect(py).toContain("kokoro");
    expect(py).toContain("chatterbox");
  });
});

describe("the plan", () => {
  const slots = R.buildPlan(
    SCRIPT,
    BOARD,
    new Map([
      ["a", 2.04],
      ["b", 3.0],
    ]),
  );

  it("a phrase's slot is its speech plus the gap, rounded up to whole frames; slots follow one another", () => {
    expect(slots.map(s => s.dur)).toEqual([2.6, 3.5, 2]);
    expect(slots.map(s => s.frames)).toEqual([26, 35, 20]);
    expect(slots.map(s => s.start)).toEqual([0, 2.6, 6.1]);
  });

  it("a replay range given as `to` becomes the speed that spans exactly the slot", () => {
    expect(slots[1].replay).toEqual({ from: 100, speed: 60 / 3.5 });
    expect(slots[0].replay).toBeUndefined();
  });

  it("a silent card is a slot with no phrase", () => {
    expect(slots[2].phrase).toBeUndefined();
    expect(slots[2].card).toEqual({ title: "E" });
  });

  it("refuses a phrase with no audio", () => {
    expect(() => R.buildPlan(SCRIPT, BOARD, new Map([["a", 1]]))).toThrow(/no audio for b/);
  });

  it("the subtitles carry one cue per spoken phrase, from the slot's start to the end of its speech", () => {
    expect(R.toSrt(slots)).toBe(
      "1\n00:00:00,000 --> 00:00:02,040\nFirst.\n\n2\n00:00:02,600 --> 00:00:05,600\nSecond.\n",
    );
  });

  it("a card page escapes its text", () => {
    expect(R.cardHtml({ title: "A <b> & c", lines: ["x<y"] })).toContain("A &lt;b&gt; &amp; c");
  });
});

describe("the committed script and storyboard", () => {
  const script = R.parseScript(read("video/script.md"));
  const board = JSON.parse(read("video/storyboard.json")) as Storyboard;
  const replay = JSON.parse(read("docs/public/replay/anyparse.json")) as { durationMs: number };

  it("agree: every phrase is placed once, every range lies inside the replay", () => {
    expect(R.validate(script, board, replay.durationMs)).toEqual([]);
  });

  it("is an intro of 2 to 3 minutes of narration, one phrase per line", () => {
    const words = script.reduce((n, p) => n + p.text.split(/\s+/).length, 0);
    expect(words).toBeGreaterThan(250);
    expect(words).toBeLessThan(450);
  });
});

describe("the video pipeline's wiring", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

  it("is one command, and the recorders share one scene capture", () => {
    expect(pkg.scripts.video).toBe("node video/render.mjs");
    expect(read("video/render.mjs")).toContain("openScene");
    expect(read("scripts/record-scene.mjs")).toContain("openScene");
    expect(read("scripts/scene-capture.mjs")).toContain("export async function openScene");
  });

  it("keeps the venv, the voice cache, the output and a voice sample out of git", () => {
    const ignore = read(".gitignore");
    for (const line of ["video/.venv/", "video/cache/", "video/out/", "video/voice-sample.*"])
      expect(ignore).toContain(line);
  });

  it("names both voices: Kokoro by default, Chatterbox as the cloning option", () => {
    const req = read("video/requirements.txt");
    expect(req).toContain("kokoro");
    expect(req).toContain("chatterbox-tts");
    expect(read("video/README.md")).toContain("--sample");
  });
});
