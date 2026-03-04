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
// WRONG — ternary null check
x != null ? x : defaultValue

// RIGHT — null coalescing
x ?? defaultValue

// WRONG — verbose chained ternary
fe != null && fe.action != null ? fe.action : (be != null ? be.action : null)

// RIGHT — null-safe access + coalescing
fe?.action ?? be?.action
```

- `a ?? b` → returns `a` if non-null, else `b`
- ANY `x != null ? x : y` pattern → replace with `x ?? y`
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

## Self-Resolving Enum Abstract with `@:from`

When an enum maps to/from strings (or ints), use `enum abstract` with `@:from` — the enum resolves itself from raw values, no external mapping function needed.

```haxe
// WRONG — enum + separate resolve function outside
enum XmlFieldType { XInt; XFloat; XBool; XString; }
function resolveTypeName(name:String):Null<XmlFieldType> {
    return switch name {
        case 'Int': XInt; case 'Float': XFloat;
        case 'Bool': XBool; case 'String': XString; case _: null;
    };
}

// RIGHT — self-resolving Int-based enum, @:from converts String → Int
enum abstract XmlFieldType(Int) {
    final XInt = 0;
    final XFloat = 1;
    final XBool = 2;
    final XString = 3;

    @:from private static function resolve(name:String):Null<XmlFieldType> {
        return switch name {
            case 'Int': XInt;
            case 'Float': XFloat;
            case 'Bool': XBool;
            case 'String': XString;
            case _: null;
        };
    }
}

// Usage — implicit conversion, no explicit resolve call:
final fieldType:Null<XmlFieldType> = inner.name; // @:from auto-converts
```

- Int-based → all switch/== comparisons are integer operations
- `@:from` does real conversion (String → Int) with validation
- Unknown strings become null — callers just assign a String where `Null<XmlFieldType>` is expected

**`from Type` vs `@:from` method — choose one, not both:**
- `enum abstract Foo(String) from String` — simple wrapping, no logic, no validation. Use when underlying type matches.
- `@:from` method on `enum abstract(Int)` — real conversion with validation (String → Int). Use when types differ or you need to reject invalid values.
- **Never mix:** don't `@:from` with `cast` inside — either wrap simply or convert properly.

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

## Deep Pattern Matching in Switch

Haxe switch supports nested destructuring — match struct fields, array elements, and enum constructors in a single `case`. Use this to flatten nested switches into one.

```haxe
// WRONG — nested switch, verbose
return switch ct {
    case TPath(tp):
        if (tp.name == 'Null' && tp.params != null && tp.params.length == 1)
            switch tp.params[0] {
                case TPType(TPath(inner)): inner.name;
                case null, _: null;
            }
        else
            tp.name;
    case null, _: null;
};

// RIGHT — deep pattern matching, one switch
return switch ct {
    case TPath({name: 'Null', params: [TPType(TPath(inner))]}): inner.name;
    case TPath(tp): tp.name;
    case null, _: null;
};
```

- `{name: 'Null', params: [...]}` — match struct fields by value + destructure array
- More specific patterns first, general fallback after
- Works with any nesting depth: enums inside structs inside arrays

## Switch on Nullable Enums: `case _` Does NOT Catch Null

`case _:` (wildcard/default) does **not** match null. This is intentional — the compiler skips the null check. On hxcpp, switching on a null enum causes a **segfault**.

```haxe
// WRONG — case _ does not catch null, segfault on hxcpp
function resolve(ct:Null<ComplexType>):Null<MyType> {
    return switch ct {
        case TPath(tp): handlePath(tp);
        case _: null;  // null falls through here? NO — crash
    };
}

// RIGHT — explicit case null when type is Null<T>
function resolve(ct:Null<ComplexType>):Null<MyType> {
    return switch ct {
        case TPath(tp): handlePath(tp);
        case null, _: null;  // null explicitly handled
    };
}
```

**When `case null, _:` is needed:** value is `Null<EnumType>`, comes from a Map, Optional field, or external API.
**When redundant:** type is guaranteed non-null (pure enum, no casts, no untyped).

## Switch Without Parentheses

In Haxe, `switch` does not require parentheses around the expression (unlike `if`/`while` where they are mandatory).

```haxe
// WRONG — C-style parentheses
switch (value) { ... }

// RIGHT — idiomatic Haxe
switch value { ... }
```

## Range Iteration Over Manual Counter

Use `for (i in start...end)` instead of `while` with manual `i++`. The range syntax is a built-in language feature — cleaner and eliminates the mutable counter variable.

```haxe
// WRONG — manual counter, C-style
var i:Int = frame;
while (i < maxFrame) {
    doWork(i);
    i++;
}

// RIGHT — range iteration
for (i in frame...maxFrame) {
    doWork(i);
}
```

Note: `start...end` is exclusive of `end` (like Python's `range()`).

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

## Dangling-Else in Macro Comprehensions

When a comprehension branch contains `macro if(...)`, using `if/else` causes dangling-else: the `else` binds to the inner `macro if`, not the outer `if`. Use ternary `?:` instead.

```haxe
// WRONG — else binds to inner `macro if`, f is lost in else-branch
final exprs:Array<Expr> = [
    for (f in xmlFields)
        if (f.type == XString)
            macro if ($p{[f.field]} != null) doA($p{[f.field]})
        else
            macro if ($p{[f.field]} != null) doB($p{[f.field]})  // Unknown identifier: f
];

// RIGHT — ternary is unambiguous, both branches see f
final exprs:Array<Expr> = [
    for (f in xmlFields)
        f.type == XString
            ? macro if ($p{[f.field]} != null) doA($p{[f.field]})
            : macro if ($p{[f.field]} != null) doB($p{[f.field]})
];

// ALSO RIGHT — parentheses around `macro if` prevent dangling-else with if/else too
if (cond)
    (macro if ($p{[f.field]} != null) doA($p{[f.field]}))
else
    (macro if ($p{[f.field]} != null) doB($p{[f.field]}))
```

**General rule:** in any context where the branch body starts with `macro if(...)`, prefer `?:` over `if/else` to avoid ambiguity.

**Null safety with `?.` on abstract method returns:**
```haxe
// WRONG — && narrowing fails for method calls on nullable
final scrolling:Bool = (_axis != null && _axis.isScrolling());

// RIGHT — safe navigation + explicit comparison
final scrolling:Bool = (_axis?.isScrolling() == true);
```
