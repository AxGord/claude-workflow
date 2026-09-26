---
name: hxq
description: When and how to use hxq for structural Haxe navigation
---

# hxq — structural Haxe query CLI

`hxq <subcommand> [opts] <file-or-dir-or-glob>...` parses `.hx` files with anyparse's own parser. Invoke as bare `hxq` (on PATH) — never `./bin/hxq`. Auto-adds `--lang haxe`.

> **ONE command for EVERYTHING — `hxq`.** `hxq` runs BOTH the read/query subcommands AND the write/mutation ops below (it forwards every subcommand to the engine). **`apq` is a documentation label, NOT an installed command** — wherever this skill writes `apq <op>`, RUN it as `hxq <op>`. **Never `node bin/apq.js`** (bypasses the shim and needs cwd=project). **Never `cd`** — `hxq` is on PATH and cwd-independent; pass project-relative paths (default cwd = project root) or absolute paths, and use `hxq probe '<code>'` for throwaway snippets instead of `/tmp` scratch files. (USER decision; root cause = the `apq`/`hxq` dual-naming where only `hxq` is installed.)

**Path arguments: prefer relative.** `hxq` respects CWD; relative paths give shorter hit lines (`<file>:line:col`) than absolute. Use absolute only for files outside the current project.

**Works on ANY `.hx`, including EXTERNAL forks / other repos.** hxq parses by the anyparse grammar regardless of which project a file lives in — `refs`/`uses`/`ast`/`search`/`source` all work cross-project (e.g. querying a `haxe-formatter` fork for ground-truth). Pass the absolute path. Do NOT grep / `node -e readFileSync` / `git show` a fork `.hx` — that is the recurring crutch reflex. Query it structurally (`refs`/`ast`) or read raw lines with `hxq source` (gate-blessed, below; **inside a sandboxed agent use the alias `hxq show`** — a shell sandbox refuses any command carrying the token `source`, since it reads as the builtin that executes a file). Most fork files parse; only the few that genuinely skip-parse need `hxq source` (which reads raw bytes regardless of parse status).

**READING a foreign repo is unconditional; WRITING to one is not.** Every writer-emit op is gated on `writeRoundTrip(s) == s` — canonical *by hxq's writer*. A foreign repo may declare a DIFFERENT formatter (check its CLAUDE.md / README / CI before the first edit), and then `the old fragment does not occur` / `file is not in canonical form` is not an obstacle to route around: it is the tool reporting that it does not own this file's layout. **Do not `hxq fmt --write` to satisfy the gate** — that rewrites the file into a style the repo's own formatter partially reverts on its next pass, so you have started a tool war inside someone else's repo. Edit with ordinary tools, then run THAT repo's formatter, and check the result is idempotent.

Two traps while establishing which formatter owns a file:
- **Compare the two INSIDE the repo, never on a copy elsewhere.** Both discover `hxformat.json` by walking up from the file, so a scratch copy silently gets compiled defaults and manufactures a huge fake delta — the same config-blindness documented for `--fix` probes below, in a shape that looks like a tool-vs-tool finding rather than a probe error.
- **A disagreement between two writers is a CONFIG gap until proven a parity defect.** An `hxformat.json` that leaves a knob unset does not make both tools behave the same — it makes each fall back to its OWN default, and the resulting diff looks exactly like a writer-parity bug. Measured on one ~200-line file: under a config with no `wrapping.functionSignature` the two writers differed by 57 lines; copying in a fully-specified config from a sibling project dropped that to 19 and made both produce the same (better) shape. Before reporting "the writers disagree", re-measure under a config that actually pins the rules in question — otherwise you will file config gaps as tool defects, and the "fix" you recommend (avoid one tool) is the wrong one. The right fix is usually to specify the config.

  Corollary worth checking first when output looks ugly rather than merely different: **ugly wrapping is almost always an unset knob, not the tool.** A parameter list that overflows its line and orphans one argument at a deep continuation indent is the formatter's fallback for an unconfigured signature-wrapping rule; a project that configures `fillLineWithLeadingBreak` gets a break after `(`, all parameters on ONE continuation line at +1 indent, and the closer back at the declaration's indent.

**A lint finding is a HYPOTHESIS — typecheck after acting on one, before believing it.** The linter reasons about shapes, not about what a callee's signature demands, so a rule can propose a transformation the language forbids at that call site. The sharpest case: **a repeated string literal that feeds a MACRO cannot be hoisted into a constant.** Macro parameters are `Expr`, and a macro that wants a literal rejects an identifier — the error names the macro's own parameter and reads nothing like "your constant", e.g. `haxe.macro.Expr should be String … For function argument 'inModule'`. Whole families do this: native-prim loaders, compile-time translation lookups, compiler-directive helpers. When a `string-literal-dup` (or any hoist/extract suggestion) lands on an argument of such a call, the fix is a COMMENT recording why the repetition is mandatory, not the extraction. Apply, typecheck, and revert if the compiler objects — and note that `noqa` only works as a TRAILING comment on the flagged line, so a finding whose position falls inside a wrapped argument list cannot be suppressed there without fighting the formatter; accepting it and documenting the reason in the project's own notes is the honest end state.

**`hxq lint` in a repo with no `apqlint.json` runs the builtin defaults, which that project never opted into.** Read the findings, never `--fix` them: a `naming` rule will happily rename identifiers that deliberately mirror foreign-language symbols (C prims, JNI methods), and `unused-parameter` fires on every per-platform no-op stub by construction.

**Output: grouped-by-file by default.** Walkers print `<file>:` once then 2-space-indented `<line>:<col>: <hit>` lines. Pass `--flat` for legacy `<file>:<line>:<col>: <hit>` per line (downstream tools).

## Build / auto-rebuild

