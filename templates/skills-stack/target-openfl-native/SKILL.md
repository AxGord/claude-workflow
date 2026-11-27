---
name: target-openfl-native
description: OpenFL/lime native target specifics (display tree, lime/NDLL build, platform details)
---

# OpenFL/Lime Native — Gotchas & Pitfalls

General hxcpp gotchas (GC, threads, externs, boot order, boxing) are in target-hxcpp; load it too (not installed: install it with `wf-skills add target-hxcpp`).

See `references/` for build config and version notes.

## Versions

Reference baseline (verify against current toolchain): OpenFL 9.5.0, Lime 8.3.0. Android: NDK r28c, SDK 35 (JDK 17+), 16KB alignment.
Default Android archs: ARM64 + x86_64 (ARMv7 removed). iOS: ARM64 only.


### Display tree detach for background threads

`DisplayObject.parent = null` does NOT remove the object from the parent's `__children` array. The parent's render loop (OpenGL on main thread) still iterates `__children` and renders the "detached" object concurrently → segfault.

```haxe
// WRONG — parent field nulled but still in __children → main thread renders it
child.parent = null;

// RIGHT — remove from __children, then null parent
@:privateAccess parent.__children.remove(child);
child.parent = null;
```

To restore, save the child index before removing and re-insert at the same position:

```haxe
// Save
final savedIndex:Int = @:privateAccess parent.__children.indexOf(child);
@:privateAccess parent.__children.remove(child);
child.parent = null;

// Restore
@:privateAccess parent.__children.insert(savedIndex, child);
child.parent = savedParent;
```

**Why not `removeChild()`?** It dispatches REMOVED/REMOVED_FROM_STAGE events, nulls stage, and triggers side effects. Direct `__children` manipulation is a lightweight detach for thread isolation.

### project.xml: `if="release"` does NOT gate — use `unless="debug"`

In Lime's project.xml, the `release` define can be set even in `-debug` builds, so `if="release"` entries (haxedefs, sections) silently leak into debug. Unknown identifiers ARE falsy — `release` is specifically unreliable, not a parser quirk. The reliable gate is the `debug` define, set only by `-debug`:

```xml
<!-- WRONG — leaks into -debug builds -->
<haxedef name="analyzer-optimize" if="release" />

<!-- RIGHT — 'debug' is set only by -debug -->
<haxedef name="analyzer-optimize" unless="debug" />
```

Verify gating with `lime display <target> -debug | grep <define>` vs `-release` — never trust the conditional by reading it.

### Build.xml `outdir` resolves against the CWD, not the Build.xml location — and a misplaced artifact still prints `Link:` and exits 0

A relative `outdir` is joined to the directory hxcpp was INVOKED from. The standard Lime extension layout puts Build.xml in `project/` and writes `<outdir name="../ndll/${BINDIR}" />`, which is correct **only when the build runs from `project/`** — that is what `lime rebuild` does. Invoke the same file from the extension root and `../ndll/` climbs one level ABOVE the extension:

```sh
# WRONG — ../ndll/ resolves against the extension root → <parent-of-extension>/ndll/
cd <extension> && haxelib run hxcpp project/Build.xml -D<platform>

# RIGHT — ../ndll/ resolves to <extension>/ndll/, where the app links from
cd <extension>/project && haxelib run hxcpp Build.xml -D<platform>
```

This fails in the worst possible way: compilation succeeds, the build prints `Link: ../ndll/<BINDIR>/<lib>` (its own relative spelling, so it reads as correct), and the exit status is 0. Nothing is stale-checked, so the app keeps linking the OLD artifact and a newly added `DEFINE_PRIME*` entry point is simply absent at runtime — surfacing as a `Could not find primitive` / signature-mismatch crash far from the build.

**Never treat a green build as proof the artifact landed.** Check the file the app actually bundles:

```sh
stat -f "%Sm %z" <extension>/ndll/<BINDIR>/<lib>   # did the mtime move?
nm -gU <extension>/ndll/<BINDIR>/<lib> | grep <new_symbol>
```

A stray `ndll/` tree one level above an extension is the fingerprint of this mistake — from this build or an earlier one.

### `lime display` prints the CACHED hxml when the project file is older than it — it is not a fresh parse

