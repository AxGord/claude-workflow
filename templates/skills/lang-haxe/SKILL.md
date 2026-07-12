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

## Targets/runtime — index (full details: references/targets-runtime.md)

BEFORE writing target-conditional code (`#if sys`/`nodejs`), stdin handling, regexes on `--interp`, or exception-heavy hot paths on JS → Read references/targets-runtime.md.

- `Sys.stdin().readAll()` throws `haxe.io.Error.Blocked` on hxnodejs when stdin is a pipe (`echo … | cmd`, heredoc) — read via Node `fs.readFileSync(0)` under `#if nodejs`, keep `Sys.stdin()` for other sys targets.
- `EReg.escape` on `--interp` fails to escape `)` / `]` → `new EReg` dies with "unmatched closing parenthesis" before any match — on interp use `indexOf`/manual scanning or literal patterns, never escape-built regexes.
- `#if sys` is FALSE on hxnodejs builds (`sys.io.File` still compiles — the guarded branch is silently dead at runtime) — gate with `#if (sys || nodejs)`.
- Each thrown `haxe.Exception` on JS eagerly captures a V8 stack trace at construction — catastrophic in throw-heavy control flow (parser backtracking); throw ONE pre-allocated immutable stackless sentinel instead of `new` per throw.

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

## Function Default Parameter Values Must Be Compile-Time Constants — Enum Ctors With Args Excluded

Default values in ordinary function signatures (`param:T = default`) must be compile-time constants. Zero-arity enum constructors (e.g. `Empty`) qualify and DO work. Enum constructors that take arguments do NOT — even when every argument is itself a literal constant. The compiler rejects with `Default argument value should be constant`.

```haxe
enum Foo { A; B(s:String); }

// WRONG — B('hi') is not a compile-time constant despite the literal arg
function test(x:Foo = B('hi')):Foo return x;
//                    ^^^^^^^ Default argument value should be constant

// WRONG — same root cause, Line('\n') / Text("x") rejected
function emit(?items:Array<Doc>, trailBreak:Doc = Line('\n')):Doc { ... }

// RIGHT — make the param nullable, unwrap inside the body with `??`
function emit(?items:Array<Doc>, ?trailBreak:Doc):Doc {
    final trailBreakDoc:Doc = trailBreak ?? Line('\n');
    ...
}

// RIGHT — zero-arity ctor IS allowed as default
enum Mode { Empty; Filled(s:String); }
function f(m:Mode = Empty):Void { ... }  // ✓
```

Verified on Haxe 4.3.7.

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

## Abstract Types in Catch Clauses: Runtime Type Is the Underlying Type

`catch` accepts abstract types. The runtime check is against the abstract's **underlying type**, not its compile-time conversions. `from` declarations do NOT widen the runtime catch behavior.

- `abstract Foo(Dynamic) from Dynamic` — catches **everything** (class instances, anonymous structs, plain strings) because the underlying runtime check is on `Dynamic`.
- `abstract Foo(SomeClass) from SomeClass from Dynamic` — catches **only** runtime instances of `SomeClass`. The compile-time `from Dynamic` does not widen what is caught at runtime — anonymous structs and unrelated values fall through.

```haxe
abstract MyErr(Dynamic) from Dynamic {
    public var name(get, never):String;
    inline function get_name():String return this.name;
}

class Test {
    static function main():Void {
        try { throw { name: 'IOError' }; }
        catch (e: MyErr) { trace('caught: ' + e.name); }  // works — anon struct caught
    }
}
```

Practical pattern: `abstract MyError(Dynamic) from Dynamic` as a typed unified catch surface that catches every thrown shape, with typed accessors via getters.

Verified on Haxe 4.x — `--interp` and `-js` targets.

## `this` Inside an Abstract Body IS the Underlying Type

Inside abstract methods and getters, `this` is already typed as the **underlying type**. No cast is needed.

```haxe
// WRONG — redundant cast; this is already Dynamic
abstract MyAbs(Dynamic) from Dynamic {
    public var name(get, never):String;
    inline function get_name():String return (this:Dynamic).name;  // noise
}

// RIGHT — direct field access; this IS Dynamic
abstract MyAbs(Dynamic) from Dynamic {
    public var name(get, never):String;
    inline function get_name():String return this.name;
}
```

Same for any underlying type: `abstract Foo(SomeClass)` makes `this` typed as `SomeClass` inside the body — field access goes direct.

**Bonus: `to UnderlyingType` is implicit.** `abstract Foo(Bar) to Bar` — the `to Bar` direction is redundant; the compiler provides it automatically. Drop it.

```haxe
// REDUNDANT
abstract MyAbs(Dynamic) from Dynamic to Dynamic { ... }

// EQUIVALENT — less noise
abstract MyAbs(Dynamic) from Dynamic { ... }
```

`from Dynamic` IS load-bearing (allows implicit conversion into the abstract from any value). `to Dynamic` is automatic.

## Abstract over Dynamic Does NOT Auto-Convert to Typedef Without Explicit `to`

