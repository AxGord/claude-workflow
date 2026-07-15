#!/bin/sh
# Mechanical review pass for one file (run by the engine, file-review.yaml
# mechanical_pass exec state). Self-gating: a non-.hx file or missing hxq
# prints an observable "SKIP: ..." line and exits 0, so the exec state needs
# no branching and never blocks the review.
#
# Usage: hxq-lint-file.sh <file>   (absolute path — the engine's cwd is the
#                                   server's, not the reviewed project's)
# Output: lint findings (all severities) + writer-canonical drift list,
# each section headed with the file path so a stale report is detectable.

f="$1"
[ -n "$f" ] || { echo "SKIP: no file path"; exit 0; }
case "$f" in
    *.hx) ;;
    *) echo "SKIP: not a .hx file: $f"; exit 0;;
esac
[ -f "$f" ] || { echo "SKIP: file not found: $f (cwd: $(pwd))"; exit 0; }
command -v hxq >/dev/null 2>&1 || { echo "SKIP: hxq unavailable"; exit 0; }

# hxq exits 0 even with findings/drift; a non-zero exit means hxq itself
# broke — surface that as a SKIP so an empty report is never read as clean.
echo "=== hxq lint (all severities): $f ==="
HXQ_QUIET=1 hxq lint "$f" --all 2>&1 || echo "SKIP: hxq lint failed (exit $?)"
echo "=== fmt drift (empty = writer-canonical): $f ==="
HXQ_QUIET=1 hxq fmt -l "$f" 2>&1 || echo "SKIP: hxq fmt failed (exit $?)"
exit 0
