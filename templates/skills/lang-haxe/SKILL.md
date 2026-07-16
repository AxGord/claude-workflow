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

### Escaping a literal `$`: use `$$`, NEVER `\$`

To put a literal `$` in a single-quoted string, double it: `$$`. `\$` is **not a valid escape sequence** — `haxe` rejects it with `Invalid escape sequence \$` (the recognized escapes are `\t \n \r \" \' \\ \xXX \uXXXX`; `\$` is not among them).

```haxe
var a = 'price is $$5';          // ✓ → "price is $5"
var b = 'unterminated $${ here'; // ✓ → "unterminated ${ here"  (escape the $, the { is literal)
var c = 'cost \$5';              // ✗ COMPILE ERROR: Invalid escape sequence \$
var d = "cost $5";               // ✓ double quotes never interpolate → literal "cost $5"
```

So for a literal `$` (or a literal `${`) the two correct forms are **`$$` inside `'...'`** or **just use `"..."`** (no interpolation at all). Reach for double quotes when the string is mostly literal `$`/`${`; use `$$` when you also want interpolation elsewhere in the same string.

## Compile-traps — index (details: references/compile-traps.md)

A Haxe compile error whose message does not obviously name the cause →
Read references/compile-traps.md BEFORE trying fixes. It covers:
`String has no field replace` (using StringTools) · `Cannot access
property` in a subclass ((default,null)) · `Default argument value
should be constant` (enum ctor with args) · @:privateAccess placement ·
typedef→enum field-access breakage · `Type not found` for return types /
sub-module types (imports) · `Unknown identifier` in single-quoted test
fixtures with `$` (MISLEADING — points at the call argument; use double
quotes, scan EVERY touched test file) · block comments dying on inner
`*/` · `Cannot create closure on inline closure` · `Expected )` on
`for (x:Type in xs)` · `Unexpected @` on enum-ctor param metadata ·
keyword collisions (`untyped`, `cast`, `dynamic`, …) · regex `^A|B`
parsing as `(^A)|B` — SILENT mid-buffer matches, wrap `^(?:A|B)` and
treat `matchedPos().pos != 0` as no-match.

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

## Strict null-safety — index (details: references/null-safety.md)

BEFORE writing `@:nullSafety(Strict)` code or fighting ANY narrowing
error → Read references/null-safety.md. One-line rules: a FIELD never
stays narrowed — capture it into a local IMMEDIATELY after the null
check (any intervening statement resets it); `charCodeAt` → `fastCodeAt`
in bounds-checked loops; `pop()`/`shift()` are `Null<T>` even behind a
length guard (cast / capture-and-break / drop Strict); `?.` chains are
expressions, not l-values — no `++`/`--`/`+=`; `x?.m() == true` for
boolean methods.

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

**Rule: NEVER use `_ =>` in map iteration.** If the key is unused, drop it — `for (val in map)` iterates values directly. (Both cases are linter-owned in hxq projects: `redundant-map-iter-key` for `_ =>`, `map-keys-lookup` for keys-then-lookup.)

## `catch (e:Exception)` IS a full catch-all — Dynamic is never needed for coverage

Since Haxe 4.1 (unified exceptions), ANY thrown value — raw string, Int, anonymous object — is wrapped into `haxe.ValueException extends Exception`, so `catch (e:Exception)` catches everything `catch (e:Dynamic)` does, on every target INCLUDING eval/macro context, in both statement and expression position:

```haxe
try throw 'raw' catch (e: Exception) {}  // ✓ caught — e.message == 'raw'
try throw 42 catch (e: Exception) {}     // ✓ caught
```

- Do NOT claim `Dynamic` catches more — that is pre-4.1 knowledge.
- The ONLY difference is the BODY's view of the value: `Dynamic` binds the raw thrown value; `Exception` binds the wrapper (raw value via `.unwrap()` / `ValueException.value`). A `catch (e:Dynamic)` body that uses `e`'s raw-value API needs that migration; a body that ignores `e` swaps type with zero behavior change.

## Null Coalescing Operator `??`

