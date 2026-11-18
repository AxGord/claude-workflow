---
layout: home
pageClass: has-hero
title: Claude Workflow
hero:
  name: Claude Workflow
  text: Workflows for Claude Code agents
  tagline: States, gates, a machine-wide thread pool and a live map of everything that runs.
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: How it works
      link: /concepts
features:
  - title: Agents keep their step
    details: A workflow is a YAML state machine. The engine tracks the state, enforces the guards and hands the agent one prompt at a time, so a long task survives context loss and a restart.
    link: /concepts
    linkText: Concepts
  - title: One pool for heavy work
    details: Builds and test runs from every session share a machine-wide thread pool, so parallel agents queue instead of choking the machine.
    link: /pool
    linkText: How the thread pool works
  - title: A task queue that dispatches itself
    details: A queue file, a picker that admits lines by priority, overlap and dependencies, and a driver per task, with the model and effort chosen by difficulty.
    link: /queue
    linkText: Task queue
  - title: A universal default, a stack pack on request
    details: A new machine gets 14 universal skills; the 15 for a language, domain or tool (Haxe, Python, Pixi, CMake...) ship in the same plugin and are installed by name, offered when the task needs one.
    link: /concepts#bundled-skills
    linkText: Bundled skills
  - title: See what runs
    details: A live map of lanes and branches in the web dashboard, a plan pane in the terminal, and a status line.
    link: /dashboard
    linkText: Dashboard and plan pane
---

## The problem

- **Agents lose their step.** A long task drifts, a context is compacted, Claude Code restarts, and nobody knows which step was next.
- **Parallel heavy work chokes the machine.** Four agents each start a build and the laptop stops answering.
- **No picture of what runs.** Several sessions, branches and reviews are in flight and the only view is scrollback.

## In real use

[anyparse](https://github.com/AxGord/anyparse), an open-source platform for parsers and formatters, is developed on this engine: a queue of small tasks, a scout that may rescore a task before any worker starts, review rounds, and a land under one lock. [See how one task goes from the queue to main](/use-case-anyparse), with the project's own numbers.

## What you see

### The workflows

Every bundled workflow, drawn by the dashboard's own renderer from its definition, as SVG. Click a state to read its prompt and where it goes; a sub-workflow state opens that workflow.

<WorkflowGraphs />

### The status line

The band the mod draws above Claude Code's prompt while the plan pane is closed, drawn by the mod's own code from a recorded session. Drag the slider to another moment.

<StatusLine />
