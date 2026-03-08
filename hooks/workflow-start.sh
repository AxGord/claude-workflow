#!/bin/bash
# SessionStart hook: detect context (new session / plan resume / context clear)
# and instruct agent accordingly.

# --- 0. Ensure base skills exist ---
# lang-* skills are dependencies of coding-skill-selector — only copied together with it.
# If user deletes a lang-* skill, it stays deleted until coding-skill-selector is also removed.
SKILLS_SRC="${CLAUDE_PLUGIN_ROOT}/templates/skills"
SKILLS_DST="$HOME/.claude/skills"
if [ -d "$SKILLS_SRC" ]; then
  mkdir -p "$SKILLS_DST"
  COPY_LANG=false
  [ ! -d "$SKILLS_DST/coding-skill-selector" ] && COPY_LANG=true
  for skill_dir in "$SKILLS_SRC"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    if [ "$COPY_LANG" = false ] && [[ "$skill_name" == lang-* ]]; then continue; fi
    if [ ! -d "$SKILLS_DST/$skill_name" ]; then
      cp -r "$skill_dir" "$SKILLS_DST/$skill_name"
    fi
  done
fi

read -t 1 -r INPUT
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
STATE_DIR="${STATE_DIR:-$HOME/.claude/workflow-state}"
PLANS_DIR="$HOME/.claude/plans"

ZED_SUFFIX=""
if [[ -n "$ZED_ENVIRONMENT" ]]; then
  ZED_SUFFIX=" Then load skill ide-zed (Skill tool)."
fi

# --- Helper: increment skill_epoch in a session JSON by ID ---
bump_skill_epoch_by_id() {
  local sid="$1"
  local sf="$STATE_DIR/${sid}.json"
  [ -f "$sf" ] || return
  jq '.skill_epoch = ((.skill_epoch // 0) + 1)' "$sf" 2>/dev/null > "${sf}.tmp" && mv "${sf}.tmp" "$sf" || rm -f "${sf}.tmp"
}

# --- Helper: increment skill_epoch in active sessions for current PID ---
bump_skill_epoch_by_pid() {
  [ -d "$STATE_DIR" ] || return
  local cc_pid=$PPID
  for sf in "$STATE_DIR"/*.json; do
    [ -f "$sf" ] || continue
    local pid
    pid=$(jq -r '.context.claude_code_pid // empty' "$sf" 2>/dev/null)
    [ "$pid" = "$cc_pid" ] || continue
    jq 'if .stack | length > 0 then .skill_epoch = ((.skill_epoch // 0) + 1) else . end' "$sf" 2>/dev/null > "${sf}.tmp" && mv "${sf}.tmp" "$sf" || rm -f "${sf}.tmp"
  done
}

# --- Helper: find active planning session from plan files ---
find_plan_session() {
  [ -d "$PLANS_DIR" ] || return
  for plan in "$PLANS_DIR"/*.md; do
    [ -f "$plan" ] || continue
    # Extract session ID from ## Workflow section (Session line: `<hex>`)
    local sid
    sid=$(grep -A5 '^## Workflow' "$plan" | grep 'Session' | grep -oE '[a-f0-9]{7,}' | head -1)
    [ -n "$sid" ] || continue
    # Check if this session is active and in planning state
    local state_file="$STATE_DIR/${sid}.json"
    [ -f "$state_file" ] || continue
    local wf
    wf=$(jq -r 'select(.stack | length > 0) | .stack[-1].workflow // empty' "$state_file" 2>/dev/null)
    if [ "$wf" = "planning" ]; then
      echo "$sid"
      return
    fi
  done
}

# --- 1. Transcript exists and has content → same process ---
if [ -n "$TRANSCRIPT" ] && [ -s "$TRANSCRIPT" ]; then
  # Check for ExitPlanMode → plan resume after context clear
  if grep -q 'ExitPlanMode' "$TRANSCRIPT" 2>/dev/null; then
    PLAN_SID=$(grep -oE 'transition\(\\"[a-f0-9]+\\"' "$TRANSCRIPT" | tail -1 | grep -oE '[a-f0-9]{7,}')
    if [ -n "$PLAN_SID" ]; then
      bump_skill_epoch_by_id "$PLAN_SID"
      echo "PLAN RESUME (same process): call transition(\"$PLAN_SID\", \"planned\") to resume planning session.$ZED_SUFFIX"
      exit 0
    fi
  fi
  # Has content but no plan → context clear
  bump_skill_epoch_by_pid
  echo "Context was cleared. Call status() to check for active session and restore context.$ZED_SUFFIX"
  exit 0
fi

# --- 2. Transcript empty or missing → new process ---
# Check plans/ for active planning sessions (cross-process plan resume)
PLAN_SID=$(find_plan_session)
if [ -n "$PLAN_SID" ]; then
  bump_skill_epoch_by_id "$PLAN_SID"
  echo "PLAN RESUME (new process): active planning session $PLAN_SID found. Call transition(\"$PLAN_SID\", \"planned\") to resume.$ZED_SUFFIX"
  exit 0
fi

# --- 3. Nothing found → fresh start ---
echo "STOP. Call mcp__plugin_workflow_wf__start (no args) first.$ZED_SUFFIX"
