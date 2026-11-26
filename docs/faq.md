---
title: FAQ
description: Troubleshooting
---

# FAQ and troubleshooting

## Where does the engine keep its state?

Session JSON files live in `~/.claude/workflow-state/` (`STATE_DIR`); the foreground output and exit codes of `exec` states are under its `exec/` directory. See [Configuration](/getting-started#configuration).

## What does an uninstall leave behind?

The skill copies in `~/.claude/skills/`, `~/.claude/workflow-state/` and `~/.claude/workflow-pool/`. Run `wf-skills remove` before `/plugin uninstall`, with `--state` to include the two state directories. See [Concepts](/concepts#updating-and-removing-the-skills).

## The dashboard does not open

It binds `127.0.0.1:3100` by default (`DASHBOARD_HOST`, `DASHBOARD_PORT`). Another process on that port, or a second Claude Code instance, may hold it; set `DASHBOARD_PORT` and restart Claude Code. The page is described in [Dashboard and plan pane](/dashboard).

## Claude Code restarted: is my session lost?

No. Sessions are suspended when Claude Code exits and `claude --resume` continues them, sub-agents included; an `exec` that was running keeps running and is taken over. A session nobody resumed for `WF_SUSPENDED_TTL_DAYS` (7) days is abandoned. See [Restart: suspend and resume](/action-states#restart-suspend-and-resume).

## A session seems stuck

Give a state a `stale_after` so a stall is reported, and look at the session in the dashboard. See [Stall detection](/action-states#stall-detection-—-stale-after).

## A heavy command ran outside the pool

The pool gate only wraps the commands a project marks heavy in `.claude/workflows/pool-gate.yaml`. See [Pool gate](/action-states#pool-gate-—-agents-heavy-bash-commands-through-the-pool).

## I edited a workflow and a running session did not change

Definitions are frozen at session start (snapshot isolation); hot-reload affects new sessions only. A file that fails to reload is not applied: `list` shows it under `BROKEN (did not load)` with the reason, and when a bundled template fails to reload (e.g. this server is too old to read it) the previous bundled set keeps serving until Claude Code restarts. See [Workflow YAML](/workflow-yaml).

## Claude Code asked me about a write to `trusted-workflows.json` or `~/.claude/workflows/`

An agent tried to write the exec-consent record or a workflow (`.yaml`, `.yml`, or `settings.json`) into the global workflows directory.

Other files there, a native `.js` workflow for one, pass without this question. A workflow there runs its `exec` states without a consent step, so the plugin's PreToolUse hook (`hooks/trust-write-gate.sh`) makes it a question to you. Confirm only what you asked for; approve a project yourself with `<plugin dir>/scripts/wf-trust <project>` in a terminal (the question prints that path). What the guard covers and does not: [Trusting project workflows](/getting-started#what-consent-does-and-does-not-protect-against).

## A project install from a git URL does not run

`build/` is gitignored, so a git-sourced plugin has no compiled MCP server. Install from this repository's marketplace (`/plugin marketplace add AxGord/claude-workflow`), npm or a local checkout; see [Getting started](/getting-started#install-channels).
