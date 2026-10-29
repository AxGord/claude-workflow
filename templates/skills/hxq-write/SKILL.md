---
name: hxq-write
description: hxq WRITE side — mutation ops, patch/replace-node, new/fmt, lint --fix (authors editing .hx; load after hxq)
---

# hxq-write — editing and creating .hx

Read-side rules (selectors, gate, which query answers what) live in `hxq`; this skill is only for agents that WRITE.

**READING a foreign repo is unconditional; WRITING to one is not.** Every writer-emit op is gated on `writeRoundTrip(s) == s` — canonical *by hxq's writer*. A foreign repo may declare a DIFFERENT formatter (check its CLAUDE.md / README / CI before the first edit), and then `the old fragment does not occur` / `file is not in canonical form` is not an obstacle to route around: it is the tool reporting that it does not own this file's layout. **Do not `hxq fmt --write` to satisfy the gate** — that rewrites the file into a style the repo's own formatter partially reverts on its next pass, so you have started a tool war inside someone else's repo. Edit with ordinary tools, then run THAT repo's formatter, and check the result is idempotent.

Before blaming a writer for a diff against another formatter: compare INSIDE the repo (both walk up for `hxformat.json`; a scratch copy gets defaults) and treat a disagreement as an unset config knob until proven otherwise — detail: references/ops.md § foreign repos (moved there).

**A lint finding is a HYPOTHESIS — typecheck after acting on one, before believing it.** The linter reasons about shapes, not about what a callee's signature demands, so a rule can propose a transformation the language forbids at that call site. The sharpest case: **a repeated string literal that feeds a MACRO cannot be hoisted into a constant.** Macro parameters are `Expr`, and a macro that wants a literal rejects an identifier — the error names the macro's own parameter and reads nothing like "your constant", e.g. `haxe.macro.Expr should be String … For function argument 'inModule'`. Whole families do this: native-prim loaders, compile-time translation lookups, compiler-directive helpers. When a `string-literal-dup` (or any hoist/extract suggestion) lands on an argument of such a call, the fix is a COMMENT recording why the repetition is mandatory, not the extraction. Apply, typecheck, and revert if the compiler objects — and note that `noqa` only works as a TRAILING comment on the flagged line, so a finding whose position falls inside a wrapped argument list cannot be suppressed there without fighting the formatter; accepting it and documenting the reason in the project's own notes is the honest end state.

**`hxq lint` in a repo with no `apqlint.json` runs the builtin defaults, which that project never opted into.** Read the findings, never `--fix` them: a `naming` rule will happily rename identifiers that deliberately mirror foreign-language symbols (C prims, JNI methods), and `unused-parameter` fires on every per-platform no-op stub by construction.

## Build / auto-rebuild

