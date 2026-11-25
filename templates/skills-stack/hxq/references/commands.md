# hxq — rarely used disambiguation rows (moved from SKILL.md)

| Question | Tool |
|---|---|
| Full change-impact for type T (incl. `.field` access) | `blast T <dir>` |
| Who does function F call (direct/transitive) | `callees 'Type.method' <scope> [--depth N] [--kinds call,ref,new,virtual,contains]` — APPROXIMATE graph (name + declared-type resolution); out-of-scope `[external]`; unresolved sites counted on stderr |
| Is B reachable from A + through which chain | `reach --from 'A.m' --to 'B.n' <scope> [--to …] [--max-paths N]` (`--to` repeatable, `Type.*` patterns; BFS shortest path per pair; default kinds call,ref,new,virtual) |
| Along which lines does a god-type split | `clusters <TypeName> <scope> [--hubs N]` — components of intra-type call edges after hubs; ⚠️ scope = the type's own package dir, never whole src/ (minutes of CPU) |
| Measure a rule's precision/recall against a labelled truth file | `lint-score --truth <truth.json> <report.json>` (key = family+function+subject; exit 1 = a real-long/recall entry lost, 2 = nothing scoreable) |
| ONLY switch case-patterns `case Foo:` / `case Foo(_):` | `cases Foo <dir>` |
| **Retire a define — fold every `#if` region it decides, keep the live branch** (WRITE-twin of `cond`) | `resolve-define <DEFINE> <scope> [--undefined] [--write] [--list] [--reformat]` |
| Structural AST diff between files | `diff a.hx b.hx` (`--flat`, `--limit N`) |
| Single-file PARSE OK/FAIL probe | `recon --probe <file>` |