`lime display <target> [-Dfoo]` reuses `<app path>/<target>/haxe/<buildType>.hxml` left by the last `lime build`/`update`, and only re-generates it when the project file's mtime is newer than that hxml (`MacPlatform.getDisplayHXML`, same in the other desktop platforms). So the output reflects the LAST BUILD's defines, not the flags on the command line: after a `-DUNIT_TESTS` build every later `lime display mac` still lists `-D UNIT_TESTS`, with the test haxelibs and `-D HEADLESS`, while `-D` flags you pass now are silently absent. Nothing in the output marks it as stale. Bisecting project.xml with copies under another name "works" only because a freshly copied file is newer than the hxml — the copy is parsed, the original is not, which makes the two look different for reasons that have nothing to do with their content.

```sh
# WRONG — reads the hxml of whatever was built last
lime display mac -debug -DFOO | grep '^-D'

# RIGHT — regenerate first, then read the file lime wrote
lime update mac -debug -DFOO >/dev/null && grep '^-D' dist/macos/haxe/debug.hxml
# (or: touch project.xml before `lime display`)
```

`buildType` is `debug` / `release` / `final`, so a `-debug` display reads `debug.hxml` — a test build (release) and an IDE debug build only collide on the `.app` bundle they both write into `<app path>/<target>/bin/`, not on the hxml.

### Native assets

Assets are **synchronous** on native — `Assets.getImage()` etc. return immediately. For runtime-added assets (not in project.xml): use `sys.io.File` directly — `lime.Assets` only knows compile-time manifest.

No leading slashes in asset paths — `"/manifest/default.json"` crashes on some native targets.

### SWF assets: Graphic symbols lose instance names

`getChildByName()` fails on children that are **Graphic** symbols in the SWF — OpenFL renders them inline and assigns auto-names (`instance1425`). Only **MovieClip** symbol type preserves the Animate instance name. If name-based access is needed on a Graphic, convert it to MovieClip in Animate and re-publish.

## Display Filters (GlowFilter, DropShadowFilter, etc.)

**GlowFilter on Label/Sprite container** — apply to the parent container (Label, Sprite), NOT to TextField directly. `label.filters = [new GlowFilter(...)]` works. `textField.filters` inside a Label wrapper does NOT produce visible results.

**BitmapData.draw() does NOT capture filters** — `bmd.draw(stage)` uses the software renderer and skips GPU filters. Use `window.readPixels()` instead — reads from the GPU framebuffer and captures everything including filters. Screenshot tooling (e.g. a debug bridge) should use readPixels with draw() as fallback.

**Search codebase first** — before implementing text outlines, shadows, or effects, grep for existing `GlowFilter`/`DropShadowFilter` usage in the project. Likely already solved with correct params.

**`DisplayObject.filters != null` forces `cacheAsBitmap = true`** — the getter is `return (__filters == null ? __cacheAsBitmap : true)`. Any non-null filters array (even a filter with alpha=0 or zero-radius) causes the object to render through the intermediate bitmap-cache path. Symptoms:

- Setting `obj.cacheAsBitmap = false` has NO effect when `filters != null` — the getter still returns `true`.
- At high render scales (video export, offscreen `BitmapData.draw` with large matrix), the intermediate cache bitmap can be sized wrong for the target, visually clipping the right/bottom of content (elements near those edges silently disappear from the output).

```haxe
// WRONG — unselected state keeps a zero-alpha filter "to avoid allocations"
override private function set_isSelected(value:Bool):Bool {
    final alpha:Float = value ? 1 : 0;
    obj.filters = [new GlowFilter(color, alpha, 4, 4, 1)];  // still forces cacheAsBitmap
    return isSelected = value;
}

// RIGHT — null out filters when not needed
override private function set_isSelected(value:Bool):Bool {
    obj.filters = value ? [new GlowFilter(color, 1, 4, 4, 1)] : null;
    return isSelected = value;
}
```

For batch operations (video export, offscreen render): if you cannot change the per-object filter logic, strip `filters` AND `cacheAsBitmap` on every descendant before the batch, save both values, and restore them after. Stripping only `cacheAsBitmap` is insufficient because the filter-override re-enables the cache path.

