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

## String.replace() Requires `using StringTools`

`String` in Haxe has NO built-in `.replace()` method. Calling `.replace()` without `using StringTools` fails with `String has no field replace`.

```haxe
// WRONG — compile error: String has no field replace
t('Hello {name}').replace('{name}', userName)

// RIGHT — add `using StringTools` at top of file
using StringTools;
// ...
t('Hello {name}').replace('{name}', userName)
```

This is a common trap when using the i18n placeholder pattern: `t('...{key}...').replace('{key}', value)`.

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

## Property `(default, null)` — Subclass Write Restriction

`null` write access restricts writes to the **declaring class only** — subclasses CANNOT assign to the field, even in their constructor.

```haxe
abstract class Base {
    public var value(default, null):Int;
}

final class Child extends Base {
    public function new() {
        value = 42;  // ERROR: Cannot access property
    }
}
```

**Fix**: set via `super()` constructor in the declaring class:
```haxe
abstract class Base {
    public var value(default, null):Int;
    private function new(value:Int) { this.value = value; }
}

final class Child extends Base {
    public function new() { super(42); }  // ✓
}
```

This is distinct from `(default, set)` where the setter IS accessible from subclasses.

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

## Macro `Context.error` Halts the Macro — No Defensive `continue` Needed

`haxe.macro.Context.error(msg, pos)` throws — execution does NOT fall through. The return type is `Dynamic` only because the function never returns normally. Subsequent statements in the same macro invocation are dead code.

```haxe
// Verified on Haxe 4.3.7: only "first error" is reported, "second error" is never reached.
Context.error('first error', pos);
Context.error('second error', pos);  // unreachable
```

**Implication for validation loops in build macros:** after `Context.error`, you do NOT need `continue` / `return` to skip downstream processing. Adding them is harmless but dead. One tempting anti-pattern:

```haxe
// WRONG — the `continue` is dead code; Context.error already threw
for (field in fields) {
    if (invalid(field)) {
        Context.error('bad', field.pos);
        continue; // never reached
    }
    process(field);
}

// RIGHT — trust the throw
for (field in fields) {
    if (invalid(field))
        Context.error('bad', field.pos);
    process(field);
}
```

