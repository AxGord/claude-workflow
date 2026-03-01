---
name: lang-haxe
description: Haxe language gotchas
---

# Haxe — Verified Gotchas

## String Interpolation: Single Quotes Only

Inverted from most languages. Double quotes are plain strings.

```haxe
var name = "world";
var greeting = 'Hello, $name!';        // ✓ Simple variable — no braces
var result = 'Sum is ${a + b}';        // ✓ Expression — braces required
var plain = "No $interpolation here";  // ✗ Literal text, no parsing
```

- `$name` for simple variables — NO braces
- `${expr}` only for expressions (field access, math, function calls)
- `'${_name}'` is wrong → `'$_name'`

## Properties: Never Call set_/get_ Directly

Haxe properties with `(default, set)` or `(get, default)` **always** route through the getter/setter — even for self-assignment inside the owning class. Never bypass the property syntax by calling `set_X()` / `get_X()` directly.

```haxe
public var thumbSize(default, set):Float = 0;

// WRONG — bypasses property system, anti-pattern
set_thumbSize(thumbSize);

// RIGHT — property syntax, calls setter
this.thumbSize = thumbSize;

// BETTER — if value unchanged, call only what's needed
redrawThumb(thumbSize);  // when only the side-effect matters
```

- `this.thumbSize = thumbSize` (self-assignment) **does** trigger the setter — Haxe does not optimize it away
- Direct `set_X()` calls are a Java/C# habit — in Haxe, always use property access

## Null Safety: Narrowing Limitations

### Basic (`@:nullSafety`)
`if (x != null)` narrows for **argument passing** only. Does NOT narrow for:
- **Lambda captures**: `() -> useString(x)` — x still nullable
- **Method calls on nullable**: `handler.bind(...)`, `handler("x")` — error

Fix: pass narrowed value through a helper with non-null param, or use `.bind()` at call site for value types.

### Strict (`@:nullSafety(Strict)`)
Fields are NEVER narrowed — compiler assumes another thread/callback could modify them. Local variables narrow normally.

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

## Map Key-Value Iteration

Use `for (key => value in map)` — cleaner than iterating keys and looking up values separately. Value is guaranteed non-null.

```haxe
// WRONG — extra lookup + unnecessary null check
for (f in _frames.keys()) {
    final fData:Null<Map<Int, Data>> = _frames[f];
    if (fData != null) { ... }
}

// WRONG — _ => is redundant, Haxe iterates values by default
for (_ => data in frameData) { ... }

// RIGHT — key-value destructuring, no lookup, no null check
for (f => fData in _frames) { ... }

// RIGHT — values only (key unused), just iterate directly
for (data in frameData) { ... }
```

**Rule: NEVER use `_ =>` in map iteration.** If the key is unused, drop it — `for (val in map)` iterates values directly.

## Null Coalescing Operator `??`

Use `??` to provide a fallback when left side is null. Combines well with `?.` for chained nullable access.

```haxe
// WRONG — verbose ternary chains
fe != null && fe.action != null ? fe.action : (be != null ? be.action : null)

// RIGHT — null-safe access + coalescing
fe?.action ?? be?.action
```

- `a ?? b` → returns `a` if non-null, else `b`
- `fe?.field ?? be?.field` → try `fe.field`, fall back to `be.field`

## Enum Abstract for Simple Enums

For marker enums without associated data, use `enum abstract(Int)` — zero-cost at runtime, compiles to a primitive. Use `final` instead of `var` for values (immutable by intent).

```haxe
// WRONG — runtime enum objects, unnecessary overhead
enum ScrollDirection {
    HORIZONTAL;
    VERTICAL;
    BOTH;
}

// RIGHT — zero-cost, compiles to Int
enum abstract ScrollDirection(Int) {
    final HORIZONTAL = 0;
    final VERTICAL = 1;
    final BOTH = 2;
}
```

