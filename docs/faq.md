---
title: FAQ
description: Troubleshooting
---

# FAQ and troubleshooting

## Where does the engine keep its state?

Session JSON files live in `~/.claude/workflow-state/` (`STATE_DIR`); the foreground output and exit codes of `exec` states are under its `exec/` directory. See [Configuration](/getting-started#configuration).

## The dashboard does not open

It binds `127.0.0.1:3100` by default (`DASHBOARD_HOST`, `DASHBOARD_PORT`). Another process on that port, or a second Claude Code instance, may hold it; set `DASHBOARD_PORT` and restart Claude Code. The page is described in [Dashboard and plan pane](/dashboard).

## Claude Code restarted: is my session lost?

No. Sessions are suspended when Claude Code exits and `claude --resume` continues them, sub-agents included; an `exec` that was running keeps running and is taken over. A session nobody resumed for `WF_SUSPENDED_TTL_DAYS` (7) days is abandoned. See [Restart: suspend and resume](/action-states#restart-suspend-and-resume).

## A session seems stuck

Give a state a `stale_after` so a stall is reported, and look at the session in the dashboard. See [Stall detection](/action-states#stall-detection-—-stale-after).

## A heavy command ran outside the pool

The pool gate only wraps the commands a project marks heavy in `.claude/workflows/pool-gate.yaml`. See [Pool gate](/action-states#pool-gate-—-agents-heavy-bash-commands-through-the-pool).

## I edited a workflow and a running session did not change

Definitions are frozen at session start (snapshot isolation); hot-reload affects new sessions only. See [Workflow YAML](/workflow-yaml).

## A project install from a git URL does not run

`build/` is gitignored, so a git-sourced plugin has no compiled MCP server. Install from the community catalog, npm or a local checkout; see [Getting started](/getting-started#install-channels).
