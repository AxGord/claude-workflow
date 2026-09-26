#!/bin/sh
# Mechanical review pass for one file or a coupled batch (run by the engine,
# file-review.yaml mechanical_pass exec state). Args: file paths — as separate
# argv entries or as ONE whitespace-separated list (the env: channel delivers
# the batch as a single value; paths with spaces are unsupported in batches).
# Self-gating: a non-.hx or missing path is reported as an observable
# "SKIP: ..." line while the remaining .hx files still lint; no .hx at all,
# or no hxq on PATH, prints SKIP and exits 0 — the exec state never blocks.
#
# Output: with LINT_LIST_RULES=1, the linter's rule registry and the project
# lint config that narrows it (the reviewer subtracts its manual checklist by
# the two together); then lint findings (all severities, grouped by file) and
# the writer-canonical drift list, those two headed with the file list so a
# stale report is detectable. The registry goes first on purpose: max_output
# truncation keeps the tail, so findings survive it and the reusable,
# file-independent list is what gets dropped.

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

# The rule registry is what a checklist-building reviewer subtracts by; a
# review that only acts on findings (lint-review) does not ask for it.
# Both `===` headers below are what file-review.yaml build_checklist tells the
# reviewer to look for — reword them there too, or the reviewer stops finding
# the lists.
if [ "$LINT_LIST_RULES" = "1" ]; then
    echo "=== hxq lint rules — the linter verifies these mechanically ==="
    HXQ_QUIET=1 hxq lint --list-rules 2>&1 || echo "SKIP: hxq lint --list-rules failed (exit $?)"
    # The registry is the REGISTERED set, not the effective one: the config
    # disables rules and switches opt-in (default-off) ones on. hxq discovers
    # it by walking up from a linted file — do the same walk here.
    echo "=== lint config (narrows the registry; absent = builtin defaults, opt-in rules OFF) ==="
    set -- $hx
    d=$(cd "$(dirname "$1")" 2>/dev/null && pwd)
    [ -n "$d" ] || echo "config lookup skipped — cannot resolve the directory of $1"
    while [ -n "$d" ]; do
        if [ -f "$d/apqlint.json" ]; then
            echo "$d/apqlint.json:"
            cat "$d/apqlint.json"
            break
        fi
        [ "$d" = "/" ] && { echo "no apqlint.json found above $1"; break; }
        d=$(dirname "$d")
    done
fi

# hxq exits 0 even with findings/drift; a non-zero exit means hxq itself
# broke — surface that as a SKIP so an empty report is never read as clean.
echo "=== hxq lint (all severities):$hx ==="
HXQ_QUIET=1 hxq lint $hx --all 2>&1 || echo "SKIP: hxq lint failed (exit $?)"
echo "=== fmt drift (empty = writer-canonical):$hx ==="
HXQ_QUIET=1 hxq fmt -l $hx 2>&1 || echo "SKIP: hxq fmt failed (exit $?)"
exit 0
