---
name: wf-yaml-authoring
description: Reference for authoring workflow YAML — state types, skill gates, exec/fetch action states, terminals, routing, and engine gotchas
---

## Workflow Authoring Reference

### When a user asks for a workflow

This is the "ask the agent" path of `docs/getting-started.md`: the user describes a process in their words and you write the workflow. Write the YAML to this reference, save it with `create({ name, scope: "project", definition })` (a project workflow, `.claude/workflows/<name>.yaml`; `scope: "global"` for every project; `create` and `modify` REFUSE a definition with an `exec` or `fetch` state — write that file with your file tools and tell the user to run `wf-trust <project>` in a terminal, see "Exec consent" below), and say what you did NOT run: saving only proves the file loaded, not that its commands work. A saved project workflow is listed in `master`'s routing prompt (Step 1, `Available workflows:`), so a later message that matches its description starts it; the user can also name it (`start({ workflow: "<name>" })`). The other two ways to use the engine are the same page's Mode 1 (`start()` with no arguments opens `master`, which routes to a bundled workflow) and Mode 2 (a queue file plus `batch`, see Task queue below).

### Deployment & reload

- Bundled templates load from `templates/` next to the server's `build/` (i.e. `${CLAUDE_PLUGIN_ROOT}/templates`) — once, at server boot. Editing them does NOT hot-reload a running server.
- Load order (later overrides earlier by workflow name): bundled `templates/` → `~/.claude/workflows/` → project `.claude/workflows/`. The project is the server's cwd — except a session started with `cwd:` in ANOTHER project that has its own `.claude/workflows/` (a worktree counts as its main checkout): that session sees the workflows that project defines itself laid by name over the server's (a server-only name is still found; the home dir is no project) — a queue line's `workflow:` runs in its `repo:`. The SessionStart hook's CLI loads the same three tiers (one owner, `workflow-dirs.ts`).
- `~/.claude/workflows/` and the project dir ARE fs.watch'ed; ANY `.yaml` change there triggers a FULL reload that also re-reads bundled templates. Hot-reload trick after editing bundled templates (no server restart): `echo "# t" > ~/.claude/workflows/_trigger.yaml && sleep 1 && rm ~/.claude/workflows/_trigger.yaml`, then verify via `list` (state counts change).
- Active sessions keep their definition snapshot; only NEW `start()` sessions see reloaded workflows. The snapshot lives in the server's memory (engine.ts `_snapshots`), not the state file: after a server restart a session runs the current YAML. A child session snapshots at its own `start()`, so an old pipeline's new review runs the new slice-review.
- A NEW bundled workflow must also be added to `Engine.GLOBAL_WORKFLOWS` (`src/engine.ts`, a hardcoded name set) — otherwise the route prompt lists it under "Available workflows" as if it were a PROJECT workflow and Step 1 routes it via `project`. That is a code change: `npm run build` + server restart (templates hot-reload, code does not). Before deploying anything, check WHICH tree the running server loads: `ps -axo command | grep build/index.js` — a local-marketplace install can be a symlink straight to the repo, and a copy made into the plugin cache then changes nothing.

### Exec consent: `wf-trust`

