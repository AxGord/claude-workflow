---
name: target-openfl-native
description: OpenFL/hxcpp native target gotchas
---

# OpenFL/Lime Native (hxcpp) — Gotchas & Pitfalls

See `references/` for build config and version notes.

## Versions

Reference baseline (verify against current toolchain): OpenFL 9.5.0, Lime 8.3.0. Android: NDK r28c, SDK 35 (JDK 17+), 16KB alignment.
Default Android archs: ARM64 + x86_64 (ARMv7 removed). iOS: ARM64 only.

## hxcpp GC ↔ C++ Interop

### GC roots — heap-stored Haxe objects are invisible to GC

GC scans the stack, not the C++ heap. Storing a Haxe object in a C++ member → premature collection.

```cpp
// WRONG — invisible to GC
class NativeHelper { value myHaxeObj; };

// RIGHT
class NativeHelper {
    AutoGCRoot *root;
    NativeHelper(value obj) { root = new AutoGCRoot(obj); }
    value get() { return root->get(); }
};
```

### @:unreflective suppresses GC scanning

`@:unreflective` on a field prevents GC from tracing it. Only use on fields with native C++ types, never on fields holding Haxe objects.

### Moving GC (HXCPP_GC_MOVING)

Invalidates raw C++ pointers to Haxe objects after collection. Also shows erratic memory growth during long load/unload cycles — may exceed non-moving GC over time.

## Pointer Types

| Type | C++ | GC? | Use case |
|------|-----|-----|----------|
| `cpp.RawPointer<T>` | `T*` | No | Native C++ function params |
| `cpp.Pointer<T>` | wrapper | **Yes** | Dynamic typing, array indexing |
| `cpp.Star<T>` | `T*` typedef | No | Extern signatures |
| `cpp.Reference<T>` | `T&` | No | C++ reference params |

`addressOf()` on `Dynamic` → pointer to stack wrapper, NOT the object. Crashes after stack frame changes.

## Threading

### Foreign threads MUST register with GC

```cpp
void foreign_thread_func() {
    int stackTop;
    SetTopOfStack(&stackTop, true);  // MUST be stack variable, not heap
    // ... use hxcpp APIs ...
    SetTopOfStack(0, false);
}
```

### Blocking operations need GC-free zone

GC is stop-the-world. Blocking without GC-free zone deadlocks entire GC. This includes mutex waits — Thread A holds mutex, GC triggers on Thread B, deadlock.

```haxe
cpp.vm.Gc.enterGCFreeZone();
// blocking I/O, network, sleep, mutex wait...
cpp.vm.Gc.exitGCFreeZone(); // MUST also exit on error paths
```

**CAUTION**: Only use GC-free zones on threads that are properly registered with GC. Calling enter/exitGCFreeZone from `Thread.create()` threads that haven't done GC work yet can cause "GCFree Zone mismatch" errors.

### NEVER wrap Sys.sleep() (or other hxcpp std functions) with GC-free zone

`mGCFreeZone` is a **boolean, NOT a counter** (`Immix.cpp:5830`). `Sys.sleep()` internally calls `enterGCFreeZone()`/`exitGCFreeZone()` (`Sys.cpp:125,147`). Wrapping it with additional enter/exit causes nested mismatch:

```haxe
// WRONG — double enter/exit, intermittent CriticalGCError → SIGTRAP crash
cpp.vm.Gc.enterGCFreeZone();
Sys.sleep(0.001);  // internally: enter(sets true) → sleep → exit(sets false)
cpp.vm.Gc.exitGCFreeZone();  // mGCFreeZone already false → "GCFree Zone mismatch"

// RIGHT — Sys.sleep() handles GC-free zone internally
Sys.sleep(0.001);
```

The crash is **intermittent** — depends on whether GC collection triggers between inner exit and outer exit. Same applies to all `_hx_std_*` functions in `Sys.cpp` that wrap with GC-free zones: `sys_command`, `sys_exists`, `file_delete`, `file_stat`, etc.

