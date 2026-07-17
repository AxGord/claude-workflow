---
name: claude-code-config
description: Claude Code configuration gotchas — permission rule syntax and evaluation order, settings hierarchy, plugin install scopes, hook behavior
---

# Claude Code Configuration Gotchas

## Permission Path Syntax (Critical)

**Single vs Double Slash**:
- `/path/to/file` = relative to settings file location
- `//path/to/file` = absolute filesystem path
- `~/path` = home directory (works in both)

**Common mistake**: Writing `Read(/tmp/**)` when you mean absolute path. Correct: `Read(//tmp/**)`.

**Pattern format must match tool signature**:
- Correct: `Read(//tmp/**)`, `Bash(npm run:*)`
- Wrong: `Read(file_path://tmp/**)` — tool name only, no parameter labels

**Bash rules use `:*` for prefix matching**: `Bash(npm run:*)` matches any command starting with `npm run `. `Bash(npm run *)` (space-star) is NOT the prefix syntax and matches unreliably.

## Wildcard Matching

**Recursive vs Single Level**:
- `*` = matches single path segment (e.g., `*.txt` in current dir only)
- `**` = matches recursively (e.g., `**/*.txt` in all subdirs)

**Edge case**: `Bash(ls *)` may not match `ls -la ~/.claude/` due to tilde expansion timing and wildcard evaluation order.

## Rule Evaluation Order

**Deny always wins**:
1. Deny rules checked first (block regardless of anything else)
2. Ask rules checked second (prompt user if matched)
3. Allow rules checked last (permit if matched)

**First match wins** within each category.

**Common mistake**: Adding allow rule but deny rule exists elsewhere (user settings, enterprise managed-settings.json, or higher in hierarchy). Deny always overrides allow, even if allow is more specific.

## Settings File Hierarchy (Highest to Lowest Priority)

1. Enterprise `managed-settings.json` (cannot be overridden)
2. Command-line flags (`--dangerously-skip-permissions`)
3. Project `.claude/settings.local.json` (gitignored, per-developer)
4. Project `.claude/settings.json` (versioned, shared with team)
5. User `~/.claude/settings.json` (global for your machine)

**Gotcha**: Local settings override shared settings. If permission works for you but not teammate, check if you have conflicting `.local` file.

## Known Bugs (as of 2026)

**Allow rules ignored**: Issue #18160 reports global allow permissions being ignored, requiring manual approval despite being in allowlist.

## Domain-Specific Rules

**WebFetch requires domain syntax**:
- Correct: `WebFetch(domain:example.com)`
- Wrong: `WebFetch(https://example.com/*)` — use domain prefix, not URL patterns

## Common Pitfalls

**Overly broad wildcards**: Starting with `Bash(*)` or `Read(**)` creates security holes. Be specific.

**Environment variables in Bash**: Don't persist between commands. Use the `env` map in settings.json or hooks instead.

**Testing permissions**: Use Shift+Tab to switch permission modes mid-session without editing files.

## Path Examples

```json
{
  "permissions": {
    "allow": [
      "Read(./config.json)",       // relative: config.json in settings file dir
      "Read(//tmp/**)",            // absolute: all files in /tmp
      "Read(~/.config/**)",        // home: all files in ~/.config
      "Read(**/config.json)",      // recursive: config.json anywhere in subtree
      "Bash(npm run:*)",           // command prefix matching (:* suffix)
      "WebFetch(domain:docs.anthropic.com)"  // domain-specific
    ],
    "deny": [
      "Read(**/secrets/**)",       // block entire directory tree
      "Bash(rm:*)"                 // block dangerous commands
    ]
  }
}
```

## Debugging Permission Issues

