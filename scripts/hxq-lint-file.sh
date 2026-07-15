#!/bin/sh
# Mechanical review pass for one file or a coupled batch (run by the engine,
# file-review.yaml mechanical_pass exec state). Args: file paths — as separate
# argv entries or as ONE whitespace-separated list (the env: channel delivers
# the batch as a single value; paths with spaces are unsupported in batches).
# Self-gating: a non-.hx or missing path is reported as an observable
# "SKIP: ..." line while the remaining .hx files still lint; no .hx at all,
# or no hxq on PATH, prints SKIP and exits 0 — the exec state never blocks.
#
# Output: lint findings (all severities, grouped by file) + writer-canonical
# drift list, each section headed with the file list so a stale report is
# detectable.

[ $# -gt 0 ] || { echo "SKIP: no file path"; exit 0; }

set -f # a careless caller may pass globs; do not expand them
hx=""
for arg in "$@"; do
    for f in $arg; do
        case "$f" in
            *.hx)
                if [ -f "$f" ]; then
                    hx="$hx $f"
                else
                    echo "SKIP: file not found: $f (cwd: $(pwd))"
                fi
                ;;
            *) echo "SKIP: not a .hx file: $f";;
        esac
    done
done
# NOTE: set -f stays on — the unquoted $hx expansions below must never
# glob-resolve a path like foo[1].hx onto a different existing file.

[ -n "$hx" ] || { echo "SKIP: no .hx files to lint"; exit 0; }
command -v hxq >/dev/null 2>&1 || { echo "SKIP: hxq unavailable"; exit 0; }

# hxq exits 0 even with findings/drift; a non-zero exit means hxq itself
# broke — surface that as a SKIP so an empty report is never read as clean.
echo "=== hxq lint (all severities):$hx ==="
HXQ_QUIET=1 hxq lint $hx --all 2>&1 || echo "SKIP: hxq lint failed (exit $?)"
echo "=== fmt drift (empty = writer-canonical):$hx ==="
HXQ_QUIET=1 hxq fmt -l $hx 2>&1 || echo "SKIP: hxq fmt failed (exit $?)"
exit 0
