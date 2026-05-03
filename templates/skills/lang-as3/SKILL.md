---
name: lang-as3
description: AS3 / AIR 51 language gotchas — optional chaining bugs, immutability limits
---

## AS3 / AIR 51 Language Gotchas

### Optional chaining `?.`

- **Property access**: `obj?.prop` — works, returns `undefined` if null
- **Method calls**: `obj?.method()` — **BROKEN**. Calls `null()` instead of short-circuiting. Use `if (obj != null) obj.method()`
- Codebase marks reverted `?.` with comments `// ?. air bugfix`

### Immutability

- `final` only works on **methods and classes**, NOT on fields — `final var` is a compile error

### `as` operator with primitive types

- `context.call(...) as int` works **only** if the native extension returns `FRENewObjectFromInt32` (value arrives as a boxed `int`). If the C++ side returns `FRENewObjectFromDouble`, `as int` silently returns `null`, which coerces to `0`.
- Prefer explicit cast: `int(context.call(...))` — works regardless of whether the native side returns `int`, `uint`, `Number`, or `double`.
- `as` is designed for reference types. With primitives (`int`, `uint`, `Number`, `Boolean`), behavior depends on the exact runtime type of the boxed value — fragile and non-obvious.
