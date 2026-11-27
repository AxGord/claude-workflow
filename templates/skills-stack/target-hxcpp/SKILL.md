---
name: target-hxcpp
description: hxcpp target gotchas (GC, threads, externs, boot order, generated C++, value boxing), for any Haxe code built for cpp
---

# hxcpp (Haxe C++) — Gotchas & Pitfalls

For any Haxe code built with `-cpp`, with or without OpenFL. See `references/build-and-types.md` for defines, cross-compilation, build.xml and the Haxe→C++ type mapping. OpenFL/lime specifics are in `target-openfl-native`.

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

## Static Init Boot Order (`__boot_all`)

Each class's static-variable initializers AND its RTTI payload (`__mClass->__rtti__`, from `@:rtti`) are set inside that class's generated `__boot()`. `__boot_all()` calls these in a generator-chosen order — not declaration order, not strictly alphabetical.

**Observed (hxcpp 4.x)**: for a class `A` with an eager static `static var _instance:A = new A();`, dependency objects constructed inside `A`'s **constructor body** get hoisted to boot before `A`. The same dependency constructed in a **field-declaration initializer** (`public final child:B = new B();`) does NOT get hoisted — it boots after `A`, in roughly module-alphabetical order.

Consequence: a runtime guard that inspects another class's boot state during construction (e.g. `haxe.rtti.Rtti.hasRtti(Type.getClass(this))` in a base-class constructor) passes when `new B()` sits in the ctor body, but throws ("requires @:rtti notation") when the identical init is moved to the field declaration — `B.__boot()` hasn't assigned `__rtti__` yet.

```haxe
// RISKY — field-decl init boots AFTER A; RTTI guard in B's base ctor can fire too early
class A {
    public static var _instance:A = new A();
    public final child:B = new B();
}

// SAFER — construct in ctor body; observed to hoist B ahead of A
class A {
    public static var _instance:A = new A();
    public final child:B;
    public function new() { child = new B(); }
}
```

Nothing at compile time catches this (typecheck clean, lint clean) — only launching the binary does, and it crashes before any test runner starts. Check the process exit code and log tail, not just "did output stop".

**Robust fix**: never build an object graph that depends on other classes' boot state (RTTI guards, static registries) from an EAGER static initializer — make the static lazy (nullable, create on first accessor call). Fighting generator-chosen boot order from Haxe code is not controllable.

## Diff the GENERATED C++ — a typecheck is blind, a full build is not the only alternative

"Does this refactor change anything on hxcpp?" (moving a ctor init to a field declaration, relocating an `untyped __cpp__` splice, reordering statics) reads as unanswerable without a full native build, so it gets settled by guessing — either shipping the change unverified or reverting a harmless one. Both are avoidable: hxcpp's `-D no-compilation` emits the whole C++ tree and skips the compiler, so the question becomes a text diff that costs seconds.

```sh
haxe <target>.hxml            # hxml already carries -D no-compilation + -cpp <objdir>
cp -R <objdir> /tmp/gen-before
# apply the change
haxe <target>.hxml
diff -r /tmp/gen-before <objdir>
```

Diff the WHOLE output dir, not one class's `.cpp`. Per-class emit lives in `<Class>.cpp`; the boot ordering the section above warns about lives in the generated `__boot__.cpp`, whose `__boot_all()` is an explicit ordered list of `__boot()` calls. Only a tree-wide diff covers both.

Expect line-number churn: `HX_STACKFRAME` / `HXDLIN(n)` macros embed source line numbers, so a pure statement move shows up as renumbering with identical bodies — that IS the "no-op" verdict, not noise to explain away.

What this does and does not prove: it settles CODEGEN equivalence (same emitted statements, same boot order). It says nothing about whether the emitted C++ compiles when the change introduces new native constructs — for that you still need the real build.

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
if (_worker.isStopped()) {
    // Thread stopped cleanly — safe to close resources.
    // Re-check the flag, NOT the timer: the worker may have stopped
    // during the final sleep, right as the timeout expired.
    try db.close() catch (e:Dynamic) {};
}
// Always null out regardless
_worker = null;
```
### Sys.exit() doesn't flush stdout

`Sys.exit()` calls C `exit()`. In worker threads, stdout buffer may not flush. Always call `Sys.stdout().flush()` before `Sys.exit()`.

### Sys.exit() races hxcpp GC mutex destruction → `mutex lock failed: Invalid argument`

`Sys.exit()` → libc `exit()` → runs C++ static destructors, including hxcpp's GC mutexes (`sThreadPoolLock` in `hx::gc::Immix.cpp`, `g_threadInfoMutex` in `hx::Thread.cpp`). The GC worker thread is NOT stopped by `exit()`. Its next `pthread_mutex_lock` on a now-destroyed mutex returns EINVAL → libc++abi terminates with `mutex lock failed: Invalid argument`. Manifests differently per platform: Linux shows `terminate ... std::system_error ... Invalid argument`, Windows is silent or AV, macOS crashes at unit test exit.

Fix: after cooperative cleanup, skip C++ static destructors by calling `_Exit` (see below).

### `_exit` from `<unistd.h>` is NOT available; use `_Exit` from `<cstdlib>`

hxcpp does NOT auto-include `<unistd.h>`. `untyped __cpp__("::_exit({0})", code)` fails with `error: no type named '_exit' in the global namespace`.

Use C99 `_Exit` (capital E) from `<cstdlib>` — skips C++ static destructors and atexit handlers, identical to `_exit` in effect, portable across Darwin/Linux/Windows MSVC.

```haxe
// WRONG — <unistd.h> not included by hxcpp; compile error
untyped __cpp__("::_exit({0})", code);