- Use regular `enum` only when you need associated data (`case Node(left, right)`) or pattern matching
- `enum abstract` supports `==` comparison, switch, and all typical enum usage

## Optional Parameters: Type-Based Skipping

Parameters with default values (`param:Type = default`) can be **skipped** at call site. Haxe compiler matches arguments to parameters by type, not just position.

```haxe
function new(?children:Array<DisplayObject>, ?w:Int, ?h:Int,
    bgColor:Int = -1, bgAlpha:Float = 1, bgRadius:UInt = 0,
    alignment:String = "start")

// Skip bgColor, bgAlpha, bgRadius — compiler matches String to alignment:
super(items, 30, 30, "end");  // ✓ Clean
super(items, 30, 30, -1, 1, 0, "end");  // ✗ Hardcoding someone else's defaults
```

**Never hardcode intermediate default values** to reach a later parameter — use type-based skipping instead.

**DANGER: Float constant passed to Int parameter silently skips it.** An `inline final X:Float = 180` looks like an integer but is typed Float. When passed to `new Row(children, X, 16, ...)` where `boxWidth:Int`, the Float skips `boxWidth` and lands on the next Float parameter (e.g. `bgAlpha`). Fix: use `Int` type for constants passed to Int parameters, or cast with `Std.int()`.

## Abstract Classes (Haxe 4.2+)

Native `abstract class` keyword — NOT the same as `abstract` types (which are compile-time wrappers over existing types).

```haxe
// Abstract base — cannot be instantiated directly
@:nullSafety abstract class ScrollAxis {
    abstract private function contentMeasure(content:DisplayObject):Float;
    abstract private function getScroll(content:DisplayObject):Float;

    // Concrete methods can call abstract ones (template method pattern)
    public function maxScroll(content:DisplayObject, vp:Float):Float {
        return Math.max(0, contentMeasure(content) - vp);
    }
}

// Subclass — implements abstract methods WITHOUT `override`
@:nullSafety(Strict) final class VerticalScrollAxis extends ScrollAxis {
    private function contentMeasure(content:DisplayObject):Float {
        return content.getBounds(content).bottom * content.scaleY;
    }
    private function getScroll(content:DisplayObject):Float {
        return content.y;
    }
}
```

**Key rules:**
- `abstract` methods have **no body** — just the signature
- Subclasses implement abstract methods **WITHOUT** `override` keyword
- Subclasses override concrete methods **WITH** `override` keyword
- `abstract class` **cannot** combine with `final` or `inline`
- Subclasses **can** be `final class`
- Abstract method calls from constructor work fine (vtable is ready)

## Switch Without Parentheses

In Haxe, `switch` does not require parentheses around the expression (unlike `if`/`while` where they are mandatory).

```haxe
// WRONG — C-style parentheses
switch (value) { ... }

// RIGHT — idiomatic Haxe
switch value { ... }
```

## If-Expression for Conditional Assignment

`if/else` in Haxe is an expression — use it to assign `final` instead of `var` with mutation.

```haxe
// WRONG — var with overwrite, dummy initial value
var target:Float = currentScroll;
if (condA)
    target = valueA;
else if (condB)
    target = valueB;
else
    return;

// RIGHT — final + if-expression
final target:Float = if (condA)
    valueA;
else if (condB)
    valueB;
else
    return;

// RIGHT — with fallback value instead of return
final target:Float = if (condA) valueA;
else if (condB) valueB;
else currentScroll;
```

- `else return` works inside if-expression — exits function, never assigns
- Eliminates `var` + mutation pattern
- Works with `switch` too: `final x:Int = switch v { case A: 1; case B: 2; }`

**Null safety with `?.` on abstract method returns:**
```haxe
// WRONG — && narrowing fails for method calls on nullable
final scrolling:Bool = (_axis != null && _axis.isScrolling());

// RIGHT — safe navigation + explicit comparison
final scrolling:Bool = (_axis?.isScrolling() == true);
```
