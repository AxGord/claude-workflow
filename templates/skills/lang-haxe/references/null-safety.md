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
