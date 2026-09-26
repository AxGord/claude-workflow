# lang-haxe — Gotchas (full text)

Moved verbatim from SKILL.md; the index there names each lesson and when to open it.

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

### Nested same-quote strings inside `${...}` — valid at any depth, but escapes are NOT re-processed

A single-quoted string may appear INSIDE another single-quoted string's `${...}` block — the interpolation scanner lexes nested same-quote strings via brace/quote balancing, at arbitrary nesting depth. All of these compile and evaluate as expected (verified compile-and-run, byte-identical to their `Std.string` equivalents):

```haxe
'${cond ? '${id}' : 'NULL'}'     // nested interpolated string in a ternary branch
'${'inner=${'${x}'}'}'           // triple nesting — still fine
'${x ? '$name' : 'x'}'           // unbraced $name form nests too
```

Two constraints make this safe or break it:
- **Escapes are NOT processed inside a nested same-quote string.** A `\` escape there mis-lexes (`Unterminated string`) — keep nested strings free of backslashes, quotes, and `$` beyond the intended interpolation.
- **The OUTER literal's escapes are decoded BEFORE the interpolation inside it is read.** Source text moved into a `${...}` block is re-read one escape level up: `'${~/\x24/}'` decodes to `'${~/$/}'` — a regex for a literal `$` silently becomes the end-of-input anchor.

Value-wise `'${x}'` is identical to `Std.string(x)` (interpolation compiles to the same conversion; `null` prints `null` either way).

## Compile-traps — index (details: references/compile-traps.md)

A Haxe compile error whose message does not obviously name the cause →
Read references/compile-traps.md BEFORE trying fixes. It covers:
`String has no field replace` (using StringTools) · `Cannot access
property` in a subclass ((default,null)) · `Default argument value
should be constant` (enum ctor with args) · @:privateAccess placement ·
typedef→enum field-access breakage · `Type not found` for return types /
sub-module types (a sub-module type needs an import even from its OWN
package; a root-package type is bare-visible but silently shadowable) ·
`@:access(pkg.M.Sub)` silently failing to reach
a sub-module type's private field (use `@:allow` on the sub-module type
instead) · `Unknown identifier` in single-quoted test
fixtures with `$` (MISLEADING — points at the call argument; use double
quotes, scan EVERY touched test file) · its two siblings whose message
names something else: `'${'` → **`Unterminated string`** (often at a
line far below the literal) and `'\$'` → **`Invalid escape sequence \$`**
(the literal-dollar escape is `$$`) · block comments dying on inner
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

### Inside the accessor itself, the access is NOT routed

`x = v` written in `set_x` does **not** recurse — within its own accessor the property reads/writes the backing storage directly. That is why `return x = v;` is the canonical setter body, and why converting a `(get, set)` + `_x` pair into `(default, set)` is safe rather than an infinite loop. The same unrouted access is what makes the two property kinds behave differently:

```haxe
public var a(default, set):String;   // PHYSICAL — has storage
function set_a(v:String):String return a = v;   // ✓ direct field write, no recursion

