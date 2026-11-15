---
title: Getting started
description: Install the plugin and run your first workflow
---

# Getting started

## Quick Start

### From Community Plugins (recommended)

The plugin is listed in the [claude-plugins-community](https://github.com/anthropics/claude-plugins-community/) catalog:

```bash
/plugin marketplace add https://github.com/anthropics/claude-plugins-community
/plugin install workflow
```

### From this repository

The repository is its own marketplace (`.claude-plugin/marketplace.json`):

```bash
/plugin install workflow --marketplace AxGord/claude-workflow
```

A local checkout works the same way: `claude plugin marketplace add /path/to/mcp-workflow-engine`, then
`claude plugin install workflow@claude-workflow` — the plugin is then read from the checkout itself (edit, then
`/reload-plugins`). Install it from a folder that IS the plugin, not through a symlink to it: the hooks module
(`hooks/plan-pane.tsx`) must resolve inside the marketplace folder.

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

## Your first workflow

About ten minutes, once the plugin is installed and Claude Code restarted.

1. Create `.claude/workflows/hello.yaml` in your project:

```yaml
name: hello
description: "Plan, do, finish"
initial: plan

states:
  plan:
    prompt: "List the steps for the task in two lines."
    transitions:
      go: do

  do:
    prompt: "Do the steps, then report what changed."
    transitions:
      done: finish

  finish:
    terminal: true
    outcome: complete
```

2. In Claude Code ask the agent to run it: it calls `start` with `workflow: "hello"` and gets the prompt of `plan`.
3. When a step is done the agent calls `transition` with the session id and a name from that state's `transitions` (`go`, then `done`); each call returns the next prompt, and the last state ends the session. A transition the state does not list is refused.
4. Open `http://localhost:3100` (the dashboard): the session appears with its current state, and the workflow as a graph. The agent can also call `status` to read it back at any time.

From here: [Workflow YAML](/workflow-yaml) for the format, [Action states](/action-states) for steps the engine runs itself.

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

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `WORKFLOW_DIR` | `~/.claude/workflows/` | Global workflow YAML directory |
| `STATE_DIR` | `~/.claude/workflow-state/` | Session JSON persistence (also `exec/`: foreground exec output and exit codes) |
| `WF_SUSPENDED_TTL_DAYS` | `7` | A suspended session nobody resumed for this long is abandoned at server start |
| `DASHBOARD_PORT` | `3100` | Web dashboard HTTP port |
| `DASHBOARD_HOST` | `127.0.0.1` | Web dashboard bind address |
