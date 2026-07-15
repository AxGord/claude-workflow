# hxq query recipes + empty-result nudge reference

## Empty-walker nudges — read the stderr

When a walker returns 0 hits, stderr prints kind/case-aware tool-suggestion + skip-parse warning if any file failed:
- Uppercase TypeName via `refs` → `uses` / `blast` suggestion.
- Lowercase name via `uses` → `refs` / `lit` suggestion.
- Dotted query (`Type.method`, `obj.field`) → `search '$x.field'` (field-access) / `search 'X.Y($_)'` (call) / `refs <rhs> --decls` (decl).
- Degenerate `search` patterns (single leaf): `$x` alone → "add structural context"; bare literal/ident → "use `lit`" or refs/uses menu.

**Fuzzy "Did you mean"** on `refs`/`uses` 0-hit: substring match (wins, for prefix-truncated TypeNames like `HxTypeParam` → `HxTypeParamDecl`) + Levenshtein ≤3 (typos). Silent when nothing is close.

**Skip-parse WARNING with locus**: when `M < N` (parseable < scanned), printed paths show `:: LINE:COL <msg>`. If locus is at top of file, the file is invisible to the walk; if locus is far past the construct, ignore safely.

**`hxq ast <TypeName> <dir>`** is detected (ast is single-file) and routed to the right tools (`refs --decls` / `uses` / `blast` / `meta @:peg` / `ast --select`).

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