public var b(get, set):String;       // NON-physical — no storage
function set_b(v:String):String return b = v;   // ✗ COMPILE ERROR
// "This field cannot be accessed because it is not a real variable"
// "Add @:isVar here to enable it"
```

So a `(get, set)` property needs a separate backing field (or `@:isVar`), while `(default, set)` must assign the property name itself. To write a physical property from *outside* its accessor while skipping the setter, use `@:bypassAccessor x = v` — not a hand-rolled second field.

## Strict null-safety — index (details: references/null-safety.md)

BEFORE writing `@:nullSafety(Strict)` code or fighting ANY narrowing
error → Read references/null-safety.md. One-line rules: a FIELD never
stays narrowed — capture it into a local IMMEDIATELY after the null
check (any intervening statement resets it); a LOCAL narrows reliably
EXCEPT in two shapes — in an `||` chain only a null test that is the FIRST
operand narrows the rest (an `&&` chain narrows from any position), and a
narrowed local never reaches an anonymous-structure literal whose expected
type is non-nullable, in ANY position (re-bind `final v:T = x;` first); `charCodeAt` → `fastCodeAt`
in bounds-checked loops; `pop()`/`shift()` are `Null<T>` even behind a
length guard (cast / capture-and-break / drop Strict); `?.` chains are
expressions, not l-values — no `++`/`--`/`+=`; `x?.m() == true` for
boolean methods; a param's BODY type ≠ its written annotation for `?p:T`
and `p:T = null` (both `Null<T>`, the `null` default is nullable even
without `?`) and `...p:T` (`haxe.Rest<T>`); an error inside an `inline`
function body is reported at EVERY call site, naming the callee but
pointing at the caller — read the callee's body, not the callers;
a non-null-safe library's declared types are trusted literally and can
lie in both directions — bridge locally with `cast` in a NON-inline
wrapper (Loose accepts it, Strict callers re-check inline bodies → drop
inline), or a SPEC-equivalent sentinel; changing the fork's type =
cross-repo scope escalation, ask first; never `@:nullSafety(Off)`.

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

## `substr` Counts a NEGATIVE Start From the END — `substring` Clamps It to 0

The two differ exactly where a computed index can go negative, and `substr` fails SILENTLY: it
returns a window from the far end of the string instead of erroring or clamping.

```haxe
final s = "0123456789";
s.substr(-3, 2)     // "78"    — 3 back from the end
s.substr(-30, 5)    // "01234" — |pos| past the length falls back to 0
s.substring(-3, 5)  // "01234" — negatives clamp to 0
```

**Where this bites:** a debug dump of "context around offset N" written as
`source.substr(n - 60, 130)`. For any `n < 60` it prints the END of the file, and the output looks
like ordinary source — so you reason about the wrong location and never suspect the print. Use
`substr(n < 60 ? 0 : n - 60, …)`, or `substring` when a clamp is what you want.

Verified on Haxe 4.3.7 / `--interp`.

## Null Coalescing Operator `??`

`a ?? b` returns `a` if non-null, else `b`. ANY `x != null ? x : y` → `x ?? y`
(linter-owned in hxq projects: `prefer-null-coalescing`); chain with `?.` for
nested fallbacks — `fe?.action ?? be?.action` replaces the verbose
`fe != null && fe.action != null ? fe.action : (be != null ? be.action : null)`.

## Targets/runtime — index (full details: references/targets-runtime.md)

BEFORE writing target-conditional code (`#if sys`/`nodejs`), stdin handling, regexes on `--interp`, exception-heavy hot paths on JS, or any tool driving the Haxe compilation server (`--wait`/`--connect`) → Read references/targets-runtime.md.

