# Haxe Target/Runtime Gotchas

Part of the lang-haxe skill: full verified gotcha entries for target-specific runtime edge cases, indexed one-per-line in SKILL.md under "Targets/runtime — index".

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

## An UNWRITTEN Field Is Not a Zero — on js It Is `undefined`, and EVERY Comparison Against It Is False

Haxe has no definite-assignment analysis for fields, so a `var q: Int;` with no initializer and no
constructor write compiles fine. The instinct is that it reads as `0`, and then a guard like
`if (q <= 1)` looks harmless. On js it reads `undefined`, and `undefined` compares false in BOTH
directions — so the guard takes neither branch's expectation:

```haxe
class C { public var q: Int; public function new() {} }
// js:      q<=1 is false   q>0 is false      (q prints as `undefined`)
// --interp: q<=1 is false   q>0 is false      (q is null; `q + 1` throws "Invalid operation: null + 1")
```

That makes a quality/level/mode guard fall through to the branch nobody tested, and if that branch
does arithmetic on another unwritten `Float` the result is `NaN` — which then propagates silently
through every derived value instead of failing anywhere near the cause. Not measured on hl/cpp/jvm;
do not assume those read `0` either, and do not rely on it if they do.

**Tell:** a numeric field with no initializer, a comparison used as a two-branch switch on it, and a
downstream `NaN` (or a layout/scale that comes out blank) with no exception anywhere. Also: a
constructor that TAKES a default-valued parameter and never assigns it — the parameter default is a
lie, the field default is what runs.

Strict null safety refuses the shape outright, which is most of why it stays out of sight in code
that has null safety off.

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

## A Stackless Sentinel Does NOT Make a V8 Throw Cheap — It Still Costs ~310 ns + ~38 ns per Unwound Frame

The section above removes the *stack capture*. What is left is the throw machinery itself, and on V8 it is still three orders of magnitude more expensive than a sentinel return. Measured on Node 20.18 (Apple silicon), preallocated `Error` subclass, `instanceof` catch — i.e. exactly a `ParseError.backtrack`:

| shape | ns/op |
|---|---:|
| throw, handler is the throwing frame's caller | 313 |
| throw, handler 8 frames up | 634 |
| throw, handler 32 frames up | 1561 |
| throw, handler 64 frames up | 2805 |
| throw, handler 128 frames up | 5232 |
| 4-alternative ordered choice, every alternative throws | 1344 |
| the same choice on a sentinel return | **0.43** |

**The cost tracks the DISTANCE TO THE HANDLER, not the total stack depth.** A control probe with the handler one frame up but the whole stack 256 frames deep costs 2029 ns of which only ~318 ns is the throw — the rest is the recursion itself (the no-throw control at the same depth is 1711 ns). So a deep recursive-descent parser is not penalised for being deep; it is penalised for ordered choices whose handler is far above the terminal that failed.

Two corollaries that cost real time to rediscover:

- **The "Error-ness" of the thrown object is irrelevant.** Replacing the sentinel with an object that has the same prototype chain but is not a live `Error` (`Object.create(ParseError.prototype)`, so every `instanceof` catch still matches) changed nothing measurable (7304 ms vs a 7029 ms median on a 9.7 MB parse). Do not spend a slice on "throw something cheaper"; the only real fix is to **not throw**.
- **A sampling profiler bills the unwind to the THROWING frame.** A three-line `expectLit` whose body is one string compare showed 37.6 % self time; per call that is 2.7 µs, i.e. ~10 000 cycles for four character comparisons. That reads as an impossible profile until you realise the samples are the `Runtime_Throw` + unwind. When a trivial function tops a profile, check whether it throws before you go looking for a pathological loop inside it.

Practical accounting, same parser: 2 731 191 backtrack throws over 202 239 source lines (**13.5 per line**); removing 917 280 of them with one hand-written first-set guard cut the parse 24.6 %, i.e. **1.82 µs per throw+catch in situ**. Exception-based PEG backtracking on V8 is not a constant factor you can ignore — it was 65 % of parse CPU.

## Regex on V8: `substring(pos, end)` Is Free, `/y` Sticky Is Not a Win, and the Engine Is ~1 % of a Parser

The classic "our parser slices the whole remaining input on every terminal" alarm is, on V8, a false alarm. `String.prototype.substring` returns a `SlicedString` (O(1), no copy) and the regexp engine reads it through the flat parent with an offset. Measured: a parser doing 2 230 095 tail-substrings totalling **161 GB of logical length** spent 0.4 % of its time in GC and 1.5 % in the whole EReg + RegExp category.

