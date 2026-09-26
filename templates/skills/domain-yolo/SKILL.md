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

## ByteTrack: Birth Threshold vs Sustain Floor — Track Flicker

ByteTrack-style two-stage association trackers expose TWO distinct thresholds that are easy to conflate:
- **Birth threshold** (`high_thresh`): gates whether an unmatched high-score detection may **create a NEW track**.
- **Detection score floor**: the postprocess confidence gate deciding a detection exists at all. This floor doubles as the **sustain floor** — the second association pass re-matches already-confirmed tracks against low-score detections (between the floor and the high-score split), letting a track survive frames where its score dips, as long as the score still clears the floor.

Trap: setting the score floor INSIDE the frame-to-frame score-noise band of the tracked class makes the score cross the floor repeatedly — each dip deletes the detection, the track loses its match, and (absent an appearance/ReID bridge) the box flickers on/off. Measured: a class whose confidence crossed a 0.20 floor ~40 times across 80 frames produced ~20 visible flickers; dropping the floor to ~0.10 while keeping the birth threshold at ~0.30 eliminated all crossings — the same strong tracks stayed drawn every frame.

Fix: DECOUPLE birth from sustain. Keep the birth threshold high enough to block junk detections from spawning new tracks; set the sustain floor well BELOW the score-noise band of the tracked objects. Unmatched low-score detections never create tracks (birth threshold still gates that) — they only sustain existing ones — so lowering the floor does not flood the output with junk track births.

Corollary: tuning detection thresholds for **yield** (how many objects appear) is a different objective from tuning for **track stability** (no flicker) — optimizing one can leave the other broken. Check both.

**Refinement — effective birth threshold is a MAX, not `high_thresh` alone:** a detection only reaches the birth check after first landing in the high-score pool, i.e. its score already cleared the high/low split (`track_thresh`). So effective birth = `max(track_thresh, high_thresh)`. Lowering `high_thresh` alone is a no-op once it drops below `track_thresh` — a sub-`track_thresh` detection never reaches the birth check at all, it lands in the low pool instead (sustain-only). Example: `track_thresh=0.25, high_thresh=0.30` → effective birth 0.30; dropping `high_thresh` to 0.22 alone leaves effective birth at 0.25 (`track_thresh` now dominates); only lowering both, e.g. to `track_thresh=0.20, high_thresh=0.22`, gets effective birth to 0.22.

Appear-latency vs flicker: an object present in frame for seconds with no track at all is this birth-threshold problem; per-frame flicker of an already-confirmed track is the separate sustain-floor problem above — different timescales, different knobs.

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
