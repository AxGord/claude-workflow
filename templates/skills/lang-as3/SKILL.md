---
name: lang-as3
description: AS3 / AIR 51 language gotchas — optional chaining bugs, immutability limits
---

# AS3 / AIR 51 — Verified Gotchas

## Optional chaining `?.`

- **Property access**: `obj?.prop` — works, returns `undefined` if null
- **Method calls**: `obj?.method()` — **BROKEN**. Calls `null()` instead of short-circuiting. Use `if (obj != null) obj.method()`
- When reverting a broken `?.` call to an explicit null-check, leave a marker comment at the site (e.g. `// ?. AIR bugfix — don't restore optional chaining`) so later edits don't reintroduce the bug

## Immutability

- `final` only works on **methods and classes**, NOT on fields — `final var` is a compile error
- Use `const` for never-reassigned fields instead: `private const _items:Array = [];` — assign at the declaration, or once in the constructor
- `const` is shallow — the binding is fixed, the object's contents stay mutable

## `as` operator with primitive types

- `context.call(...) as int` works **only** if the native extension returns `FRENewObjectFromInt32` (value arrives as a boxed `int`). If the C++ side returns `FRENewObjectFromDouble`, `as int` silently returns `null`, which coerces to `0`.
- Prefer explicit cast: `int(context.call(...))` — works regardless of whether the native side returns `int`, `uint`, `Number`, or `double`.
- `as` is designed for reference types. With primitives (`int`, `uint`, `Number`, `Boolean`), behavior depends on the exact runtime type of the boxed value — fragile and non-obvious.
