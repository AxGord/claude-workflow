---
name: claude-code-config
---

# Claude Code Configuration Gotchas

## Permission Path Syntax (Critical)

**Single vs Double Slash**:
- `/path/to/file` = relative to settings file location
- `//path/to/file` = absolute filesystem path
- `~/path` = home directory (works in both)

**Common mistake**: Writing `Read(/tmp/**)` when you mean absolute path. Correct: `Read(//tmp/**)`.

**Pattern format must match tool signature**:
- Correct: `Read(//tmp/**)`, `Bash(npm run *)`
- Wrong: `Read(file_path://tmp/**)` — tool name only, no parameter labels

## Wildcard Matching

**Recursive vs Single Level**:
- `*` = matches single path segment (e.g., `*.txt` in current dir only)
- `**` = matches recursively (e.g., `**/*.txt` in all subdirs)

**Edge case**: `Bash(ls *)` may not match `ls -la ~/.claude/` due to tilde expansion timing and wildcard evaluation order.

## Rule Evaluation Order

**Deny always wins**:
1. Deny rules checked first (block regardless of anything else)
2. Allow rules checked second (permit if matched)
3. Ask rules checked last (prompt user)

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

**Deny rules not enforced**: Multiple reported issues (GH #13785, #6631, #4467, #6699) where deny patterns in settings.json are ignored. Tool still gets access despite explicit deny.

**Allow rules ignored**: Issue #18160 reports global allow permissions being ignored, requiring manual approval despite being in allowlist.

**Wildcard pattern bugs**: `Bash(command *)` patterns may fail to match commands with flags or tilde expansion.

## Domain-Specific Rules

**WebFetch requires domain syntax**:
- Correct: `WebFetch(domain:example.com)`
- Wrong: `WebFetch(https://example.com/*)` — use domain prefix, not URL patterns

## Common Pitfalls

**Overly broad wildcards**: Starting with `Bash(*)` or `Read(**)` creates security holes. Be specific.

**Forgetting .gitignore**: By default, Claude respects `.gitignore`. If files missing from suggestions, check ignore rules or set `respectGitignore: false`.

**Environment variables in Bash**: Don't persist between commands. Use `CLAUDE_ENV_FILE` or hooks instead.

**Testing permissions**: Use Shift+Tab to switch permission modes mid-session without editing files.

## Path Examples

```json
{
  "permissions": {
    "allow": [
      "Read(./.env)",              // relative: .env in settings file dir
      "Read(//tmp/**)",            // absolute: all files in /tmp
      "Read(~/.config/**)",        // home: all files in ~/.config
      "Read(**/.env)",             // recursive: .env anywhere in subtree
      "Bash(npm run *)",           // command prefix matching
      "WebFetch(domain:docs.anthropic.com)"  // domain-specific
    ],
    "deny": [
      "Read(**/secrets/**)",       // block entire directory tree
      "Bash(rm *)"                 // block dangerous commands
    ]
  }
}
```

## Debugging Permission Issues

1. Check hierarchy: local > project > user > enterprise
2. Check deny rules first (they always win)
3. Test pattern manually: Does it match the exact tool signature shown in prompt?
4. Check for known bugs (deny rules may be ignored)
5. Use `claude mcp list` to verify MCP server status if permission involves MCP tool

## Plugin Install Scope

`claude plugins install <pkg>@<marketplace>` takes `-s, --scope <user|project|local>` (default: `user`).

- `user` — global, ~/.claude/plugins/installed_plugins.json with `"scope": "user"`
- `project` — must run from within the target project dir; registry entry gets `"scope": "project"` + `"projectPath": "<cwd>"`. Plugin activates only when Claude Code runs inside that dir
- `local` — per-clone/session scope (rarely needed)

Swap scope = uninstall + reinstall (no in-place conversion):
```bash
claude plugins uninstall <pkg>@<mkt> --scope user
cd /path/to/project && claude plugins install <pkg>@<mkt> --scope project
```

All scopes share the same `~/.claude/plugins/cache/` payload — only the registry entry differs.

## npx Argument Re-parsing Under PreToolUse Hooks

PreToolUse Bash hooks that rewrite commands can mis-parse `npx -y <pkg>@latest <subcmd>`, with `<pkg>@latest` landing as an **npm** subcommand, producing `Unknown command: "<pkg>@latest"`.

Workaround: invoke through a wrapper that bypasses the rewriter (e.g. an explicit `proxy` subcommand of the hook tool, or call the binary directly without `npx -y`). The same `npx` call may succeed via workflow-engine exec while failing via Bash tool — the difference is whether the hook intercepts.
