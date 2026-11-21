#!/bin/sh
# release-tree.sh — the tree a git-sourced plugin install gets: a commit's committed files plus the runtime build.
#
# Usage: scripts/release-tree.sh --dir DIR [--rev REV]
#        scripts/release-tree.sh --commit [--rev REV] [--message TEXT]
#   --dir DIR      write the tree into DIR (an empty or missing directory)
#   --commit       write a commit whose parent is REV and whose tree is REV's tree plus build/; print its id
#                  (no ref moves, the working tree and the index stay as they are; author, committer and dates are
#                  REV's own, so the same REV makes the same commit id on every run: a re-run of a release can
#                  tell that the tag it finds already names this commit)
#   --rev REV      the commit whose committed files are the base (default HEAD)
#
# Claude Code never builds at install: it copies the files and installs the dependencies from package-lock.json with
# install scripts off. So the commit a git source names must already hold build/. master keeps no built files; the
# publish workflow calls this after `npm publish` and pushes the commit as branch `release`.
# What build/ holds here is what runs: the `.js` files only (no `.d.ts`, `.d.ts.map`, `.js.map`), compiled from the
# base commit's own sources into a temporary directory, so the checkout's build/ is neither read nor changed.
# Needs node_modules (the TypeScript compiler) in the checkout this script is in.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
dir= mode= rev=HEAD msg=
while [ $# -gt 0 ]; do
  case $1 in
    --dir) [ $# -ge 2 ] || { echo "release-tree: --dir needs a directory" >&2; exit 2; }; mode=dir; dir=$2; shift 2 ;;
    --commit) mode=commit; shift ;;
    --rev) [ $# -ge 2 ] || { echo "release-tree: --rev needs a revision" >&2; exit 2; }; rev=$2; shift 2 ;;
    --message) [ $# -ge 2 ] || { echo "release-tree: --message needs a text" >&2; exit 2; }; msg=$2; shift 2 ;;
    -h|--help) sed -n '2,/^# Needs/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "release-tree: unknown argument $1 (see --help)" >&2; exit 2 ;;
  esac
done
[ -n "$mode" ] || { echo "release-tree: --dir DIR or --commit (see --help)" >&2; exit 2; }
git -C "$root" rev-parse --verify -q "$rev^{commit}" >/dev/null || { echo "release-tree: $rev is not a commit" >&2; exit 2; }
sha=$(git -C "$root" rev-parse "$rev^{commit}")
[ -n "$msg" ] || msg="Release build of $(git -C "$root" rev-parse --short "$sha")"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/release-tree.XXXXXX")
trap 'rm -rf "$tmp"' EXIT INT TERM HUP

# The base commit's sources, compiled as they are committed (a dirty checkout never leaks in).
mkdir "$tmp/src-tree"
git -C "$root" archive "$sha" | tar -x -C "$tmp/src-tree"
ln -s "$root/node_modules" "$tmp/src-tree/node_modules"
(cd "$tmp/src-tree" && node node_modules/typescript7/bin/tsc --outDir "$tmp/build" \
  --declaration false --declarationMap false --sourceMap false) >&2
[ -f "$tmp/build/index.js" ] || { echo "release-tree: the build left no build/index.js" >&2; exit 1; }

if [ "$mode" = dir ]; then
  mkdir -p "$dir"
  git -C "$root" archive "$sha" | tar -x -C "$dir"
  rm -rf "$dir/build"
  cp -R "$tmp/build" "$dir/build"
  exit 0
fi

export GIT_INDEX_FILE="$tmp/index"
git -C "$root" read-tree "$sha"
(cd "$tmp/build" && find . -type f | sed 's|^\./||' | LC_ALL=C sort) >"$tmp/files"
git -C "$root" rm -r -q --cached --ignore-unmatch -- build >/dev/null
while IFS= read -r f; do
  blob=$(git -C "$root" hash-object -w "$tmp/build/$f")
  mode_bits=100644
  [ -x "$tmp/build/$f" ] && mode_bits=100755
  git -C "$root" update-index --add --cacheinfo "$mode_bits,$blob,build/$f"
done <"$tmp/files"
tree=$(git -C "$root" write-tree)
# Identity and dates come from the base commit, never from git's config or the clock: the commit id is a function of
# the base commit (and the build, which is deterministic for the same sources and compiler).
meta() { git -C "$root" log -1 --format="$1" "$sha"; }
GIT_AUTHOR_NAME=$(meta %an) GIT_AUTHOR_EMAIL=$(meta %ae) GIT_AUTHOR_DATE=$(meta %aI)
GIT_COMMITTER_NAME=$(meta %cn) GIT_COMMITTER_EMAIL=$(meta %ce) GIT_COMMITTER_DATE=$(meta %cI)
export GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_AUTHOR_DATE GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_COMMITTER_DATE
git -C "$root" commit-tree "$tree" -p "$sha" -m "$msg"
