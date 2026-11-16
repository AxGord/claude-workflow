#!/usr/bin/env python3
"""Voices the phrases of the narration, one WAV per phrase, into a cache directory.

render.mjs calls this with a jobs file (a JSON list of {"hash", "text"}); the hash is the cache key it computed
from the engine, the voice and the text, so a WAV already in the cache is kept and only an edited phrase is voiced
again. Engines (both free and local):

  kokoro      Kokoro-82M, Apache-2.0, the default: fixed preset voices (--voice af_heart, ...), 24 kHz.
  chatterbox  Chatterbox, MIT: clones the voice of --sample (a clean 5-20 s WAV/MP3 of yourself, not committed).

Usage (from the repo root, inside video/.venv):
  video/.venv/bin/python video/tts.py --jobs jobs.json --out video/cache [--engine kokoro] [--voice af_heart]
                                      [--speed 1.0] [--sample video/voice-sample.wav]
"""
import argparse
import json
import os
import sys


def kokoro_voicer(voice, speed):
    from kokoro import KPipeline
    import numpy as np

    pipeline = KPipeline(lang_code=voice[0])  # af_/am_ American English, bf_/bm_ British English

    def say(text):
        chunks = [np.asarray(audio) for _, _, audio in pipeline(text, voice=voice, speed=speed) if audio is not None]
        return np.concatenate(chunks), 24000

    return say


def chatterbox_voicer(sample):
    if not sample or not os.path.exists(sample):
        sys.exit("chatterbox needs --sample <an existing voice sample file>")
    import torch
    from chatterbox.tts import ChatterboxTTS

    device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
    # the checkpoints were saved on cuda; map them to wherever this machine computes
    load = torch.load
    torch.load = lambda *a, **k: load(*a, **{**k, "map_location": torch.device(device)})
    model = ChatterboxTTS.from_pretrained(device=device)
    torch.load = load

    def say(text):
        wav = model.generate(text, audio_prompt_path=sample)
        return wav.squeeze(0).cpu().numpy(), model.sr

    return say


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--jobs", required=True, help="JSON list of {hash, text}")
    ap.add_argument("--out", required=True, help="cache directory; one <hash>.wav per job")
    ap.add_argument("--engine", choices=["kokoro", "chatterbox"], default="kokoro")
    ap.add_argument("--voice", default="af_heart", help="kokoro voice")
    ap.add_argument("--speed", type=float, default=1.0, help="kokoro speaking speed")
    ap.add_argument("--sample", help="chatterbox voice sample")
    args = ap.parse_args()

    with open(args.jobs, encoding="utf-8") as f:
        jobs = json.load(f)
    os.makedirs(args.out, exist_ok=True)
    todo = [j for j in jobs if not os.path.exists(os.path.join(args.out, j["hash"] + ".wav"))]
    for j in jobs:
        if j not in todo:
            print(f"cached {j['hash']}", flush=True)
    if not todo:
        return
    import soundfile as sf

    say = kokoro_voicer(args.voice, args.speed) if args.engine == "kokoro" else chatterbox_voicer(args.sample)
    for j in todo:
        audio, rate = say(j["text"])
        path = os.path.join(args.out, j["hash"] + ".wav")
        sf.write(path + ".part", audio, rate, format="WAV", subtype="PCM_16")
        os.replace(path + ".part", path)  # a killed run never leaves a half-written WAV in the cache
        print(f"wrote {j['hash']} {len(audio) / rate:.2f}s", flush=True)


if __name__ == "__main__":
    main()
