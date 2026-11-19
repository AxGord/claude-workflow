#!/bin/sh
# PreToolUse(Bash|Write|Edit|MultiEdit|NotebookEdit): an agent's write to the trust record
# ($STATE_DIR/trusted-workflows.json) or into the global workflows directory ($WORKFLOW_DIR,
# default ~/.claude/workflows) is answered `ask`, so the user confirms it. It only decides, never
# rewrites the call. Fast path, no node: with WORKFLOW_DIR unset, a payload that names neither
# `trusted-workflows` nor `workflows` cannot reach either place. Never breaks the call: no node /
# no build / a failing gate → the call passes as it is with one line on stderr.
p=$(cat)
if [ -z "${WORKFLOW_DIR:-}" ]; then
  case $p in
    *trusted-workflows*|*workflows*) ;;
    *) exit 0 ;;
  esac
fi
root=$(cd "$(dirname "$0")/.." && pwd -P)
gate="$root/build/trust-write-gate-hook.js"
if ! command -v node >/dev/null 2>&1; then
  echo "trust-write-gate: node not found — call passes as is" >&2
  exit 0
fi
if [ ! -f "$gate" ]; then
  echo "trust-write-gate: $gate missing (npm run build) — call passes as is" >&2
  exit 0
fi
out=$(printf '%s' "$p" | node "$gate") || {
  echo "trust-write-gate: the gate failed — call passes as is" >&2
  exit 0
}
[ -z "$out" ] || printf '%s\n' "$out"
exit 0