`a ?? b` returns `a` if non-null, else `b`. ANY `x != null ? x : y` → `x ?? y`
(linter-owned in hxq projects: `prefer-null-coalescing`); chain with `?.` for
nested fallbacks — `fe?.action ?? be?.action` replaces the verbose
`fe != null && fe.action != null ? fe.action : (be != null ? be.action : null)`.

## Targets/runtime — index (full details: references/targets-runtime.md)

BEFORE writing target-conditional code (`#if sys`/`nodejs`), stdin handling, regexes on `--interp`, or exception-heavy hot paths on JS → Read references/targets-runtime.md.

- `Sys.stdin().readAll()` throws `haxe.io.Error.Blocked` on hxnodejs when stdin is a pipe (`echo … | cmd`, heredoc) — read via Node `fs.readFileSync(0)` under `#if nodejs`, keep `Sys.stdin()` for other sys targets.
- `EReg.escape` on `--interp` fails to escape `)` / `]` → `new EReg` dies with "unmatched closing parenthesis" before any match — on interp use `indexOf`/manual scanning or literal patterns, never escape-built regexes.
- `#if sys` is FALSE on hxnodejs builds (`sys.io.File` still compiles — the guarded branch is silently dead at runtime) — gate with `#if (sys || nodejs)`.
- Each thrown `haxe.Exception` on JS eagerly captures a V8 stack trace at construction — catastrophic in throw-heavy control flow (parser backtracking); throw ONE pre-allocated immutable stackless sentinel instead of `new` per throw.

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

## Abstract types — index (details: references/abstracts.md)

BEFORE designing an abstract / enum abstract with operators, conversions
or catch behavior → Read references/abstracts.md. One-line rules: ordered
`<`/`>=` need bodyless `@:op(A < B)` forwards (never work bare, even with
`to Int`); bit-flags need `from Int to Int`; `@:from` static for
validating conversions; `catch (e:Abstract)` tests the UNDERLYING type at
runtime; `this` inside the body IS the underlying type; `to Underlying`
is implicit; abstract→typedef flow needs explicit `to Typedef`; type
helper params at the structural level, don't propagate the abstract.

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

## Macros — index (full details: references/macros.md)

BEFORE writing or editing ANY macro code (build macros, `Context.*`, reification `macro {}`, `$b{}`, `$a{}`, `$v{}`, `FunctionArg`) → Read references/macros.md.

