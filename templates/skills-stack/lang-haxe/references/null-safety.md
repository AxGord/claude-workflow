# Strict null-safety — narrowing rules, nullable stdlib accessors, ?. limits

## Null Safety: Narrowing Limitations

### When a FIELD narrows, and when a local copy is REQUIRED (measured, Haxe 4.3.7, -cpp, 51 shapes)

A copy `final x:Null<T> = _field; if (x != null) …` is NOT the default — write it only for one of
the five reasons below. It costs nothing at run time (a stack reference, no allocation) and saves
nothing either (a field read is one load): choose by correctness and readability, never by speed.
"Field" here = an instance field, a static field, or a chain of fields (`p.o`); NOT a property
with a getter.

Narrowing a field gets (`if (f != null)`, `if (f == null) return;`, `else` branch, `&&` chain, ternary):
- **`@:nullSafety` (Loose):** stays narrowed like a local — through calls, field writes, loops.
- **`@:nullSafety(Strict)`:** survives until the FIRST of these, in EVALUATION order:
  - any function call — own methods, methods OF THE NARROWED OBJECT ITSELF (`o.m(); o.m();` — the
    second fails), `trace`, `Math.abs`, an `inline` function whose body calls anything (an empty
    inline does not count);
  - a write to ANY field — another field, or a member of the narrowed object (`o.x = 1; o.m();` fails).
  NOT reset by: local writes, `new`, array/string literals. Inside one expression order decides:
  `o.n(calc())` and `take(o, calc())` pass (`o` is read first), `take(calc(), o)` fails. In a loop a
  call anywhere in the body resets it for the next iteration (`for (i in r) o.m();` fails).
- **Never narrows, either mode:** a field captured in a lambda (`if (o != null) later(() -> o.m())`),
  a getter property. Locals and parameters DO narrow in lambdas (final or var).
- Strict quirk: `fn.bind(1)` on a narrowed nullable function PARAMETER fails ("Cannot call a nullable value").

**Copy the field into a local ONLY when:**
1. Strict, and the field is used after a call or a field write (see the list above);
2. the field is used inside a lambda / local function;
3. it is a getter property (also: the getter then runs once, not per read);
4. another thread may write the field — two reads are a race even with nothing between them;
5. you WANT the value as of the check while code in between may reassign the field (in Loose the
   compiler accepts the field version, but it then sees the new value or NPEs).

Otherwise use the field directly: `if (onChange != null) onChange(this);`,
`if (_logo != null) _logo.y = h - _logo.height;`, `_logo = new Bitmap(d); _logo.alpha = 0.3;` all compile in Strict.
Replacing a copy with the field is behaviour-preserving only under the Strict condition (no call or
field write between the copy and the last use) AND reason 4 absent — whatever the class's mode.

### Basic (`@:nullSafety`)
A narrowed local or parameter works for argument passing, calls (`if (h != null) h("x")`) and lambda
captures. What fails is a FIELD in a lambda or a getter (see above).

### Optional callback forwarded into async callbacks: bind it into a method, don't default it to a no-op lambda
Shape: `function f(?cb: () -> Void)` that calls `cb` from inside nested success/error callbacks. Under `@:nullSafety(Strict)`, `if (cb != null) cb();` inside a NAMED local function (`function inner() …`) fails with "Null safety: Cannot call a nullable value" because `cb` is captured. Inside an arrow lambda it compiles (measured 4.3.7, both modes), and so does a check outside with the call in the lambda (`if (cb != null) later(() -> cb())`).

- **WRONG**: `final done: () -> Void = cb != null ? cb : () -> {};` — noise, allocates a dummy.
- **RIGHT**: pass it as a parameter via `.bind()` to private methods typed `Null<() -> Void>`; as a plain parameter it narrows normally:
```haxe
api.call(arg, successHandler.bind(cb), errorHandler.bind(cb));

private function successHandler(cb: Null<() -> Void>): Void { /* ... */ if (cb != null) cb(); }
private function errorHandler(cb: Null<() -> Void>, err: Error): Void { /* ... */ if (cb != null) cb(); }
```
The bound arg goes first; the API's own callback args follow.