- An UNWRITTEN field is not a zero: on js it reads `undefined` and EVERY comparison against it is false (`q<=1` AND `q>0` both false; on `--interp` it is null and `q + 1` throws), so a guard on it takes the untested branch and any arithmetic there yields silent `NaN` — a constructor that takes a default-valued parameter and never assigns it is the classic shape.
- `Sys.stdin().readAll()` throws `haxe.io.Error.Blocked` on hxnodejs when stdin is a pipe (`echo … | cmd`, heredoc) — read via Node `fs.readFileSync(0)` under `#if nodejs`, keep `Sys.stdin()` for other sys targets.
- `EReg.escape` on `--interp` fails to escape `)` / `]` → `new EReg` dies with "unmatched closing parenthesis" before any match — on interp use `indexOf`/manual scanning or literal patterns, never escape-built regexes.
- `#if sys` is FALSE on hxnodejs builds (`sys.io.File` still compiles — the guarded branch is silently dead at runtime) — gate with `#if (sys || nodejs)`.
- Each thrown `haxe.Exception` on JS eagerly captures a V8 stack trace at construction — catastrophic in throw-heavy control flow (parser backtracking); throw ONE pre-allocated immutable stackless sentinel instead of `new` per throw.
- …and the stackless sentinel is only step one: the V8 throw ITSELF still costs ~310 ns + ~38 ns per frame between throw and handler (a sentinel RETURN is 0.43 ns — 3000×), the cost tracks handler DISTANCE not stack depth, making the object non-`Error` changes nothing, and a sampling profiler bills the unwind to the THROWING frame (a 3-line `expectLit` showed 37.6 % self time). Measured: exception-based PEG backtracking = 65 % of parse CPU, 13.5 throws per source line.
- Regex on V8 is NOT the parser bottleneck the hxcpp numbers suggest: `substring(pos, end)` is a free `SlicedString` (161 GB of logical tail-slicing cost 0.4 % GC), the whole EReg+RegExp category was 1.5 % of parse CPU, and converting all 87 generated terminals to sticky `/y` made it 6–8 % SLOWER.
- `haxe.Timer.stamp()` on js is `Date.now()/1000` — millisecond resolution; per-file/per-item benchmarks need `js.Syntax.code('performance.now()')`, plus one or two warm-up passes over the whole input (a cold first file read 20× slow).
- `Reflect.copy` on js is a `for…in` + `try/catch` dynamic read per field (50 % of a code writer's CPU cloning a 210-field options record) — and `Object.assign({}, o)` is 1.8× WORSE than it; only `{ ...o }` (or a macro-generated field-by-field literal) hits V8's `CloneObjectIC`.
- `haxe <path/to/build.hxml>` does NOT chdir into the hxml's directory — every relative path WRITTEN INSIDE it (`-cp`, output path) resolves against the process cwd regardless of how the hxml argument itself is spelled (relative or absolute); compile from the hxml's own directory, and beware the process cwd is also implicitly on the classpath (can mask the bug in a badly-placed test fixture) — see references/targets-runtime.md.
- An output flag CANNOT be overridden by a later one — `haxe build.hxml -js other.js` on an hxml that already holds `-js a.js` dies with `Error: Multiple targets`, so an hxml naming its output is NOT retargetable per invocation. To build the same sources to N private outputs (per-worker binaries so parallel agents stop clobbering one artifact), split the flags into a `*-common.hxml` that names NO output and let each caller add its own `-js <path>`.
- A bare hxml-INCLUDE line inside an hxml (`test-common.hxml` on its own line) resolves against the process cwd, NOT the including hxml's directory — a `bin/leaf.hxml` including a sibling must write the full `bin/common.hxml`, and the build only works from the repo root. (Same cwd rule as the relative paths written inside it, above.)
- `--interp` DOES honor `-D analyzer-optimize` (Eval runs the normal filters pipeline) — prove optimizer effects on ANY target with `-D dump=pretty -D dump-path=<dir>`, which dumps the typed AST AFTER filters; `--times` on `--interp` collapses to one `interp` row and can't answer it.
- `haxe --connect <port>` exit status is NOT interchangeable with a cold compile's — a no-change recompile can flip a clean server from exit 0 to a bogus `Null safety: Cannot return nullable value of String as String` (seen on `try FileSystem.fullPath(p) catch (e) fallback` used as an expression) and back on the next no-change compile; always re-verify a server-reported REJECTION with a cold compile.
- Compilation-server module staleness is decided at ONE-SECOND mtime granularity — a write landing in the same second as the reading compile is invisible and stays stale indefinitely, not just for a second; wait ≥1.0s between write and connect, or use `server/invalidate`.
- `server/invalidate`'s `file` param must be a symlink-resolved REALPATH (`sys.FileSystem.fullPath`, never `absolutePath`, which does not follow symlinks) — under a symlinked root (e.g. macOS `$TMPDIR`) a merely-absolutised path silently matches no module while the server still returns a well-formed `"result"`.
- `haxe --connect <port>` against a port held by an unrelated listener (e.g. `nc`) exits 0 with no output — only a display-protocol reply carrying a `"result"`/`"error"` member proves a real server answered (`"jsonrpc"` alone is not enough — the request also has that key, so an echoing listener would pass).
- Compilation-server client error text is exact: a closed port gives exit 2 and `Fatal error: exception Failure("Couldn't connect on 127.0.0.1:<port> (Connection refused)")` — spelled "Couldn't connect", not "Could not connect"; `--wait` on an already-bound port gives `Fatal error: exception Failure("Couldn't wait on 127.0.0.1:<port>")`.
- hxnodejs: `js.Node.process.kill(pid, signal)` types `signal` as `String`, so `process.kill(pid, 0)` is a compile error (`Int should be Null<String>`) — shell out to `kill -0 <pid>` and read the exit status instead.
- `haxe --jvm` failing with a bare `IO.Overflow("write_ui16")` is the JVM 64 KB METHOD-BODY limit (not the constant pool — check it with `javap -v -p`), caused by `inline` helpers fusing into one caller; the failing build still writes `-D dump=pretty` (filters run before codegen), so the oversized method and the inlined callees are diffable — and the gate in a codegen/macro file is `Context.defined('jvm')`, never `#if jvm` (macro code compiles for the macro context, so that is always false).
- `@:noInline` does NOT override a field declared `inline` — neither written on the field nor injected via `Compiler.addMetadata`, and `addMetadata` never reaches a macro-GENERATED field at all; bisect inlining by editing the `inline` modifier on a scratch copy of the tree, not with metadata.
- `nekotools boot x.n` OVERWRITING an existing executable leaves it SIGKILLed on macOS arm64 (exit 137, zero output, no error text) — the in-place write invalidates the cached ad-hoc signature and `codesign --force -s -` cannot repair it (booted binaries fail strict validation by construction); `rm` the target first so the boot creates a fresh file.
- The Haxe js bundle is NOT build-deterministic — an unchanged tree emitted two different md5s across three builds (a switch arm block floats), so a single before/after `cmp` cannot prove a change is codegen-neutral; build the unchanged arm repeatedly and show the patched hash falls in that set.

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

## Operator Precedence Diverges from C — Bitwise, `|&^` Tier, and `%`

Three places where Haxe binary-operator precedence contradicts the C-family instinct. Quoting C precedence for Haxe code produces wrong claims and wrong parenthesization advice.

1. **Bitwise `& | ^` bind TIGHTER than comparisons** (C binds them looser than `==`/`!=`):

```haxe
flags & mask != 0     // Haxe: (flags & mask) != 0 — correct WITHOUT parens
                      // C-family: flags & (mask != 0) — in Haxe that reading
                      // would be a TYPE ERROR (Int & Bool), which is why the
                      // bare form compiles at all
trace(2 & 2 != 0);    // true
```

2. **`|`, `&`, `^` share ONE left-associative tier** (C: `&` above `^` above `|`):

```haxe
trace(4 | 1 & 1);     // Haxe: (4 | 1) & 1 = 1;  C: 4 | (1 & 1) = 5
```

3. **`%` binds TIGHTER than `*` and `/`** (C: same tier, left-to-right):

```haxe
trace(2 * 7 % 4);     // Haxe: 2 * (7 % 4) = 6;  C: (2 * 7) % 4 = 2
```

Shifts agree with C (tighter than comparison, looser than `+`/`-`): `1 + 2 << 1` is `6` in both. Rule: when writing or reviewing mixed bitwise/comparison Haxe expressions, never transfer C precedence; when code must read unambiguously to C-trained eyes, keep explicit parens around `& | ^` operands even where Haxe doesn't need them.

## Abstract types — index (details: references/abstracts.md)

BEFORE designing an abstract / enum abstract with operators, conversions
or catch behavior → Read references/abstracts.md. One-line rules: ordered
`<`/`>=` need bodyless `@:op(A < B)` forwards (never work bare, even with
`to Int`); bit-flags need `from Int to Int`; `@:from` static for
validating conversions; `catch (e:Abstract)` tests the UNDERLYING type at
runtime; `this` inside the body IS the underlying type, so `this.m()`
binds against THAT type's members (the abstract's own never shadow it,
and a `using` extension supplies what the underlying lacks); `this = expr`
compiles ONLY in inline members + ctor, and calling an inline this-writer
on a `final` binding errors transitively; `to Underlying`
is implicit; abstract→typedef flow needs explicit `to Typedef`; type
helper params at the structural level, don't propagate the abstract;
STRING INTERPOLATION of such a value can become abstract ARITHMETIC —
when any `@:op(A + B)` overload's LEFT type accepts String implicitly,
`'x=$v'` compiles to `("x=" : ThatType) + v` and traces numeric garbage
with no error (`Std.string(v)` is the escape).

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

