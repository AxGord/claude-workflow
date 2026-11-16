# The voiced intro video

A 2-3 minute English video, generated and re-renderable: `npm run video` writes `video/out/intro.mp4`
(1920x1080, narration, burned subtitles) and `video/out/intro.srt`. It plays the landing page's scene (the
terminal plan pane beside the live map, driven by the recorded anyparse replay in `docs/public/replay/`, no
private project data) while a local voice reads `script.md`.

| File | Role |
| --- | --- |
| `script.md` | The narration, one phrase per line (`[p01] text`): problem, how the engine solves it, the live scene, how to start. Edit the wording here. |
| `storyboard.json` | What is on screen for each phrase: a card (title, lines) or a stretch of the replay, `from` (replay seconds) plus `speed` (times real time) or `to` (the speed is then derived so the range lasts exactly the phrase). Also `fps` and the `gap` after each phrase. |
| `tts.py` | Voices phrases into `video/cache/<hash>.wav`; the hash is of engine, voice and text, so an edited phrase alone is voiced again. |
| `render.mjs` | Voices what is missing, plans the timeline from the audio lengths, draws every frame (scene and cards in headless Chromium, through `scripts/scene-capture.mjs`, the same capture as `npm run docs:record`), lays the audio, writes the SRT and encodes with ffmpeg. |

## One-time setup

```sh
npm install && npx playwright install chromium            # as for npm run docs:record (or set CHROME)
python3.12 -m venv video/.venv && video/.venv/bin/pip install -r video/requirements.txt
```

Python 3.10-3.12 (the Kokoro wheel does not support 3.13+). The first render downloads the Kokoro weights (about
330 MB) from Hugging Face into its cache. ffmpeg is taken from `/opt/homebrew/bin/ffmpeg` or `PATH` (`FFMPEG`).

## Commands

```sh
npm run video                          # voice what changed, render video/out/intro.mp4
npm run video -- --check               # validate script.md against storyboard.json (and the replay's length), nothing else
npm run video -- --only scene --fps 5  # a quick partial render of chosen segments: video/out/partial.mp4
npm run video -- --no-burn             # frames without the burned caption (the SRT track is always muxed, switched on by default only with --no-burn)
npm run video -- --voice am_adam       # another Kokoro voice (af_*, am_* American; bf_*, bm_* British), --speed 0.95
```

After a UI change, `npm run video` is all there is: the voice cache stays valid and only the frames are drawn
again (about 3 minutes at 20 fps). After a wording change only the edited phrases are voiced again. A new phrase
needs its line in `script.md` and its place in `storyboard.json` (`--check` names a phrase that is in only one).

## Voices (both free, local)

- **Kokoro** (default): Apache-2.0, 82M parameters, fixed preset voices (default `af_heart`), runs faster than real time on a laptop CPU.
- **Chatterbox** (MIT): clones a voice from a sample of yours. Install it on top (`video/.venv/bin/pip install chatterbox-tts`, it pins its own torch), put a clean 5-20 s recording at `video/voice-sample.wav` (or pass `--sample <file>`; `video/voice-sample.*` is git-ignored, never commit a voice) and render with `npm run video -- --engine chatterbox`. Its WAVs are cached under the sample's content hash.

State of the field when this was written (November 2026): Kokoro and Chatterbox are still the practical pair for
a permissive license, Apple Silicon and a one-command setup; Qwen3-TTS (Apache-2.0, cloning) and CosyVoice 3
(Apache-2.0, cloning) are the alternatives worth trying if Chatterbox is not enough, the best-known cloning
models besides them (Coqui XTTS v2, Fish Audio S2) are non-commercial. A new engine is one function in `tts.py`
plus a name in `render.mjs`'s `voiceKey`.
