#!/bin/sh
# PreToolUse(Agent|Task), SubagentStart, SubagentStop: refuse an Agent spawn once the project's
# `agents.max_live` (.claude/workflows/settings.json) agents of the session are live, and keep the count
# (a reservation at the spawn, the agent's own entry at its start, freed at its stop). It only decides,
# never rewrites the call. Fast path, no node: no settings.json naming `max_live` from the payload cwd up
# to the git root (a worktree, whose settings live in its main checkout, goes to node) → exit at once.
# Never breaks the call: no node / no build / a failing gate → the call passes as it is with one line on stderr.
p=$(cat)
case $p in
  *'"cwd":"'*) d=${p#*\"cwd\":\"}; d=${d%%\"*} ;;
  *) d= ;;
esac
case $d in
  *\\*) d= ;;
  /*) ;;
  *) d= ;;
esac
if [ -n "$d" ]; then
  while :; do
    if [ -f "$d/.claude/workflows/settings.json" ] && grep -q max_live "$d/.claude/workflows/settings.json" 2>/dev/null; then
      break
    fi
    [ -f "$d/.git" ] && break
    [ -e "$d/.git" ] && exit 0
    [ -z "$d" ] && exit 0
    d=${d%/*}
  done
fi
root=$(cd "$(dirname "$0")/.." && pwd -P)
gate="$root/build/agent-cap-hook.js"
if ! command -v node >/dev/null 2>&1; then
  echo "agent-cap-gate: node not found — call passes as is" >&2
  exit 0
fi
if [ ! -f "$gate" ]; then
  echo "agent-cap-gate: $gate missing (npm run build) — call passes as is" >&2
  exit 0
fi
out=$(printf '%s' "$p" | node "$gate") || {
  echo "agent-cap-gate: the gate failed — call passes as is" >&2
  exit 0
}
[ -z "$out" ] || printf '%s\n' "$out"
exit 0
