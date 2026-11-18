---
title: Concepts
description: Workflows, states, sessions, transitions, child sessions, bundled workflows, skills and tools
---

# Concepts

**Two ways to use it.** *One task:* with the CLAUDE.md snippet every conversation starts the `master` workflow, which picks a bundled one (`bug-fix`, `coding`, `new-feature`, ...) and hands the agent one prompt at a time; a named one starts with `start({ workflow: "bug-fix" })` or by asking. *A queue:* for many tasks, a queue file plus the `batch` workflow runs one task workflow per line, several at once, each under a driver agent. A workflow of your own comes from asking the agent (it loads the bundled `wf-yaml-authoring` skill) or from writing the YAML by hand. Step by step: [Getting started](/getting-started).

## The vocabulary

- **Workflow** — a YAML state machine: a name, an `initial` state and a map of states. Bundled ones live in the plugin, yours in `.claude/workflows/` ([Workflow YAML](/workflow-yaml)).
- **State** — one step. A prompt state hands the agent a prompt and lists the transitions it may take; an action state (`exec`, `fetch`) runs a command or request by itself and routes on the result ([Action states](/action-states)); a terminal state ends the workflow with an outcome.
- **Session** — one run of a workflow, with its current state, context and visit counts, persisted as JSON. `start()` creates it.
- **Transition** — a move from the current state to another, named by the agent through `transition()`; the engine validates it, advances and returns the next prompt.
- **Child session** — a state with `sub_workflow:` pushes a nested workflow as a child session; when it ends the parent continues at `on_complete` or `on_fail`. A parent can also spawn child sessions for sub-agents (the task queue does this for each task).

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
5. Sub-workflows form a stack: a state with `sub_workflow:` pushes a nested workflow (max depth 10) and the engine pops it when it completes
6. Snapshot isolation: workflow definitions are frozen at session start, so a hot-reload never changes a running session
7. Runtime overlays: `modify` adds, changes or removes states and transitions of one session without touching the YAML files
8. The SessionStart hook auto-provisions missing skills and injects the workflow context

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
| `planning` | Explore, design plan (tasks and steps), record workflow context |
| `testing` | Testing verification — unit tests first, then integration |
| `web-research` | Check existing knowledge, then delegate to web subagents |
| `reflection` | Self-reflection after significant tasks — evaluate, classify, act |
| `subagent` | Lightweight routing for sub-agents (no chat/plan/reflect) |
| `file-code` | Per-file coding — spawned by coding/bug-fix for each file |
| `file-review` | Per-file deep review — spawned by code-review for each file |
| `lint-review` | Trivial-diff review — engine-run lint, act on findings, one intent re-read |
| `batch` | Long-running task queue: the engine admits lines into the window (`after:` / `touches:` / `owner:` / pause), one `batch-task` child per task, one fresh-eyes review of the combined diff |
| `batch-task` | One queued task, run by a haiku driver (`driver:`): difficulty → model/effort (`model_table`) → worktree → worker → reviewer chosen by the diff → merge + `land_test` under the repo's land lock → mark done → cleanup |
| `review-push` | Review uncommitted changes, then commit and push to GitHub |
| `github-init` | Initialize git repo and create private GitHub repository |

The `coding` workflow, drawn by the dashboard's own renderer (click a state to read its prompt; the [landing page](/) draws every bundled workflow):

<WorkflowGraphs workflow="coding" :picker="false" />

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
| `wf-yaml-authoring` | Reference for authoring workflow YAML: state types, skill gates, exec/fetch action states (not Claude Code's own `workflow-authoring`, which covers its native JS workflows) |

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
| `start` | Start a workflow, return initial prompt | `workflow`, `actor`, `parent_session_id`, `cwd`, `priority`, `context`, `reply`, `force` |
| `status` | Get current state, stack, transitions, context (values cut to 200 chars), history — of any session, incl. a finished child; with `key`, only that context value, whole | `session_id`, `key` |
| `transition` | Advance to next state (auto push/pop sub-workflows) | `session_id`, `transition`, `caller_session_id`, `force` + `reason` |
| `context_set` | Save key-value data in session context | `session_id`, `key`, `value` |
| `modify` | Runtime overlay — add/change/remove states and transitions (an `exec`/`fetch` state is refused) | `session_id`, `add_state`, `add_transition` |
| `create` | Create new workflow definition (saves YAML; an `exec`/`fetch` state is refused) | `name`, `definition`, `scope` |
| `delete` | Delete a workflow definition | `name`, `scope` |
| `abort` | Abort workflow, pop all stack frames | `session_id`, `caller_session_id`, `force`, `reason` |
| `sessions` | List all sessions (active first); `[STALE: …]` marks one whose state saw no engine call past its `stale_after` | `all` |
| `set_priority` | Set the priority level of a session and its descendants; re-rank their waiting pool entries (no preemption) | `session_id`, `level` |
| `pool_status` | The machine-wide pool: one line per lease and waiter (as `wf-run --status`) | — |
| `resume` | Continue a suspended session in this process (and own its sub-tree); finishes an exec state it stopped in; lists the sub-agents to wake | `session_id` |
| `suspended` | Suspended sessions of this project (or `all`) | `all` |
| `link_agent` | Record the Agent-tool id of the sub-agent driving a child session (named by the parent's `resume`) and the parent's state + visit (the parent's `status` marks it current or stale) | `session_id`, `agent_id` |
| `queue_next` | Admit the next tasks of a YAML task queue and set them running (§ Task queue) | `queue`, `file`, `dry_run`, `explain` |
| `queue_mark` | Move one task's status (`running` / `done` / `failed` / `released` / `promoted` / `shelved`; `retry` restarts a failed task) | `queue`, `file`, `id`, `to`, `note`, `retry`, `force` |
| `queue_add` | Add a task (pending or backlog) to a queue, checked as a pick reads it | `queue`, `file`, `task`, `after_id`, `before_id` |
| `queue_edit` | Set / remove a task's fields, append a note to its `notes:` | `queue`, `file`, `id`, `set`, `append_note`, `from` |
| `queue_header` | Set a queue's `batch_size` (0 = pause) with its reason, and/or its `archive_after_days`, `exclusive_hold` | `queue`, `file`, `batch_size`, `reason`, `archive_after_days`, `exclusive_hold` |

Notes on the tools above:

- `start`, `cwd`: an absolute existing dir — a sub-agent's worktree.
- `start`, `priority`: `low` / `normal` / `high` / `urgent`; default: the parent's level, else `normal`.
- `start`, `context`: a string map the session starts with; not `cwd`.
- `start`, `reply: "id"`: answer only `SESSION: <id> @ <state>`, no prompt or rules.
- `start`, `force: "<reason>"`: a second root. Without `parent_session_id`, a start in a process that already has an active root is refused, naming the root by workflow and state, never its id. A sub-agent never gets a root.
- `start`: a workflow with `driver:` ends the answer with the driver's Agent call.
- `transition`: a call with a `caller_session_id` outside the caller's subtree is refused unless `force: true` with a `reason`. A `transition` naming no `caller_session_id` is not judged (the engine's own prompts step other sessions without one, and a step ends no one); the guard stops an agent that names itself.
- `abort`: its active descendants end with it; the cascade is logged to stderr with the caller and the session count. Refused for a root or a session with active descendants unless `caller_session_id` is the target or an ancestor of it, or `force: true` with a `reason`.
- `link_agent`: every agent linked stays on the session (`linked_agents`). Every call is recorded with its time, the parent's state and that state's stage (`agent_links`) for the ledger's spend, in total and per agent and stage (`spend.by_agent`).
