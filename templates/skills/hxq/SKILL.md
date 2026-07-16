---
name: hxq
description: When and how to use hxq for structural Haxe navigation
---

# hxq — structural Haxe query CLI

`hxq <subcommand> [opts] <file-or-dir-or-glob>...` parses `.hx` files with anyparse's own parser. Invoke as bare `hxq` (on PATH) — never `./bin/hxq`. Auto-adds `--lang haxe`.

> **ONE command for EVERYTHING — `hxq`.** `hxq` runs BOTH the read/query subcommands AND the write/mutation ops below (it forwards every subcommand to the engine). **`apq` is a documentation label, NOT an installed command** — wherever this skill writes `apq <op>`, RUN it as `hxq <op>`. **Never `node bin/apq.js`** (bypasses the shim and needs cwd=project). **Never `cd`** — `hxq` is on PATH and cwd-independent; pass project-relative paths (default cwd = project root) or absolute paths, and use `hxq probe '<code>'` for throwaway snippets instead of `/tmp` scratch files. (USER decision; root cause = the `apq`/`hxq` dual-naming where only `hxq` is installed.)

**Path arguments: prefer relative.** `hxq` respects CWD; relative paths give shorter hit lines (`<file>:line:col`) than absolute. Use absolute only for files outside the current project.

**Works on ANY `.hx`, including EXTERNAL forks / other repos.** hxq parses by the anyparse grammar regardless of which project a file lives in — `refs`/`uses`/`ast`/`search`/`source` all work cross-project (e.g. querying a `haxe-formatter` fork for ground-truth). Pass the absolute path. Do NOT grep / `node -e readFileSync` / `git show` a fork `.hx` — that is the recurring "костыль" reflex. Query it structurally (`refs`/`ast`) or read raw lines with `hxq source` (gate-blessed, below). Most fork files parse; only the few that genuinely skip-parse need `hxq source` (which reads raw bytes regardless of parse status).

**Output: grouped-by-file by default.** Walkers print `<file>:` once then 2-space-indented `<line>:<col>: <hit>` lines. Pass `--flat` for legacy `<file>:<line>:<col>: <hit>` per line (downstream tools).

## Build / auto-rebuild

