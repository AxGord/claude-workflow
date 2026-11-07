#!/bin/sh
# PreToolUse(Bash): a call made by a read-only agent type (wf-recon, wf-reviewer) that would write is
# refused; the project's .claude/read-only-commands.json adds write commands and the env the CLI reads
# (APQ_READ_ONLY=1). Fast path, no node: a payload without an agent_type is the main session or a
# plain call — nothing to do. Never breaks the Bash call: no node / no build / a failing gate →
# the command passes as it is with one line on stderr.
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
