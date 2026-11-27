---
name: cleanup
description: Clean .claude directory data
---

## .claude directory cleanup

Run steps in order. **Ask user confirmation before each step.**

### Step 1: Temp data (always safe)

Delete contents of (keep directories themselves):
- `~/.claude/debug/` — session debug logs
- `~/.claude/shell-snapshots/` — zsh state snapshots
- `~/.claude/todos/` — task lists from past sessions
- `~/.claude/plans/` — plan files from past sessions

Show size before/after.

### Step 2: Project session logs

For each project in `~/.claude/projects/`:
- **DELETE**: `*.jsonl` files (conversation logs), `UUID/` directories (session caches), `agent-*.jsonl` (subagent logs)
- **KEEP**: `memory/` directory, `CLAUDE.md` file

⚠️ This breaks `/resume` for old sessions. Warn user.

Show size before/after.

### Step 3: Empty project directories

After step 2, list projects that have no remaining files (no memory/, no CLAUDE.md).
Offer to remove them — they recreate automatically when Claude Code runs in that project.

### Step 4: Memory audit

Load the `knowledge-placement` skill. For each remaining `memory/MEMORY.md`:
1. Read its contents
2. Give each entry the first row of the skill's table that fits (the project's
   own map, if its CLAUDE.md names one, refines the rows)
3. Present table to user:

| Entry | Row | Verdict |
|---|---|---|
| ... | 1-7 | keep in memory (row 6 or 7) / move to row N / delete (status or log, or common knowledge) |

Only modify after user approval.

### Other cleanable files

Also check and report sizes of:
- `~/.claude/history.jsonl` — conversation history (can be large)
- `~/.claude/file-history/` — file change history
- `~/.claude/paste-cache/` — clipboard cache
- `~/.claude/tasks/` — task data

These are less critical. Mention sizes, let user decide.
