# Strict null-safety — narrowing rules, nullable stdlib accessors, ?. limits

## Null Safety: Narrowing Limitations

### Basic (`@:nullSafety`)
`if (x != null)` narrows for **argument passing** only. Does NOT narrow for:
- **Lambda captures**: `() -> useString(x)` — x still nullable
- **Method calls on nullable**: `handler.bind(...)`, `handler("x")` — error

Fix: pass narrowed value through a helper with non-null param, or use `.bind()` at call site for value types.

### Strict (`@:nullSafety(Strict)`)
Fields DO narrow right after a null check, but the narrowing is fragile: ANY intervening statement that could mutate state (a call, a write to any field) resets it — the compiler assumes another thread/callback could modify the field. In practice a field is only usable as non-null on the line directly after its check. Local variables narrow normally and stay narrowed.

**Pattern: capture field into local immediately after null check:**
```haxe
// WRONG — field not narrowed in Strict, any statement between check and use resets it
if (_animate == null) return;
_transitioning = true;             // ← field write invalidates narrowing
final animate:AnimatePanel = _animate;  // ERROR: nullable

// RIGHT — local assigned immediately after null check, before any field writes
if (_animate == null) return;
final animate:AnimatePanel = _animate;  // ✓ narrowed
_transitioning = true;
```

**Pattern: field used multiple times — capture into local:**
```haxe
// WRONG — field access, Strict won't narrow
if (_logo != null) _logo.y = h - _logo.height;  // ERROR

// RIGHT — local variable narrows normally
final logo:Null<DisplayObject> = _logo;
if (logo != null) logo.y = h - logo.height;  // ✓
```

**Pattern: field assigned then used — use local for the non-null path:**
```haxe
// WRONG — _logo is Null<T> field, stays nullable after assignment
_logo = new Bitmap(data);
_logo.alpha = 0.3;  // ERROR

// RIGHT — assign to local first, then store in field
final logo:DisplayObject = new Bitmap(data);
_logo = logo;
logo.alpha = 0.3;  // ✓
```

**Key rule:** in Strict mode, ANY intervening statement (even writing to a *different* field) can invalidate narrowing of a nullable field. Always capture to local **immediately** after the null check.

**Null safety with `?.` on abstract method returns:**
```haxe
// WRONG — && narrowing fails for method calls on nullable
final scrolling:Bool = (_axis != null && _axis.isScrolling());

// RIGHT — safe navigation + explicit comparison
final scrolling:Bool = (_axis?.isScrolling() == true);
```

## Null-Safe Access `?.` Does NOT Support `++`/`--`

`?.` chains are expressions, not l-values. Increment/decrement operators require an l-value — combining them with `?.` is an `Invalid operation` at compile time.

```haxe
// WRONG — Invalid operation
_readbackBmd?.image.version++;

// RIGHT — capture into local, null-check, then increment
final bmd:Null<BitmapData> = _readbackBmd;
if (bmd != null) bmd.image.version++;
```

Same applies to `--`, `+=`, `-=` on the end of a `?.` chain.

## `String.charCodeAt` Returns `Null<Int>` — Use `StringTools.fastCodeAt` Under Strict Null Safety

Under `@:nullSafety(Strict)`, `String.charCodeAt(i)` is typed `Null<Int>`. Assigning it to `final c:Int` fails even inside a bounds-checked loop.

```haxe
// WRONG — Null<Int> can't go into Int under Strict
for (i in 0...s.length) {
    final c:Int = s.charCodeAt(i);  // Null safety error
}

// RIGHT — fastCodeAt returns plain Int, designed for in-bounds access
for (i in 0...s.length) {
    final c:Int = StringTools.fastCodeAt(s, i);
}
```

Use `charCodeAt` only when the caller genuinely may pass an out-of-bounds index and wants `null` back. For loops over `0...s.length`, always use `fastCodeAt`.

Sister pattern: `Array.pop()` / `Array.shift()` have the same root cause — see below.

## Array.pop() / shift() Return Null<T> — Strict Refuses to Narrow Despite Length Guard

Under `@:nullSafety(Strict)`, `Array.pop()` and `Array.shift()` are typed `Null<T>`. The classic length-guarded stack-walker pattern fails to compile with `Cannot assign nullable value here` — the compiler does not narrow based on the runtime invariant proved by `stack.length > 0`.

```haxe
// WRONG — Null<T> cannot be assigned to T under Strict, even with the length guard
while (stack.length > 0) {
    final node:T = stack.pop();  // Null safety error
}
```

Three valid fixes:

**Option 1 — cast at assignment** (guard already proved correctness):
```haxe
final node:T = (cast stack.pop() : T);
```

**Option 2 — capture as `Null<T>` and break on null**:
```haxe
final node:Null<T> = stack.pop();
if (node == null) break;
```

**Option 3 — drop `@:nullSafety(Strict)` from the walker class** (lowest friction when the file's only nullability concern is this stdlib accessor):
```haxe
@:nullSafety  // Basic, not Strict
class MyWalker { ... }
```

Same root cause as `String.charCodeAt` returning `Null<Int>`: stdlib accessor is typed nullable for the out-of-bounds case; Strict has no mechanism to narrow on a runtime-proven invariant. Option 3 is the right default when Strict doesn't otherwise benefit the class; use option 1 or 2 when Strict genuinely matters for the rest of the file.

Verified on Haxe 4.3.7.