Downside of the minimal form: the first invalid field halts the whole build, so the user sees one error per compile cycle instead of a batch. If you want **batched** errors across multiple fields, use `Context.warning` (doesn't throw) plus a post-loop `Context.error` / `Context.fatalError`, or collect errors into an array and emit a summary at the end.

## Macro `FunctionArg`: `opt: true` Widens Type To `Null<T>` Even With a Default

When building a `FunctionArg` in a macro, `opt: true` corresponds to the `?` sigil in Haxe source — and `?minPrec:Int = 0` has type `Null<Int>`, not `Int`. The default value makes the parameter callable without the argument, but the `?` widens the type for strict null safety. Combining `opt: true` with `value: macro 0` produces a signature that is both "optional (via default)" AND nullable — the default is ignored for type-narrowing purposes.

Generated-code consumers that do `if (minPrec < outer)` or similar binary ops on the parameter then fail the strict null safety check with `Cannot perform binary operation on nullable value`.

**Fix**: drop `opt: true` and rely on `value` alone. A default value implicitly makes the parameter optional at call sites (matching `function f(minPrec:Int = 0)` in source) while keeping the type as non-nullable `Int`.

```haxe
// WRONG — generated param is Null<Int>, breaks binary ops under strict null
args.push({
    name: 'minPrec',
    type: macro : Int,
    opt: true,           // widens to Null<Int>
    value: macro 0,
});

// RIGHT — generated param is Int, implicitly optional via the default value
args.push({
    name: 'minPrec',
    type: macro : Int,
    value: macro 0,
});
```

## Macro Optional Expr Args: Omitted Means Null-Literal, Not Null

A macro function declared with `?options:Expr` does NOT receive `null` when the caller omits the argument at a macro-meta call site like `@:build(...)`. Haxe synthesizes an `Expr` whose `expr` field is `EConst(CIdent("null"))` — a null-literal expression — and passes that. A naive `if (options != null)` guard fires for the omitted-arg case and any validation gated on it runs spuriously.

```haxe
// WRONG — fires for callers that omit the optional arg
public static function buildWriter(typePath:Expr, ?options:Expr):Array<Field> {
    if (options != null)
        Context.error('writer takes one arg', options.pos); // hits @:build(buildWriter(T))
    ...
}

// RIGHT — normalize the Expr first, then check the result
private static function extractTypePath(e:Null<Expr>):Null<String> {
    if (e == null) return null;
    return switch e.expr {
        case EConst(CIdent('null')): null;
        case _: ExprTools.toString(e);
    };
}

public static function buildWriter(typePath:Expr, ?options:Expr):Array<Field> {
    if (extractTypePath(options) != null)
        Context.error('writer takes one arg', options.pos);
    ...
}
```

Verified on Haxe 4.3.x: a single-arg `@:build(...)` call triggered a fatal validation error meant for two-arg callers because `options.expr` was `EConst(CIdent("null"))`, not a Haxe-level `null`.

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

## Type Checking: `is` Operator and `Std.downcast`

`is` is syntactic sugar for `Std.isOfType` — cleaner syntax for type checks:

```haxe
// WRONG — verbose
Std.isOfType(obj, DisplayObjectContainer)

// RIGHT — idiomatic
obj is DisplayObjectContainer
```

When you need both check AND typed reference, use `Std.downcast` — one operation instead of `is` + `cast`:

```haxe
// WRONG — two operations: runtime check + unsafe cast
if (obj is DisplayObjectContainer) {
    final c:DisplayObjectContainer = cast obj;
    c.removeChildren();
}

// RIGHT — single operation: check + typed reference
final c:Null<DisplayObjectContainer> = Std.downcast(obj, DisplayObjectContainer);
if (c != null) c.removeChildren();
```

On hxcpp, both `is` and `Std.downcast` compile to the same `hx::IsInstanceOf` check — no performance difference. `Std.downcast` just avoids the separate unsafe `cast`.

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

## Private Access: `@:access` Over `@:privateAccess`

Prefer `@:access(package.ClassName)` over `@:privateAccess` blocks. `@:access` is scoped to a specific class's internals — precise and doesn't clutter method bodies. `@:privateAccess` unlocks ALL private fields of ALL types — overly permissive.

**Placement:** put `@:access` on the **method** when only one method needs it. Move to the **class** when multiple methods share the same access.

```haxe
// WRONG — @:privateAccess in method body, unlocks everything, clutters code
private static function invalidateGraphics(obj:DisplayObject):Void {
    @:privateAccess {
        final g:Null<Graphics> = obj.__graphics;
        if (g != null) g.__dirty = true;
    }
}

// RIGHT — @:access on method (only this method needs it)
@:access(openfl.display.DisplayObject)
@:access(openfl.display.Graphics)
private static function invalidateGraphics(obj:DisplayObject):Void {
    final g:Null<Graphics> = obj.__graphics;
    if (g != null) g.__dirty = true;
}

// RIGHT — @:access on class (multiple methods need it)
@:access(openfl.display3D.Context3D)
class MyClass {
    private function methodA():Void { ctx.__present = true; }
    private function methodB():Void { ctx.__contextState = ...; }
}
```

**Placement gotcha:** `@:privateAccess` on a **function declaration** does NOT propagate to the function body — must be on a block or variable declaration inside, not on the function itself. This is another reason to prefer `@:access`.

## `using` + New Methods = Silent Name Hijacking

When a class is imported via `using` globally (e.g., `using ASCompat` in `rootImports.hx` / `import.hx`), adding a new static method to that class makes it available as an extension method on the first parameter's type across the entire project. If the first parameter is `Dynamic`, ANY existing call matching that method name can be silently hijacked — the compiler resolves to the new extension instead of the previously imported function.

```haxe
// rootImports.hx (global)
using ASCompat;

// SomeFile.hx — imports a specific function
import Globals.flash_utils_getQualifiedClassName as getQualifiedClassName;

// After adding ASCompat.getQualifiedClassName(value:Dynamic):String,
// calls to getQualifiedClassName(x) may resolve to ASCompat's version
// instead of the imported Globals function — SILENTLY breaking behavior.

// FIX: @:noUsing on methods not intended as extensions
@:noUsing public static function getQualifiedClassName(value:Dynamic):String { ... }
```

**Rule:** Before adding any static method to a class that has global `using`, check if the method name conflicts with existing imports. Use `@:noUsing` on utility methods not meant as extensions.

## Typedef-to-Enum Conversion Breaks Field Access

Converting a `typedef` to an `enum` (e.g. adding sum-type variants) silently breaks all direct field access sites — `.fieldName` no longer compiles because enums don't have fields.

```haxe
// BEFORE — typedef, field access works
typedef Ctor = { var name:String; }
final n:String = ctor.name;  // ✓

// AFTER — enum with variants, field access breaks
enum Ctor { Simple(name:String); Param(decl:CtorDecl); }
final n:String = ctor.name;  // ✗ compile error

// FIX — destructure via switch
final n:String = switch ctor {
    case Simple(name): name;
    case Param(decl): decl.name;
};
```

**Before converting:** grep all consumers of the typedef's fields. Every `.fieldName` access must become a `switch` destructuring.

## Imports for Return Types vs Pattern Match Positions

When a function returns a type that callers only use in `switch/case` pattern matching, the import may appear "unnecessary" — but it IS required for the explicit return type annotation. Haxe resolves types in pattern positions (e.g. `case SimpleCtor(name):`) from the enum's own definition, but explicit type annotations (`final x:MyType = ...`) require the import in the consuming file.

```haxe
// This compiles WITHOUT importing HxIdentLit — pattern match resolves from enum def
switch ctor { case SimpleCtor(name): name; }

// This REQUIRES `import HxIdentLit` — explicit return type annotation
function expectSimple(ctor:HxEnumCtor):HxIdentLit { ... }  // ✗ without import
```

**Rule:** When adding helper functions with return types from other packages, always verify the import exists — even if the type is already "visible" through pattern matching in the same file.

## Sub-Module Types Require Explicit Import Even Within the Same Package

If `pack/Helpers.hx` contains both `class Helpers` and `typedef Foo` at module top level, another file in the same package CANNOT use `Foo` without an explicit import — same-package auto-visibility covers main-module types only.

```haxe
// WRONG — Foo lives in Helpers.hx but is not the module's main type
// compile error: Type not found : Foo
var x:Foo = ...;

// RIGHT — explicit sub-module import required
import pack.Helpers.Foo;
var x:Foo = ...;
// OR fully qualify: var x:pack.Helpers.Foo = ...;
// OR move Foo into its own Foo.hx file
```

This is the consumer-side counterpart to the macro-pipeline `Module.SubType` access rule.

## Metadata String Arguments Are Subject to String Interpolation

`@:meta('value')` arguments are parsed as normal Haxe expressions. Single-quoted strings in metadata follow interpolation rules — `$` triggers interpolation just like in regular code.

```haxe
// WRONG — '${' triggers interpolation, produces wrong/broken value
@:lead('${') @:trail('}')
Block(expr:HxExpr);

// WRONG — '$$' is escaped dollar, produces "$" not "$$"
@:lit('$$')
Dollar;

// RIGHT — double-quoted strings have no interpolation
@:lead("${") @:trail("}")
Block(expr:HxExpr);

@:lit("$$")
Dollar;
```

**Rule:** Always use double-quoted strings for metadata arguments containing `$`. This applies to all `@:` metadata, not just specific tags.

## Doc-Comments `/** */` Reject Embedded `*/` — Even Inside Backticks

Inside a `/** ... */` doc comment the lexer treats the first `*/` it sees as the closing delimiter — even when wrapped in backticks for markdown code-span formatting. Everything after the premature close is invalid syntax.

```haxe
// WRONG — the inner */ closes the doc comment; ` after it is an "Invalid character"
/**
 * Comment style (`//` line vs `/* */` block) is not stored.
 */                //         ^^^^^ closes comment here
class Foo {}  // Error: Invalid character '`'

// RIGHT — rephrase without the */ sequence inside the doc comment
/**
 * Comment style (line-style vs block-style delimiters) is not stored.
 */
class Foo {}
```

The gotcha applies only to `/** */` doc comments. Plain `/* */` block comments use a different lexer path and tolerate backtick-wrapped `*/` sequences. Simple backticks (`` `foo` ``, `` `//` ``) inside doc comments are fine — the problem is specifically the `*/` character sequence appearing by any means inside a `/** */` comment.

Verified on Haxe 4.3.7.

## Macro `$b{}` Creates Nested Scopes — Variables Don't Leak

`$b{exprs}` wraps the array in an `EBlock`, creating a new scope. Variables declared inside one `$b{}` are NOT visible to code in a sibling `$b{}`, even within the same function body.

```haxe
// WRONG — var declared in first $b{} is invisible in second $b{}
(macro class {
    public static function example():Void {
        $b{declarations}  // var x = null; — scoped to THIS block
        $b{usages}        // x = 42; — ERROR: Unknown identifier x
    }
}).fields.pop();

// RIGHT — build a flat Array<Expr> and embed once
final body:Array<Expr> = [];
for (e in declarations) body.push(e);
for (e in usages) body.push(e);
// ... set fun.expr = macro $b{body};
```

**Also:** `macro $i{stringVar}` may trigger identifier resolution at macro expansion time. For identifiers that only exist at runtime (e.g., load-local vars), construct the Expr manually:

```haxe
// WRONG — macro system tries to resolve _di_storage at macro time
params.push(macro $i{dep.paramName});  // Unknown identifier: _di_storage

// RIGHT — untyped AST node, resolved later during generated code typing
params.push({expr: EConst(CIdent(dep.paramName)), pos: Context.currentPos()});
```

## Macro `$a{}` Splices Arguments, Not Array Literal

In macro function calls, `$a{arr}` splices array elements as separate arguments, NOT as an array literal. So `f($a{[x, y, z]})` becomes `f(x, y, z)` — three separate arguments, not a single array argument.

```haxe
// WRONG — splices as separate args: _dc(doc1, doc2, doc3)
final parts:Array<Expr> = [exprA, exprB, exprC];
macro _dc($a{parts})

// RIGHT — build array expression manually
final arr:Expr = {expr: EArrayDecl(parts), pos: Context.currentPos()};
macro _dc($arr)  // generates: _dc([doc1, doc2, doc3])
```

`$a{}` is designed for splicing arguments into function calls (like spread operator), not for building array literals. When you need to pass a macro-time `Array<Expr>` as a single runtime array argument, construct `EArrayDecl` manually.

## Enum Constructor Calls in `macro {}` Trigger Type Checking

Direct enum constructor calls (e.g. `pkg.core.Doc.Concat(...)`) inside `macro {}` blocks trigger macro-time type checking against the real enum type. If the arguments reference runtime variables whose types can't be resolved at macro time, the compilation fails with type mismatch errors.

```haxe
// WRONG — macro-time type checking fails on runtime variable _docs
macro {
    final _docs:Array<MyEnum> = [];
    MyEnum.Concat(_docs);  // Error: type mismatch at macro expansion
}

// RIGHT — use wrapper function on the generated class
// In codegen, emit a thin wrapper:
//   private static function _dc(items:Array<MyEnum>):MyEnum return MyEnum.Concat(items);
// Then in macro:
macro {
    final _docs:Array<MyEnum> = [];
    _dc(_docs);  // just an identifier call, no macro-time type checking
}
```

Class constructor calls (`new ClassName(...)`) don't have this issue — only enum constructors. The fix is to generate wrapper functions on the target class and call those by name (plain identifiers aren't resolved at macro time).

