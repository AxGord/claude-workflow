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
| `hooks/workflow-start.sh` | Detects plan resume, context clear, or fresh start; on every start rewrites `$STATE_DIR/context-epoch-<pid>` so the server re-delivers `digest_on_repeat` prompts, and deletes the markers of dead pids |
| `hooks/workflow-cleanup.sh` | Abandons this instance's active sessions on session end, appends their ledger lines via `build/ledger-cli.js`, caps retained terminal sessions |
| `scripts/` | Shell scripts exec states run via the engine-injected `$WF_PLUGIN_ROOT` (incl. the `wf-run` shim → `build/wf-run.js`), plus `check-skill-sync.sh` (bundled-vs-live skill drift check; `.skillsyncignore` lists intentional divergence) |

**Tool naming**: `mcp__plugin_workflow_wf__<tool>` (e.g., `mcp__plugin_workflow_wf__start`).

**Dev-machine setup after clone**: wire the drift check as a local git hook —
`printf '#!/bin/sh\nsh "$(git rev-parse --show-toplevel)/scripts/check-skill-sync.sh"\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit` —
so a commit cannot ship a bundled skill snapshot that silently lags its live `~/.claude/skills/` copy.

## Build & Run

```bash
npm run build    # tsc → compiles src/ to build/
npm run dev      # tsc --watch
npm start        # node build/index.js
npm test         # vitest run (src/*.test.ts)
```

No linter or formatter is configured.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `WORKFLOW_DIR` | `~/.claude/workflows/` | Global workflow YAML directory |
| `STATE_DIR` | `~/.claude/workflow-state/` | Session JSON persistence |
| `DASHBOARD_PORT` | `3100` | Web dashboard HTTP port |
| `DASHBOARD_HOST` | `127.0.0.1` | Web dashboard bind address |
| `WF_POOL_DIR` | `$HOME/.claude/workflow-pool` | Machine-wide thread pool (`pool.json`, optional `config.json`); NOT under `CLAUDE_CONFIG_DIR` — every config dir shares one budget |

Project-local workflows load from `./.claude/workflows/` (relative to server CWD). Project-local overrides global on name conflict.

## Architecture

### Source Files (`src/`)

