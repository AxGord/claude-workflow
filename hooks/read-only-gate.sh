#!/bin/sh
# PreToolUse(Bash|Write): a Write by a read-only type is allowed only in the task's report directory; a Bash call made by a read-only agent type (workflow:recon, workflow:reviewer) is allowed only when
# every pipeline segment starts with a declared reader (an allow list), and refused when it would write; the
# project's .claude/read-only-commands.yaml adds readers (`read`), write commands (`write`) the variables a NAME=value prefix may set (`envAllowed`) and the env the
# CLI reads (`env`, e.g. APQ_READ_ONLY=1). A guard against accidental writes, not an adversary. Fast path,
# no node: a payload without an agent_type is the main session or a plain call — nothing to do. Never
# breaks the Bash or Write call: no node / no build / a failing gate → the command passes as it is with one
# line on stderr.
p=$(cat)
case $p in
  *'"agent_type":"'*) ;;
  *) exit 0 ;;
esac
root=$(cd "$(dirname "$0")/.." && pwd -P)
gate="$root/build/read-only-gate-hook.js"
if ! command -v node >/dev/null 2>&1; then
  echo "read-only-gate: node not found — command passes as is" >&2
  exit 0
fi
if [ ! -f "$gate" ]; then
  echo "read-only-gate: $gate missing (npm run build) — command passes as is" >&2
  exit 0
fi
out=$(printf '%s' "$p" | node "$gate") || {
  echo "read-only-gate: the gate failed — command passes as is" >&2
  exit 0
}
[ -z "$out" ] || printf '%s\n' "$out"
exit 0
