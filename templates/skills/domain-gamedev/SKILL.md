---
name: domain-gamedev
description: Game dev precision and physics gotchas
---

# Game Development Gotchas

See also: math skill for overflow boundaries (factorial, Fibonacci, float absorption tables).

## Float32 World Precision (verified)

| Distance from origin | ULP (precision) | Effect |
|---------------------|-----------------|--------|
| 100km | 0.78cm | Fine for most games |
| 524km (≈2^19m) | 3.1cm → 6.25cm | Unity/Unreal world edge zone |
| 2,097km (2^21m) | 25cm | 5m/s @ 60fps movement ABSORBED — character stops moving |
| 8,389km (≈2^23m) | 1m | Positions snap to meter grid |

**Absorption formula**: movement absorbed when `velocity * dt < ULP(position) / 2`.

## Deterministic Physics

**DLL FPU contamination**: Direct3D, printer drivers, sound libraries can silently change FPU control word (precision/rounding mode) without restoring. Assert FPU state after every external call.

**Debug vs release breaks replays**: compiler optimization level alone changes float results even with identical source. All replay participants must use identical binary.

**FMA cross-platform**: PowerPC uses fused multiply-add (one rounding), Intel uses separate mul+add (two roundings) → different results from identical math. Cross-platform determinism requires controlling instruction selection.

**x87 vs SSE**: x87 uses 80-bit extended precision internally → double rounding when storing to 64-bit. SSE uses exact 32/64-bit → more predictable. But SSE FTZ/DAZ modes may differ across platforms.

**Fixed iteration count**: physics solvers that iterate fewer times on faster CPUs break determinism. Iteration count must be fixed per timestep.

## CCD Threshold (verified)

Enable continuous collision detection when: `velocity × dt > object_size`.
- 1m object at 60m/s, 60fps: travels 1m/frame → equals object size → CCD needed
- Below threshold: discrete detection misses contacts (tunneling)

## State Machine Safety Timeouts vs Scaled Animation Time

When a state machine waits for an animation-completion event (e.g. xstate `on.ANIMATION_END` from a `tween.onComplete` callback) and you add a safety `after:` timeout, the timeout uses **wall-clock** via `setTimeout`. Animation libs like gsap expose `timeScale` (`gsap.globalTimeline.timeScale(speed)`) that scales animation duration by `1/speed` — at `speed=0.5` a 7000ms tween takes 14000ms wall-clock.

**Failure mode**: safety `after: 10000` + user uses `?speed=0.5` → timeout fires mid-flight → state transitions prematurely → tween later completes and sends its event into a state that ignores it.

**Fix options:**
- Generous constant that covers worst reasonable `speed` (e.g. `30_000` covers speed≥0.25 for a 7s animation)
- Clamp `speed` at the caller
- Compute the timeout at the layer that knows `timeScale` and pass via event payload

## Parallax Tile Assets: Native Width = Integration Signal

When integrating an artist-authored asset (e.g. `hole_flag.png`) into a row of cyclically-stitched parallax tiles (e.g. `front_1..6.png`), **check native dimensions first**.

- If the asset has the **same native width** as the cyclic tiles → it was designed as ONE of the tiles. Insert it into the stitch sequence at a specific anchor position. Don't overlay.
- If the asset has **different dimensions** → it's a prop sprite meant to sit on top of the tile row (e.g. a character, tree, bush).

**Failure mode**: overlaying a full "same-width" panel on top of the stitched row creates a visible seam/silhouette mismatch where the overlay's terrain doesn't line up with the cyclic tiles' silhouette or pattern (grass stripes, hill peaks, etc.).

**Fix shape**: extend the stitcher to accept an optional `anchor: { leftWorldX, texture }`. When provided, place the anchor at its target X, then cycle remaining tiles outward (left and right). Ordering: place left tiles first (farthest → nearest), then anchor, then right tiles — so each tile's right edge correctly covers its left neighbor's seam overlap.

## 2D Camera Zoom-Out Trade-offs

When scene dimensions are fixed (e.g. 1920×1393) and you need to widen the camera's horizontal world-view at rest to frame more content, there are three options — and they are NOT equivalent:

