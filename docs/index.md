---
layout: home
title: Claude Workflow
hero:
  name: Claude Workflow
  text: Workflows for Claude Code agents
  tagline: States, gates, a machine-wide thread pool and a live map of everything that runs.
  image:
    src: /screenshots/workflow-master.png
    alt: The live workflow map
  actions:
    - theme: brand
      text: Get started
      link: /getting-started
    - theme: alt
      text: How it works
      link: /concepts
    - theme: alt
      text: GitHub
      link: https://github.com/AxGord/claude-workflow
features:
  - title: Agents keep their step
    details: A workflow is a YAML state machine. The engine tracks the state, enforces the guards and hands the agent one prompt at a time, so a long task survives context loss and a restart.
    link: /concepts
    linkText: Concepts
    icon:
      src: /screenshots/workflow-coding.png
      alt: A coding workflow graph
      width: 96
      height: 96
  - title: One pool for heavy work
    details: Builds and test runs from every session share a machine-wide thread pool, so parallel agents queue instead of choking the machine.
    link: /action-states
    linkText: Action states and the pool
  - title: A task queue that dispatches itself
    details: A queue file, a picker that admits lines by priority, overlap and dependencies, and a driver per task, with the model and effort chosen by difficulty.
    link: /queue
    linkText: Task queue
  - title: See what runs
    details: A live map of lanes and branches in the web dashboard, a plan pane in the terminal, and a status line.
    link: /dashboard
    linkText: Dashboard and plan pane
    icon:
      src: /screenshots/workflow-master.png
      alt: The live workflow map
      width: 96
      height: 96
---

<!-- Hero visual slot: the replay of the live map (ENG-SITE-MAP-REPLAY) and the recorded scene (ENG-SITE-DEPLOY-GIF) go here. -->

## The problem

- **Agents lose their step.** A long task drifts, a context is compacted, Claude Code restarts, and nobody knows which step was next.
- **Parallel heavy work chokes the machine.** Four agents each start a build and the laptop stops answering.
- **No picture of what runs.** Several sessions, branches and reviews are in flight and the only view is scrollback.

## What you see

![The live workflow map](/screenshots/workflow-master.png)

![A coding workflow](/screenshots/workflow-coding.png)

![The status line](/screenshots/statusline.png)

## Install

```bash
/plugin marketplace add https://github.com/anthropics/claude-plugins-community
/plugin install workflow
```

Then start a session: the plugin provisions its skills on first run. [Get started](/getting-started) walks through the first workflow.
