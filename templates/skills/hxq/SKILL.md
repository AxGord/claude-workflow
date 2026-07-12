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

## Empty-walker nudges — read the stderr

When a walker returns 0 hits, stderr prints kind/case-aware tool-suggestion + skip-parse warning if any file failed:
- Uppercase TypeName via `refs` → `uses` / `blast` suggestion.
- Lowercase name via `uses` → `refs` / `lit` suggestion.
- Dotted query (`Type.method`, `obj.field`) → `search '$x.field'` (field-access) / `search 'X.Y($_)'` (call) / `refs <rhs> --decls` (decl).
- Degenerate `search` patterns (single leaf): `$x` alone → "add structural context"; bare literal/ident → "use `lit`" or refs/uses menu.

**Fuzzy "Did you mean"** on `refs`/`uses` 0-hit: substring match (wins, for prefix-truncated TypeNames like `HxTypeParam` → `HxTypeParamDecl`) + Levenshtein ≤3 (typos). Silent when nothing is close.

**Skip-parse WARNING with locus**: when `M < N` (parseable < scanned), printed paths show `:: LINE:COL <msg>`. If locus is at top of file, the file is invisible to the walk; if locus is far past the construct, ignore safely.

**`hxq ast <TypeName> <dir>`** is detected (ast is single-file) and routed to the right tools (`refs --decls` / `uses` / `blast` / `meta @:peg` / `ast --select`).

## Pick the right subcommand — disambiguation table

| Question | Tool |
|---|---|
| Where value X declared / read / written | `refs X <dir> --decls / --reads / --writes` |
| Who consumes type T (field/param/return/generics) | `uses T <dir>` |
| Full change-impact for type T (incl. `.field` access) | `blast T <dir>` |
| List all top-level type decls across a scope (cross-file) | `symbols <scope> [--kind ClassDecl/…]` |
| Which files import a module (cross-file) | `importers <module> <scope>` |
| Declaration site(s) of ONE named type + ambiguity check | `declares <type> <scope>` (matches simple name or qualified path; >1 row = ambiguous, 0 = not declared) |
| Run analysis checks + report violations (grouped-by-file) | `lint <scope> [--rule <id>]… [--fix] [--all] [--flat] [--fail-on <sev>] [--format text\|json\|checkstyle]` (analysis/check layer; built-in checks — **`unused-import`**: an import whose bound name has no word-boundary occurrence outside the imports → `Warning`; a wildcard (`import pkg.*;`) stays `Info`; a `using` is LIVE when its bound name is referenced (a static / type use such as `StringTools.fastCodeAt`) OR one of its extension methods appears as a `.method` member-access — for a known stdlib module (`StringTools` / `Lambda`, resolved via the `GrammarPlugin.knownExtensionMethods` seam, a table extracted from the installed std) a verified-unused `using` is a deletable `Warning`, while an UNKNOWN module stays an unverifiable `Info`; **`unused-local`**: a local `var`/`final` (`VarStmt`/`FinalStmt`) never referenced in its enclosing scope → `Warning` (conservative word-boundary text scan via `RefactorSupport.referencedInRange`; skips the plugin's `opaqueKinds` macro-reification subtrees so splice-injected uses are not false-flagged; params/`for`-iterators/`catch`-vars/fields out of scope); **`duplicate-import`**: an import/using whose (kind, module-path, alias) all match an earlier one in the file → `Warning` on the 2nd+ occurrence (distinct kinds — `import a.B` vs `using a.B` — and distinct aliases kept); **`--fix`** deletes the fixable subset in place (unused imports; unused locals with no initializer or a side-effect-free one; duplicate imports) via the DELETE verb, batched per file, canonical-gated; Info hidden unless `--all`; report-only exit UNLESS `--fail-on <error\|warning\|info>` → exit non-zero when a finding at-or-above `<sev>` survives. **Inline suppression** is applied in `Linter.run` so BOTH the report and `--fix` honour it: a trailing `// noqa` (or `// noqa: <rule>,<rule>` for named rules) clears any finding whose source span COVERS its line — so a `noqa` the writer reflowed onto a continuation line still lands; `// CHECKSTYLE:OFF`…`// CHECKSTYLE:ON` clears a region by the finding's REPORT line (`anyparse.check.Suppression`, an `Entry.region` flag discriminates the two, string-aware comment scan, no parse). **`--format`** machine output via `anyparse.query.format.LintFormat`: `json` records / `checkstyle` XML (symmetric with the `checkstyle.json` the loaders consume). Builtins span the `unused-*` (`import`/`local`/`private`/`parameter`), `dead-code`/`empty-block`/`empty-statement`, structural-correctness (`identical-operands`, `self-assignment`, `duplicate-case`, `comparison-to-boolean`, `redundant-parens`, `redundant-else-after-return`, `collapsible-if`, `double-negation`, `swallowed-exception`, `assignment-in-condition`, `duplicate-ternary-branches`, `constant-condition`, `redundant-map-iter-key`), modernization `prefer-*` (`prefer-final`/`prefer-ternary-return`/`prefer-switch`/`prefer-bind`/`prefer-null-coalescing`/`prefer-array-literal`/`prefer-map-literal`/`prefer-interpolation`/`prefer-single-quotes`, `simplify-boolean-ternary`, `fold-adjacent-string-literals`) and project-style (`naming`, `missing-visibility`, `modifier-order`, `explicit-type`, `complexity`) families. The authoritative, current set is `Linter.builtins()` / the README check table — this line is NOT kept in lockstep, so don't trust a hardcoded count. **Project config `apqlint.json`** (apq-native, walk-up discovered like `checkstyle.json`/`hxformat.json`, in `anyparse.check.LintConfig`): per rule `"enabled":false` drops it from the default set (an explicit `--rule` still runs it), `"severity":"error|warning|info"` overrides the reported severity (remapped in `Linter.run` before report/`--fail-on`), any other key is a rule option (`complexity`'s `"max"`, precedence over a `checkstyle.json` threshold). Missing/malformed → no-op. Walk-up extracted to shared `anyparse.query.ConfigFinder.findUp`; `Severity.fromName` shared with `--fail-on`) |
| Every occurrence of name X (incl. case-patterns) | `mentions X <dir>` |
| Who does function F call (direct/transitive) | `callees 'Type.method' <scope> [--depth N] [--kinds call,ref,new,virtual,contains]` (approximate call graph: name + declared-type resolution, `Null<T>` unwrapped, virtual edges to overrides, `Ref` edges for lambdas/method-values/`.bind` with the receiving call as `via`; out-of-scope targets `[external]`; unresolved sites counted to stderr; builds graph over the whole scope — ~25s on TM-sized 800 files) |
| Who calls function F (direct/transitive) | `callers 'Type.method' <scope> [--depth N]` (same graph, in-edges) |
| Is B reachable from A + through which chain | `reach --from 'A.m' --to 'B.n' <scope> [--to …] [--max-paths N]` (`--to` repeatable, `Type.*` patterns; BFS shortest path per pair; default kinds call,ref,new,virtual) |
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

