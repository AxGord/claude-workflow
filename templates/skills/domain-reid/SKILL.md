---
name: domain-reid
description: Person re-identification ML gotchas
---

# Re-ID — Verified Gotchas

## BNNeck Trick (distance metric direction)

BNNeck = BatchNorm before classifier. The trick:
- **Training**: Euclidean distance in triplet loss (features BEFORE BNNeck)
- **Inference**: Cosine similarity (features AFTER BNNeck)

Sonnet and others commonly reverse this — getting the direction wrong silently degrades results.

## Loss Recipe

Typical: `loss = CE_label_smoothing + triplet_hard_mining + 0.0005 * center_loss`

The center loss weight (lambda=0.0005) is critical — too high destabilizes training.

## CLIP-ReID

Two-stage approach (NOT generic CLIP fine-tuning):
1. Learn **text tokens per identity** (freeze visual encoder)
2. Fine-tune **visual encoder** with learned text supervision

SOTA on MSMT17: **~86.7% mAP** (ViT-B). Sonnet underestimates at 70-75%.

## SOTA Performance Reference

| Method | Market-1501 R1/mAP | MSMT17 R1/mAP |
|--------|---------------------|----------------|
| CLIP-ReID (ViT-B) | 96.4 / 93.3 | 91.1 / 86.7 |
| TransReID (ViT-B) | 95.2 / 89.5 | 86.2 / 69.4 |
| BoT (ResNet-50) | 94.5 / 85.9 | 77.5 / 47.5 |

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
