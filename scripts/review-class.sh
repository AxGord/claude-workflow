#!/bin/sh
# The reviewer class of a change, by the paths it touches (run by the engine, batch-task
# `review_scope`): stdout `light` when every changed path is a test or a doc, else `code`. The task
# workflow's model_table maps the class (context `review_class`) to the reviewer's model and effort.
#
# Args: <base> <tip> — the change is `git diff <base>...<tip>`: the tip's side since the merge base.
# Env:  REVIEW_LIGHT_PATHS — extended regex a light path matches (default below: docs, tests).
# Exit: 0 with the class. A change that cannot be measured (not a repo, a bad ref, an empty diff)
#       is `code`, with the reason on stderr: doubt takes the full reviewer. 2 = usage.

[ $# -eq 2 ] || { echo "usage: review-class.sh <base> <tip>" >&2; exit 2; }

# docs/ and specs/ count at the repo root only (a nested `docs/` package may hold code); a nested
# tests/ or __tests__/ is tests anywhere. `.txt` is no doc extension (CMakeLists.txt, requirements.txt).
light=${REVIEW_LIGHT_PATHS:-'^(docs?|specs?)/|(^|/)(tests?|__tests__)/|\.(md|markdown|rst|adoc)$|[._-](test|spec)\.[^/]+$|Tests?\.[^/]+$|(^|/)(CHANGELOG|LICENSE|README)[^/]*$'}

# git's own message goes to stderr as it is; stdout holds the paths only.
if ! files=$(git -c core.quotePath=false diff --no-renames --name-only "$1...$2" --); then
    echo "review-class: cannot diff $1...$2" >&2
    echo code
    exit 0
fi
if [ -z "$files" ]; then
    echo "review-class: $1...$2 changes nothing" >&2
    echo code
    exit 0
fi
heavy=$(printf '%s\n' "$files" | grep -Ev -e "$light" | head -3)
if [ -n "$heavy" ]; then
    echo "review-class: code — $(printf '%s' "$heavy" | tr '\n' ' ')" >&2
    echo code
else
    echo "review-class: light — $(printf '%s\n' "$files" | wc -l | tr -d ' ') test/doc path(s)" >&2
    echo light
fi