## Refactoring ops (`hxq <op>` — source MUTATION, not query)

Distinct from the read-only query subcommands above: these REWRITE source. All are **scope-correct** (reuse the `refs`/`Scope` resolver, not by-name text replace), **format-preserving** (span-splice; everything else byte-verbatim), and **re-parse-validated** (a rewrite that doesn't parse is rejected, never written). **Every `<l>:<c>` slot in the tables below ALSO accepts `--select '<sel>'` / `--match '<pattern>'` [+ `--nth <k>`] and the bare `<line>` form — see “Addressing (v2)” above; prefer those, the positional form is the legacy fallback** (exceptions: `extract-method` ranges and `set-comment` stay positional; `extract-var` takes `--match` but not `--select`). Default prints the rewrite (or a summary) to stdout; `--write` applies in place. **Coordinate convention = 1-based `<line>:<col>`** — identical to what `hxq refs`, `ast --at`, `source`, and your editor print (no `col-1`/`col+1` inversion — a col copied from any of them lands correctly).

| Op | What | Safety boundary |
|---|---|---|
| `hxq rename <f> <l>:<c> <new> [--write]` | rename the binding at the cursor (local/param/field) + all in-file occurrences | single-file (scope-resolved); the resolver is MACRO-AWARE (`RefShape.opaqueKinds`/`interpolationKinds`): a plain identifier inside `macro {...}` reification is treated as a runtime emit (NOT renamed), while a `${…}`/`$v{…}` interpolation IS a real reference (renamed) — so renaming a field whose name is also emitted as a generated-code identifier (e.g. `ctx` in a `@:build` lowering class) is safe. Build-after (`haxe test-js.hxml`) is still prudent for any field rename in a macro class, but the historical 8338-`Unknown identifier` over-rename is fixed |
| `hxq rename … <new> --scope <dir> [--write]` | cross-file rename of a TYPE (decl + type-positions + `new`/cast/extends/type-params + import/using segments + `T.staticMethod()`) across `<dir>` | type-namespace = 0 false-positive; uniqueness + skip-parse guards; ATOMIC (all files or none); residual = bare `Class<T>` value / aliased imports (loud — compile error, advisory-warned) |
| `hxq inline <f> <l>:<c> [--write]` | inline a local `var`/`final` into its reads | refuses unless side-effect-free init + immutable free locals (correct-by-construction) |
| `hxq extract-var <f> <l>:<c> <name> [--write]` | hoist the expression at the cursor into a `final <name>` before the enclosing block-stmt | refuses if not in a `{ }` block, or name collides with a param/local |
| `hxq change-sig <f> <l>:<c> <perm> [--write]` | reorder a function's params + every resolvable call-site's args (`perm`=`2,0,1`) | refuses unresolvable/`obj.foo()` call sites + value-captures (silent-failure guard); method → cross-file advisory |
| `hxq move <f> <l>:<c> <dest> --scope <dir> [--write]` | move a TYPE decl (with doc-comment/`@:meta`) to another file in the SAME package; carry dep-imports; repoint importers | same-package only; import-carry best-effort (advisory); ATOMIC |
| `hxq add-param <f> <l>:<c> '<paramText>' [--write]` | add a trailing param to a function | requires default `=`/optional `?` (backward-compat) → decl-only, no call-site update |
| `hxq remove-param <f> <l>:<c> <index> [--write]` | remove the 0-based param + its positional argument at every resolvable call site | change-sig completeness proof (refuses unresolvable / receiver-qualified / value-captured / arity-mismatched calls); refuses if the param is still used in the body (incl single-quote `'$a'` interpolation); method → cross-file advisory |
| `hxq inline-method <f> <l>:<c> [--write]` | inline a single-return function into EVERY proven-complete in-file call site (args substituted for params, parenthesised) + delete the decl | body must be one `return E;`; CallSites completeness proof; a 0-/2+-use param ⇒ pure arg required; refuses recursion / `'$p'` simple-interpolation / param-shadow / arity-mismatch; method → cross-file note (deletes the decl regardless) |

**Structural insert / replace ops — WRITER-EMIT:** a SECOND mutation sub-family, distinct from the scope-correct span-splice refactoring ops above. These introduce NEW code, so they are **writer-emitted, NOT spliced as-is**: the raw new text is placed at an AST-resolved position, then the WHOLE file is re-emitted through `writeRoundTrip` (the trivia/comment-preserving pipeline), which formats the inserted code by the grammar's own rules AND re-parse-validates in one step (unparseable → `Err`). Because a whole-file rewrite would also reflow unrelated hand-wrapping, there is a **canonical gate**: unless `--reformat`, the file must already satisfy `writeRoundTrip(f) == f` (else `Err` "not canonical"); `--reformat` opts into canonicalising the whole file (the gofmt workflow). **anyparse src/ is writer-canonical**, so the gate passes on src files; the project `hxformat.json` is auto-DISCOVERED (walk up from the edited file via `Cli.discoverFormatConfig`) and threaded into the writer, so the result matches the project style. Shared finalize `RefactorSupport.canonicalize(source, edits, reformat, plugin, ?optsJson)` + unified `RefactorSupport.EditResult { Ok(text); Err(message); }`; each op is a thin `final class` (`src/anyparse/query/{ReplaceNode,AddMember,AddImport,AddElement,ExtractMethod}.hx`). Requires a grammar with a writer; result is FULLY canonical (whole-file gofmt), NOT a minimal diff of just the change. **CODE INPUT:** the `<code>`/`<memberText>`/`<newSource>` positional arg of `add-member`/`add-element`/`replace-node` accepts `--from-file <path>` OR the literal `-` (read from stdin, like `probe -`) — the QUOTE-SAFE path for code containing `$` (Haxe interp) or `'`/`"` that the shell mangles as an arg. **USE THIS to drive the ops from bash** instead of the heredoc-into-var trick. **PREFER stdin via a quoted heredoc** — `hxq add-member f --type T - <<'EOF'\n<code>\nEOF` — it is quote-safe (the `'EOF'` quotes suppress `$`/backtick/`'`/`"` expansion, so Haxe interpolation reaches stdin verbatim) AND a single bash call: no Write-temp-file + `--from-file` + `rm` round-trip (that 3-step path is the costlier default I kept reaching for — don't). `--from-file <path>` is for when the code ALREADY exists as a file or is reused across several ops. `printf '%s' "$code" >/tmp/m.hx` then `--from-file` works too but only earns its keep on reuse. Giving the code by more than one route → `Err`. Shared resolver `Cli.resolveCodeArg`.

| Op | What | Safety boundary |
|---|---|---|
| `hxq add-member <f> --type <T> '<memberText>' [--reformat] [--write]` | append `<memberText>` to type `<T>`'s body, before the closing `}`, writer-formatted; works for class/interface/abstract/enum/typedef-anon | resolves `<T>` by name via final-aware `RefactorSupport.typeDeclOf` (refuses unknown / ambiguous); APPEND-ONLY (ordering = formatting layer's job); closing `}` found by scanning BACK over trailing whitespace from `fullSpan.to-1` (the `FinalDecl`/`TypedefDecl` span SWALLOWS trailing trivia past the `}`); canonical-gate |
| `hxq add-import <f> <module.path> [--using] [--reformat] [--write]` | add `import <path>;` (or `using` with `--using`) after the last import/using, else after `package`, else file-top; writer-formatted | dedup per-kind (`import a.B` does NOT block `using a.B`); same-kind duplicate → `Err`; collects `ImportDecl`/`UsingDecl`/`ImportWildDecl`/`ImportAliasDecl`; canonical-gate |
| `hxq replace-node <f> (--select '<sel>' \| --at <l>:<c> [--kind <Kind>]) '<newSource>' [--with-doc] [--reformat] [--write]` | replace ONE node's source span with `<newSource>`, writer-formatted | `--select` reuses `Engine.select` (the `ast --select` resolver; MUST match exactly one — 0/>1 → `Err`); `--at` reuses `Engine.at` (innermost spanned node) using 1-based `<line>:<col>` (identical to `ast --at` / `hxq refs` — unified, no inversion); **`--at … --kind <Kind>`** narrows to the innermost node of `<Kind>` at the cursor via `Engine.atKind` — reaches a CO-STARTING operator/wrapper node that plain `--at` (innermost overall) skips past to its first child (the whole `a + b * c` Add / `b * c` Mul, not `IdentExpr a`/`b`); cursor placement + kind select any nesting level; kind-equiv-aware like `--select`. **`--with-doc`** extends the replaced span back over a leading `/*`-opened doc comment (`RefactorSupport.docExtendedSpan`), so the new source rewrites the decl AND its docs. Provide exactly one of `--select`/`--at`; `--kind` requires `--at`; canonical-gate |
| `hxq add-element <f> (--after \| --before \| --append <l>:<c>) '<code>' [--reformat] [--write]` | insert a NEW element into a list-shaped slot. `--after`/`--before` = next to an existing SIBLING element whose first token is at `l>:<c` (statement-in-block / case-in-switch / array / object-field / call-arg). `--append` = as the LAST child of the CONTAINER whose first token is at `l>:<c` (block / array / object / call / new / class / switch / type-body) — the only mode that also works on an EMPTY container with no sibling to point at (`class C {}`, `[]`, `foo()`); resolves the first pre-order container at the cursor (so a `foo(x);` stmt → its `Call`, not the `ExprStmt`) via back-scan from `span.to` to the closing delimiter (`RefactorSupport.typeDeclOf`-aware for `final class` bodies). **MODIFIED decls:** a decl's modifiers/`@:meta` project to separate sibling nodes BEFORE it (`public static function`=`(Public)(Static)(FnMember)`), so `declGroupSpan` folds the `[@:meta modifiers… decl]` run into one element — `--before` lands ahead of the FIRST modifier (not between modifier and keyword), `--after` past the decl end, and a cursor ON a modifier targets the decl it precedes (point at `private` of `private typedef X` works). `final` excluded (it WRAPS) | separator AUTO (newline for self-terminated statement/case lists + block/class/switch bodies; `,` for `ArrayExpr`/`ObjectLit`/`Call`/`NewExpr` OR source-comma-adjacency, which also catches unenumerated multi-element comma lists); container-AGNOSTIC beyond the separator (the re-parse IS the element-validity gate); `--append` is the COMPLETE new primitive (empty→append; non-empty front-insert = `--before` on the first elem) and is APPEND-ONLY like `add-member` — no `--prepend` (it would add no capability); canonical-gate. NO fragment-parse |
| `hxq extract-method <f> <startL>:<c> <endL>:<c> <name> [--reformat] [--write]` | extract a contiguous sibling-statement run into a LOCAL FUNCTION (closure) + replace the run with a call; range-locals read AFTER the run become the return value — ONE returned bare (`final/var v = name()`), TWO-PLUS as an anon struct `return {a: a, b: b}` destructured back into the original names at the call site (`final _<name>Result = name(); final a = _<name>Result.a; …`), each rebind `var` if reassigned after the range else `final` | closure capture sidesteps the no-typechecker wall (read-only locals need no param/type); refuses return/break/continue in range, an outer local mutated-and-used-after, or a cross-block range; canonical-gate |
| `hxq remove-element <f> <l>:<c> [--with-doc] [--reformat] [--write]` | remove the sibling element whose first token is at `l>:<c` (statement / case / array / object / call-arg element / member, with its modifier-`@:meta` group) — the **DELETE verb**, structural inverse of `add-element` | `RefactorSupport.deleteNode` = `declGroupSpan` + `canonicalize` empty-text; comma lists swallow ONE separating comma (trailing-preferred, leading if last); self-terminated lists (stmt/case/member/import) swallow the WHOLE physical line via `lineExtendedSpan` (else the trivia writer keeps a blank line); `--with-doc` also removes a leading `/*`-doc comment (else orphaned); canonical-gate |
| `hxq remove-import <f> <module.path> [--reformat] [--write]` | remove the `import`/`using` whose EXPOSED path equals `<module.path>` (the alias for an aliased import; `pkg.*` for wildcard) — by-name wrapper over `remove-element`; backend of `lint --fix` | refuses 0/>1 matches; parent = module root (imports are top-level, non-comma, no modifiers); canonical-gate |
| `hxq remove-member <f> --type <T> <memberName> [--with-doc] [--reformat] [--write]` | remove the field/method `<memberName>` of type `<T>` (final-aware via `typeDeclOf`), with its modifier-`@:meta` group — by-name wrapper, sister to `add-member` | both `<T>` and `<memberName>` must resolve to exactly one node (0/>1 → `Err`); `--with-doc` removes the member's leading doc comment too; canonical-gate |
| `hxq set-doc <f> <l>:<c> (<text> \| --from-file \| -) [--reformat] [--write]` | add or REPLACE the doc-comment of the decl at the cursor (`SetDoc.hx`) — edits ONLY the doc region `[docExtendedSpan.from, declGroupSpan.from)` (existing leading `/*`-doc replaced, else inserted), the decl untouched. Closes the member-doc-ADD gap (`replace-node --with-doc` needs the whole decl retyped) | text via inline / `--from-file` / `-` (stdin) through `resolveCodeArg`; payload = RAW doc text — a `/** */`-wrapped payload is rejected (`RefactorSupport.docComment` adds the delimiters); canonical-gate |
| `hxq set-modifier <f> <l>:<c> <change>... [--reformat] [--write]` | flip visibility / add-remove modifiers WITHOUT retyping the decl (`SetModifier.hx`) — `public`/`private` (set visibility), `+<mod>`/`-<mod>` (static/inline/override/macro/extern/dynamic). **The safe replacement for the `replace-node --at <modifier>` footgun** (which grabs the whole-decl wrapper → overwrote the member). Recomputes only the NON-`@:meta` modifier run + splices it; `@:meta`/decl/body untouched | changing visibility/mods OF a `final` decl works (final is part of the decl node); adding/removing `final` itself → `Err` (it wraps; use replace-node); a bare change must be public/private; canonical-gate |
| `hxq set-comment <f> <l>:<c> (<text> \| --from-file \| -) [--reformat] [--write]` | replace the COMMENT at the cursor (`SetComment.hx`) — the comment counterpart of `set-doc`, for inline `//` comments (trivia no other op reaches): a block comment whole, a contiguous full-line `//` run merged as ONE unit, a trailing `//` after code alone; string literals skipped (`RefactorSupport.commentBlockAt`). The replacement must itself be a comment (`//` or `/*`) | the writer re-indents the spliced comment to its attachment context; canonical-gate |
| `hxq rewrite <f> '<pattern>' '<replacement>' [--reformat] [--write]` | structural search-and-replace (`Rewrite.hx`) — the FUSION of `search` + span-replace (gofmt -r / comby). Every node matching `<pattern>` (`hxq search` syntax, `$x` metavars) is rewritten from `<replacement>`: `$x` / `${x}` → the captured metavar's verbatim source, `${x+N}` / `${x-N}` → an integer-literal metavar shifted by N. All matches in one pass | reuses `Matcher` (`Match.span` + bindings); keeps only non-overlapping matches; `${x±N}` refuses a non-integer metavar; canonical-gate. Killer use: bump a positional arg across all calls — `rewrite f 'g($a, $b, $c)' 'g($a, $b, ${c+1})'` |
| `hxq comment-rewrite '<find>' '<replace>' <f\|dir>… [--regex] [--write] [--list]` | text find/replace scoped to COMMENT BODIES (`CommentRewrite.hx`) — the WRITE-twin of `lit`, filling the gap `rewrite` (AST nodes only) + `set-comment` (one block) leave open. Literal by default and matches ACROSS comment line breaks (a phrase wrapped over two ` * ` doc lines, via `RefactorSupport.normalizeCommentBody` + index map); GOTCHA: the <find> must be the NORMALIZED body text — strip the leading ` * ` prefixes and write line joins as single spaces; a multi-line <find> pasted verbatim with ` * ` prefixes/newlines matches 0. GOTCHA 2: cross-line matching works only WITHIN one comment token — consecutive full-line `//` lines are SEPARATE bodies (they merge into one unit only for set-comment), so a find spanning two `//` lines matches 0; use per-line finds, or `hxq patch` on the enclosing node to delete/join whole `//` lines. `--regex` makes `<find>` an `EReg` on the RAW body (no cross-line normalization) and `<replace>` a template (`${1}`=group, `${1+N}`/`${1-N}`=integer group shifted by N, `$$`=literal `$`). Bodies only — code + delimiters never touched, strings skipped (`RefactorSupport.collectCommentTokens`+`commentBody`) | multi-file UX = `fmt`'s (single file→stdout, dir/glob→list, `--write` applies); no-match → unchanged `Ok`; canonical-gate; a replacement that breaks the parse (e.g. an injected block-comment closer) → `Err`. Killer use: bump a coordinate cited across doc-comments — `comment-rewrite --regex 'col (\d+)' 'col ${1+1}' src/ test/` |
| `hxq patch <f> (--select \| --match [--nth] \| --at <l>[:<c>] [--kind]) (- \| --from-file <p>) [--sep <marker>] [--reformat] [--write]` | **the DEFAULT op for a SMALL edit inside a node** (`Patch.hx`) — replace ONE unique fragment without resending the whole declaration. Payload = old fragment, a separator line (exactly `====`, `--sep` overrides), new fragment, via quoted heredoc; **N pairs in ONE call** by alternating sections (even count): `old1 ==== new1 ==== old2 ==== new2` — all matched against the ORIGINAL node text, ranges must not overlap, one writer round-trip. Matching: byte-exact first, then LINE-WISE with per-line indentation ignored — so a multi-line fragment copied from the DEDENTED `source --select` output works as-is | old fragment must occur EXACTLY ONCE within the resolved node (0 → "copy verbatim from apq source"; 2+ → widen until unique — ambiguity can never mis-land); search region = the modifier-folded slice `source --select` prints EXCEPTION: `--select 'ParamCtor:<Name>'` on an enum-ctor resolves the BARE ctor node — its leading `@:meta` lines project as separate siblings and are NOT in the patch search region; to edit a ctor's @:meta annotations, target the PARENT decl (`--select 'EnumDecl:<EnumName>'`) instead.; same canonicalize finalize as replace-node (writer-formatted, re-parse-validated, canonical-gate). Empty new = deletes the fragment but leaves the emptied line as blank trivia — whole-statement removal is `remove-element`'s job. Prefer patch over `replace-node --select 'FnMember:x'` whenever the change is a few lines of a bigger body |

