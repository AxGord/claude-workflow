#!/bin/sh
# Mechanical review pass for one file or a coupled batch (run by the engine,
# file-review.yaml mechanical_pass exec state). Args: file paths — as separate
# argv entries or as ONE whitespace-separated list (the env: channel delivers
# the batch as a single value; paths with spaces are unsupported in batches).
# Self-gating: a non-.hx or missing path is reported as an observable
# "SKIP: ..." line while the remaining .hx files still lint; no .hx at all,
# or no hxq on PATH, prints SKIP and exits 0 — the exec state never blocks.
#
# Output: with LINT_LIST_RULES=1, the rule state hxq ACTUALLY runs for these
# files (`hxq lint --list-rules <files>`: every rule on/off after the
# apqlint.json chain, default-off rules and the languageVersion gate, one
# block per distinct config chain, each naming its files) — the reviewer
# subtracts its manual checklist by the rules reported ON; an hxq too old to
# answer that gets its bare registry plus a line saying it is an upper bound.
# Then lint findings (all severities, grouped by file) and the
# writer-canonical drift list, those two headed with the file list so a stale
# report is detectable. The rule state goes first on purpose: max_output
# truncation keeps the tail, so findings survive it and the reusable list is
# what gets dropped.
#
# LINT_PROBE=1: only self-gate — print the SKIP lines and exit 0 when there is
# nothing to lint, exit 10 (nothing printed past per-file SKIPs) when there
# is: the review templates take a pool lease for the real pass only then, so
# a review of a non-Haxe file never queues for one.
#
# Under a pool lease (WF_THREADS set by the engine or wf-run) the compiler
# oracle's concurrent compiles follow it: APQ_ORACLE_PARALLEL defaults to
# WF_THREADS; one the caller set wins.

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
[ "$LINT_PROBE" = "1" ] && exit 10
if [ -n "$WF_THREADS" ] && [ -z "$APQ_ORACLE_PARALLEL" ]; then
    APQ_ORACLE_PARALLEL=$WF_THREADS
    export APQ_ORACLE_PARALLEL
fi

# The rule state is what a checklist-building reviewer subtracts by; a review
# that only acts on findings (lint-review) does not ask for it. The `===`
# headers below are what file-review.yaml build_checklist tells the reviewer
# to look for — reword them there too, or the reviewer stops finding them.
if [ "$LINT_LIST_RULES" = "1" ]; then
    # An hxq without the scoped form stops at --list-rules and prints its bare
    # registry, exit 0 — so support is read off the output, not the exit code.
    rules=$(HXQ_QUIET=1 hxq lint --list-rules $hx 2>&1)
    rc=$?
    if [ $rc -ne 0 ]; then
        echo "=== hxq lint rules: unavailable ==="
        printf '%s\n' "$rules"
        echo "SKIP: hxq lint --list-rules failed (exit $rc)"
    elif printf '%s\n' "$rules" | grep -q '^=== effective lint rules'; then
        echo "=== hxq lint rules: effective state per file (on = the linter ran it) ==="
        printf '%s\n' "$rules"
    else
        echo "=== hxq lint rules: registry only ==="
        echo "effective state unavailable — treat registry as upper bound"
        printf '%s\n' "$rules"
    fi
fi

# hxq exits 0 even with findings/drift; a non-zero exit means hxq itself
# broke — surface that as a SKIP so an empty report is never read as clean.
# A report over hxq's reportSummaryThreshold is printed as a per-rule summary;
# a review needs every finding, so ask for the full list where hxq offers it.
full=""
hxq lint --help 2>/dev/null | grep -q -- '--full ' && full="--full"
echo "=== hxq lint (all severities):$hx ==="
HXQ_QUIET=1 hxq lint $hx --all $full 2>&1 || echo "SKIP: hxq lint failed (exit $?)"
echo "=== fmt drift (empty = writer-canonical):$hx ==="
HXQ_QUIET=1 hxq fmt -l $hx 2>&1 || echo "SKIP: hxq fmt failed (exit $?)"
exit 0
