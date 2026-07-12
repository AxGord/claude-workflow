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
