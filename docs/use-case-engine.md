---
title: "Use case: the engine builds itself"
description: How the engine's own changes go through the engine they change, how one queue carries lines of two repositories, how a field report becomes a landed line, with the ledger's numbers
aside: false
pageClass: use-case
---

# Use case: the engine builds itself

This plugin is developed with itself. A change to the engine is a line in a queue, run by a dispatcher that is running on the engine it is about to change. The path of a line (the pick, the worker, the gate, the review rounds, the land) is the one on the [anyparse page](/use-case-anyparse). This page covers only what is particular to an engine line.

## A change reaches running sessions without breaking them

The engine's lines run `engine-task`, a tracked file of this repository (`.claude/workflows/engine-task.yaml`, extending `batch-task`). Its worker never edits the checkout the plugin is loaded from: it works in its own worktree on a branch `eng/<id>`, and `npm run check` is its gate.

Only the land touches the loaded checkout. It fast-forwards master to the tree the gate passed and runs `npm run build`. A red build takes the merge back and rebuilds master.

What a session sees of the new code depends on which process runs it:

| What changed | When a running session sees it |
|---|---|
| A script the engine runs per call (`wf-queue`, the pick) | At once after the build, on its next call |
| A workflow file of a project | Only in sessions started after the change: a running session keeps the definition it started with |
| The MCP tools, `hooks.json`, the bundled templates | After a Claude Code restart |
| An agent type | After a Claude Code restart |

The land prints `RESTART Claude` when anything under `src/`, `hooks/`, `templates/` or the plugin manifest changed, else `no restart needed`. It checks paths, not rows: the source of an exec'd script is under `src/`, so it errs toward a restart. A restart suspends the sessions and `claude --resume` continues them, sub-agents included ([FAQ](/faq#claude-code-restarted-is-my-session-lost)). The checkout is loaded as in [Manual (for development)](/getting-started#manual-for-development).

## One queue, two repositories

A project's queue may carry a line that changes another repository. The line names its `repo:` and its `workflow:`, and its session starts with that repository as cwd, so the repository's own workflow file, gate and land apply.

```yaml
- id: ENG-EXAMPLE
  repo: mcp-workflow-engine
  workflow: engine-task
  touches: [src/pool.ts, src/pool.test.ts]
  text: ...
```

- The window and the pick are the project's, so engine lines and project lines run side by side.
- `touches:` are compared only between lines of the same repository.
- The land lock is per repository: an engine land does not wait for a project land.
- A Landed row of such a line in the plan pane draws its commit from the line's `landed <sha>` note: the commit is in the other repository.

## A field report becomes a line

A defect found while the engine runs another project arrives as a queue line, with the facts the reporter had, and lands through the same path. A line of `kind: bug` is reproduced first: the worker starts only after a reproducer has written a failing test, or said the defect cannot be tested.

Two from the [changelog](https://github.com/AxGord/claude-workflow/blob/master/CHANGELOG.md):

- ENG-DELIVERY-KEY-ADVANCES. A sibling project's investigator had delivered its report, but a command it started was still alive, so its turn never ended and the driver waited for a notification that never came. A state that declares `delivers: <key>` now takes the agent's `context_set` of that key as the delivery and moves the driver on.
- ENG-SPEND-PLACEHOLDER-AGENT-DROPS-TOTAL. Two landed rows in the plan pane had no price. The ledger showed a driver had linked the literal `PENDING` as an agent id, and the whole total was dropped. `link_agent` now refuses such an id.

## The numbers

The same ledger as the anyparse page, cut to the engine's own `engine-task` runs. Its agents are not recorded stage by stage, so the stage and recon panels are not drawn. Tap a figure to read how it is counted.

<UseCaseNumbers of="engine" />

<style>
/* the prose keeps a reading width; the scenes take the whole column */
.use-case .vp-doc > div > :where(p, h1, h2, h3, ul, ol) {
  max-width: 720px;
}
</style>
