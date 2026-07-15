---
name: domain-pixi
description: Pixi.js v8 gotchas — graphics, masking, text, shaders, Spine, capture
---

## Pixi.js v8 Gotchas

### 1. Graphics mask silently fails with high vertex counts

A polygon with ~625 vertices renders fine as a sprite but produces NO clipping as a mask. Keep mask polygons to ≤20 vertices.

- Wrong: `new Graphics().poly([...625pts]).fill(0xffffff)` → assign as mask → no clipping
- Right: keep masks low-vertex; use keyhole-bridge (see #5) to encode multiple holes in one polygon

### 2. `setMask({ mask, inverse: true })` does not work for Graphics masks

The `StencilMask` object is created (visible on `_maskEffect`) but inverse produces no visible change. Non-inverse normal mask works. Version qualifier: the `inverse` option only exists since v8.5.0 (earlier v8 ignores it entirely); this failure was observed on v8.6.x — retest on your version before building a workaround.

- Wrong: `container.setMask({ mask: g, inverse: true })` to hide inside-shape content
- Right: build "world minus holes" via keyhole-bridge manually

### 3. Multiple `.fill()` calls create separate shapes — unreliable as mask

`g.rect(a).fill().rect(b).fill()` creates two fill shapes. For stencil masking, multi-fill Graphics can misbehave.

- Right: single polygon path + single `.fill()` for any mask

### 4. Winding direction required for polygon holes

Outer boundary CW, hole CCW (Y-down screen coords). For a rhombus {top, left, bottom, right} as a hole inside a CW outer rect:

- Wrong order: top → left → right → bottom — a self-intersecting bowtie, not a CCW circuit; fills instead of holing
- Right CCW order: top → left → bottom → right (strict CCW around centroid)

### 5. Keyhole-bridge: multiple holes in one polygon

`FillStyle` has no `fillRule` field — `evenodd` is not available. v8 does offer `Graphics.cut()` (draw the hole path after the fill, then `.cut()`), but caveat: it attaches the hole only to the LAST drawn shape (its fill+stroke instruction pair), and a hole that is not completely inside that shape "will fail to cut correctly" (per its own doc). For multiple or edge-touching holes use a zero-width bridge instead:

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

`FillStyle` fields: `color`, `alpha`, `texture`, `matrix`, `fill`, `textureSpace` — no `fillRule`. TypeScript will error on `.fill({ fillRule: 'evenodd' })`. (`textureSpace: 'local' | 'global'`, default `'local'`, controls whether texture coords are relative to each shape's bounds or to world space.)

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

Failure mode: a HUD/UI container is added to `app.stage` (sibling of the world `sceneRoot`) with interactive Graphics for buttons. Clicking a button fires the Pixi `pointertap` AND the global `window` pointerdown listener that was meant to handle "tap on world to trigger the primary action" — every panel click double-fires the world action.

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

Pixi v8 sizes the offscreen text texture using `measureText`. Firefox's `measureText` reports tighter advance widths than `fillText` actually paints, especially for `bold`/`800`/`900` weights, so the rightmost 1–2 px of the rightmost glyph fall outside the texture and get clipped. Chrome/Safari measure more generously and don't show the bug. User reports it as "in Chrome works, in Firefox last letter is cut" — affects every label simultaneously (BALANCE → BALANC, $100.00 → $100.0, TOTAL WIN → TOTAL WI).

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

### 17. Letterboxed canvas: use `app.canvas.clientWidth/Height`, not `container.clientWidth/Height`

`app.renderer.resize(W, H)` sets the canvas CSS size to `W×H` (with `autoDensity: true`; without it the canvas has no CSS size of its own). When the game letterboxes inside a wider container (landscape window), `container.clientWidth > app.canvas.clientWidth`. Overlays laid out using the container dims extend into unrendered space; centering is computed against a wider rect than the canvas occupies.

- Wrong: `bg.rect(0, 0, container.clientWidth, container.clientHeight).fill(color)` — bg overshoots the rendered region; "centered" text drifts toward one side.
- Right: `bg.rect(0, 0, app.canvas.clientWidth, app.canvas.clientHeight).fill(color)` — matches the rendered region exactly.
- Symptom: overlay (preloader, modal, HUD) appears off-center on landscape; looks correct in portrait where container and canvas widths match.
- Note: `app.screen.width/height` gives the logical (renderer) resolution before CSS scaling — use `clientWidth/clientHeight` for layout in CSS pixels.

### 18. `TilingSprite` wrap-samples the whole `TextureSource` — never feed it an atlas sub-frame

Pixi v8 `TilingSprite` repeats the entire backing `TextureSource`, not the `frame` rect of the `Texture` you pass. If the texture is a sub-region of a shared atlas page, every tile wrap boundary bleeds the adjacent atlas content (alpha-bleed rings, packed neighbours), producing periodic seam artifacts across the tiled surface.

- Wrong: pack a gradient strip into a shared atlas, then tile it:
  ```ts
  new TilingSprite({ texture: atlas.textures['sky_gradient'], width, height });
  // → seam every `tileScale * atlas.textures['sky_gradient'].height` px
  ```
- Right option 1: keep tiled textures as standalone `TextureSource`s (own PNG, not atlas-packed).
- Right option 2: if the texture must stay in the atlas and is horizontally uniform (e.g. a 1-px-wide gradient strip), use a clamped `Sprite` instead of tiling:
  ```ts
  const src = atlasTex.source;
  const { x: fx, y: fy, width: fw, height: fh } = atlasTex.textures['sky_gradient'].frame;
  const cropped = new Texture({ source: src, frame: new Rectangle(fx, fy + cropTop, fw, fh - cropTop) });
  const sprite = new Sprite(cropped);
  sprite.width = sceneWidth;
  sprite.height = fh - cropTop;
  ```
  A `Sprite` uses `CLAMP_TO_EDGE` semantics within its frame — no wrap, no seam. Stretching a uniform-column strip horizontally is visually lossless.
- This is the same underlying constraint as the classic WebGL "repeat requires pow2 or whole texture" rule, restated for v8 atlas usage.

### 19. Custom uniforms on a Mesh shader require UBO (`ubo: true` + std140 block) — plain `uniform float foo;` with `UniformGroup` resource silently never syncs to GPU

Adding a custom uniform to a `Mesh` shader by declaring `uniform float uTime;` at top level (outside any block) and passing `new UniformGroup({ uTime: { value: 0, type: 'f32' } })` as a resource appears correct: the shader compiles, `glProgram._uniformData.uTime` exists (introspected with type `float`), `shader.groups[99].resources[0]` is the UniformGroup, and the generated sync function emits `gl.uniform1f(ud["uTime"].location, v)`. JS-side mutations to `_waveUniforms.uniforms.uTime` advance correctly each frame. But the GPU never sees the value change — the shader behaves as if `uTime` is permanently 0. The fallback bind-group path (group index 99 for resources without a `gpuProgram` layout) generates a sync function that doesn't actually push plain uniforms.

The reliable path is std140 UBO:

- Wrong (compiles, draws, but uniform value never updates):
  ```glsl
  uniform float uTime;
  ```
  ```ts
  new UniformGroup({ uTime: { value: 0, type: 'f32' } });
  new Shader({ glProgram, resources: { waveUniforms } });
  ```
- Right (WebGL2 only — requires `#version 300 es`):
  ```glsl
  layout(std140) uniform waveUniforms {
    float uTime;
  };
  ```
  ```ts
  new UniformGroup(
    { uTime: { value: 0, type: 'f32' } },
    { ubo: true },
  );
  ```
  The resource KEY (`waveUniforms`) must match the GLSL block name. The std140 block size is padded to 16 bytes, so the underlying `Float32Array` is length 4 for a single float — write `group.uniforms.uTime = t; group.update();` per frame.

Per-frame update flow that works: bump `_dirtyId` via `group.update()` after writing — `updateUniformGroup` then calls `syncUniformGroup` which writes std140 into `buffer.data`, bumps `buffer._updateID`, and `GlBufferSystem.updateBuffer` re-uploads on the next bind.

Verification trick: read `(window as any).__group.buffer.data[0]` over 500 ms — if it advances but the rendered shader output stays frozen, the binding chain is broken (likely the plain-uniform fallback). If `buffer.data[0]` advances and pixel output also advances → UBO path is working.

### 20. GLSL ES 3.00 fragment shaders need explicit `precision <qual> float;` — `compileHighShaderGl` does NOT inject one

When emitting WebGL2 shaders via `compileHighShaderGl({ template: { vertex: vertexGlTemplate, fragment: fragmentGlTemplate }, bits: [...] })` and prepending `#version 300 es`, the fragment shader fails to link if any custom bit references a float-typed varying or uniform. Symptom: console fills with `WebGL: INVALID_OPERATION: useProgram: program not valid` warnings, the mesh draws silently disappear from the framebuffer (no exception thrown). Vertex stage compiles fine (ES 3.00 supplies an implicit `highp` for vertex floats); only fragment needs the explicit precision.

- Wrong:
  ```ts
  const fragment = `#version 300 es\n${compiled.fragment}`;
  ```
- Right:
  ```ts
  const fragment = `#version 300 es\nprecision highp float;\n${compiled.fragment}`;
  ```

The standard `localUniformBitGl` / `globalUniformsBitGl` shaders bundled with Pixi escape this because their fragment never reads a float — they only write `outColor = vColor`. Any custom bit doing `mix()`, `smoothstep()`, or reading a `varying vec2 vUV` triggers the precision-missing link error.

### 21. Freezing a Pixi scene for a deterministic screenshot — stop `Ticker.shared`, NOT just the external tween lib

Per-frame motion in a Pixi app often comes from TWO independent drivers: Pixi's own `Ticker.shared` (drives `Spine.autoUpdate` skeletons and any `Ticker.shared.add(...)` per-frame loop) AND a separate tween library (gsap, etc.) driving specific objects. Pausing only ONE freezes only what IT drives. Common failure when capturing a screenshot of a transient overlap/alignment: you pause `gsap.globalTimeline` (which froze the gsap-driven object), take the screenshot a few hundred ms later via your screenshot tool, and the ticker-driven objects have moved on — the exact frame you detected is gone, and the screenshot shows empty space where the detector said a sprite was.

- Wrong (only the gsap-driven object freezes; ticker-driven objects keep moving):
  ```js
  window.__gsap.globalTimeline.pause();   // gsap object stops, but ticker-driven sprites move before the screenshot
  ```
- Right (freeze BOTH drivers at the detected frame, then screenshot):
  ```js
  window.__gsap.globalTimeline.pause();
  ticker.stop();                          // freezes Spine autoUpdate + every Ticker.shared sim loop
  ```
- Reaching `Ticker.shared` when it isn't exposed on `window`: in **spine-pixi-v8** every `Spine` instance with `autoUpdate` on holds the ticker at `spineInstance._ticker` (defaults to `Ticker.shared`; overridable via `options.ticker`) — walk the scene to any Spine and read `._ticker`. (Also reachable via `app.ticker` if you have the Application; the Pixi `Ticker` class itself is usually minified / not global in a prod bundle.)
- Restore after the screenshot: `ticker.start()` + `gsap.globalTimeline.resume()`.
- Detect-and-freeze in the SAME `requestAnimationFrame` callback that finds the frame (call `pause()` + `stop()` synchronously inside it), so no extra ticks elapse before the freeze. A poll-from-outside-then-pause loses frames to the round-trip latency.

### 22. Pinpoint an in-clip Spine animation event frame from AttachmentTimeline data — don't eyeball scrubbed screenshots

To find the exact time a prop breaks, an attachment appears/disappears, or a face changes mid-clip, scrubbing the clip and eyeballing screenshots is unreliable: a fast mid-motion pose can look like the event already happened. Concrete miss: a "prop break" was eyeballed at `trackTime ~0.2s` but the prop is still intact then; the real break is `0.933s` — a ~0.7s error that shipped a mistimed banner.

Read the animation's `AttachmentTimeline`s from skeleton data. The keyframe where a slot's attachment name changes (to the broken/cracked variant, or to/from `null`) is the exact event time:

```ts
const anim = spine.skeleton.data.animations.find(a => a.name === 'break_anim');
for (const tl of anim.timelines) {
  if (tl.attachmentNames && tl.frames) {          // AttachmentTimeline
    const slot = spine.skeleton.data.slots[tl.slotIndex].name;
    // tl.frames[i] = time (s), tl.attachmentNames[i] = attachment (or null)
  }
}
// e.g. intact `prop_whole` → null AND `shard_1..8` pieces appear, all at t=0.933
```

Companion: to RENDER a specific frame for a visual check, set `spine.autoUpdate = false`, then:

```ts
const e = spine.state.setAnimation(0, clip, false);
e.trackTime = t;
spine.update(0);
```

Do NOT call `skeleton.updateWorldTransform()` directly in spine-pixi v8 — it requires a `Physics` argument and throws `physics is undefined`. `spine.update(0)` applies state + transforms correctly.

### 23. A BlurFilter on a fully-transparent sprite still renders its padded region — detach it, don't rely on alpha 0

A `BlurFilter` (or any filter) attached via `sprite.filters = [blur]` forces a filter render pass that composites the filter's padded region **even when the sprite is fully transparent** (`alpha = 0`). The result is a faint soft-edged rectangle lingering on screen at the sprite's position — the blur edge-clamp of the (invisible) content.

- Symptom: sprite is faded to `alpha = 0` (dissolve/burn-out tween) but a faint box persists at its position until something else clears the filter.
- Wrong: tween `sprite.alpha → 0` and leave `sprite.filters = [blur]` attached, assuming alpha 0 hides everything. The empty filter region keeps compositing.
- Right: detach the filter when content goes invisible — `sprite.filters = []` in the fade tween's `onComplete` (or whenever alpha hits ~0). An alpha-0 sprite with no filter renders nothing; with a filter it renders the region.
- Note: a plain alpha-0 sprite (no filter) is correctly skipped by Pixi — only the attached filter forces the stray pass. Verified by toggling `sprite.filters.length` 1→0 at alpha 0: rectangle present with the filter, gone without it.

### 24. Deferred texture upload — a standalone atlas page used only by a LATER clip uploads SYNCHRONOUSLY on its first render, stalling that frame. Pre-warm at boot.

Pixi v8 uploads a `TextureSource` to the GPU lazily, on the FIRST render that binds it (`GlTextureSystem.bind`→`_initSource`→`onSourceUpdate`→`texImage2D`). A boot "warmup render" (`app.render()` once before revealing the scene) only uploads what's VISIBLE in that idle frame. Any texture whose only consumers are clips/states not shown at idle — a separate Spine FX atlas (flame, explosion, bonus), a rarely-used sprite page — is NOT uploaded at boot. It uploads the first time that clip renders: a one-time synchronous `texImage2D` of the WHOLE page on the gameplay frame that first shows it.

- Symptom: a "strong lag SOMETIMES" exactly at a transition (a strike, an ability, a scene change) — "sometimes" = only the FIRST occurrence per page-load, because after that the page is GPU-resident. Invisible on a fast desktop GPU (a ~16 MB upload is a few ms), a clear hitch on mobile (far lower texture-upload bandwidth + driver overhead).
- A shared atlas page is fine: if the idle scene shows ANY region of `atlas.png`, the whole page uploads at boot, so later clips packed into the SAME page (an action pose, a flag) pay nothing. Only pages with NO region visible at idle defer. (So a Spine action clip on the hero's already-visible atlas = free; the flame's SEPARATE atlas = a deferred stall.)
- Measure it directly — hook the GL context in an addInitScript BEFORE app boot and timestamp every upload:
  ```js
  const og = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, ...r) {
    const gl = og.call(this, t, ...r);
    const proto = Object.getPrototypeOf(gl), o = proto.texImage2D;
    proto.texImage2D = function (...a) {
      const w = typeof a[3]==='number'?a[3]:(a[a.length-1]?.width||0);
      const h = typeof a[4]==='number'?a[4]:(a[a.length-1]?.height||0);
      if (w*h) window.__up.push({ t: performance.now(), w, h, bytes: w*h*4 });
      return o.apply(this, a);
    };
    return gl;
  };
  ```
  A big single `texImage2D` (e.g. `2018×2044` = 16.5 MB) landing a few ms before the visible transition, present only ONCE in the whole session, is the smoking gun. A page costs `w·h·4` bytes of GPU RAM regardless of the PNG's compressed size (a 2.6 MB PNG → ~16.5 MB upload).
- Fix: force the upload at boot, behind the preloader, with `renderer.texture.initSource(source)` (idempotent — no-op if already resident). Reach the source of a spine-pixi-v8 atlas via `Assets.get(atlasAlias).pages[i].texture.texture.source` (the `SpineTexture` wrapper holds the Pixi `Texture` at `.texture`, whose `.source` is the `TextureSource`). Call once per standalone FX atlas right after the warmup `app.render()`.
- This trades a one-time gameplay stall for slightly more load-time work — the correct tradeoff, same intent as the warmup render itself.

### 25. 8-bit gradient banding in additive glows → screen-space additive-noise dither overlay (NOT a post-filter)

A soft radial glow built from stacked ADDITIVE Spine/sprite slots, scaled up several×, shows concentric "Mach-band" rings on some mobile panels (and milder banding on iPhones) even though the source texture is a smooth gradient. Cause: across the falloff the additive contribution drops <1 LSB per screen pixel, so the 8-bit framebuffer holds one value for ~16 px then steps +1 — a ring at every step. Desktop GPUs/panels dither it away; many mobile panels render the raw 8-bit, so the rings show. Confirm by sampling a radial line of the captured frame: a banded glow holds RGB constant for 16–24 px then steps by exactly 1 (`(70,131,194)`→`(70,132,195)`), and ×6-amplifying `(frame − local_sky)` makes the rings pop.

- **The texture is NOT the bug.** Measure the source alpha falloff: if it's a smooth ramp (many levels, no long flat runs), the banding is purely the final 8-bit COMPOSITE. Re-exporting / dithering the source won't help (it's washed out by the upscale + linear filter before the framebuffer quantizes).
- **A post-process filter on the already-8-bit frame can't reconstruct the gradient, but ≥1-LSB dither STILL breaks the rings** — adding noise then re-quantizing scatters the hard step edge into noise the eye integrates. Sub-LSB dither does nothing (re-rounds to the same value); you need ~1–2 LSB amplitude.
- **Cheapest robust fix = a screen-space additive `TilingSprite` of noise** over the world, `blendMode:'add'`, tiny `alpha` (~0.012 → contribution `noise(0..255)·alpha` ≈ 0..3 LSB, mean ~1.5). Added to `app.stage` ABOVE the world, BELOW the HUD. Backend-agnostic (works on WebGL AND WebGPU — no custom shader), one cheap quad (vs a full-frame render-target pass for a `Filter`), and it dithers BEFORE the framebuffer re-quantizes. Use `scaleMode:'nearest'`, `tileScale = 1/renderer.resolution` (≈ one noise texel per device pixel), `eventMode:'none'`. Imperceptible at 1× (verify on the real idle scene), bands gone (radial flat-run maxrun drops from ~16–24 px to ~2–3 px).
- A custom GLSL/WGSL dither `Filter` is the "more correct" symmetric dither but costs: a full-frame render pass, and on a renderer that may pick WebGPU (Pixi v8 default if no `preference` set in `app.init`) you must supply BOTH a glProgram and a gpuProgram. The additive-noise sprite sidesteps all of that.
- **GOTCHA — generate the noise from a LOCAL seeded PRNG, never `Math.random()`.** Filling a 128×128 RGBA tile is ~49k draws; if the game seeds any sim state (enemy layout, spawn jitter) off the GLOBAL `Math.random` stream, consuming those draws at boot SHIFTS that layout and silently changes gameplay. Use a local `mulberry32` (a fixed seed is ideal — the dither tile only needs to be uncorrelated, not unpredictable). A render-init utility must never consume the sim's RNG.

### 26. A Graphics whose draw is ONLY `g.texture(...)` is UNCLICKABLE — `containsPoint` skips texture instructions; set an explicit `hitArea`

Pixi v8 `GraphicsContext.containsPoint` iterates instructions and does `if (!instruction.action || !path) continue;` — `texture` instructions carry no `path`, so a Graphics that draws nothing but texture quads never hit-tests true. Symptom: `eventMode: 'static'` + `onpointertap` on a texture-only Graphics (e.g. an atlas-frame button) silently never fires; the same handler pattern works elsewhere because those draws include `fill()` shapes. No error, cursor may even change (cursor comes from the events system pre-hit in some paths) — the tap just doesn't land.

- Wrong (renders fine, never clickable):
  ```ts
  <Graphics eventMode="static" onpointertap={onTap}
    draw={(g) => g.texture(frame, 0xffffff, -w/2, -h/2, w, h)} />
  ```
- Right — explicit hitArea (local coords of the Graphics):
  ```ts
  <Graphics eventMode="static" onpointertap={onTap}
    hitArea={new Circle(0, 0, w / 2 - pad)}   // or new Rectangle(...)
    draw={(g) => g.texture(frame, 0xffffff, -w/2, -h/2, w, h)} />
  ```
- Related trap: a draw of only thin glyph bars (a `−`/`+` made of 2 small rects) IS hit-testable but the target is a sliver — give it a generous `hitArea` rect too.
- Rule of thumb: any interactive Graphics should either contain at least one `fill()` shape covering the intended target, or carry an explicit `hitArea`. `hitArea` also short-circuits per-shape testing — cheaper on complex draws.

### 27. `generateTexture` of a TRIMMED Text at resolution≠1 renders shifted when composited into a RenderTexture atlas — bake untrimmed for atlas pages

Baking labels via `renderer.generateTexture({ target: text, resolution: 2 })` where the TextStyle has `trim: true` produces a texture whose CONTENT lands offset (≈ the logical ink height upward) when the baked texture is drawn as a Sprite into another RenderTexture (an atlas page): the recorded frame rect is right, the pixels are not — on retina the atlas shows the label's bottom half at the frame position and garbles every drawn label. At resolution 1 the same pipeline renders perfectly, so the bug ONLY appears on DPR-2 devices — desktop verification with a CDP-forced DPR-1 viewport misses it completely.

- Wrong (garbled on retina): `style.trim = true` → `generateTexture({target, resolution})` → Sprite → atlas page.
- Right: bake UNTRIMMED with the style's `padding` captured as a border (`generateTexture({ target, frame: new Rectangle(-pad, -pad, w+2pad, h+2pad), resolution })`); the padding is symmetric, so centering the FULL padded box visually centers the text. Subtract `pad` where the label butts another element.
- Verify by extracting the atlas page itself (`renderer.extract.canvas(new Texture({source: page.source}))`) at BOTH resolutions — comparing only final screenshots hides whether the page or the frame math is at fault.
- Related: assigning `texture.source.resolution = N` after `Texture.from(canvas)` to "mark" a hi-res raster double-counts in any packer that multiplies `tex.width * source.resolution` — leave source.resolution at 1 and scale at draw time with explicit dw/dh.

### 28. BitmapText silently DROPS local-space FillGradient — DynamicBitmapFont bakes glyphs without textMetrics; layer two solid texts + an alpha-ramp mask instead

A `TextStyle` with `fill: new FillGradient({ textureSpace: 'local', ... })` renders correctly on `Text`, but on `BitmapText` (v8 dynamic bitmap font) the glyphs come out SOLID in (approximately) the LAST stop's colour. Cause: `DynamicBitmapFont._setupContext` calls `getCanvasFillStyle(style._fill, context)` with NO `textMetrics` argument, so the local gradient is built over a 1×1 box — every glyph pixel below y=1 samples the final stop. Same for gradient strokes. No warning is emitted.

- Wrong (compiles, renders solid): per-frame multiplier label as `<BitmapText>` with a vertical `FillGradient` fill/stroke.
- Switching to `Text` "fixes" the gradient but re-rasterizes + re-uploads the whole string every frame — the exact cost BitmapText was chosen to avoid for per-frame counters.
- Right (keeps BitmapText, exact vertical gradients for BOTH fill and stroke): draw the string TWICE in solid colours and alpha-mask the top copy:
  1. Bottom `BitmapText`: fill = gradient END colour, stroke = stroke-gradient END colour (opaque).
  2. Top `BitmapText` (same text/anchor/pos): fill = gradient START colour, stroke = stroke-gradient START colour.
  3. Mask the top copy with a static 1×H canvas texture: alpha 1 above the digit ink, linear 1→0 across the ink band, 0 below. Sprite spans the text area; `container.mask = sprite` (alpha mask) — verified working in v8.18.
- BOTH layers MUST declare a stroke of the SAME `width` — `DynamicBitmapFont` feeds `stroke.width` into the glyph padding and draw offsets (`extraPadding = stroke.width`, `tx/ty ± width/2`), so a stroke-less layer rasterises its glyphs SHIFTED vs a stroked one and its fill paints over the other layer's stroke edge (shows as "the top stroke is eaten"). For a TRANSLUCENT stroke (e.g. black @0.4) that must not double-darken under the mask: keep the visible stroke in the BOTTOM layer and give the TOP layer the same-width stroke with `alpha: 0` — identical metrics, zero paint.
- Ink-band placement: Poppins-like fonts ≈ ink top at 0.30·fontSize below the line top, ink height ≈ 0.70·fontSize — verify against a live screenshot (measure stroke/fill row extents) rather than font tables.
- Cost: +1 glyph-quad draw + one small alpha-mask pass while the label shows — no per-frame canvas rasterization.

### 29. pixi-svelte: a late-becoming-true `{#if}` block APPENDS its Pixi node — template order ≠ z-order; background layers must mount UNCONDITIONALLY

pixi-svelte components call `parentContext.addToParent(node)` at mount time. Children that mount TOGETHER land in template order, but a `{#if cond}` block whose condition flips true LATER (data arrives, state changes mid-animation) appends its node to the END of the parent's children — ON TOP of everything already mounted, regardless of where the block sits in the template.

- Symptom: a "background" sprite/Graphics written ABOVE a text/sprite in the template renders OVER it — but only when its data arrives after mount (e.g. an atlas frame that resolves later, a kind flag that flips a frame into the animation). Screenshots taken when the condition was true from the start look correct, hiding the bug.
- Wrong (flame draws on top of the text whenever `flameTex` resolves after mount):
  ```svelte
  {#if flameTex}
    <Graphics draw={drawFlame} />   <!-- background -->
  {/if}
  <BitmapText text={label} ... />
  ```
- Right — mount the background node UNCONDITIONALLY (same mount tick as its siblings preserves template order) and guard inside the draw callback; pixi-svelte's Graphics `$effect` runs `graphics.clear()` before every draw, so a null texture just draws nothing:
  ```svelte
  <Graphics draw={(g) => { if (flameTex) g.texture(flameTex, ...); }} />
  <BitmapText text={label} ... />
  ```
- Late-mounting is fine for nodes that SHOULD be on top (overlays, masked top layers) — append order is exactly what they need.
- Verify layering by ZOOMING a screenshot at an actual overlap point (glyph stroke crisp over the background = correct); a row-scan "stroke pixels exist somewhere" check passes in BOTH orders and proves nothing about z.

## Verification & capture

General Playwright/browser-capture traps (stale headless AND headed screenshots,
persistent MCP browser cache, headless-vs-device GPU perf) live in the
`browser-verify` skill — load it alongside this one when verifying visually.

### 30. Measuring per-frame motion — sample on the Pixi render ticker, NOT your own `requestAnimationFrame`

To verify/diagnose a per-frame animation artifact (judder, stutter, "moves every other frame"), read the object's position INSIDE a callback added to the actual render ticker (`spineInstance._ticker.add(cb)` — walk the scene for a `Spine` with `_ticker`, see #21), not a separate `requestAnimationFrame` loop you spin up. Your own rAF runs on a DIFFERENT clock than the game's update/render and ALIASES against it: when the game updates at a different effective rate than your sampler, you get bogus duplicate frames — a perfectly regular `0, X, 0, X` per-frame delta that looks like a real every-other-frame stutter but is partly your sampling beat. (Headless Chrome makes this worse: observed `_ticker.FPS` bounced 113→120→151 across runs, and gsap/Pixi can run at mismatched rates so BOTH the tween-driven and ticker-driven motion appeared to update at ~60 while the ticker reported 120.)

- Wrong (aliased — `0,X,0,X` is partly the sampler beat, present even in a smooth build):
  ```js
  let prev; const loop = () => { const x = read(); /* delta = prev - x */ prev = x; requestAnimationFrame(loop); };
  ```
- Right (synced to what is actually drawn — true per-render-frame delta):
  ```js
  let ticker; walkScene(n => { if (n._ticker && n.skeleton) ticker = n._ticker; });
  const xs = []; const cb = () => xs.push(read()); ticker.add(cb); /* …900ms… */ ticker.remove(cb);
  // smooth build → every delta ≈ mean (e.g. 4.8–6.1 around 5.4); juddery → 0 / 2×mean alternation (zeroFrac ≈ 0.5)
  ```
- Discriminator: compute `zeroFrac` (fraction of frames with ≈0 delta). A render-synced smooth build is `zeroFrac ≈ 0`; a real every-other-frame stutter is `zeroFrac ≈ 0.5`. Your-own-rAF can't tell them apart.
- Sibling cause to watch for: a fixed-timestep accumulator (`while (acc >= SIM_STEP_MS) step(SIM_STEP_MS)`) on a `>62.5 Hz` display releases a step only every ~N frames → the object visibly moves in quantized bursts. If the camera is static (so the object's own motion is the only thing on screen), this reads as judder. Fix: step with the real (capped) frame `dt` where determinism isn't required.

### 31. Translucent text stroke darkens where glyphs overlap — in BOTH Text and BitmapText; bake the stroke OPAQUE and alpha the whole layer

A `stroke: { color: 0x000000, alpha: 0.4 }` on a TextStyle produces DARKER seams between adjacent letters: Pixi rasterises `Text` glyph-by-glyph (each glyph's strokeText composites separately even at letterSpacing 0), and `BitmapText` draws one quad per glyph — wherever two glyphs' stroke rings overlap, 40% black over 40% black ≈ 64%. Design tools (Figma) stroke the whole text outline once, so mocks show a uniform stroke — the game shows dark blotches between every letter pair.

- Wrong: `stroke: { color: 0x000000, alpha: 0.4, width: 8 }` — dark seams at every glyph junction.
- Right — split into an OPAQUE stroke silhouette layer flattened to the target alpha, under a fill-only layer:
  - `Text` (infrequent updates): bottom Text with fill black + stroke black alpha 1, shown at `alpha = 0.4` — a single rasterised texture is already flat, plain element alpha is uniform. Top Text with the real fill + SAME-width stroke at alpha 0 (metrics parity).
  - `BitmapText` (per-frame counters): plain container alpha does NOT work — alpha applies per glyph-quad and re-compounds the seams. Wrap the stroke-layer BitmapText in a `Container` with `filters: [new AlphaFilter({ alpha: 0.4 })]` — the filter flattens the subtree to a texture before applying alpha. Cheap (label-sized pass), keeps BitmapText's no-reraster benefit.
- The silhouette layer's FILL can simply be the stroke colour (opaque) — the fill layers above cover it; no transparent-fill styles needed.
- Disable the layer by setting its text to `''`, not by unmounting (see #29 late-mount z-order trap).

### 32. FillGradient `textureSpace: 'local'` on Text — the gradient axis anchors to the measured text box, NOT the padded texture, and shifts per string

Placing a vertical `FillGradient` (stops at 0/1) on a padded `Text` shows only the middle of the ramp on the glyph ink — the mock's edge colours never appear (e.g. a salmon→red mock reads flat red). But computing stop offsets from naive texture-height fractions (padding + lineHeight) ALSO misses: the local axis is anchored to Pixi's measured text box, and empirically the ink lands at DIFFERENT axis fractions for different strings of the same style (observed ~0.12..0.92 for one 70px string vs ~0.24..1.0 for another — the sign/symbol mix changes measured bounds).

- Fix procedure (empirical, converges in 2-3 iterations): render with a 0→1 gradient, row-profile the rendered ink (median fill colour per row), invert the sampled colours to ramp positions, fit `ink_y(f) = A + B·f`, then solve gradient `start.y`/`end.y` so the ink sees the mock's sampled ramp band. Out-of-[0,1] start/end values are valid (canvas gradients accept off-canvas endpoints) — keep the pure design hexes in the stops and move the LINE, don't lerp the colours.
- Calibrate PER STRING-SHAPE (win/loss/half skins each get their own start/end pair); re-calibrate if font size, lineHeight, or padding change.
- Row-profile trick: median of fill-family pixels per row (filter by hue family to exclude stroke/AA), compare `f→colour` curves between mock screenshot and render — both measured the same way, so mock zoom level doesn't matter.

### 33. Filter default `resolution: 1` half-res-blurs the filtered subtree on a DPR-2 canvas — pass `resolution: 'inherit'`

`Filter.defaultOptions` in v8 is `{ resolution: 1, antialias: 'off', ... }`. On a renderer at `resolution: 2` (retina/mobile), ANY filtered container (`AlphaFilter`, `BlurFilter`-less passes included) is rendered into a texture at HALF the device resolution and upscaled — the subtree comes out visibly blurry while unfiltered siblings stay crisp. Classic symptom: a text stroke/silhouette layer flattened via `AlphaFilter` (gotcha #31) reads soft and low-contrast next to its crisp fill layer; users report it as "less contrast than the mock".

- Wrong: `new AlphaFilter({ alpha: 0.4 })` — device-res-blind, blurry at DPR ≥ 2.
- Right: `new AlphaFilter({ alpha: 0.4, resolution: 'inherit', antialias: 'inherit' })` — renders the filter pass at the render target's resolution.
- Applies to every Filter subclass and custom filters; check any `filters = [...]` on a project that inits Pixi with `resolution: window.devicePixelRatio`.
- Invisible on desktop DPR-1 screenshots — verify with `deviceScaleFactor: 2` capture and zoom the edge.
