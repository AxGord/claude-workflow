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

- `queue_mark: failed | released` on a terminal state with no transitions (on any other state it is a load error):
  - when the session enters it, the engine marks the session's own queue line (context `queue_file` and `task`) that is still `running` `failed` / `released`, noted `ended <state>: the pipeline made no mark`;
  - a line already marked, a missing queue and a missing line leave the end of the session as it is;
  - bundled `batch-task` declares it on `closed`, `stopped` (`failed`) and `released`, so no task session that ends leaves its line `running`.
- `delivers: <key>` (or `{ key, tokens?, agent? }`) on a prompt state: the context key the agent the state waits on writes its deliverable to; its `context_set` is a delivery the driver acts on without waiting for the agent's end of turn (on a terminal, `sub_workflow`, `exec` or `fetch` state it is a load error): see [Delivery](/action-states#delivery-—-delivers).
- `human: { question, show?, answer_key?, passes?, moved?, stop? }` on a prompt state: a human wait (§ below).

### Human wait — `human:`

A state with `human:` waits for the task's owner, not for an agent.

```yaml
owner_look:
  max_visits: 5               # the owner's rounds
  on_exhausted: blocked
  human:
    question: "Compare the preview of {{context.task}} with main"
    show: ["{{context.preview_links}}"]   # links and files; several lines = one entry each
    answer_key: owner_words   # the answer's text goes here (default human_answer)
    passes: [go]              # the answers that pass the line's human_gate: (default: all)
    moved: rebase             # optional: a passing answer enters this state first when HEAD moved
    stop: 'kill "$(cat .preview.pid)"'    # optional: run once when the session ends
  transitions:
    go: land
    fix: owner_fix
    close: blocked
```

- Entering it, by an agent's transition or an exec's route, records the rendered question and links on the session.
- For a queue task (context `queue_file` and `task`) its line goes `awaiting`: the window slot is free, the line keeps its `touches:` claim, and nothing else takes it ([Queue](queue.md#human-waits)).
- Each transition is an answer. The owner answers with the `answer` tool or from the dashboard. A move out without that answer, or by another route, is refused.
- The move writes the answer's text into `answer_key`. `set` may not ride it.

Rounds and holds:

- The state's own `max_visits` counts every owner round. Every other state's `max_visits` counts from the last answer, so a `fix` round leaves the worker's and the reviewer's caps whole. `{{visits.x}}` still counts all visits.
- `stop` is what the wait holds while its slot is free (a preview server, a port). The session owns it, and the pool does not count it. The command runs once, in the session's cwd, when the session ends: done, closed, aborted, expired.
- A waiting session is not STALE while no answer is recorded, nor while its answered line waits for a slot. Once the pick resumes it, the prompt state's clock runs again from the answer.
- A `stop:` command needs the same consent as an exec state: an untrusted project file with one is not loaded, and `create` / `modify` refuse it.
- Load errors: a `human:` on an exec, fetch, terminal, sub-workflow or skill gate; no transitions; a `passes` entry that is no transition; a `moved` that is no state; `human` with `delivers`.

## Three-Tier Loading

Workflows load from three sources in ascending priority — later tiers override earlier ones:

| Tier | Path | Purpose |
|------|------|---------|
| Bundled | `templates/` (plugin root) | Base workflows shipped with the plugin |
| Global | `~/.claude/workflows/` | User customizations shared across projects |
| Project | `.claude/workflows/` | Project-specific workflows |

A project workflow named `coding` overrides the bundled `coding` template. Same-name global workflows sit in between.

A project file that declares an `exec` or `fetch` state loads only in a trusted project: a folder you trusted in Claude Code, or one approved with `wf-trust <project>` (see [Trusting project workflows](/getting-started#trusting-project-workflows)); until then it is left out and the tier below answers by name. Bundled and global files are not gated.

The project tier is the server's cwd.

A session started with `start({ cwd })` in ANOTHER project that has
its own `.claude/workflows/` sees the workflows that project defines itself laid by
name over the server's.

- A worktree counts as its main checkout; the home dir, whose
  `.claude/workflows` is the global tier, is none.
- A name only the server has is still found: a dispatcher in one repo can run a task by the
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
replaced whole, not merged key by key; new states are added). `initial`, `max_transitions`,
`description`, `model_table`, `resume`, `driver` and `dispatcher` come from the heir where it sets them.

- A heir extending its OWN name inherits that
  name from the tiers below its file (project `coding` → global, else bundled `coding`); another name
  resolves like any workflow name (the top tier).
- Chains work; a cycle, a missing base, or `extends`
  of its own name with nothing below fail the load.
- Reference checks (initial, transitions, routes)
  run on the merged result.
- Without `extends`, `initial` and `states` are required.

**The engine's brief rules survive a replaced state.** A bundled prompt that spawns a worker or a
reviewer names the engine's protocol rules for that agent (waits in the foreground, the `DELIVERED`
hand-back line) as a block: `{{rules.worker_waits}}`, `{{rules.reviewer_waits}}`. The loader expands
the marker once, at load, from one source (`src/brief-rules.ts`); only the block's `{{context.*}}`
placeholders are left for the render.

A heir that replaces such a state whole would lose the paragraph, so the loader carries over every
block the base prompt names that the heir's prompt neither names nor drops. It appends the block to
the heir's prompt under a line saying whom the rules are for, and the driver relays it into its brief.
In the heir's own prompt:

- write `{{rules.worker_waits}}` (or `{{rules.reviewer_waits}}`) where the rules belong in its brief;
  a block the heir names is never carried a second time;
- write `{{rules.none}}` to drop every carried block of that state (it expands to nothing);
- an unknown name (`{{rules.nope}}`) fails the load, and `wf-validate` reports it.

A heir that copied the paragraph by hand keeps working but now carries it twice: delete its copy.

**Extension points.** The bundled workflows expose the steps a project usually wants to own as
states with contract names; bundled, each keeps the old behaviour (the agent does it, or nothing):

| State | In | Bundled default | Routes a heir's exec should keep |
|---|---|---|---|
| `project_test` | `testing` | prompt: the agent runs the tests via a runner subagent | `on_success: check_integration`, `on_error: fix_unit` |
| `project_build` | `testing` | prompt: build before integration | `on_success: integration`, `on_error: fix_integration` |
| `project_gate` | `testing` | exec `true` — no gate | `on_success: done`, `on_error: failed` (the caller's fix round) |
| `project_build` | `bug-fix` | prompt: build the fixed app before the visual check | `on_success: verify_visual`, `on_error: write_fix` |
| `project_prepare` | `batch-task` | exec: `git worktree add <repo>/../.wt/<repo-name>/<ID> -b batch/<ID>`; stdout = the path alone | `on_success: work`, `on_error: prepare_failed` |
| `project_land` | `batch-task` | exec under the lock `{{context.cwd}}-land`: `git merge --no-ff` + the queue's `land_test:` (red → the merge is taken back with `reset --keep`; unsafe → exit 4, nothing touched) | `cases: {"0": mark_done}`, `default: land_failed`, `on_timeout: land_timeout` (an exec: retry twice when the branch is unmerged and the tree clean, else `stop_state`; `max_visits: 2`, each visit re-runs `project_land`) |

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