### Strict (`@:nullSafety(Strict)`) — the reset in practice
Locals narrow normally and stay narrowed — with two exceptions that look like compiler bugs (see
"Two Places a LOCAL Refuses to Narrow" below). A field follows the Strict list in the section above.

```haxe
// WRONG — the field write between check and use resets the field's narrowing
if (_animate == null) return;
_transitioning = true;
_animate.show();                        // ERROR: nullable

// RIGHT — reorder, or copy once (reason 1) when the use must come after the write
if (_animate == null) return;
final animate:AnimatePanel = _animate;  // narrowed
_transitioning = true;
animate.show();
```

**Null safety with `?.` on abstract method returns:**
```haxe
// WRONG — && narrowing fails for method calls on nullable
final scrolling:Bool = (_axis != null && _axis.isScrolling());

// RIGHT — safe navigation + explicit comparison
final scrolling:Bool = (_axis?.isScrolling() == true);
```

## Two Places a LOCAL Refuses to Narrow

Locals otherwise narrow reliably, so these two read as compiler bugs. Both isolated to a
single discriminator on Haxe 4.3.7 / `--interp`.

**1. In an `||` chain, only a null test that is the FIRST operand narrows the rest.** An `&&`
chain has no such restriction — the asymmetry is the tell that this is a defect, not a design:

```haxe
if (xs == null || xs.length == 0) …               // ✓
if (xs == null || o == null || xs.length == 0) …  // ✓ narrowing survives an intervening operand
if (o == null || xs == null || xs.length == 0) …  // ✗ Cannot access "length" of a nullable value
if (flag    || xs == null || xs.length == 0) …    // ✗ a bare Bool ahead of it is enough
if (flag && xs != null && xs.length > 0) …        // ✓ the && chain narrows from ANY position
```

Bites when several independent optional values are validated in one guard, which is the
natural way to write it. Fix: lead the chain with the null test, or split into one
early-return `if` per value.

**2. A narrowed local NEVER reaches an anonymous-structure literal whose expected type is
NON-nullable.** Position is irrelevant — return value, typed local initializer, call
argument and array element all fail identically. What flips it is the expected type:

```haxe
if (t == null) return null;
final p:Null<P> = { flag: t };   // ✓ expected Null<P> — accepted
return ({ flag: t } : Null<P>);  // ✓
```
```haxe
if (t == null) return mk();
return { flag: t };              // ✗ expected P — Cannot unify { flag : Null<Bool> } with P
out.push({ flag: t });           // ✗ same, as a call argument
return [{ flag: t }];            // ✗ same, as an array element
```

Fix: re-bind before the literal — `final flag:Bool = t;` then `{ flag: flag }`. (The
`Null<P>` arm passing is itself suspicious: it looks like the strict field check is simply
skipped there, a hole in the other direction. Do not rely on it.)

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

## A Parameter's Body Type Can Differ From Its Written Annotation

Inside a function, a parameter's effective (body) type is NOT always the type you
wrote after the `:`. Three forms widen it — so copying the written annotation as the
binding's type (`final x:T = p`) is unsound under `@:nullSafety(Strict)`:

| Written parameter        | Body type        | Why |
|--------------------------|------------------|-----|
| `p:T` (required, no default) | `T`          | safe — annotation is the type |
| `p:T = v` (non-null default) | `T`          | safe — default makes it non-null |
| `?p:T = v` (non-null default)| `T`          | safe — non-null default wins over the `?` |
| `?p:T` (optional, no default)| `Null<T>`    | optional without default is nullable |
| `p:T = null` (null default)  | `Null<T>`    | a `null` default is nullable EVEN without `?` |
| `?p:T = null` (null default) | `Null<T>`    | same |
| `...p:T` (rest)              | `haxe.Rest<T>`| rest params are a `haxe.Rest<T>` collection, not `T` |

```haxe
function f(?p:String, q:String = null, ...r:Int):Void {
    final a:String = p;  // ERROR: Cannot assign nullable value here (p is Null<String>)
    final b:String = q;  // ERROR: q has a null default -> Null<String>, not String
    final c:Int    = r;  // ERROR: haxe.Rest<Int> should be Int
}
```

