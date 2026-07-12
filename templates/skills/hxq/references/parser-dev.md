# hxq self-development recipes

Part of the hxq skill — recipes for developing/debugging hxq ITSELF (writer, grammar plugin, parser corpus, .hxtest fixtures, predictors), not for everyday use of hxq on project code.

```sh
# Byte-span annotation — debug parser bugs producing same-span duplicates
hxq probe 'class C { var x = a ? 1. : 2.; }' --depth 6 --spans

# Writer iteration loop — parse + format-write
hxq ast file.hx --writer-output           # TRIVIA pipeline (corpus harness)
hxq ast file.hx --writer-output-plain     # PLAIN pipeline (unit-test entry)
hxq writer-probe file.hx                  # both, labelled fences
hxq probe '<code>' --writer-probe         # both for inline source

# Writer-bug AST diff (input ↔ output) — collapses whitespace noise
hxq ast file.hx --writer-output --diff

# Byte-equality check on writer output
hxq writer-equals /tmp/probe.hx /tmp/expected.txt
hxq writer-equals --plain /tmp/probe.hx /tmp/expected-plain.txt

# Structural AST diff between two files
hxq diff a.hx b.hx
hxq diff a.hx b.hx --flat --limit 3       # for piping / long divergences

# Strip + parse-check (sole-blocker confirmation)
hxq strip /tmp/probe.hx --replace 'inner;}' --with '}'
hxq strip /tmp/probe.hx --delete '...' --show
hxq strip --regex --replace 'new \w+<\w+>\(' --with ''
hxq strip <files...> --replace … --with …  # multi-file batch with summary
hxq strip --from-cluster '<key>' --delete '...'  # apply across a recon cluster
hxq strip <file> --replace A --with A2 --replace B --with B2 --per-pattern  # interlocking-vs-sole diagnostic

# Strip dry-run — typo guard (no parse, ≥1 match required per pattern)
hxq strip file.hx --replace <p> --with <r> --dry-run

# .hxtest fixtures: section 2 auto-extracts for parse, section 3 for expected
hxq strip /path/to/case.hxtest --replace 'final ?' --with 'final '
hxq ast /path/to/case.hxtest --writer-output
hxq writer-equals /path/to/case.hxtest /path/to/case.hxtest

# Sweep snapshot (read-only; written as side-effect of `node bin/test.js`)
ANYPARSE_HXFORMAT_FORK=/… node bin/test.js   # writes bin/.last-sweep.json + auto-rotates .prev-sweep.json
hxq sweep                                     # totals
hxq sweep --diff                              # auto-default: bin/.prev-sweep.json (zero-setup pre/post-slice)
hxq sweep --prev /tmp/baseline.json
hxq sweep --save /tmp/baseline.json           # explicit baseline (survives next sweep)

# Test-summary: parse utest stdout into counts
node bin/test.js > /tmp/test.out
hxq test-summary                              # default /tmp/test.out
node bin/test.js | hxq test-summary -

# Recon — skip-parse drill harness
ANYPARSE_HXFORMAT_FORK=/… hxq recon --top 20            # corpus sweep + cluster histogram
hxq recon --probe /path/to/case.hxtest                  # single-file PARSE OK/FAIL
hxq recon --cluster '<exact-key>'                       # drill into ONE cluster (full path list)
hxq recon --cluster '<key>' --source                    # + windowed src around fail-locus

# Upper-bound predictor BEFORE grammar edit
hxq recon --predict-strip --replace '<pat>' --with '<repl>'
hxq recon --predict-strip --delete '<pat>'
hxq recon --predict-strip --regex --replace '<re>' --with '<repl>'  # one regex covers every site
hxq recon --predict-strip --source                                  # + windowed src around NEW locus on STILL FAIL
hxq recon --probe <file> --predict-strip --replace <p> --with <r>   # single-file form

# Terminator-insertion predictor (inverse of strip)
hxq recon --predict-relax                               # corpus sweep
hxq recon --predict-relax --no-target-cluster '<expected-msg>'  # drill footer NO TARGET bucket
hxq recon --probe <file> --predict-relax                # single-file

# Regression probe — diff current corpus vs prior snapshot, no full rerun
ANYPARSE_HXFORMAT_FORK=/… hxq recon --regression-probe

# Construct enumeration via regex (when forward-locus clusters miss)
hxq recon --candidates 'new [A-Z]\w*<'

# Permissive-construct field-optionalization predictor
hxq recon --permissive-construct

# Post-parser-additive-slice byte-PASS check — THE reflex BEFORE corpus sweep
hxq recon --probe /path/to/case.hxtest --writer-equals
hxq recon --probe /tmp/probe.hx --writer-equals --expected /tmp/expected.txt
hxq recon --probe /path/to/case.hxtest --writer-equals-plain
# Mutex with --predict-strip / --predict-relax (patched source diverges from expected by construction).

# Which `.hx` files in src/ does the grammar plugin fail to parse?
hxq self-status                # walk src/
hxq self-status test/          # walk test/
hxq self-status --strict       # exit 1 if any file skip-parses (CI guard)

# Gates — which predicate gates a ctor's `;` elision
hxq gates                                       # default trail-opt
hxq gates --mechanism mandatory-ref-lead-trail  # candidate inventory for a gate mechanism
hxq gates --mechanism optional-ref-trail        # current consumers of a gate mechanism
hxq gates --mechanism optional-ref              # all @:optional Ref precedent
hxq gates --mechanism kw-lead                   # keyword-dispatched fields
```

**Reflexes:**
- **AFTER parser-additive slice, BEFORE sweep**: `hxq recon --probe <file> --writer-equals` to confirm byte-PASS upfront (avoids skip→fail surprise).
- **BEFORE grammar edit on a skip-parse cluster**: `hxq recon --predict-strip --regex …` confirms the proposed change is the sole parse-blocker.
- **Pre/post-slice sanity**: `hxq sweep --diff` after `node bin/test.js` (auto-rotated prev).
