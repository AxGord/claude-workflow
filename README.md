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
- **18 bundled workflows** — complete agent lifecycle from routing to reflection
- **20 bundled skills** — reusable knowledge modules auto-provisioned on first run
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

All prompts support `{{mustache}}` templates. Context values are available everywhere via `{{context.key}}`. After action execution, result variables are also available:

| Source | Variables |
|--------|-----------|
| `exec` | `{{stdout}}`, `{{stderr}}`, `{{exit_code}}`, `{{pid}}` (background) |
| `fetch` | `{{status}}`, `{{body}}`, `{{error}}` |

Action states can be chained — `exec` → `exec` → `fetch` → `prompt` — up to 20 steps without agent involvement.

## Three-Tier Loading

Workflows load from three sources in ascending priority — later tiers override earlier ones:

| Tier | Path | Purpose |
|------|------|---------|
| Bundled | `templates/` (plugin root) | Base workflows shipped with the plugin |
| Global | `~/.claude/workflows/` | User customizations shared across projects |
| Project | `.claude/workflows/` | Project-specific workflows |

A project workflow named `coding` overrides the bundled `coding` template. Same-name global workflows sit in between.

## Bundled Workflows

| Workflow | Description |
|----------|-------------|
| `master` | Single entry point — analyzes task, loads skills, routes to sub-workflows |
| `coding` | Code writing pipeline: think → delegate → write → review → verify |
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

**Platforms & Tooling**

| Skill | Description |
|-------|-------------|
| `target-openfl-native` | OpenFL/hxcpp native target gotchas |
| `build-cmake` | CMake build system gotchas |
| `ci-github-actions` | GitHub Actions workflow gotchas |
| `aws-lambda` | AWS Lambda .NET deployment gotchas |
| `mcp-setup` | MCP server setup and troubleshooting |
| `claude-code-config` | Claude Code configuration gotchas |

**Utility**

| Skill | Description |
|-------|-------------|
| `math` | Math overflow boundary gotchas |
| `web-reading` | Fetch web content via subagents |

## MCP Tools

All tools are registered under the `wf` server. Full tool prefix: `mcp__plugin_workflow_wf__`.

| Tool | Description | Key Parameters |
|------|-------------|----------------|
| `list` | List all available workflow definitions | — |
| `start` | Start a workflow, return initial prompt | `workflow`, `actor`, `parent_session_id` |
| `status` | Get current state, stack, transitions, history | `session_id` |
| `transition` | Advance to next state (auto push/pop sub-workflows) | `session_id`, `transition` |
| `context_set` | Save key-value data in session context | `session_id`, `key`, `value` |
| `modify` | Runtime overlay — add/change/remove states and transitions | `session_id`, `add_state`, `add_transition` |
| `create` | Create new workflow definition (saves YAML) | `name`, `definition`, `scope` |
| `delete` | Delete a workflow definition | `name`, `scope` |
| `abort` | Abort workflow, pop all stack frames | `session_id` |
| `sessions` | List all sessions (active first) | — |

## Dashboard

The web dashboard runs on `localhost:3100` and provides real-time monitoring:

- **Sessions panel** — active, completed, and abandoned sessions with status badges
- **Workflow list** — all loaded workflows with state counts
- **Session detail** — full state history, stack depth, context data
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
| `src/executor.ts` | Action state execution — shell commands (`exec`) and HTTP requests (`fetch`) |
| `src/template.ts` | Mustache-style `{{var}}` template rendering for action parameters |
| `src/dashboard.ts` | Express REST API + static file serving |
| `src/types.ts` | Zod schemas, TypeScript types, constants |

## License

MIT