`haxe bin/apq-js.hxml` builds the JS runner. **The `hxq` shim AUTO-REBUILDS by default** when `find -newer` detects stale `.hx` under `src/`; aborts on build failure. Opt-out:
- `HXQ_AUTO_REBUILD=0` — legacy warn-once-per-mtime mode (cache at `$XDG_CACHE_HOME/hxq/warned`).
- `HXQ_QUIET=1` — skip stale check entirely. Takes precedence.
  ⚠️ NEVER use it for a VERIFICATION probe right after src/ edits — it runs the STALE binary and can "refute" a fix that actually landed (or "confirm" one that didn't). Verification probes need an explicit `haxe bin/apq-js.hxml` first, or a bare `hxq` call (auto-rebuild on).

**Rebuild matrix — `apq.js` and `test.js` are SEPARATE binaries.** `haxe bin/apq-js.hxml` builds `apq.js`; `haxe test-js.hxml` builds `test.js`. Edits to macro-driven src (`WriterLowering`/`ShapeBuilder`/`Codegen`/`Build`/`Lowering`/`TriviaTypeSynth`…) require rebuilding BOTH before trusting results: a stale `apq.js` makes probes/ops lie, a stale `test.js` makes the sweep lie. Quick staleness check: `grep -c <newSymbol> bin/apq.js`.

**Worktree nuance:** the shim keys off `git rev-parse --show-toplevel` — run `hxq` with CWD *inside* the worktree AND build the worktree's engine, else it silently falls back to the main-tree baseline binary.

**PARALLEL WORKERS — `HXQ_BIN=<path>/apq.js` pins the engine** (checked before the shared-`bin/` selection, so it works even in a tree whose `bin/` is empty; `.n` ⇒ neko, else node) and SKIPS the stale check entirely — the caller owns its build. This is the only way several agents can work one repo at once: the shared `bin/apq.js` / `bin/test.js` are single artifacts, so each build truncates the binary the others are executing (failures then read as flaky tests, not as a build race). Each worker runs `tools/worker-build.sh <workdir>` for a private `apq.js` + `test.js`, then `HXQ_BIN=<workdir>/apq.js hxq …` and `node <workdir>/test.js`. Two limits: this parallelizes the TOOL, not the source tree — concurrent mutation ops on the same files still need coordination (real isolation = a worktree per worker, which `tools/mutation-check.sh` does); and a private engine is a snapshot that goes stale with NO warning when another agent lands a `src/` change, so rebuild your own before trusting a probe. Full recipe: `docs/testing.md` § "Parallel tracks".

## Addressing (v2) — how to point ops at code. READ FIRST

**Default = named/pattern addresses, NOT positions.** Every mutation op accepts one of:

| Form | Meaning |
|---|---|
| `--select '<sel>'` | Selector path: `Kind`, `Kind:name`, `A > B` (direct child), **`A >> B` (any-depth descendant)**. Must resolve to exactly ONE node. |
| `--match '<pattern>'` | `hxq search` structural pattern (`$x` metavars) — the matched node is the target. Exactly-one discipline like `--select`. |
| `--nth <k>` | Pick the k-th (1-based, document order) of several `--select`/`--match` matches. The ambiguity error lists candidates with positions — copy the ordinal from there. |
| ambiguity listing / delete family | An ambiguous `--select`/`--match` listing now spells the selector that picks each candidate where names can (`#2 4:2 Conditional  --select 'ClassDecl:C >> Conditional'`); a row only an ordinal separates stays bare. `remove-member`/`safe-delete` REFUSE two declarations of one name in the SAME `#if` branch (what a `replace-node` leftover looks like) and name the `remove-element … --nth <k>` that takes one — twins in DIFFERENT branches still all go. |
| `<line>[:<col>]` | 1-based position, FALLBACK only. **Column is optional — a bare line number snaps to the line's first non-whitespace char** (take it straight from lint/compiler output). |

**Not EVERY writer-emit op is addressed this way.** `add-member` takes `--type <TypeName>` and the member
text (inline / `--from-file` / stdin `-`) — it has NO `--select`, and appending is its only position.
`add-import` / `remove-import` take the import path. `new` / `fmt` are whole-file. Everything else in the
table below does accept the address forms above.

**Why select/match over positions: they are EDIT-STABLE.** A chain of ops needs NO re-locate between edits (positions rot as soon as an earlier edit shifts lines — the old add-import/replace-node line-shift gotcha is dead when you use named addresses). `>>` makes the natural path work: `--select 'ClassDecl:X >> FnMember:f >> VarStmt:tmp'` reaches a local without knowing block nesting.

**A `--select` that matched nothing now says WHY (S196, 2026-09-09).** Two clauses after a leading em dash, either possibly absent, joined with `; `. The first names a KIND this grammar's parser projects no node for, with the nearest spellings that it does — `--select "FnMembr:f" matched no nodes — "FnMembr" is not a node kind this grammar projects (did you mean FnMember?)`; the did-you-mean runs over the WHOLE vocabulary (238 kinds) and keeps only a substring hit or an edit distance under half the query, so `ClassDeclz` → `ClassDecl` and `Expr` → `FnExpr, IfExpr, ForExpr`, while `Fix` suggests nothing. The second is the older name hint (`"f" exists as 12:9 FnDecl:f; try --select "FnDecl:f"`). A kind that IS projected and merely absent from this file gets NO unknown-kind clause, so the two failures are finally distinguishable: a typo against the vocabulary vs. a node that is somewhere else. `hxq source` carries the same tail (it had no hint at all before); `hxq ast --select` answers the unknown-kind clause instead of its per-file `Kinds present here: …` listing but KEEPS the TypeName-shaped pointer at `refs` / `uses` / `blast` — a type name typed into `--select` is the commonest way to reach a kind no grammar projects. Read the clause before re-typing the selector. **`--kind` is checked against the same vocabulary (S201, 2026-09-10).** `hxq lit 'x' F.hx --kind Literaal` now answers `apq lit: --kind "Literaal" is not a node kind this grammar projects (did you mean Literal, Interval?)` and exits **2** — same clause and same did-you-mean filter as `--select`, under each command's own prefix and the FLAG the user typed (`meta` reports `--on`). It covers `lit`, `search`, `symbols` and `meta --on` (all EXIT_USAGE), and the edit ops' `--kind` narrow / lift on `replace-node` / `patch` / `add-meta` (message improved, exit stays 1 — they always failed closed, but blamed the cursor: `position 1:1 is not on a "ClassDeclz" node`). **`cases` has no `--kind` at all** — its flags are `--flat` / `--limit`; `new --kind` is a different vocabulary (`class|interface|enum|typedef|abstract`) and was already validated. `apq lit` mints `Comment` and `Directive` itself and declares them where it mints them, so both are accepted AND suggestible (`--kind Coment` → `did you mean Comment?`); `lit --kind` segments are trimmed (`'Literal, Comment'` works); an EMPTY segment (`--kind 'Literal,'`) is rejected with no suggestion. `ast --select` / `probe --select` on an unprojected kind now exits **2** with EMPTY stdout (no `(no matches)`, no `--json` document); a kind that IS projected and merely absent from this file still exits **0** with the `Kinds present here: …` listing — the message and the status finally agree, and that is the distinction to read. `source --select` still exits 1 for both (T978).

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

## Gate rules — when grep is forbidden

**Per statement-segment** (split on `&&`/`||`/`;`/newline, NOT on `|` pipes). Two questions:

1. Does the file parse? (skip-parse fixture → NO; normal `src/`/`test/` `.hx` → YES)
2. Is the question structural? ("where defined", "what shape", "which decls carry @:meta") → YES

**BOTH yes ⇒ hxq MANDATORY**, grep/Grep/rg/sed/cat/head/tail/awk on the `.hx` path is **denied**. Two families gate: grep-family AND read-family (use Read tool or hxq to view a parseable `.hx`).

**Pipes don't bypass.** `hxq … | grep` or `cat foo.hx | grep` stays gated — pipelines containing a `.hx` path are caught. Narrow inside hxq instead: `--limit N` (walkers), `--kind <K>` (search), precise subcommand (`refs <name> --decls` for decl, `ast --select <path>` for subtree).

**Pipe-after-hxq warning** (`| head`/`| tail`/`| sed`/`| awk`) is **allowed but nudged** — the hook surfaces a suggestion:
- `_LIST` subcommands (refs/uses/meta/search/blast/lit/mentions) — use `--limit N` instead.
- `_BOUNDED` (ast/diff/strip/writer-equals) — drop the pipe, read full output, or narrow with `--depth N` / `--select`.

**Bypass tokens (last resort):**
- `# HXQ_OK` — machine-verified; only takes effect when EVERY targeted `.hx` is genuinely skip-parse / missing. Bare `# HXQ_OK` on a parseable file = denied.
- `# HXQ_OK:prose` — unconditional bypass for **string/comment-literal search in parseable files**. Use only when `lit` truly can't reach the target (raw bytes, non-captured leaves).
- Heredoc-write to `/tmp/*.hx` is whitelisted (scratch files in `/tmp` are not gate-policed). NOTE: this is about `/tmp` scratch ONLY — an **external fork `.hx` (e.g. `haxe-formatter`) IS gate-policed and IS fully queryable** by hxq; it is NOT a bypass case. Do not over-generalize "outside the project tree" to forks.

**Doc-comments lie about capabilities — verify against the IMPLEMENTATION.** `TypeInfoProvider.declaredTypes`'s doc claimed `Null<…>` declarations were "absent"; the implementation returns the outer name `"Null"` (consumer-side `nullableWrapperTypeNames` handles it). A capability claim sourced from a doc-comment cost a wrong user-facing statement. Before claiming "X can't do Y", read the function body or probe it live.

**Anti-reflex (READ THIS): a tool that SEEMS not to work = assume you're using it wrong, not that it's broken.** Bypass tokens are LAST RESORT — reach for them ONLY after CONFIRMING the target genuinely skip-parses (`recon --probe <file>` / `self-status`). Never `node -e readFileSync` / `git show` / grep a `.hx` reflexively: `hxq source <file> --range L:L2` reads the lines of ANY `.hx` (project or fork, parseable or skip-parse) and is gate-blessed. Its output is **dedented by the smallest indentation in the printed window** — widen the range to include a column-0 line (the type header, a module-level decl) before concluding anything about a member's real nesting, or the same file will look like it declares members at column 0 in one window and at one tab in another. Verify a claimed tool-limitation with one command before acting on it; never propagate "tool X can't do Y" (yours or a sub-agent's) without checking.

**Reading a specific NAMED function / decl → `hxq source <f> --select 'FnMember:<name>'`** (or `--select 'ClassDecl:<Name>'`, or `--at <l>:<c>`). It prints exactly that node's raw source — full lines, dedented, flush-left, in ONE step, gate-blessed. Do **NOT**: (a) use the **`Read` tool** on a `.hx` — it can fabricate content past the first lines AND neither gate blocks it (the gates match `Bash|Grep` / `Edit|Write`, not `Read`), so the discipline there rests entirely on you; (b) `refs --decls` then `source --range` — that's the two-step path the `--select` form collapses; (c) `ast --select … --source` when you only want the TEXT — it prepends the whole S-expr tree (the source slice is appended after, indented). Use `ast --select --source` only when you actually want AST + source together. **`--select` is REPEATABLE**: `hxq source <f> --select 'FnMember:a' --select 'FnMember:b'` prints both in DOCUMENT order under `=== <selector> ===` banners — one selector prints exactly as before, no banner.

**Multi-file IS native.** `meta`/`refs`/`uses`/`search`/`blast`/`mentions`/`lit` all accept dir/glob/multiple paths (recursive walk, union+deduped). `ast` stays single-file. Glob is resolved in-process: `*`, `**`, `?`, `[...]`. **Quote globs** so the shell doesn't pre-expand: `'src/**/Hx*.hx'`. "Grep first to locate, hxq next" is the forbidden reflex — hxq IS the locator.

**Batch-multi-file reflex.** Reaching for `for f in <list>; do hxq <cmd> "$f" …; done` means you missed a batch flag — every walker accepts multiple paths; `strip` is explicitly multi-file (per-file `<file>: PARSE OK/FAIL` + `--- N OK, M FAIL ---` summary). Zsh foot-gun: lowercase `path=` is tied to `$PATH`; assigning inside a loop body wipes PATH.

## Pick the right subcommand — disambiguation table

| Question | Tool |
|---|---|
| Where value X declared / read / written | `refs X <dir> --decls / --reads / --writes` |
| Who consumes type T (field/param/return/generics) | `uses T <dir>` |
| Full change-impact for type T (incl. `.field` access) | `blast T <dir>` |
| List all top-level type decls across a scope (cross-file) | `symbols <scope> [--kind ClassDecl/…]` |
| Which files import a module (cross-file) | `importers <module> <scope>` |
| Declaration site(s) of ONE named type + ambiguity check | `declares <type> <scope>` (matches simple name or qualified path; >1 row = ambiguous, 0 = not declared) |
| Run analysis checks + report violations (grouped-by-file) | `lint <scope> [--rule <id>]… [--fix] [--all] [--flat] [--no-oracle] [--fail-on <sev>] [--format text\|json\|checkstyle]` (analysis/check layer; **`--no-oracle` when you are linting a file you just edited** — with a `compilerOracle` configured, every lint runs a PROJECT-WIDE `haxe <hxml> --no-output` no matter how narrow the scope — measured on anyparse at ~18s of a ~24.5s single-file run; `--no-oracle` makes the same call ~5s and leaves findings byte-identical, it only forfeits the compiler-confirmed nullSafety note. The exact seconds are per-project and DRIFT (the same anyparse figures read 16.1/18.7/2.2 before its tree grew and before it declared `resolutionRoots`) — quote the ratio, re-measure the absolutes. A project that declares its OWN sources in `resolutionRoots` pays one read+parse of the tree per lint process on top of the `--no-oracle` figure (anyparse: 1.05s -> 5.1s, flat, and only when a whole-scope check runs) — that is what buys a narrow lint the same reflection surface a project-wide one has, and without it `lint <one-file> --fix` will erase a name some sibling file spells to `Reflect`. NEVER pass it to a gate (battery, pre-commit, anything whose output is a verdict) — declining a gate can only weaken one. **lint --list-rules** prints every check as id+description — THE authoritative list of REGISTERED rules, not of what runs here: it never reads `apqlint.json`, so a config-disabled rule still prints, and every opt-in (default OFF) rule, `explicit-local-type` among dozens, prints while firing only under `--rule` or a config that enables it. **`lint --list-rules <files…>`** prints what DOES run: each rule `on`/`off` + reason per distinct `apqlint.json` chain — subtract a checklist by that, never by the bare registry. **`--rule <id>` on an actual run also force-enables a rule the config disables — a `--rule` count can diverge sharply from the unfiltered gate; see references/lint.md.** Inline suppression: trailing `// noqa` or `// noqa: rule1, rule2` — those two spellings ONLY; a bracketed `// noqa[rule]` parses as NO directive and silently suppresses nothing — or CHECKSTYLE:OFF/ON region. --fix has a HUGE blast radius — scope to a file and/or --rule; looping --fix to a fixpoint without a typecheck between passes compounds cascade deletions. Full semantics: BEFORE relying on lint verdicts or configuring apqlint.json → Read references/lint.md) |
| Every occurrence of name X (incl. case-patterns) | `mentions X <dir>` |
| Who does function F call (direct/transitive) | `callees 'Type.method' <scope> [--depth N] [--kinds call,ref,new,virtual,contains]` (approximate call graph: name + declared-type resolution, `Null<T>` unwrapped, a receiver that is itself a CALL resolved through the callee's DECLARED return type, virtual edges to overrides — a BARE call to a non-static member of the enclosing type is an implicit-`this` call and gets them too, `Ref` edges for lambdas/method-values/`.bind` with the receiving call as `via`; out-of-scope targets `[external]`; unresolved sites counted to stderr; builds graph over the whole scope — ~25s on TM-sized 800 files) |
| Who calls function F (direct/transitive) | `callers 'Type.method' <scope> [--depth N]` (same graph, in-edges) |
| Is B reachable from A + through which chain | `reach --from 'A.m' --to 'B.n' <scope> [--to …] [--max-paths N]` (`--to` repeatable, `Type.*` patterns; BFS shortest path per pair; default kinds call,ref,new,virtual) |
| Along which lines does a god-type split (decomposition recon) | `clusters <TypeName> <scope> [--hubs N]` — connected components over aggregated intra-type call edges after top-fan-in hubs go to a utils bucket (`--hubs 0` = off, default auto — conservative: cap 10% of members; crank `--hubs` manually to dissolve a persistent blob); lambdas/local fns condense into their member; per-component `-> hubs`/`<- hubs` traffic = the future module interface; `<- hubs` ≠ 0 flags a dispatcher wrongly bucketed as a utility. ⚠️ SCOPE = the type's own package dir, NOT whole src/ — the graph builds over every file in scope; whole-project scope is ~25× slower (minutes of CPU, kills a subagent's stream watchdog) and only adds unresolved-call noise |
| Main-thread stall candidates (blocking call on main / lock held across blocking call) | `lint <scope> --rule thread-safety` — config-driven via `apqlint.json` (`sinks` required, `spawns`/`marshals`/`lockPairs` optional; inert without config — projects using this rule keep `apqlint.json` in the repo root) |
| ONLY switch case-patterns `case Foo:` / `case Foo(_):` | `cases Foo <dir>` |
| Decls carrying `@:meta` | `meta @:meta <dir>` |
| Match expression / statement shape with metavars | `search 'pattern with $x' <dir>` |
| Find string-literal / annotation key | `lit '<text>' <dir>` |
| Find text in comments / TODO / doc-comment | `lit '<text>' <dir> --include-comments` or `--kind Comment` |
| Find text in `#if`/`#elseif` directive lines (condition text is NOT a node — plain lit/search can't see it) | `lit '<text>' <dir> --include-directives` or `--kind Directive` |
| **Branch BODIES of every `#if` region mentioning a define** (what runs under a flag) | `cond <DEFINE> <scope> [--active\|--inactive] [--names] [--max-body N]` |
| **Retire a define — fold every `#if` region it decides, keep the live branch** (WRITE-twin of `cond`) | `resolve-define <DEFINE> <scope> [--undefined] [--write] [--list] [--reformat]` |
| Subtree at line:col / by selector | `ast file.hx --at L:C` / `--select Kind:name` |
| Filter `--select` by arity | `--min-children N` / `--max-children N` |
| Cap rendered child count per level | `--depth N --children-limit M` |
| Sweep snapshot read + Δ vs prior | `sweep [--prev <path>]` |
| Save sweep baseline | `sweep --save <path>` |
| Pre/post-slice diff (auto-rotated prev) | `sweep --diff` |
| Parse utest stdout into counts | `test-summary [<file> \| -]` |
| Inline-source AST/writer probe (no /tmp) | `probe '<code>' [ast-options]` / `probe -` (stdin) |
| Parse + format-write (trivia / plain) | `ast file.hx --writer-output` / `--writer-output-plain` |
| Side-by-side trivia + plain writer | `writer-probe file.hx` / `probe '<code>' --writer-probe` |
| Byte-equality check on writer output | `writer-equals <input> <expected.txt>` (`--plain` opt) |
| Writer-bug AST diff (input ↔ output) | `ast file.hx --writer-output --diff` |
| Structural AST diff between files | `diff a.hx b.hx` (`--flat`, `--limit N`) |
| Sed-strip + parse-check | `strip file.hx --replace <p> --with <r>` / `--delete <p>` |
| Typo guard for strip patterns | `strip … --dry-run` |
| Skip-parse drill — corpus sweep + histogram | `recon [<dir>]` (default `$ANYPARSE_HXFORMAT_FORK/test/testcases`) |
| Single-file PARSE OK/FAIL probe | `recon --probe <file>` |
| **Post-PARSE-OK byte-compare** (after parser-additive slice) | `recon --probe <file> --writer-equals` |
| Cluster drill (paths in ONE bucket) | `recon --cluster '<key>'` (`--source` for windowed src) |
| Upper-bound predict: would strip unblock? | `recon --predict-strip --replace <p> --with <r>` (combine with `--cluster`) |
| Gate-relaxation predict (insert expected token) | `recon --predict-relax` |
| NO TARGET bucket drill | `recon --predict-relax --no-target-cluster '<expected-msg>'` |
| Find every fixture matching a regex | `recon --candidates '<regex>'` |
| Apply strip across a cluster | `strip --from-cluster '<key>' --replace <p> --with <r>` |
| Multi-pattern isolation diagnostic | `strip <file> --replace … --replace … --per-pattern` |
| Which predicate gates a ctor's `;` elision | `gates [<dir>]` |
| Gate-mechanism candidate lists | `gates --mechanism mandatory-ref-lead-trail` (and other mechanisms) |
| **Which `.hx` files plugin can't parse** | `self-status [<dir>]` (`--strict` exits non-zero on any skip-parse) |
| Sanity-check direct-child count at root | `ast file.hx --count` / `probe '<code>' --count` |
| **View file lines** (no parse; any/skip-parse file; Edit-anchorable) — **dedented by the window's MINIMUM indentation**, so it shows raw columns only when the window includes a column-0 line | `source <file> [--range L:L2]` |
| **Read ONE node's raw source BY NAME / position** (clean text, dedented, no S-expr) — and a file over 120 lines read with NO `--range`/`--select`/`--at` is REFUSED with a menu of top-level selectors on stderr (exit 2); pass `--all` for the whole file, or `HXQ_SOURCE_MAX_LINES=0` to disable the guard. The budget counts LINES, not Haxe: a long `.md`/`.json`/log is refused the same way. | `source <file> --select 'FnMember:<name>'` (or `ClassDecl:<Name>` etc.; must match one) / `source <file> --at <l>:<c>` |
| Decls carrying `@:tag(arg)` (exact arg, NOT substring) | `meta '@:tag(arg)' <dir>` |
**A 0-hit `callers` is not proof of absence — and it now SAYS so.** With no edge resolved and unresolved sites in scope, the note reads `no callers resolved, but N call site(s) in scope are unresolved — this is NOT proof "X" has none`, and `--exit-on-empty` exits non-zero; with edges shown it stays the plain approximate-graph note. Read that distinction rather than the raw count, and note the graph resolves receivers by NAME, not by a typer: an un-annotated local, a `using` extension, a `Null<T>`/`Dynamic` return, a `new T().m()` receiver all leave the site unresolved and therefore silent. Before turning a thin `callers` result into "only tests call this" / "dead code", cross-check with `hxq mentions <name> <dir>`, and for a member that may be inherited or overridden also query the SUPERTYPE's declaration (`hxq refs <name> <dir> --decls` lists every declaration of the name — an `abstract` one has no body, so it terminates a chain even though it IS the call target).

**Changing the graph? `lint --rule thread-safety` over a big real tree is the only WHOLE-TREE oracle** — there is no edge dump, and per-target `callers` runs cost ~1.4s each. That check consumes the same graph, so a before/after diff of its findings reflects the whole edge set. Two things to expect when reading that diff: findings gain or lose the `(also reachable from a background thread)` annotation as reachability changes (compare findings by `file:line` + sink, NOT by full message — the message embeds a chain that re-renders), and **ADDING edges can REMOVE findings**, because a node with no resolved callers is ASSUMED main; supply its real caller and a stale "main thread reaches" claim correctly disappears. A disappearing finding is still the direction to verify first — confirm the newly-revealed caller really is background before accepting it.

**Confusion-buster:** `refs` = VALUE bindings, `uses` = TYPE positions, `search` = AST SHAPES, `lit` = CAPTURED STRING CONTENT in leaves. They are not interchangeable. **Neither `refs` nor `uses` catches `expr.field` on a value of type T** — use `blast <Type>` (union + heuristic field-access; `--all` to disable smart 20-hit cap on heuristic section).

**`refs` is blind to EVERY member access, including a QUALIFIED STATIC.** `Type.f()` looks like it must resolve — the receiver is a type name, no inference needed — but the name sits on a field-access node, not an identifier, so `refs f` shows only the declaration. Same for `obj?.f()` / `obj!.f()`, the forms strict null-safety pushes you toward. This is by design (`refs` feeds `rename`, which must not drag `obj.f` along when renaming a local `f`), and `refs` now warns on stderr with a count when it resolved no read/write but the scope holds accesses. **Never turn a bare `refs` result into "unused" / "only one caller" / "safe to delete" for a member or static — confirm with `hxq mentions <name> <dir>` first.** Sibling of the `#if`-blindness rule below: a 0-hit structural query is not proof of absence.

**A DOTTED PATH is ONE leaf, so a simple-name query never sees it — `mentions` included.** `import unit.FooTest;` projects as a single `ImportDecl` carrying the whole `unit.FooTest` string, so `hxq mentions FooTest <file>` reports the `new FooTest()` call and NOT the import that makes it resolve — "no import found" is the query's blind spot, not the file's state. The same leaf shape used to hide a qualified sub-module type reference `Mod.SubType` from `uses` — FIXED 2026-09-06: a simple `<type-name>` now also answers a qualified spelling of the same LAST SEGMENT (`Mod.T`, `pkg.Mod.T`) in `uses` and in the `uses` section of `mentions`/`blast`, each hit printing the path it found; a dotted query stays an exact compare, and the widening is opt-in at the API so `rename` still splices last segments through its own arithmetic. `refs`/`lit` are unchanged, so the IMPORT half of this rule stands. Ask for the path you expect to see: `hxq lit 'unit.FooTest' <file>` (or `lit 'Mod.SubType'`). Reach for this the moment a registration/import audit comes back empty — the wrong conclusion there is a build error one command later.

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

Six SILENT hazards that must never wait for the reference read:
- **`replace-node`'s span covers the WHOLE declaration INCLUDING its leading modifiers**,
  so `<newSource>` that omits them silently drops them. Replacing a member with
  `function f(): T { … }` instead of `public function f(): T { … }` reports `wrote <file>`
  and leaves the member private. The op does not complain; the next build does, with an
  error that names a DIFFERENT problem — an interface-conformance failure at the type, or
  an access error at some caller — so the modifier is the last place you look. Always spell
  the modifiers verbatim (`private static function walk(…)`), and prefer `patch` when the
  change is a few lines inside a bigger body. (Modifier FLIPS are `set-modifier`'s job, and
  a whole-type `replace-node --select 'ClassDecl:X'`/`ClassForm:X` is separately documented
  as unreliable — its span excludes the leading `final` keyword, so a replacement copied
  from `source --select` duplicates it and the op refuses with a confusing parse error.)
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
  rest of this paragraph still holds for every other insertion spelling. **FIXED (2026-09-01, `907299b8`) — `add-element` no longer lands inside a
  doc/declaration pair.** It used to: a leading doc is trivia BEFORE X's node span, so
  `--before --select '<Kind>:X'` inserted at `span.from` and slid in between X's doc and X,
  silently transferring the doc to the inserted declaration. Both offsets now go through
  `RefactorSupport.docExtendedSpan` (`span.from` for `--before`, a zero-width probe at
  `span.to` for `--after`), so the insert clears the doc on either side. Two things you can
  still rely on: `set-doc` on a declaration you did not just create still collapses a doc
  RUN into the one block you pass, and the doc-splitting edit is now REFUSED at the shared
  seam (`RefactorSupport.docSplittingEdit`, called from `canonicalize`) — which covers the
  17 addressed ops, both `lint --fix` paths, AND `ExtractInterface` / `ExtractSuperclass` /
  `IntroduceParameterObject` (they reach it through `RefactorSupport.editKeepingCanonical`;
  `NewFile` has no edit list). Only `MoveMember`, `MoveSymbol` and `InheritanceMove`
  (`pull-up`/`push-down`) splice with `applyEdits` and never arrive — and MEASURED
  (S51, `12988dbf`, 13-cell census with doc'd neighbours above and below at member and
  module level) that does not matter: every insertion the move/extract family makes lands
  at a member list's end, at EOF, in a type header, or above a first declaration's trivia,
  so none is the doc-splitting shape; the moved member's own doc TRAVELS with it in every
  cell, never orphans onto the next member, never vanishes. One caveat stays advisory
  (T403): `editKeepingCanonical` falls back to a plain `applyEdits` on a NON-canonical
  source, so on a drifted file the three extract ops lose the refusal — canonicalise first.
  **Why the module level bit and the member level did not** (the asymmetry behind the old
  trap, worth knowing because other span arithmetic shares it): module-level declaration
  spans are GREEDY — `TypedefDecl A @73-149` and `TypedefDecl B @149-219` are contiguous,
  so A's span swallows B's leading doc — while type-member spans are tight, ending before
  the next member's modifier group. That is why `--after` overshot at module level only.
  Verified fixed on 2026-09-01 with both probes: `--before --select 'FnMember:m1'` lands
  ABOVE m1's doc, and `--after --select 'TypedefDecl:A'` lands BEFORE B's doc.
- **A TYPE-LEVEL doc comment is trivia BEFORE the node's own span — `patch` cannot reach
  it.** A declaration's leading `/** */` sits outside the type's node, so every address
  mode reports absence: `--select 'ClassDecl:X'` → `apq patch: the old fragment does not
  occur in the resolved ClassForm node`; `--at <line-inside-the-doc>` → `apq patch:
  position L:C is not on a node`; `--at <line-of-a-@:meta-above-the-class>` resolves the
  `FinalDecl` and still reports the fragment absent. The op that DOES reach it is `hxq
  comment-rewrite '<find>' '<replace>' <f> --write` — a LITERAL `<find>` is matched
  against the normalized body (each line break, plus the ` * ` continuation after it,
  collapsed to one space) and the find is normalized the SAME way since 2026-08-20, so a
  multi-line find works written either with those prefixes or with bare newlines; a
  `--regex` find is matched against the RAW body instead and needs `\s+\*\s+` to cross a
  line. A multi-line `<replace>` gets the block's own continuation on every line it adds,
  so write PLAIN lines with real newlines (a shell `$'first line\nsecond line'` literal)
  and a ` * ` you add yourself is stripped, not doubled; long lines are reflowed into the
  configured width (see the `comment-rewrite` bullet below). A find that
  matches nothing now SAYS so on stderr — "rewrote 0 file(s)" alone used to be the only
  signal, and it reads as "the text was already right". `set-doc` also reaches a type doc but
  replaces the WHOLE block — prefer `comment-rewrite` for a one-sentence correction inside
  a longer doc, `set-doc` only when replacing the entire thing.
- **A TYPE's own doc block is outside its node; a MEMBER's doc is inside the type's.** So
  `patch --select 'ClassDecl:T'` reaches every member doc of `T` as an ordinary fragment,
  but its own leading doc is not in the resolved text and the call fails with "the old
  fragment does not occur in the resolved node". Correcting a type doc therefore goes
  through `comment-rewrite` (one sentence) or `set-doc` (the whole block) — reaching for
  `patch` first and then retyping the entire doc into `set-doc` is the avoidable cost here.
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

## hxq self-development — references/parser-dev.md

WHEN working on hxq ITSELF (writer bugs, grammar-plugin slices, parser corpus sweeps, .hxtest fixtures, predictors) → Read references/parser-dev.md. Everyday querying/refactoring of project code never needs it.

Recipes there:
- Byte-span annotation (same-span duplicate debug)
- Writer iteration loop (`--writer-output` / `writer-probe`)
- Writer-bug AST diff (input ↔ output)
- Byte-equality check on writer output (`writer-equals`)
- Structural AST diff between two files (`diff`)
- Strip + parse-check (`strip`, sole-blocker confirmation)
- Strip dry-run (typo guard)
- .hxtest fixture handling
- Sweep snapshot (`sweep`)
- Test-summary (utest stdout → counts)
- Recon skip-parse drill harness
- Upper-bound predictor (`--predict-strip`)
- Terminator-insertion predictor (`--predict-relax`)
- Regression probe
- Construct enumeration via regex (`--candidates`)
- Permissive-construct predictor
- Post-parser-additive-slice byte-PASS check (+ predict-mutex note)
- Grammar-plugin parse-coverage status (`self-status`)
- Gates (`;`-elision predicates, mechanism inventories)
- Parser-dev reflexes (post-slice byte-PASS, pre-edit predict-strip, `sweep --diff`)

## File-level create / format ops (`new` / `fmt`)

Create-side + whole-file counterparts of the node-level writer-emit ops. **Raw `Write` of a `.hx` is NOT canonical** (it emits whatever bytes you typed) and may not parse — so a new file goes through `hxq new`, and any drift is fixed by `hxq fmt`. Both run via the `hxq` CLI (a Bash command, not the Edit/Write tools), so they bypass the Edit-gate/warn hooks and emit canonical+validated by construction.

| Op | What | Safety boundary |
|---|---|---|
| `hxq new <path> (--kind class\|interface\|enum\|typedef\|abstract \| --implements <iface> \| --raw -) [--extends <T>]... [--open] [--underlying <T>] [--from <T>]... [--to <T>]... [--field <m>]... [--bodies -] [--write]` | CREATE a new module deterministically — parses-or-rejects + byte-canonical + atomic (the writer round-trip IS the validator). | `--kind` (default `class`) picks class / interface / enum / typedef / abstract (`--class` = shorthand for `--kind class`). Package + name derived from `<path>` (under a `src/`/`test/` root). `--implements` (class only) slices each interface method signature exactly (`[FnMember, NoBody)` drops the `;`) and CARRIES the imports the signatures need — the iface file's own imports verbatim + an import per sibling sub-module type (e.g. `Violation` next to `Check`) + the iface itself when cross-package — so the result TYPE-CHECKS, not just parses. `--extends <T>` adds a superclass (class, ≤1), super-interfaces (interface, repeatable), or struct extensions (typedef → `{ > Base, … }`, repeatable); only `enum` / `abstract` reject it. A qualified `pkg.T` is imported, a simple name is assumed same-package. `--kind abstract` needs `--underlying <T>` (+ optional `--from <T>` / `--to <T>`, repeatable), each imported when qualified → `abstract N(U) from .. to ..`. `--open` emits a non-final class (default `final`). Auto-emits `public function new() {}` ONLY for a class with NO `extends` and no caller ctor (a subclass inherits its super's ctor — auto-emitting would skip a parameterised `super(...)`). **Create-only** (refuses an existing path; modify via the ops / `fmt`). `--bodies -` reads `@@ <method>` sections from stdin; reserved `@@ imports` (one entry per line: a bare module path like `haxe.ds.StringMap` OR a whole `import …;` / `using …;` statement — both accepted since `e8ec6cc1`; anything else is refused BY NAME before assembly), `@@ doc` (the type doc-comment), and `@@ members` (a free-form member block — works for ANY kind, and adds helpers alongside `--implements` stubs without the "names no method" Err); an unfilled interface method → a `NotImplementedException` stub (reported); a section naming an unknown method, or an unparseable body, → non-zero exit, **nothing written**. `--field` = verbatim member text (repeatable). `NewFile.create` is pure. **`--raw -`** bypasses the spec — stdin = the COMPLETE file → `writeRoundTrip` (parse-or-Err, canonicalise) → atomic write (`NewFile.createRaw`), the validated equivalent of a raw Write for files no `--kind` shape covers (multi-type / free-form). |
| `hxq fmt <file/dir/glob>... [--write] [--list]` | Canonicalise via the writer round-trip (gofmt-style) — the create-finisher AND the canonical-gate's measuring stick (`writeRoundTrip(s) == s`). | `--write` rewrites in place; `--list`/`-l` prints drifted paths (no rewrite); a single concrete file with no flags → formatted source to stdout; multiple files / a dir without `--write` → `--list` implied. Per-file `hxformat.json` discovered. Idempotent. A parse failure is reported + skipped; exit non-zero if any file failed. |

**Creating a new `.hx`: use `hxq new`, not Write.** For shapes `hxq new` doesn't cover (enums, interfaces, typedefs, multi-type modules, test classes with methods), raw `Write` is still the path — but a **PostToolUse warn hook** (`apq-canon-warn.sh`, personal/gitignored, sibling of the edit-gate) then nudges if the result isn't canonical/parseable; run `hxq fmt <file> --write` to fix. **The original false belief that started this: "a new file via Write is immediately canonical" — it is NOT.** Determinism comes from the writer round-trip (`new`/`fmt`), never from the way bytes were written.

**Never `rm` an existing `.hx` then `hxq new --raw -` to EDIT it.** `new` is create-only by design (refuses an existing path); deleting the file first to bypass that refusal is a wholesale-rewrite hack — it risks faithful-reproduction errors and discards the ops' scope-correct/format-preserving guarantees. To edit a parseable `.hx`, always use the surgical ops (`replace-node`/`add-member`/`add-import`/`set-modifier`/`remove-member`/`remove-element`); reserve `new`/`new --raw` for files that do not yet exist.

## Common confusions — index (full text: `references/confusions.md`)

One line per confusion; open `references/confusions.md` at the matching lead when a query
misbehaves the way a line describes. **Before ANY fallback to grep / Read / `git show` on a
`.hx`, scan this index first** — "hxq can't do this" is almost always one of these lines, and
the fix is a different subcommand or flag, never a bypass.

- `probe`/`ast --depth N` SILENTLY TRUNCATES below N — never conclude a node LACKS a child from a depth-limited dump.
- `search --kind K` finds a node of that kind ANYWHERE, including nested inside a member — the hit line cannot tell you which.
- 0 hits on `search` — almost always a kind mismatch.
- `search` pattern BOOL LITERALS match by KIND, not VALUE — `false == true` matches `true == true` (the operator `==` vs `!=` IS discriminated; the literal's text is not).
- A string literal's CONTENT lives in a different slot depending on the QUOTE, and neither spelling is decoded.
- "Find string `'foo.bar'`" — that's `lit`, not `search`.
- "Find annotation `@:trailOpt`" — `hxq lit '@:trailOpt' src/ --kind Literal,Meta`.
- `search 'function foo'` returns no decls — `search` is expressions/statements (call sites), not declarations.
- TODO/comment text — `hxq lit 'TODO' src/ --include-comments`.
- `refs`/`uses`/`blast`/`mentions` all return 0 but you know the name appears
- Want `| head -N` — every walker has `--limit N`; walkers also auto-cap at 500 hits without `--limit`.
- Sweeping an op over EVERY declaration of a kind — (a census: how often does this op fire, how often does it refuse and why) — you do not need names or positions.
- Script-checking "is X gone?" — pass `--exit-on-empty` (alias `--require-match`) to a find-walker (refs/uses/meta/lit/cases/blast/mentions/search), to `reach`…
- Output flood (e.g. `lit '/*' src/ --any-kind`) — per-hit content is auto-truncated and hits auto-cap at 500; opt out with a large `--limit N`, never `--limit 0`.
- `#if`…`#end` interiors ARE parsed and visible to walkers/lint — a 0-hit `refs` still means unused.
- "What runs under flag X" is `hxq cond X <scope>`, not `lit --include-directives` plus guesswork.
- A token the parser folds into TRIVIA is invisible to BOTH lint and `fmt --list` — "0 findings + canonical" is not proof it isn't there.
- Raw-text search across many `.hx` has no batch reader — `hxq source` is one file per call and `strip` takes neither a directory nor a glob (`EISDIR` / `ENOENT`).
- Several queries in ONE walk — a bare `--`. — `hxq refs A B C -- src --decls` (also `mentions`, `lit`, `declares`) parses the tree once and prints a `=== <query> ===` section…
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
- `clusters` output columns do NOT discriminate static from instance members.

## Report on hxq gaps

If a structural query forced a fallback to grep/Read because hxq couldn't handle it (parse-fail, missing capability), tell the user at the end of the task — hxq's readiness gets tracked that way.