`haxe bin/apq-js.hxml` builds the JS runner. **The `hxq` shim AUTO-REBUILDS by default** when `find -newer` detects stale `.hx` under `src/`; aborts on build failure. Opt-out:
- `HXQ_AUTO_REBUILD=0` — legacy warn-once-per-mtime mode (cache at `$XDG_CACHE_HOME/hxq/warned`).
- `HXQ_QUIET=1` — skip stale check entirely. Takes precedence.
  ⚠️ NEVER use it for a VERIFICATION probe right after src/ edits — it runs the STALE binary and can "refute" a fix that actually landed (or "confirm" one that didn't). Verification probes need an explicit `haxe bin/apq-js.hxml` first, or a bare `hxq` call (auto-rebuild on).

**Rebuild matrix — `apq.js` and `test.js` are SEPARATE binaries.** `haxe bin/apq-js.hxml` builds `apq.js`; `haxe test-js.hxml` builds `test.js`. Edits to macro-driven src (`WriterLowering`/`ShapeBuilder`/`Codegen`/`Build`/`Lowering`/`TriviaTypeSynth`…) require rebuilding BOTH before trusting results: a stale `apq.js` makes probes/ops lie, a stale `test.js` makes the sweep lie. Quick staleness check: `grep -c <newSymbol> bin/apq.js`.

**Worktree nuance:** the shim keys off `git rev-parse --show-toplevel` — run `hxq` with CWD *inside* the worktree AND build the worktree's engine, else it silently falls back to the main-tree baseline binary.

**PARALLEL WORKERS — `HXQ_BIN=<path>/apq.js` pins the engine** (checked before the shared-`bin/` selection, so it works even in a tree whose `bin/` is empty; `.n` ⇒ neko, else node) and SKIPS the stale check entirely — the caller owns its build. This is the only way several agents can work one repo at once: the shared `bin/apq.js` / `bin/test.js` are single artifacts, so each build truncates the binary the others are executing (failures then read as flaky tests, not as a build race). Each worker runs `tools/worker-build.sh <workdir>` for a private `apq.js` + `test.js`, then `HXQ_BIN=<workdir>/apq.js hxq …` and `node <workdir>/test.js`. Two limits: this parallelizes the TOOL, not the source tree — concurrent mutation ops on the same files still need coordination (real isolation = a worktree per worker, which `node bin/dev.js mutation-check` does); and a private engine is a snapshot that goes stale with NO warning when another agent lands a `src/` change, so rebuild your own before trusting a probe. Full recipe: `docs/testing.md` § "Parallel tracks".

## Addressing for ops

**Not EVERY writer-emit op is addressed this way.** `add-member` takes `--type <TypeName>` and the member
text (inline / `--from-file` / stdin `-`) — it has NO `--select`, and appending is its only position.
`add-import` / `remove-import` take the import path. `new` / `fmt` are whole-file. Everything else in the
table below does accept the address forms above.

**Why select/match over positions: they are EDIT-STABLE.** A chain of ops needs NO re-locate between edits (positions rot as soon as an earlier edit shifts lines — the old add-import/replace-node line-shift gotcha is dead when you use named addresses). `>>` makes the natural path work: `--select 'ClassDecl:X >> FnMember:f >> VarStmt:tmp'` reaches a local without knowing block nesting.

**Recipes:**
```sh
# member/decl by name (no locate step at all):
hxq set-modifier f.hx --select 'FnMember:walk' public --write
hxq set-doc f.hx --select 'FnMember:walk' 'One-liner.' --write
hxq remove-element f.hx --select 'FnMember:run >> VarStmt:tmp' --write
# statement by pattern + kind-LIFT (replaces the WHOLE statement, not the bare Call):
hxq replace-node test/RunTests.hx --match 'addCase(new SiblingTest())' --kind ExprStmt --write - <<'EOF'
addCase(new SiblingTest());
addCase(new NewTest());
EOF
# insert next to a named sibling (mode flag is valueless when --select/--match give the address):
hxq add-element f.hx --after --select 'Field:conditionalElseKeywords' "newField: ['x']" --write
# fn-ops by name (cursor lands on the NAME token automatically):
# GOTCHA: --select 'FnMember:f' alone renames the FUNCTION itself — a PARAM has no
# named selector (Required/Optional nodes); rename a param via its position from
# `refs <name> --decls` (e.g. `hxq rename f.hx 52:63 _opt --write`).
hxq rename f.hx --select 'FnMember:f >> VarStmt:x' newName --write
hxq change-sig f.hx --select 'FnMember:g' 1,0 --write
hxq remove-param f.hx --select 'FnMember:g' 1 --write
# extract-var by expression pattern (exact subexpression, co-starting chains can't swallow it):
hxq extract-var f.hx --match 'a * 2' doubled --write
```

**The ops TEACH you the stable address:** a position- or `--match`-addressed op echoes `apq <op>: target <canonical-selector>` to stderr — use it verbatim in the follow-up op. `hxq lint --format json` records carry the same thing in an `address` field. When you DO need a position mode on ops, prefer the bare `<line>` form; `--at <l> --kind <K>` (replace-node) still exists for co-starting operator nodes, but `--select`/`--match --kind <lift>` covers most of what it did.

## Mutation ops — index. BEFORE running ANY mutation op → Read references/ops.md

hxq has full-CRUD, scope-correct, format-preserving, re-parse-validated
mutation ops. The complete contracts, safety boundaries, writer-emit
caveats and recipes live in references/ops.md — read it before the FIRST
mutation op of a session; the index below only names what exists.

Span-splice refactoring ops: rename (in-file / --scope cross-file) ·
inline · extract-var · change-sig · move · move-member (--closure
--scaffold) · extract-interface · pull-up / push-down ·
extract-superclass · add-param · remove-param · inline-method ·
introduce-parameter-object · make-final.
Writer-emit ops (canonical-gated): add-member · add-import · replace-node ·
add-element · remove-element · remove-import · remove-member · safe-delete ·
encapsulate-field · set-doc · set-modifier · set-comment · rewrite ·
comment-rewrite · resolve-define · patch · extract-method · add-meta.
JSON files (`mutation-arms.json`, `apqlint.json`, `hxformat.json`): add-element
(--after/--before/--append/--sorted) · remove-element · replace-node · ast ·
source work on a `.json` path, format-preserving — NEVER python/sed/jq for
these files. Vocabulary `Member:<key>` / `JArray` / `JString:<value>` →
references/ops.md § "JSON files".

Six SILENT hazards that must never wait for the reference read:
- **`replace-node`'s span covers the WHOLE declaration INCLUDING its leading modifiers**,
  so `<newSource>` that omits them silently drops them. Replacing a member with
  `function f(): T { … }` instead of `public function f(): T { … }` reports `wrote <file>`
  and leaves the member private. The op does not complain; the next build does, with an
  error that names a DIFFERENT problem — an interface-conformance failure at the type, or
  an access error at some caller — so the modifier is the last place you look. Always spell
  the modifiers verbatim (`private static function walk(…)`), and prefer `patch` when the
  change is a few lines inside a bigger body. (Modifier FLIPS are `set-modifier`'s job. A
  whole-type `replace-node --select 'ClassDecl:X'` works since 2026-10-17 (anyparse N5 +
  `bf7c68763`): its span covers the type's leading doc AND `final`, so `<newSource>` spells
  both — omit the doc and it is dropped.)
- **`replace-node --select 'FnMember:x'` also silently DROPS the member's leading `@:meta`s**
  (`@:pin`, `@:killer`, …; an open bug): spell them verbatim in
  `<newSource>` like the modifiers, or prefer `patch`; read the node back after the op.
- **`set-doc` replaces EVERY doc block above the target, not just the adjacent one.**
  Two `/** */` blocks can sit back-to-back before a declaration — the usual cause is an
  earlier type's doc left ORPHANED above the next declaration, which is exactly the shape
  a doc-placement lint reports and nobody has fixed yet. `set-doc` collapses the run into
  the single block you wrote, deleting the other with no diagnostic: the op reports
  `wrote <file>`, the build stays green, the suite stays green, and documentation for an
  unrelated type is simply gone. Read the region back (`hxq source --range`) or check
  `git diff` after ANY `set-doc` on a declaration you have not just created. When the
  orphan turns out to belong to a different declaration, re-attach it there rather than
  restoring the pile. **And you can CREATE that orphan yourself**: inserting a new
  declaration with `patch` anchored on `<decl-keyword> <Name>` lands the insertion AFTER
  the existing doc block, so the old doc now documents your new declaration and the old
  one has none. **`patch` now REFUSES that** (since the S23 fix — it reads the doc owner's
  name before and after the splice and rejects the edit naming both declarations), but the
  Inserting a declaration with `patch` anchored on `<decl-keyword> <Name>` would hand the old doc to the
  new declaration — `patch` REFUSES that, and the shared seam refuses every doc-splitting edit of the
  addressed ops and both `lint --fix` paths; on a NON-canonical file the extract ops fall back to a plain
  splice and lose the refusal — canonicalise first.
- **`patch` reaches a TYPE's own leading doc (since 2026-10-17, anyparse N5).** The doc is
  trivia outside the type's node, so `patch --select 'ClassDecl:X'` first searches the
  declaration as before; ONLY when the fragment is not there does it search the declaration's
  own doc block (old payloads behave byte-identically). Before N5 this failed with "the old
  fragment does not occur in the resolved ClassForm node". Inserting text ABOVE a documented
  declaration via patch is still refused (the doc would land on the wrong owner) — extend the
  fragment to include the doc on the same address instead. Other doc tools: `hxq
  comment-rewrite '<find>' '<replace>' <f> --write` — a LITERAL `<find>` is matched against the
  normalized body (each line break, plus the ` * ` continuation after it, collapsed to one
  space; the find is normalized the SAME way), a `--regex` find against the RAW body (needs
  `\s+\*\s+` to cross a line); a multi-line `<replace>` gets the block's own continuation on
  every line it adds, so write PLAIN lines with real newlines and a ` * ` you add yourself is
  stripped, not doubled; long lines are reflowed into the configured width (see the
  `comment-rewrite` bullet below); a find that matches nothing SAYS so on stderr. `set-doc`
  replaces the WHOLE block — use it only when replacing the entire doc.
- **`add-member` only reaches a TYPE BODY.** A new module-level sibling — a second typedef,
  an enum beside the class — goes in with `add-element --after --select '<Kind>:<name>'`
  addressing an existing top-level declaration; `add-member` has no address for that slot.
- A de-prefixing `rename` whose new name a PARAM/LOCAL already holds produces a
  self-assignment that COMPILES — `m_x` -> `x` where `new(x)` does `m_x = x`
  yields `x = x;`, and stripping a trailing `_` that disambiguated param from
  field (`f = f_` -> `f = f`) is the same trap; no error, no oracle catch, the
  field silently stays unassigned. `rename` now REFUSES this (it re-resolves the
  rewritten tree and requires the occurrence set to be unchanged), naming the
  re-bound position. Pass `--qualify-shadowed` to get `this.x = x` instead of the
  refusal — it applies ONLY to a capture by a PARAMETER in a non-static function
  (the param idiom); a capture by a local or in a static context stays a refusal,
  since `this.` there would be confusing or invalid. `rename` still cannot refuse
  a collision with a member INHERITED from outside `--scope` (a library
  supertype) — that one at least fails to compile. `rename` also REFUSES two
  resolution blind spots (2026-07-25) instead of silently part-applying: a
  `$name` string-interpolation read (not indexed — was left bound to whatever
  the old name still meant) and a same-block REdeclaration of the name
  (references after the second decl mis-bind to the first). Until the
  resolution index learns both, run the project's compiler oracle right after
  ANY `rename --write` — reparse validation alone does not prove semantics.
  SEPARATE gap, still open: a bare `$name` macro-reification SPLICE (distinct
  from the `${…}`/`$v{…}` interpolation form, which IS indexed) is neither
  renamed nor refused — it silently keeps the OLD name. Rename a macro-time
  local via `replace-node --select 'FnMember:<fn>'` (whole-function replace),
  never `rename`.
- **Never `2>/dev/null` a mutation op.** Every rejection is a stderr line with a
  zero-ish-looking shell result inside a chained command, so a suppressed
  `the old fragment does not occur` / `matched no nodes` reads as success: the
  file is untouched, the follow-up build is green, and you go on to reason about
  a fixture or a fix that was never applied. Same for a `for`-loop of ops where
  only the last exit code survives. If output volume is the problem, keep stderr
  and drop stdout (`1>/dev/null`), and confirm the edit landed by reading the
  node back (`hxq source --select`) rather than by the command "not erroring".
- Every mutation op is PRINT-ONLY without `--write` — a forgotten --write
  looks like success (stdout echoes the result) but changes nothing.
  EXCEPTION: `lint --fix` is NOT a node mutation op — `--fix` itself WRITES
  in place (no separate `--write`, no print-only mode; it reports
  `N edit(s) in M file(s) over P pass(es)` — EDIT SPANS, not findings: one
  rename of a local read three times is 4 edits). To preview, run on a
  clean/stashed tree
  and inspect `git diff`. Scope tightly (`--rule <id>` + a file list) —
  the write set = the lint scope, and canonicalization can touch any file
  it writes.
- On parseable project .hx: EDIT via ops, CREATE via `hxq new` — never
  Edit/Write (a gate hook denies them); `hxq patch` (old ==== new via
  heredoc) is the DEFAULT small-edit op.
- `replace-node --at <pos> --kind <K>` can grab a CO-STARTING ENCLOSING
  node of the same kind and silently swallow surrounding code — prefer
  `--select` / `--match --kind`; if you must use --at, probe `ast --at`
  first.

**Choosing `patch` vs `replace-node`, and what NOT to type.** `patch` matches its `old`
fragment VERBATIM inside the resolved node (byte-exact, then dedent-tolerant), so the cost of
`patch` is retyping the fragment exactly and it grows with the fragment. Rule of thumb: when
the replacement covers **more than about half the node, address the node and pass only the new
text** — `replace-node --select '<Kind>:<name>'`. `patch` earns its keep on a few lines inside a
bigger body. Two cases stay with `replace-node` whatever the size: a macro-time local (`rename`
cannot see a bare `$name` reification splice), and any change to a leading modifier group — and
there `replace-node`'s span INCLUDES the modifiers, so spell them verbatim.

**Write types, skip indentation.** Every writer-emit op re-emits the file through the writer, so
the text you hand it is canonicalised by the project's own `hxformat.json` — measured on
`add-member`: a body written flush-left with `xs:Array<String>):Int` came back tab-indented as
`xs: Array<String>): Int`. Explicit type annotations are the opposite: hxq does NOT infer them
(`explicit-type` / `explicit-local-type` are OracleAssisted, and a write op's `--fix` forces
`--no-oracle`, so they are inert and report-only). So do not hand-indent, and do annotate.

**`hxq lint --baseline <path>`** (S197) reports only the findings a previous `--format json`
snapshot at `<path>` does not already carry, then refreshes `<path>` with every finding of this
run. Multiset over `(file, rule, severity, message)`, so a line shift is not a delta. Narrows
the report, the summary and `--fail-on` alike; REFUSED with `--fix`. A `<path>` that does not
exist starts a fresh snapshot; one that exists and is not a report is reported on and LEFT
ALONE, so a mistyped path cannot cost you a file. **`hxq lint --verbose`** brings back the two
blocks a quiet run withholds: the `--fix` rule census (silent when the run wrote nothing) and
the `--no-oracle` net notice.

Query recipes and 0-hit troubleshooting: references/queries.md (the tool also prints kind-aware suggestions on empty results — read the stderr first).

## File-level create / format ops (`new` / `fmt`)

Create-side + whole-file counterparts of the node-level writer-emit ops. **Raw `Write` of a `.hx` is NOT canonical** (it emits whatever bytes you typed) and may not parse — so a new file goes through `hxq new`, and any drift is fixed by `hxq fmt`. Both run via the `hxq` CLI (a Bash command, not the Edit/Write tools), so they bypass the Edit-gate/warn hooks and emit canonical+validated by construction.

| Op | What | Safety boundary |
|---|---|---|
| `hxq new <path> (--kind class\|interface\|enum\|typedef\|abstract \| --implements <iface> \| --raw -) [--extends <T>]… [--field <m>]… [--bodies -] [--write]` | CREATE a module — parse-or-reject + canonical + atomic. | Create-only (refuses an existing path). Package/name from `<path>`. `--implements` slices the interface signatures AND carries their imports (result type-checks). `--bodies -`: `@@ <method>` / `@@ imports` / `@@ doc` / `@@ members` sections; an unknown section or unparseable body → nothing written. `--raw -` = the whole file on stdin through the writer round-trip. Full flag contract: references/ops.md § new. |
| `hxq fmt <file/dir/glob>... [--write] [--list]` | Canonicalise via the writer round-trip (gofmt-style) — the create-finisher AND the canonical-gate's measuring stick (`writeRoundTrip(s) == s`). | `--write` rewrites in place; `--list`/`-l` prints drifted paths (no rewrite); a single concrete file with no flags → formatted source to stdout; multiple files / a dir without `--write` → `--list` implied. Per-file `hxformat.json` discovered. Idempotent. A parse failure is reported + skipped; exit non-zero if any file failed. |

**Creating a new `.hx`: use `hxq new`, not Write.** For shapes `hxq new` doesn't cover (enums, interfaces, typedefs, multi-type modules, test classes with methods), raw `Write` is still the path — but a **PostToolUse warn hook** (`apq-canon-warn.sh`, personal/gitignored, sibling of the edit-gate) then nudges if the result isn't canonical/parseable; run `hxq fmt <file> --write` to fix. **The original false belief that started this: "a new file via Write is immediately canonical" — it is NOT.** Determinism comes from the writer round-trip (`new`/`fmt`), never from the way bytes were written.

**Never `rm` an existing `.hx` then `hxq new --raw -` to EDIT it.** `new` is create-only by design (refuses an existing path); deleting the file first to bypass that refusal is a wholesale-rewrite hack — it risks faithful-reproduction errors and discards the ops' scope-correct/format-preserving guarantees. To edit a parseable `.hx`, always use the surgical ops (`replace-node`/`add-member`/`add-import`/`set-modifier`/`remove-member`/`remove-element`); reserve `new`/`new --raw` for files that do not yet exist.

## Write-side confusions — index (full text: `references/confusions.md`)

- Sweeping an op over EVERY declaration of a kind — (a census: how often does this op fire, how often does it refuse and why) — you do not need names or positions.
- `patch` anatomy — the three failure modes in one line each. — (1) The payload is ONE argument: `old` / `new` fragments alternating, separated by `====` on its OWN line (even section count; N…
- Widening an interface with many implementors is impossible under per-op auto-rebuild
- MOVING a member within its type has no dedicated op — it is `remove-member` + a re-insert, and the whole chain needs `HXQ_AUTO_REBUILD=0`.
- `rename` refuses a new name that an EARLIER op in the same chain already introduced — order, not `HXQ_AUTO_REBUILD`, is the fix.
- `rename --scope` refuses with a FALSE type ambiguity when the cursor file and the scope are written in DIFFERENT path forms.
- `test-summary -` TRUNCATES a large piped stream — `node bin/test.js | hxq test-summary -` read only ~1583 of 5023 tests and still printed `0 failures` (a partial slice looks…
- A new lint/fix rule green on its unit suite + scratch probes is NOT done yet — run it over a large real tree and READ every site it would change.
- `move` (type to another file/package), the contract measured by S64/S65 (2026-09-03):
- Removing a temporary `Sys.stderr` probe: use `remove-element --match`, not a verbatim `patch` revert.
- Wrapping an EXISTING member in `#if … #end`: `patch` the ENCLOSING type, not the member.
- A scratch fixture that `lint --fix` SKIPS reads exactly like a refusal.
- A scratch-file probe of a LAYOUT-sensitive fix (line wrap/indent/braces) is config-blind — same root cause as the `/tmp`-canonical false-refuse and `--fix` no-op notes (references/ops.md, references/lint.md).
- `set-doc` takes PLAIN newline-separated text — it derives and adds the per-line doc-comment prefix itself, from the target's indent.
- `comment-rewrite` re-prefixes a MULTI-LINE replacement with the comment's own continuation
- A `$'…'` doc payload containing an APOSTROPHE must escape it as `\'` — the `'"'"'` idiom silently kills the `\n` escapes after it.
- Driving an op over a real tree to MEASURE it: classify by the op's OWN message, never by exit code.
