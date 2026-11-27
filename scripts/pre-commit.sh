#!/bin/sh
# What the pre-commit hook of this repo runs (install: the stub in docs/development.md).
#   1. scripts/check-commit-scope.sh: what a commit on the main checkout may carry.
#   2. scripts/check-skill-sync.sh: bundled skills against the live copies. It BLOCKS only a commit that
#      touches templates/skills*/ or .skillsyncignore; for any other commit a drift is a warning, so an
#      edit of a live skill never stops every engine land until someone syncs.
root="$(git rev-parse --show-toplevel)" || exit 1

sh "$root/scripts/check-commit-scope.sh" || exit 1

staged=$(git -C "$root" diff --cached --name-only --no-renames)
if printf '%s\n' "$staged" | grep -q -e '^templates/skills/' -e '^templates/skills-stack/' -e '^\.skillsyncignore$'; then
    sh "$root/scripts/check-skill-sync.sh" || {
        echo "pre-commit: skill sync check failed — sync or ignore, then retry."
        exit 1
    }
    exit 0
fi

out=$(sh "$root/scripts/check-skill-sync.sh" 2>&1) || {
    echo "$out" | sed 's/^/pre-commit: /'
    echo "pre-commit: WARNING a bundled skill drifted from its live copy; this commit touches no skill, so it goes on."
    echo "pre-commit: add an engine-task line that syncs it (mcp__plugin_workflow_wf__queue_add): the next commit that touches a skill is refused until then."
}
exit 0