**BitmapData.draw() ignores source scaleX/scaleY** — setting `bitmap.scaleX = 0.5` then calling `bmd.draw(bitmap)` renders at full size, clipping to BitmapData bounds. The source object's transform properties are NOT applied. Use the Matrix parameter instead:

```haxe
// WRONG — draws at full size, clips
final src:Bitmap = new Bitmap(largeBmd);
src.scaleX = src.scaleY = 0.5;
smallBmd.draw(src);  // full-size render, clipped to smallBmd bounds

// RIGHT — Matrix applies the scale
final m:Matrix = new Matrix();
m.scale(0.5, 0.5);
smallBmd.draw(new Bitmap(largeBmd), m);
```

Affects both Cairo and GL renderers. Children inside a Sprite container DO get their transforms composed during rendering — only standalone DisplayObject transforms are ignored.

## BitmapData GPU Rendering (render-to-texture)

**Non-readable BitmapData triggers GL path** — `BitmapData.draw()` checks `!readable && context3D != null` and routes to `__drawGL` (render-to-texture via FBO). To enable: call `bmd.getTexture(ctx)` then `bmd.disposeImage()`.

**`copyPixels` silently no-ops on non-readable targets** — `if (!readable) return;`. When compositing a static background into a GPU BitmapData, use `draw(bitmap)` instead of `copyPixels`.

**`Context3D.__bindGLFramebuffer` is non-nullable** — the parameter type is `GLFramebuffer` (no `Null<>`). Passing `null` to bind the default framebuffer fails `@:nullSafety`. Workaround: skip the restore if the next `draw()` call will rebind via `setRenderToTexture` anyway — `__drawGL` always saves/restores FBO state.

**`GL.readPixels` returns rows bottom-up** — OpenGL origin is bottom-left. After reading from an FBO, flip rows vertically (swap top↔bottom) before passing to encoders that expect top-down pixel order.

**`UInt8Array` has NO `blit` method** — Lime's `UInt8Array` (abstract over `ArrayBufferView` on native) does not expose a static or instance `blit`. For byte-level copy/swap (e.g. row flipping after `glReadPixels`), convert to `haxe.io.Bytes` via `.toBytes()` — on native this returns the underlying buffer (no copy), then use `Bytes.blit()`:

```haxe
final bytes:Bytes = readbackArray.toBytes(); // no-copy on native
final tmp:Bytes = Bytes.alloc(rowStride);
tmp.blit(0, bytes, topOff, rowStride);       // top → tmp
bytes.blit(topOff, bytes, botOff, rowStride); // bottom → top
bytes.blit(botOff, tmp, 0, rowStride);        // tmp → bottom
```

### BitmapData.draw pixelRatio vs cache bitmaps (text blur on Windows)

`BitmapData.draw()` sets `renderer.__pixelRatio = window.scale`. TextFields with filters (GlowFilter, DropShadowFilter) go through `__updateCacheBitmap` which creates the cache bitmap at `pixelRatio` resolution. On Windows (`window.scale=1`), cache bitmaps are 1x — if the draw matrix scales up (e.g. a ~2x video-export draw matrix), the 1x cache is upscaled → blurry text.

**Fix**: set `pixelRatio = max(window.scale, transform_scale)` in `BitmapData.draw()` so cache bitmaps are rasterized at the final output resolution. This fixes BOTH code paths — text with filters (cache bitmap) and text without filters (Context3DTextField.render).

**Key insight**: fixing `pixelRatio` only in `Context3DTextField.render` (via `renderer.__worldTransform` scale) does NOT help text with filters — those bypass `render()` entirely and go through `__updateCacheBitmap` → `Context3DBitmap.render`.

**Testing gotcha**: on Mac (`window.scale=2`), simulating `pixelRatio=1` only in `BitmapData.draw` doesn't reproduce the bug — screen rendering already created 2x cache bitmaps. Must also force `pixelRatio=1` in `Stage.hx` (screen render) to accurately simulate Windows.

## Raw GL + Context3D Mixing

Context3D has TWO state objects: `__state` (desired) and `__contextState` (cached GL state). Cache invalidation must target `__contextState`, NOT `__state` — modifying `__state` corrupts desired state and causes unpredictable rendering.

