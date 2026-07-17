---
name: domain-yolo
description: YOLO object detection model selection
---

# YOLO — Verified Gotchas

## YOLO26 — Current Default

YOLO26 is NMS-free end-to-end (no NMS post-processing step), drops DFL, and delivers ~43% faster CPU inference. Same Ultralytics API — change the `.pt` file. Prefer it for new projects, especially CPU/edge deployment.

## YOLO11 vs YOLOv8

YOLO11: higher mAP than v8m with 22% fewer params. Refined C3k2 blocks. **Drop-in replacement** — change `.pt` file, code identical. Same Ultralytics API.

## YOLOv10 — Legacy NMS-Free

YOLOv10 pioneered NMS-free inference, but its headline "1.8x faster" figure is vs an RT-DETR-R18 baseline, not vs other YOLOs. Superseded by YOLO26 for the NMS-free niche.

## Zero-Shot: YOLOE Supersedes YOLO-World

YOLOE covers text prompts, visual prompts, AND a prompt-free mode at real-time speed. Reach for YOLO-World only if a dependency pins it.

## `predict(source=<list>)` — List Length IS the Batch, `batch=` Is Ignored

Passing a list of image paths to `model.predict(source=...)` runs **one forward pass** with the list length as the batch dimension — the `batch=` kwarg has no effect on a list source, it does not sub-divide it. A 128-path list at high resolution becomes a single huge `(128, 3, H, W)` allocation and can OOM the GPU; the failing allocation size stays invariant no matter what else you tune (TTA, model count), because the batch never actually changes.

- WRONG: `model.predict(source=all_128_paths, batch=1)`  # runs ONE batch-128 forward → OOM
- RIGHT: `for sub in chunks(paths, 8): model.predict(source=sub)`  # batch bounded to 8

## Verified Gotcha — Matching Shapes ≠ Same Model

When picking a source model to convert/requantize into a new precision variant, don't infer "same model" from matching input shape or overlapping backbone conv-layer shapes alone. A single-class fine-tune and the 80-class COCO base model of the same YOLO family (same width/depth, same input resolution) share nearly identical backbones — dozens of conv layers will have IDENTICAL shapes in both — because only the detection head's final output channel count differs (e.g. `[1, 5, N]` = 4 bbox coords + 1 class score, vs `[1, 84, N]` = 4 bbox coords + 80 class scores). Trusting partial shape matches can pick the WRONG source file — architecturally similar but a different model (different class count / task).

Fix: check the actual OUTPUT tensor shape before committing to a source file, not just the input shape.

```python
import openvino as ov
m = ov.Core().read_model(path)
print([o.get_partial_shape() for o in m.outputs])  # channel-axis last dim reveals class count
```

A mismatch here (e.g. expecting 84 channels but seeing 5) means the wrong file was picked — even if input shape and many backbone layers matched.

## Model Selection Quick Reference

| Model | When | Key Feature |
|-------|------|-------------|
| YOLO26 | Default choice | NMS-free end-to-end, ~43% faster CPU inference |
| YOLO11 | Proven/stable production | Higher mAP than v8 with 22% fewer params |
| YOLO12 | Attention-based research | Attention-centric (area attention) |
| YOLOv8 | Mature, widest ecosystem | Anchor-free, unified API |
| YOLOv10 | Legacy | First NMS-free (1.8x claim is vs RT-DETR-R18) |
| YOLOE | Zero-shot / open-vocabulary | Text/visual prompts + prompt-free mode |
| YOLO-World | Superseded by YOLOE | Text prompt detection |
