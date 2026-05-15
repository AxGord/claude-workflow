#!/bin/bash
# SessionEnd hook: abandon this Claude Code instance's active workflow sessions
# (and their descendants), then cap retained terminal sessions so the state
# dir keeps only the most recent few for history — never grows unbounded.
# Skips sessions referenced in plan files (they should survive context clears).
# Modifies JSON files directly — does NOT depend on MCP server being alive.
read -t 1 -r INPUT
STATE_DIR="${STATE_DIR:-$HOME/.claude/workflow-state}"
PLANS_DIR="$HOME/.claude/plans"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
# Mirror of KEEP_TERMINAL_SESSIONS in src/types.ts
KEEP_TERMINAL=3
ABANDONED_SIDS=()

is_planned() {
  [ -d "$PLANS_DIR" ] && [ -n "$1" ] && grep -rqlF "$1" "$PLANS_DIR"/ 2>/dev/null
}

abandon() {
  local f="$1" event="${2:-abandon}" TMP="${f}.tmp"
  jq --arg now "$NOW" --arg event "$event" '
    .history += [{ frame: .active_frame, event: $event, at: $now }] |
    .stack = [] |
    .active_frame = -1 |
    .outcome = "abandoned" |
    .updated_at = $now
  ' "$f" > "$TMP" 2>/dev/null && mv "$TMP" "$f" || rm -f "$TMP"
}

for f in "$STATE_DIR"/*.json; do
  [ -f "$f" ] || continue
  SID=$(jq -r "select(.stack | length > 0) | select(.context.claude_code_pid == $PPID) | .session_id" "$f" 2>/dev/null)
  [ -n "$SID" ] || continue
  is_planned "$SID" && continue
  abandon "$f"
  ABANDONED_SIDS+=("$SID")
done

# Cascade: abandon children of abandoned sessions
cascade_abandon() {
  local parent_sid="$1"
  for f in "$STATE_DIR"/*.json; do
    [ -f "$f" ] || continue
    local child_sid
    child_sid=$(jq -r --arg pid "$parent_sid" 'select(.parent_session_id == $pid) | select(.stack | length > 0) | .session_id' "$f" 2>/dev/null)
    [ -n "$child_sid" ] || continue
    is_planned "$child_sid" && continue
    abandon "$f" cascade_abandon
    cascade_abandon "$child_sid"
  done
}

for sid in "${ABANDONED_SIDS[@]}"; do
  cascade_abandon "$sid"
done

# Cap retained terminal sessions: keep the KEEP_TERMINAL with the newest
# .updated_at, delete older ones. Full parity with Storage.pruneTerminal in
# src/storage.ts:
#   - sort by the JSON .updated_at field (not file mtime) — abandon() bumps
#     mtime via mv, so mtime order would diverge from the engine's retention;
#   - secondary sort by .session_id — cascade abandon stamps every child with
#     one identical .updated_at, so a stable tiebreak keeps the retained set
#     deterministic and identical to the engine;
#   - no is_planned guard here — terminal (empty-stack) sessions can never be
#     plan-referenced (plan resume requires an active stack), same invariant
#     the engine's pruneTerminal documents and relies on.
TERM_FILES=()
for f in "$STATE_DIR"/*.json; do
  [ -f "$f" ] || continue
  jq -e '.stack | length == 0' "$f" >/dev/null 2>&1 && TERM_FILES+=("$f")
done
if [ "${#TERM_FILES[@]}" -gt "$KEEP_TERMINAL" ]; then
  i=0
  while IFS=$'\t' read -r _ _ f; do
    i=$((i + 1))
    [ "$i" -le "$KEEP_TERMINAL" ] && continue
    rm -f "$f"
  done < <(
    for f in "${TERM_FILES[@]}"; do
      meta=$(jq -r '[.updated_at // "", .session_id // ""] | @tsv' "$f" 2>/dev/null)
      printf '%s\t%s\n' "$meta" "$f"
    done | sort -r -t $'\t' -k1,2
  )
fi