1. Check hierarchy: local > project > user > enterprise
2. Check rule order: deny → ask → allow (deny always wins)
3. Test pattern manually: Does it match the exact tool signature shown in prompt?
4. Check for known bugs (allow rules may be ignored — #18160)
5. Use `claude mcp list` to verify MCP server status if permission involves MCP tool

## Plugin Install Scope

`claude plugin install <pkg>@<marketplace>` (singular `plugin`, not `plugins`) takes `-s, --scope <user|project|local>` (default: `user`).

- `user` — global, ~/.claude/plugins/installed_plugins.json with `"scope": "user"`
- `project` — must run from within the target project dir; registry entry gets `"scope": "project"` + `"projectPath": "<cwd>"`. Plugin activates only when Claude Code runs inside that dir
- `local` — per-clone/session scope (rarely needed)

Swap scope = uninstall + reinstall (no in-place conversion):
```bash
claude plugin uninstall <pkg>@<mkt> --scope user
cd /path/to/project && claude plugin install <pkg>@<mkt> --scope project
```

All scopes share the same `~/.claude/plugins/cache/` payload — only the registry entry differs.

## Stop Hook Fires Per Turn, Not on Process Exit

**Wrong assumption**: `Stop` hook = "CLI process is shutting down / session ending".
**Correct**: `Stop` fires **each time the main agent finishes responding** (end of every turn). One CLI process lifetime can trigger it dozens of times. Docs: *"when Claude finishes responding"* — [docs.claude.com/en/docs/claude-code/hooks](https://docs.claude.com/en/docs/claude-code/hooks).

`SubagentStop` fires when a subagent (Task tool) finishes — separate from the main agent's Stop.

**Practical implication**: Any state registered on `UserPromptSubmit` and released on `Stop` churns every turn. For per-process state (e.g. a background daemon, a lock file, an IPC socket) key by **CLI PID** — `session_id` is wrong because it also changes on `/clear`, `/compact`, or resume within the same process.

```
UserPromptSubmit → fires before each user turn
Stop             → fires after each assistant response (not at exit)
SubagentStop     → fires when a Task-tool subagent completes
PostToolUse      → fires after each individual tool call within a turn
```

## Capturing a Real Hook Payload

To see the exact JSON a hook receives, run headless claude with a dump hook — faster and more reliable than docs or grepping the compiled CLI binary:

```bash
# settings.json: {"hooks":{"Stop":[{"hooks":[{"type":"command","command":"cat > /tmp/stop-payload.json"}]}]}}
printf 'start a background sleep 180 via Bash run_in_background, reply done' \
  | claude -p --settings settings.json --allowedTools "Bash(sleep:*)"
```

Gotchas:
- Pass the prompt via **stdin** — the argument form can fail with `Error: Input must be provided either through stdin or as a prompt argument` when a PreToolUse rewriter hook mangles quoting.
- A nested `claude -p --dangerously-skip-permissions` gets denied by the auto-mode classifier; a narrow `--allowedTools "Bash(<cmd>:*)"` passes.

## Stop Hook `background_tasks` (v2.1.145+)

Entry shape: `{"id","type","status","description"}` + type-specific fields (`command` for shell, `agent_type` for subagent, `server`/`tool` for MCP). `type` ∈ shell | subagent | monitor | workflow | teammate | cloud session | MCP task.

- `id` is stable across Stop firings; there are **NO timestamps** or turn counters. Distinguishing "started this turn" from "long-lived since an earlier turn" (dev server, watcher) requires persisting seen ids between Stop firings yourself (state file keyed by `session_id`).
- Non-empty `background_tasks` ≠ new work in progress: a persistent dev server stays listed at EVERY Stop — a hook that suppresses on non-empty silences itself for the whole session.
- Only live tasks are listed (completed ones are removed), and `session_crons` entries also carry `id`.
- `prompt_id` (v2.1.196+) identifies the current prompt; `last_assistant_message` (v2.1.145+) holds the final text.
- JSON string values escape quotes as `\"`, so a naive grep for `"key":"` cannot false-match text inside `command`/`description` values.

## npx Argument Re-parsing Under PreToolUse Hooks

PreToolUse Bash hooks that rewrite commands can mis-parse `npx -y <pkg>@latest <subcmd>`, with `<pkg>@latest` landing as an **npm** subcommand, producing `Unknown command: "<pkg>@latest"`.

Workaround: invoke through a wrapper that bypasses the rewriter (e.g. an explicit `proxy` subcommand of the hook tool, or call the binary directly without `npx -y`). The same `npx` call may succeed via workflow-engine exec while failing via Bash tool — the difference is whether the hook intercepts.

## Multiple Hook Entries for the Same Event Run in Parallel

**Wrong assumption**: Two `PreToolUse` entries in `hooks.json` run in declaration order — first entry first, second entry second.
**Correct**: All entries for the same event fire **simultaneously**. Declaration order is not execution order.

**Race-condition trap**: If entry A writes a marker file and entry B deletes it, the outcome depends on timing, not position. A fast B (~0 ms) completes before a slow A (~30–50 ms), so A's delete wins even when B is declared last. Symptom: your write appears to have no effect.

**Fix**: One hook entry per event. Inspect stdin JSON inside that single script/command and branch on `tool_name` or other fields to dispatch logic. This guarantees deterministic ordering because it's a single process.