A project file (`.claude/workflows/*.yaml`) that declares an `exec` or `fetch` state is NOT loaded in a project the user has not trusted. A project is trusted when the user accepted Claude Code's own folder-trust question for it (the engine reads that answer from Claude Code's config; nothing for the user to do, and an edited file keeps loading), or when the user ran `wf-trust <project>` (the plugin's `scripts/wf-trust`, also a `wf-trust` bin) in a terminal: it prints every command, asks for a typed `yes` and trusts the project directory once; `wf-trust <file.yaml>` approves one file's sha256; `--list` / `--revoke <project dir | hash prefix>` manage it. With `WF_TRUST_STRICT=1` only a file's approved sha256 counts and an edited file needs approval again. Until trusted the file is left out (a same-named bundled workflow runs instead; `list` and `start` say which file, which project and how to trust it) and its exec never runs. You cannot approve for the user: no MCP tool does, `wf-trust` refuses to run without a terminal, and `modify` / `create` refuse exec/fetch states outright. Bundled and global (`~/.claude/workflows/`) files are not gated; a project file with prompt states only needs nothing.

### Inheritance: `extends:`

A project workflow for a complex project should INHERIT the base process, not copy it:

```yaml
# .claude/workflows/testing.yaml
name: testing
extends: testing            # same name → the global/bundled testing below this file
states:
  project_test:             # replaces the base state WHOLE (no key-by-key merge)
    type: exec
    command: "npm test -- --maxWorkers=$WF_THREADS"
    timeout: 600000
    resource: { threads: 6 }
    on_success: check_integration
    on_error: fix_unit
    on_timeout: suite_slow
  suite_slow:               # new states are added
    prompt: "Suite timed out. `retry` or report."
    transitions: { retry: project_test }
```

- Merge: base states + heir states by name; `initial` / `max_transitions` / `description` / `model_table` / `driver` / `dispatcher` from the heir when set (a heir inherits the base's `driver:` or `dispatcher:` unless it sets its own whole). Validation (initial, transitions, routes) runs on the MERGED result, so a heir may route to base-only states
- `extends` of its OWN name resolves from the tiers below the file (project → global → bundled); another name resolves from the top tier. Chains work; cycle / missing base / self-extends with nothing below = load error (stderr names it), and a file that fails resolution or validation falls back to the same name one tier down
- Without `extends`, `initial` and `states` are required (strict schema)
- **Extension points** (contract names in the bundled workflows; bundled = the old agent-run prompt or a no-op): `testing.project_test` (run the unit tests: keep `check_integration` / `fix_unit`), `testing.project_build` (build before integration: `integration` / `fix_integration`), `testing.project_gate` (end-of-change gate, bundled `exec true`: `done` / `failed`), `bug-fix.project_build` (build before the visual check: `verify_visual` / `write_fix`). `coding` and `bug-fix` verify through `testing` — one `testing` heir serves both; `batch-task.project_prepare` (the task's worktree, stdout = its path alone: `work` / `prepare_failed`) and `batch-task.project_land` (merge + verify under the repo's land lock: `"0"` → `mark_done`, default → `land_failed`, `on_timeout` → `land_timeout` (an exec: retries twice when the branch is unmerged and the tree clean, else `stop_state`)) — see Task queue below
- Override an extension point with an exec; copy a whole workflow only when the process itself differs
- A gate exec whose verdict must match CI runs the suite in a CI-like clean environment too (`env -i`, an empty `HOME`, no global git identity, another TZ/LANG): a test green only thanks to the local environment then fails before CI. The engine's own `npm run check:ci` (`scripts/check-ci.sh`, inside `npm run check`) is the pattern; its slices run by its project workflow `engine-task` (`extends: batch-task`), a tracked file of that repo (`.claude/workflows/engine-task.yaml`, un-ignored in its `.gitignore`: a workflow a slice must change cannot live only in an ignored directory); a check that lists what a branch changed (a CHANGELOG entry, a reproduction) diffs against the branch's own base (`git merge-base master HEAD`), never the moving `master`.

### State Types

**prompt** (default) — Agent reads the prompt and acts. Standard behavior.

**exec** — Engine runs a shell command automatically. Agent doesn't participate.
```yaml
run_tests:
  type: exec
  command: "npm test"
  cwd: "{{context.cwd}}"
  timeout: 30000
  env:
    CI: "true"
  on_success: analyze
  on_error: fix
  success_prompt: "Tests passed:\n{{stdout}}"
  error_prompt: "Tests failed (exit {{exit_code}}):\n{{stderr}}"
  context_set:
    last_test_output: "{{stdout}}"
```

- `env:` — extra environment variables (map; values are templates), merged over the server's env
- `context_set:` — after the action **succeeds**, render each value with the action result vars and store it in session context (e.g. `last_test_output` above becomes `{{context.last_test_output}}` in later prompts). Skipped entirely on failure.

**fetch** — Engine makes an HTTP request automatically.
```yaml
check_api:
  type: fetch
  url: "http://localhost:8888/ping"
  method: GET
  timeout: 5000
  headers:
    Authorization: "Bearer {{context.token}}"
  body: '{"q": "{{context.query}}"}'
  retry:
    max: 60
    interval: 500
  on_success: ready
  on_error: wait
  success_prompt: "API ready: {{body}}"
  error_prompt: "Not responding: {{error}}"
```

- `headers:`/`body:` — templated; `body` is sent for all methods except GET/HEAD
- `retry:` is **fetch-only** — it is ignored on exec states
- Retries fire only on network errors/timeouts (connection refused, abort). A non-2xx HTTP **response** does not retry — it returns immediately and routes via `on_error`/`cases`
- `context_set:` works on fetch states too (e.g. `{"api_body": "{{body}}"}`)

**skills** — Skill gate. Checks if skills are loaded; blocks if not, auto-transitions if yes.
```yaml
load_skills:
  skills:
    - coding-skill-selector
    - "?project-skill-selector"
  transitions:
    continue: work
```

- Engine tracks loaded skills per session with epoch-based freshness
- First visit: prompts agent to call `Skill("X")` for each missing skill
- After loading + transition: skills marked as loaded for current epoch
- Subsequent visits: auto-transitions silently (agent sees nothing)
- After context clear/plan resume: epoch increments, skills reload on next gate
- `?`-prefix marks a skill **optional**: the gate lists it as "load if available, skip if not found" — use for project-local skills that may not be installed

- Skill gate states have `transitions` (unlike action states) — exactly **one**, conventionally named `continue`. The engine auto-takes the *first* transition when all skills are loaded, and its blocking prompt tells the agent "transition to continue", so any other name breaks the instruction

**full_on_revisit** (per-state flag, prompt states): the state delivers its full prompt
on every visit instead of the `Revisit #N` line. Use it when the text carries what the agent
must do THIS time (a fresh session to start, a value that changed), not a rule it can recall
from the first visit. A YAML using it needs an engine that knows the flag, so build and
restart the engine before the YAML goes in.

**revisit_prompt** (per-state template, prompt states): shown on a revisit instead of the
generic `Revisit #N` line, rendered with the same variables as `prompt` (`{{stdout}}` of the
latest exec, `{{context.*}}`). Use it when a revisit must carry per-visit data without
resending the whole prompt. `full_on_revisit` takes precedence; `status()` still returns the
full prompt. Absent = the generic line. Needs an engine that knows the field.

**ask: parent** (per-state tag): the state asks its parent a question. Entering it logs an `ask` event (the state name), leaving it an `answer`; the dashboard's event log (`/api/events`) carries the pair. Needs an engine that knows the key. A question from ANY state: a driver sets the context key `ask_parent` (one `context_set`) at a hand-back — it is OPEN while the key holds text and the session has not moved or ended since that write; the session's next move or end (the parent's own `transition` on it) or the key cleared to `""` is the `answer`. A stale key is ignored.

**station** (per-state flag, any state): the live workflow map groups bands by project, then queue (`context.queue_file`), then workflow (heading `project › queue · workflow`, one lane per queue line) and draws a workflow's band with one
column per *station* — the states on the shortest happy-path route (`transitions`, `on_success`,
`on_complete`, `cases["0"]`) from `initial` to the success terminal; exec states draw as scripts.
The success terminal is the farthest terminal that is not `outcome: fail` (the early exits —
released, closed — are nearer), or the one terminal marked `station: true` (a mark on a failure terminal or on several terminals is ignored; the loader warns). `station: false` keeps a helper
(`prepare`, a `*_route` exec) out of the columns; `station: true` adds a reachable state off the
path. `/api/workflows` returns the result as `stations: [{name, script, terminal}]`.

**digest_on_repeat** (per-state flag, prompt states): after the state's full
prompt was delivered once in the agent's current context, later deliveries send a
2-line digest ("already delivered earlier — status() for the full text")
instead — for large prompts re-delivered every task (routing rubrics,
doc-sync/reflect ceremony). `status()` always returns the full text; a
template reload clears the delivered-set, and so does a context reset —
every SessionStart (`/clear`, `/compact`, `/resume`) rewrites a per-process
marker (`$STATE_DIR/context-epoch-<claude pid>`) that the server checks on
every status render; the same-session Revisit
abbreviation takes precedence. Do NOT flag states whose prompt a FRESH
agent context may hit mid-flow without having seen it (spawned-agent
workflows share the server process — their first delivery may be a digest;
the status() hint is the recovery, but don't rely on it for load-bearing
one-shot instructions).

**stale_after** (per state, seconds; `0` = never): a session whose state saw no engine call
(any write) for longer is STALE — its agent may be dead or stuck. Unset, by type: prompt 1800,
exec/fetch 3600, a `resource:`/`fanout:` exec 14400; an exec's default is never below its own
`timeout` x 4 (the ceiling of a pool-wait stretch) + 300. A load error on a terminal or `sub_workflow` state (never read). Never STALE: an
ended or suspended session, one with an active child (it waits; each child is judged alone), a
`resource:`/`fanout:` exec waiting for its pool lease (no run yet, or `pool_starved`) while its
owner process lives. Clock = the later of the last write and the run's start (`running_exec`, else
`pending_action.run_at`), so a takeover / resume / `context_set` during a run resets it. Marks:
`sessions` → `[STALE: no engine call for 47m (since …), past its state's stale_after 30m]`;
`status` → the STALE sessions BELOW it on top (`STALE: session <id> (<wf @ state>, child of <p>,
agent <a>) — …`) plus one what-to-do line (SendMessage the agent; no answer → abort, or a new agent
continues from `status` — the session holds the step); `transition` appends them. Give a long
single-step prompt state (one agent turn of an hour) its own `stale_after`; a state waiting for the
user `stale_after: 0` (bundled `batch` `paused`).

### Routing Modes

**Simple** — binary success/error:
```yaml
  on_success: target_if_ok
  on_error: target_if_fail
```

Define **both** routes on every action state. The engine throws at runtime ("Action state has no target for result") the moment an outcome occurs that has no route — an exec that "can't fail" will eventually fail.

**Cases** — route by exit code (exec) or HTTP status (fetch):
```yaml
  cases:
    "0": all_passed
    "1": tests_failed
    "2": no_tests_found
  default: unknown_error   # required with cases
```

Cases overrides on_success/on_error when both are present.

### Template Variables

Available in ALL prompts (not just action states):
- `{{context.cwd}}` — the session's working directory (`start`'s `cwd`, else the server's)
- `{{session_id}}`, `{{parent_session_id}}` (empty at the root)
- `{{project_root}}` — the main checkout of the session's cwd (a linked worktree maps to its main worktree; no repo = the cwd), fixed at `start`: spell a path under the repo (queue file, `lib/` script) with it, not `{{context.cwd}}`, which is a batch task's worktree. A server started before this variable existed renders it empty
- `{{context.<key>}}` — any context value set via context_set, or by `transition`'s `set: {key: value, ...}` (written first, in the same call, all or nothing with the move: an agent's `context_set` + `transition` pair is one request, and the entered exec/prompt sees the keys)
- `{{visits.<state>}}` — visit count of `<state>` in the ACTIVE stack frame (empty if never visited) — route on "did the fix loop run?" without an agent turn
- `{{root_workflow}}` — workflow at the stack root (`subagent` = running as a spawned sub-agent)
- `{{stale_sessions}}` — one `STALE:` line per stale session below this one, or `none` (computed only when a template names it; also in `success_prompt` / `error_prompt` / `context_set`) — bundled `batch` `collect` lists the run's stuck agents with it; a `status` whose prompt renders it shows no second copy on top

After exec/fetch, also available:
- `{{stdout}}`, `{{stderr}}`, `{{exit_code}}` — exec results
- `{{status}}`, `{{body}}` — fetch results
- `{{error}}` — error message (both types)
- `{{pid}}` — PID for background exec
- `{{wait_ms}}` — pool wait of a `resource:` exec

These come from the session's LAST action result (`last_action_result`), not
only the action state's own `success_prompt`/`error_prompt`/`context_set`: the
state the action routes into renders them in its own `prompt` (no
`success_prompt` needed), every later prompt state still sees them, and the
next action state reads them in its `command`/`env` — until that action
replaces them. To keep a result past the next action, `context_set` it.

Templates are single-pass, no recursion. `undefined` → empty string.

Exec env always includes `WF_PLUGIN_ROOT` — the plugin root (dir holding
`templates/` and `scripts/`), resolved from the engine's own module location.
Reference bundled scripts as `command: "sh \"$WF_PLUGIN_ROOT/scripts/foo.sh\""`
— portable across install paths, no per-machine setup. A state's own `env:`
key of the same name overrides it. It also carries `WF_PROJECT_ROOT` (= `{{project_root}}`), `WF_SESSION_ID`,
`WF_PARENT_SESSION_ID` (empty at the root), `WF_ROOT_SESSION_ID`,
`WF_PRIORITY` / `WF_PRIORITY_LEVEL` (the session level, below) and
`AGENT_CONTEXT` (tokens of the last turn of the agent linked to the session:
input + cache read + cache write; empty when none is linked or its transcript
is unreadable — test `[ "${AGENT_CONTEXT:-0}" -gt N ]` to hand off to a fresh
agent); a `resource:` exec with threads also gets `WF_THREADS` (below).

An exec without `cwd:` runs in the session's cwd — a sub-agent started with
`start(cwd: <worktree>)` runs its execs in the worktree, not the server's tree;
a relative `cwd:` resolves against it. Each exec's history entry carries
`exit_code` and `duration_ms` (plus `wait_ms`, `threads_granted` and
`step_key` = `<project git root>|<workflow>|<state>` for a `resource:` exec);
every session end appends one line to `$STATE_DIR/ledger.jsonl` with them, plus `spend`: the task's real cost summed from the transcripts of the agents the session ever linked (a respawned worker's earlier agents too) or names (`agent_id_<stage>`, `<role>_agent` context keys), unmeasured (never $0) when one cannot be read; `spend.by_agent` lists it per agent, state and stage the agent was linked at (`link_agent` records each call's time, the parent's state and that state's stage under any parent; a worker linked again for a fix round splits at the call) and `wf-calibration` sums it into the `$` / `$/task` columns of the stage rows; the plan pane (what it draws is `hooks/pane-view.ts`, one pure module the mod and the documentation site's landing both draw) shows it per Landed and Failed row (`—` when unmeasured), as a day sum on each Landed day and in the Failed header (`✗ Failed (28) · $41.20 (parent $6.10)`: every ledger row of the recent failed lines, agents' `spend.usd` plus the row's `parent_spend.usd`, a row nested under a same-task row adding only its parent spend, and how many lines have no row); the Landed heading sums the landed lines' spend and adds `parent $P (S%)`, the top-level session's own spend in the queue repo's conversations. A task's ledger line records that as `parent_spend` (the conversation's own turns since the conversation's previous line, priced by the same table, tiled so a turn is in one line, read from a recorded byte offset so only the new turns are read, with the transcript's `project`; absent when its transcript cannot be read).
A sub-workflow `push` history entry carries `workflow` and `to` (the sub-workflow's first state), so the time spent in every state can be read from the history alone (the dashboard's Timeline tab does: a bar per session that carries a `slice` / `task` id, its agent sessions folded under it); the ledger's `transitions` and `visits` do not count it as a move.

Unknown keys are a LOAD ERROR (strict schema): a typo like `comand:` drops
the whole workflow, and stderr names the file, state, key and nearest known key.

### Background Exec

```yaml
start_build:
  type: exec
  command: "make build"
  background: true
  on_success: poll_ready
  on_error: build_failed
```

- Process runs detached, PID saved in `session.background_pids`
- stdout/stderr go to a temp log file
- `on_success` fires immediately (process started OK)
- `timeout` is **ignored** on background exec — the process runs until it exits or the session is aborted
- Abort (and a parent's abort cascade) kills each background exec's whole process group — `sh -c` and its children; a timeout on a foreground exec does the same
- Session scope: `start` without `parent_session_id` while this process already has an active root is REFUSED (the reply names the root by workflow @ state, never its id; `force: "<reason>"` starts a second root on purpose) — a sub-agent always passes `parent_session_id`, and reads its own session with `status`. `abort` of a root or of a session with active descendants is refused unless `caller_session_id` (your own session id) is the target or an ancestor of it, or `force: true` + `reason`; `transition` with a `caller_session_id` outside that subtree is refused the same way. A `transition` with no `caller_session_id` stays open on purpose: the engine's own prompts step other sessions without one, and a step ends no session. The abort hints the engine prints name the caller (`abort({ session_id, caller_session_id })`), so following one is not refused. Every cascade abort is logged to stderr with the caller and the session count
- Abort also kills a FOREGROUND exec still running in that session (or a descendant) at once — it does not wait for the exec to finish; the interrupted transition returns an error instead of routing the killed result

### Restart: suspended sessions and execs in flight

- Claude Code exiting SUSPENDS its sessions (and their sub-agents' sessions) — never abandons them; nothing ends, no ledger line. `claude --resume` / `--continue` (same conversation id) PICKS THEM UP in the SessionStart hook: the sessions and their sub-trees belong to the new process, nothing to call — the hook names each (`picked up: <session> @ <workflow @ state>`) and the sub-agent sessions with the `SendMessage` that wakes each agent (the agent calls `status` on its OWN session — no `resume`, never a new `start`); a session with no `agent_id` up to the root is taken for the main agent's own (`no agent linked — yours, unless a sub-agent you spawned runs it`) — so `link_agent` every spawned agent; under a parent of a `driver:` workflow (only there), an agent linked at an earlier visit of the parent's current state (a fix round re-entered it) is named `… an earlier visit's agent — not woken; abort(…) once it is not needed`, with no wake `SendMessage` (so is one linked at another STEP of the parent than its current one: `… an earlier step's agent — not woken …`) — any other parent's agents (a dispatcher looping `dispatch`) are all woken as before. The action step a session stopped in — an exec in flight, finished, killed by the restart, or never started (e.g. waiting for a pool lease) — is finished by the first `status` / `transition` of its session: waited for, its result taken, or run again (that `transition` is not taken — the session moved on). `startup`, another account, `--fork-session`: explicit — `suspended()` lists them by project, `resume({ session_id })` continues one (and lists its sub-agents to wake, each calling `resume` on its own session). Unresumed for `WF_SUSPENDED_TTL_DAYS` (7) → abandoned
- After `/compact` (or `/clear`) the hook output, which lands in the new context, lists the process's active sessions as a tree (id, workflow @ state, nested stack, agent) — the orchestrator knows where it is; `status()` gives the full prompt
- A spawner that wants its sub-agents woken by name after a restart calls `link_agent({ session_id: <child>, agent_id })` once the child session id is known. When the parent is a session of a `driver:` workflow (its states run one agent per visit — opt-in by workflow, no state flag) it also records the parent's step beside the agent (`agent_step`: the parent's workflow, state and that state's visit; linking again re-records it); any other parent records none, and nothing below applies to its agents (every call, under any parent, is still recorded in `agent_links` with its time, the parent's state and that state's stage, for the ledger's per-agent spend). For such a parent `status` lists `LINKED AGENTS at <state> (visit N)` — each child agent linked at the current state: `linked at visit N → current`, or `linked at visit 1, now visit 2 → stale (its session ended)` / `an earlier visit's (its session still runs)`; at a `_spawn` state (`work_spawn`, `plan_spawn`) also the running agent linked at the state before it (routing steps skipped; its session started there), `→ live (its session still runs)`, so a re-spawned driver messages it instead of spawning a second worker (a driver answers a harness `[handback-send-enforce]` prompt mid-run with the WAITING line only, never a hand-back). An agent reused at a later visit (a fix round's SendMessage to the same worker) needs `link_agent` again, else it shows as an earlier visit's — never keep a visit key in the context for this
- A foreground exec running at exit keeps running (detached, own group, output and exit code in files); `resume` waits for it or takes its recorded result, and runs the step again only when neither survived (reboot). So an exec state may be finished by a DIFFERENT server process than the one that started it — keep exec commands self-contained (no reliance on the server's lifetime). A `fanout:` state is re-run, not taken over. Output files are not capped while the command runs (`yes` writes until the `timeout`); `max_output` is the BYTES of tail read back. `--fork-session` (new conversation id) picks nothing up — `suspended()` lists the sessions
- MCP calls longer than ~120 s are moved to a background task of the Claude session, which does not survive its exit — the exec does, and the resumed session's first `status` (or `resume`) picks it up

### Heavy Work: `resource:` and `wf-run`

Light commands (a lint, a grep, a quick build check) run as plain execs — no
queue, they never wait. HEAVY work (a full test suite, a release build, a
corpus run) takes threads from ONE machine-wide pool shared by every session,
project and Claude config dir (`$WF_POOL_DIR`, default `~/.claude/workflow-pool`):

```yaml
run_suite:
  type: exec
  command: "npm test"
  timeout: 600000
  resource: { threads: 6, priority: 0, wait_timeout: 900 }
  cases:
    "0": analyze
    "75": machine_busy      # no lease within wait_timeout
  default: fix
```

- Admission: `held + N <= budget` and, beside a live lease, `held + N + external <= budget` — external load never blocks an EMPTY pool. `budget` defaults to performance cores − 2; `external = max(0, load − own − load_threshold)` is load not taken through the pool (`own`: per lease with threads, the larger of its threads and the busy cpus of its own process tree — a command that spawns more than it leased does not block the queue as "external"; it is flagged `runs ~N (OVERRUN)` instead — and NOT bounded: admission only keeps `held ≤ budget`, so pass `WF_THREADS` on or the machine is oversubscribed), `load` = busy cpus measured from cpu ticks over the window since the pool's previous pass (loadavg1 only before a window exists — it lags a minute), `load_threshold` (default 2) is the noise floor. These settings and `starve_after` (seconds, default 900: a waiter queued that long, or a pool that granted nothing that long, is STARVED — marked in `pool_status`, logged in `<pool dir>/pool.log`, and a starved exec's session shows `POOL STARVED` in its and its ancestors' `status` / `transition`) live in `<pool dir>/config.yaml`
- Queue order: priority descending, then arrival; a lock goes to its waiters in queue order. The first waiter blocked only by threads is the **head** and holds a reservation (starved or not): a later task starts ahead of it (**backfill**) only when its estimate ends before the threads the head waits for (its min; a flexible head inside `wait_full`: its max) are expected free — the running leases' estimated ends in order; a lease with no estimate, past it or over-running ends at an unknown time, and then nothing passes. Estimates: p90 of the step's last successful runs in the ledger on the same threads (≥3 runs, within 30 days; a `fanout:` step has none; a flexible lease carries the estimate of its granted size), or `wf-run --est SEC`; with neither, the p90 of the last 10 runs of the same command (its label with the slice id dropped; ≥3 runs, clean ends only, kept in the pool's `history`) — so a lease or a waiter with no ledger history still takes part. No estimate on either side → strict order. A lease backfilled past a head that runs past 2× its estimate sets `backfill_off` for that head — nothing passes it any more (`backfill:` / `backfill off:` lines in `pool.log`). No preemption. `threads` above the budget counts as the budget: it waits for an empty machine and runs alone
- **`start({ …, reply: "id" })`**: the answer is `SESSION: <id> @ <state>` only (a `driver:` workflow's DRIVER block still follows) — no prompt, TRANSITIONS or rules. Use it where a parent starts a child just to pass the id to that child's own agent, which reads the prompt with `status`; without `reply` the answer is the full prompt
- **Priority = session level + step `priority`**: levels `low` −100, `normal` 0, `high` 100, `urgent` 200 — `start({ priority })`, inherited by child sessions, else the project default, else `normal` (project default: `{ "priority": "urgent" }` in `<project root>/.claude/workflows/settings.json` — a worktree counts as its main checkout, the loader ignores it as it reads only `*.yaml`; applies to a root `start` with no `priority` and to a bare `wf-run` outside a session; a bad file makes `start` fail, never silently ignored; `wf-run --status` / `--usage` never read it); keep a step's own `priority` under ±100 so it only fine-tunes within the level. `set_priority({ session_id, level })` changes a session and its descendants on the fly and re-ranks their WAITING entries at once (running leases keep theirs — no preemption). Every exec gets `WF_PRIORITY` (the sum) and `WF_PRIORITY_LEVEL`; `wf-run` without `--priority` takes them (outside a session: the project default), so a nested `wf-run` queues at its session's level. Old level kept in two windows: an exec between building its context and joining the queue (waits at the old level until granted), and a `wf-run` inside an exec started before the change (its `WF_PRIORITY` is from the spawn). Call `set_priority` only on the user's request — never raise your own session or change another project's
- **Flexible threads**: `threads: { min: A, max: B|budget }` (+ `wait_full: SEC`, default 0) / `wf-run --threads A-B [--wait-full SEC]` — gets B when B fits; otherwise, once `wait_full` has passed (counted from the waiter's arrival; with locks, from the moment they are first free, so time queued behind a lock does not use it up), everything free if it is ≥ A. While it waits (for B inside the window, for A after it) it closes the threads to those behind it like any waiter. **With an estimate for every size A..B** (the ledger's p90 per size, a curve fitted through the sizes that have ≥3 runs, ≥2 of them; or `wf-run --est-by-threads K:SEC,…`) `wait_full` is not used: the pool takes the size whose estimated end is earliest — start (now if it fits, else when the running leases' estimated ends free it) plus its run time — so it starts now on the free room or waits briefly for more, never for a fixed window; a lease with no estimate / past it / over-running is not waited for; no history → the `wait_full` rule. `WF_THREADS` = what was granted — read it, never assume B. For work that scales with cores (test suites, parallel builds) where an earlier start beats a wider one When the history (or `--est-by-threads`) cannot cover every size, the size is still picked by `wait_full`, but the granted lease carries `est_ms` from the measured sizes (nearest size, as is).
- `<pool dir>/pool.log`: one `sample:` line a minute while a lease or waiter exists and some pass runs (a polling waiter, `--status`, `pool_status`, a release) — `sample: load 7.5 external 1.1 held 8/10 runs 11.4 leases 2 waiting 3 [2-8, 4]`: machine load, external load, threads held/budget, busy cpus of the leases' process trees (`-`: unmeasured), the first four waiters' asks (`+N` more) — read it to tell whether the CPUs were busy while a waiter waited on threads; beside it the `orphan:` / `overrun:` / `underuse:` / `starved:` / `backfill:` lines; rotated to `pool.log.1` past 1 MiB; the documentation site replays it: `scripts/export-replay.mjs` cuts the samples of the replay's window (a lease or waiter keeps its label only when it names a slice or session of the replay, every other one is a thread count in one row of leases the log does not name (a sample lists no holders: only an `overrun:` / `underuse:` / `backfill:` line names one, shown from the next sample; the replayed Pool tab marks it `OVERRUN ~N` / `UNDERUSE ~N` like the live pane), and `assertReplayClean` refuses the write on any other label, a path or a pid) into `docs/public/replay/anyparse.json`, and `docs/pool.md` plus the landing's pool strip and Pool tab draw it (the log carries no priority and no age per lease, so the replayed rows show none); the same export keeps the sessions of anyparse and of the engine's own project (`--project`, `--also`; `--workflows DIR` loads the stations of the engine's own `engine-task`, which lives in its project directory) and reads each task's `spend.usd` from `ledger.jsonl` (`--ledger FILE|none`, only the replay's tasks: `ledgerSpend`, and `assertReplayClean` refuses a spend of any other task), so the replayed pane shows `$x.xx` on a Landed row and `—` for a task with no measured spend; it also reads the queue file (`--queue FILE|none`) through the engine's own pick (`planPick`, `describeQueue`) over the file rolled back to the window's start (every line that ran at or after it set back to pending; a line claimed before it and not ended at it is `running` at the start, so a line `after:` it waits `after: X (running)`) and writes the pending lines of those projects as ids, difficulty, priority, kind and a fixed set of reasons (`captureReplayQueue`; never a line's text or notes, and `assertReplayClean` refuses anything else), so the replayed pane's Next and Waiting fill and a line moves Waiting, Next, Running as the lines it waits for end (a line added after the window cannot be rebuilt)
- `wf-run --status` / the `pool_status` tool: one line per lease and waiter — pid, held/wanted threads and locks (`, runs ~N` for a measured lease, `(OVERRUN)` / `(UNDERUSE)` when far above / below its threads for 30 s), priority + level, since when (`STARVED`), project (git root), session, step, label; a `STARVED:` line when the pool granted nothing for `starve_after`
- `wf-run --usage [--since 90m|24h|2d]`: per label key (slice ids and hashes as `*`) over the leases that ended in the window — `n`, mean threads `held` and `used`, `idle thr-min`, `over thr-min`, `sampled` share — from `<pool dir>/usage.jsonl`; use it to right-size a caller's `resource: { threads }` (a lease is the caller's declaration; the pool only reports `underuse:` / `overrun:`)
- `threads: budget` (the only non-number value, strict) asks for the whole budget as `config.yaml` sets it when the request is made (a later raise does not grow a waiting or held lease) — no hardcoded core count; `wf-run --threads budget` is the same
- **The lease counts threads, it does not enforce them**: compilers, test runners and optimizers take every core by default. The command gets `WF_THREADS` = the threads granted (after `budget`/the clamp) — pass it on: `make -j"$WF_THREADS"`, `vitest --maxWorkers="$WF_THREADS"`, `HXCPP_COMPILE_THREADS="$WF_THREADS"`, `APQ_ORACLE_PARALLEL="$WF_THREADS"`. Env only (no template var); absent for a light exec, a lock-only lease and `--efficiency`. A step that empties its environment (`env -i`) drops `WF_THREADS` too: carry it over by name. A serial pipeline with a narrow half and a wide half cannot match held to used with one lease: take a lease per half, one after the other from the command (two `wf-run`, never nested: a lease around a second `wf-run` waits on itself). Size a range's `max` from a measurement of held against used (`LC_ALL=C ps`), not `budget`: a threads-fixed run holds what it does not use.
- `locks: [NAME, …]` (one word each: `port:3000`; a name may template a session value, `"{{context.cwd}}-land"` — rendered whitespace becomes `_`) — machine-wide mutual exclusion by name, for dev servers / bridges / devices on fixed ports. `threads` is optional beside `locks` (at least one of the two; lock-only takes no threads and is never blocked by load). Threads and locks are granted ATOMICALLY (all or nothing, nothing held while waiting → no deadlock); a lock goes to its waiters in queue order, and a waiter blocked by a held lock claims no threads, so a long-held lock does not stall the queue
- `wait_timeout` (seconds) expired → exit **75** (busy), routed through `cases`/`on_error` like any exit; without it the exec waits until granted or aborted (abort withdraws the wait)
- A `transition` / `start` / `resume` / `status` call that waits for an exec (pool lease queue included) sends an MCP progress notification every 60 s (`waiting for pool lease (Ns)` / `running <state> (Ns)`) when the client gave a `progressToken`, so Claude Code's no-response timeout does not cut the call.
- `timeout` counts the run, not the wait: a lease the exec itself waits for is not counted, and neither is the time a `wf-run` inside its command (it carries the session's id) has a waiter queued in the pool — the deadline stretches by that wait (also the part of it that fell in a server restart), capped at 4x the `timeout` so a pool that never grants still ends the exec; the history entry and the ledger record `wait_ms` beside `duration_ms`; `{{wait_ms}}` is a template var
- Foreground exec only: `resource:` with `background: true` (or on a fetch) is a load error
- **Shards: `fanout:`** — `fanout: { count: N | items_command: "<prints one item per line>", threads_each: k, max_parallel?: M }` on an exec runs the command N times (`WF_SHARD=i/N`, 1-based — the `vitest`/`jest --shard` form) or once per non-empty line (`WF_ITEM=<line>`), each instance under its OWN lease of k threads (`WF_THREADS`), started as threads free up, at most M in flight (default: budget / k — what runs side by side). Leases take no `wait_timeout` / `locks` / step `priority`. `timeout` is PER SHARD (default 30s — set it). Exit 0 only if every shard exits 0; else the failing shards' common code (all timed out → 124 → `on_timeout`), or 1 when they differ. `{{stdout}}` = summary (`fanout: 3/4 ok, 1 failed (exit 1)`) + each failed shard's output tail. Abort kills running shards, withdraws waiting ones, starts no more. History/ledger: one `shards` entry per instance. Load error beside `background` or `resource`; a failing `items_command` fails the step without running a shard
- A shell step inside a larger command, or an agent's own Bash call, uses the CLI instead: `"$WF_PLUGIN_ROOT/scripts/wf-run" --threads 6|budget [--lock NAME]… [--priority P] [--wait-timeout SEC] [--est SEC] [--est-by-threads K:SEC,…] [--label TEXT] [--fail-open] -- <cmd> [args…]` — same pool and admission, the child runs in its own process group, SIGINT/SIGTERM/SIGHUP are forwarded, the exit code is the child's (75 = busy), the child gets `WF_THREADS`; `--lock` without `--threads` is lock-only; a SIGKILLed `wf-run` cannot release: the next pool pass kills its detached child's group (SIGTERM, SIGKILL after 3 s; never a group from another boot or with another leader) and frees the lease — an exec's group, by contrast, outlives its server for `adopt`; `--efficiency` (macOS) runs the command on efficiency cores via `taskpolicy -b`, outside the budget
- **Pool gate (agents' own Bash calls)**: the plugin's PreToolUse(Bash) hook rewrites a command the project's `.claude/workflows/pool-gate.yaml` (nearest from the directory the command runs in up to the git root: the call's cwd moved by the command's leading `cd <dir> &&` / `;` segments, not by a later `cd`; a directory with no config falls back to the call's cwd's; the call's cwd's own config keeps its `deny` rules even when the target has a config, a deny in either refuses, heavy routing follows the target) marks heavy into `<plugin>/scripts/wf-run --fail-open --threads <N|MIN-MAX> --label '<cmd>' -- <shell> -c '<cmd>'`; no config / no hit → untouched. Rules: `{ match: "<leading words>" | "/regex/", threads: N | "MIN-MAX", pass?: "--flag=$WF_THREADS" | "env:NAME", deny?: "<reason>", env?: { NAME: true | false | "/regex/" } }` (`env` tests the segment's own leading `NAME=value` assignments, which `match` never sees: `true` set, `false` unset, a regex on the value; first hit per segment wins; a flag goes before `--`, never doubled; `deny` refuses watch modes) + `wrappers: [scripts that call wf-run themselves]`. One `wf-run` for the whole command, the largest share of its hits; `--fail-open` = a pool that cannot be used (read-only / sandboxed dir) runs the command unleased. A segment that runs `wf-run` or a wrapper is never matched against the rules, `deny` included; the other segments of that command still are. Left alone: `WF_THREADS` already set (an exec under a lease), `wf-run` or a wrapper in the command, a background `&`, a heredoc; `WF_POOL_BYPASS=1 WF_POOL_BYPASS_REASON='…' <cmd>` skips it with a stderr note. Any hook failure → the command runs as is. With `rtk` on PATH the body goes through `rtk rewrite` (Claude Code keeps only the last `updatedInput`, i.e. the gate's); RTK's exit 0 → auto-allow. Never add an allow rule for `…/scripts/wf-run` (it would allow any wrapped chain). Not seen: `npx -y …`, `sudo …`, `nice …`, `$( )`; the inner shell has no Bash-tool snapshot (aliases, functions). Do not hand-write `wf-run` around a command the gate already covers — and never start a watch mode it refuses under another spelling

### Task queue: `batch`, `queue_next` / `queue_mark` / `queue_add` / `queue_edit` / `queue_header`, `wf-queue`

A queue is a YAML file the engine admits from: top-level keys are the header — `batch_size: N` (`0` = paused: running tasks finish, nothing new is admitted) with `reason:`, and any other key (`base: [path=sha]`, `land_test:`, `land_branch:` — the branch the queue's lands target, read by the plan pane's Landed tree (absent: the queue repo's checked-out branch, else `main`), `record_file:` — a file `batch-task`'s `mark_done` appends one record line to per landed task; relative = beside the queue; `overlap:`); `tasks:` is a list of `{id, status, difficulty, kind, priority, model, effort, repo, workflow, after: [ids], touches: [paths], owner, sweep, exclusive, breaking, parked, ended, restored, base, text_hash, text, notes: [{from, date, text}]}` (`ended` = the day queue_mark moved the line to done or failed; mark-written, queue_add / queue_edit refuse it; `restored` = the day `wf-queue --restore` brought a done / failed line back from the archive: the archive counts the line's age from the later of `ended` and `restored`, it is removed with `ended`, and queue_add / queue_edit refuse it; `base` = HEAD of the line's repo and `text_hash` = short sha256 of text + touches + owner (+ sweep when set), where the line was written: queue_add writes both, queue_edit rewrites both only when it changes text, touches, owner, sweep or the repo (a re-spelling of the same repo keeps them), both refuse them as input; no `base` outside git; a line written before has neither and stays valid; the line's `base` is not the header's `base:` list). `status`: `pending | running | done | failed | backlog` (backlog = never picked). Keys: `model`, `effort` (`model: —` = parent-run, never admitted; so is a repo-bound line whose `touches:` entry git ignores in its repo, e.g. a live `.claude/` workflow — queue_add/queue_edit warn on it), `after:` (waits for done; an unknown id-like token or prose beside the ids = manual, not admitted), `touches:` (prefixes on a `/` boundary must not overlap a running or just-admitted task of the SAME repo; NO `touches:` = overlaps every task of its repo, runs alone there; header `overlap: files` = only FILE entries conflict, on the same file — no glob, and a regular file under the task's repo (`Makefile`), or, not there yet, a last segment holding a `.`; a directory or glob entry is then a hint; default `overlap: paths`; another value refuses the pick only), `owner:` (equal or `.`-prefix = one at a time, across repos too), `sweep:` (one non-empty line, the command a sweep line runs over its tree: data for the project's workflow, no pick rule reads it; `queue_next` prints it), `exclusive: true` (overlaps every task of its OWN repo, not another repo, in either mode: mass moves, renames, reformats; while it waits only for running lines of its repo it HOLDS the repo — no later line (priority, file order) of that repo is admitted, `--explain` says `held for exclusive <ID>`, other repos are not held; the header key `exclusive_hold: no` turns the hold off), `breaking: true` (a format/protocol change with no compat for running processes: admitted only into an empty window, nothing else admitted while it runs; that picker rule is the engine's — handing the land to the parent (`NEEDS-PARENT reason=breaking land ready`) is a route the project's task workflow must carry, and a line on plain `batch-task` lands as usual), `repo:` (absolute, or a name: the `base:` repo of that basename, else the dir beside the queue's project; default = the queue's project), `workflow:` (the task's own task workflow, found from its repo; default the dispatcher's `task_workflow`; not one word = not admitted), `difficulty:` (1..10, `-` = none; the task workflow's `model_table` maps it to model/effort — prefer it to `model`/`effort`; outside 1..10 = not admitted), `kind:` (`bug|feature|research`, absent or `-` = feature; any other value = not admitted; the pick only reports it, `queue_next` and the exec form's last column carry it, a task workflow reads it as `kind`; the dashboard's Plan tab and live map and the plan pane draw it as one glyph after the difficulty bar: `※` bug, `⚑` research, `◆` feature, GET `/api/queue` lines carry `kind` and `mark`), `priority:` (`urgent|high|normal|low`, default normal: the picker admits ready lines by priority, then file order; the pick's report shows it; GET `/api/queue` gives each pending line its place in that order as `admitOrder`, which the plan pane's Waiting tab sorts by), `parked: true` (skipped until unparked), `text` (the brief, a block scalar). A bad status or a duplicate id refuses every read. A task key this server does not know (written by newer code) is kept on write and inert for the pick; `queue_next` / `queue_mark` name it (`unknown key priority on X: ignored by this server`); `queue_add` / `queue_edit` still refuse it in their input. Writes edit the parsed document in place (key order and comments kept).
- Admission: window = `batch_size` − running; pending tasks by `priority:`, then file order; each admitted task is set `running` under the queue's lock (`<file>.lock`, mkdir — two picks never admit one task).
- Which queue: every queue tool and `wf-queue` takes an optional `queue` NAME beside `file`; neither = the project's `.claude/batch/queue.yaml`, `queue: "<name>"` = `.claude/batch/<name>.yaml` (project = git root of the cwd, a worktree → its main checkout), a full `file` still works; both = error. The dispatcher resolves a name ONCE and `context.queue_file` stays the absolute path task sessions get (never re-resolve a name from a task's own repo). `queue_add` / `--add` on a missing queue addressed by name or by default CREATES it (`batch_size: 1`, `tasks: []`; a full `file` path that does not exist is an error, never created) and says so; the other ops error naming the resolved path.
- MCP: `queue_next({ queue?, file?, dry_run?, explain? })` → id / model / effort / repo / workflow, difficulty (when set), kind, priority (when set) / text per admitted task; `queue_mark({ queue?, file?, id, to: running|done|failed|released|promoted|shelved, note?, from?, retry?, force? })` — pending→running (refused when the picker would not admit the line — overlap, after, exclusive, breaking, parked — naming why; `force: "<reason>"` overrides and is noted), running→done/failed/pending, backlog→pending, pending→backlog only (`retry: true` + `running`: failed→running, its `difficulty:` +1, at most 10); `note` is appended to `notes:` as `{from, date, text}`. `queue_add({ queue?, file?, task: {id, …}, after_id?|before_id? })` (pending or backlog; refused: a known id, an unknown key, an `after:` id that names no task or closes a cycle, `workflow:` not one word, `repo:` unresolved, `difficulty:` outside 1..10 or missing on a pending line (`difficulty: <1-10> is required on a pending line`; backlog, `parked` and `model: —` lines need none; `queue_edit` and `queue_mark` `promoted` refuse the same way when they would leave a pending line without one, a line already without stays editable), `kind:` not bug|feature|research; it writes `base` / `text_hash`), `queue_edit({ queue?, file?, id, set?: {field: value}, append_note?, from? })` (`""`/null removes a field; `after`/`touches` a list or a comma string; not the status; a change of text, touches, owner, sweep or repo rewrites `base` / `text_hash`), `queue_header({ queue?, file?, batch_size?, reason?, archive_after_days?, exclusive_hold? })` (the window `batch_size` + `reason` together, and/or `archive_after_days` — a whole number ≥ 1, `null` removes it, and/or `exclusive_hold` — `yes` / `no`, `null` removes it; no other key), no archive tool: the header key `archive_after_days: N` (set by `queue_header` / `wf-queue --header-set archive_after_days=N`; absent = never) makes every pick move the done / failed lines that ended over N days ago to `<queue>.archive.yaml`, under the pick's lock (an `after:` still resolves an archived id, an archived id cannot be added again; a failed line an open line names stays; the CLI forms are manual: `wf-queue --archive --older-than N [--include-unended] [--dry-run]`, `--restore ID`; `--convert --into` refuses an archived id too). A write lands only if the file is unchanged since its read (else re-plan) — change a live queue through these, never a script. Keep the queue file untracked + ignored (a tracked one dirties the tree; the land refuses a dirty tree, exit 3)
- Exec form `"$WF_PLUGIN_ROOT/scripts/wf-queue" [<file>|--queue NAME] [--dry-run] [--explain|--explain-all]` (`--explain` folds the `window full` tasks into one, `--explain-all` lists each): stdout `ID\tmodel\teffort\trepo\tworkflow\tdifficulty\tkind` (`-` = no `workflow:` / `difficulty:`; `kind` is `feature` when the line has none) per admitted task, summary + reasons on stderr; exit **0** admitted · **10** none, running ones still run · **11** none, nothing runs (done) · **12** none, nothing runs, `batch_size: 0` · **2** error. `--done|--failed|--release|--running|--promote|--shelve <ID> [--note T] [--from W]` (`--running <ID> --retry`, `--running <ID> --force REASON`), `--header <key>`, `--path` (the resolved file), `--add '<YAML mapping>' [--after ID|--before ID]`, `--edit <ID> [--set k=v]… [--append-note T]`, `--batch-size <N> --reason T`, `--header-set archive_after_days=N` / `exclusive_hold=yes|no` (`=` empty removes), `--lessons <ID> --records FILE… [--triage FILE] [--repo DIR] [--workflow NAME]` (a landed task's lesson records → queue lines / triage rows, prints `lessons=filed N, triage M`; see the lesson records bullet below), `--lessons-take [--triage FILE]` (prints the triage file and empties it under the lock a land's append takes). One-time conversion: `--convert <old.md> [--into <q.yaml>] [--status S]` (prints, writes, or APPENDS the old file's open lines with status S to an existing queue, `--status pending` refused with exit 2 when a line has no `difficulty:`; `⏸` → parked, mark/dated fields → notes), `--convert <config.json> [--into <config.yaml>]` for the JSON configs.
- Bundled `batch` (dispatcher: `plan_queue` → `pick` exec → `dispatch` → `collect` → `slot_free` → `pick` …, `paused`, `cross_check`) starts one child session per admitted line: `context.task_workflow` (default `batch-task`: `claim` → `project_prepare` [worktree `<repo>/../.wt/<repo-name>/<ID>`, branch `batch/<ID>`] → `work` → `work_check` [exec: one clean commit on the branch; the driver has no shell] → `review_scope` [exec: the diff's class] → `review` [FIXES → `work`] → `project_land` [`git merge --no-ff` + the header's `land_test:`, a red test takes the merge back with `reset --keep` only while HEAD is that merge, else exit 4 untouched; lock `{{context.cwd}}-land`] → `mark_done` [exec: done + the `record_file:` line] → `cleanup`). With a `driver:` task workflow (bundled `batch-task`) `dispatch` starts each task with `start({…, context: {task, queue_file, difficulty}})`, spawns the DRIVER block of the answer unchanged and `link_agent`s it; `collect` routes on the drivers' one-line answers (`LANDED` / `CLOSED` / `NEEDS-PARENT`; a `LANDED` line ends with `lessons=filed N, triage M` (plus ` triage_file=<path>` when M > 0; `lessons=not run` when the step failed): its lesson records are already filed by `wf-queue --lessons`, `collect` reads nothing for them, and the triage rows are read in a batch with `wf-queue <q> --lessons-take` (prints and empties the file under the lock) and each becomes a `queue_add` line, a memory note or nothing; a `CLOSED` line ends with `lessons=<phrase (file)>; …|none` — the agents' own follow-ups, copied — and `collect` turns each into a `queue_add` line, a memory note or nothing; a reject or block → SendMessage the driver to take `reject` / `close`), ignores workers and reviewers under a driver (after a restart such a line is relayed to that P's driver), and re-spawns a lost driver from `status({session_id: P, key: "driver_call"})`. A re-spawned driver takes only a `current` agent of P's `LINKED AGENTS` as this visit's; none current → the prompt from its first step. A project heir: `extends: batch` overriding `plan_queue` with an exec that `context_set`s `queue_file` + `task_workflow` (master's `enqueue_plan` finds a heir by `extends: batch` in the project's workflow files, reads its `plan_queue` for the queue it names and `queue_add`s an approved multi-task plan there, header untouched — keep that queue readable from the exec; the bundled `plan_queue` resumes a queue whose `queue_file` is already in the context); its own task workflow (or `extends: batch-task` overriding the two extension points).
- **`driver:`** (workflow level, in the TASK workflow): `{ model, effort, prompt_ref, agent_type? }` — the cheap agent that runs the task session for the dispatcher. `prompt_ref`: a bare name = shipped `templates/drivers/<name>.md` (`task-driver`; unknown name fails the load), else a path (absolute, `~/…`, relative to the session's cwd). The initial state must be a prompt state (else the load fails). `start` of such a workflow ends its answer with a DRIVER block — the exact Agent call (model, effort, background, `subagent_type` = `agent_type`, default `workflow:driver`, prompt filled with session id, `context.task`, `context.queue_file` or the parent's, the instructions path; a missing file → WARNING) + its `link_agent` — and keeps it in the context as `driver_call`. A driver messaged after its last line is NOT finished (P still holds the step): it calls `status` on P and continues. A driver never calls a tool on the dispatcher session: on a terminal prompt it replies with its last line. `start`'s `context` (string map) seeds the session's context (`cwd` / `claude_code_pid` refused; `difficulty` goes through the `model_table`). A transition into a state already visited answers `Revisit #N` without rendering its prompt: the values the agent remembers from that prompt are the FIRST visit's — a prompt that needs current values on a later visit names the context keys to read (`status` with `key`), never `{{visits.…}}` or `{{context.…}}` alone. Declaring `driver:` also opts the workflow's sessions into visit-scoped agent links: `agent_step`, the `LINKED AGENTS` block and the restart wake-skip of an earlier visit's agent (see `link_agent`). The `agent_link` event of such a session records the DRIVER's `model` / `effort` (the block's values), not the task's execute model in its context, so the dashboard's driver chip and the replay's `driver · <model>` show what the driver runs on.
- **`dispatcher:`** (workflow level, in the DISPATCHING workflow; bundled `batch` declares it, a heir inherits it): `{ model, effort, prompt_ref, agent_type?, env?, after? }` — an OPT-IN cheap agent that drives the dispatcher session itself for the main conversation. `env` = the environment variable that turns it on (bundled: `WF_DISPATCHER`; set in the Claude Code process, e.g. the settings `env` block; empty / `0` / `false` / `off` / `no` = off; no `env` key = always on); off, the workflow behaves as if the key were absent and `start` answers byte for byte as before. On: `start` ends its answer with a DRIVER block for the dispatcher (Agent call with `subagent_type` = `agent_type`, default `workflow:dispatcher`; the `link_agent`; what it hands back; one depth line) kept in the context as `dispatcher_call`, and the `transition` reply that leaves the `after` state (bundled: `plan_queue`, so the main conversation still builds the queue) repeats it, also through an exec chain. The main conversation then spawns it and takes no transition of that session. The agent (`templates/drivers/dispatch-driver.md`) does `dispatch` (start per admitted line with `reply: "id"`, the task driver's DRIVER block verbatim, `link_agent`, `dispatched` with `tasks` in the transition's `set`) and `collect` (`slot_free` with `tasks` + `lessons_pending` in the `set` on a `LANDED` / `CLOSED` line; absorbs WAITING lines and notifications; relays a stray worker / reviewer line to that task's driver; pings then re-spawns a dead driver from `driver_call`). It hands the main conversation ONLY: a driver's `NEEDS-PARENT` line verbatim (answer by SendMessage to the dispatcher, starting `task=<ID>:`), `LESSONS lands=<n> session=<D>` + the drivers' last lines once per `lessons_every` lands (a queue HEADER key, default 5; copied, never judged; also kept in `lessons_handed`), and `HANDOVER session=<D> state=<s>` at a state it does not drive (`paused`, `pick_failed`, `cross_check`, `report`: the main conversation drives it and sends `continue`). Engine guards under such a session: a second `start` of a `context.task` already running there is refused (names the session), and the restart pickup names the dispatcher's SendMessage in place of the task sessions of its `tasks` key and their sub-trees (it wakes the task drivers; a sub-session `tasks` does not name is still listed for the main conversation; before the session left `after` with no agent linked the pickup is unchanged). Needs `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=4` (main → dispatcher → driver → worker → helper). Unlike `driver:`: no `agent_step`, no wake-skip; `driver:` and `dispatcher:` on one workflow fail the load, as does an unknown `after` state. A project heir with its own `collect` prompt needs no key, but every step of its prompts that needs a queue tool, a shell or a judgment is the main conversation's at the LESSONS hand-back.
- **Shipped agent types** (`agents/`, after a Claude restart): `workflow:dispatcher` (haiku/medium, only under the `dispatcher:` opt-in: `start` / `status` / `transition` / `context_set` / `link_agent` + Agent/SendMessage/Read — no abort/delete/queue_mark/queue_edit/queue_add, no Edit/Write/Bash; its rules are the file its spawn prompt names), `workflow:driver` (haiku/medium, the workflow MCP tools `start` / `status` / `transition` / `context_set` / `link_agent` / `queue_mark` / `queue_edit` + Agent/SendMessage/Read, no abort/delete/create/modify, no Edit/Write/Bash — the task-driver rules are its system prompt, so its spawn prompt is `P = <id>`), `workflow:recon` (sonnet/medium) and `workflow:reviewer` (opus/high), read-only by tool list (no Edit; a Write tool that the `read-only-gate` PreToolUse(Write) hook limits to the task's report directory — an absolute path under a `<task>.log` / `<task>-logs` directory in scratch space, outside a git work tree, no `..`) AND by the `read-only-gate` PreToolUse(Bash) hook: those types may run Bash only as an ALLOW list: the first word of every pipeline segment must be a declared reader (built-in: ls, cat, head, tail, wc, rg, grep, jq, find without actions, `sed -n '<n>p'`, git log/show/diff/status/grep/blame…), no `$( )`/backticks, brace expansion, `printf -v` or `$` in a command word, no `NAME=value` prefix unless its name is in the config's `envAllowed` (`GIT_*`, `LD_*`, `DYLD_*`, `PAGER`, `PATH`, `BASH_ENV`, `ENV`, `IFS` never), no redirect outside scratch (nor to a variable or glob), and the write list stays — a guard against ACCIDENTAL writes, not an adversary; the project's `.claude/read-only-commands.yaml` (`read`: extra readers, leading words or `/regex/` — its read-only CLIs; `write`: leading words or `/regex/`; `envAllowed`: variable names a `NAME=value` prefix may set; `env`: exported before the command only when a segment starts with a `read` CLI (the rewrite then carries `permissionDecision: "allow"`, so every other segment must be a project reader, a no-file default or a stdin filter behind a pipe, where a grep/rg flag value such as `-C 3` is not a file operand — else the call is denied, run it in its own call; other allowed calls pass unchanged), e.g. `APQ_READ_ONLY=1`; `agents`: override the type names) extends the built-in lists. A project may extend a type in its own `.claude/agents`.
- **Agents answer in one line, the text is in files**: bundled `batch-task`'s worker writes `report.md` (`handoff.md` when it stops unfinished), in `<worktree>.log` (kept after cleanup); the reviewer is the read-only `workflow:reviewer` (no workflow tools, no session; its Write is limited to scratch space), so its `review.md` is `/tmp/wf-batch-logs/<ID>/review.md`; answers `DONE <sha> report=…` / `BLOCKED …` / `VERDICT MERGE|FIXES|REJECT … review=… design=yes|no`; a fix round sends the line + "read <file> whole", never the text. The files carry named sections the driver copies as `lessons` (up to two): `report.md` / `handoff.md` `## Follow-up not done`, `## Tool defect found`, `## Open`; `review.md` `## Notes (non-blocking)`; a fix round or later review carries the previous file's items forward. **Lesson records**: a worker or reviewer may end its answer with `lessons=<one-line JSON>` (`engine-task`: a `LESSONS: <JSON>` line) = `{"lessons":[{id,kind,touches,repro,text}]}`; the driver copies it verbatim into the `set` of its next transition (`lessons` on the worker's `check`, `review_lessons` on the verdict); after the land the `lessons_file` exec (`wf-queue <q> --lessons <ID> --records …`, never fails the land: `lessons=not run`) files `unverified` as a backlog line (priority low) and `arm-rot-on-base` as a pending one (high, difficulty 4), each with the task's `repo:` / `workflow:`; every other kind and every refused record (bad id / kind, empty text or repro, `touches` empty / over 8 / glob / directory / absent and not `(new)` in the task's repo, a taken id, a duplicate of an open line) becomes a row of the triage file (`--triage`, else header `lessons_triage:`, else `../backups/slice-logs/lessons-triage.txt` beside the queue's directory) the dispatcher reads in a batch; the driver's `LANDED` line carries `lessons=filed N, triage M` (and ` triage_file=<path>` when M > 0, so the line alone says where the rows wait); `wf-queue <q> --lessons-take` prints and empties the triage file under the same lock. Spawn prompts say once that a transition reply IS the next prompt — never `status` after it. The round cap stays: a third FIXES (the Nth by context `max_fixes`) is NEEDS-PARENT, decider or not. An earlier FIXES with `design=yes` goes to a fresh opus decider (context `memory_index`, optional) that writes `decisions.md` in `<worktree>.log` and answers `DECIDED file=…` or `ESCALATE reason=…`; only ESCALATE produces NEEDS-PARENT; the driver's `LANDED` line gains ` decided=<file>` and `batch` `collect` audits it.
- **`model_table:`** (workflow level, in the TASK workflow): `rows: [{ upto, model, effort }]` (ascending `upto`, last = 10; effort `low|medium|high|xhigh|max`) = the execute rows, or `stages: { <name>: rows[] }` (any name `^[a-z][a-z_]*$` except `model`/`effort`/`step`/`reached`, e.g. `recon` for a cheap recon spawn; plan/execute/review/review_verify/fix are the five the bundled workflows use; each stage its own rows; `stages.execute` replaces `rows`, giving both is refused; a malformed or reserved name, a stage short of 10, or a state reading `context.model_<x>` / `effort_<x>` for an undeclared stage fails the load) — `difficulty` then also writes `model_<stage>` / `effort_<stage>` for every declared stage and `model_reached`, while `model` / `effort` stay the execute row; `escalate` moves the execute and fix stages only, `escalate: { <state>: N }`, `review: { <class>: { model, effort } }`. `context_set` of `difficulty` (the claim sets the line's) → the engine writes `model`, `effort`, `model_step`, `escalations` (the answer names them; outside 1..10 refused). Every move into a state recomputes the row = the difficulty's + one per `escalate` entry whose state's visits reached N (capped); a moved row rewrites model/effort (a `model` history line). Escalation is per session: fix rounds, and a blocked re-entry within one session (a workflow whose `blocked` routes back declares `escalate: { blocked: 1 }`); no hidden state crosses sessions — in bundled `batch-task` `blocked` ends the session, and `queue_mark` `retry: true` (`wf-queue --running <ID> --retry`) rewrites the line's `difficulty: N` to `min(N+1, 10)` in the line itself (the answer says `(difficulty 4 → 5)`), so the re-run starts a row up; a line without `difficulty:` is retried unchanged. `review_class` set (an exec: `sh "$WF_PLUGIN_ROOT/scripts/review-class.sh" <base> <tip>` → `light` when every changed path is a test or a doc: root `docs/` / `specs/`, `tests/` / `__tests__/` anywhere, `*.md`/`.rst`/`.adoc`, `*.test.*` / `*Test.*`, CHANGELOG/LICENSE/README; a nested `docs/` package, a `.txt` build file, `docs/**/.vitepress/` or a script/`.vue` under `docs/` is code; else `code`) → `review_model` / `review_effort` (the class's entry, which overrides the review stage; else the review stage's row; without stages the task's own). The nearest table down the stack applies. Bundled `batch-task` is stage-aware (plan 1–3 sonnet/high, 4–8 opus/high, 9–10 opus/xhigh; execute 1–6 sonnet/high, 7–8 opus/high, 9–10 opus/xhigh; review 1–8 opus/high, 9–10 opus/xhigh; review_verify sonnet/high; fix 1–6 sonnet/high, 7–10 opus/high), `escalate: { work: 3 }` (second fix round → a fresh worker on the new model), review `light` sonnet/medium and no `code` entry. Interactive workflows take it too: bundled `coding` and `bug-fix` declare the stage table without `escalate`; `difficulty` set at `start` or by the plan state (`think` / `diagnose`) makes their implementer and reviewer spawns use `model_execute` / `model_review` (+ `effort_*`), no difficulty = the prose rule. **Difficulty rubric** (by the WORK, for a queue line and a plan step alike): 2 one function; 3 one owner; 4 a few files at one owner; 5 a new rule or command on existing parts; 6 a new shared component or config key; 7 cross-file typing or an unknown cause; 8 a contract moving across packages; 9-10 a whole-tree redesign that must be split; +1 when the premise is a stale measurement or a hypothesis. Ledger lines carry `difficulty`, `model`, `effort`, `escalations`, `review_model`, `review_effort`, `claim_difficulty` (the first difficulty; `wf-calibration` bands by the final `difficulty` and counts a claim off by >=2 in its `claim` column), `stages` (model/effort each stage ran on: its row when a state reading it was entered (in a prompt state also the bare `model` / `effort` = execute, `review_model` / `review_effort` = review; an exec's env does not count), first value wins; only those stages, so one absent from the line did not run), `tokens` (`tokens` → total, `tokens_<role>` → role; the driver sets `tokens_worker` / `tokens_review`) — tune the table from them

### Terminal States & Outcomes

```yaml
report:
  prompt: "Write the final report per the contract above."
  task: "Final report"
  transitions:
    done: finish
finish:
  terminal: true
  outcome: complete   # or "fail"
```

- **Hard terminal** = `terminal: true` with no transitions. Entering it auto-pops the stack frame (sub-workflow returns to parent; root frame completes the session)
- A hard terminal's `prompt` **is delivered**: the engine renders it and prepends it to the pop/completion status, separated by a `---` divider — use it for final instructions (report contracts, push steps)
- `task:` on a hard terminal is **ignored** (the state is popped before a task op could be emitted). When you need a task op at the end, use the soft-terminal pattern above: a prompt state carrying the `prompt`/`task` with a `done` transition into a bare `finish` terminal
- **Soft terminal** = `terminal: true` WITH transitions: the session is marked finishable but stays in the state; the agent may re-enter/continue via its transitions
- **Outcome collapse on pop**: `outcome: fail` routes the parent to its `on_fail`; anything else (including omitted `outcome`) routes to `on_complete`. If the parent state lacks the needed route, the pop parks as pending (a `modify` adding the route resumes it)
- A ROOT frame ending on `outcome: fail` leaves the session `failed` (shown by `status` / `sessions`); a parent reads a finished child's results via `status(child_session_id)`, which lists its context with each value cut to 200 chars; `status({ session_id, key })` returns that one value whole (a gate table, an edit list)

### Common Patterns

**Review lives with the spawner**: a workflow that spawns code-writing
workers owns the ONE fresh-eyes review of their diff; the worker itself
stops at lint + its own intent re-read (a reviewer spawned inside the
worker re-pays what the spawner already pays, and cannot see seams
between workers). Never both — a worker review plus a parent review of
the same diff is paid twice; and never neither — a parent that assumes
the workers reviewed ships unreviewed code. Only a root session with no
spawner reviews its own writes (reviewer agents; lint-only for a trivial
diff).

**Decide once, flag in context**: when several states share one decision
(is the file user-authored? is the lint report usable?), have ONE state
evaluate it and `context_set` a verdict flag; downstream prompts guard on
`{{context.flag}}`. Re-stating the decision criteria in each consumer
drifts (guards diverge, agents re-evaluate inconsistently) — exactly the
bug class a single flag eliminates.

**Test-before-commit**: `exec(npm test)` → success → `exec(git commit)` → done

**Health check polling**: `fetch(url, retry: 60x500ms)` → success → interact

**Build-and-verify**: `exec(make, bg)` → `fetch(health, retry)` → ready

**Multi-step pipeline**: chain action states — exec → exec → fetch → prompt
(max chain depth: 20, no agent involvement between action states)

**Loop re-entry needs its own state, not a jump into assess**: when a
fix/retry transition routes back into a general decision state, audit that
state's OUTBOUND transitions first — an early-exit there (`skip → done`)
lets the agent end the loop without re-running the verification the loop
exists to guarantee. Give the retry a dedicated re-entry state that offers
only loop-preserving routes. Dual of the inbound rule: adding a gate before
state X requires auditing ALL transitions INTO X for bypasses.

### Gotchas

- stdout/stderr truncated to `max_output` bytes (default 10KB, configurable per state). Truncation keeps the **tail** (last N bytes), not the head — errors at the end of output are preserved. Use higher values for verbose builds (e.g. `max_output: 51200`)
- Default timeout: 30s (exec), 5s (fetch)
- Exec timeout → SIGTERM to the process group (SIGKILL after 5s grace) and **exit code 124**; `{{error}}` is "Process timed out". Route it with `on_timeout: <state>` (foreground exec; wins over `on_error`/`cases`; beside `cases: {"124": …}` = load error) — a heavy gate that timed out must NOT fall into the code-fix loop
- Action states CANNOT have `transitions` or `sub_workflow`
- Action states route via on_success/on_error or cases/default only
- `success_prompt`/`error_prompt` are templates, rendered with action result vars
- If neither prompt template is set, the next prompt state's own prompt is used
- **A chained action state's prompt is DISCARDED**: in an exec→exec→… chain only the LAST state's `success_prompt`/`error_prompt` reaches the agent. The engine renders each state's prompt, then recurses into the next action state without passing it on — every intermediate one is dropped silently. So an intermediate state can never REPORT anything: a check whose whole value is its output (a `--list`, a `--dry-run`, a diff stat) is invisible where it sits. Either make it the chain's last state, have it ACT rather than report (`--write` over `--list`), or gate it on a non-zero exit into its own prompt state — and note that a `--list`-style check usually exits 0 whether or not it found anything, so `cases` never fires and the chain sails past
- Background processes are NOT monitored — use a subsequent fetch/exec to check
- **Template injection**: `{{...}}` values are substituted **unescaped** into `command:` and run via `sh -c`. A context value containing quotes, `$`, `;`, or backticks breaks the command — or executes as shell. Never interpolate untrusted/free-form context into commands; keep interpolated values to known-safe tokens (paths you set, enum-like flags). **Safe channel for everything else — `env:`**: env values are set on the process, never parsed by the shell, so `env: { REVIEW_FILE: "{{context.file_path}}" }` + `command: "script.sh \"$REVIEW_FILE\""` is injection-proof. Any AGENT-set context value (a `context_set` an agent made — e.g. a file path from a reviewed repo, where a hostile `$(cmd).hx` filename would otherwise execute) and even engine-set paths (`{{context.cwd}}` — a `$(payload)`-named directory) must go via `env:`, not into `command:`
- **Guards throw unless routed**: a move past a state's `max_visits` throws (the transition is refused) — unless that state has `on_exhausted: <state>`, which enters that state instead (agent transitions, action-state routes and skill-gate auto-transitions alike; chained routes are followed, a route cycle throws; the history entry's `detail` names the exhausted states; a rerouted action move shows the routed-to state's own prompt, not the action's `success_prompt`/`error_prompt`; `on_exhausted` without `max_visits` or to an unknown state is a load error). `{{visits.<state>}}` in the exhausted-route state's prompt shows how many tries ran. A pop's `on_complete`/`on_fail` move does not check `max_visits`. Hitting `max_transitions` throws, except for a move that only closes the run (into a terminal, or into a state no route leads back to that reaches a terminal); within 5% of the cap the reply carries a `WARNING:` line
- `max_transitions` accounting is **per stack frame** — each sub-workflow push starts a fresh counter checked against that workflow's own `max_transitions` (default 50)
- **Duplicate YAML keys** — parser rejects the entire file with a `YAMLParseError`; the loader logs it to stderr and skips the file (workflow not loaded). Always validate YAML before deploying (no duplicate `success_prompt`, `error_prompt`, etc. on the same state)
- **Long-running commands** (dev servers, log tailers, watchers — anything that doesn't exit) — always use `background: true`. A foreground exec resolves when its `sh -c` exits (output goes to files, not pipes): a command that never exits blocks until its `timeout`; a grandchild it leaves running keeps running in the exec's process group, untracked — and is killed by the next abort of the session. On `timeout` the group gets SIGTERM, then SIGKILL after 5 s, and the step resolves only once the group is gone
- **Foreground build + background deploy** pattern: use foreground `build` (catches errors) then background `test/run` (streams logs), then poll readiness via `fetch` with retry