Micro-costs of the three tiers (same machine, 228 KB source):

| tier | ns/op |
|---|---:|
| `^`-anchored regex on `substring(pos, end)` — what generated PEG code does | 14.25 |
| sticky `/y` regex with `lastIndex = pos` | 10.80 |
| hand-written char-class matcher | 4.64 |
| the `substring(pos, end)` alone | 3.39 |

But rewriting **all 87** generated regex terminals of a real parser from anchored-on-substring to sticky made it **6–8 % SLOWER** on both of two real trees (medians of 5 interleaved rounds). The per-call `lastIndex` write plus the loss of the anchored fast path outweighs the saved allocation. Before planning a "generated matchers instead of EReg" slice for a JS target, measure the regex category first — on hxcpp the same primitive was 4.6× and the slice is justified; on V8 it is noise.

## `haxe.Timer.stamp()` on js Has MILLISECOND Resolution — Per-Item Benchmarks Need `performance.now()`

`haxe.Timer.stamp()` compiles to `Date.now() / 1000` on js. Anything whose unit of work is around a millisecond (parsing one source file, rendering one document) reads as 0 ms or 1 ms with no middle. Node exposes `performance` as a global, so the portable-with-one-escape-hatch form is:

```haxe
private static function now(): Float {
    #if js
    return (cast js.Syntax.code('performance.now()'): Float) / 1000.0;
    #else
    return haxe.Timer.stamp();
    #end
}
```

Independently: a fresh Node process needs its JIT tiered up before any of this means anything. On a ~100-file parse corpus the first pass ran an order of magnitude slower than the same files later, and the first file alone read 20× slow. Warm with one or two full passes over the whole input set before the timed loop, and for A/B work repeat the workload inside the process (report ms-per-rep) rather than trusting one cold pass.

## `Reflect.copy` on js Is a `for…in` Loop — and `Object.assign` Is a WORSE Replacement Than It

`Reflect.copy(o)` compiles to `Reflect.fields(o)` (a `for…in` with a `hasOwnProperty` guard) plus a `try/catch`-wrapped dynamic read per field. On a wide anonymous structure this dominates: a code writer cloning a ~210-field options record 245 912 times (51.6 M field copies) spent **50.7 % of its total CPU** inside `Reflect.copy`/`fields`/`field`.

Replacements, measured on that exact workload (6227 ms baseline):

| replacement | result |
|---|---|
| `Object.assign({}, o)` | **11 208 ms — 1.8× WORSE than `Reflect.copy`** |
| `{ ...o }` (object spread, V8 `CloneObjectIC`) | 4739 ms — **−24 %** |
| no copy at all (ceiling probe, not semantics-preserving) | 2794 ms — −55 % |

So the reflex "swap the Haxe reflection helper for the native one" picks the wrong native one. In Haxe the way to get the spread's monomorphic fast path is a **macro-generated object literal naming every field** (`{ f1: o.f1, f2: o.f2, … }`), which the compiler knows at build time whenever the structure's type is concrete. And before optimising the copy, ask whether the copy is needed at all — most such clones exist to change one or two flags and could be replaced by threading a small override record.

## `haxe <hxml>` Resolves Every Relative Path Inside the hxml Against the Process CWD, Not the hxml's Directory

Passing a path to an hxml file to the `haxe` compiler does NOT chdir into that file's directory
first. Every relative path WRITTEN INSIDE the hxml (`-cp`, `-lib` source roots, the `-js`/output
path) resolves against wherever the `haxe` process was launched — not against the hxml's own
location. Since hxml files are normally authored relative to where they live, invoking one from
any other directory silently resolves its paths against the wrong root. Passing an ABSOLUTE path
to the hxml file itself changes nothing — the argument's own path and the paths written inside the
file are resolved independently.

```
project/build.hxml declares:  -cp src

cwd=project/sub   haxe ../build.hxml           -> `-cp src` becomes project/sub/src : Type not found
cwd=project/sub   haxe /abs/project/build.hxml -> SAME failure (the argument form is irrelevant)
cwd=project        haxe build.hxml             -> ok
cwd=project        haxe /abs/project/build.hxml -> ok
```

**Fix:** any tool or script that invokes `haxe <hxml>` on the user's behalf must set the CHILD
PROCESS cwd to the hxml's own directory — never to the directory of whatever config named it.