## Enum Abstract Values in Typed Expressions Are Inlined

When reading field initializers via `f.expr()` in build macros, `enum abstract` values are already inlined to their underlying type. `Encoding.Binary` (where `Binary = 4`) appears as `TConst(TInt(4))`, NOT as `TField(_, FEnum(_, ef))`.

```haxe
// WRONG — FEnum pattern never matches for enum abstract values
private static function extractEnumIndex(texpr:TypedExpr):Int {
    return switch texpr.expr {
        case TField(_, FEnum(_, ef)): ef.index;  // never hits
        case _: -1;
    };
}

// RIGHT — enum abstract values are inlined to TConst
private static function extractInt(texpr:TypedExpr):Int {
    return switch texpr.expr {
        case TConst(TInt(v)): v;
        case TCast(inner, _): extractInt(inner);
        case TParenthesis(inner): extractInt(inner);
        case _: -1;
    };
}
```

`FEnum` only works for real `enum` types. For `enum abstract(Int)`, the compiler resolves values at typing time — the typed AST contains the raw Int, not a reference to the abstract's field.

## `EReg.escape` Is Broken on `--interp` Target

`EReg.escape` on Haxe `--interp` does NOT escape closing parens/brackets (likely more chars). Feeding the result into `new EReg(...)` produces a PCRE error `at N: unmatched closing parenthesis` at regex construction — before any match runs. Works correctly on `neko` and `js`.

