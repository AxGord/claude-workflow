# Abstract types & abstract classes — operators, conversions, catch semantics, design rules

## Enum Abstract Operators — Which Work, and How to Enable the Rest

Per-operator behavior on a plain `enum abstract(Int)`:
- `==` / `!=` / `switch` — work bare.
- `+` / `-` arithmetic — work through `to Int`.
- **Ordered `<` `>` `<=` `>=`** — REFUSED, even between two values of the SAME abstract, even with `to Int`. Haxe blocks it deliberately (an enum abstract models a name set, not an ordinal). Enable with a bodyless `@:op(A < B)` forward.
- **Bitwise `|` `&` `^` (bit-flags)** — a PLAIN abstract refuses them (`Flags should be Int` / `Int should be Flags`), but adding **`from Int to Int`** enables them completely — the idiomatic typed-flags pattern. `to Int` lets a value flow INTO the bitwise op; `from Int` lets the Int result flow BACK into the abstract.

`@:forward` does NOT help with any operator — it forwards fields of the underlying type, not operators.

```haxe
// Bit-flags — WRONG (plain) vs RIGHT (from Int to Int)
enum abstract Flags(Int) from Int to Int { var A = 1; var B = 2; var C = 4; }
final combined:Flags = A | B;          // ✓ = 3
final hasA:Bool = combined & A == A;   // ✓ true
var f:Flags = A; f |= C;               // ✓ = 5
```

```haxe
// WRONG — "Cannot compare MemberRank and MemberRank" (and MemberRank vs Int), despite `to Int`
enum abstract MemberRank(Int) to Int { final A = 0; final B = 6; }
if (rankA < rankB) { ... }   // compile error

// RIGHT — declare the operators you need as bodyless @:op forwards
enum abstract MemberRank(Int) {
    final A = 0;
    final B = 6;
    @:op(A < B) static function lt(a:MemberRank, b:MemberRank):Bool;
    @:op(A - B) static function sub(a:MemberRank, b:MemberRank):Int;
}
if (rankA < rankB) { ... }   // ✓ resolves to lt
```

Bodyless `@:op` functions get their body synthesized from the underlying type; once declared, `to Int` is unnecessary. When the value is a pure ordinal used mainly in comparison and the `@:op` boilerplate isn't worth it, a plain class of `static inline final Int` constants keeps every operator working with no ceremony — the abstract's payoff is a distinct type, its cost is the operator declarations.

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
