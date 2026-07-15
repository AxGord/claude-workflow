# Compile-time traps — errors whose message does not name the real cause

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