| File | Responsibility |
|---|---|
| `index.ts` | Entry point — resolves dirs, wires components, starts stdio transport |
| `types.ts` | Zod schemas, TypeScript types, constants (`MAX_STACK_DEPTH=10`, `DEFAULT_MAX_TRANSITIONS=50`, `LOCK_STALE_MS=5000`) |
| `engine.ts` | FSM core — `start()`, `transition()`, `abort()`, `setContext()`. Manages snapshot isolation and stack push/pop |
| `loader.ts` | YAML loading + Zod validation (strict: an unknown key fails the load, nearest known key named) + `fs.watch` hot-reload. Three tiers (bundled → global → project, later wins by name), each parsed as `WorkflowFileSchema`; then every name is resolved through its `extends:` chain (`_resolve`) and the MERGED definition is validated |
| `storage.ts` | JSON session persistence with atomic writes (temp+rename) and `proper-lockfile` mutex (contended locks retry); `update(id, change)` = read-modify-write under that lock for writers outside the transition queue (`setPriority`); `appendLedger` → `ledger.jsonl` (same lock discipline, its own lock file) |
| `pool.ts` | Machine-wide thread pool (also `projectRoot`, `formatEntry`/`formatStatus` for `wf-run --status` and `pool_status`, `reprioritize`): `config.json` (`budget`, `load_threshold`), the pure admission pass `schedule()` (reap dead entries — a lease lives while its pid OR its attached child group does; grant in strict priority/arrival order while `held + N <= budget` and, beside a live lease, `held + N + external <= budget` — external never blocks an empty pool — and the waiter's named locks are neither held nor wanted by an earlier waiter, all at once), `Pool.acquire` / lease attach / release under a proper-lockfile lock; load = busy cpus over the cpu-tick window since the pool's previous pass (loadavg1 only without a window); cpu/tick/load/liveness probes injectable |
| `wf-run.ts` | CLI over `pool.ts` (`package.json` `bin`): lease (`--threads N|budget|MIN-MAX`, `--wait-full`, `--lock`; priority from `--priority`, else `WF_PRIORITY`/`WF_PRIORITY_LEVEL`), run the child in its own group with `WF_THREADS`/`WF_PRIORITY`, forward signals, exit with its code; 75 = busy |
| `process.ts` | `killProcessGroup`, `isPidAlive` — shared by executor, engine and `wf-run` |
| `ledger.ts` / `ledger-cli.ts` | The ledger line of an ended session; the CLI the cleanup hook runs for sessions it ends outside the server |
| `modifier.ts` | Runtime overlays via `modify` (stored in session JSON, never touches YAML). Also `create` (writes new YAML) |
| `tools.ts` | 12 MCP tool registrations (incl. `set_priority`, `pool_status`) + text formatting for status output |
| `dashboard.ts` | Express REST API (`/api/sessions`, `/api/session/:id`, `/api/workflows`) + static file serving |

### Key Design Patterns

**Stack-based sub-workflows**: States with `sub_workflow` property push a new `StackFrame`. Terminal states auto-pop back to parent via `on_complete`/`on_fail`. Max depth: 10.

**Snapshot isolation**: Workflow definitions are snapshotted into an in-memory `Map` at session start. Hot-reloads of YAML files don't affect already-running sessions.

**Overlay modifications**: `modify` stores changes in `session.overrides` (persisted JSON), never modifies source YAML. Overlays are applied at state resolution time in `_resolveState()`.

**Atomic writes**: Storage uses temp file + `fs.renameSync` + `proper-lockfile` for safe concurrent access.

**Session cwd and ids**: `start(cwd)` sets `context.cwd`; execs without their own `cwd:` run there. Execs get `WF_SESSION_ID` / `WF_PARENT_SESSION_ID` / `WF_ROOT_SESSION_ID`, prompts `{{session_id}}` / `{{parent_session_id}}`. A root ending on a `fail` terminal is `outcome: "failed"`.

**Visit guards**: every move into a state (agent transition, action route, skill-gate auto-transition) goes through `Engine._enterTarget`: past the target's `max_visits` it follows `on_exhausted` (chained, cycle = error) or throws. Pop moves (`on_complete`/`on_fail`) do not check `max_visits`.

**Action results in later states**: `_buildTemplateVars` exposes the session's `last_action_result` (`{{stdout}}`, `{{exit_code}}`, …) to every prompt and action until the next action replaces it — not only to the action's own `success_prompt`.

**Reading a child's results**: `status` cuts each context value to 200 chars; `status({ session_id, key })` returns one value whole (`formatContextValue`), finished sessions included, with no ownership check (like `status`).

**Heavy work through the pool**: an exec with `resource: { threads?, locks?, priority?, wait_timeout? }` (threads, locks, or both) leases from `pool.ts` (the same code path as `wf-run`, not a CLI call) before it runs (`threads: budget` = the configured budget, read when the request is made — a later raise does not grow a waiting or held lease): no lease within `wait_timeout` → exit 75, routed like any exit; abort withdraws the wait; `wait_ms` sits beside `duration_ms` in history and ledger. Light execs never queue. The leased command gets `WF_THREADS` = the threads granted (clamped; absent without threads — `_buildEnv` drops an inherited one); `wf-run` does the same for its child. Named locks are machine-wide mutexes granted atomically with the threads in `schedule()` (all or nothing, no hold while waiting); nothing overtakes a waiter on what it waits for, and a waiter blocked by a held lock claims no threads.

**Priority levels and flexible leases**: `PRIORITY_LEVELS` (`types.ts`: low −100, normal 0, high 100, urgent 200) — `session.priority` is set by `start(priority)` or inherited from the parent; a lease's priority = level + the step's `resource.priority` (`levelPriority`), recorded with its `level` in the pool entry, and execs get `WF_PRIORITY`/`WF_PRIORITY_LEVEL`. `Engine.setPriority` (tool `set_priority`) writes the level on the session and its active descendants OUTSIDE the session queue, each through `Storage.update` (an ended session stays ended) (an exec of it may be waiting for the very lease) — so `_executeActionState` keeps the level it re-reads after the exec — then `Pool.reprioritize` shifts the waiting entries that carry a level; leases are never touched. `threads: { min, max }` + `wait_full` → pool entry `min_threads` + `full_until`: `schedule()` grants the max when it fits, else after `full_until` the room that fits if ≥ min; a waiting flexible head closes the threads like any waiter; the lease records `threads` = granted (`asked_threads` = the request). History/ledger of a leased exec: `threads_granted`, `step_key` = `projectRoot(session cwd)|workflow|state` (`projectRoot`: nearest `.git`, linked worktree → main repo).

**Inheritance (`extends:`)**: `_loadAll` parses each tier into a map of raw files, then resolves every name: a file with `extends: X` = X's resolved definition + its own states laid over by name (whole-state replacement), `initial`/`max_transitions`/`description` from the heir when set. `extends` of its own name resolves from the tiers BELOW the file's tier (project `coding` → global/bundled `coding`), another name from the top tier; `name@tier` links detect a cycle. A file whose resolution or validation fails falls back to the same name one tier down (like a file failing the schema). `_validate` and `validateReferences` see only merged definitions; `extends` never reaches the engine. The bundled `testing` / `bug-fix` expose contract states for heirs (`project_test`, `project_build`, `project_gate` — README § "`extends:`").

**Fan-out and timeouts**: an exec with `fanout: { count | items_command, threads_each, max_parallel? }` (`Executor._execFanout`) runs one instance per shard through `_execLeased` (its own pool lease of `threads_each`, `WF_SHARD=i/N` 1-based or `WF_ITEM`), at most `max_parallel` workers pulling the next shard (default `max(1, floor(budget / min(threads_each, budget)))`, so the pool queue holds only what can run); exit 0 only if all shards are 0, else their common code or 1; `killSession` aborts the fanout (no new shards) besides the usual group kills and lease withdrawals; `ActionResult.shards` → history entry → ledger `execs[].shards`. A foreground exec killed by its `timeout` exits 124 (`EXIT_CODE_TIMEOUT`); `on_timeout` routes it in `_executeActionState` before `cases`/`on_error`.

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
