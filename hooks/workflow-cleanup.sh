#!/bin/bash
# SessionEnd hook: abandon active workflow sessions for this Claude Code instance.
# Skips sessions referenced in plan files (they should survive context clears).
# Modifies JSON files directly — does NOT depend on MCP server / dashboard being alive.
read -t 1 -r INPUT
STATE_DIR="${STATE_DIR:-$HOME/.claude/workflow-state}"
PLANS_DIR="$HOME/.claude/plans"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
ABANDONED_SIDS=()

for f in "$STATE_DIR"/*.json; do
  [ -f "$f" ] || continue
  SID=$(jq -r "select(.stack | length > 0) | select(.context.claude_code_pid == $PPID) | .session_id" "$f" 2>/dev/null)
  [ -n "$SID" ] || continue
  # Skip if session referenced in plan files
  [ -d "$PLANS_DIR" ] && grep -rql "$SID" "$PLANS_DIR"/ 2>/dev/null && continue
  # Abandon: clear stack, set outcome, append history entry
  TMP="${f}.tmp"
  jq --arg now "$NOW" '
    .history += [{ frame: .active_frame, event: "abandon", at: $now }] |
    .stack = [] |
    .active_frame = -1 |
    .outcome = "abandoned" |
    .updated_at = $now
  ' "$f" > "$TMP" 2>/dev/null && mv "$TMP" "$f" || rm -f "$TMP"
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
    TMP="${f}.tmp"
    jq --arg now "$NOW" '
      .history += [{ frame: .active_frame, event: "cascade_abandon", at: $now }] |
      .stack = [] |
      .active_frame = -1 |
      .outcome = "abandoned" |
      .updated_at = $now
    ' "$f" > "$TMP" 2>/dev/null && mv "$TMP" "$f" || rm -f "$TMP"
    cascade_abandon "$child_sid"
  done
}

for sid in "${ABANDONED_SIDS[@]}"; do
  cascade_abandon "$sid"
done