## Switching a NULL Enum: the WILDCARD Is What Saves You — Its Absence Is the Crash

The widely-repeated "`case _` does not match null" is backwards for the shape that actually
faults. Measured on hxcpp (with and without `-D analyzer-optimize -dce full`), js and eval:

```haxe
// SAFE on every target — the wildcard makes the compiler emit a null check
// FIRST, and null lands in the wildcard body.
switch (e) { case Red: a(); case _: b(); }        // null -> b()
switch (e) { case Red: a(); default: b(); }       // null -> b()
switch (e) { case Red: a(); case Green: c(); case _ if (false): b(); }  // null -> falls past, no crash

// CRASHES — every constructor listed, NO wildcard: the switch reads the
// constructor tag off the subject before any pattern is tried.
switch (e) { case Red: a(); case Green: c(); }    // e == null:
// hxcpp  -> SIGSEGV (exit 139)
// js     -> TypeError: Cannot read properties of null (reading '_hx_index')
// eval   -> Uncaught exception Null Access
```

A guard on the wildcard does not weaken it — the arm's PRESENCE is what triggers the null
check, not whether it can match.

**Only a real `enum` faults.** A wildcard-less switch over `Null<Int>`, `Null<String>` or an
`enum abstract` subject is safe on every target: those compile to plain comparisons, which
null simply fails to match, and control falls past the switch.