1. **Uniform scale (X and Y)**: the entire scene compresses proportionally. Hills/ground shrink to a thin band at the bottom; sky dominates. Sprite proportions are preserved.
2. **X-only scale (zoom X, keep Y)**: object heights are unchanged, but thin vertical features become invisible. A flag pole at 5 native px × 0.22 atlas-scale × 0.5 worldView-zoom ≈ 0.55 scene px, then × 0.517 viewport fit-scale ≈ **0.3 viewport px** → below the 1 px visibility threshold. All sprites look horizontally pinched.
3. **Change scene dimensions**: make the widest view native at zoom=1; flight mode zooms IN. Requires updating sky/backstop widths and any viewport-size-dependent layouts.

**Visibility threshold rule**: a 1-px-wide feature disappears when all scale factors compound below ~1 viewport px. Multiply every stage: worldView zoom × sceneRoot fit-scale × atlas scale. Miss any stage and you'll wonder why the feature vanished at seemingly minor zoom changes.

**Rule of thumb**: if thin features (flag poles, wires, hair) must remain visible, prefer option 1 or 3 over option 2.

## Transform Composition — Trace, Don't Guess

When a scene has nested transforms (e.g. worldView zoom + per-layer parallax x + per-sprite pivot/rotation), a sprite's screen position is the product of the ENTIRE chain. Debugging a "why is this in the wrong place?" bug by guessing which transform is responsible is a time sink.

**Rule**: walk the chain explicitly from root → leaf, applying each transform. A child added to a parallax-offset layer INHERITS that offset — don't add offset twice. A mask added as a child of a masked container INHERITS that container's rotation/position — mask coords live in the masked container's local space automatically.

**Symptom of violation**: doubled offsets (sprite at `2 × cameraX`), or mask not tracking its target (mask coords in world, but target in a rotated parent → mismatch).

## Sprite Anchor = Position AND Rotation Pivot

In most 2D engines (Pixi, Phaser, etc.), `sprite.anchor.set(ax, ay)` serves TWO roles simultaneously:
1. The texture pixel at `(ax·width, ay·height)` is placed at `sprite.position`.
2. Rotation (`sprite.rotation`) pivots AROUND that same anchor pixel.

**Use case**: to rotate a sprite around a specific feature of its PNG (e.g. the left rim of a hazard/foot of a character), put the anchor at that feature's normalized texture coords. Then set `sprite.position` to the world location of that feature and `sprite.rotation` — the feature stays locked in place while the rest swings.

**Gotcha**: anchor and pivot are NOT separate in Pixi's Sprite. If you need them decoupled, wrap the Sprite in a Container and rotate the Container.

## Heightmap From PNG Alpha — Pre-sample Once

When a PNG's visible silhouette matters for gameplay (terrain, trap surface, collision top edge), DON'T re-sample alpha per frame. Pre-build a `Uint16Array` heightmap at init: for each native column, find the topmost non-transparent row.

```
for x in 0..width:
  for y in 0..height:
    if data[(y*width + x)*4 + 3] > alphaThreshold: heightmap[x] = y; break
```

Store result alongside the asset (hardcode in a `.ts` file or build at load time via OffscreenCanvas). Query at runtime via `heightmap[col]` — O(1) surface lookup, correct for any PNG shape including concave curves.

**When to use**: terrain silhouette for ball/character landing, fluid surface curve, collision top edge. Anywhere code needs "what Y does this PNG visibly START at for X=col?".

## Cut a Trap/Pit Hole in a Silhouette — Rhombus Mask

Requirement: a background silhouette (hill, cliff, ground row) should show a "pit" where a trap/hazard/item sits, so the trap is visible without the silhouette bleeding through it. Ball/character needs to land on the trap rim, not the hidden silhouette.

**Don't**:
- Pixel-perfect alpha mask from the trap PNG (overkill for a prototype; engine-specific).
- Rect mask covering the trap bbox (cuts too much when hill silhouette peaks inside the band → dark gap below trap).
- Cut the whole panel column at that X range (removes hill below trap where it should remain).

