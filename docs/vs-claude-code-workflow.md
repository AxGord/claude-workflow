---
title: How this differs from Claude Code's built-in Workflow
description: What Claude Workflow, a plugin, and the Workflow tool built into Claude Code each do, side by side, and how their files coexist
---

# How this differs from Claude Code's built-in Workflow

Claude Code has a Workflow tool of its own, announced as "dynamic workflows" in Claude Code v2.1.154 (28 May 2026). Claude Workflow is an independent plugin for Claude Code, not affiliated with or endorsed by Anthropic. Both help Claude do multi-step work and answer different needs. This page states what each does as of Claude Code 2.1.331.

## Two different things

The built-in Workflow tool ships inside Claude Code. It became available in v2.1.146 (20 May 2026). Claude Workflow is a plugin you install: it has been public on GitHub and npm since 1 March 2026 (npm `claude-mcp-workflow` 0.1.0). It is not part of Claude Code and is released under the MIT license.

## The differences

| | Claude Code's built-in Workflow | Claude Workflow (plugin) |
|---|---|---|
| Form | A JavaScript script that starts many subagents; Claude writes it, or you save it as a `/command` | A YAML state machine: states, named transitions, nested workflows |
| Who decides the next step | The script | The agent names a transition and the engine checks it against the state's allowed list; `exec` and `fetch` states route on the result with no model |
| What the workflow itself can run | Agents only: the script has no shell or file access of its own | Shell commands and HTTP requests, run by the engine |
| What is deterministic | The script's control flow; each agent's output still varies | The allowed transitions, the `exec` and `fetch` routing and the saved state; in a prompt state the model picks among the allowed transitions |
| Mid-run questions to you | None: a run pauses only for permission prompts and usage limits | The driving agent is in your conversation and can ask |
| Across restarts | Results are saved in the session; after `claude --resume`, Claude relaunches the run and finished agents are replayed | Session state is saved as files; `claude --resume` continues the session |
| Continuing an agent | Each `agent()` call starts a new agent | A step can wake an agent it already ran |
| Machine resources | A per-run cap on concurrent agents, set by Claude Code and configurable | One machine-wide thread pool for all sessions and for the agents' own heavy commands |
| Task queue | None | A queue file with a driver per task |
| Progress view | `/workflows` in the terminal | A web dashboard, a live map and a plan pane |
| Distribution | Built into Claude Code | A plugin, from a marketplace or npm |

The built-in tool's side is read from Claude Code's workflow documentation and the 2.1.331 binary. The engine's side is its own documentation: [Concepts](/concepts), [Action states](/action-states), [Thread pool](/pool) and [Task queue and dispatch](/queue).

## Which to use

Use the built-in tool when a task is one large fan-out that you can describe in a sentence. Use Claude Workflow when a long process must keep its state, run commands, wait for you or share a machine across sessions.

## Both in one directory

Both read workflow files from `.claude/workflows/` and `~/.claude/workflows/`, each its own kind. A run on Claude Code 2.1.331 with one saved `.js` and one engine `.yaml` in a project directory showed this:

- The saved `.js` appears in the `/` autocomplete, tagged `[dynamic workflow]`, and not in the engine's `list` tool.
- The engine's `.yaml` appears in its `list` tool and not in the `/` autocomplete.
- `wf-validate` on the directory reports the `.yaml` as ok and ignores the `.js`.
- Neither side reported an error.

`/workflows` shows runs, not saved workflows, so neither file is listed there.
