# Workflow sessions for a Claude Code status line — SOURCE this file from your statusline script:
#
#   . /path/to/mcp-workflow-engine/scripts/statusline-workflows.sh
#   # line 1: … ${wf_info}      (the root session, inline)
#   # then:   [ -n "$wf_lines" ] && printf "%b\n" "$wf_lines"
#
# Sets two variables (printf %b escapes):
#   wf_info  — the root session of THIS Claude Code instance (its MCP engine's sessions only, matched by
#              context.claude_code_pid == the statusline's parent pid); alone it is drawn like any session,
#              with children it is marked ◆ in bold.
#   wf_lines — the other sessions, oldest first, three per line, at most six (five and "+N" past six).
# Bright cyan ⚙ = a leaf an agent or an engine step is working in; plain cyan ⚙ = waiting (on a child or idle).
# Needs jq. STATUSLINE_PID overrides the parent pid (for testing).
wf_info=""
wf_lines=""
wf_state_dir="${WF_STATE_DIR:-$HOME/.claude/workflow-state}"
if [ -d "$wf_state_dir" ]; then
  wf_list=$(jq -r -s --arg pid "${STATUSLINE_PID:-$PPID}" '
    [ .[] | select((.stack | length) > 0 and ((.context.claude_code_pid // 0) | tostring) == $pid) ]
    | ([ .[].parent_session_id // empty ]) as $parents
    | [ .[] | { at: (.started_at // .updated_at // ""),
          kind: (if (.parent_session_id // "") == "" then "R"
                 elif (.session_id as $s | $parents | index($s)) == null
                      and ((.agent_id // "") != "" or .running_exec != null) then "A" else "I" end),
          wf: (.stack[.active_frame].workflow // "?"),
          st: (.stack[.active_frame].current_state // "?"),
          tag: (.context.slice // .context.task
                // ((.context.cwd // "") | capture("/(?:\\.wt/[^/]+|tmp/hxqb-|tmp/wf-)/?(?<id>[A-Za-z0-9-]+)$").id)
                // "") } ]
    | sort_by(.at) | (map(select(.kind == "R")) + map(select(.kind != "R"))) | .[]
    | "\(.kind)\t\(.wf)\(if .tag != "" then "[\(.tag)]" else "" end):\(.st)"
  ' "$wf_state_dir"/*.json 2>/dev/null)
  wf_rest=$(printf '%s\n' "$wf_list" | grep -v '^R' | grep -v '^$')
  # R = root with children (marked), A = working leaf, anything else = waiting
  wf_paint='BEGIN { FS = "\t" }
    $1 == "R" { print "\\033[1;96m\\xE2\\x97\\x86 " $2 "\\033[0m"; next }
    $1 == "A" { print "\\033[96m\\xE2\\x9A\\x99 " $2 "\\033[0m"; next }
              { print "\\033[36m\\xE2\\x9A\\x99 " $2 "\\033[0m" }'
  wf_roots=$(printf '%s\n' "$wf_list" | grep '^R')
  if [ -n "$wf_roots" ] && [ -z "$wf_rest" ]; then
    # alone: drawn like any session — a working one bright, nothing marked
    wf_info=$(printf '%s\n' "$wf_roots" | sed 's/^R/A/' | awk "$wf_paint" | paste -sd ' ' -)
  elif [ -n "$wf_roots" ]; then
    wf_info=$(printf '%s\n' "$wf_roots" | awk "$wf_paint" | paste -sd ' ' -)
  elif [ -n "$wf_rest" ]; then
    # no root of this instance: the first session takes the inline place
    wf_info=$(printf '%s\n' "$wf_rest" | head -n 1 | awk "$wf_paint")
    wf_rest=$(printf '%s\n' "$wf_rest" | sed '1d')
  fi
  wf_n=0
  [ -n "$wf_rest" ] && wf_n=$(printf '%s\n' "$wf_rest" | wc -l | tr -d ' ')
  if [ "$wf_n" -gt 0 ]; then
    wf_shown=6
    [ "$wf_n" -gt 6 ] && wf_shown=5
    wf_items=$(printf '%s\n' "$wf_rest" | head -n "$wf_shown" | awk "$wf_paint")
    [ "$wf_n" -gt 6 ] && wf_items="${wf_items}
\\033[36m+$((wf_n - wf_shown)) workflows\\033[0m"
    wf_lines=$(printf '%s\n' "$wf_items" | awk '{ printf "%s%s", (NR == 1 ? "" : (NR % 3 == 1 ? "\\n" : "  ")), $0 }')
  fi
fi
