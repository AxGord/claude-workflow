---
name: lang-as3
description: AS3 / AIR 51 language gotchas — optional chaining bugs, immutability limits, event dispatch semantics
---

# AS3 / AIR 51 — Verified Gotchas

## Optional chaining `?.`

- **Property access**: `obj?.prop` — works, returns `undefined` if null
- **Method calls**: `obj?.method()` — **BROKEN**. Calls `null()` instead of short-circuiting. Use `if (obj != null) obj.method()`
- When reverting a broken `?.` call to an explicit null-check, leave a marker comment at the site (e.g. `// ?. AIR bugfix — don't restore optional chaining`) so later edits don't reintroduce the bug

## Immutability

- `final` only works on **methods and classes**, NOT on fields — `final var` is a compile error
- Use `const` for never-reassigned fields instead: `private const _items:Array = [];` — assign only at the declaration. AIR 51 SDK (`asconfigc`) rejects a constructor assignment (`private const _x:T;` then `_x = value;` in the constructor) with `Illegal assignment to a variable specified as constant` — same result for a public class, a file-level helper class outside the package block, and primitive or reference field types. Use a private `var` for constructor-injected values.
- `const` is shallow — the binding is fixed, the object's contents stay mutable

## `removeEventListener` does not take effect during an in-flight dispatch

Adobe docs (`EventDispatcher`): *"If an event listener is removed from a node while an event is being processed on the node, it is still triggered by the current actions."* The listener list is snapshotted when the dispatch starts.

- Listener **added** during dispatch → not called in the current phase.
- Listener **removed** during dispatch → **still called** in the current dispatch.

Consequence: a handler can run *after* its own cleanup already nulled the fields it reads → `TypeError #1009`. Classic shape — many objects listen to `stage` `ENTER_FRAME`; handler A synchronously disposes object B; B's handler is still in the snapshot and fires with `_field == null`.

Removing a listener is therefore **not** a sufficient guard. Any handler on a shared dispatcher must also null-check the state it touches, or check a `disposed` flag first.

## `as` operator with primitive types

- `context.call(...) as int` works **only** if the native extension returns `FRENewObjectFromInt32` (value arrives as a boxed `int`). If the C++ side returns `FRENewObjectFromDouble`, `as int` silently returns `null`, which coerces to `0`.
- Prefer explicit cast: `int(context.call(...))` — works regardless of whether the native side returns `int`, `uint`, `Number`, or `double`.
- `as` is designed for reference types. With primitives (`int`, `uint`, `Number`, `Boolean`), behavior depends on the exact runtime type of the boxed value — fragile and non-obvious.

## `NativeProcess` on Linux inherits every fd

- AIR opens files, V4L2 camera/decoder nodes, etc. without close-on-exec, and every spawned child inherits them all. No `NativeProcessStartupInfo` option prevents it.
- A child holding such a descriptor keeps the resource owned: e.g. a V4L2 queue stays busy, so the app's own reopen fails with `EBUSY` for as long as the child lives. Long-lived children (decoders, browsers, watchdogs) make it permanent.
- Workaround: `executable = /bin/bash`, `arguments = ['-c', PREFIX, realExe.nativePath, ...realArgs]` where `PREFIX` closes fds >= 3 then `exec`s the real binary in place (same pid, so `NativeProcess.exit()` still kills it; stdio 0-2 and argv pass through untouched): `for f in /proc/self/fd/*; do n=${f##*/}; [ "$n" -ge 3 ] 2>/dev/null && eval "exec $n>&-"; done; exec "$0" "$@"`
- Must be `bash`, not `/bin/sh`: on Debian/Ubuntu that is dash, which cannot address fds above 9 - `exec 12>&-` makes it look for a command named `12` and the shell exits 127.
- Never put a stderr redirect on the loop or the eval (` 2>/dev/null`): for a redirected command, bash first saves stderr on a spare fd (>= 10); the loop can close that saved copy, so the exec'd child silently starts with stderr on `/dev/null` - every time for a loop-level redirect, only for some fd layouts (e.g. lowest free fd 11 or 100) for an eval-level one, so a single-layout test can pass while it is broken. Closing an fd that is not open is silent in bash, so no redirect is needed there; redirecting the `[` test is harmless.
- Test such a wrapper for stderr survival, not only closed fds and argv, across several fd layouts (contiguous, and with a gap), with a positive control proving the harness detects a lost stderr.
- Decide "is Linux" with `flash.system.Capabilities.os` (starts with `"Linux"`; Android matches too, so also check `/bin/bash` exists) - not a helper populated late in startup, or processes spawned before it is ready silently skip the wrapper.
