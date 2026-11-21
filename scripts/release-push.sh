#!/bin/sh
# release-push.sh — publish the release commit: the branch and the tag in ONE atomic push, safe to run again.
#
# Usage: scripts/release-push.sh REMOTE BRANCH_REF TAG SHA     (e.g. origin refs/heads/release v0.2.0 <sha>)
#   - the tag already names SHA on REMOTE   -> the tag is left alone; the branch is pushed again (a no-op when it
#                                              already holds SHA)
#   - the tag names another commit          -> exit 1: the version was released from other content, never moved
#   - no such tag                            -> BRANCH_REF (forced) and the tag go in one `git push --atomic`, so a
#                                              half-pushed state (branch without tag) cannot happen
# Every call to the remote is retried with a pause (scripts/retry.sh; $RETRY_DELAYS, default "10 30 60").
# The release commit is deterministic (scripts/release-tree.sh --commit), so a re-run of the same release arrives here
# with the SHA the first run pushed.

set -eu
[ $# -eq 4 ] || { echo "release-push: usage: release-push.sh REMOTE BRANCH_REF TAG SHA" >&2; exit 2; }
remote=$1 branch=$2 tag=$3 sha=$4
retry="$(cd "$(dirname "$0")" && pwd)/retry.sh"

listing=$(sh "$retry" -- git ls-remote --tags "$remote" "refs/tags/$tag" "refs/tags/$tag^{}")
# An annotated tag lists the tag object and, peeled, the commit; a lightweight one lists the commit only.
at=$(printf '%s\n' "$listing" | awk -v t="refs/tags/$tag" '$2 == t "^{}" { print $1; found = 1 } $2 == t && !found { plain = $1 } END { if (!found && plain) print plain }' | tail -n 1)

if [ -z "$at" ]; then
  git tag -f "$tag" "$sha" >/dev/null
  sh "$retry" -- git push --atomic "$remote" "+$sha:$branch" "refs/tags/$tag:refs/tags/$tag"
elif [ "$at" = "$sha" ]; then
  echo "release-push: $tag already names $sha on $remote; not pushed again"
  sh "$retry" -- git push "$remote" "+$sha:$branch"
else
  echo "release-push: $tag on $remote names $at, this run built $sha: refusing to move a released tag" >&2
  exit 1
fi
