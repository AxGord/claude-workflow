---
name: mcp-setup
description: MCP server setup and troubleshooting
---

## Rules

1. **NEVER guess package names** → `npm info <name>` to verify before installing
2. **Validate before adding** → `npm info` → `npx -y <pkg> --help` → `claude mcp add`
3. **Think UX upfront** → headless mode, timeouts, flags — ask user BEFORE installing
4. **Minimize restarts** → each MCP change = session restart. Get it right first time.

## Troubleshooting

1. `claude mcp list` for status
2. Run command manually to see error
3. `npm whoami` — fix stale token if needed
4. `npm info <pkg> deprecated` — check if abandoned