`abstract Foo(Dynamic) from Dynamic` accepts any value as input (catch-all), but does NOT automatically convert to a `typedef` of an anonymous struct on output. The compiler treats abstract → typedef as a distinct conversion that must be declared with `to TypedefName`.

```haxe
// typedef in an extern web-API library
typedef WebAPIError = { code: Float; name: String; message: String; };

abstract MyAbs(Dynamic) from Dynamic { ... }

function logError(e: WebAPIError): Void { /* uses e.code, e.name, e.message */ }

final m: MyAbs = ...;
logError(m);  // ❌ Compile error:
              //   pkg.MyAbs should be webapi.WebAPIError
              //   For function argument 'e'
```

The fix is to declare `to WebAPIError` on the abstract:

```haxe
abstract MyAbs(Dynamic) from Dynamic to WebAPIError { ... }  // ✓ now flows
```

This is asymmetric with the `from Dynamic` direction — Dynamic → typedef works at value level (structural matching), but abstract → typedef requires an explicit declaration. Failing to add `to` triggers a "viral retyping" cascade: every helper that took the typedef seemingly needs to accept the abstract, which is the wrong fix. The right fix is the one-line `to`.

## Don't Propagate the Abstract Into Signatures That Only Need the Underlying Structural Shape

When adding an abstract over an existing typedef (e.g. `DeviceError` over `WebAPIError`), the temptation is to retype every existing helper to accept the abstract. Resist.

If a function only uses fields like `.code`, `.name`, `.message` — fields the typedef already has — its signature should stay on the typedef. The abstract auto-converts at call sites (with `to` declared per the section above). Propagating the abstract into structural-only helpers couples them to the unified-type concept needlessly.

```haxe
// WRONG — abstract propagated into a pure formatter that only needs {code, name, message}
private function deviceError(err: DeviceError): Void {
    error('${err.code} ${err.name} ${err.message}');
}

// RIGHT — typedef captures the structural need; DeviceError -> WebAPIError via `to`
private function deviceError(err: WebAPIError): Void {
    error('${err.code} ${err.name} ${err.message}');
}
```

Rule of thumb: type the parameter at the level of structural need, not at the level of the most-typed source. The abstract's job is auto-conversion at the boundary — it should NOT bleed into every internal helper.

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

## Test Fixture Strings With `$identifier` Content Must Use Double Quotes

Single-quoted strings in test files are subject to Haxe interpolation — any `$name` or `${...}` in a parser fixture input or an `Assert.equals` expected literal is treated as an identifier reference, not verbatim text. The compiler error is a **compile-time `Unknown identifier : <name>`** pointing at the call argument, which can mislead: the error looks like a scope or import problem, not a quoting mistake.

```haxe
// WRONG — single quotes: Haxe interpolates $name as an identifier
final decl = parseSingleVarDecl('class Foo { var x:Int = a.$name; }');
Assert.equals('$name', (f : String));
// Error: Unknown identifier : name
//        ... For function argument 'source'
// Error: Unknown identifier : name
//        ... For function argument 'expected'

// RIGHT — double quotes: $ is literal text
final decl = parseSingleVarDecl("class Foo { var x:Int = a.$name; }");
Assert.equals("$name", (f : String));
```

Verbatim compiler error for reference:
```
HxPostfixSliceTest.hx:92: characters 73-77 : Unknown identifier : name
HxPostfixSliceTest.hx:92: characters 73-77 : ... For function argument 'source'
HxPostfixSliceTest.hx:96: characters 21-25 : Unknown identifier : name
HxPostfixSliceTest.hx:96: characters 21-25 : ... For function argument 'expected'
```

The failure bites BOTH the fixture input string and the expected-value literal in `Assert.equals`. It survives self-review because `$name` in a string LOOKS intentional — it is reliably caught only by the compiler.

**Prevention rule:** before building, scan newly-added or edited `.hx` test code for single-quoted string literals whose content contains `$` followed by a letter, underscore, or `{`; each is a bug unless interpolation is actually intended. The scan must cover **every** test file touched in the same change, not only the file currently in focus — a recurrence happened where the rule was applied correctly in one new test file but missed in a sibling file edited in the same change, caught only by file-review.

## Block Comments Reject Embedded `*/` — Even Inside Backticks

Inside any `/* ... */` block comment (doc comments `/** */` included) the lexer treats the first `*/` it sees as the closing delimiter — block comments do not nest, and backtick-wrapping for markdown code-span formatting does not escape it. Everything after the premature close is invalid syntax.

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

The gotcha applies to ALL block comments — plain `/* */` and `/** */` doc comments alike; the lexer closes the comment at the first `*/` regardless of surrounding backticks. Simple backticks (`` `foo` ``, `` `//` ``) inside comments are fine — the problem is specifically the `*/` character sequence appearing by any means inside a block comment.

Verified on Haxe 4.3.7.

## Regex Alternation: `^A|B` Is `(^A)|B`, NOT `^(?:A|B)` — Wrap Both Alts in a Non-Capturing Group

