---
title: Getting started
description: Install the plugin, then use it two ways (one task, or a queue) and make a workflow of your own
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

### Uninstall

Run `wf-skills remove` (`scripts/wf-skills` of the plugin), then `/plugin uninstall workflow`. The plugin copies its skills into `~/.claude/skills/` and keeps state in `~/.claude/workflow-state/` and `~/.claude/workflow-pool/`; an uninstall alone removes none of them. `wf-skills remove` takes out the skill copies you did not edit, `--state` the two state directories, `--dry-run` shows what it would do. Details: [Updating and removing the skills](/concepts#updating-and-removing-the-skills).

## Recommended CLAUDE.md Snippet

The engine only helps when the agent actually starts a workflow. Add this to your `~/.claude/CLAUDE.md`, once; after it every conversation begins inside the engine, with nothing for you to type:

```markdown
- **ALWAYS** start every conversation by calling `mcp__plugin_workflow_wf__start()` (no arguments) before doing anything else, including answering the user
  - **EXCEPTION**: If you are a sub-agent spawned by the Task tool, do NOT call `start()` without arguments — the parent agent manages the workflow session. Follow the start instructions from the parent's preamble instead
```

## Mode 1 — one task at a time

With the snippet, `start()` with no arguments opens the bundled `master` workflow. It does no work: it reads your message and routes to the workflow that fits (`bug-fix`, `coding`, `new-feature`, `explore`, `planning`, `code-review`, ... — the table in [Concepts](/concepts#bundled-workflows)). From then on the agent gets one prompt per step and moves on by calling `transition`.

What happened in a scratch project, on the message "the login page crashes with a null error when the password is empty":

1. The agent called `start()`. The answer began `SESSION: e1477cd2` / `master @ route` and carried the routing prompt (the routing rules and the list of the workflows).
2. It chose `bug_fix` (a concrete symptom is a bug), and one `transition` later the answer was the first prompt of `bug-fix`: `[0] master @ run_bug_fix (waiting)`, `[1] bug-fix @ classify ← ACTIVE`, "Classify the bug before proceeding", with the transitions it may take (`visual`, `logic`).

You see this as the agent's own messages; the session also shows in the plan pane (`/wf-plan`, its Sessions tab is the tree of `master` → `bug-fix`) and on the dashboard at `http://localhost:3100` (a live map of the workflow, the current state highlighted). See [Dashboard and plan pane](/dashboard). The route and the two answers above are the real output of a scratch run; the pane and the dashboard were not looked at for this page.

To pick the workflow yourself, name it: ask "run the bug-fix workflow on this", or have the agent call `start({ workflow: "bug-fix" })`. A workflow of your own (below) is also listed in `master`'s routing prompt as a project workflow, so a message that matches its description starts it.

## Mode 2 — a queue of tasks

When there are many independent tasks, write them to a queue instead of working one by one. A queue is a YAML file, `.claude/batch/<name>.yaml`.

The bundled `batch` workflow (master routes a "do all of these" message to it, or ask for it by name):

- admits lines into a window;
- starts one `batch-task` session per line, each run by a cheap driver agent that has a worker and a reviewer do the work in a worktree and lands the result;
- re-picks every time a slot frees.

A minimal queue (add the lines by asking the agent, which calls `queue_add`, or with `wf-queue --queue demo --add '<YAML mapping>'`; the first add creates the file):

```yaml
batch_size: 2                 # how many tasks run at once
reason: two at once
tasks:
  - id: T1
    status: pending
    difficulty: 3             # 1-10, required on a pending line: it picks the agents' model and effort
    touches: [ src/login ]    # lines whose touches overlap never run together
    text: |-
      Fix the null error when the password is empty (login page).
  - id: T2
    status: pending
    difficulty: 2
    touches: [ docs ]
    text: |-
      Document the password rules in docs/login.md.
  - id: T3
    status: pending
    difficulty: 4
    after: [ T1 ]             # starts only when T1 is done
    touches: [ test/login ]
    text: |-
      Add a test for the empty password.
```

The engine also writes `added`, `base` and `text_hash` on every line it adds. `wf-queue --queue demo --dry-run --explain` shows what a pick would do without starting anything; on this file it printed:

- `T1` and `T2` as admitted;
- `T3: window full` (with `batch_size: 5` it reads `T3: after: T1 (pending)`);
- the summary `batch_size 2, running 0, pending 3, admitted 2 (dry run)`.

To run it, ask the agent to run the queue (`start({ workflow: "batch" })`); its `plan_queue` step resumes a queue that has pending lines. Everything else — priorities, `owner:`, the model table, drivers, the plan pane's Plan tab — is in [Task queue and dispatch](/queue).

Checked for this page: the add and the dry-run pick above. Not re-run: a whole dispatch (worktrees, drivers, land), which [Task queue and dispatch](/queue) describes.

## Your own workflow

A project with its own procedure can have its own workflow. There are two paths.

### Ask the agent

The agent loads the bundled `wf-yaml-authoring` skill (the reference for the YAML format) and writes the file. Say what the process is, in your words:

> Make me a workflow for releasing my small npm library: run the tests, bump the version, build, then ask me before publishing. Save it for this project.

What this produced in a scratch project (the engine built from this repository; the skill was the project's own `.claude/skills/workflow-authoring`, the name the bundled skill had then; it is now `wf-yaml-authoring`):

1. The agent loaded `workflow-authoring`.
2. It tried to write `.claude/workflows/release.yaml` with the Write tool (denied: the run was headless).
3. It saved the file with the engine's `create` tool (`scope: "project"`), which answered `Workflow "release" created at <project>/.claude/workflows/release.yaml`.

The file has 14 states; its start and the confirmation step:

```yaml
name: release
description: "Release the npm library: test, bump version, build, confirm with
  the user, publish"
initial: choose_bump
max_transitions: 30
states:
  choose_bump:
    prompt: "Ask the user which version bump to release: patch, minor or major. Then
      store the answer with the workflow context_set tool as key `bump` (exactly
      one of: patch, minor, major) and transition to `continue`."
    transitions:
      continue: run_tests
  run_tests:
    type: exec
    command: npm test
    timeout: 600000
    on_timeout: tests_failed
    on_success: bump_version
    on_error: tests_failed
  # ... bump_version and build (exec), a failure prompt after each ...
  confirm_publish:
    prompt: Tests passed, version is now {{context.new_version}}, build succeeded.
      Ask the user explicitly whether to publish to npm now. Transition
      `publish` only on a clear yes; otherwise `cancel`.
    transitions:
      publish: publish
      cancel: cancelled
  publish:
    type: exec
    command: npm publish
    timeout: 120000
    on_timeout: publish_failed
    on_success: published
    on_error: publish_failed
  # ... publish_failed, cancelled, published, finish and failed ...
```

The engine's own loader accepted it (a `Loader` over the bundled templates plus that directory: 22 workflows, `release` among the project's own), and a later `start()` in the same project listed it in `master`'s routing prompt (`Available workflows: - release — Release the npm library: ...`).

Not checked: running `release` itself (its `npm` steps need a real package), and what an interactive session shows when the Write tool asks for permission.

Read what the agent wrote before you rely on it: the agent's own summary said the build runs after `npm version`, so a failed build leaves the bump commit and tag in place.

### Write the YAML by hand

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
      "mcp__plugin_workflow_wf__sessions"
    ]
  }
}
```

`modify`, `create` and `delete` are deliberately **not** allowlisted either: they change what the engine runs (`delete` removes a workflow file, `create` writes one, `modify` rewrites a live session's graph), so each keeps its confirmation prompt. The engine adds its own guard on top: neither `modify` nor `create` accepts an `exec` or `fetch` state at all, so an agent cannot get a shell command or an HTTP request run through the engine, whatever the permission rules say.

`abort` is deliberately **not** allowlisted: sub-agents inherit permissions, and an auto-allowed `abort` would let a sub-agent silently kill its parent's session. Keep it behind a manual prompt. The engine adds its own guard: an `abort` of a root, or of a session with active descendants, is refused unless the call names `caller_session_id` (its own session, an ancestor of the target) or passes `force: true` with a `reason`.

## Trusting project workflows

An `exec` state runs a shell command as you the moment a session enters it, so a workflow file that comes with a project (a cloned repository's `.claude/workflows/`) runs its `exec` and `fetch` states only in a project you trust.

The engine does not ask you again: it takes the answer you already gave Claude Code. After you accept Claude Code's "trust this folder" question for a project, Claude Code itself runs that project's hooks (`.claude/settings.json`) as shell commands, so the project's workflows add nothing an attacker would not already have.

What you have to do:

- **Bundled workflows, your own `~/.claude/workflows/`, a project file with prompt states only:** nothing.
- **A folder you already trusted in Claude Code:** nothing. An edited workflow file keeps working; no approval after an edit.
- **A fresh clone:** open the folder in Claude Code and accept its trust question. A running engine notices the answer on its next read.
- **A folder Claude Code never asked about** (headless `claude -p`, say): approve the project directory once yourself, in a terminal.

```sh
wf-trust /path/to/project        # shows each command, asks, trusts the project directory on a typed "yes"
wf-trust /path/to/project/.claude/workflows/deploy.yaml   # one file's exact content (its sha256) instead
wf-trust --list                  # what is approved (projects and files)
wf-trust --revoke <project dir | hash prefix>   # withdraw one
```

Until a project is trusted its file with exec/fetch states is left out of the load (a bundled workflow of the same name, `master` for one, runs instead), and `list` and `start` say so in one sentence naming the project and both ways to fix it.

How the engine reads Claude Code's answer:

- The flag `projects[<project path>].hasTrustDialogAccepted` in Claude Code's user config, `$CLAUDE_CONFIG_DIR/.claude.json` (default `~/.claude.json`). It reads that one flag and never writes the file.
- A trusted folder covers the folders below it up to the git root of their repository.
- A worktree counts as its main checkout, but only when its `.git` pointer and the main checkout's record of it agree (a cloned repository cannot borrow another project's trust by naming its `.git`), and `wf-trust` in a worktree records the main checkout.
- The home directory's answer holds for one session only, so it covers nothing.
- A missing file, entry or flag, an unreadable or malformed file, or `CLAUDE_CODE_IGNORE_PERSISTED_TRUST` all mean "not trusted", and then `wf-trust` is the way.
- The flag is an internal record of Claude Code, not a documented interface: if a Claude Code release renames it, the engine falls back to `wf-trust` instead of trusting anything.

`wf-trust` is `scripts/wf-trust` of the plugin (also a `wf-trust` bin of the npm package). It refuses to run without a terminal, so an agent cannot approve for you; no MCP tool of the engine can. Its record is `$STATE_DIR/trusted-workflows.json` (default `~/.claude/workflow-state/`): a running server picks it up on its next read, and per-file approvals of an earlier version keep working. A session already running keeps the definition it started with.

**Strict mode.** For those who want to approve each file's exact content regardless of the folder answer, set `WF_TRUST_STRICT=1` in the environment of the server. Then neither Claude Code's trust nor a project approval counts: a file loads only after `wf-trust` approved its sha256 (`wf-trust <project>` records each file's hash), and an edited file asks again.

`modify` and `create` refuse `exec` and `fetch` states in every mode: an agent cannot get a command run through the engine.

## Heavy commands share one thread pool

Builds and test suites from every session on the machine go through one thread pool, so several agents working at once queue for threads instead of choking the machine:

- `wf-run -- <command>` takes a lease first;
- an `exec` state asks with `resource:`;
- a project can mark commands for the pool gate so an agent's own heavy Bash call goes through it too.

Nothing to set up; the budget defaults to the performance cores minus two. [Thread pool](/pool) shows a real recorded window of it, live, and explains leases, priority, locks and backfill in plain language.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `WORKFLOW_DIR` | `~/.claude/workflows/` | Global workflow YAML directory |
| `STATE_DIR` | `~/.claude/workflow-state/` | Session JSON persistence (also `exec/`: foreground exec output and exit codes) |
| `WF_TRUST_STRICT` | off | `1`: a project file's exec/fetch states load only after `wf-trust` approved that file's exact content; Claude Code's folder trust and project approvals no longer count ([Trusting project workflows](#trusting-project-workflows)) |
| `WF_SUSPENDED_TTL_DAYS` | `7` | A suspended session nobody resumed for this long is abandoned at server start |
| `DASHBOARD_PORT` | `3100` | Web dashboard HTTP port |
| `DASHBOARD_HOST` | `127.0.0.1` | Web dashboard bind address |
