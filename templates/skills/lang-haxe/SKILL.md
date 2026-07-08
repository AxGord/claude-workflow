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

## `Sys.stdin().readAll()` Throws `Error.Blocked` on hxnodejs When Stdin Is a Pipe

`Sys.stdin().readAll()` works on neko / eval, but on hxnodejs (`-lib hxnodejs`, `-js`) it raises `haxe.io.Error.Blocked` the moment stdin is a pipe — `echo … | cmd`, heredoc, `cmd <<< …`, process substitution. The hxnodejs sync stdin binding wraps a non-blocking `process.stdin._handle.read()` call and re-throws `EAGAIN` as `Blocked` instead of waiting for EOF. TTY mode happens to work because input arrives in one synchronous chunk; the moment the producer is anything other than a TTY (`/dev/tty`), the call fails before any bytes are consumed.

```haxe
// WRONG on hxnodejs — `echo 'class C {}' | node bin/cli.js` throws Blocked
final src:String = Sys.stdin().readAll().toString();

// RIGHT — read via Node's native fs.readFileSync(0), which IS blocking
// on a pipe and returns all bytes through EOF.
private static function readStdin():String {
    #if nodejs
    final fs:Dynamic = js.Lib.require('fs');
    final buf:Dynamic = fs.readFileSync(0);
    return (buf : Dynamic).toString('utf8');
    #elseif sys
    return Sys.stdin().readAll().toString();
    #else
    throw 'stdin requires a sys target';
    #end
}
```

The two-branch shape is required: neko / eval do not have `js.Lib.require`, and hxnodejs is the only target on which `Sys.stdin().readAll()` raises Blocked. The Node path uses untyped `Dynamic` because `js.Lib.require('fs')` returns the raw Node module surface — `fs.readFileSync(0)` returns a Node `Buffer` whose `.toString('utf8')` decodes the bytes.

Symptom in test output:
```
haxe_ValueException [Error]: Blocked
    at haxe_Exception.thrown (...:50993:12)
    at _$Sys_FileInput.readAll (...:285:27)
    at <yourReadStdin> (...:46538:33)
  value: { _hx_name: 'Blocked', _hx_index: 0, __enum__: 'haxe.io.Error', ... }
```

`Error.Blocked` from a `Sys.stdin().readAll()` frame ≡ this gotcha. Verified on Node 20.18 + Haxe 4.3.7 + hxnodejs 12.x.

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

Downside of the minimal form: the first invalid field halts the whole build, so the user sees one error per compile cycle instead of a batch. For **batched** errors across multiple fields, the right API is `Context.reportError(msg, pos)` — it records the error and continues (compilation still fails at the end), so every invalid field is reported in one compile cycle. Follow with a post-loop `Context.error` / `Context.fatalError` only if you must abort before further processing.

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

## Single Combined `EVars` Splices Into Outer Scope (Workaround for `$b{}` Isolation)

When a macro helper must declare N vars that the caller's sibling code can read, returning `Array<Expr>` of separate `EVars` and splicing via `$b{}` doesn't help — the block still isolates. The fix: fold all `Var` entries into ONE `EVars(Array<Var>)` node and splice it as a single `$expr`.

```haxe
// WRONG — block wraps vars in new scope, caller siblings can't see them
function initVars():Expr {
    return macro { var _prev0:Int = 0; var _prev1:Int = 0; };
}
// caller: ${initVars()}; — _prev0/_prev1 NOT visible to siblings

// RIGHT — single EVars node, vars declared at caller's EBlock level
function initVars(names:Array<String>):Expr {
    final vars:Array<haxe.macro.Expr.Var> = [
        for (n in names) {name: n, type: macro:Int, expr: macro 0}
    ];
    return vars.length > 0
        ? {expr: EVars(vars), pos: Context.currentPos()}
        : (macro {});
}
// caller:
final initPrev:Expr = initVars(['_prev0', '_prev1']);
return macro { $initPrev; /* _prev0 / _prev1 VISIBLE here */ };
```

**Why it works:** a single `EVars` spliced into a parent `EBlock` IS the same form as writing `var a = 0; var b = 0;` as sibling statements — no extra nesting. `EBlock` always creates a new scope; `EVars` is just a multi-declaration statement.

**Decision rule:** N var declarations that siblings must read → fold to one `EVars(Array<Var>)`; assignments/mutations of already-declared vars → `EBlock` is fine (nested scope reads outer vars normally). Empty list → `macro {}`.