When mixing raw GL calls (`glBindTexture`, `glUseProgram`, `glBindBuffer`, `glBindFramebuffer`) with Context3D rendering, the cached state in `__contextState` becomes stale. Context3D's flush methods (e.g. `__flushGLFramebuffer`) compare `__contextState` vs `__state` to decide whether to issue GL calls — stale cache means skipped rebinds.

**Preferred fix: ORDER OPERATIONS so Context3D rendering happens AFTER raw GL calls.** Each `BitmapData.draw()` creates a fresh `OpenGLRenderer` that fully reinitializes GL state through Context3D, making any prior raw GL state pollution irrelevant. This is far simpler than trying to save/restore GL state.

If you must interleave raw GL and Context3D:
- After raw GL calls, unbind everything (`gl.bindTexture(gl.TEXTURE_2D, null)`, etc.)
- Invalidate matching `__contextState` fields: `__currentGLFramebuffer`, `__currentGLTexture2D`, `__currentGLArrayBuffer`, `renderToTexture`, `program`, `shader`
- Note: `__bindGLTexture2D` cache is commented out in OpenFL (always calls `gl.bindTexture`), but framebuffer cache IS active in `__flushGLFramebuffer`
- Setting `__contextState` fields to `cast null` makes Context3D think "no current binding" — next flush will rebind. But if `__state` is ALSO null, Context3D sees them as matching and skips the rebind entirely

### Custom shader sampling Context3D textures — set texture params explicitly

`RectangleTexture` does NOT set `TEXTURE_MIN_FILTER`/`TEXTURE_MAG_FILTER` on creation. GL default is `GL_NEAREST_MIPMAP_LINEAR` which requires mipmaps — without them, `texture2D()` returns black (incomplete texture). Context3D's `__setSamplerState` sets these params during normal rendering, but custom GL shaders bypass it.

```haxe
// After bindTexture, before drawArrays:
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
```

## Edge Overlap for Gradient Fade Covers

OpenFL (like Flash) — elements at the same edge can leak 1-2px due to anti-aliasing, rounding, or offset children (e.g. scrollbar with `barPad > 0` extends past container width). Classic fix: **extend covering shapes a few pixels past the container edge**.

```haxe
// Gradient fade: alpha 0→1 over FADE_WIDTH
graphics.beginGradientFill(GradientType.LINEAR, [bg, bg], [0, 1], [0, 255], matrix);
graphics.drawRect(0, 0, FADE_WIDTH, h);
graphics.endFill();
// Solid overlap BEYOND container edge — covers scrollbar overshoot, sub-pixel artifacts
graphics.beginFill(bg);
graphics.drawRect(FADE_WIDTH, 0, OVERLAP, h);
graphics.endFill();
shape.x = containerWidth - FADE_WIDTH;  // gradient at edge, solid extends past it
```

Key: solid rect goes PAST `containerWidth`, not before it. Parent mask clips the visual excess, but the fill covers any children that overshoot the boundary (e.g. scrollbar offset by `barPad`). Verify by inspecting the display tree (debug-bridge query, runtime trace) — check child positions and widths to confirm the cover extends past all children.

## Actuate (Tween Library)

`Actuate.tween(target, duration, {prop: value})` — starting a new tween on the same target+property automatically stops the previous one. No need for `Actuate.stop(target)` before `Actuate.tween(target, ...)`.

`onUpdate` fires on the last frame too — inside `complete()`, before `onComplete`. So `onUpdate` + `onComplete` with the same callback = double call on the final frame. Use only `onUpdate` when you need per-frame sync (e.g. scrollbar position during tween).

**Per-frame polling during tween → `.onUpdate()`, NOT `addEventListener(ENTER_FRAME)`**. Actuate's `.onUpdate()` fires on every tween update — same cadence as ENTER_FRAME but tied to the tween lifecycle. No manual add/remove listener management needed, automatically cleaned up when tween stops.

**dispatchEvent during tween kills animation** — when a method starts a tween AND dispatches an event synchronously, event listeners may call a property setter that instantly sets the animated property to its target value, killing the tween. Fix: add early-return guard in setter when value unchanged (`if (_field == value) return`), and `Actuate.stop(target)` before instant-setting for programmatic changes.