**Second, costlier trap: the process cwd is implicitly on the classpath too.** A compile run from
the WRONG directory can still silently resolve a type that happens to live in that directory — so
a test written specifically to prove "cwd matters" can PASS with the underlying bug still present,
if the test fixture's source file sits in the same directory the wrong-cwd run would use (the
implicit cwd classpath quietly stands in for the missing `-cp`).

**Tell:** you are testing cwd/classpath behavior and the fixture's source file lives in the
directory the wrong-cwd run would use.
**Fix:** make the fixture require a type reachable ONLY through the hxml's own `-cp` — put it in a
directory no candidate cwd contains, so the right and the wrong cwd runs are actually
distinguishable.

## `--interp` DOES Honor `-D analyzer-optimize` — and `-D dump` Is How You Prove It

The Eval platform runs the same `filters` pipeline as a codegen target, so `-D analyzer-optimize`
(const propagation, copy propagation, fusion, local DCE) applies to `--interp` exactly as it does
to js/neko. Do not assume the interpreter skips the optimizer.

The probe that settles it for ANY target, without needing an observable behavior difference:
`-D dump=pretty -D dump-path=<dir>` writes the typed AST **after** filters, so the analyzer's
effect is visible directly in the dumped source.

```
class M2 { static function main() { var a = 1; var b = a + 2; var c = b * 10; Sys.println(c); } }

haxe -cp . -main M2 --interp -D dump=pretty -D dump-path=dumpA
  -> static function main() { var a = 1; var b = a + 2; var c = b * 10; Sys.println(c); }

haxe -cp . -main M2 --interp -D analyzer-optimize -D dump=pretty -D dump-path=dumpB
  -> static function main() { Sys.println(30); }
```

Note `--times` is useless for this question on `--interp`: its table collapses to a single
`interp` row with no `filters`/`analyzer` breakdown, so neither arm names the phase.

Verified on Haxe 4.3.7.

## A No-Change Recompile Through the Compilation Server Can Re-Emit a Diagnostic a Cold Compile Never Produces

A `--connect` exit status is NOT interchangeable with a cold compile's. On one server, across
four compiles: compile 1 (fresh) exits 0; compile 2, with NOTHING changed, exits 1 with
`Null safety: Cannot return nullable value of String as String`; compile 3, where a module
genuinely changed, is clean again; compile 4, again with no change, brings the bogus error back.
A cold `haxe <hxml> --no-output` exits 0 throughout the same sequence. Any tool that uses the
server as a correctness gate must re-verify a REJECTION with a cold compile before acting on it —
the server's exit status alone is not proof.

The source shape that trips it: an extern DECLARED to return a non-null `String` reads as
nullable when its module comes back out of the server's cache. Both observed sites were
`sys.FileSystem.fullPath` used as a try-EXPRESSION:

```haxe
return try FileSystem.fullPath(p) catch (e:haxe.Exception) fallback;
```

Fix — bridge explicitly so the code is correct under either reading (and is better code anyway):

```haxe
final v:Null<String> = try FileSystem.fullPath(p) catch (e:haxe.Exception) null;
return v ?? fallback;
```

Verified on Haxe 4.3.7.

## Compilation-Server Module Staleness Is Decided at ONE-SECOND Mtime Granularity

The server decides whether a module is stale by comparing modification times, and the comparison
is only as fine as ONE SECOND. A write landing in the same second as the compile that reads the
file is invisible to that compile — and stays invisible, not just for a second but indefinitely,
until the file is written again in a LATER second. Measured in a tight write-then-connect loop: 9
of 10 iterations with no wait gave a wrong verdict (including a broken build reported clean); 0 of
5 wrong with a ≥1.0s wait inserted between the write and the connect.

**Fix:** wait ≥1.0s between writing a file and connecting to the server to compile it, or use
`server/invalidate` (below) instead of waiting.

## `server/invalidate` Needs a Realpath, Not Just an Absolute Path

`server/invalidate`, sent over the display protocol, clears the staleness problem above with no
wait — but only when the path given is a REALPATH:

```
haxe --connect <port> <hxml> --display '{"jsonrpc":"2.0","id":1,"method":"server/invalidate","params":{"file":"<abs path>"}}'
```

A real server answers `{"jsonrpc":"2.0","id":1,"result":{...}}`. It matches the module by its
symlink-RESOLVED path — `sys.FileSystem.absolutePath` does NOT follow symlinks, so a path that is
merely absolutised silently matches nothing, and the server still returns the same well-formed
success reply, so there is no way to notice from the response alone. Use `sys.FileSystem.fullPath`
instead. This bites hardest under a symlinked root — on macOS `$TMPDIR` is `/var/folders/…` whose
realpath is `/private/var/folders/…` — where a staleness guard written with `absolutePath` is
completely inert while looking correct.