## Macro `$a{}` Is Context-Dependent: Splices Call Arguments, Builds an Array Literal Standalone

In a call-argument position, `$a{arr}` splices array elements as separate arguments, NOT as an array literal: `f($a{[x, y, z]})` becomes `f(x, y, z)` — three separate arguments. In a standalone expression position, `$a{arr}` builds an array literal: `macro $a{parts}` yields `[x, y, z]` (an `EArrayDecl`).

```haxe
// WRONG — splices as separate args: _dc(doc1, doc2, doc3)
final parts:Array<Expr> = [exprA, exprB, exprC];
macro _dc($a{parts})

// RIGHT — build the array literal first (standalone $a{} = array literal), then pass it
final arr:Expr = macro $a{parts};  // [doc1, doc2, doc3]
macro _dc($arr)  // generates: _dc([doc1, doc2, doc3])

// EQUIVALENT — construct EArrayDecl manually
final arr:Expr = {expr: EArrayDecl(parts), pos: Context.currentPos()};
macro _dc($arr)
```

When you need a macro-time `Array<Expr>` as a single runtime array argument, wrap it into an array-literal `Expr` first — inside a call's argument list, `$a{}` always splices.

## Macro `Array<Expr>` Literal — Parenthesise Each `macro …` Element

Inside an `Array<Expr>` literal (for `EBlock` / `ECall` / `EArrayDecl` construction in build macros), bare `macro …` reifications must be wrapped in parentheses. Without them, the Haxe parser treats `macro` as an identifier for the next array slot and fails with:

```
Keyword macro cannot be used as variable name
```

Plain `Expr` variables (already-built values) do NOT need parens — only `macro …` reifications.

```haxe
// WRONG — bare macro reification as array element
final block:Array<Expr> = [
    macro final _wo = _copyOpt(opt),
    macro { var _f:Bool = false; $probeBody; },
    baseRawWriteCall,
];
// Error: Keyword macro cannot be used as variable name

// RIGHT — each macro reification parenthesised
final block:Array<Expr> = [
    (macro final _wo = _copyOpt(opt)),
    (macro { var _f:Bool = false; $probeBody; }),
    baseRawWriteCall,   // plain Expr variable — no parens needed
];
```

Ternary positions like `cond ? macro X : macro Y` bind correctly without parens — the issue is specific to comma-separated array literal elements.

Verified on Haxe 4.3.7.

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

## Macro Dead-Code `$v{flag}` Branches Still Type-Check — `cast` Required for Reflective Calls

A `$v{flag}` compile-time bool short-circuits at **runtime**, but the compiler type-checks the whole expression **before** dead-code elimination. A reflective call like `Type.enumParameters(x)` inside a `$v{forceInlineSep}`-gated `else if` fails the build whenever the macro inlines the call across consumers whose element type is a struct, not `EnumValue`:

```
WriterLowering.hx:8365: characters 30-48 : pkg.grammar.haxe.trivia.HxMemberDeclT should be EnumValue
WriterLowering.hx:8365: characters 30-48 : ... For function argument 'e'
```

```haxe
// WRONG — type-check fails on struct-shaped element types even though
// the branch is never executed when forceInlineSep == false
} else if (_si > 0 && $v{forceInlineSep}
        && Type.enumParameters(_arr[_si - 1].node).length == 0
        && Type.enumParameters(_t.node).length == 0) {

// RIGHT — cast suppresses compile-time type-check; runtime is gated by $v{flag}
} else if (_si > 0 && $v{forceInlineSep}
        && Type.enumParameters(cast _arr[_si - 1].node).length == 0
        && Type.enumParameters(cast _t.node).length == 0) {
```

**Rule of thumb:** in macro-generated code, any reflective call (`Type.enumParameters`, `Type.getClass`, `Reflect.field`, …) inside a `$v{...}`-gated branch needs `cast` on the argument when the surrounding engine inlines the call across consumers with different static types. The flag short-circuit is a runtime gate, not a compile-time one.

Verified on Haxe 4.3.7.

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

## `#if sys` Is FALSE on hxnodejs Builds — Use `#if (sys || nodejs)`