**`Actuate.stop(target)` FIRES `onComplete`** — its defaults are `complete = false, sendEvent = true`, and with no `properties` the actuator runs `complete(sendEvent)`, which invokes the `onComplete` handler synchronously (Actuate 1.9.0, `SimpleActuator.stop` → `GenericActuator.complete`). A "stop the fade-in" in `dispose()` therefore starts the chained fade-out on the disposed object, and stopping the previous overlay inside a re-triggered flash runs its handler against state not yet reassigned. Pass `Actuate.stop(target, null, false, false)` whenever the tween has a completion you do not want.

## Built-in Utility Methods

OpenFL provides utility methods that are easy to miss. Use them instead of writing manual implementations:

- `Point.interpolate(pt1, pt2, t)` — linear interpolation between two points. Note: `pt1` is the end point, `pt2` is the start point, `t` is progress (0→pt2, 1→pt1)
- `Point.distance(pt1, pt2)` — distance between two points
- `Point.polar(len, angle)` — create point from polar coordinates
- `Rectangle.intersection()`, `Rectangle.union()` — rectangle math

## TextField Line Metrics

**A line advances by `ascent + descent + format.leading` — the FONT's line gap is ignored.**
`TextEngine` reads `leading` from the `TextFormat` (default 0), never from the face's `hhea.lineGap`
/ `OS/2.sTypoLineGap`. So a 12 px face whose file says ascent 750 / descent 250 / lineGap 200
advances 12.0 per line in OpenFL, not 14.4 — a line height derived from the font file (fontTools,
FreeType metrics) over-reserves by the gap on every line. Measure instead:
`field.getLineMetrics(0).height` after setting text, or `TextLineMetrics.ascent + descent`.

**Every line after the first renders 1 px below where that advance puts it.** A multi-line field
sized as `lines * advance + 4` (the 2 px gutter above and below) shears the descenders of its last
line by exactly one pixel per extra line. Reserve `(lines - 1)` extra pixels on top of the advance
sum; a height helper that walks `getLineMetrics(i)` per line has to add the same term.

## Cross-Target Differences

**ByteArray endianness**: native defaults `LITTLE_ENDIAN`, Flash hardcoded `BIG_ENDIAN`. Always set explicitly.

**DPI scaling**: iOS/macOS Retina `window.width` = DPI-scaled, `stage.stageWidth` = actual pixels. Android: both = device pixels.

**TextField HTML5**: AutoSize NONE gives incorrect textWidth/textHeight and wraps regardless of `wordWrap`.

## Touch vs Hover: runtime detection, not `#if mobile`

iOS supports hover (Apple Pencil 2, trackpad, mouse). Some Android devices too (Samsung S Pen, USB mouse). `#if mobile` is too coarse for touch vs hover distinction.

Use `event.buttonDown` in ROLL_OVER handler for runtime detection:
- Touch: ROLL_OVER fires with `buttonDown=true` (finger already pressing) → register one-shot stage MOUSE_UP to reset highlight
- Mouse/trackpad hover: ROLL_OVER fires with `buttonDown=false` → rely on ROLL_OUT as usual

ROLL_OVER on a direct finger tap is UNRELIABLE (observed missing on iPad native) — don't depend on it for press feedback. `MOUSE_DOWN` IS reliable (SDL synthesizes it from touch, `SDL_HINT_TOUCH_MOUSE_EVENTS="1"` in Lime): add a MOUSE_DOWN handler with the same body as the ROLL_OVER one, keep TOUCH_END for reset. No ENTER_FRAME/flags needed.

```haxe
private function hoverInHandler(event:MouseEvent):Void {
    _icon.color = Colors.HIGHLIGHT;
    if (event.buttonDown) {
        final s:Null<Stage> = stage;
        _stageRef = s;
        s?.addEventListener(MouseEvent.MOUSE_UP, stageMouseUpHandler);
    }
}
```

## Stage listener cleanup on dispose

When registering listeners on `stage` from a child display object, always store the stage reference in a `_stageRef` field. If the object is removed from display list before dispose, `stage` returns null and `stage?.removeEventListener` silently leaks the listener.

