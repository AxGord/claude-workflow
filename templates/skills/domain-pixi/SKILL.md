---
name: domain-pixi
description: Pixi.js v8 masking and graphics gotchas
---

## Pixi.js v8 Gotchas

### 1. Graphics mask silently fails with high vertex counts

A polygon with ~625 vertices renders fine as a sprite but produces NO clipping as a mask. Keep mask polygons to ≤20 vertices.

- Wrong: `new Graphics().poly([...625pts]).fill(0xffffff)` → assign as mask → no clipping
- Right: keep masks low-vertex; use keyhole-bridge (see #5) to encode multiple holes in one polygon

### 2. `setMask({ mask, inverse: true })` does not work for Graphics masks

The `StencilMask` object is created (visible on `_maskEffect`) but inverse produces no visible change. Non-inverse normal mask works.

- Wrong: `container.setMask({ mask: g, inverse: true })` to hide inside-shape content
- Right: build "world minus holes" via keyhole-bridge manually

### 3. Multiple `.fill()` calls create separate shapes — unreliable as mask

`g.rect(a).fill().rect(b).fill()` creates two fill shapes. For stencil masking, multi-fill Graphics can misbehave.

- Right: single polygon path + single `.fill()` for any mask

### 4. Winding direction required for polygon holes

Outer boundary CW, hole CCW (Y-down screen coords). For a rhombus {top, left, bottom, right} as a hole inside a CW outer rect:

- Wrong CCW order: top → left → right → bottom (skips proper circuit, fills instead of holes)
- Right CCW order: top → left → bottom → right (strict CCW around centroid)

### 5. Keyhole-bridge: multiple holes in one polygon

`FillStyle` has no `fillRule` field — `evenodd` is not available. Use a zero-width bridge instead:

```ts
const pts: number[] = [0, 0];
for (const h of holes) {              // sorted by x
  pts.push(h.topX, 0);               // descend from top edge
  pts.push(h.topX, h.topY);
  // hole perimeter, CCW
  pts.push(h.leftX, h.leftY, h.botX, h.botY, h.rightX, h.rightY, h.topX, h.topY);
  pts.push(h.topX, 0);               // ascend (same X = zero-width seam)
}
pts.push(W, 0, W, H, 0, H);         // close outer rect
new Graphics().poly(pts).fill(color);
```

The zero-width bridge (same X down/up) is tolerated by Pixi's tessellator — produces a seam but no visible artifact when used as mask.

### 6. Texture sub-region: v8 constructor shape

- Wrong (v7): mutating `texture.frame` after creation doesn't rebuild UVs reliably
- Right:
  ```ts
  const sub = new Texture({ source: original.source, frame: new Rectangle(x, y, w, h) });
  new Sprite(sub);
  ```

### 7. Mask as child of masked container inherits transforms

Adding a Graphics mask as a child of the container it masks makes it inherit the container's full transform chain (rotation, camera zoom, parallax).

- Don't apply parallax offset to the mask separately — the parent already does it

### 8. `.fill()` has no `fillRule` option

`FillStyle` fields: `color`, `alpha`, `texture`, `matrix`, `fill`, `visible` — no `fillRule`. TypeScript will error on `.fill({ fillRule: 'evenodd' })`.

- Right: use winding-based holes (#4, #5)

### 9. `sprite.anchor` is both position reference AND rotation pivot

`sprite.anchor.set(ax, ay)` + `sprite.position.set(wx, wy)` + `sprite.rotation = θ`:
- The pixel at `(ax·width, ay·height)` maps to world `(wx, wy)`
- Rotation happens around that same pixel

Use this to rotate around a specific PNG feature (e.g. left rim of a hazard sprite).

### 10. `addChild` z-order + mask visibility

- `container.addChild(a, b, c)` — later = on top
- A Graphics assigned as `sprite.mask` or `container.mask` is hidden from normal rendering (not drawn, only used for clipping)

### 11. `Mesh.geometry` attribute buffers may be interleaved — never iterate `aPosition` with stride 2

When a `Geometry` is built with multiple attributes that share one underlying `Buffer` (interleaved layout: `[x, y, u, v, x, y, u, v, ...]`), `geometry.getBuffer('aPosition').data` returns the WHOLE interleaved Float32Array, not a positions-only view. Iterating with `for (i; i < data.length; i += 2)` reads `[x0, y0, x2, y2, ...]` — actually `[x0, u0, x2, u2, ...]` — and produces garbage.

- Wrong: `for (let i = 0; i < buf.length; i += 2) { x = buf[i]; y = buf[i+1]; }` on interleaved geometry
- Right: read attribute config first (`geometry.attributes.aPosition.{stride, offset}`) and use the actual stride. For 2 floats × 2 attrs (xy + uv), stride is 4 floats per vertex:
  ```ts
  for (let k = 0; k < buf.length; k += 4) { const x = buf[k], y = buf[k+1], u = buf[k+2], v = buf[k+3]; }
  ```
- Symptom: every other vertex reads as `(x, -1)` because `-1` is the Loop-Blinn hull UV sentinel — looks like "weird hull padding" until you trace the buffer layout.

### 12. Use `displayObject.toGlobal({x,y})` instead of hand-multiplying nested transforms

When a scene has multiple nested scales (e.g. `sceneRoot.scale = camera_fit`, `layers.scale = camera_zoom`, `mesh.scale = native_to_screen`), computing canvas pixel coords by hand-multiplying through the chain is brittle and easy to get backwards. Pixi already exposes the matrix it actually uses to render.

- Wrong: `canvas_x = (front.x + tile.x + local_x) * sceneRoot.scale * layers.scale * resolution`
- Right: `const p = mesh.toGlobal({x: local_x, y: local_y}); const canvas_x = p.x * renderer.resolution;`
- Also useful for the inverse direction: `mesh.toLocal(globalPoint, fromObject?)`

### 13. DOM `window`/`canvas` listeners don't respect Pixi `eventMode` consumption

Pixi v8's federated event system (`eventMode='static'` + `pointertap` etc.) only governs dispatch *within* the Pixi scene graph. The original DOM `pointerevent` continues bubbling to anything attached via `window.addEventListener('pointerdown', ...)` or `canvas.addEventListener(...)` regardless of which Pixi child handled it.

Failure mode: a HUD/UI container is added to `app.stage` (sibling of the world `sceneRoot`) with interactive Graphics for buttons. Clicking a button fires the Pixi `pointertap` AND the global `window` pointerdown listener that was meant to handle "tap on world to fire/cash out" — every panel click double-fires the world action.

- Wrong: rely on `eventMode='static'` to "consume" the event for window listeners.
- Wrong: gate via `if (ev.target !== app.canvas) return` — the canvas IS the target for clicks anywhere over its rect, including over panel children.
- Right: gate window listeners by hit area. If the panel occupies the bottom strip of the canvas, track its top Y in CSS px and skip when `ev.clientY - canvas.getBoundingClientRect().top >= panelTopY`.
- Alternative: make the panel container's parent absorb the pointerevent at the DOM level (`canvas.addEventListener` with `stopPropagation`) — but only if you control which pointerevents reach that listener relative to Pixi's.

### 14. `Graphics.roundRect` clamps the corner radius to half the smaller dimension — stacking pills with different aspect ratios desyncs corners

When two `roundRect` calls stack to fake a "raised button" effect (e.g. tall pill in fill color, short shadow inset at the bottom), passing the same `r` parameter to both does NOT give matching corners. Pixi clamps each call independently to `min(width, height) / 2`, so a `roundRect(0, 0, w, 48, 24)` keeps `r=24` while `roundRect(0, 42, w, 6, 24)` is silently clamped to `r=3`. The wide pill curves inward at the bottom corners, but the short shadow inset has nearly square corners and extends across the FULL width — visible as a dark sliver leaking past the curved bottom of the pill.

- Wrong (artifact at corners):
  ```ts
  const r = Math.min(h / 2, 28);
  g.roundRect(0, 0, w, h, r).fill(fill)
   .roundRect(0, h - 6, w, 6, r).fill(shadow);  // r clamps to 3, leaks past the curve
  ```
- Right (matching corner curves on both shapes — outer in shadow, inner shorter in fill):
  ```ts
  const r = Math.min((h - 6) / 2, 28);
  g.roundRect(0, 0, w, h, r).fill(shadow)
   .roundRect(0, 0, w, h - 6, r).fill(fill);
  ```
- Symptom in screenshots: zoom into the rounded-corner edge of a stacked roundRect; you'll see the shadow color extending past where the fill pill's curve cuts off, making the bottom band look like it has flatter corners than the rest of the button.

### 15. Firefox clips rightmost glyph of Pixi `Text` — set `TextStyle.padding`

Pixi v8 sizes the offscreen text texture using `measureText`. Firefox's `measureText` reports tighter advance widths than `fillText` actually paints, especially for `bold`/`800`/`900` weights, so the rightmost 1–2 px of the rightmost glyph fall outside the texture and get clipped. Chrome/Safari measure more generously and don't show the bug. User reports it as "in Chrome works, in Firefox last letter is cut" — affects every label simultaneously (BALANCE → BALANC, $100.00 → $100.0, FREE BET → FREE BE).

- Wrong (clipped in FF):
  ```ts
  new TextStyle({ fontFamily: '...', fontSize: 18, fontWeight: '800', fill: 0xffe600 });
  ```
- Right: add `padding` (≥16 px for bold-800/900 uppercase with letterSpacing on 11+ chars; 4–8 px is too tight and still clips trailing glyph) — Pixi inflates the canvas by `padding` on all sides, so Firefox's wider-than-measured glyphs still fit. Pixi v8.18+ centers visible content correctly with anchor 0.5 (no manual compensation needed); v8.6's `updateQuadBounds` had a `-padding` term that did shift content, but that was removed.
  ```ts
  new TextStyle({ fontFamily: '...', fontSize: 18, fontWeight: '800', fill: 0xffe600, padding: 16 });
  ```
- Apply to every TextStyle in the project — labels and values both. A shared constant (`const TEXT_PADDING = 16`) keeps it consistent.
- `padding` only inflates the texture; Pixi compensates so the visible text stays at `text.position`. `text.width` still reports `measuredWidth + padding*2`, so tight-pack columns may shift by ~8 px — verify layouts after applying.
- Verify in Firefox specifically — the bug is invisible in Chrome screenshots. `npx playwright install firefox` + a small launcher script is enough.

### 16. `anchor: 0.5` centers measureText box, not visible ink — set `trim: true` on centered TextStyles

Even with `padding` (gotcha #15) keeping FF from clipping, `anchor: 0.5 + sprite.x = container_center` does NOT visually center the painted glyphs in Firefox bold-800 stacks. `text.getBounds()` returns bounds based on glyph advance widths, but the actual ink sits asymmetrically inside that box: each glyph has its own left/right side-bearings, so an "S"-starting word lands ink slightly right of geometric center while a "C"-starting word lands ink slightly left. Direction and magnitude vary per text — typical observed range ±5–20 px — so a single horizontal compensation offset hacks one label and breaks the next.

- Wrong: nudge `sprite.x` by a magic constant to recenter ink — works for one label, off-center for another.
- Right: set `trim: true` on the TextStyle. Pixi runs `getCanvasBoundingBox` on the rendered canvas, sets `texture.frame` to the actual ink extent (then re-pads). With `anchor: 0.5`, sprite center maps to ink center, not measureText-box center.
  ```ts
  new TextStyle({ ..., padding: 16, trim: true });
  ```
- GOTCHA: only enable `trim` for centered-anchor texts. With `anchor: 0` (top-left labels), `trim` crops the natural ascender/descender whitespace at the top of the canvas, so the visible ink sits HIGHER than `sprite.y` than the untrimmed equivalent — stacked labels with hardcoded vertical offsets will overlap. Either parametrize the style helper (`labelStyle(size, color, weight, trim = false)`) and opt in only at centered call sites, or split into two separate styles.
- Verification recipe: clip a 1px-tall strip across the rendered text band, sample bg color from outside the glyphs, find first/last column with significantly-different pixels (Manhattan delta > 100). Compare visible-ink center to bg center. Reading rendered canvas pixels via `python -c "from PIL import Image; ..."` works when Pixi's `preserveDrawingBuffer=false` makes JS-side `drawImage` of the WebGL canvas come back empty.