## `haxe --connect <port>` Against a Non-Server Listener Exits 0 With No Output

`haxe --connect <port>` against a port held by an UNRELATED listener exits 0 with NO output —
verified with a plain `nc` listener bound to the port while the actual project did not typecheck.
A stray listener therefore reads as a clean build. The only reliable proof that a real compilation
server answered is a display-protocol reply carrying a `"result"` or `"error"` member — testing
for `"jsonrpc"` alone is not enough, since the REQUEST also contains that key, so an echoing
listener would pass too.

## Compilation-Server Client Error Messages: Exact Spellings

Two exact client messages worth matching on literally, not approximately:

- Closed port: exit 2, `Fatal error: exception Failure("Couldn't connect on 127.0.0.1:<port> (Connection refused)")` — spelled **"Couldn't connect"**, not "Could not connect"; code that greps for the latter silently never matches.
- `haxe --wait <port>` on an already-bound port: exits immediately with `Fatal error: exception Failure("Couldn't wait on 127.0.0.1:<port>")`.

## hxnodejs: `process.kill(pid, signal)` Types `signal` as `String` — `kill(pid, 0)` Is a Compile Error

`js.Node.process.kill(pid, signal)` types `signal` as `String`, so the standard existence probe
`process.kill(pid, 0)` is a COMPILE error (`Int should be Null<String>`). Spawn `kill -0 <pid>`
and read the exit status instead.

## `--jvm` Overflows on Big Generated Methods — `IO.Overflow("write_ui16")` Is the 64 KB Method Limit

`haxe --jvm` can fail with a bare `IO.Overflow("write_ui16")` and no file, class or method
named. It is the JVM's hard **64 KB limit on a single method body** (the u2 offsets in that
method's `Code` attribute — line-number / exception-table / stack-map entries), reached because
`inline` helpers fused into one caller. `-D no-inline` "fixes" it by handicapping the whole
build; `-D analyzer-optimize` does not help.

Diagnosing it without a compiler patch, in this order:

1. **Rule out the constant pool** (the other u2 that can overflow): build once with
   `-D no-inline`, then `javap -v -p <Class>.class` and take the max `#N` — a few thousand
   against the 65 535 limit means the pool is not the mechanism.
2. **Find the oversized method from the FAILING build**, which the JVM writer never emits:
   `-D dump=pretty -D dump-path=<dir>` runs after filters (so post-inline) and BEFORE codegen,
   so the dump exists even though the build died. Rank per-method body size in `<dir>/java/`;
   the biggest one is the container.
3. **Calibrate chars → bytecode** on the `-D no-inline` jar (`javap -v -p`, last offset per
   method) to estimate how far past 65 535 the failing method was.
4. **Diff the two dumps' bodies for that method** — a token-frequency delta names the inlined
   callees directly (`+696 Reflect.copy`, `+162 <helperName>`).

The fix is to drop `inline` on the JVM target only. In a **macro/codegen** file the gate is
`Context.defined('jvm')` at macro RUNTIME (true in a build macro when the target is `--jvm`);
`#if jvm` there is always FALSE, because macro code is compiled for the macro context, not the
target.

## `@:noInline` Does NOT Override a Field Declared `inline` — the Standard Bisection Lever Is Inert

The usual way to bisect an inlining problem — `--macro haxe.macro.Compiler.addMetadata('@:noInline', cls, field, isStatic)`,
or just writing `@:noInline` on the field — does **nothing** to a function whose declaration
already says `inline`:

```haxe
class NI {
	public static inline function helper(a:Int):Int return a * 2 + 1;
	@:noInline public static inline function helper2(a:Int):Int return a * 3 + 1;
	static function main() trace(helper(Std.random(5)) + helper2(Std.random(3)));
}
// js output — BOTH inlined at the call site:
//   console.log(Std.random(5) * 2 + 1 + (Std.random(3) * 3 + 1));
```

`@:noInline` suppresses the *compiler's* discretionary inlining; an explicit `inline` modifier
is a directive it does not veto. `addMetadata` is doubly inert on a **macro-GENERATED** field —
the metadata registry is consumed before the `@:build` macro contributes its fields, so the
dump is byte-identical with and without it (which reads as "not the culprit" and sends the
bisection down a false path).

So bisect by editing the `inline` modifier itself, on a **scratch copy** of the tree
(`cp -R src srccopy`, a `-cp srccopy` hxml) — never in the real source. For codegen-emitted
fields that means flipping `AInline` out of the emitted `access` array at chosen sites.

