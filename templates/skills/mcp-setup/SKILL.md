---
name: mcp-setup
description: MCP server setup and troubleshooting
---

## Rules

1. **NEVER guess package names** → `npm info <name>` to verify before installing
2. **Validate before adding** → `npm info` → `npx -y <pkg> --help` → `claude mcp add`. Caveat: many MCP servers don't implement `--help` and just wait on stdio — wrap validation in `timeout 10 …` so it can't hang.
3. **Think UX upfront** → headless mode, timeouts, flags — ask user BEFORE installing
4. **Restarts**: `/mcp` can reconnect already-registered servers, but registering a NEW server requires a session restart. Get the config right the first time.

## Quick Facts

- Python servers: `claude mcp add <name> -- uvx <pkg>` — uvx launches PyPI packages over stdio, no venv management.
- Remote servers: `claude mcp add --transport http <name> <url>` (also `--transport sse` for legacy SSE servers).
- Scopes: `project` scope lives in `.mcp.json` at the repo root (checked in); `local` scope lives in `~/.claude.json` under that project's entry (NOT in the repo); `user` scope is global in `~/.claude.json`.
- Plugin-bundled servers get tool names `mcp__plugin_<plugin>_<server>__<tool>` — the full name must stay under the 64-char API limit, so keep plugin/server names short.

## Troubleshooting

1. `claude mcp list` for status
2. Run command manually to see error
3. `npm whoami` — fix stale token if needed
4. `npm info <pkg> deprecated` — check if abandoned

## Browser MCP (playwright/chrome-devtools)

- **"Browser is already in use … use --isolated"** = the persistent Chrome profile (`~/Library/Caches/ms-playwright-mcp/mcp-chrome-*` on macOS, `~/.cache/ms-playwright-mcp/mcp-chrome-*` on Linux) is locked by a stale `SingletonLock` symlink (often pointing at an unrelated regular Chrome pid). The MCP server refuses even after `browser_close`.
- **Fix without killing the user's Chrome**: if more than one browser MCP server is configured, each has its own profile — switch to the other server rather than `kill`ing the pid the lock points at (it may be the user's real browser). Stay with ONE browser server per session; alternating between two hits the lock again.