**Ops note — `add-element` / `remove-element` TOLERATE a cursor within a node's first token.** The `<l>:<c>` does not have to be the EXACT `span.from`; a column anywhere inside the node's opening token (one past the `{`, or inside a name) resolves the same node — so **the column can be taken straight from `ast --at`** (which forgivingly returns the innermost node *containing* the cursor, not necessarily one starting at it). No need to derive the exact first-token column by hand. `--append` resolves the DEEPEST container whose first token holds the cursor (inclusive bound → an inner `[[` resolves the inner array); `--after` / `--before` and `remove-element` resolve the outermost ELEMENT whose first token holds the cursor, EXCLUSIVE of the delimiter boundary (so a container's `[` / `{` does not swallow the first element that starts right after it). Backed by the shared `RefactorSupport.elementAtFrom`; the internal `nodeAtFrom` stays EXACT for the binding-span callers (`CallSites` / `ExtractMethod` / `Inline`).

`--after`/`--before` anchored on a bare string-literal element inserts correctly between elements; no whole-array replace needed.

**Writer-emit ops caveat — inserting NEW `#if` conditional-compilation blocks FAILS.** The writer structurally re-emits newly-inserted source; it mangles `#if (...)`/`#else`/`#end` blocks inside a method body (collapses them inline, emits stray `;;`) → the op aborts with `result does not parse`. EXISTING `#if` blocks survive ops fine (their trivia is preserved verbatim — `recon --probe <file> --writer-equals` shows WRITER PASS), so an op that does NOT touch the `#if` region works, AND replacing an `#if`-containing member with `#if`-FREE new source works (e.g. repointing it to a helper). WORKAROUND: put any new `#if`-containing class/method in a NEW file via `hxq new <path> --raw - --write` (reads from stdin, writes bytes VERBATIM, only parse-validates — no writer re-emit). Note: `--raw -` requires the `-` adjacent to `--raw`, and `--write` to apply.

**Writer-emit ops caveat — whole-class `replace-node --select 'ClassDecl:<Name>'` is unreliable.** Observed failure: `apq replace-node: result does not parse: error at 25:7: unexpected input (expected //)` — the whole-file re-emit mangles the class's LEADING doc comment (`/** */`). Reproduced both with and without `#if` in the new body — this is distinct from the `#if` gotcha above; the culprit is whole-class re-emit of the leading doc. WORKAROUND: use per-member ops instead — `replace-node --select 'FnMember:<name>'`, `add-member`, `remove-member`. Single-member replaces round-trip fine even when the member body contains inline `//` comments. To reorder members (e.g. move a private static below a public static): `remove-member <name> --with-doc` then `add-member` (append-only → lands last).

**Writer-emit ops caveat — ops/`hxq new` auto-rebuild aborts on a non-compiling src tree.** The shim auto-rebuilds `apq.js` when `src/` is stale; if the CURRENT tree does not compile (e.g. right after `rm`-ing a file still referenced elsewhere, or mid-multi-edit where two members' signatures temporarily mismatch), the rebuild fails and the op aborts BEFORE writing — the intended edit silently does not happen. WORKAROUND: pass `HXQ_QUIET=1` to skip the staleness check for each intermediate edit in a multi-step sequence, then run one clean `haxe bin/apq-js.hxml` at the end to validate. **COROLLARY: after a run of `HXQ_QUIET=1` edits, `apq.js` is STALE — a `hxq lint … --fix` / any CLI call you run next executes the OLD binary and silently shows pre-edit behaviour (e.g. "fixed 0 issues" when your new code should fix 1). Rebuild `haxe bin/apq-js.hxml` (or drop `HXQ_QUIET` so the shim auto-rebuilds) BEFORE running the CLI. `haxe test-js.hxml` builds `test.js`, NOT `apq.js` — they are separate binaries.**

**Mutation ops are QUERY/PRINT by default — `--write` is REQUIRED to modify the file (recurring slip).** `add-member` / `add-import` / `replace-node` / `add-element` / `remove-*` / `rename` etc. print the would-be result to stdout and DO NOT touch the file without `--write`. Forgetting it (especially on `add-member`/`add-import` whose stdout echoes the whole file, looking like success) means the edit silently didn't happen → the next build fails with `Type not found` / `has extra field`. Always pass `--write` on a mutate op; if a later build complains a just-"added" member/import is missing, the `--write` was dropped.

**Ops note — bare-call statements and `add-element` (guarded in-tool).** `--after`/`--before` on a bare-call statement correctly adds a sibling STATEMENT; and a `;`-terminated element aimed at a comma-separated container (call args / array / object — e.g. `--append` pointed at the call) is REFUSED with a clear Err rather than a cryptic parse error / silent arg-splice. **Registering a NEW test class = exactly two edits, both name-addressed, no re-locate needed:** `hxq add-import test/RunTests.hx unit.XTest --write` then `hxq replace-node test/RunTests.hx --match 'addCase(new SiblingTest())' --kind ExprStmt --write -` with the sibling + new addCase (RunTests uses per-class imports, NO wildcard — forgetting the import leaves `Type not found` only in the test.js build, silently; apq-js stays green).

**Ops caveat — heredoc `- <<'EOF'` is CLEAN for EVERY op; do NOT default to temp files.** A `<<'EOF'` heredoc body always ends with a `\n`. Append/whole-file ops (`add-member` / `add-import` / `new --raw`) normalise it away. The span-splice ops (`replace-node` / `add-element`) strip one trailing newline themselves (`Cli.resolveCodeArg(opName, code, fromFile, stripTrailing=true)` → `withoutTrailingNewline`), so a heredoc leaves no blank line. Regression test: `ApqFromFileCliTest.testReplaceNodeFromFileStripsTrailingNewline`.

**Net rule: `- <<'EOF'` is the DEFAULT for every op — one bash call, quote-safe.** Reach for `--from-file`/temp-file ONLY to (a) reuse the same code across several ops, or (b) iterate on it (edit the file + re-apply, e.g. fix one line and re-run `replace-node`). Writing a temp file just to feed a single op is the needless crutch to stop.

**Ops caveat — `add-member`/`add-element` reject an `EnumAbstractDecl` body.** `typeDeclOf`/the container-resolver don't recognise `enum abstract` (the decl projects as `EnumAbstractDecl`, distinct from `AbstractDecl`/`ClassDecl`), so `add-member --type <EnumAbstract>` errors `no type named "<X>"` and `add-element --append <enum-pos>` errors `not on the first token of a container`. WORKAROUND to add a static method/value to an enum abstract: `replace-node --select 'FnMember:<siblingMethod>'` with the sibling member + the new member appended in `<newSource>` (per-member replace round-trips fine).

**Ops caveat — `set-doc` fails on a `final class` carrying a leading doc + `@:meta`.** `set-doc <pos>` on such a class (e.g. `/** … */` then `@:nullSafety(Strict)` then `final class X`) consistently aborts `result does not parse: error at <near-class-end>: expected HxDecl` — the doc-region span calc mis-resolves for the `FinalDecl`-wrapped, meta-bearing class (tried cursor on the meta line and the `final` keyword; both fail). No clean workaround found (`replace-node --select ClassDecl` re-mangles the leading doc too); leave the class doc or fix via a non-`set-doc` route. **WORKAROUND: `hxq set-comment <f> <docStartLine>:1 --write -` REPLACES the class doc fine** — point the cursor at the `/**` line itself (a comment is a whole-block unit for set-comment; a cursor on a non-comment line errs "not on a comment"). The replacement must itself be a `/** … */` block. SECOND variant: on a `final class` whose leading doc sits after imports, `set-doc --select 'ClassDecl:<Name>'` can report `wrote <file>` yet leave the doc UNCHANGED (silent no-op) — always verify with `hxq lit '<new phrase>' <file>` after a set-doc, and fall back to the `set-comment <docStartLine>:1` workaround.

**Ops caveat — `set-comment` quirks.** (a) A `- <<'EOF'` heredoc whose BODY contains shell-ish words (`tail`/`head`/`cat`/`sed`) can be false-denied by the .hx view-gate — use `--from-file` for such payloads. (b) On a comment block starting at column 1, the cursor `<line>:1` can err "not on a comment" — take the exact col from `hxq lit '<text>' <file> --kind Comment` output.

**CRUD-by-AST + the Edit-gate hook:** the mutation ops cover the full CRUD so EVERY parseable-`.hx` edit is doable via an op — **Create** = `add-member`/`add-import`/`add-element`, **Update** = `replace-node` (`--select`/`--at`/`--at --kind`/`--with-doc` reach ANY node), **Delete** = `remove-element`/`remove-import`/`remove-member`. A **project-local PreToolUse hook** (`.claude/settings.local.json` matcher `Edit|Write` → `.claude/hooks/apq-edit-gate.sh`, `.claude/` is gitignored) HARD-DENIES Edit/Write of a parseable anyparse `.hx` and points at the ops. Allowed: non-`.hx` / outside-project / `/tmp`, a **skip-parse `.hx`** (`recon --probe` rc≠0 → ops can't edit it), and the `APQ_EDIT_OK=1` escape (op bug / genuinely-uncovered case). **Write of a NEW `.hx` is DENIED too** — create via `hxq new` (covers every shape: `--kind class/interface/enum/typedef/abstract` / `--implements` / `--field` / `@@ members`, or `--raw -` for an arbitrary whole file), which canonicalises + validates before writing. So on `.hx`: EDIT via the ops, CREATE via `hxq new` — never Edit/Write.

**`APQ_EDIT_OK` is NOT live-settable.** A per-Bash `APQ_EDIT_OK=1` prefix never reaches the `Edit|Write` gate hook, and baking it into `settings.local.json` env is blocked; the only sanctioned route is asking the user to `export APQ_EDIT_OK=1` and relaunch the session. Don't burn turns trying to enable it mid-session.

**Bulk comment/trivia sweep** (many-file doc/comment rewrite the ops don't cover one-by-one): a validated `python`/`perl` script via Bash is legitimate (Bash is not the Edit gate) — afterwards `hxq fmt -l <files>` must print nothing (all still canonical) and the suite/corpus must be Δ0.

**Writer-emit working discipline — prefer ops over Edit, but know the writer's limits:**
- **Edit is what makes files non-canonical.** Hand-written code drifts from the writer's form (e.g. a `['a','b',…]` array on one line that exceeds 140 cols — the writer wraps it one-element-per-line). Then the next writer-emit op REFUSES (canonical gate). The writer-emit ops are IDEMPOTENT — `op(canonical) == canonical` — so a file mutated ONLY by ops stays at the canonical fixed-point forever and every op keeps working. **Default to the ops; surgical mid-logic rewrites are `hxq patch`'s job now** (old `====` new via heredoc — no whole-declaration resend); Edit remains only for what no op covers (rare trivia-only shapes) and must be written in canonical shape, or `--reformat` after.
- **`--reformat` is the FIX for drift, not a hazard.** On a file that is SUPPOSED to be canonical (the project's own `src/`), the "extra" lines `--reformat` touches are correcting your own Edit-drift — desirable, not noise. Don't fear it.
- **MEASURE canonical-ness, never guess from file SIZE.** Drift ∝ accumulated non-canonical Edits, NOT line count — an 8000-line file mutated only by ops gives a clean one-member diff; a 100-line file you Edited gives more. One command tells you: run the gate IN-TREE — `hxq add-member <file> --type T 'x' >/dev/null 2>&1; echo $?` (exit 0 = canonical, 1 = not), or `… --reformat --write` then `git diff --stat`. (Declining an op because a file is "big" is the false-proxy trap.)
- **The gate reads `hxformat.json` via `discoverFormatConfig` from the FILE'S directory upward.** So testing canonical-ness on a `/tmp` COPY gives a FALSE refuse (no `hxformat.json` there → default opts, e.g. `:Array` vs the project's `: Array`). Always gate-check the file IN ITS PROJECT TREE.
- **`ast --writer-output` uses DEFAULT opts, NOT the project config** — it is the wrong tool to canonicalize to project style. There is no standalone `format` command; canonicalize content-neutrally with `hxq replace-node <file> --select PackageDecl '<the exact package line>' --reformat --write` (replace a decl with itself + whole-file re-emit through the config-aware path).
- **Canonicalization is SAFE for the catch case** — the `} catch  (` double-space bug is FIXED (root was `HaxeFormatConfigLoader.applyConditionParens` deriving BOTH the kw→`(` gap AND the inner `( ` pad from one `openingPolicy` under `conditionParens.openingPolicy:"before"` — config-specific, NOT the trivia non-idempotence first guessed). Re-emitting a project-tree file does not bake `catch  (`. **Still eyeball the `git diff` of any canonicalization before committing** — if it introduces ARTIFACTS (not just clean wrapping/spacing) there may be ANOTHER writer non-idempotence; then leave the file non-canonical and use `--reformat` per-op. `--from-file`/`-` closes the QUOTING gap but NOT the canonical-gate — ops still need the file canonical (or `--reformat`).

**`final`-decl handling:** `final` is the one modifier that WRAPS a decl, so a `final` declaration projects to a DIFFERENT kind than its plain form. **Decl-kind cheat-sheet:** `final class X`→`FinalDecl(ClassForm X)` (the NAME is on the inner `ClassForm`, the `final ` keyword is in the outer `FinalDecl` span); `final function d()`→`FinalModifiedMember`; plain `class`→`ClassDecl`; plain method→`FnMember`; `final` FIELD (`final x:Int`)→`FinalMember`; every OTHER modifier (`public`/`private`/`static`/`override`/`extern`)→a SEPARATE preceding sibling node before a plain decl. **All refactoring ops HANDLE final decls:** TYPE ops (rename `--scope` / move / SymbolIndex) handle `final class` via shared final-aware `RefactorSupport.typeDeclOf`/`resolveTypeDeclAtCursor`; FN ops (rename / change-sig / add-param / extract-var, + remove-param) handle `final function` — via the QUERY-PROJECTION layer (`HaxeQueryPlugin.extractName` surfaces the method name off the inner `HxFinalModifierMember.fn` onto `FinalModifiedMember`, which then joins `DECL_HOST_KINDS`/`scopeKinds`); the shared `RefactorSupport.FN_DECL_KINDS` (`FnMember`/`FinalModifiedMember`/`LocalFnStmt`) backs all fn-ops. Methods INSIDE a `final class` are normal `FnMember`. **`hxq ast --select` is final-aware too:** `--select ClassDecl` matches a `final class`'s `ClassForm` and `--select FnMember` matches a `final function`'s `FinalModifiedMember` (chains too — `--select 'ClassDecl > FnMember'` reaches a final method inside a final class), via `GrammarPlugin.selectKindEquivalence` folding `ClassDecl≡ClassForm` / `FnMember≡FinalModifiedMember`. This `--select` fold is SEPARATE from the search-only kind-equivalence and does NOT fold a `final` FIELD (`FinalMember` stays its own kind). So you don't need to remember the wrapper kinds for `--select` on classes/methods — but a `final` field is still `--select FinalMember`.

**Modifier flips = `hxq set-modifier`; `replace-node`'s span always covers the WHOLE decl incl. leading modifiers.** A `replace-node` target (any address mode) resolves to the co-starting wrapper spanning the ENTIRE declaration — so `<newSource>` must be the complete decl with modifiers verbatim (`private static function walk(…)`, not bare `function walk(…)`). The silent-corruption trap (bare `'public'` as newSource would eat the declaration body) is GUARDED IN-TOOL: a newSource consisting of a single modifier keyword is refused with an Err pointing at `set-modifier`.

**`replace-node --at <l:c> --kind <Kind>` can resolve a CO-STARTING node of `<Kind>` that ENCLOSES the one you mean — a silent-corruption hazard.** Editing the inner `return X;` of `return arr.filter(v -> { … return X; })` via `--at <innerReturn> --kind ReturnStmt` grabbed the OUTER `return arr.filter(…)` ReturnStmt (both contain the cursor, both are `ReturnStmt`) → the new `return X;` replaced the WHOLE outer return, the filter/lambda body vanished, and the file still PARSED (caught only on the next build / `source` read). **FIX: don't use `--at --kind` for nested statements at all — `--match '<the exact statement>' --kind <Kind>` (lift semantics, exactly-one discipline) or `--select 'FnMember:<fn>'` (replace the whole function) have no co-starting ambiguity.** `--at <l> --kind <K>` remains only for operator nodes a pattern can't spell easily; if you must use it, probe `ast --at` first.

## Recurring queries (copy-paste)

```sh
# Value bindings (scope-aware)
hxq refs X src/<dir>/ --decls          # declarations only
hxq refs X src/<dir>/ --reads          # reads only
hxq refs X src/<dir>/ --writes         # writes only

# Type-position references
hxq uses HxVarDecl src/<dir>/

# Full change-impact for a type (the only query that covers expr.field)
hxq blast HxObjectField src/ test/

# Decls carrying @:meta (optionally restricted to a kind)
hxq meta @:trailOpt src/<dir>/
hxq meta @:peg src/<dir>/ --on ClassDecl

# Structural pattern with metavars; --kind narrows by AST node kind
hxq search 'recv.addCase(new $x())' path/File.hx
hxq search '$x is HxType' src/ --kind Is
hxq search '<pat>' src/ --explain        # 0-hit debug — shows parsed pattern + input-kind histogram

# Case patterns precisely (case Foo: / case Foo(_): / case A | Foo:)
hxq cases VarMember src/ test/

# String-literal / annotation lookup (smart-default kind by case)
hxq lit 'lit.kwText' src/anyparse/macro/
hxq lit '@:trailOpt' src/ --kind Literal,Meta

# Text inside comments (TODO/FIXME/doc-comments)
hxq lit 'TODO' src/ --include-comments    # AST walk + comment scan
hxq lit 'workaround' src/ --kind Comment  # comment-only

# Cap output (gate-safe `| head` replacement); walkers auto-cap at 500 hits without --limit
hxq refs X src/<dir>/ --limit 10

# Subtree / node at position
hxq ast File.hx --select 'Kind:name'      # locate a named decl
hxq ast File.hx --select 'Kind name'      # space is alias for `:`
hxq ast File.hx --at 142:5                # by line:col
hxq ast File.hx --depth 3                 # depth from displayed root
hxq ast File.hx --depth 3 --children-limit 3   # truncate width too

# Arity filter on --select (find multi-arg ctors / unary wrappers)
hxq ast HxExpr.hx --select 'ParamCtor' --min-children 2
hxq ast HxDecl.hx --select 'ParamCtor' --max-children 1

# Inline source via positional (short) or stdin (multi-line, heredoc-safe)
hxq probe 'class C { var x:Int = 1; }' --depth 6
hxq probe - <<'EOF'
class C { function f() { trace('$name'); } }
EOF

# Locator + reader in one — append --doc / --source to refs/uses/ast
hxq refs HxVarDecl src/<dir>/ --decls --doc        # + leading /** */
hxq uses HxVarDecl src/<dir>/ --source             # + verbatim slice
hxq ast File.hx --select ClassDecl --doc --source

# RAW verbatim line view — gate-blessed; replaces `git show`/`readFileSync`
# to inspect .hx the Read tool fabricates. 1-based inclusive; clamps out-of-range.
hxq source src/anyparse/grammar/haxe/HxIfExpr.hx --range 122:127   # range
hxq source src/anyparse/query/Cli.hx --range 5800: --number       # line N→EOF, cat -n style
hxq source <file>                                                  # whole file

# @:fmt(flag)-driven search — which ctors/fields carry a specific @:fmt arg.
# Matches a top-level arg = bare ident `flag` OR call `flag(...)` (callee), EXACT
# per arg. (lit --kind Meta returns EMPTY for these — arg idents aren't Meta leaves;
# plain `meta @:fmt` lists ALL @:fmt fields. This is the precise filter.)
hxq meta '@:fmt(propagateExprPosition)' src/anyparse/grammar/haxe/   # bare-ident arg
hxq meta '@:fmt(trailingComma)' src/                                 # callee of trailingComma(...)
```

For full flag reference on any subcommand: `hxq <cmd> --help`.

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

## Report on hxq gaps

If a structural query forced a fallback to grep/Read because hxq couldn't handle it (parse-fail, missing capability), tell the user at the end of the task — hxq's readiness gets tracked that way.