## The Haxe js Bundle Is NOT Build-Deterministic — "Byte-Identical Output" Needs a Repeat-Build Control

Two compiles of an **unchanged** source tree with the same compiler can emit different bytes:
a switch arm block (`case 5:case 28:case 29: return true;`) floats between two positions, so
the same `bin/apq.js` alternated between two md5s across three consecutive builds. A single
before/after `cmp` therefore "proves" a change altered codegen when it did not.

To prove a change is codegen-neutral on js, build the **unchanged** arm several times and
collect the hash set, then show the patched arm's hashes fall inside it (a patched build being
byte-identical to *one* unpatched build is the clean result). Inspect any residual diff — a
handful of reordered lines is the known non-determinism; anything structural is real.

## Haxe as a Script Runner: `--run`, Not `--interp` — and the 2.5 s Cliff When the Script Touches a Real Library

`haxe --run <Module> [args…]` compiles to eval and runs, forwarding the trailing
arguments to the program. `--interp` does NOT: with `haxe -cp . -main M --interp foo.json`
the compiler claims the trailing argument for itself and dies with
`Error: Could not process argument foo.json / Package name must start with a lowercase letter`.

Measured on Haxe 4.3.7 / Mac15,9, three runs each, wall clock:

| what                                                    | time   |
|---------------------------------------------------------|--------|
| `--run` hello-world (startup floor: typecheck + eval)     | 0.06 s |
| `--run` std-only script, two 2.7 MB JSON files diffed     | 0.41 s |
| `python3` doing the same diff (stdlib `json`)             | 0.04 s |
| `--run` a 4-line script with `-cp src` of a macro-heavy lib | 2.5 s  |
| `bash -c 'echo hi'`                                       | 0.00 s |

Three things follow, and the third is the one that bites:

1. **60 ms is cheap enough for tool scripts.** Haxe is a viable replacement for
   awk/shell logic in a build harness; the interpreter is not the bottleneck.
2. **Eval is ~10× slower than CPython on JSON-heavy work** (0.41 s vs 0.04 s here,
   both dominated by parsing, since the diff itself is two map builds). Irrelevant
   at build-harness scale, decisive if the script runs in a loop.
3. **The startup floor is a floor for STD-ONLY scripts.** Add `-cp` of a real
   library and every invocation re-typechecks it: a script whose whole body is
   `Sys.println(Linter.builtins().length)` costs 2.5 s per run once the library
   is macro-driven grammar code. So "reuse the project's own parser from a
   `--run` script" is not free — if the logic needs the library, it belongs in
   the compiled CLI as a subcommand, not in a script.

`sys.io.Process` works on eval and is genuinely concurrent: two `sh -c 'sleep 0.3'`
processes started back to back and then waited on complete in 0.38 s wall, so
"shell is needed for parallelism" is false.

Remember `EReg.escape` is broken on eval (see above) — a script built around
escaped-input regexes will die at regex construction, literal patterns are fine.

## `nekotools boot` Over an Existing Binary Produces a SIGKILLed Executable on macOS arm64

A booted neko binary is the `neko` VM with the bytecode appended past its ad-hoc code
signature, so it never passes strict signature validation — it runs only because the
kernel accepted it when the file was first created. Writing a NEW boot over the SAME
path keeps the inode and invalidates that acceptance: every later run dies with SIGKILL
(exit 137) and prints nothing at all — no error, no partial output, no crash report line
in the terminal.

The failure is easy to misdiagnose, because it looks like a program that starts and
silently decides to do nothing:

```
$ haxe build.hxml        # -cmd nekotools boot bin/tool.n
$ bin/tool --version
$ echo $?
137
```

- `codesign --force --sign - bin/tool` does not fix it — it reports
  `main executable failed strict validation`, and the binary stays killed.
- Restoring the previous BYTES to the same path does not fix it either; the path is
  poisoned, not the content.
- A boot into a path that does not exist yet works normally, which is why a first
  install succeeds and only rebuilds break.

**Fix:** delete before booting — `rm -f bin/tool && nekotools boot bin/tool.n`. In an
hxml that boots as a build step, the `-cmd` line needs the same treatment (keep it
portable if the project builds on Windows too, where the overwrite is harmless).

**Tell:** a CLI tool that worked before a rebuild now exits 137 with empty stdout AND
empty stderr, for every argument including `--help`. Any wrapper that re-execs the
canonical install path will report the same silence with a different exit code, which
sends the search toward config parsing instead of toward the binary.
