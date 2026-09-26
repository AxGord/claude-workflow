#!/bin/sh
# Review routing by change size (run by the engine, coding/bug-fix `review`
# exec state). Replaces an agent turn that only measured the diff.
#
# Env: REVIEW_BASE   — diff baseline sha (context review_base); empty -> HEAD
#      ROOT_WORKFLOW — stack root; "subagent" -> always single (the parent
#                      reviews the worker's result with its own reviewer)
#
# Exit: 0  single — TRIVIAL change: <=2 files AND <=50 changed lines
#       10 multi  — everything else
#       2  undecidable (not a repo, bad baseline, nothing measured) -> the
#          prompt fallback state, where the agent sizes the change by hand
#
# Untracked files count whole. With REVIEW_BASE set (a fix round), only those
# modified after the baseline commit count — `git stash create` snapshots
# never hold untracked files, so older ones belong to the reviewed round (a
# clean-tree base must therefore be a fresh commit, not HEAD itself). A
# binary file counts as over the line cap.

MAX_FILES=2
MAX_LINES=50

[ "$ROOT_WORKFLOW" = "subagent" ] && exit 0

sha=$(git rev-parse --verify --quiet "${REVIEW_BASE:-HEAD}^{commit}" 2>/dev/null) || exit 2
cd "$(git rev-parse --show-toplevel)" || exit 2

stats=$(git diff --numstat "$sha" 2>/dev/null) || exit 2

files=0
lines=0
while IFS="$(printf '\t')" read -r added deleted _path; do
    [ -n "$added" ] || continue
    files=$((files + 1))
    if [ "$added" = "-" ]; then
        lines=$((lines + MAX_LINES + 1))
    else
        lines=$((lines + added + deleted))
    fi
done <<EOF
$stats
EOF

marker=""
if [ -n "$REVIEW_BASE" ]; then
    marker=$(mktemp) || exit 2
    trap 'rm -f "$marker"' EXIT
    ts=$(git log -1 --date=format-local:%Y%m%d%H%M.%S --format=%cd "$sha") || exit 2
    touch -t "$ts" "$marker" || exit 2
fi

untracked=$(git -c core.quotePath=false ls-files --others --exclude-standard 2>/dev/null) || exit 2
while IFS= read -r f; do
    [ -n "$f" ] || continue
    # "./" keeps a "-name" from parsing as a find option; a git-quoted name
    # (tab, quote, backslash) does not exist as printed -> count it
    [ -z "$marker" ] || [ ! -e "./$f" ] || [ -n "$(find "./$f" -newer "$marker" 2>/dev/null)" ] || continue
    files=$((files + 1))
    n=$({ wc -l < "$f"; } 2>/dev/null) || n=$((MAX_LINES + 1))
    lines=$((lines + n))
done <<EOF
$untracked
EOF

[ "$files" -eq 0 ] && exit 2
[ "$files" -le "$MAX_FILES" ] && [ "$lines" -le "$MAX_LINES" ] && exit 0
exit 10