```haxe
// WRONG — stage is null after removeChild, listener leaks
stage?.removeEventListener(MouseEvent.MOUSE_UP, handler);

// RIGHT — stored reference works regardless of display list state
_stageRef?.removeEventListener(MouseEvent.MOUSE_UP, handler);
_stageRef = null;
```

## Event Listeners

### event.target — no cast needed

OpenFL's `event.target` is `Dynamic`. `Dynamic` implicitly converts to any type in Haxe — no cast required. `Std.downcast` and `cast()` are both unnecessary overhead.

```haxe
// WRONG — unnecessary runtime check + null handling
final target:Null<T> = Std.downcast(event.target, T);

// WRONG — unnecessary cast
_selected = cast(event.target, T);

// RIGHT — Dynamic assigns to any type implicitly
_selected = event.target;
```

### Accessing stage — use displayObject.stage, not Lib.current.stage

Any `DisplayObject` on the display list has a `.stage` property. Use it instead of the global `openfl.Lib.current.stage`:

```haxe
// WRONG — global static access, requires extra import
openfl.Lib.current.stage.addEventListener(Event.RESIZE, handler);

// RIGHT — use any display object already on stage
_button.stage.addEventListener(Event.RESIZE, handler);
this.stage.addEventListener(Event.RESIZE, handler);  // if 'this' is a DisplayObject
```

### `KeyboardEvent.keyCode` is the LAYOUT's character, not the physical key — letter shortcuts die on a non-Latin layout

`switch event.keyCode { case Keyboard.C: copy(); }` silently stops matching the moment the user types in a
Cyrillic/Greek/Hebrew/… layout: SDL reports the keycode the CURRENT layout produces, so the physical C key arrives as
`1089` (`с`), V as `1084` (`м`), Z as `1103` (`я`). Nothing errors — the shortcut just never fires, and the same build
works for anyone on a Latin layout, which is what makes it read as "works on my machine". The modifier keys themselves
also arrive through the handler (`15` = Command, `17` = Control on mac).

The physical scan code IS in the SDL event and lime THROWS IT AWAY at the C++ boundary: `lime/project/include/ui/KeyEvent.h`
declares `{ keyCode, modifier, type, windowID }` and `SDLApplication.cpp` copies only `keysym.sym` / `keysym.mod` — never
`keysym.scancode`. `Window.onKeyDown` is typed `KeyCode -> KeyModifier -> Void`, and openfl's `KeyboardEvent` carries
`keyCode`/`charCode`/`keyLocation`, so no layer downstream can hand it to you. Recovering it first-hand means patching both
forks and rebuilding the native libraries per platform.

What works without touching either fork: `lime.ui.ScanCode.fromKeyCode(keyCode)` — that is `SDL_GetScancodeFromKey` against
the CURRENT keymap (`lime/project/src/backend/sdl/SDLKeyCode.cpp`), i.e. SDL's own reverse lookup, not a hand-built table.
Letter scan codes are alphabetical (`ScanCode.A` = 4 … `ScanCode.Z` = 29), so the Latin code comes back by offset:

```haxe
// Latin layouts keep CHARACTER matching on purpose: on Dvorak/AZERTY the user expects
// cmd+C on the key that produces `c`, not on the QWERTY position of C. Only a layout
// with no `c` at all falls back to the physical key — the rule macOS and Windows follow.
if (keyCode >= Keyboard.A && keyCode <= Keyboard.Z) return keyCode;
final scanCode:Int = ScanCode.fromKeyCode(keyCode);
final firstLetterScanCode:Int = ScanCode.A;
final lastLetterScanCode:Int = ScanCode.Z;
return scanCode < firstLetterScanCode || scanCode > lastLetterScanCode ? keyCode : Keyboard.A + scanCode - firstLetterScanCode;
```

Two consequences worth carrying: "always use the scan code" is WRONG (it would move Dvorak/AZERTY shortcuts onto QWERTY
positions), and on a target without `lime_cffi` the lookup answers `ScanCode.UNKNOWN` (0), so the fallback must return the
original `keyCode` rather than trusting the result. Non-letter shortcuts (`ESCAPE`, `ENTER`, arrows) need none of this —
their key codes are layout-independent by construction.

