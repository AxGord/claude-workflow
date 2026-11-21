#!/bin/sh
# retry.sh — run a command again, with a pause, until it succeeds or the pauses run out.
#
# Usage: scripts/retry.sh [--delays "10 30 60"] -- CMD [ARG...]
#   --delays   the seconds to wait before each further attempt: N delays make N+1 attempts
#              (default $RETRY_DELAYS, else "10 30 60": 4 attempts)
# Exits with the command's own status on success or after the last attempt; 2 on a bad argument.
# For a step that talks to a remote that fails now and then (a git push to GitHub), not for a failure that repeats.

delays=${RETRY_DELAYS:-"10 30 60"}
while [ $# -gt 0 ]; do
  case $1 in
    --delays) [ $# -ge 2 ] || { echo "retry: --delays needs a list" >&2; exit 2; }; delays=$2; shift 2 ;;
    --) shift; break ;;
    *) echo "retry: unknown argument $1 (usage: retry.sh [--delays \"10 30 60\"] -- CMD...)" >&2; exit 2 ;;
  esac
done
[ $# -gt 0 ] || { echo "retry: no command" >&2; exit 2; }

attempt=1
for delay in $delays; do
  "$@" && exit 0
  rc=$?
  echo "retry: attempt $attempt failed (exit $rc): $*; next in ${delay}s" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
done
"$@"
rc=$?
[ "$rc" -eq 0 ] || echo "retry: attempt $attempt failed (exit $rc): $*; giving up" >&2
exit "$rc"