So the fix for an exhaustive enum switch over a nullable subject is an explicit `case null:`
arm (or narrowing the subject before the switch) — NOT sprinkling `case null, _:` onto
switches that already have a wildcard, which is the shape that was already safe.

```haxe
// WRONG — exhaustive, no wildcard, subject may be null
function name(e:Null<Colour>):String
    return switch e { case Red: "red"; case Green: "green"; }

// RIGHT — null gets its own answer
function name(e:Null<Colour>):String
    return switch e { case null: "none"; case Red: "red"; case Green: "green"; }
```

## A Bare Lowercase Identifier in a `case` Pattern CAPTURES — It Never Compares

`case name:` where `name` is an ordinary field, parameter or local declares a NEW binding that
shadows it, so the arm matches EVERY value. It compiles clean — no warning, no hint.

```haxe
var expected = "a";
for (v in ["a", "b", "c"]) switch v {
    case expected: trace(v);   // fires for ALL THREE — `expected` is a fresh binder
}
```

Unqualified, only an enum / enum-abstract value and a `static inline` field resolve as pattern
CONSTANTS; an instance field never does. Write the comparison explicitly — `case v if (v == expected):`,
or a plain `if`. Treat a lowercase binder whose name is already in scope and which the arm never reads
as a BUG (the author meant a comparison), not as a style nit — and note the reverse hazard when
cleaning up: silently rewriting it to `case _:` preserves behaviour while erasing the only evidence.

## `return <expr>` Still Needs Its `;` — a Block-Terminated Statement Hides That

`return switch x { … }` and `if (c) { … }` compile with no trailing `;` because the closing brace
ends the statement. Swap such a construct for a non-block expression and the terminator is gone:
`return 42` before `}` is `Missing ;`. This bites any transformation that unwraps a braced construct
into a value — the replacement owes a `;` exactly when the brace it removed was the statement's last
token. In statement position the same problem disappears by splicing a BLOCK instead of bare
statements: a block self-terminates, is legal as a brace-less `if`/loop body, and preserves the
scope the braces held.

## An Arrow Lambda's BLOCK Body Yields Its Last Expression — a `function` Body Never Does

`->` always takes an EXPRESSION, and a `{ … }` block IS an expression whose value is its last
expression. A `function` body is a statement list with no implicit result. So the two "equivalent"
literals differ in return type:

```haxe
var f = () -> { 5; };     // Int — trace(f()) prints 5
var g = function() { 6; };// Void — trace(g()) is "Void should be Dynamic"
function h() { 7; }       // Void — same as g
```

This makes an arrow → named-local-function rewrite (`h = (e:Event) -> { … }` becoming
`function h(e:Event) { … }`) a silent RETURN-TYPE change whenever the block's last statement
produces a value; it still compiles wherever the result is unused, and breaks at the use site
otherwise. Rewrite only with evidence the value is `Void` (e.g. the binding's written type ends in
`->Void`). Two neighbours of that rewrite:

- An arrow lambda takes NO return-type hint — `(x:Int):Int -> x * 2` is `Missing ;` at the `:`.
  Only `function(x:Int):Int …` can state one. A parser refusing that shape is CORRECT.
