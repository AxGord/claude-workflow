---
title: Workflow YAML
description: The workflow file format, tiers, inheritance and project workflows
---

# Workflow YAML

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

## Three-Tier Loading

Workflows load from three sources in ascending priority — later tiers override earlier ones:

| Tier | Path | Purpose |
|------|------|---------|
| Bundled | `templates/` (plugin root) | Base workflows shipped with the plugin |
| Global | `~/.claude/workflows/` | User customizations shared across projects |
| Project | `.claude/workflows/` | Project-specific workflows |

A project workflow named `coding` overrides the bundled `coding` template. Same-name global workflows sit in between.

The project tier is the server's cwd. A session started with `start({ cwd })` in ANOTHER project that has
its own `.claude/workflows/` (a worktree counts as its main checkout; the home dir, whose
`.claude/workflows` is the global tier, is none) sees the workflows that project defines itself laid by
name over the server's — a name only the server has is still found: a dispatcher in one repo can run a task by the
procedure another repo defines (a queue line's `repo:` + `workflow:`).

The SessionStart hook's CLI (`build/session-cli.js`) builds its loader from the same owner (`src/workflow-dirs.ts`) as the server, so a resumed session's routing steps are judged against the same three tiers, the cwd's project tier included.

### `extends:` — inherit a workflow

```yaml
# .claude/workflows/testing.yaml
name: testing
extends: testing          # the global / bundled testing, never this file
states:
  project_test:           # replaces the base state of that name WHOLE
    type: exec
    command: "npm test -- --maxWorkers=$WF_THREADS"
    timeout: 600000
    resource: { threads: 6 }
    on_success: check_integration
    on_error: fix_unit
    on_timeout: suite_slow
  suite_slow:             # a new state joins the base's
    prompt: "The suite timed out — machine loaded? Re-run (`retry`) or report."
    transitions: { retry: project_test }
```

The definition is the base's, with the heir's states laid over it by name (a same-named state is
replaced whole, not merged key by key; new states are added). `initial`, `max_transitions` and
`description` come from the heir where it sets them. A heir extending its OWN name inherits that
name from the tiers below its file (project `coding` → global, else bundled `coding`); another name
resolves like any workflow name (the top tier). Chains work; a cycle, a missing base, or `extends`
of its own name with nothing below fail the load. Reference checks (initial, transitions, routes)
run on the merged result. Without `extends`, `initial` and `states` are required.

**Extension points.** The bundled workflows expose the steps a project usually wants to own as
states with contract names; bundled, each keeps the old behaviour (the agent does it, or nothing):

| State | In | Bundled default | Routes a heir's exec should keep |
|---|---|---|---|
| `project_test` | `testing` | prompt: the agent runs the tests via a runner subagent | `on_success: check_integration`, `on_error: fix_unit` |
| `project_build` | `testing` | prompt: build before integration | `on_success: integration`, `on_error: fix_integration` |
| `project_gate` | `testing` | exec `true` — no gate | `on_success: done`, `on_error: failed` (the caller's fix round) |
| `project_build` | `bug-fix` | prompt: build the fixed app before the visual check | `on_success: verify_visual`, `on_error: write_fix` |
| `project_prepare` | `batch-task` | exec: `git worktree add <repo>/../.wt/<repo-name>/<ID> -b batch/<ID>`; stdout = the path alone | `on_success: work`, `on_error: prepare_failed` |
| `project_land` | `batch-task` | exec under the lock `{{context.cwd}}-land`: `git merge --no-ff` + the queue's `land_test:` (red → the merge is taken back with `reset --keep`; unsafe → exit 4, nothing touched) | `cases: {"0": mark_done}`, `default: land_failed`, `on_timeout: land_timeout` (an exec: retry twice (`max_visits: 2`, each visit re-runs `project_land`) when the branch is unmerged and the tree clean, else `stop_state`) |

`coding` and `bug-fix` verify through `testing`, so one heir of `testing` serves both. Give every
heavy step `on_timeout:` and a state of its own for it.

### When a project should have its own workflow

The bundled workflows fit simple projects and one-off tasks: the agent itself runs whatever build and
tests the project has. A complex project should drive its development through its own workflow in
`.claude/workflows/`. Signs that a project is complex:

- builds, test suites, linters or simulations that take minutes or saturate the CPU;
- a gate a change must pass before it merges (several checks, one verdict);
- several agents working at once, or one long queue of tasks;
- its own merge or release procedure.

Why it pays:

- **Deterministic steps become `exec` states.** Build, tests, gate and merge run inside the engine; the
  agent transitions and gets back only the verdict (keep it short — a table, the first error — and
  write full logs to files). No tokens spent re-reading build output, and no "forgot to run the tests".
- **Heavy steps go through the machine-wide pool** (`resource:`, `fanout:` for shards): sessions of
  every project share one CPU budget instead of racing each other, and a waiting exec costs the agent
  nothing — it sleeps inside the `transition` call until its lease is granted.
- **Short prompts.** A state's prompt says what to do NOW and links the project's docs instead of
  restating them; a worker's brief from the parent shrinks to a few lines.
- **Loops are explicit.** A fix-and-recheck cycle is `max_visits` + `on_exhausted`, not a rule the
  agent must remember; a timeout is `on_timeout`, not a fix round.

How: start with `extends:` — a heir of the bundled workflow under its own name that overrides only
the extension points (`project_test`, `project_build`, `project_gate`) with `exec` states
(`resource:` / `fanout:` where heavy, `on_timeout:` everywhere), so the base process keeps improving
underneath it. Add or replace further states only where the project's process really differs, and
keep judgement (design, code, review) in prompt states. Copy a whole workflow only when the process
itself is different.