// RIGHT — <cstdlib> is safe; _Exit skips static destructors
@:cppFileCode("#include <cstdlib>")
final class CleanExit {
    public static function exit(code:Int):Void {
        try Sys.stdout().flush() catch (_:Exception) {}  // see "doesn't flush stdout" above
        try Sys.stderr().flush() catch (_:Exception) {}
        #if cpp
        untyped __cpp__("std::_Exit({0})", code);
        #else
        Sys.exit(code);
        #end
    }
}
```

**Warning**: `_Exit` skips ALL atexit handlers. Any pending writes (DB flushes, file saves) are lost. Only call after cooperative cleanup. Keep this as a small shared utility class.

## Sockets

### Read-timeout error string differs by platform — classify by elapsed time, not text

hxcpp's `block_error()` throws `"Blocking"` only for EAGAIN/EWOULDBLOCK/EINPROGRESS/EALREADY on POSIX and WSAEWOULDBLOCK/WSAEALREADY on Windows; everything else — including WSAETIMEDOUT, what `SO_RCVTIMEO` actually produces on Windows — falls into the generic `"EOF"` string. The Haxe std maps `"Blocking"` → `haxe.io.Error.Blocked`, anything else → `Error.Custom(e)`. So a `socket.setTimeout()` / `Http.cnxTimeout` read timeout surfaces as `Blocked` on macOS/Linux and over TLS on every platform (mbedtls maps its own WANT_READ to `"Blocking"`), but as `Custom(EOF)` for a plain socket on Windows — `sys.Http.customRequest` hands that string straight to `onError`.

```haxe
// WRONG — misses the timeout on Windows plain sockets; treats it as a connection error, retries a non-idempotent POST
if (msg == "Blocked") isTimeout = true;

// RIGHT — classify by elapsed time, not error text
if (failed && Timer.stamp() - started >= timeoutSeconds) isTimeout = true;
```

A real peer close is `haxe.io.Eof` (0-byte recv) on every platform — distinct from the `"EOF"` string above, which is a read-error code, not end-of-stream.

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

    static void* get_eagl_context() {
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

## Performance

**Null\<Float\> is 50x slower** — C++ boxes as heap GC object, allocates on every assignment. Use sentinel values.

**`?p:T = default` on a value type boxes on hxcpp** — the parameter stays `Dynamic` for the whole body; dropping the `?` gives a `hx::Null<T>` boundary and native values (but breaks a literal `null` argument on static targets and any override or interface implementation). (Measured once, not re-verified.)

**`Lambda.foreach` / `exists` go through reflection on hxcpp** — `Iterable<A>` erases to `Dynamic`: reflective field lookups per iteration plus a closure; an inlined flag-and-break body removes all of it. (Measured once, not re-verified.)

**Dynamic allocates on null check** — comparing callback to null creates a Dynamic wrapper. Avoid in hot loops.

**Modulo goes through fmod()** — `x % n` on ints converts to double → `fmod()`. Use `x & (n - 1)` for power-of-2.

**Iterator for-loops allocate** — `for (item in array)` creates GC iterator object. Use `for (i in 0...array.length)`.

**Map degrades after ~50k keys** — becomes 50%+ slower than neko at 100k. Use custom structures for large maps.

**A declaration's SCOPE is transliterated 1:1 — narrowing one into a loop costs nothing.** hxcpp emits a local exactly where it was written: `var x:Int;` inside a `while` body becomes `int x;` inside that C++ block, not a hoisted slot. The frame is allocated once on function entry and the value lives in a register, so the hoisted and the sunk spelling produce identical machine code — there is no per-iteration allocation to fear. Same for a reference type: `::String s = …` in a loop body is a stack slot with an empty constructor, and heap traffic comes from the INITIALIZER, which ran per-iteration in the hoisted spelling too. So "will moving this declaration inside the loop re-allocate?" is always no; the only reason to refuse is SEMANTIC (a value carried across iterations, or a closure that captured one shared binding). Settle any such question in seconds with the `-D no-compilation` recipe above rather than reasoning about it.

## Debugging

| Define | Effect | Overhead |
|--------|--------|----------|
| `HXCPP_DEBUG_LINK` | Symbol tables | Minimal |
| `HXCPP_CHECK_POINTER` | NULL → exception not segfault | Small |
| `HXCPP_STACK_TRACE` | Function names in traces | Small |
| `HXCPP_STACK_LINE` | Line numbers (implies above) | Medium |
| `-debug` | All above + no optimization | ~80% |

**Crash investigation builds**: When building a binary to reproduce a crash, always add `-DHXCPP_CHECK_POINTER` to the build flags. Without it, a Null Object Reference is a silent segfault with no stack trace — useless for diagnosis. `-debug` includes it automatically, but if already building with `-debug`, you're covered.

**Null function pointer = hard crash**: `var f:Void->Void = null; f();` → C++ NULL dereference, not catchable. Check before calling.

