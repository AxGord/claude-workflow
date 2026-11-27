#!/bin/sh
# PreToolUse(Bash|Write|Edit|MultiEdit): an agent's hand edit of a queue file (a `.yaml` / `.yml`
# file in a `.claude/batch/` directory, or one with a `batch_size:` header and a `tasks:` list) is
# denied with the names of the tools that write it (`queue_add` / `queue_edit` / `queue_mark` /
# `queue_header`, `wf-queue`). A read passes; the engine's own writers are no Edit / Write call. It
# only decides, never rewrites the call. Fast path, no node: a payload that names no `.yaml` / `.yml`
# file cannot reach a queue file. Never breaks the call: no node / no build / a failing gate → the
# call passes as it is with one line on stderr.
p=$(cat)
case $p in
  *.yaml*|*.yml*|*.YAML*|*.YML*) ;;
  *) exit 0 ;;
esac
root=$(cd "$(dirname "$0")/.." && pwd -P)
gate="$root/build/queue-write-gate-hook.js"
if ! command -v node >/dev/null 2>&1; then
  echo "queue-write-gate: node not found — call passes as is" >&2
  exit 0
fi
if [ ! -f "$gate" ]; then
  echo "queue-write-gate: $gate missing (npm run build) — call passes as is" >&2
  exit 0
fi
out=$(printf '%s' "$p" | node "$gate") || {
  echo "queue-write-gate: the gate failed — call passes as is" >&2
  exit 0
}
[ -z "$out" ] || printf '%s\n' "$out"
exit 0