Regex alternation has lower precedence than every other operator including anchors. `^A|B` parses as `(^A)|B` — the `^` anchor binds ONLY to the first alternative. The second alt is unanchored and scans the rest of input for an arbitrary match anywhere — silently consuming mid-buffer bytes that the parser thought it was inspecting at the cursor.

```haxe
// WRONG — second alt scans mid-buffer
var re = new EReg('^[0-9]+\\.[0-9]+|[0-9]+\\.(?![\\w.])', '');
re.match('UI.get() ? 1. : 2.;');
// re.matched(0) == '1.'   (matched at offset 11, NOT at start)
// re.matchedPos().pos == 11  (NOT 0)
// Consumer that does `ctx.pos += re.matched(0).length` advances by 2
// but the matched bytes started 11 positions away — overwriting the
// ident at the parser's actual cursor with the mid-buffer slice.

// RIGHT — both alts inside a non-capturing group, so `^` binds to both
var re = new EReg('^(?:[0-9]+\\.[0-9]+|[0-9]+\\.(?![\\w.]))', '');
re.match('UI.get() ? 1. : 2.;');
// re.match returns false — `U` is not a digit, regex fails to match at start.
```

**Defensive runtime check** for any code that builds regexes from `|`-alternations dynamically (or accepts user-supplied patterns): after `re.match(rest)`, verify `re.matchedPos().pos == 0`. If not, treat as no-match — the regex matched something but NOT at the cursor position.

```haxe
if (!re.match(_rest) || re.matchedPos().pos != 0) {
    // either no match, or mid-buffer match — both are "not here"
    throw new ParseError(...);
}
```

**Symptom**: parser produces an AST where two nodes have identical source spans (`@from-to` ranges) at positions where one ident and one literal should sit. The mid-buffer match overwrites the cursor position, the cursor advances by the wrong amount, and the next parse step sees corrupted input. Reproducible only when the second alt's pattern HAPPENS to match somewhere later in the input — easy to miss in narrow unit tests.

Verified on Haxe 4.3.7, JS / EReg path.

## Inline Local Functions Cannot Be Passed as Arguments

`inline function` on a local variable is a direct-call optimization only. The compiler cannot materialize a closure object for an inline-tagged local, so passing it as an argument to another function fails with `Cannot create closure on inline closure`.

```haxe
// WRONG — Cannot create closure on inline closure
inline function evalAt(x:Int):Int { return x * 2; }
helper(evalAt);  // Error: Cannot create closure on inline closure

// RIGHT — drop `inline`; direct calls at the same site are still inlined by the optimizer
function evalAt(x:Int):Int { return x * 2; }
helper(evalAt);
```

This surfaces when factoring local helpers (e.g. a recursive `buildXTree`-style function that accepts a callback) and the helper was initially tagged `inline` per project style. `inline` is correct for locals called directly; remove it when the local needs to cross a function boundary as a parameter.

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

## Enum Constructor Parameters Cannot Have Metadata — Use a Typedef Instead

Haxe does NOT allow field-level metadata on individual enum constructor parameters. Attempting `Ctor(a:Int, @:lead("{") b:String)` is a parse-time error — `Unexpected @` — before any macro or typing runs.

```haxe
// WRONG — parse error: Unexpected @ at the @ before the param
enum E {
    Ctor(a:Int, @:lead("{") b:String);
}

// RIGHT — wrap params in a typedef; metadata is legal on typedef/anon-struct var fields
typedef CtorBody = {
    var a:Int;
    @:lead("{") var b:String;
};
enum E {
    Ctor(v:CtorBody);
}

// ALSO RIGHT — metadata IS allowed on the constructor itself (not its params)
enum E {
    @:deprecated Ctor(a:Int, b:String);
}
```

The restriction bites `@:build` / PEG-style DSLs that drive codegen from per-field metadata: the fix is the **ctor-wraps-typedef** pattern (one struct typedef per constructor), which also keeps per-field metadata working for macro inspection.

Verified on Haxe 4.3.x.

## `untyped` Is a Reserved Keyword — Cannot Be a Variable Name

`untyped` is a Haxe keyword (the `untyped expr` escape hatch that disables type-checking), so it cannot be used as an identifier — a `var`/`final` named `untyped` fails at compile with `Keyword untyped cannot be used as variable name`. It reads like an ordinary descriptive word (e.g. a `final untyped:Array<Bool>` flag array), which is exactly why it slips in.

```haxe
// WRONG — compile error: Keyword untyped cannot be used as variable name
final untyped:Array<Bool> = [for (c in clauses) isUntypedCatch(c)];

// RIGHT — rename
final untypedFlags:Array<Bool> = [for (c in clauses) isUntypedCatch(c)];
```

Other sneaky-looking reserved words in the same trap (read like normal nouns/verbs but are keywords): `cast`, `dynamic`, `inline`, `extern`, `macro`, `operator`, `overload`, `using`, `abstract`. When a local name collides, rename it (`untypedFlags`, `castNode`, …). Verified on Haxe 4.3.7.

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