- `Context.error()` throws — everything after it is dead code, no defensive `continue`/`return` needed; use `Context.reportError` to batch multiple errors in one compile cycle.
- `FunctionArg` with `opt: true` = the `?` sigil → param type widens to `Null<T>` even with a `value` default; drop `opt`, keep `value` — the default alone makes it optional and non-nullable.
- An omitted `?options:Expr` macro argument arrives as a null-LITERAL expr (`EConst(CIdent("null"))`), not Haxe `null` — `options != null` is true for omitted args; normalize by matching `EConst(CIdent('null'))` in `.expr`.
- Branch bodies starting with `macro if (...)` capture a following `else` (dangling-else) — use ternary `?:` or parenthesise the `(macro if ...)`.
- `$b{exprs}` wraps in `EBlock` = new scope: vars from one `$b{}` are invisible to a sibling `$b{}` — build one flat `Array<Expr>` and splice once; also `macro $i{name}` may resolve at macro time — build `EConst(CIdent(name))` manually for runtime-only idents.
- Vars that caller siblings must read: fold into ONE `EVars(Array<Var>)` node spliced as `$expr` — any `EBlock` wrapper isolates them.
- `$a{arr}` in a call-argument position SPLICES elements as separate args (`f(x, y, z)`); standalone it builds an array literal — to pass one array argument, build the array-literal `Expr` first, then splice `$arr`.
- Bare `macro …` elements inside an `Array<Expr>` literal fail with `Keyword macro cannot be used as variable name` — parenthesise each: `(macro …)`.
- Direct enum-constructor calls inside `macro {}` are type-checked at macro time and fail on runtime vars — emit a wrapper function on the generated class and call it by name (`new Class(...)` is unaffected).
- In build-macro `TypedExpr`s (`f.expr()`), `enum abstract` values are inlined to `TConst(TInt(v))` — `TField(_, FEnum(...))` never matches; match `TConst` and recurse through `TCast`/`TParenthesis`.
- `Context.onTypeNotFound` does NOT fire for types referenced inside a callback-returned `TypeDefinition` — mutually referencing synthesized types must be defined atomically via `Context.defineModule` (single type without cross-refs → `Context.defineType`).
- `Context.defineModule`-synthesized sub-module types are NOT reachable via `import pkg.Mod.Type` from other files — use fully qualified inline paths (re-resolved during typing, after the macro runs).
- Macro `Null<T>` arrives as BOTH `TAbstract(Null,[T])` and `TType(Null,[T])` — unwrap code must match both or it silently falls through to the default branch.
- Field types may arrive as `TLazy(f)`, which matches no other `Type` ctor — add `case TLazy(f): return recurse(f())` at the top of every switch on `haxe.macro.Type`.
- Narrowing from `if (x == null) throw ...` does NOT propagate into anonymous struct literals — `{field: x}` still types the field as `Null<T>`; re-bind `final y:T = x` and use `y` in the literal.
- `$v{flag}` dead branches STILL type-check before dead-code elimination — reflective calls (`Type.enumParameters`, `Reflect.field`, …) inside them need `cast` on the argument.
- Helper method SIGNATURES cannot reference `Context.defineModule`-synth sub-module types (signature typing runs before static-init forcing) — inline the destructuring switch into method bodies instead of factoring a helper.

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

## Adding Enum Ctor: Grep Sister Ctor Literal Across Project

Haxe's exhaustive switch detection fires `Unmatched patterns: <NewCtor>` at every switch missing an arm — but ONLY when that switch is reached during compile. Pre-flight grepping by function name (e.g. "find all walker functions") misses switches with non-obvious names. The reliable audit: grep on a sister-ctor literal that is already exhaustively handled.

```haxe
// Adding `IfLineExceeds` to Doc enum.
// WRONG audit: "find all flat-walking helpers"
//   → finds 6 sites, missed 3 hardline-checking helpers in same file
// → build breaks with "Unmatched patterns: IfLineExceeds"

// RIGHT audit: grep on existing sister ctor
//   $ grep -rn 'case IfWidthExceeds' src/
//   → enumerates ALL 11 exhaustive switch sites uniformly
```

**Rule**: when adding a new ctor to an enum used in multiple files, grep `case <SisterCtor>` on an existing exhaustively-handled ctor — this catches every switch regardless of function/variable name. Do this BEFORE committing the ctor; otherwise compile errors fire only when callers reach the unmatched switch and may surface late in the test cycle.

Verified on Haxe 4.3.7.

## Safe Cast `cast(v, T)` Returns `null` for a `null` Value — Only Throws on a Non-Null Mismatch

The runtime-checked cast `cast(value, Type)` does NOT unconditionally throw when the value isn't a `Type`. The generated check (Haxe `Boot.__cast`) is `value == null || isOfType(value, T) ? value : throw`. So:
- `cast(null, SomeClass)` → returns `null` (no exception).
- `cast(nonNullValueOfWrongType, SomeClass)` → throws.

```haxe
var s:Null<String> = null;
var x = cast(s, Sys);   // returns null — does NOT throw
var y = cast("hi", Sys); // throws — "hi" is a non-null String, not a Sys
```

Implication when reasoning/messaging about an impossible cast (`cast(x, T)` where `x`'s type and `T` are unrelated): "always throws" / "guaranteed exception" is wrong for a value that may be `null`. The accurate framing is "the cast can never yield a usable `T`" (it throws for any non-null value, yields `null` for a null one). Distinct from `(v : T)` (compile-time ascription — a wrong type is a COMPILE error, never a runtime cast) and from the unchecked single-arg `cast v` (no runtime test at all). Verified on Haxe 4.3.7 / js.