**Do**: mask the silhouette layer with a **rhombus (kite)** per trap. Four vertices:
- **Left/right**: world positions of the rim endpoints — `(band[0], terrainY(band[0]))` and `(band[1], terrainY(band[1]))`. Since these are in WORLD coords, rotation of the rotated trap sprite is baked in automatically.
- **Top**: well above the rim (scene top is safe) — generous margin guarantees any silhouette peak inside the band is inside the cut.
- **Bottom**: `rim_midY + below_rim_scaled` where `below_rim_scaled = (texture.height − leftY) × scale`. Matches the trap PNG's visible bottom — doesn't carve deeper than the sprite.

Apply as mask on the silhouette-layer container. Ball/character lands on a rim-line helper that interpolates `terrainY` between band endpoints inside the band (straight rim line in world coords, rotation included).

**Why it works**: the rhombus naturally tracks rotated traps (rim endpoints are world-space), hides silhouette where the trap's visible area is, and leaves silhouette intact beyond the kite.

## 2D Camera Follow — Clamp Direction Trap

When the follow formula is `cameraY = targetScreenY − worldY × zoom` (standard "world point at fixed screen point"), the sign flips your intuition:

- Ball RISES in world → `worldY` DECREASES → `cameraY` INCREASES.
- `Math.min(flightTarget, idleCameraY)` reads as "never go ABOVE idle" in human terms, but `cameraY` for a higher ball is NUMERICALLY LARGER than the idle value — so `Math.min` pins the camera to idle and BLOCKS the follow-up. The correct direction is `Math.max` (if clamping against an upper bound on camera Y) or no clamp at all.

**Verify before shipping**: plug in two concrete numbers — ball at rest and ball at peak — and compute `cameraY` for each. The one with higher `worldY` (lower on screen) should yield a MORE NEGATIVE `cameraY` if the pivot is above the horizon pivot, or more positive if below. If the clamp picks the wrong side, the camera becomes useless at exactly the moment it needs to work.

**Rule**: every time you combine `screenAnchor − worldPos × zoom` with a `Math.min`/`Math.max`, write the two endpoints on paper. Don't trust the human-language reading of the clamp.

## Anchor-and-Rotate to a Tilted Line — Rotation Aligns Direction, Not Length

When an authored sprite/mesh has two internal landmarks (e.g. left/right rim corners of a hazard trap) and you anchor one landmark to a target point on a tilted line, then `rotation = atan2(targetDy, targetDx) − atan2(sourceDy, sourceDx)`, the second landmark **does not** land on the line — rotation aligns the chord *direction* but preserves chord *magnitude*.

**Failure shape**: source chord length × renderScale was sized to match the line's X-EXTENT (assuming horizontal target). On tilted target the line's chord length `T = √(width² + dy²) > width`, so the far landmark falls SHORT by `~dy²/(2·width)`.

| terrain dy across width | width | shortfall |
|---|---|---|
| 5 px | 100 px | 0.13 px |
| 10 px | 100 px | 0.50 px |
| 20 px | 100 px | 2.0 px |
| 5 px | 80 px | 0.16 px |
| 20 px | 140 px | 1.43 px |

Sub-pixel for flat terrain, but visible (1+ px sliver) on noticeably tilted bands. Easy to dismiss as AA fuzz, easy to miss in non-retina screenshots.

**Fix**: apply a uniform `chordScale = targetChordLen / sourceChordLen` on top of renderScale. For typical scenes the scale lands at 1.007–1.018 — visually imperceptible, mathematically eliminates the gap. Apply the same `chordScale` to any physics surface table (per-column world Y projection) that mirrors the render transform — otherwise visuals and physics drift.

**Detection — don't trust eyeballs**: instrument the actual transform output. Apply the same rotation+scale in JS, compute endpoint, compare to target. `dx_err = 0, dy_err = 0` post-fix is unambiguous; pre-fix shows the predicted shortfall to FP precision. Retina screenshots can miss 1 px slivers but a JS-side numerical assert can't.

## Audio Latency Thresholds

| Latency | Perception |
|---------|-----------|
| < 20ms | Imperceptible |
| 25-40ms | Casual players notice |
| > 40ms | Unacceptable for rhythm/FPS |

Humans react to audio faster than visual → audio lag more noticeable than dropped frames.