`haxe bin/apq-js.hxml` builds the JS runner. **The `hxq` shim AUTO-REBUILDS by default** when `find -newer` detects stale `.hx` under `src/`; aborts on build failure. Opt-out:
- `HXQ_AUTO_REBUILD=0` — legacy warn-once-per-mtime mode (cache at `$XDG_CACHE_HOME/hxq/warned`).
- `HXQ_QUIET=1` — skip stale check entirely. Takes precedence.
  ⚠️ NEVER use it for a VERIFICATION probe right after src/ edits — it runs the STALE binary and can "refute" a fix that actually landed (or "confirm" one that didn't). Verification probes need an explicit `haxe bin/apq-js.hxml` first, or a bare `hxq` call (auto-rebuild on).

**Rebuild matrix — `apq.js` and `test.js` are SEPARATE binaries.** `haxe bin/apq-js.hxml` builds `apq.js`; `haxe test-js.hxml` builds `test.js`. Edits to macro-driven src (`WriterLowering`/`ShapeBuilder`/`Codegen`/`Build`/`Lowering`/`TriviaTypeSynth`…) require rebuilding BOTH before trusting results: a stale `apq.js` makes probes/ops lie, a stale `test.js` makes the sweep lie. Quick staleness check: `grep -c <newSymbol> bin/apq.js`.

**Worktree nuance:** the shim keys off `git rev-parse --show-toplevel` — run `hxq` with CWD *inside* the worktree AND build the worktree's engine, else it silently falls back to the main-tree baseline binary.

## Addressing (v2) — how to point ops at code. READ FIRST

**Default = named/pattern addresses, NOT positions.** Every mutation op accepts one of:

| Form | Meaning |
|---|---|
| `--select '<sel>'` | Selector path: `Kind`, `Kind:name`, `A > B` (direct child), **`A >> B` (any-depth descendant)**. Must resolve to exactly ONE node. |
| `--match '<pattern>'` | `hxq search` structural pattern (`$x` metavars) — the matched node is the target. Exactly-one discipline like `--select`. |
| `--nth <k>` | Pick the k-th (1-based, document order) of several `--select`/`--match` matches. The ambiguity error lists candidates with positions — copy the ordinal from there. |
| `<line>[:<col>]` | 1-based position, FALLBACK only. **Column is optional — a bare line number snaps to the line's first non-whitespace char** (take it straight from lint/compiler output). |

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

**Anti-reflex (READ THIS): a tool that SEEMS not to work = assume you're using it wrong, not that it's broken.** Bypass tokens are LAST RESORT — reach for them ONLY after CONFIRMING the target genuinely skip-parses (`recon --probe <file>` / `self-status`). Never `node -e readFileSync` / `git show` / grep a `.hx` reflexively: `hxq source <file> --range L:L2` reads raw verbatim lines of ANY `.hx` (project or fork, parseable or skip-parse) and is gate-blessed. Verify a claimed tool-limitation with one command before acting on it; never propagate "tool X can't do Y" (yours or a sub-agent's) without checking.

**Reading a specific NAMED function / decl → `hxq source <f> --select 'FnMember:<name>'`** (or `--select 'ClassDecl:<Name>'`, or `--at <l>:<c>`). It prints exactly that node's raw source — full lines, dedented, flush-left, in ONE step, gate-blessed. Do **NOT**: (a) use the **`Read` tool** on a `.hx` — it can fabricate content past the first lines AND neither gate blocks it (the gates match `Bash|Grep` / `Edit|Write`, not `Read`), so the discipline there rests entirely on you; (b) `refs --decls` then `source --range` — that's the two-step path the `--select` form collapses; (c) `ast --select … --source` when you only want the TEXT — it prepends the whole S-expr tree (the source slice is appended after, indented). Use `ast --select --source` only when you actually want AST + source together.

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
| Run analysis checks + report violations (grouped-by-file) | `lint <scope> [--rule <id>]… [--fix] [--all] [--flat] [--fail-on <sev>] [--format text\|json\|checkstyle]` (analysis/check layer; **lint --list-rules** prints every check as id+description — THE authoritative list. Inline suppression: trailing // noqa[: rules] or CHECKSTYLE:OFF/ON region. --fix has a HUGE blast radius — scope to a file and/or --rule. Full semantics: BEFORE relying on lint verdicts or configuring apqlint.json → Read references/lint.md) |
| Every occurrence of name X (incl. case-patterns) | `mentions X <dir>` |
| Who does function F call (direct/transitive) | `callees 'Type.method' <scope> [--depth N] [--kinds call,ref,new,virtual,contains]` (approximate call graph: name + declared-type resolution, `Null<T>` unwrapped, virtual edges to overrides, `Ref` edges for lambdas/method-values/`.bind` with the receiving call as `via`; out-of-scope targets `[external]`; unresolved sites counted to stderr; builds graph over the whole scope — ~25s on TM-sized 800 files) |
| Who calls function F (direct/transitive) | `callers 'Type.method' <scope> [--depth N]` (same graph, in-edges) |
| Is B reachable from A + through which chain | `reach --from 'A.m' --to 'B.n' <scope> [--to …] [--max-paths N]` (`--to` repeatable, `Type.*` patterns; BFS shortest path per pair; default kinds call,ref,new,virtual) |
| Along which lines does a god-type split (decomposition recon) | `clusters <TypeName> <scope> [--hubs N]` — connected components over aggregated intra-type call edges after top-fan-in hubs go to a utils bucket (`--hubs 0` = off, default auto — conservative: cap 10% of members; crank `--hubs` manually to dissolve a persistent blob); lambdas/local fns condense into their member; per-component `-> hubs`/`<- hubs` traffic = the future module interface; `<- hubs` ≠ 0 flags a dispatcher wrongly bucketed as a utility |
| Main-thread stall candidates (blocking call on main / lock held across blocking call) | `lint <scope> --rule thread-safety` — config-driven via `apqlint.json` (`sinks` required, `spawns`/`marshals`/`lockPairs` optional; inert without config). TM has the config in repo root |
| ONLY switch case-patterns `case Foo:` / `case Foo(_):` | `cases Foo <dir>` |
| Decls carrying `@:meta` | `meta @:meta <dir>` |
| Match expression / statement shape with metavars | `search 'pattern with $x' <dir>` |
| Find string-literal / annotation key | `lit '<text>' <dir>` |
| Find text in comments / TODO / doc-comment | `lit '<text>' <dir> --include-comments` or `--kind Comment` |
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
| **View RAW verbatim file lines** (no parse; any/skip-parse file; Edit-anchorable) | `source <file> [--range L:L2]` |
| **Read ONE node's raw source BY NAME / position** (clean text, dedented, no S-expr) | `source <file> --select 'FnMember:<name>'` (or `ClassDecl:<Name>` etc.; must match one) / `source <file> --at <l>:<c>` |
| Decls carrying `@:tag(arg)` (exact arg, NOT substring) | `meta '@:tag(arg)' <dir>` |

**Confusion-buster:** `refs` = VALUE bindings, `uses` = TYPE positions, `search` = AST SHAPES, `lit` = CAPTURED STRING CONTENT in leaves. They are not interchangeable. **Neither `refs` nor `uses` catches `expr.field` on a value of type T** — use `blast <Type>` (union + heuristic field-access; `--all` to disable smart 20-hit cap on heuristic section).

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
comment-rewrite · patch · extract-method.

Three SILENT hazards that must never wait for the reference read:
- Every mutation op is PRINT-ONLY without `--write` — a forgotten --write
  looks like success (stdout echoes the result) but changes nothing.
- On parseable project .hx: EDIT via ops, CREATE via `hxq new` — never
  Edit/Write (a gate hook denies them); `hxq patch` (old ==== new via
  heredoc) is the DEFAULT small-edit op.
- `replace-node --at <pos> --kind <K>` can grab a CO-STARTING ENCLOSING
  node of the same kind and silently swallow surrounding code — prefer
  `--select` / `--match --kind`; if you must use --at, probe `ast --at`
  first.

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
| `hxq new <path> (--kind class\|interface\|enum\|typedef\|abstract \| --implements <iface> \| --raw -) [--extends <T>]... [--open] [--underlying <T>] [--from <T>]... [--to <T>]... [--field <m>]... [--bodies -] [--write]` | CREATE a new module deterministically — parses-or-rejects + byte-canonical + atomic (the writer round-trip IS the validator). | `--kind` (default `class`) picks class / interface / enum / typedef / abstract (`--class` = shorthand for `--kind class`). Package + name derived from `<path>` (under a `src/`/`test/` root). `--implements` (class only) slices each interface method signature exactly (`[FnMember, NoBody)` drops the `;`) and CARRIES the imports the signatures need — the iface file's own imports verbatim + an import per sibling sub-module type (e.g. `Violation` next to `Check`) + the iface itself when cross-package — so the result TYPE-CHECKS, not just parses. `--extends <T>` adds a superclass (class, ≤1), super-interfaces (interface, repeatable), or struct extensions (typedef → `{ > Base, … }`, repeatable); only `enum` / `abstract` reject it. A qualified `pkg.T` is imported, a simple name is assumed same-package. `--kind abstract` needs `--underlying <T>` (+ optional `--from <T>` / `--to <T>`, repeatable), each imported when qualified → `abstract N(U) from .. to ..`. `--open` emits a non-final class (default `final`). Auto-emits `public function new() {}` ONLY for a class with NO `extends` and no caller ctor (a subclass inherits its super's ctor — auto-emitting would skip a parameterised `super(...)`). **Create-only** (refuses an existing path; modify via the ops / `fmt`). `--bodies -` reads `@@ <method>` sections from stdin; reserved `@@ imports` (one import per line), `@@ doc` (the type doc-comment), and `@@ members` (a free-form member block — works for ANY kind, and adds helpers alongside `--implements` stubs without the "names no method" Err); an unfilled interface method → a `NotImplementedException` stub (reported); a section naming an unknown method, or an unparseable body, → non-zero exit, **nothing written**. `--field` = verbatim member text (repeatable). `NewFile.create` is pure. **`--raw -`** bypasses the spec — stdin = the COMPLETE file → `writeRoundTrip` (parse-or-Err, canonicalise) → atomic write (`NewFile.createRaw`), the validated equivalent of a raw Write for files no `--kind` shape covers (multi-type / free-form). |
| `hxq fmt <file/dir/glob>... [--write] [--list]` | Canonicalise via the writer round-trip (gofmt-style) — the create-finisher AND the canonical-gate's measuring stick (`writeRoundTrip(s) == s`). | `--write` rewrites in place; `--list`/`-l` prints drifted paths (no rewrite); a single concrete file with no flags → formatted source to stdout; multiple files / a dir without `--write` → `--list` implied. Per-file `hxformat.json` discovered. Idempotent. A parse failure is reported + skipped; exit non-zero if any file failed. |

**Creating a new `.hx`: use `hxq new`, not Write.** For shapes `hxq new` doesn't cover (enums, interfaces, typedefs, multi-type modules, test classes with methods), raw `Write` is still the path — but a **PostToolUse warn hook** (`apq-canon-warn.sh`, personal/gitignored, sibling of the edit-gate) then nudges if the result isn't canonical/parseable; run `hxq fmt <file> --write` to fix. **The original false belief that started this: "a new file via Write is immediately canonical" — it is NOT.** Determinism comes from the writer round-trip (`new`/`fmt`), never from the way bytes were written.

**Never `rm` an existing `.hx` then `hxq new --raw -` to EDIT it.** `new` is create-only by design (refuses an existing path); deleting the file first to bypass that refusal is a wholesale-rewrite hack — it risks faithful-reproduction errors and discards the ops' scope-correct/format-preserving guarantees. To edit a parseable `.hx`, always use the surgical ops (`replace-node`/`add-member`/`add-import`/`set-modifier`/`remove-member`/`remove-element`); reserve `new`/`new --raw` for files that do not yet exist.

## Common confusions

- **`probe`/`ast --depth N` SILENTLY TRUNCATES below N — never conclude a node LACKS a child from a depth-limited dump.** A `--depth 5` probe of `abstract A(Int){ function f() return this.x; }` printed `(FieldAccess x)` with no receiver, so I wrongly concluded abstract `this.x` carries no `IdentExpr this` child (and built a check around that); at full depth it is `(FieldAccess x (IdentExpr this))` — the child was just past the depth cap. When verifying a node's CHILD structure (does X have child Y?), use depth deep enough to reach the leaf, or `--select` the node and read it unbounded. A unit test caught the false invariant; a deeper probe would have caught it first.
- **0 hits on `search`** — almost always a kind mismatch. Re-run with `--explain` to see parsed pattern + input-kind histogram. If the pattern's root kind isn't in the histogram, the search never hits — read actual node shape via `hxq ast` and rewrite.
- **"Find string `'foo.bar'`"** — that's `lit`, not `search`. Use `hxq lit 'foo.bar' <dir>`.
- **"Find annotation `@:trailOpt`"** — `hxq lit '@:trailOpt' src/ --kind Literal,Meta`.
- **`search 'function foo'` returns no decls** — `search` is expressions/statements (call sites), not declarations. Use `refs foo --decls` or `ast --select 'FnMember:foo'`.
- **TODO/comment text** — `hxq lit 'TODO' src/ --include-comments`. Replaces `grep + # HXQ_OK:prose`.
- **`refs`/`uses`/`blast`/`mentions` all return 0 but you know the name appears** — case-pattern usage. Try `cases Foo <dir>`.
- **Want `| head -N`** — every walker has `--limit N`; walkers also auto-cap at 500 hits without `--limit`. `--limit 0` disables.
- **Script-checking "is X gone?"** — pass `--exit-on-empty` (alias `--require-match`) to a find-walker (refs/uses/meta/lit/cases/blast/mentions/search): 0 hits → non-zero exit instead of the default 0. Without the flag a walk always exits 0, so a bare `hxq refs X …; echo $?` can't distinguish found-vs-gone.
- **Output flood** (e.g. `lit '/*' src/ --any-kind`) — auto-truncated per-hit content (multi-line block-comments → first line + ` … +N lines`); auto-cap at 500 hits with stderr nudge. Both opt-out via `--limit`.
- **`test-summary -` TRUNCATES a large piped stream** — `node bin/test.js | hxq test-summary -` read only ~1583 of 5023 tests and still printed `0 failures` (a partial slice looks green; same hxnodejs stdin pipe limitation as the `Sys.stdin().readAll()` gotcha). For a full-suite run ALWAYS redirect to a file first: `node bin/test.js > out.txt 2>&1; hxq test-summary out.txt`. Piping is safe only for short filtered runs (`APQ_TEST=X node bin/test.js | hxq test-summary -`).

## Report on hxq gaps

If a structural query forced a fallback to grep/Read because hxq couldn't handle it (parse-fail, missing capability), tell the user at the end of the task — hxq's readiness gets tracked that way.