```haxe
var e = EReg.escape(')');
// interp: ')'           — wrong
// neko/js: '\\)'        — correct
var r = new EReg('c,\\s*' + e, '');  // interp: throws "at 6: unmatched closing parenthesis"
r.match('c,)');
```

**Fix on code that must run on interp:** don't build regexes from `EReg.escape`-ed user input. Use `String.indexOf`/`lastIndexOf` plus manual whitespace scanning, or hard-code the regex pattern as a literal.

**Symptom in utest suites:** class init runs before the first assertion. If a regex is built at class-init time (test setup, static init), the whole interp pass dies with an opaque `at N: unmatched closing parenthesis` — often followed by uninitialized-buffer bytes on stdout. No test body ever runs.

## Macro `Context.onTypeNotFound` Does Not Fire for Internal References — Use `Context.defineModule` for Cyclic Type Synthesis

`Context.onTypeNotFound` fires only for initial top-level lookups (`Context.getType(path)` calls or user-code references to unresolved types). It does NOT fire for types referenced inside a `TypeDefinition` returned by the callback itself. Cycles therefore break: callback for A returns a TD referencing B; Haxe tries to type B, but the callback is NOT re-invoked for that internal reference, producing a fatal "Type not found".

```haxe
// WRONG — assumes callback fires recursively for types referenced inside
// a callback-returned TypeDefinition. Cycles break silently.
Context.onTypeNotFound(function(name:String):Null<TypeDefinition> {
    return switch name {
        case 'HxStatementT': makeTypeDef('HxStatementT', [{name:'body', kind:FVar(TPath({name:'HxIfStmtT',pack:[],params:[]}))}]);
        case 'HxIfStmtT':    makeTypeDef('HxIfStmtT',    [{name:'then', kind:FVar(TPath({name:'HxStatementT',pack:[],params:[]}))}]);
        case _: null;
    };
});
Context.getType('HxStatementT'); // typing the TD tries to resolve HxIfStmtT — callback NOT fired → fatal

// RIGHT — define all mutually referencing types atomically in one module
final tds:Array<TypeDefinition> = [tdHxStatementT, tdHxIfStmtT]; // A and B with cyclic refs
Context.defineModule('my.pack.Pairs', tds); // single call; cycles resolve like a multi-type .hx file
```

