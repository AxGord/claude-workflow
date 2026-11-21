#!/bin/sh
# npm-publish.sh — publish to npm and wait until the registry shows the version; safe to run again.
#
# Usage: scripts/npm-publish.sh PACKAGE VERSION -- CMD [ARG...]      (CMD is the publish command)
# 1. runs CMD. A refusal because the version already exists ("cannot publish over the previously published
#    versions") counts as published: an earlier run published it and `npm view` had not yet shown it.
#    Any other failure fails the script with the command's status.
# 2. waits until `npm view PACKAGE@VERSION version` answers VERSION: a fresh publish answers 404 for minutes.
#    Exit 1 when that does not happen in time.
# Env: NPM_PUBLISH_WAIT (seconds to wait, default 600), NPM_PUBLISH_POLL (seconds between reads, default 15).

[ $# -ge 4 ] && [ "$3" = -- ] || { echo "npm-publish: usage: npm-publish.sh PACKAGE VERSION -- CMD..." >&2; exit 2; }
pkg=$1 version=$2
shift 3
wait=${NPM_PUBLISH_WAIT:-600}
poll=${NPM_PUBLISH_POLL:-15}

out=$(mktemp "${TMPDIR:-/tmp}/npm-publish.XXXXXX")
trap 'rm -f "$out"' EXIT INT TERM HUP
if "$@" >"$out" 2>&1; then
  cat "$out"
else
  rc=$?
  cat "$out"
  if grep -Eqi 'cannot publish over|previously published version' "$out"; then
    echo "npm-publish: $pkg@$version is already published; waiting for the registry to show it"
  else
    exit "$rc"
  fi
fi

start=$(date +%s)
while :; do
  if [ "$(npm view "$pkg@$version" version 2>/dev/null)" = "$version" ]; then
    echo "npm-publish: $pkg@$version is visible on the registry"
    exit 0
  fi
  [ $(( $(date +%s) - start )) -lt "$wait" ] || break
  sleep "$poll"
done
echo "npm-publish: $pkg@$version is not visible after ${wait}s (the publish itself succeeded or was refused as a duplicate; run the workflow again)" >&2
exit 1
