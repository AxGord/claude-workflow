#!/bin/bash
# SessionEnd hook: SUSPEND this Claude Code instance's active workflow sessions
# and their active descendants — stack, context and children stay, no ledger
# line (the session has not ended): `claude --resume` (or another process)
# continues them with the `resume` tool. Each is stamped with the id of the
# conversation that is ending, which the SessionStart hook of a resume lists
# by. The server abandons a session left suspended past its TTL. Then cap
# retained terminal sessions so the state dir never grows unbounded.
# Modifies JSON files directly — does NOT depend on MCP server being alive.
read -t 1 -r INPUT
STATE_DIR="${STATE_DIR:-$HOME/.claude/workflow-state}"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
# Mirror of KEEP_TERMINAL_SESSIONS in src/types.ts
KEEP_TERMINAL=3

# This instance's markers (hooks/workflow-start.sh) die with it.
rm -f "$STATE_DIR/context-epoch-$PPID" "$STATE_DIR/claude-session-$PPID"
CONVERSATION=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)

suspend() {
  local f="$1" TMP="${1}.tmp.$$"
  jq --arg now "$NOW" --arg conv "$CONVERSATION" '
    .history += [{ frame: .active_frame, event: "suspend", at: $now }] |
    .suspended_at = $now |
    (if $conv != "" then .claude_session_id = $conv else . end) |
    .updated_at = $now
  ' "$f" > "$TMP" 2>/dev/null && mv "$TMP" "$f" || rm -f "$TMP"
}

SUSPENDED_SIDS=()
for f in "$STATE_DIR"/*.json; do
  [ -f "$f" ] || continue
  SID=$(jq -r "select(.stack | length > 0) | select(.suspended_at == null) | select(.context.claude_code_pid == $PPID) | .session_id" "$f" 2>/dev/null)
  [ -n "$SID" ] || continue
  suspend "$f"
  SUSPENDED_SIDS+=("$SID")
done

# Cascade: active children of suspended sessions (whatever process owns them)
cascade_suspend() {
  local parent_sid="$1"
  for f in "$STATE_DIR"/*.json; do
    [ -f "$f" ] || continue
    local child_sid
    child_sid=$(jq -r --arg pid "$parent_sid" 'select(.parent_session_id == $pid) | select(.stack | length > 0) | select(.suspended_at == null) | .session_id' "$f" 2>/dev/null)
    [ -n "$child_sid" ] || continue
    suspend "$f"
    cascade_suspend "$child_sid"
  done
}

for sid in "${SUSPENDED_SIDS[@]}"; do
  cascade_suspend "$sid"
done

# Cap retained terminal sessions: keep the KEEP_TERMINAL with the newest
# .updated_at, delete older ones. Full parity with Storage.pruneTerminal in
# src/storage.ts:
#   - sort by the JSON .updated_at field (not file mtime) — a rewrite bumps
#     mtime via mv, so mtime order would diverge from the engine's retention;
#   - secondary sort by .session_id — the engine's cascade abandon stamps every
#     child with one identical .updated_at, so a stable tiebreak keeps the
#     retained set deterministic and identical to the engine;
#   - no is_planned guard here — terminal (empty-stack) sessions can never be
#     plan-referenced (plan resume requires an active stack), same invariant
#     the engine's pruneTerminal documents and relies on.
TERM_FILES=()
for f in "$STATE_DIR"/*.json; do
  [ -f "$f" ] || continue
  # `.stack == []` (not `length == 0`) — a file without a .stack array is a
  # placeholder, not a terminal session, and must not be pruned.
  jq -e '.stack == []' "$f" >/dev/null 2>&1 && TERM_FILES+=("$f")
done
if [ "${#TERM_FILES[@]}" -gt "$KEEP_TERMINAL" ]; then
  i=0
  while IFS= read -r f; do
    i=$((i + 1))
    [ "$i" -le "$KEEP_TERMINAL" ] && continue
    rm -f "$f"
  done < <(
    for f in "${TERM_FILES[@]}"; do
      meta=$(jq -r '[.updated_at // "", .session_id // ""] | @tsv' "$f" 2>/dev/null)
      # Path goes FIRST: empty meta fields would collapse under IFS splitting,
      # shifting the path into the wrong column.
      printf '%s\t%s\n' "$f" "$meta"
    done | LC_ALL=C sort -r -t $'\t' -k2,3 | awk -F'\t' '{print $1}'
  )
fi