**Rule of thumb:**
- Single type, no cross-refs → `Context.defineType` (simpler).
- Two+ types that may reference each other → `Context.defineModule` (atomic batch).
- `Context.onTypeNotFound` — useful for lazily satisfying user-code imports, not a cycle handler.

Each TD's `pack + name` is its canonical address; the `modulePath` argument is physical location. Consumers reach sub-module types via `ModulePath.SubType`:
```haxe
import my.pack.Pairs.HxModuleT;
```

Verified on Haxe 4.3.7.

## Macro `Context.defineModule` Sub-Module Types Are Not Import-Resolvable From Other Files

Types synthesized via `Context.defineModule("pkg.Sub", [...])` are reachable from other files via fully qualified inline paths, but NOT via `import pkg.Sub.Foo`. Import resolution in other files runs before the build macro has had a chance to register the synthesized module, so `import pkg.Sub.Foo` fails with `Type not found : pkg.Sub` followed by `Type not found : Foo`. Fully qualified inline references work because Haxe re-resolves them during the typing phase, after the macro has already defined the module.

```haxe
// WRONG — sub-module import fails at parse/import phase, macro hasn't defined Pairs yet
import pkg.synth.Pairs.SynthT;  // Type not found : pkg.synth.Pairs
// ...
final ast:SynthT = MacroParser.parse(src);

// RIGHT — fully qualified inline, resolved during typing phase AFTER macro runs
final ast:pkg.synth.Pairs.SynthT = MacroParser.parse(src);
```

