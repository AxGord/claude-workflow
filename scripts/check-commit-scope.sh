#!/bin/sh
# Commit scope of the engine's main checkout (the pre-commit hook runs it).
#
# The engine's code and its shipped text (skills, templates, docs) change through an engine-task
# worktree: a worker commits there, a review reads that commit, the land fast-forwards master. A
# commit made straight on the main checkout skips all of that, so it may carry ONE thing: a line of
# docs/decisions.md (the append-only list of refuted hypotheses).
#
# Passes (exit 0) when
#   - the commit is made in a linked worktree (a task worktree: its commit is reviewed before the land);
#   - a merge is in progress (MERGE_HEAD: the commit is the merge of a reviewed branch);
#   - nothing is staged, or only docs/decisions.md is;
#   - WF_ENGINE_USER_COMMIT is set: the USER's own commit (a release, a hand fix). An agent never sets it.
# A land is a `git merge --ff-only`, which makes no commit and runs no pre-commit hook, so it is never
# refused. Refuses (exit 1) otherwise, naming the files and the queue tools that carry the change.

root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "commit-scope: not a git checkout"; exit 1; }

[ -z "${WF_ENGINE_USER_COMMIT:-}" ] || { echo "commit-scope: WF_ENGINE_USER_COMMIT set: the user's own commit, scope not checked"; exit 0; }

gd=$(git -C "$root" rev-parse --path-format=absolute --git-dir) || exit 1
cd_=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir) || exit 1
[ "$gd" = "$cd_" ] || exit 0
[ ! -e "$gd/MERGE_HEAD" ] || exit 0

# GIT_INDEX_FILE (set by `git commit -a`) is honoured by diff --cached.
staged=$(git -C "$root" diff --cached --name-only --no-renames) || exit 1
other=$(printf '%s\n' "$staged" | grep -v -x -e 'docs/decisions.md' -e '')
[ -n "$other" ] || exit 0

echo "commit-scope: REFUSED. A commit on the main checkout may carry only a docs/decisions.md line; it also changes:"
printf '%s\n' "$other" | sed 's/^/    /'
echo "Engine changes go through a task worktree and its review, never a hand commit on the main checkout:"
echo "    mcp__plugin_workflow_wf__queue_add  (a line for the engine repo, workflow engine-task; queue_edit refines an existing line)"
echo "The user's own commit (a release, a hand fix): WF_ENGINE_USER_COMMIT=1 git commit ..."
exit 1