- `return <Void expr>;` is legal — `function g(x:Int) return trace(x);` compiles and runs. So an
  expression-bodied arrow converts to `function name(p) return <expr>;` with no Void special case.

Verified on Haxe 4.3.7 / `--interp`.

## Switch Without Parentheses

In Haxe, `switch` does not require parentheses around the expression (unlike `if`/`while` where they are mandatory).

```haxe
// WRONG — C-style parentheses
switch (value) { ... }

// RIGHT — idiomatic Haxe
switch value { ... }
```

## An Anonymous Structure Type Picks Its Separator From Whether Fields Carry `var` / `final`

Two spellings, and they do NOT mix. The bare form separates with COMMAS; the keyword form
separates with SEMICOLONS and needs one after the LAST field too. Getting it wrong is always
the same message — `Missing ;` — pointing at the separator, which reads like a stray comma
rather than "this form does not take commas at all".

```haxe
typedef A = { x: Int, y: Int };            // ✓ bare fields, commas
typedef B = { final x: Int; final y: Int; }; // ✓ keyword fields, semicolons, trailing one required
typedef C = { var x: Int; var y: Int; };   // ✓ same with var

typedef D = { final x: Int, final y: Int }; // ✗ Missing ; — at the COMMA
typedef E = { var x: Int, var y: Int };     // ✗ Missing ; — at the COMMA
typedef F = { final x: Int; final y: Int }; // ✗ Missing ; — at the CLOSING BRACE
```

This bites when adding immutability to an existing bare-comma structure: writing `final` in
front of each field looks like a local edit and turns the whole declaration into a syntax
error whose reported column is the first comma, several fields away from what you changed.

Verified on Haxe 4.3.7 / `--interp`.

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

### …but `Std.downcast` does NOT compile under `@:nullSafety(Strict)` on js / flash / lua / php

Those four targets implement it as an **inline** function whose body is
`return check(value) ? cast value : null;` while the declared return type is the non-null `S`.
Strict re-checks an inline body at every call site, so the call fails — and the message names
neither `Std` nor `null`:

```
Null safety: Cannot cast nullable value to not nullable type.
```

The columns point at the `Std.downcast(...)` call, which reads like *your* cast is wrong, and
the same line compiles clean on cpp / hl / jvm / java / cs / neko / python (extern, no inline
body to re-check) — and on `--interp`, so a probe run the usual way **cannot reproduce it**.
Only `-js` (or the other three) shows it, which is what makes it read as a project-specific
mystery rather than a target difference.

In a Strict class targeting one of the four, fall back to the two-step form:

```haxe
if (Std.isOfType(o, Text)) return textSize(cast o);   // ✓ compiles everywhere
```

Sibling of the general rule that an error inside an `inline` body is reported at every call
site: the callee is stdlib here, so nothing in your own tree explains the error.

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

## Braces Around a Lone `if` in an `else` Can Be Load-Bearing for a Following `else`

`else { if (b) q(); }` and `else if (b) q();` are equivalent ONLY when no `else` can follow the enclosing `if` statement. When that statement is itself the brace-less body of an outer construct that carries a trailing `else`, the braces close the inner `if` — so the trailing `else` binds to the OUTER `if`. Removing them makes the inner `if` dangling, and it captures that `else` instead.

```haxe
// The braces are load-bearing here
if (x)
    if (a) p();
    else { if (b) q(); }
else r();          // binds to `if (x)` — runs when !x
```

```haxe
// After de-bracing — r() silently moved to a different branch
if (x)
    if (a) p();
    else if (b) q();
else r();          // now binds to `if (b)` — runs when x && !a && !b
```

