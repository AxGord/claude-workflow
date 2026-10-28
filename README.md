<p align="center">
  <img src="docs/banner.png" alt="Claude Workflow" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/claude-mcp-workflow"><img src="https://img.shields.io/npm/v/claude-mcp-workflow" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.7-3178c6" alt="TypeScript"></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude_Code-Plugin-ff6600" alt="Claude Code Plugin"></a>
</p>

A Claude Code plugin that drives agents through YAML-defined state machines. The engine tracks state, enforces guards, manages nested sub-workflow stacks, and visualizes everything in a web dashboard.

![Master workflow graph](docs/screenshots/workflow-master.png)

## Features

- **FSM-based state machines** — define workflows in YAML with states, transitions, and prompts
- **Stack-based sub-workflows** — states can push nested workflows (max depth 10), auto-pop on completion
- **Three-tier loading** — bundled templates < global (`~/.claude/workflows/`) < project (`.claude/workflows/`)
- **Snapshot isolation** — workflow definitions frozen at session start; hot-reloads don't affect running sessions
- **Runtime overlays** — modify workflows on the fly without touching YAML files
- **Action states** — `exec` runs shell commands, `fetch` makes HTTP requests, with auto-routing by exit code or HTTP status
- **Web dashboard** — real-time session monitoring with DAG graph visualization
- **20 bundled workflows** — complete agent lifecycle from routing to reflection, including long-running batch orchestration and a text-only `docs` route
- **28 bundled skills** — reusable knowledge modules auto-provisioned on first run
- **SessionStart hook** — auto-provisions missing skills and injects workflow context

## Quick Start

### From Community Plugins (recommended)

