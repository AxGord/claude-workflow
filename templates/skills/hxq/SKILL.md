---
name: hxq
description: hxq — structural Haxe READ/query CLI (every agent that reads .hx); edits/creates → also load hxq-write
---

# hxq — structural Haxe query CLI

`hxq <subcommand> [opts] <file-or-dir-or-glob>...` parses `.hx` files with anyparse's own parser. Invoke as bare `hxq` (on PATH) — never `./bin/hxq`. Auto-adds `--lang haxe`.

> **ONE command for EVERYTHING — `hxq`.** `hxq` runs BOTH the read/query subcommands AND the write/mutation ops below (it forwards every subcommand to the engine). **`apq` is a documentation label, NOT an installed command** — wherever this skill writes `apq <op>`, RUN it as `hxq <op>`. **Never `node bin/apq.js`** (bypasses the shim and needs cwd=project). **Never `cd`** — `hxq` is on PATH and cwd-independent; pass project-relative paths (default cwd = project root) or absolute paths, and use `hxq probe '<code>'` for throwaway snippets instead of `/tmp` scratch files. (USER decision; root cause = the `apq`/`hxq` dual-naming where only `hxq` is installed.)

**Path arguments: prefer relative.** `hxq` respects CWD; relative paths give shorter hit lines (`<file>:line:col`) than absolute. Use absolute only for files outside the current project.

**Works on ANY `.hx`, including EXTERNAL forks / other repos.** hxq parses by the anyparse grammar regardless of which project a file lives in — `refs`/`uses`/`ast`/`search`/`source` all work cross-project (e.g. querying a `haxe-formatter` fork for ground-truth). Pass the absolute path. Do NOT grep / `node -e readFileSync` / `git show` a fork `.hx` — that is the recurring crutch reflex. Query it structurally (`refs`/`ast`) or read raw lines with `hxq source` (gate-blessed, below; **inside a sandboxed agent use the alias `hxq show`** — a shell sandbox refuses any command carrying the token `source`, since it reads as the builtin that executes a file). Most fork files parse; only the few that genuinely skip-parse need `hxq source` (which reads raw bytes regardless of parse status).

**READING a foreign repo is unconditional; WRITING to one is not** — see `hxq-write`.

**Output: grouped-by-file by default.** Walkers print `<file>:` once then 2-space-indented `<line>:<col>: <hit>` lines. Pass `--flat` for legacy `<file>:<line>:<col>: <hit>` per line (downstream tools).

**Fresh engine.** The `hxq` shim auto-rebuilds when `src/` is newer. Never `HXQ_QUIET=1` for a verification probe (runs the STALE binary — refutes a fix that landed). In a worktree run hxq with CWD inside it; parallel workers pin `HXQ_BIN=<tree>/bin/apq.js` (no stale check — the caller owns the build). Detail: `hxq-write` § Build.

## Addressing — selectors (read AND write ops)

| Form | Meaning |
|---|---|
| `--select '<sel>'` | Selector path: `Kind`, `Kind:name`, `A > B` (direct child), **`A >> B` (any-depth descendant)**. Must resolve to exactly ONE node. |
| `--match '<pattern>'` | `hxq search` structural pattern (`$x` metavars) — the matched node is the target. Exactly-one discipline like `--select`. |
| `--nth <k>` | Pick the k-th (1-based, document order) of several `--select`/`--match` matches. The ambiguity error lists candidates with positions — copy the ordinal from there. |
| ambiguity listing / delete family | An ambiguous `--select`/`--match` listing now spells the selector that picks each candidate where names can (`#2 4:2 Conditional  --select 'ClassDecl:C >> Conditional'`); a row only an ordinal separates stays bare. `remove-member`/`safe-delete` REFUSE two declarations of one name in the SAME `#if` branch (what a `replace-node` leftover looks like) and name the `remove-element … --nth <k>` that takes one — twins in DIFFERENT branches still all go. |
| `<line>[:<col>]` | 1-based position, FALLBACK only. **Column is optional — a bare line number snaps to the line's first non-whitespace char** (take it straight from lint/compiler output). |