### Bool flags invisible across threads in release mode

C++ optimizer (`-O2`) hoists field reads out of loops. A `Bool` flag set from thread A is never seen by thread B's `while (!flag)` loop — the read is optimized to a single load before the loop.

```haxe
// WRONG — _stopped may never be seen as true by other threads
while (!_stopped) { Sys.sleep(0.1); }

// RIGHT — Mutex acquire/release creates memory barrier
private final _flagsMutex:Mutex = new Mutex();

// Writer (any thread):
_flagsMutex.acquire();
_stopped = true;
_flagsMutex.release();

// Reader (any thread):
_flagsMutex.acquire();
final stopped:Bool = _stopped;
_flagsMutex.release();
```

### Stopping worker threads — the pattern

Worker threads typically loop with `Sys.sleep()` + condition checks. To stop them reliably:

1. **Flag visibility**: Use Mutex-protected reads/writes for stop flags (see above)
2. **Blocking operations can't check flags**: If a thread is stuck inside a long-running method (DB query, file I/O, network), no flag check will help until the method returns
3. **Timeout + skip cleanup**: When waiting for a thread to stop, use a timeout. If timeout expires, the thread is stuck in a blocking op — skip `close()`/cleanup and just null out references. The OS will clean up on process exit
4. **Don't close resources held by stuck threads**: Calling `db.close()` while a worker thread still holds a DB lock → deadlock. Skip close on timeout

```haxe
// Stopping pattern
_worker.stopRequested = true;  // Mutex-protected setter
var waited:Int = 0;
while (!_worker.isStopped() && waited < TIMEOUT_MS) {
    Sys.sleep(0.1);
    waited += 100;
}
if (waited < TIMEOUT_MS) {
    // Thread stopped cleanly — safe to close resources
    try db.close() catch (e:Dynamic) {};
}
// Always null out regardless
_worker = null;
```

### Display tree detach for background threads

`DisplayObject.parent = null` does NOT remove the object from the parent's `__children` array. The parent's render loop (OpenGL on main thread) still iterates `__children` and renders the "detached" object concurrently → segfault.

