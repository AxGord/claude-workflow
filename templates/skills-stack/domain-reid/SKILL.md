---
name: domain-reid
description: Person re-identification ML gotchas
---

# Re-ID — Verified Gotchas

## BNNeck Trick (distance metric direction)

BNNeck = BatchNorm before classifier. The trick:
- **Training**: Euclidean distance in triplet loss (features BEFORE BNNeck)
- **Inference**: Cosine similarity (features AFTER BNNeck)

This direction is commonly reversed — getting it wrong silently degrades results.

## Loss Recipe

Typical: `loss = CE_label_smoothing + triplet_hard_mining + 0.0005 * center_loss`

The center loss weight (lambda=0.0005) is critical — too high destabilizes training.

## CLIP-ReID

Two-stage approach (NOT generic CLIP fine-tuning):
1. Learn **text tokens per identity** — BOTH encoders frozen; only the id-specific text tokens train
2. Fine-tune **visual encoder** with learned text supervision (text side stays fixed)

MSMT17 **~86.7% mAP** is the SIE+OLP **+ re-ranking** configuration — plain ViT-B CLIP-ReID lands in the low-to-mid 70s mAP. Don't quote 86.7 as the vanilla-model number.

## SOTA Performance Reference

| Method | Market-1501 R1/mAP | MSMT17 R1/mAP |
|--------|---------------------|----------------|
| CLIP-ReID (ViT-B, SIE+OLP, +re-rank) | 96.4 / 93.3 | 91.1 / 86.7 |
| TransReID (ViT-B) | 95.2 / 89.5 | 86.2 / 69.4 |
| BoT (ResNet-50) | 94.5 / 85.9 | 77.5 / 47.5 |

The CLIP-ReID row already includes k-reciprocal re-ranking — do NOT add the re-ranking boost from the section below on top of these numbers (double-count).

## Key Datasets

| Dataset | IDs | Images | Notes |
|---------|-----|--------|-------|
| Market-1501 | 1,501 | 32,668 | Most widely used |
| MSMT17 | 4,101 | 126,441 | Largest, preferred for SOTA |
| CUHK03 | 1,467 | 14,096 | Use "new protocol" (767/700 split) |
| MARS | 1,261 | 1,191,003 | Video-based (tracklets) |

Note: DukeMTMC-reID was **retracted** due to privacy concerns — avoid citing it.

## k-Reciprocal Re-Ranking

Parameters: k1=20, k2=6, lambda=0.3. Boosts mAP by 5-10%. Use for offline, skip for real-time.

## torchreid install — from git, NOT PyPI

`pip install torchreid` fetches a **stale 0.2.5** (2019) with a different API — `import torchreid`
often outright fails on a modern torch/numpy. The real KaiyangZhou/deep-person-reid is **1.4.x, git-only**. Its `setup.py` imports numpy/Cython
at build time, so a plain `pip install git+...` **fails under PEP-517 build isolation**
(`error: getting requirements to build wheel` → `ModuleNotFoundError: No module named 'torchreid'`
/ numpy). Two working installs (both need numpy+Cython in the env):
`pip install --no-build-isolation git+https://github.com/KaiyangZhou/deep-person-reid.git`, or the
official `git clone … && cd deep-person-reid && pip install -r requirements.txt && python setup.py develop`
(its requirements.txt does NOT pin torch, so a preinstalled CUDA torch survives).
So a "package is installed but import raises" state ≠ missing — detect it with
`importlib.util.find_spec(m) is not None` + a real import attempt, and surface the actual exception
(don't report "missing" and re-suggest the PyPI name that caused it).

## torchreid (deep-person-reid) — query/gallery need DIFFERENT camids

`torchreid.metrics.evaluate_rank` (run by every engine at the final epoch, and whenever
`eval_freq` fires) drops, **for each query, every gallery sample sharing that query's
`(pid, camid)`**, then asserts `num_valid_q > 0` → `AssertionError: all query identities do not
appear in gallery`. A query is "valid" only if the same pid appears in gallery under a *different*
camid.

Trap when registering a custom `ImageDataset` for fine-tuning: if you build a throwaway
query/gallery by splitting one identity's crops but leave them under one camid, every query is
invalid → training crashes at the FINAL-EPOCH eval (not at data load, so it looks like a late,
unrelated failure). Fix: assign query camid=0, gallery camid=1 (or any distinct pair) with the
same pids on both sides.

Note the value gap vs cosine ReID: the evaluator ranks by that removal rule (Market1501 protocol);
it is NOT a plain cosine-margin metric, so its CMC/mAP on a tiny throwaway split is meaningless —
do the real margin eval separately.
