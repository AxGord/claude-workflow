---
name: debug-bridge-scaffold
description: Meta-skill for creating debug bridges for new technologies
---

# Debug Bridge Scaffold

## When to Use

When you need runtime inspection of an application built with a technology that has no existing debug bridge.

## Step 1: Check Existing Solutions First

Before building a custom bridge, check if a standard tool already works:

| Technology | Existing Solution |
|-----------|-------------------|
| Web/Electron/browser apps | Playwright MCP, browser DevTools |
| Native apps with standard UI toolkit | Accessibility API MCP |
| Any app with visible UI | Computer Use (screenshot + click) |
| OpenFL/hxcpp | `debug-bridge-openfl` skill (already exists) |

**If an existing solution covers your needs — use it. Don't build a bridge.**

## Step 2: Build a Custom Bridge

If no existing tool works, create an HTTP bridge following this pattern:

### Architecture

```
[Background Thread] HTTP Server (127.0.0.1:PORT)
    ↓ accept()
[Worker Thread] Parse request → dispatch to main thread
    ↓ runOnMainThread(fn)
[Main Thread] Execute handler → return result
    ↑ result via Lock/Mutex
[Worker Thread] Send HTTP response
```

### Required Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/ping` | GET | Health check |
| `/screenshot` | GET | Capture visual state → save to /tmp → return path |
| `/shutdown` | POST | Graceful exit |

### Framework-Specific Endpoints

Add endpoints relevant to the technology:
- **UI frameworks**: display tree, component inspection, event simulation
- **Game engines**: scene graph, entity list, physics state
- **Servers**: request log, connection pool, cache state

### Implementation Checklist

1. HTTP server on background thread (127.0.0.1 only — no external access)
2. Main-thread dispatch for all UI/rendering operations
3. JSON envelope: `{"ok": true, "data": ...}` / `{"ok": false, "error": "..."}`
4. Conditional compilation (only in debug builds)
5. Graceful shutdown (close socket, flush stdout, exit)

## Step 3: Create a Tech-Specific Skill

After building the bridge, create `~/.claude/skills/debug-bridge-<tech>/SKILL.md` with:

1. Build command with the debug flag
2. Binary path pattern
3. All endpoints with parameters and example responses
4. Technology-specific gotchas (threading, rendering pipeline, etc.)

Register it in `coding-skill-selector` under the appropriate domain.

## Step 4: Create an Interactive Debugger Agent

Create `~/.claude/agents/interactive-<tech>-debugger.md` with pre-loaded skills:

```yaml
---
name: interactive-<tech>-debugger
description: <Tech> debug agent with visual debug bridge — ...
tools: Read, Glob, Grep, Bash, Skill
model: sonnet
skills:
  - debugging
  - debug-bridge
  - debug-bridge-<tech>
  - <app-specific-interactive-debug-skill if exists>
---
```

Body: describe the debug loop for the agent — PID tracking, separate build and run steps, timeout rules.

Then update:
1. `task-delegation` — add agent to Available Agents table and routing rules
2. `testing` — reference the new agent for integration verification
3. `debugging` — reference the new agent in Step 4 (Debug Bridge)