Real-world pattern: a build-time helper calls `Context.defineModule('pkg.synth.Pairs', paired)` where `paired` is an array of synthesized wrapper types. Consumer files that used `import pkg.synth.Pairs.SynthT` fail; switching to fully qualified inline references fixes it.

**Rule of thumb:**
- Consumer files that need macro-synthesized types: use fully qualified inline paths, NOT sub-module imports.
- Types inside a hand-written multi-type `.hx` file (Haxe's own sub-module feature): sub-module imports DO work — the module exists as source before import resolution runs. The restriction is specific to macro-synthesized modules.

Verified on Haxe 4.3.7.

## Macro `Null<T>` Appears as Both `TAbstract` and `TType` — Match Both

Haxe represents `Null<T>` two different ways in the macro `Type` enum. `@:optional` anonymous struct fields tend to arrive as `TType(Null, [inner])`; explicit `Null<T>` in enum constructor args tend to arrive as `TAbstract(Null, [inner])`. Code that only matches one form silently falls through to the default "unsupported type" branch.

```haxe
// WRONG — misses TType form; @:optional fields are never unwrapped
switch t {
    case TAbstract(ref, params):
        final a = ref.get();
        if (a.pack.length == 0 && a.name == 'Null' && params.length == 1)
            return unwrap(params[0]);
    case _:
}

// RIGHT — both representations handled
switch t {
    case TAbstract(ref, params):
        final a = ref.get();
        if (a.pack.length == 0 && a.name == 'Null' && params.length == 1)
            return unwrap(params[0]);
    case TType(ref, params):
        final d = ref.get();
        if (d.pack.length == 0 && d.name == 'Null' && params.length == 1)
            return unwrap(params[0]);
    case _:
}
```

Always handle both `TAbstract(Null, [T])` and `TType(Null, [T])` wherever `Null<T>` unwrapping is needed in macro code.

## Macro `TLazy` Thunks Hide Cross-Typedef Forward References

When a `@:build` macro fires and its marker class's fields reference typedefs defined in the same compilation unit, Haxe may deliver those field types wrapped in `TLazy(f:()->Type)`. `TLazy` matches none of the other `Type` constructors — every pattern falls through to the default branch, producing a misleading "unsupported type" fatal error.

```haxe
// WRONG — TLazy falls through to fatalError, error message gives no hint
function shape(t:Type):ShapeNode {
    switch t {
        case TAbstract(...): ...
        case TInst(...): ...
    }
    Context.fatalError('unsupported type', pos); // hits when t is TLazy
}

// RIGHT — evaluate TLazy at entry, recurse with the resolved type
function shape(t:Type):ShapeNode {
    switch t {
        case TLazy(f): return shape(f());
        case _:
    }
    switch t {
        case TAbstract(...): ...
        case TInst(...): ...
    }
    Context.fatalError('unsupported type', pos);
}
```

Add `case TLazy(f): return recurse(f())` at the top of every macro function that switches on `haxe.macro.Type`.

## Macro Null Narrowing After `throw` Does Not Propagate Into Anonymous Struct Literals

The sequential narrowing idiom `if (x == null) throw ...; x.foo()` correctly narrows `x` for method calls, assignments, and argument passing. But when `x` is referenced inside an anonymous struct literal (`{ field: x }`), the compiler infers the literal's field type from the declared type of `x` (`Null<T>`), not from the narrowed type (`T`). The literal's type becomes `{ field: Null<T> }`, which fails to unify against a target struct typed `{ field: T }`.

```haxe
// WRONG — struct literal sees Null<String>, fails to unify with target struct
var _f_name:Null<String> = null;
// ... parse loop fills _f_name ...
if (_f_name == null) throw 'missing name';
return { name: _f_name }; // Error: Cannot unify {name:Null<String>} with TargetStruct

// RIGHT — re-bind to a final with the non-null type; literal uses the narrowed local
var _f_name:Null<String> = null;
// ... parse loop fills _f_name ...
if (_f_name == null) throw 'missing name';
final _r_name:String = _f_name; // narrowing committed
return { name: _r_name }; // ok
```

Emit one `final _r_X:T = _f_X` re-bind per required struct field in macro-generated parse functions that build anonymous struct literals from nullable accumulator variables.

## Helper Signatures Cannot Reference `Context.defineModule`-Synth Sub-Module Types

A test/consumer class trying to "force" a `@:build`-generated synth module via the `private static final _force:Class<MarkerClass> = MarkerClass;` pattern works for FQN references in METHOD BODIES, but NOT for FQN references in HELPER METHOD SIGNATURES of the same class. Method-signature typing precedes static-initializer execution, so the synth module isn't registered when the helper's parameter / return types are resolved.

```haxe
// SETUP (works in baseline): the synth module `pkg.trivia.Pairs` is
// registered by `MarkerClass`'s `@:build` macro; static-init forcing
// makes it visible to method bodies of this consumer class.
class MyTest {
    private static final _forceBuild:Class<MarkerClass> = MarkerClass;

    public function someTest():Void {
        // OK — method body, typed AFTER static-init runs
        final m:pkg.trivia.Pairs.HxModuleT = MarkerClass.parse(src);
    }

    // WRONG — parameter and return types are typed in the field
    // signature phase, BEFORE static-init. Pairs not yet registered.
    private function helper(
        fn:pkg.trivia.Pairs.HxFnDeclT
    ):Array<pkg.trivia.Pairs.HxStatementT> { ... }
    // → "Type not found : pkg.trivia.Pairs"
}
```

The error message points at the FIRST consumer-side reference inside a method body (e.g. `pkg.trivia.Pairs.HxModuleT` at line N), which is misleading — that reference would be fine on its own. The actual cause is the helper signature pulling `Pairs` resolution too early.

**Workaround:** inline the destructuring switch into each method body instead of factoring it into a helper. Top-of-file comment should record the constraint so the next reader doesn't try to factor it out again. Local typedefs / `import pkg.trivia.Pairs.HxFnDeclT` don't help — both face the same ordering issue.

This is a stricter cousin of the existing "macro-synth sub-module imports don't resolve from other files" gotcha — that one's at parse/import phase; this one's at field-signature-typing phase.

Verified on Haxe 4.3.7.

## `for (x:Type in array)` — Type Annotations Are NOT Allowed In For Loops

Haxe's `for` loop iteration variable cannot carry an explicit type annotation. Unlike `var x:T = ...` or function parameters, the loop variable's type is always inferred from the iterable. Adding `:Type` produces `Expected )`.

```haxe
// WRONG — Expected )
for (member:HxMemberDecl in iface.members) { ... }

// RIGHT — type inferred from `iface.members:Array<HxMemberDecl>`
for (member in iface.members) { ... }

// RIGHT — when an explicit type annotation is required by null-safety
// or to widen, capture into a typed local inside the body
for (member in iface.members) {
    final m:HxMemberDecl = member;
    ...
}
```

Same restriction applies to array-comprehension `[for (x in xs) ...]`. The "always specify types explicitly" rule (when applied as a project preference) does not apply to for-loop iteration variables — there is no syntax for it.