A `--select` that matches nothing says WHY: an unknown kind (with did-you-mean over the grammar vocabulary) vs a kind merely absent from this file (`Kinds present here: …`). Read that clause before re-typing the selector. `--kind` is validated against the same vocabulary.

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
| Run analysis checks + report violations | `lint <scope> [--rule <id>]… [--all] [--no-oracle] [--format text\|json]` — `--no-oracle` only while iterating on a file you just edited, NEVER for a gate (verdict). `--list-rules <files…>` = what RUNS here (on/off per apqlint.json chain); bare `--list-rules` = the registry, not what runs. `--rule <id>` force-enables a config-disabled rule. Suppression: trailing `// noqa` / `// noqa: r1, r2` only (`// noqa[r]` suppresses nothing). `--fix` → `hxq-write`. Full semantics: references/lint.md |
| Every occurrence of name X (incl. case-patterns) | `mentions X <dir>` |
| Who does function F call (direct/transitive) | `callees 'Type.method' <scope> [--depth N] [--kinds call,ref,new,virtual,contains]` — APPROXIMATE graph (name + declared-type resolution); out-of-scope `[external]`; unresolved sites counted on stderr |
| Who calls function F (direct/transitive) | `callers 'Type.method' <scope> [--depth N]` (same graph, in-edges) |
| Is B reachable from A + through which chain | `reach --from 'A.m' --to 'B.n' <scope> [--to …] [--max-paths N]` (`--to` repeatable, `Type.*` patterns; BFS shortest path per pair; default kinds call,ref,new,virtual) |
| Along which lines does a god-type split | `clusters <TypeName> <scope> [--hubs N]` — components of intra-type call edges after hubs; ⚠️ scope = the type's own package dir, never whole src/ (minutes of CPU) |
| Main-thread stall candidates | `lint <scope> --rule thread-safety` (config-driven: `sinks` in apqlint.json; findings are CANDIDATES) |
| Measure a rule's precision/recall against a labelled truth file | `lint-score --truth <truth.json> <report.json>` (key = family+function+subject; exit 1 = a real-long/recall entry lost, 2 = nothing scoreable) |
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
| Inline-source AST/writer probe (no /tmp) | `probe '<code>' [ast-options]` / `probe -` (stdin) |
| Structural AST diff between files | `diff a.hx b.hx` (`--flat`, `--limit N`) |
| Single-file PARSE OK/FAIL probe | `recon --probe <file>` |
| **Which `.hx` files plugin can't parse** | `self-status [<dir>]` (`--strict` exits non-zero on any skip-parse) |
| Sanity-check direct-child count at root | `ast file.hx --count` / `probe '<code>' --count` |
| **View file lines** (no parse; any/skip-parse file; Edit-anchorable) — **dedented by the window's MINIMUM indentation**, so it shows raw columns only when the window includes a column-0 line | `source <file> [--range L:L2]` |
| **Read ONE node's raw source BY NAME / position** | `source <file> --select 'FnMember:<name>'` / `--at <l>:<c>` (inside a sandbox: alias `show`). A file >120 lines with no `--range/--select/--at` is REFUSED with a selector menu; `--all` for the whole file |
| Decls carrying `@:tag(arg)` (exact arg, NOT substring) | `meta '@:tag(arg)' <dir>` |
**A 0-hit `callers` is not proof of absence — and it now SAYS so.** With no edge resolved and unresolved sites in scope, the note reads `no callers resolved, but N call site(s) in scope are unresolved — this is NOT proof "X" has none`, and `--exit-on-empty` exits non-zero; with edges shown it stays the plain approximate-graph note. Read that distinction rather than the raw count, and note the graph resolves receivers by NAME, not by a typer: an un-annotated local, a `using` extension, a `Null<T>`/`Dynamic` return, a `new T().m()` receiver all leave the site unresolved and therefore silent. Before turning a thin `callers` result into "only tests call this" / "dead code", cross-check with `hxq mentions <name> <dir>`, and for a member that may be inherited or overridden also query the SUPERTYPE's declaration (`hxq refs <name> <dir> --decls` lists every declaration of the name — an `abstract` one has no body, so it terminates a chain even though it IS the call target).

**Confusion-buster:** `refs` = VALUE bindings, `uses` = TYPE positions, `search` = AST SHAPES, `lit` = CAPTURED STRING CONTENT in leaves. They are not interchangeable. **Neither `refs` nor `uses` catches `expr.field` on a value of type T** — use `blast <Type>` (union + heuristic field-access; `--all` to disable smart 20-hit cap on heuristic section).

**`refs` is blind to EVERY member access, including a QUALIFIED STATIC.** `Type.f()` looks like it must resolve — the receiver is a type name, no inference needed — but the name sits on a field-access node, not an identifier, so `refs f` shows only the declaration. Same for `obj?.f()` / `obj!.f()`, the forms strict null-safety pushes you toward. This is by design (`refs` feeds `rename`, which must not drag `obj.f` along when renaming a local `f`), and `refs` now warns on stderr with a count when it resolved no read/write but the scope holds accesses. **Never turn a bare `refs` result into "unused" / "only one caller" / "safe to delete" for a member or static — confirm with `hxq mentions <name> <dir>` first.** Sibling of the `#if`-blindness rule below: a 0-hit structural query is not proof of absence.

**A DOTTED PATH is ONE leaf, so a simple-name query never sees it — `mentions` included.** `import unit.FooTest;` projects as a single `ImportDecl` carrying the whole `unit.FooTest` string, so `hxq mentions FooTest <file>` reports the `new FooTest()` call and NOT the import that makes it resolve — "no import found" is the query's blind spot, not the file's state. The same leaf shape used to hide a qualified sub-module type reference `Mod.SubType` from `uses` — FIXED 2026-09-06: a simple `<type-name>` now also answers a qualified spelling of the same LAST SEGMENT (`Mod.T`, `pkg.Mod.T`) in `uses` and in the `uses` section of `mentions`/`blast`, each hit printing the path it found; a dotted query stays an exact compare, and the widening is opt-in at the API so `rename` still splices last segments through its own arithmetic. `refs`/`lit` are unchanged, so the IMPORT half of this rule stands. Ask for the path you expect to see: `hxq lit 'unit.FooTest' <file>` (or `lit 'Mod.SubType'`). Reach for this the moment a registration/import audit comes back empty — the wrong conclusion there is a build error one command later.

Self-development rows (sweep, test-summary, writer-probe/writer-equals, strip, recon drills, gates): references/parser-dev.md — never needed for everyday querying.

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
- `clusters` output columns do NOT discriminate static from instance members.

## Report on hxq gaps

If a structural query forced a fallback to grep/Read because hxq couldn't handle it (parse-fail, missing capability), tell the user at the end of the task — hxq's readiness gets tracked that way.