Key trap: `p:T = null` is nullable **without** the `?` sigil — Haxe treats any
parameter whose default is `null` as `Null<T>`. Only a required-no-default param and a
param with a NON-null default keep the written `T`. (The macro-level twin of this — a
`FunctionArg` with `opt:true` widening to `Null<T>` — is in the macros reference.)

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

## Inline Functions Surface Body Null-Safety Errors At Every Call Site

Under `@:nullSafety`, an error inside an `inline` function's body is reported at every call site's file:line, not just the defining file — the compiler expands the body into each caller, and null-safety checking runs on the expanded code. If an inline setter assigns its `Null<T>` parameter into a non-null-safe field, and that setter is called from N places, the SAME error repeats N times — even when every call site passes an obviously-valid non-null argument.

```haxe
// WRONG — inline setter assigns nullable param to a non-null field
inline function setName(?n:String):Void {
    this.label = n;  // ERROR, reported once PER call site of setName
}

// Call sites below all pass valid non-null literals — yet each one errors too
setName("a");
setName("b");
```

**Diagnosis rule:** when several call sites with obviously-valid arguments all report the same "Cannot pass nullable value to not-nullable argument X of function F" — do not chase the callers. Read F's body first: only one of the N reports points at the defining file, and the real defect is a single line inside it.

**Mode interaction:** null-safety MODE is per-class (`@:nullSafety` bare = Loose; `@:nullSafety(Strict)` = Strict), and an `inline` body is re-checked at each expansion under the CALLER's mode. A `cast nullableValue` inside an inline function passes in its Loose defining class but fails when expanded into Strict callers ("Cannot cast nullable value to not nullable type"). Fix: drop `inline` from the function — the defining class becomes the only checked context. (Verified on Haxe 4.3.4.)

**A parameter's null guard does not survive the inline:** `if (p == null) return; use(p.x);` narrows `p` inside the function, but expanded into a caller whose argument is a field, call or `?.` expression the guard no longer narrows anything and Strict refuses the rest. Adding `inline` to such a function is NOT a safe rewrite — typecheck the callers.

## Non-Null-Safe Library Boundary: Declared Types Are Taken At Face Value — And Can Lie

Calling from `@:nullSafety` code into a module compiled WITHOUT null safety (e.g. a third-party library): the compiler trusts that module's declared types literally, and the trust cuts both ways:
- A parameter declared `String` is treated as non-nullable — passing a `Null<String>` is a compile error, even when the library's own implementation explicitly treats `null` as a valid input at runtime.
- A getter declared to return `String` can still genuinely return `null` at runtime (e.g. an uninitialized field defaulting to `null`) — non-null-safe code never enforces its own declared types, so they lie on the way out too.

```haxe
// externalSetLabel(v:String):Void lives in a module built WITHOUT null safety;
// the field it sets is genuinely nullable (defaults to null, setter handles null).
var value:Null<String> = maybeName();
externalSetLabel(value);       // ERROR — Null<String> into non-nullable String
externalSetLabel(cast value);  // ✓ in Loose mode — library handles null at runtime
```

**Fix, in escalation order:**
1. **Prefer a local, single-line bridge at the boundary, inside your own wrapper:** `cast value` on the assignment/argument, with a comment stating the library handles null at runtime. Null safety ACCEPTS a nullable-to-non-null `cast` in Loose mode but REJECTS it in Strict ("Cannot cast nullable value to not nullable type") — and an `inline` wrapper is re-checked under each CALLER's mode, so keep the wrapper NON-inline (see the mode-interaction note in the inline-function section above).
2. **A spec-equivalent non-null sentinel** (e.g. `value ?? ''`) — ONLY if the equivalence holds by the library's SPEC/documented contract, not merely its current implementation. Implementation-only equivalence silently inverts if the library later converges to spec.
3. **Changing the library/fork's declared type to `Null<T>`** is technically sound (source-compatible — non-null-safe internals aren't checked) — but it is a CROSS-REPO scope escalation: never do it for one call-site's type friction without explicit user/team approval. Verified incident: a team-owned-fork type edit was rejected and reverted; the local cast was the accepted fix.
4. **Still never** `@:nullSafety(Off)` — it disables checking for the whole scope, not just this call.

Verified on Haxe 4.3.7.
