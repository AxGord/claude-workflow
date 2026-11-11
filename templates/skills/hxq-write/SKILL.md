---
name: hxq-write
description: hxq WRITE side — mutation ops, patch/replace-node, new/fmt, lint --fix (authors editing .hx; load after hxq)
---

# hxq-write — editing and creating .hx

Read-side rules (selectors, gate, which query answers what) live in `hxq`; this skill is only for agents that WRITE.

**READING a foreign repo is unconditional; WRITING to one is not.** Every writer-emit op is gated on `writeRoundTrip(s) == s` — canonical *by hxq's writer*. A foreign repo may declare a DIFFERENT formatter (check its CLAUDE.md / README / CI before the first edit), and then `the old fragment does not occur` / `file is not in canonical form` is not an obstacle to route around: it is the tool reporting that it does not own this file's layout. **Do not `hxq fmt --write` to satisfy the gate** — that rewrites the file into a style the repo's own formatter partially reverts on its next pass, so you have started a tool war inside someone else's repo. Edit with ordinary tools, then run THAT repo's formatter, and check the result is idempotent.

Before blaming a writer for a diff against another formatter: compare INSIDE the repo (both walk up for `hxformat.json`; a scratch copy gets defaults) and treat a disagreement as an unset config knob until proven otherwise — detail: ../hxq/references/ops.md § foreign repos (moved there).

**A lint finding is a hypothesis — typecheck after acting on it. A repeated string literal feeding a MACRO cannot be hoisted (the error names the macro's parameter): record why in a comment instead.**

## Build / auto-rebuild

**Workers pin `HXQ_BIN=<worktree>/bin/apq.js` (the prompt does) and rebuild BOTH binaries after a macro/src change: `haxe bin/apq-js.hxml && haxe test-js.hxml`; a stale binary makes probes lie.** Rest (shim auto-rebuild, HXQ_AUTO_REBUILD, parallel worker recipe): ../hxq/references/ops.md § Build.

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

## Mutation ops — index. BEFORE running ANY mutation op → Read ../hxq/references/ops.md

hxq has full-CRUD, scope-correct, format-preserving, re-parse-validated
mutation ops. The complete contracts, safety boundaries, writer-emit
caveats and recipes live in ../hxq/references/ops.md — read it before the FIRST
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
JSON files (`test/testkit/arms/<package>.json`, `apqlint.json`, `hxformat.json`): add-element
(--after/--before/--append/--sorted) · remove-element · replace-node · ast ·
source work on a `.json` path, format-preserving — NEVER python/sed/jq for
these files. Vocabulary `Member:<key>` / `JArray` / `JString:<value>` →
../hxq/references/ops.md § "JSON files".

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
  one has none. **`patch` REFUSES that.**
- `patch` reaches a TYPE's own leading doc; `comment-rewrite` / `set-doc` detail: ../hxq/references/ops.md § Doc edits.
- **`add-member` only reaches a TYPE BODY.** A new module-level sibling — a second typedef,
  an enum beside the class — goes in with `add-element --after --select '<Kind>:<name>'`
  addressing an existing top-level declaration; `add-member` has no address for that slot.
- `rename` refuses captures and `$name` string/redeclaration blind spots (`--qualify-shadowed` for the param idiom); a bare `$name` macro splice is NOT renamed or refused — replace the whole function; run the build after any `rename`.
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

`lint --baseline` / `--verbose`: ../hxq/references/lint.md § `--baseline` and `--verbose`.

Query recipes and 0-hit troubleshooting: ../hxq/references/queries.md (the tool also prints kind-aware suggestions on empty results — read the stderr first).

## File-level create / format ops (`new` / `fmt`)

Create-side + whole-file counterparts of the node-level writer-emit ops. **Raw `Write` of a `.hx` is NOT canonical** (it emits whatever bytes you typed) and may not parse — so a new file goes through `hxq new`, and any drift is fixed by `hxq fmt`. Both run via the `hxq` CLI (a Bash command, not the Edit/Write tools), so they bypass the Edit-gate/warn hooks and emit canonical+validated by construction.

| Op | What | Safety boundary |
|---|---|---|
| `hxq new <path> (--kind class\|interface\|enum\|typedef\|abstract \| --implements <iface> \| --raw -) [--extends <T>]… [--field <m>]… [--bodies -] [--arm <json> \| --arm-file <f>]… [--arms-dir <d>] [--no-verify] [--write]` | CREATE a module — parse-or-reject + canonical + atomic; a created module that does not typecheck is put back — `--no-verify` writes it ahead of its dependencies (or create the dependency first). `--arm` appends a mutation-arm record (`{name,type,method,note + force \| find,replace}`) to its type package's arm document in the SAME atomic write, so a new `@:pin('control')` test is born with its `@:killer`; a taken name is refused. | Create-only (refuses an existing path). Package/name from `<path>`. `--implements` slices the interface signatures AND carries their imports (result type-checks). `--bodies -`: `@@ <method>` / `@@ imports` / `@@ doc` / `@@ members` sections; an unknown section or unparseable body → nothing written. `--raw -` = the whole file on stdin through the writer round-trip. Full flag contract: ../hxq/references/ops.md § new. |
| `hxq fmt <file/dir/glob>... [--write] [--list]` | Canonicalise via the writer round-trip (gofmt-style) — the create-finisher AND the canonical-gate's measuring stick (`writeRoundTrip(s) == s`). | `--write` rewrites in place; `--list`/`-l` prints drifted paths (no rewrite); a single concrete file with no flags → formatted source to stdout; multiple files / a dir without `--write` → `--list` implied. Per-file `hxformat.json` discovered. Idempotent. A parse failure is reported + skipped; exit non-zero if any file failed. |

**Creating a new `.hx`: use `hxq new`, not Write.** For shapes `hxq new` doesn't cover (enums, interfaces, typedefs, multi-type modules, test classes with methods), raw `Write` is still the path — but a **PostToolUse warn hook** (`apq-canon-warn.sh`, personal/gitignored, sibling of the edit-gate) then nudges if the result isn't canonical/parseable; run `hxq fmt <file> --write` to fix. **The original false belief that started this: "a new file via Write is immediately canonical" — it is NOT.** Determinism comes from the writer round-trip (`new`/`fmt`), never from the way bytes were written.

**Never `rm` an existing `.hx` then `hxq new --raw -` to EDIT it.** `new` is create-only by design (refuses an existing path); deleting the file first to bypass that refusal is a wholesale-rewrite hack — it risks faithful-reproduction errors and discards the ops' scope-correct/format-preserving guarantees. To edit a parseable `.hx`, always use the surgical ops (`replace-node`/`add-member`/`add-import`/`set-modifier`/`remove-member`/`remove-element`); reserve `new`/`new --raw` for files that do not yet exist.

## Write-side confusions — index (full text: `../hxq/references/confusions.md`)

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
- A scratch-file probe of a LAYOUT-sensitive fix (line wrap/indent/braces) is config-blind — same root cause as the `/tmp`-canonical false-refuse and `--fix` no-op notes (../hxq/references/ops.md, references/lint.md).
- `set-doc` takes PLAIN newline-separated text — it derives and adds the per-line doc-comment prefix itself, from the target's indent.
- `comment-rewrite` re-prefixes a MULTI-LINE replacement with the comment's own continuation
- A `$'…'` doc payload containing an APOSTROPHE must escape it as `\'` — the `'"'"'` idiom silently kills the `\n` escapes after it.
- Driving an op over a real tree to MEASURE it: classify by the op's OWN message, never by exit code.