`-lib hxnodejs` does NOT define the `sys` conditional flag. Its `extraParams.hxml` uses `--macro allowPackage('sys')` (so `sys.io.File` / `sys.FileSystem` imports compile) plus `--macro define('nodejs')` (a separate flag). Code gated on `#if sys` runs ONLY on neko / hxcpp / eval / etc. — the JS/Node build silently takes the `#else` branch.

```haxe
// WRONG — silently no-op on hxnodejs build despite sys.io.File being importable
#if sys
private static function stageProbeSource(s:String):Null<String> {
    sys.io.File.saveContent('/tmp/scratch.hx', s);
    return s;
}
#else
private static function stageProbeSource(_:String):Null<String> return null;
#end

// RIGHT — both system targets AND hxnodejs reach the implementation
#if (sys || nodejs)
private static function stageProbeSource(s:String):Null<String> {
    sys.io.File.saveContent('/tmp/scratch.hx', s);
    return s;
}
#else
private static function stageProbeSource(_:String):Null<String> return null;
#end
```

**Symptom**: code that uses `sys.io.File` / `sys.FileSystem` compiles cleanly under `-lib hxnodejs` AND links into `bin/output.js`, but every `#if sys`-guarded code path is dead — the runtime takes `#else` every time. End-to-end smoke tests (run the binary, observe the side effect) catch it; unit tests using `Cli.run([...])` + exit-code-only assertions DON'T (exit stays 0 because the `#else` branch is well-behaved).

**Detection rule**: before writing a new `#if sys` block in a multi-target project, grep the file's existing import block for the conditional pattern. If imports use `#if (sys || nodejs)` (or `#if (sys || js)` etc.), match that pattern in every new block — single-source the target enumeration to the import guard.

Verified on Haxe 4.3.7 + hxnodejs 12.x.

## Throwing `Error`s in Hot Paths Eagerly Captures a V8 Stack Trace — Catastrophic in Exception-Based Control Flow

A value that extends `haxe.Exception` compiles to a native `js.lib.Error` on the JS target. **V8 captures a stack trace eagerly at `Error` construction** (up to `Error.stackTraceLimit` frames) — even when `.stack` is never read. In exception-based control flow that throws constantly — PEG parser backtracking, recursive-descent ordered-choice, deep retry loops — this per-throw stack capture DOMINATES runtime.

**Symptom**: code is ~1ms per line/item, orders of magnitude slower than the actual work. `node --prof` + `node --prof-process` reports a huge **"Unaccounted" fraction (~96%)** — the cost is in V8's native stack-collection machinery, attributed to no JS function. A `caught`/exception frame shows up in the tick list.

**Confirm in one step**: re-run with `node --stack-trace-limit=0`. A dramatic speedup (measured: 14.0s → 3.9s on a 10891-line parse) proves eager stack capture is the cost.

**Fix** — throw a single **pre-allocated stackless sentinel** instead of `new ParseError(...)` per throw. Allocated once → its stack is captured once (negligible) → reused on every throw with zero per-throw capture or allocation. Correct when the thrown payload is a pure control-flow signal (the real error is reconstructed elsewhere, e.g. from a "farthest failure position" tracker):

```haxe
class ParseError extends haxe.Exception {
    // shared backtracking signal: one instance, stack captured once, never mutated
    public static final backtrack:ParseError = new ParseError(...);
}
// hot path:
throw ParseError.backtrack;            // reused — no capture
// NOT: throw new ParseError(span, msg) // captures a stack on every throw
```

Do **not** reach for a global `Error.stackTraceLimit = 0`: it is global mutable state, JS-only, and silently strips stacks from genuine errors. The shared-sentinel approach is local, target-agnostic, and thread-safe.

**Caveat — keep the sentinel immutable.** If it has a mutable field (e.g. a `source` an error-decorator writes), make sure no path mutates it while it is in flight — otherwise you reintroduce global mutable state / a cross-parse data race. When you argue "this comparison always selects the rebuild branch over the sentinel", verify it at the **init/boundary values**: a `maxFailPos > sentinel.span.from` check fails (`-1 > -1`) if the sentinel's span equals the tracker's `-1` init value. (Fix used a `(-2,-2)` sentinel span, strictly below the `-1` floor, so the check is always true.)

Verified on Haxe 4.3.7 + Node (a PEG parser): a 10891-line parse threw 603,361 `new ParseError` (~55/line), each capturing a stack → 14.0s; the stackless sentinel cut it to 3.5s (4×), allocations 603,361 → 1, with byte-identical surfaced errors.

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
