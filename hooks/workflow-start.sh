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

ZED_SUFFIX=""
if [[ -n "$ZED_ENVIRONMENT" ]]; then
  ZED_SUFFIX=" Then load skill ide-zed (Skill tool)."
fi

# Everything below requires jq — without it, still emit the fresh-start prompt.
command -v jq >/dev/null 2>&1 || { echo "STOP. Call mcp__plugin_workflow_wf__start (no args) first.$ZED_SUFFIX"; exit 0; }

read -t 1 -r INPUT
SOURCE=$(echo "$INPUT" | jq -r '.source // empty')
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty')
HOOK_CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
# Physical path (pwd -P) so a symlinked cwd (e.g. /tmp → /private/tmp)
# compares equal to the engine's getcwd()-resolved context.cwd.
HOOK_CWD=$(cd "${HOOK_CWD:-$PWD}" 2>/dev/null && pwd -P || echo "$PWD")
STATE_DIR="${STATE_DIR:-$HOME/.claude/workflow-state}"
PLANS_DIR="$HOME/.claude/plans"

# Session IDs are 8 hex chars; the {7,} length filter skips shorter incidental hex words.
SID_RE='[a-f0-9]{7,}'

# --- Helper: apply a jq filter to a file in place (atomic tmp+rename) ---
# $$ makes the temp name unique per hook instance, so concurrent hooks
# cannot clobber each other's half-written temp files.
jq_inplace() {
  local filter="$1" f="$2" tmp="$2.tmp.$$"
  jq "$filter" "$f" 2>/dev/null > "$tmp" && mv "$tmp" "$f" || rm -f "$tmp"
}

# --- Helper: check <sid> refers to a live planning session ---
# Live = state file exists + top stack frame is "planning" + not abandoned.
validate_planning_session() {
  local sf="$STATE_DIR/$1.json"
  [ -f "$sf" ] || return 1
  jq -e '.outcome != "abandoned" and (.stack | length > 0) and .stack[-1].workflow == "planning"' "$sf" >/dev/null 2>&1
}

# --- Helper: increment skill_epoch in a session JSON by ID ---
bump_skill_epoch_by_id() {
  local sf="$STATE_DIR/$1.json"
  [ -f "$sf" ] || return
  jq_inplace '.skill_epoch = ((.skill_epoch // 0) + 1)' "$sf"
}

# --- Helper: increment skill_epoch in active sessions for current PID ---
bump_skill_epoch_by_pid() {
  [ -d "$STATE_DIR" ] || return
  # $PPID is the Claude Code process: hook commands run as single-command
  # `bash -c` invocations, which bash exec-optimizes (the shell replaces
  # itself), so no intermediate shell sits between this script and Claude Code.
  local cc_pid=$PPID
  for sf in "$STATE_DIR"/*.json; do
    [ -f "$sf" ] || continue
    local pid
    pid=$(jq -r '.context.claude_code_pid // empty' "$sf" 2>/dev/null)
    [ "$pid" = "$cc_pid" ] || continue
    jq_inplace 'if .stack | length > 0 then .skill_epoch = ((.skill_epoch // 0) + 1) else . end' "$sf"
  done
}

# --- Helper: find a live planning session for this project from plan files ---
# Only plans whose session context.cwd matches the hook's cwd are considered;
# candidates are checked newest-first by plan file mtime.
find_plan_session() {
  [ -d "$PLANS_DIR" ] || return
  local plan sid
  while IFS= read -r plan; do
    [ -f "$plan" ] || continue
    # Session ID from the ## Workflow section. -A5: the section contract is
    # 5 list lines after the heading (Session / Current state / After approve /
    # Execution workflow / Resume) — Session is always within that window.
    sid=$(grep -A5 '^## Workflow' "$plan" | grep 'Session' | grep -oE "$SID_RE" | head -1)
    [ -n "$sid" ] || continue
    validate_planning_session "$sid" || continue
    [ "$(jq -r '.context.cwd // empty' "$STATE_DIR/${sid}.json" 2>/dev/null)" = "$HOOK_CWD" ] || continue
    echo "$sid"
    return
  done < <(ls -t "$PLANS_DIR"/*.md 2>/dev/null)
}

# --- 1. clear/compact → same process, context lost ---
if [ "$SOURCE" = "clear" ] || [ "$SOURCE" = "compact" ]; then
  # Transcript grep is only used to recover the planning session hex;
  # validity is checked against the state file, not the transcript.
  if [ -n "$TRANSCRIPT" ] && grep -q 'ExitPlanMode' "$TRANSCRIPT" 2>/dev/null; then
    PLAN_SID=$(grep -oE 'transition\(\\"[a-f0-9]+\\"' "$TRANSCRIPT" | tail -1 | grep -oE "$SID_RE")
    if [ -n "$PLAN_SID" ] && validate_planning_session "$PLAN_SID"; then
      bump_skill_epoch_by_id "$PLAN_SID"
      echo "PLAN RESUME (same process): call transition(\"$PLAN_SID\", \"planned\") to resume planning session.$ZED_SUFFIX"
      exit 0
    fi
  fi
  bump_skill_epoch_by_pid
  echo "Context was cleared. Call status() to check for active session and restore context.$ZED_SUFFIX"
  exit 0
fi

# --- 2. startup/resume → new process ---
# Check plans/ for live planning sessions (cross-process plan resume)
PLAN_SID=$(find_plan_session)
if [ -n "$PLAN_SID" ]; then
  bump_skill_epoch_by_id "$PLAN_SID"
  echo "PLAN RESUME (new process): active planning session $PLAN_SID found. Call transition(\"$PLAN_SID\", \"planned\") to resume.$ZED_SUFFIX"
  exit 0
fi

# --- 3. Nothing found → fresh start ---
echo "STOP. Call mcp__plugin_workflow_wf__start (no args) first.$ZED_SUFFIX"
