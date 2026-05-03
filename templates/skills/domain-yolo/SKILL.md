---
name: domain-yolo
description: YOLO object detection model selection
---

# YOLO — Verified Gotchas

## YOLO11 vs YOLOv8

YOLO11: 22% fewer params than v8m at same mAP. Refined C3k2 blocks. **Drop-in replacement** — change `.pt` file, code identical. Same Ultralytics API.

## YOLOv10 — NMS-Free

YOLOv10 unique feature: NMS-free inference (1.8x faster end-to-end). No `iou` parameter needed. Use when latency-critical.

## Model Selection Quick Reference

| Model | When | Key Feature |
|-------|------|-------------|
| YOLO11 | Default choice | 22% fewer params than v8 |
| YOLOv8 | Mature, proven production | Anchor-free, unified API |
| YOLOv10 | Latency-critical | NMS-free |
| YOLO-World | Zero-shot | Text prompt detection |