### A listener's throw never reaches `dispatchEvent`'s caller once uncaught-error events are on

When any `UncaughtErrorEvent.UNCAUGHT_ERROR` listener exists on `loaderInfo.uncaughtErrorEvents` (typical for crash reporters), `stage.__uncaughtErrorEvents.__enabled` is true and `EventDispatcher.__dispatchEvent` wraps EACH listener call in try/catch, handing the error to `stage.__handleError`.

- **Tell:** `try dispatcher.dispatchEvent(e) catch (...)` is dead code in such an app - the throw goes to the crash handler (which usually exits), never to the caller.
- **Consequence:** "still fire the follow-up event if a listener throws" logic is moot - the app crashes instead.
- **Tests:** a unit test that adds a throwing listener and expects the throw to propagate fails, and takes the runner down through the crash handler.
- Without such a listener the throw propagates normally: behaviour depends on app setup, not on the dispatcher.

## OpenFL Internal APIs (for synthetic events / debug bridges)

### Coordinate pipeline for synthetic mouse events

Logical coords → `stage.__onMouse()` requires display-matrix input space, NOT stage coordinates:

```haxe
// logical (app coordinate space) → stage global → display input
final globalPoint:Point = contentRoot.localToGlobal(new Point(logicalX, logicalY));
final inputPoint:Point = stage.__displayMatrix.transformPoint(globalPoint);
stage.__onMouse(MouseEvent.MOUSE_DOWN, inputPoint.x, inputPoint.y, 0);
```

`__displayMatrix` on Retina: `scale(window.scale, window.scale)` — e.g. `scale(2,2)` for Retina.

### Hit-testing with shapeFlag=true

`stage.__hitTest(x, y, true, stack, true, stage)` — only **visible pixels** register. `graphics.beginFill(color, 0.0)` (alpha 0) is invisible to shape-flag testing. This affects transparent hit rects commonly used in UI components.

Display list hit-test order: **highest index first** (front-to-back). If a transparent hit rect at index 2 fails shape test, hit falls through to a lower-index sibling with visible pixels (e.g., a shadow at index 0).

### Scroll events bypass OS natural-scrolling inversion

Real scroll events: OS/SDL applies natural scrolling → Lime → OpenFL. Apps typically compensate with their own inversion flag on the scroll component.

Synthetic `stage.__onMouseWheel(deltaX, deltaY, mode)` bypasses OS/SDL, so the app's compensation causes **double inversion**. Fix: when the app's inversion flag is active, negate the delta before passing it to `__onMouseWheel`.

### __onMouseWheel needs __mouseX/Y set first

`__onMouseWheel` uses `stage.__mouseX/__mouseY` for hit-testing (not explicit coordinates). Send a `MOUSE_MOVE` first to position the internal mouse:

```haxe
stage.__onMouse(MouseEvent.MOUSE_MOVE, inputX, inputY, 0);  // sets __mouseX/Y
stage.__onMouseWheel(0, delta, MouseWheelMode.LINES);
```

## EGL Context and FBO Sharing (Android GPU Path)

**FBOs are NOT shared between EGL contexts** — even shared contexts (created with `eglCreateContext(..., shared_ctx, ...)`) do NOT share FBO objects. Only textures, renderbuffers, and buffer objects are shared.

**When blitting from an FBO created in context A to a surface created for context B**: use context A with the target surface (`eglMakeCurrent(display, target_surface, target_surface, context_A)`), not context B. This keeps the FBO visible while redirecting output to the target surface.

**eglPresentationTimeANDROID is required for correct timestamps**: Without calling `eglPresentationTimeANDROID()` before `eglSwapBuffers()`, MediaCodec uses wall-clock time instead of the intended presentation timestamp. Resolve the function pointer via `eglGetProcAddress("eglPresentationTimeANDROID")` at init time.

**EGL config compatibility for window surfaces**: When creating an EGL window surface for MediaCodec's ANativeWindow, use the same config as the caller's context (`eglQueryContext` → `EGL_CONFIG_ID` → `eglChooseConfig`). For test contexts, include `EGL_WINDOW_BIT` in `EGL_SURFACE_TYPE` alongside `EGL_PBUFFER_BIT`.
