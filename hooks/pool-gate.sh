#!/bin/sh
# PreToolUse(Bash): run a command the project's .claude/workflows/pool-gate.json marks heavy
# under scripts/wf-run (one machine-wide thread pool), refuse one it denies, pass the rest.
# Never breaks the Bash call: without node or a build, or when the gate itself fails, the
# command passes as it is with one line on stderr.
p=$(cat)
# Fast path, no process spawned: no pool-gate.json from the payload's cwd up to the git root
# → nothing to do. A cwd this cannot read plainly (escapes, another JSON layout) goes to node.
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
    [ -f "$d/.claude/workflows/pool-gate.json" ] && break
    [ -e "$d/.git" ] && exit 0
    [ -z "$d" ] && exit 0
    d=${d%/*}
  done
fi
root=$(cd "$(dirname "$0")/.." && pwd -P)
gate="$root/build/pool-gate-hook.js"
if ! command -v node >/dev/null 2>&1; then
  echo "pool-gate: node not found — command passes as is" >&2
  exit 0
fi
if [ ! -f "$gate" ]; then
  echo "pool-gate: $gate missing (npm run build) — command passes as is" >&2
  exit 0
fi
out=$(printf '%s' "$p" | node "$gate") || {
  echo "pool-gate: the gate failed — command passes as is" >&2
  exit 0
}
[ -z "$out" ] || printf '%s\n' "$out"
exit 0
