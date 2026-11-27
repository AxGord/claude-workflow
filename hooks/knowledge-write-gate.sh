#!/bin/sh
# PreToolUse(Bash|Write|Edit|MultiEdit): the creation of a new memory file under
# <~/.claude>/projects/*/memory/ is denied (or asked) unless its frontmatter carries a
# `why-memory: 7|6 <reason>` line, in a project whose .claude/workflows/settings.json sets
# `memory_write_gate: "deny"|"ask"` (absent = off). An edit of an existing file is not gated. It only
# decides, never rewrites the call. Fast path, no node: a payload that does not contain `memory`
# cannot reach a memory directory. Never breaks the call: no node / no build / a failing gate → the
# call passes as it is with one line on stderr.
p=$(cat)
case $p in
  *memory*) ;;
  *) exit 0 ;;
esac
root=$(cd "$(dirname "$0")/.." && pwd -P)
gate="$root/build/knowledge-write-gate-hook.js"
if ! command -v node >/dev/null 2>&1; then
  echo "knowledge-write-gate: node not found — call passes as is" >&2
  exit 0
fi
if [ ! -f "$gate" ]; then
  echo "knowledge-write-gate: $gate missing (npm run build) — call passes as is" >&2
  exit 0
fi
out=$(printf '%s' "$p" | node "$gate") || {
  echo "knowledge-write-gate: the gate failed — call passes as is" >&2
  exit 0
}
[ -z "$out" ] || printf '%s\n' "$out"
exit 0
