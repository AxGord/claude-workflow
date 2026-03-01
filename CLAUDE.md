# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A Claude Code plugin that provides structured workflow orchestration for AI agents via finite-state machines. Bundles an MCP server + SessionStart/SessionEnd hooks. Agents call MCP tools (`start`, `transition`, etc.) to follow state-driven processes. The engine tracks state, enforces guards (max_transitions, max_visits), and manages nested sub-workflow stacks.

Transport: stdio. Packaged as a Claude Code plugin (`.claude-plugin/`).

## Plugin Structure

| Path | Purpose |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest |
| `.mcp.json` | MCP server registration (server name: `wf`) |
| `hooks/hooks.json` | Hook declarations (SessionStart, SessionEnd) |
| `hooks/workflow-start.sh` | Detects plan resume, context clear, or fresh start |
| `hooks/workflow-cleanup.sh` | Abandons active sessions on session end |

**Tool naming**: `mcp__plugin_workflow_wf__<tool>` (e.g., `mcp__plugin_workflow_wf__start`).

**Migration from standalone**: see `migrate.sh` (not yet committed) to update user configs, then install as plugin.

## Build & Run

```bash
npm run build    # tsc → compiles src/ to build/
npm run dev      # tsc --watch
npm start        # node build/index.js
```

No test runner, linter, or formatter is configured.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `WORKFLOW_DIR` | `~/.claude/workflows/` | Global workflow YAML directory |
| `STATE_DIR` | `~/.claude/workflow-state/` | Session JSON persistence |
| `DASHBOARD_PORT` | `3100` | Web dashboard HTTP port |

Project-local workflows load from `./.claude/workflows/` (relative to server CWD). Project-local overrides global on name conflict.

## Architecture

### Source Files (`src/`)

| File | Responsibility |
|---|---|
| `index.ts` | Entry point — resolves dirs, wires components, starts stdio transport |
| `types.ts` | Zod schemas, TypeScript types, constants (`MAX_STACK_DEPTH=10`, `DEFAULT_MAX_TRANSITIONS=50`, `LOCK_STALE_MS=5000`) |
| `engine.ts` | FSM core — `start()`, `transition()`, `abort()`, `setContext()`. Manages snapshot isolation and stack push/pop |
| `loader.ts` | YAML loading + Zod validation + `fs.watch` hot-reload. Two-tier: global dir, then project dir (project wins) |
| `storage.ts` | JSON session persistence with atomic writes (temp+rename) and `proper-lockfile` mutex |
| `modifier.ts` | Runtime overlays via `modify` (stored in session JSON, never touches YAML). Also `create` (writes new YAML) |
| `tools.ts` | 9 MCP tool registrations + text formatting for status output |
| `dashboard.ts` | Express REST API (`/api/sessions`, `/api/session/:id`, `/api/workflows`) + static file serving |

### Key Design Patterns

**Stack-based sub-workflows**: States with `sub_workflow` property push a new `StackFrame`. Terminal states auto-pop back to parent via `on_complete`/`on_fail`. Max depth: 10.

**Snapshot isolation**: Workflow definitions are snapshotted into an in-memory `Map` at session start. Hot-reloads of YAML files don't affect already-running sessions.

**Overlay modifications**: `modify` stores changes in `session.overrides` (persisted JSON), never modifies source YAML. Overlays are applied at state resolution time in `_resolveState()`.

**Atomic writes**: Storage uses temp file + `fs.renameSync` + `proper-lockfile` for safe concurrent access.

**Task hints**: States can declare a `task:` string. The engine emits `create`/`complete` TaskOp signals in responses, letting the agent manage external task lists.

### Workflow YAML Structure

Workflows are defined in YAML with this structure:
```yaml
name: workflow-name
initial: first_state
max_transitions: 50        # per stack frame
states:
  first_state:
    prompt: "Instructions for the agent"
    transitions:
      next: second_state
  second_state:
    sub_workflow: other-workflow    # pushes stack
    on_complete: done_state        # required with sub_workflow
    on_fail: error_state
  done_state:
    terminal: true
    outcome: complete              # or "fail"
```

Template workflows live in `templates/` for reference. Active workflows go in `~/.claude/workflows/` or `.claude/workflows/`.

### Data Flow

1. Agent calls `start(name, session_id)` → Engine snapshots all workflows, creates session JSON, returns initial state prompt
2. Agent calls `transition(session_id, transition_name)` → Engine validates, updates state, handles sub-workflow push/pop, returns new prompt
3. Session state persisted to `STATE_DIR/*.json` after every mutation
4. Dashboard reads session/workflow data via REST API for visualization

## TypeScript Conventions

- ESM (`"type": "module"` in package.json), all imports use `.js` extension
- Target ES2022, module resolution Node16
- Strict mode enabled
- Immutable interfaces (`readonly` properties) for session state and history
- Zod for runtime validation of both YAML definitions and MCP tool inputs