The plugin is listed in the [claude-plugins-community](https://github.com/anthropics/claude-plugins-community/) catalog:

```bash
/plugin marketplace add https://github.com/anthropics/claude-plugins-community
/plugin install workflow
```

### From npm

Create a `marketplace.json` and add it as a source, or install directly:

```bash
# 1. Add a marketplace with this plugin
/plugin marketplace add <marketplace-with-workflow>

# 2. Install
/plugin install workflow@<marketplace-name>
```

See [Creating a marketplace](https://code.claude.com/docs/en/plugin-marketplaces) for how to set up an npm-based marketplace with this plugin:

```json
{
  "name": "workflow",
  "source": { "source": "npm", "package": "claude-mcp-workflow" }
}
```

### Manual (for development)

```bash
git clone https://github.com/AxGord/claude-workflow.git
cd claude-workflow
npm install
npm run build
claude --plugin-dir ./
```

### Install channels

Supported marketplace sources: the **npm package** (`claude-mcp-workflow`) and a **local directory**. A marketplace entry that points at the git repository (git URL as a plugin source) is **not** supported — `build/` is gitignored, so a git-sourced install has no compiled MCP server to run. (Cloning for development works — see above — because you run `npm run build` yourself.)

## Recommended CLAUDE.md Snippet

The engine only helps when the agent actually starts a workflow. Add this to your `~/.claude/CLAUDE.md`:

```markdown
- **ALWAYS** start every conversation by calling `mcp__plugin_workflow_wf__start()` (no arguments) before doing anything else, including answering the user
  - **EXCEPTION**: If you are a sub-agent spawned by the Task tool, do NOT call `start()` without arguments — the parent agent manages the workflow session. Follow the start instructions from the parent's preamble instead
```

## Recommended Permissions

Auto-allow the workflow tools so the agent is not interrupted with a permission prompt on every transition. In `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_workflow_wf__list",
      "mcp__plugin_workflow_wf__start",
      "mcp__plugin_workflow_wf__status",
      "mcp__plugin_workflow_wf__transition",
      "mcp__plugin_workflow_wf__context_set",
      "mcp__plugin_workflow_wf__modify",
      "mcp__plugin_workflow_wf__create",
      "mcp__plugin_workflow_wf__delete",
      "mcp__plugin_workflow_wf__sessions"
    ]
  }
}
```

`abort` is deliberately **not** allowlisted: sub-agents inherit permissions, and an auto-allowed `abort` would let a sub-agent silently kill its parent's session. Keep it behind a manual prompt.

## How It Works

```
Agent                       Engine                          Storage
  │                           │                               │
  ├── start() ───────────────►├─ snapshot workflows ─────────►├ session.json
  │◄── initial state prompt ──┤                               │
  │                           │                               │
  ├── transition() ──────────►├─ validate & advance ─────────►├ update JSON
  │◄── new state prompt ──────┤  (push/pop sub-workflows)     │
  │                           │                               │
  ├── transition() ──────────►├─ terminal state? ────────────►├ mark complete
  │◄── done ──────────────────┤  (auto-pop to parent)         │
```

1. `start()` — creates a session, snapshots all workflow definitions, returns the initial state prompt
2. `transition()` — validates the transition, advances state, handles sub-workflow push/pop, returns the new prompt
3. Every mutation is atomically persisted to JSON (temp file + rename + lockfile)
4. Dashboard visualizes sessions and workflow graphs at `localhost:3100`

## Workflow YAML

```yaml
name: my-workflow
description: "Example workflow"
initial: start
max_transitions: 50

states:
  start:
    prompt: "Analyze the task and decide on approach"
    transitions:
      implement: write_code
      explore: research

  research:
    sub_workflow: explore        # pushes nested workflow
    on_complete: write_code      # returns here on success
    on_fail: start               # returns here on failure

  write_code:
    prompt: "Write the implementation"
    transitions:
      done: finish

  finish:
    terminal: true
    outcome: complete            # or "fail"
```

## Action States

States can run shell commands or HTTP requests automatically — the agent doesn't participate, the engine handles execution and routes to the next state based on the result.

### `exec` — run a shell command

```yaml
run_tests:
  type: exec
  command: "npm test"
  cwd: "{{context.cwd}}"
  timeout: 30000
  on_success: analyze
  on_error: fix
  success_prompt: "Tests passed:\n{{stdout}}"
  error_prompt: "Tests failed (exit {{exit_code}}):\n{{stderr}}"
```

An exec without `cwd:` runs in the session's cwd (`start`'s `cwd`, else the server's); a relative `cwd:` resolves against it. Its env carries `WF_PLUGIN_ROOT`, `WF_SESSION_ID`, `WF_PARENT_SESSION_ID` (empty at the root) and `WF_ROOT_SESSION_ID`. Every exec runs in its own process group: a timeout, `abort`, or a parent's abort cascade kills `sh -c` together with everything it started. The history entry records `exit_code` and `duration_ms`.

### Heavy work — the machine-wide thread pool

Light commands run as plain execs and never wait. Heavy ones (test suites, release builds, corpus runs) take a lease from one pool shared by every session, project and Claude config dir on the machine — `$WF_POOL_DIR`, default `~/.claude/workflow-pool` (deliberately not under `CLAUDE_CONFIG_DIR`):

```yaml
run_suite:
  type: exec
  command: "npm test"
  resource: { threads: 6, priority: 0, wait_timeout: 900 }
  cases: { "0": analyze, "75": machine_busy }
  default: fix
```

The same admission is a CLI for shell steps and agents' own commands (`bin` of the package; `scripts/wf-run` for execs: `"$WF_PLUGIN_ROOT/scripts/wf-run"`):

```bash
wf-run [--threads N|budget] [--priority P] [--wait-timeout SEC] [--label TEXT] [--efficiency] -- <cmd> [args…]
wf-run --status    # leases and the queue
```

- **Admission** (under a proper-lockfile lock on `<pool dir>/pool.json`): `held + N <= budget`, and beside a live lease also `held + N + external <= budget` — external load never blocks an EMPTY pool (a head with N ≥ budget would otherwise wait forever on background load). `external = max(0, load − held − load_threshold)` is the load not taken through the pool. `load` is measured from cpu ticks (`os.cpus()`): busy cpus over the window since the pool's previous pass (≥ 0.5 s; a window over 5 s is stale and restarts); without a window (first pass, stale) it falls back to `loadavg1`, which is conservative — it lags a minute and still holds load that has ended. `<pool dir>/config.json` (optional): `budget` (default: performance cores − 2 — `hw.perflevel0.physicalcpu` on macOS, else `os.cpus().length` − 2, at least 1) and `load_threshold` (default 2: the noise floor of light work).
- **Order**: strictly priority descending, then arrival — a smaller task never overtakes the head of the queue. `N` above the budget counts as the budget: it waits for an empty machine and runs alone. `threads: budget` / `--threads budget` asks for the whole budget as `config.json` sets it when the request is made — no hardcoded core count in a workflow.
- **Reaping**: leases and waiters whose pid is dead are dropped on every pass; a `wf-run` lease records its child's process group and lives while `wf-run` OR that group does (a SIGKILLed `wf-run` leaves its child running — inside the budget). A waiter polls each second and wakes at once when `pool.json` changes; `wf-run` prints a progress line to stderr when it starts waiting and every 30 s.
- **Busy**: no lease within `--wait-timeout` / `wait_timeout` → exit **75** (EX_TEMPFAIL). An exec routes it through `cases`/`on_error`; its `timeout` counts the run only, and `wait_ms` is recorded beside `duration_ms` in the history and the ledger. `abort` withdraws a waiting exec. `resource:` is for foreground execs only (a load error on `background: true` or a fetch).
- **`wf-run`**: the child runs in its own process group with inherited stdio; `--status` measures over a 0.6 s tick window; SIGINT/SIGTERM/SIGHUP are forwarded to the group; the exit code is the child's; the lease is released on exit. `--efficiency` (macOS) runs the command under `taskpolicy -b` (efficiency cores, low priority) outside the budget; elsewhere it warns and goes through the pool.

### `fetch` — make an HTTP request

```yaml
check_api:
  type: fetch
  url: "http://localhost:8888/ping"
  method: GET
  timeout: 5000
  retry:
    max: 60
    interval: 500
  on_success: ready
  on_error: wait
  success_prompt: "API ready: {{body}}"
  error_prompt: "Not responding: {{error}}"
```

### Routing

Action states route via `on_success`/`on_error`, or by specific codes using `cases`:

```yaml
run_tests:
  type: exec
  command: "npm test"
  cases:
    "0": all_passed
    "1": tests_failed
    "2": no_tests_found
  default: unknown_error
```

### Template variables

All prompts support `{{mustache}}` templates. Context values are available everywhere via `{{context.key}}`, as are `{{visits.<state>}}` (visit count in the active stack frame; empty if never visited), `{{root_workflow}}` (the workflow at the stack root, e.g. `subagent`), `{{session_id}}` and `{{parent_session_id}}` (empty at the root). After action execution, result variables are also available:

| Source | Variables |
|--------|-----------|
| `exec` | `{{stdout}}`, `{{stderr}}`, `{{exit_code}}`, `{{pid}}` (background), `{{wait_ms}}` (`resource:`) |
| `fetch` | `{{status}}`, `{{body}}`, `{{error}}` |

They come from the session's last action result (`last_action_result` in the session JSON), so they are not limited to the action's own `success_prompt` / `error_prompt` / `context_set`: the state an action routes into renders them in its own `prompt`, later prompt states still see them, and the next action state reads them in its `command` / `env` — until that action replaces them. `context_set` a value to keep it past the next action.

Action states can be chained — `exec` → `exec` → `fetch` → `prompt` — up to 20 steps without agent involvement.

### Guards and the exhausted route

`max_transitions` (per workflow, per stack frame, default 50) and a state's `max_visits` refuse a move past them with an error. A state may instead name where a move past its `max_visits` goes:

```yaml
fix:
  prompt: "Fix attempt {{visits.fix}}"
  max_visits: 3
  on_exhausted: escalate      # the 4th move into fix enters escalate instead
  transitions: { retry: verify }
```

The route applies to every move into the state — an agent `transition`, an action state's `on_success`/`on_error`/`cases`, a skill gate's auto-transition; a pop's `on_complete`/`on_fail` does not check `max_visits`. Chained routes are followed (an exhausted `escalate` with its own route goes on), a cycle is an error, and the history entry's `detail` names the exhausted states. A rerouted action move shows the routed-to state's own prompt, not the action's `success_prompt`/`error_prompt` (written for the default target); the result stays readable there as `{{stdout}}`/`{{exit_code}}`. `on_exhausted` without `max_visits`, or to an unknown state, fails the load. `{{visits.<state>}}` counts visits in the active frame, so the routed-to state can say how many tries ran.

### Strict schema

An unknown key in a workflow, a state, a `retry:` or a `resource:` block fails that workflow's load (stderr names the file, the state, the key and the nearest known key) — a typo is never silently ignored.

### Ledger

Every session end (complete, fail, abort, cascade or hook abandon) appends one JSON line to `$STATE_DIR/ledger.jsonl`: ids (session / parent / root), workflow, outcome (`completed` / `failed` / `abandoned`), start/end time, transition count, the exec durations by state and their pool waits (`wait_ms`, `wait_ms_total`). Appends follow the session files' lock discipline with the ledger's own lock file; the ledger is never pruned with old sessions.

## Three-Tier Loading

Workflows load from three sources in ascending priority — later tiers override earlier ones:

| Tier | Path | Purpose |
|------|------|---------|
| Bundled | `templates/` (plugin root) | Base workflows shipped with the plugin |
| Global | `~/.claude/workflows/` | User customizations shared across projects |
| Project | `.claude/workflows/` | Project-specific workflows |

A project workflow named `coding` overrides the bundled `coding` template. Same-name global workflows sit in between.

### When a project should have its own workflow

The bundled workflows fit simple projects and one-off tasks: the agent itself runs whatever build and
tests the project has. A complex project should drive its development through its own workflow in
`.claude/workflows/`. Signs that a project is complex:

- builds, test suites, linters or simulations that take minutes or saturate the CPU;
- a gate a change must pass before it merges (several checks, one verdict);
- several agents working at once, or one long queue of tasks;
- its own merge or release procedure.

Why it pays:

- **Deterministic steps become `exec` states.** Build, tests, gate and merge run inside the engine; the
  agent transitions and gets back only the verdict (keep it short — a table, the first error — and
  write full logs to files). No tokens spent re-reading build output, and no "forgot to run the tests".
- **Heavy steps go through the machine-wide pool** (`resource:`): sessions of every project share one
  CPU budget instead of racing each other, and a waiting exec costs the agent nothing — it sleeps inside
  the `transition` call until its lease is granted.
- **Short prompts.** A state's prompt says what to do NOW and links the project's docs instead of
  restating them; a worker's brief from the parent shrinks to a few lines.
- **Loops are explicit.** A fix-and-recheck cycle is `max_visits` + `on_exhausted`, not a rule the
  agent must remember.

How: copy the closest bundled workflow under the same name (to replace it) or a new name (to run it via
the master's project route), turn every command the agent used to run by hand into an `exec` state
with `resource:` where it is heavy, and keep judgement (design, code, review) in prompt states.

## Bundled Workflows

| Workflow | Description |
|----------|-------------|
| `master` | Single entry point — analyzes task, loads skills, routes to sub-workflows |
| `coding` | Code writing pipeline: think → delegate → write → review → verify |
| `docs` | Text-only edits (skills, prompts, CLAUDE.md, memory, reports): write → verify — no lint, tests, or reviewer agent |
| `bug-fix` | Standard bug fix: classify → diagnose → fix → verify |
| `new-feature` | New feature implementation with planning and testing |
| `debugging` | Diagnose first, fix never (until diagnosed) |
| `code-review` | Code review with per-file deep analysis |
| `explore` | Codebase exploration — understand structure, trace code, find patterns |
| `investigate` | Resolve unknowns before deciding on action |
| `planning` | Explore, design plan, record workflow context |
| `testing` | Testing verification — unit tests first, then integration |
| `web-research` | Check existing knowledge, then delegate to web subagents |
| `reflection` | Self-reflection after significant tasks — evaluate, classify, act |
| `subagent` | Lightweight routing for sub-agents (no chat/plan/reflect) |
| `file-code` | Per-file coding — spawned by coding/bug-fix for each file |
| `file-review` | Per-file deep review — spawned by code-review for each file |
| `lint-review` | Trivial-diff review — engine-run lint, act on findings, one intent re-read |
| `batch` | Long-running queue of independent tasks dispatched to sub-agent workers, one fresh-eyes review of the combined diff |
| `review-push` | Review uncommitted changes, then commit and push to GitHub |
| `github-init` | Initialize git repo and create private GitHub repository |

![Coding workflow graph](docs/screenshots/workflow-coding.png)

## Bundled Skills

Skills are reusable knowledge modules loaded by workflows via `Skill()`. Auto-provisioned to `~/.claude/skills/` on first run if missing. Edit your local copy to override the bundled version — the hook never overwrites existing files.

**Methodology**

| Skill | Description |
|-------|-------------|
| `preferences` | Template for personal coding preferences (fill in your own) |
| `architecture` | Simplicity-first architecture decisions |
| `task-delegation` | When and how to delegate to subagents |
| `debugging` | Debugging meta-patterns — what to do when fixes don't stick |
| `coding-skill-selector` | Select and load coding skills by file extensions and domains |
| `workflow-authoring` | Reference for creating workflows with exec/fetch action states |

**Languages**

| Skill | Description |
|-------|-------------|
| `lang-haxe` | Haxe language gotchas (incl. macros, null safety, hxcpp) |
| `lang-python` | Python language gotchas |
| `lang-as3` | AS3 / AIR 51 language gotchas |

**Domains**

| Skill | Description |
|-------|-------------|
| `domain-yolo` | YOLO object detection model selection |
| `domain-pixi` | Pixi.js v8 masking and graphics gotchas |
| `domain-reid` | Person re-identification ML gotchas |
| `domain-gamedev` | Game dev precision and physics gotchas |
| `domain-pony` | Pony (Haxe cross-library) gotchas |
| `domain-ui` | UI component architecture — ownership, state, events |

**Platforms & Tooling**

| Skill | Description |
|-------|-------------|
| `target-openfl-native` | OpenFL/hxcpp native target gotchas |
| `build-cmake` | CMake build system gotchas |
| `ci-github-actions` | GitHub Actions workflow gotchas |
| `aws-lambda` | AWS Lambda .NET deployment gotchas |
| `mcp-setup` | MCP server setup and troubleshooting |
| `claude-code-config` | Claude Code configuration gotchas |
| `hxq` | When and how to use hxq for structural Haxe navigation |
| `browser-verify` | Browser-automation verification gotchas — stale captures, caches, headless limits |
| `debug-bridge-scaffold` | Meta-skill for creating debug bridges for new technologies |
| `ide-zed` | Zed IDE integration rules |

**Utility**

| Skill | Description |
|-------|-------------|
| `web-reading` | Fetch web content via subagents |
| `skill-manager` | Create, install, update, optimize skills |
| `cleanup` | Clean .claude directory data |

## MCP Tools

All tools are registered under the `wf` server. Full tool prefix: `mcp__plugin_workflow_wf__`.

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list` | List all available workflow definitions | — |
| `start` | Start a workflow, return initial prompt | `workflow`, `actor`, `parent_session_id`, `cwd` (absolute existing dir — a sub-agent's worktree) |
| `status` | Get current state, stack, transitions, context (values cut to 200 chars), history — of any session, incl. a finished child; with `key`, only that context value, whole | `session_id`, `key` |
| `transition` | Advance to next state (auto push/pop sub-workflows) | `session_id`, `transition` |
| `context_set` | Save key-value data in session context | `session_id`, `key`, `value` |
| `modify` | Runtime overlay — add/change/remove states and transitions | `session_id`, `add_state`, `add_transition` |
| `create` | Create new workflow definition (saves YAML) | `name`, `definition`, `scope` |
| `delete` | Delete a workflow definition | `name`, `scope` |
| `abort` | Abort workflow, pop all stack frames | `session_id` |
| `sessions` | List all sessions (active first) | — |

## Dashboard

The web dashboard runs on `localhost:3100` and provides real-time monitoring:

- **Sessions panel** — active sessions plus the most recent finished ones (terminal history is capped)
- **Workflow list** — all loaded workflows with state counts
- **Session detail** — state history, stack depth, context data
- **Workflow graphs** — interactive DAG visualization rendered with dagre

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/session/:id` | Get session detail |
| `POST` | `/api/session/:id/abandon` | Abandon a session |
| `GET` | `/api/workflows` | List all workflow definitions |

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `WORKFLOW_DIR` | `~/.claude/workflows/` | Global workflow YAML directory |
| `STATE_DIR` | `~/.claude/workflow-state/` | Session JSON persistence |
| `DASHBOARD_PORT` | `3100` | Web dashboard HTTP port |
| `DASHBOARD_HOST` | `127.0.0.1` | Web dashboard bind address |

## Status Line

Show the active workflow and state in Claude Code's status bar:

![Status line showing coding:think](docs/screenshots/statusline.png)

Add this snippet to your statusline script:

```sh
# Workflow status — add to your ~/.claude/statusline-command.sh
wf_state_dir="$HOME/.claude/workflow-state"
if [ -d "$wf_state_dir" ]; then
  for f in "$wf_state_dir"/*.json; do
    [ -f "$f" ] || continue
    slen=$(jq -r '.stack | length' "$f" 2>/dev/null)
    if [ "$slen" -gt 0 ]; then
      cpid=$(jq -r '.context.claude_code_pid // 0' "$f" 2>/dev/null)
      [ "$cpid" != "$PPID" ] && continue
      wf=$(jq -r '.stack[.active_frame].workflow // ""' "$f" 2>/dev/null)
      st=$(jq -r '.stack[.active_frame].current_state // ""' "$f" 2>/dev/null)
      printf "\033[96m\xE2\x9A\x99 %s:%s\033[0m" "$wf" "$st"
      break
    fi
  done
fi
```

Then in `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "bash ~/.claude/statusline-command.sh"
  }
}
```

## Development

```bash
npm run build    # tsc → compiles src/ to build/
npm run dev      # tsc --watch
npm start        # node build/index.js
npm test         # vitest run
```

### Architecture

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Entry point — resolves dirs, wires components, starts stdio transport |
| `src/engine.ts` | FSM core — start, transition, abort, context, stack push/pop |
| `src/loader.ts` | YAML loading + Zod validation + fs.watch hot-reload |
| `src/storage.ts` | JSON persistence with atomic writes and lockfile mutex |
| `src/modifier.ts` | Runtime overlays + create (YAML writer) |
| `src/tools.ts` | MCP tool registrations + response formatting |
| `src/executor.ts` | Action state execution — shell commands (`exec`, a `resource:` exec under a pool lease) and HTTP requests (`fetch`) |
| `src/pool.ts` | Machine-wide thread pool: config, admission pass, lease acquire/release under a file lock |
| `src/wf-run.ts` | The `wf-run` CLI over the pool |
| `src/process.ts` | Process-group kill and pid liveness |
| `src/template.ts` | Mustache-style `{{var}}` template rendering for action parameters |
| `src/dashboard.ts` | Express REST API + static file serving |
| `src/types.ts` | Zod schemas, TypeScript types, constants |

## License

MIT
