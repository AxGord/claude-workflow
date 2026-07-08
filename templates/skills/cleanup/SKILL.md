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

For each remaining `memory/MEMORY.md`:
1. Read its contents
2. Check each entry against existing skills — is it already covered?
3. Check if Claude already knows this without any skill
4. Present table to user:

| Entry | Duplicates? | Verdict |
|---|---|---|
| ... | skill X / common knowledge / project-specific | delete / keep |

Only modify after user approval.

### Other cleanable files

Also check and report sizes of:
- `~/.claude/history.jsonl` — conversation history (can be large)
- `~/.claude/file-history/` — file change history
- `~/.claude/paste-cache/` — clipboard cache
- `~/.claude/tasks/` — task data

These are less critical. Mention sizes, let user decide.