The same hazard reaches through any brace-less body chain (e.g. a loop body inside such a then-branch). Safe positions for the `if`: a direct child of a statement list (nothing can follow it but another statement or `}`), or the else-branch of another `if` that is itself in a safe position (an `else if` chain inherits its head's position).

**Rule:** before calling a syntactic unwrap/de-brace transformation "obviously equivalent", check the token that FOLLOWS the transformed region, not only its interior — a construct's braces may be terminating something for the benefit of what comes after.

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

## `override` Keyword Detection Misses Abstract-Method Implementations

Implementing an `abstract` method needs NO `override` keyword — adding one is a **compile error** (`Field hook is declared 'override' but parent field hook is 'abstract' and does not provide any implementation to override`). A scanner/linter that flags "is this an override?" purely by the `override` modifier MISSES every such implementation; it needs a supertype-declares-member lookup too, not just a keyword check.

```haxe
abstract class B {
    abstract private function hook():Void;
}
class S extends B {
    private function hook():Void trace('s'); // ✓ no `override` — still IS an override
}
```

Related: `inline` on a non-final class method compiles fine alone — the error surfaces later, at the SUBCLASS's `override` site (`Field ... is inlined and cannot be overridden`), not at the `inline` declaration.

## Instance Field Initializers Run in REVERSE Declaration Order

Haxe emits declaration-site field initializers into the constructor prologue **bottom-up**, not top-to-bottom. `var a = initA(); var b = initB(); var c = initC();` executes `initC() → initB() → initA()`, then the constructor body — confirmed by `--interp` trace order and by the generated JS ctor (`this.c = …; this.b = …; this.a = …`).

```haxe
class C {
    var a = initA(); // runs THIRD
    var b = initB(); // runs SECOND
    var c = initC(); // runs FIRST
    public function new() { /* runs LAST */ }
}
```

- Decl-inits run before the constructor BODY, including before an explicit `super()` call inside it — a subclass's decl-inits execute before the superclass constructor runs.
- A field initializer cannot read `this` or another instance field (`Cannot access this or other member field in variable initialization`) — the reordering hazard is confined to statics/globals/side effects, never instance-to-instance reads.
- Not measured on hxcpp or other sys targets — don't assume either direction there.

Verified on Haxe 4.3.7 / interp + js.

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

## A Library Handing You `Array<Dynamic>` Forces `Dynamic` at the BOUNDARY, Not Through Your Own Signatures

Libraries that model schema-driven or JSON-backed records (parse trees, table rows, config
documents) typically expose them as `Array<Dynamic>`, because the record's shape is only known
at runtime. The reflex is then `Reflect.field` / `setField` / `fields` / `hasField` everywhere
and `Dynamic` on every helper parameter — and the reflex is wrong. Only the library's own
typedef is forced; every signature you write can be typed.

`haxe.DynamicAccess<T>` covers the whole `Reflect` set as typed map access:

```haxe
typedef Row = DynamicAccess<Null<Any>>;

row[key]                 // Reflect.field
row[key] = value         // Reflect.setField
row.exists(key)          // Reflect.hasField
row.keys()               // Reflect.fields
```

Three things this buys, and one trap.

**`Any` over `Dynamic` is the point.** `Any` refuses unchecked field access, so a typo like
`row.desciption` stops compiling; `Dynamic` accepts it silently and yields `null` at runtime.

**Under `@:nullSafety(Strict)` the value type must admit null if the record does.**
`DynamicAccess<Any>` REJECTS a straight copy — `dst[k] = src[k]` fails with
`Null safety: Cannot assign nullable value here`, because the read is `Null<Any>`. That is a
real bug class `Reflect.setField` hides: it takes `Dynamic` and never complains about copying a
null over a valid value. When the record legitimately holds nulls (an optional column, an
absent field), `DynamicAccess<Null<Any>>` is the honest type; narrowing then happens at each
use site instead of never.

**TRAP — conversion is per element, never whole-array.** `Array` is invariant AND `Dynamic`
does not unify through a type parameter, so the obvious coercion fails:

```haxe
for (row in (lines : Array<Row>)) { … }   // ✗ Dynamic should be Row … have: Array<Dynamic>

for (line in lines) {                     // ✓
    final row: Row = line;
    …
}
```

A single `Dynamic` DOES unify with a `Row` parameter, so only locals need the annotation —
`checkRow(line, …)` against `function checkRow(row: Row, …)` compiles unchanged. Pushing a
`Row` back into the library's `Array<Dynamic>` also works.

What remains genuinely forced is the one signature that receives the library's array. Typing
that parameter `Array<Dynamic>` is correct; letting `Dynamic` spread past it is not.