```haxe
// WRONG — parent field nulled but still in __children → main thread renders it
pitchAreaGroup.parent = null;

// RIGHT — remove from __children, then null parent
@:privateAccess parent.__children.remove(pitchAreaGroup);
pitchAreaGroup.parent = null;
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

### Sys.exit() doesn't flush stdout

`Sys.exit()` calls C `exit()`. In worker threads, stdout buffer may not flush. Always call `Sys.stdout().flush()` before `Sys.exit()`.

## Extern Patterns (@:native)

### Pointer suffix for heap-allocated types

```haxe
@:native("Greeter*")  // ← asterisk required for `new`-allocated C++ objects
@:include("greeter.h")
extern class Greeter { ... }
// WITHOUT "*" → error only when multiple methods called (optimizer masks single-method case)
```

### Linc-style extern — all four metadata needed

```haxe
@:include("SDL.h")       // header
@:native("SDL_Window")   // C++ name
@:structAccess           // . not -> (value types)
@:unreflective           // skip GC scan (native type)
extern class SDLWindow { ... }
```

### @:nativeGen restrictions

Cannot extend non-@:nativeGen class. Cannot implement interfaces (rely on Dynamic). Leaf classes or full hierarchies only.

### Code injection

| Metadata | Location | Use for |
|----------|----------|---------|
| `@:headerCode` | Top of .h | #include directives |
| `@:headerClassCode` | Inside class in .h | Private C++ members |
| `@:cppFileCode` | Top of .cpp | Static helpers |
| `@:functionCode` | Function body top | Local C++ vars |

`@:functionCode` does NOT work in inline methods. `@:include` is NOT propagated to child classes — re-declare.

## @:cppFileCode with ObjC headers on iOS — Foundation/NSString conflict

Including `<OpenGLES/EAGL.h>` or any header that pulls in `Foundation.h` inside `@:cppFileCode` causes a compile error on iOS. The generated `.cpp` file includes hxcpp headers first (which define `hx::String` in the `hx` namespace and typedef it as `String`). When Foundation.h is then included, its `NSString` definition conflicts with the already-defined `String` symbol.

```haxe
// WRONG — Foundation.h (pulled by EAGL.h) conflicts with hxcpp's String typedef
@:cppFileCode('
    #include <OpenGLES/EAGL.h>
    EAGLContext* getContext() { return [EAGLContext currentContext]; }
')
```

**Workaround**: use `<objc/runtime.h>` + `objc_msgSend` to call ObjC class methods without importing the framework header. Define C helper functions in `@:cppFileCode` that wrap `objc_msgSend` calls with proper casts.

```haxe
// RIGHT — no Foundation.h import, no conflict
@:cppFileCode('
    #include <objc/runtime.h>
    #include <objc/message.h>

    static void* tm_get_eagl_context() {
        Class cls = objc_getClass("EAGLContext");
        SEL sel = sel_registerName("currentContext");
        return ((void* (*)(id, SEL))objc_msgSend)((id)cls, sel);
    }
')
```

For methods that return structs (e.g. `CGRect`, `CGSize`), use `objc_msgSend_stret` on 32-bit and regular `objc_msgSend` on 64-bit ARM (stret is deprecated on arm64).

## Build System

`<files>` → compile step (includes). `<target>` → link step (libraries). Mixing → silent failures.

hxcpp does NOT auto-create directories. `<copyFile>` with subdirs fails silently — use `<mkdir>` first.

### Platform conditionals: `macos` not `mac`

hxcpp Build.xml uses `macos` for macOS conditionals — NOT `mac`. Using `mac` silently fails (condition never matches), producing `.dylib` instead of `.ndll`. At runtime, `<ndll>` loads the stale `.ndll` which lacks `__prime` symbols → `Could not find primitive` errors.

```xml
<!-- WRONG — 'mac' is not a valid hxcpp platform identifier -->
<ext value=".ndll" if="windows || mac || linux" />

<!-- RIGHT — 'macos' matches hxcpp's HX_MACOS define -->
<ext value=".ndll" if="windows || macos || linux" />
```

Other valid platform identifiers: `windows`, `linux`, `android`, `iphoneos`, `iphonesim`.

### Build.xml `outdir` is relative to Build.xml location, not project root

When Build.xml lives in a `project/` subdirectory (standard Lime extension layout), `outdir name="ndll/${BINDIR}"` outputs to `project/ndll/` — not the root `ndll/` that Lime expects.

```xml
<!-- WRONG — outputs to project/ndll/ when Build.xml is in project/ -->
<outdir name="ndll/${BINDIR}" />

<!-- RIGHT — ../ndll/ resolves to root ndll/ -->
<outdir name="../ndll/${BINDIR}" />
```

Always verify with `lime rebuild` locally after moving Build.xml or changing `outdir`.

### Native assets

Assets are **synchronous** on native — `Assets.getImage()` etc. return immediately. For runtime-added assets (not in project.xml): use `sys.io.File` directly — `lime.Assets` only knows compile-time manifest.

No leading slashes in asset paths — `"/manifest/default.json"` crashes on some native targets.

## Display Filters (GlowFilter, DropShadowFilter, etc.)

**GlowFilter on Label/Sprite container** — apply to the parent container (Label, Sprite), NOT to TextField directly. `label.filters = [new GlowFilter(...)]` works. `textField.filters` inside a Label wrapper does NOT produce visible results.

**BitmapData.draw() does NOT capture filters** — `bmd.draw(stage)` uses the software renderer and skips GPU filters. Use `window.readPixels()` instead — reads from the GPU framebuffer and captures everything including filters. Debug bridge already uses readPixels with fallback to draw.

**Search codebase first** — before implementing text outlines, shadows, or effects, grep for existing `GlowFilter`/`DropShadowFilter` usage in the project. Likely already solved with correct params.

**`DisplayObject.filters != null` forces `cacheAsBitmap = true`** — the getter is `return (__filters == null ? __cacheAsBitmap : true)`. Any non-null filters array (even a filter with alpha=0 or zero-radius) causes the object to render through the intermediate bitmap-cache path. Symptoms:

- Setting `obj.cacheAsBitmap = false` has NO effect when `filters != null` — the getter still returns `true`.
- At high render scales (video export, offscreen `BitmapData.draw` with large matrix), the intermediate cache bitmap can be sized wrong for the target, visually clipping the right/bottom of content (e.g. missing right post, missing background geometry).

```haxe
// WRONG — unselected state keeps a zero-alpha filter "to avoid allocations"
override function set_isSelected(value:Bool):Bool {
    final alpha:Float = value ? 1 : 0;
    obj.filters = [new GlowFilter(color, alpha, 4, 4, 1)];  // still forces cacheAsBitmap
    return isSelected = value;
}

// RIGHT — null out filters when not needed
override function set_isSelected(value:Bool):Bool {
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

`BitmapData.draw()` sets `renderer.__pixelRatio = window.scale`. TextFields with filters (GlowFilter, DropShadowFilter) go through `__updateCacheBitmap` which creates the cache bitmap at `pixelRatio` resolution. On Windows (`window.scale=1`), cache bitmaps are 1x — if the draw matrix scales up (e.g. video export batchMatrix ~2x), the 1x cache is upscaled → blurry text.

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

Key: solid rect goes PAST `containerWidth`, not before it. Parent mask clips the visual excess, but the fill covers any children that overshoot the boundary (e.g. scrollbar offset by `barPad`). Verify with `display_find` — check child positions and widths to confirm the cover extends past all children.

## Actuate (Tween Library)

`Actuate.tween(target, duration, {prop: value})` — starting a new tween on the same target+property automatically stops the previous one. No need for `Actuate.stop(target)` before `Actuate.tween(target, ...)`.

`onUpdate` fires on the last frame too — inside `complete()`, before `onComplete`. So `onUpdate` + `onComplete` with the same callback = double call on the final frame. Use only `onUpdate` when you need per-frame sync (e.g. scrollbar position during tween).

**Per-frame polling during tween → `.onUpdate()`, NOT `addEventListener(ENTER_FRAME)`**. Actuate's `.onUpdate()` fires on every tween update — same cadence as ENTER_FRAME but tied to the tween lifecycle. No manual add/remove listener management needed, automatically cleaned up when tween stops.

**dispatchEvent during tween kills animation** — when a method starts a tween AND dispatches an event synchronously, event listeners may call a property setter that instantly sets the animated property to its target value, killing the tween. Fix: add early-return guard in setter when value unchanged (`if (_field == value) return`), and `Actuate.stop(target)` before instant-setting for programmatic changes.

## Built-in Utility Methods

OpenFL provides utility methods that are easy to miss. Use them instead of writing manual implementations:

- `Point.interpolate(pt1, pt2, t)` — linear interpolation between two points. Note: `pt1` is the end point, `pt2` is the start point, `t` is progress (0→pt2, 1→pt1)
- `Point.distance(pt1, pt2)` — distance between two points
- `Point.polar(len, angle)` — create point from polar coordinates
- `Rectangle.intersection()`, `Rectangle.union()` — rectangle math

## Performance

**Null\<Float\> is 50x slower** — C++ boxes as heap GC object, allocates on every assignment. Use sentinel values.

**Dynamic allocates on null check** — comparing callback to null creates a Dynamic wrapper. Avoid in hot loops.

**Modulo goes through fmod()** — `x % n` on ints converts to double → `fmod()`. Use `x & (n - 1)` for power-of-2.

**Iterator for-loops allocate** — `for (item in array)` creates GC iterator object. Use `for (i in 0...array.length)`.

**Map degrades after ~50k keys** — becomes 50%+ slower than neko at 100k. Use custom structures for large maps.

## Cross-Target Differences

**ByteArray endianness**: native defaults `LITTLE_ENDIAN`, Flash hardcoded `BIG_ENDIAN`. Always set explicitly.

**DPI scaling**: iOS/macOS Retina `window.width` = DPI-scaled, `stage.stageWidth` = actual pixels. Android: both = device pixels.

**TextField HTML5**: AutoSize NONE gives incorrect textWidth/textHeight and wraps regardless of `wordWrap`.

## Debugging

| Define | Effect | Overhead |
|--------|--------|----------|
| `HXCPP_DEBUG_LINK` | Symbol tables | Minimal |
| `HXCPP_CHECK_POINTER` | NULL → exception not segfault | Small |
| `HXCPP_STACK_TRACE` | Function names in traces | Small |
| `HXCPP_STACK_LINE` | Line numbers (implies above) | Medium |
| `-debug` | All above + no optimization | ~80% |

**Crash investigation builds**: When reproducing a crash via debug bridge, always add `-DHXCPP_CHECK_POINTER` to the build flags. Without it, a Null Object Reference is a silent segfault with no stack trace — useless for diagnosis. `-debug` includes it automatically, but if already building with `-debug`, you're covered.

**Null function pointer = hard crash**: `var f:Void->Void = null; f();` → C++ NULL dereference, not catchable. Check before calling.

## Touch vs Hover: runtime detection, not `#if mobile`

iOS supports hover (Apple Pencil 2, trackpad, mouse). Some Android devices too (Samsung S Pen, USB mouse). `#if mobile` is too coarse for touch vs hover distinction.

Use `event.buttonDown` in ROLL_OVER handler for runtime detection:
- Touch: ROLL_OVER fires with `buttonDown=true` (finger already pressing) → register one-shot stage MOUSE_UP to reset highlight
- Mouse/trackpad hover: ROLL_OVER fires with `buttonDown=false` → rely on ROLL_OUT as usual

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

## OpenFL Internal APIs (for synthetic events / debug bridges)

### Coordinate pipeline for synthetic mouse events

Logical coords → `stage.__onMouse()` requires display-matrix input space, NOT stage coordinates:

```haxe
// logical (1080×670) → stage global → display input
final globalPoint:Point = sceneLayer.localToGlobal(new Point(logicalX, logicalY));
final inputPoint:Point = stage.__displayMatrix.transformPoint(globalPoint);
stage.__onMouse(MouseEvent.MOUSE_DOWN, inputPoint.x, inputPoint.y, 0);
```

`__displayMatrix` on Retina: `scale(window.scale, window.scale)` — e.g. `scale(2,2)` for Retina.

### Hit-testing with shapeFlag=true

`stage.__hitTest(x, y, true, stack, true, stage)` — only **visible pixels** register. `graphics.beginFill(color, 0.0)` (alpha 0) is invisible to shape-flag testing. This affects transparent hit rects commonly used in UI components.

Display list hit-test order: **highest index first** (front-to-back). If a transparent hit rect at index 2 fails shape test, hit falls through to a lower-index sibling with visible pixels (e.g., a shadow at index 0).

### Scroll events bypass OS natural-scrolling inversion

Real scroll events: OS/SDL applies natural scrolling → Lime → OpenFL. App compensates via `ScrollContainer.inverted` flag.

Synthetic `stage.__onMouseWheel(deltaX, deltaY, mode)` bypasses OS/SDL, so the app's compensation causes **double inversion**. Fix: negate delta when `ScrollContainer.inverted` is true before passing to `__onMouseWheel`.

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
