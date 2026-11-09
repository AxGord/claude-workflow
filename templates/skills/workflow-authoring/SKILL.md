---
name: workflow-authoring
description: Reference for authoring workflow YAML — state types, skill gates, exec/fetch action states, terminals, routing, and engine gotchas
---

## Workflow Authoring Reference

### Deployment & reload

- Bundled templates load from `templates/` next to the server's `build/` (i.e. `${CLAUDE_PLUGIN_ROOT}/templates`) — once, at server boot. Editing them does NOT hot-reload a running server.
- Load order (later overrides earlier by workflow name): bundled `templates/` → `~/.claude/workflows/` → project `.claude/workflows/`. The project is the server's cwd — except a session started with `cwd:` in ANOTHER project that has its own `.claude/workflows/` (a worktree counts as its main checkout): that session sees the workflows that project defines itself laid by name over the server's (a server-only name is still found; the home dir is no project) — a queue line's `workflow:` runs in its `repo:`.
- `~/.claude/workflows/` and the project dir ARE fs.watch'ed; ANY `.yaml` change there triggers a FULL reload that also re-reads bundled templates. Hot-reload trick after editing bundled templates (no server restart): `echo "# t" > ~/.claude/workflows/_trigger.yaml && sleep 1 && rm ~/.claude/workflows/_trigger.yaml`, then verify via `list` (state counts change).
- Active sessions keep their definition snapshot; only NEW `start()` sessions see reloaded workflows. The snapshot lives in the server's memory (engine.ts `_snapshots`), not the state file: after a server restart a session runs the current YAML. A child session snapshots at its own `start()`, so an old pipeline's new review runs the new slice-review.
- A NEW bundled workflow must also be added to `Engine.GLOBAL_WORKFLOWS` (`src/engine.ts`, a hardcoded name set) — otherwise the route prompt lists it under "Available workflows" as if it were a PROJECT workflow and Step 1 routes it via `project`. That is a code change: `npm run build` + server restart (templates hot-reload, code does not). Before deploying anything, check WHICH tree the running server loads: `ps -axo command | grep build/index.js` — a local-marketplace install can be a symlink straight to the repo, and a copy made into the plugin cache then changes nothing.

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

- Merge: base states + heir states by name; `initial` / `max_transitions` / `description` / `model_table` / `driver` from the heir when set (a heir inherits the base's `driver:` unless it sets its own whole). Validation (initial, transitions, routes) runs on the MERGED result, so a heir may route to base-only states
- `extends` of its OWN name resolves from the tiers below the file (project → global → bundled); another name resolves from the top tier. Chains work; cycle / missing base / self-extends with nothing below = load error (stderr names it), and a file that fails resolution or validation falls back to the same name one tier down
- Without `extends`, `initial` and `states` are required (strict schema)
- **Extension points** (contract names in the bundled workflows; bundled = the old agent-run prompt or a no-op): `testing.project_test` (run the unit tests: keep `check_integration` / `fix_unit`), `testing.project_build` (build before integration: `integration` / `fix_integration`), `testing.project_gate` (end-of-change gate, bundled `exec true`: `done` / `failed`), `bug-fix.project_build` (build before the visual check: `verify_visual` / `write_fix`). `coding` and `bug-fix` verify through `testing` — one `testing` heir serves both; `batch-task.project_prepare` (the task's worktree, stdout = its path alone: `work` / `prepare_failed`) and `batch-task.project_land` (merge + verify under the repo's land lock: `"0"` → `mark_done`, default and `on_timeout` → `land_failed`) — see Task queue below
- Override an extension point with an exec; copy a whole workflow only when the process itself differs
- A gate exec whose verdict must match CI runs the suite in a CI-like clean environment too (`env -i`, an empty `HOME`, no global git identity, another TZ/LANG): a test green only thanks to the local environment then fails before CI. The engine's own `npm run check:ci` (`scripts/check-ci.sh`, inside `npm run check`) is the pattern; its slices run by its project workflow `engine-task` (`extends: batch-task`)

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
`timeout` + 300. A load error on a terminal or `sub_workflow` state (never read). Never STALE: an
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
- `{{context.<key>}}` — any context value set via context_set
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
key of the same name overrides it. It also carries `WF_SESSION_ID`,
`WF_PARENT_SESSION_ID` (empty at the root), `WF_ROOT_SESSION_ID`,
`WF_PRIORITY` / `WF_PRIORITY_LEVEL` (the session level, below); a
`resource:` exec with threads also gets `WF_THREADS` (below).

An exec without `cwd:` runs in the session's cwd — a sub-agent started with
`start(cwd: <worktree>)` runs its execs in the worktree, not the server's tree;
a relative `cwd:` resolves against it. Each exec's history entry carries
`exit_code` and `duration_ms` (plus `wait_ms`, `threads_granted` and
`step_key` = `<project git root>|<workflow>|<state>` for a `resource:` exec);
every session end appends one line to `$STATE_DIR/ledger.jsonl` with them, plus `spend`: the task's real cost summed from the transcripts of the agents the session links or names (`agent_id_<stage>`, `<role>_agent` context keys), unmeasured (never $0) when one cannot be read; the plan pane shows it per Landed and Failed row (`—` when unmeasured) and as a day sum on each Landed day.
A sub-workflow `push` history entry carries `workflow` and `to` (the sub-workflow's first state), so the time spent in every state can be read from the history alone (the dashboard's Timeline tab does); the ledger's `transitions` and `visits` do not count it as a move.

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
- Abort also kills a FOREGROUND exec still running in that session (or a descendant) at once — it does not wait for the exec to finish; the interrupted transition returns an error instead of routing the killed result

### Restart: suspended sessions and execs in flight

- Claude Code exiting SUSPENDS its sessions (and their sub-agents' sessions) — never abandons them; nothing ends, no ledger line. `claude --resume` / `--continue` (same conversation id) PICKS THEM UP in the SessionStart hook: the sessions and their sub-trees belong to the new process, nothing to call — the hook names each (`picked up: <session> @ <workflow @ state>`) and the sub-agent sessions with the `SendMessage` that wakes each agent (the agent calls `status` on its OWN session — no `resume`, never a new `start`); a session with no `agent_id` up to the root is taken for the main agent's own (`no agent linked — yours, unless a sub-agent you spawned runs it`) — so `link_agent` every spawned agent; under a parent of a `driver:` workflow (only there), an agent linked at an earlier visit of the parent's current state (a fix round re-entered it) is named `… an earlier visit's agent — not woken; abort(…) once it is not needed`, with no wake `SendMessage` (so is one linked at another STEP of the parent than its current one: `… an earlier step's agent — not woken …`) — any other parent's agents (a dispatcher looping `dispatch`) are all woken as before. The action step a session stopped in — an exec in flight, finished, killed by the restart, or never started (e.g. waiting for a pool lease) — is finished by the first `status` / `transition` of its session: waited for, its result taken, or run again (that `transition` is not taken — the session moved on). `startup`, another account, `--fork-session`: explicit — `suspended()` lists them by project, `resume({ session_id })` continues one (and lists its sub-agents to wake, each calling `resume` on its own session). Unresumed for `WF_SUSPENDED_TTL_DAYS` (7) → abandoned
- After `/compact` (or `/clear`) the hook output, which lands in the new context, lists the process's active sessions as a tree (id, workflow @ state, nested stack, agent) — the orchestrator knows where it is; `status()` gives the full prompt
- A spawner that wants its sub-agents woken by name after a restart calls `link_agent({ session_id: <child>, agent_id })` once the child session id is known. When the parent is a session of a `driver:` workflow (its states run one agent per visit — opt-in by workflow, no state flag) it also records the parent's step beside the agent (`agent_step`: the parent's workflow, state and that state's visit; linking again re-records it); any other parent records none, and nothing below applies to its agents. For such a parent `status` lists `LINKED AGENTS at <state> (visit N)` — each child agent linked at the current state: `linked at visit N → current`, or `linked at visit 1, now visit 2 → stale (its session ended)` / `an earlier visit's (its session still runs)`. An agent reused at a later visit (a fix round's SendMessage to the same worker) needs `link_agent` again, else it shows as an earlier visit's — never keep a visit key in the context for this
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
- Queue order: priority descending, then arrival; a lock goes to its waiters in queue order. The first waiter blocked only by threads is the **head** and holds a reservation (starved or not): a later task starts ahead of it (**backfill**) only when its estimate ends before the threads the head waits for (its min; a flexible head inside `wait_full`: its max) are expected free — the running leases' estimated ends in order; a lease with no estimate, past it or over-running ends at an unknown time, and then nothing passes. Estimates: p90 of the step's last successful runs in the ledger on the same threads (≥3 runs, within 30 days; a flexible or `fanout:` step has none), or `wf-run --est SEC`. No estimate on either side → strict order. A lease backfilled past a head that runs past 2× its estimate sets `backfill_off` for that head — nothing passes it any more (`backfill:` / `backfill off:` lines in `pool.log`). No preemption. `threads` above the budget counts as the budget: it waits for an empty machine and runs alone
- **`start({ …, reply: "id" })`**: the answer is `SESSION: <id> @ <state>` only (a `driver:` workflow's DRIVER block still follows) — no prompt, TRANSITIONS or rules. Use it where a parent starts a child just to pass the id to that child's own agent, which reads the prompt with `status`; without `reply` the answer is the full prompt
- **Priority = session level + step `priority`**: levels `low` −100, `normal` 0, `high` 100, `urgent` 200 — `start({ priority })`, inherited by child sessions, default `normal`; keep a step's own `priority` under ±100 so it only fine-tunes within the level. `set_priority({ session_id, level })` changes a session and its descendants on the fly and re-ranks their WAITING entries at once (running leases keep theirs — no preemption). Every exec gets `WF_PRIORITY` (the sum) and `WF_PRIORITY_LEVEL`; `wf-run` without `--priority` takes them, so a nested `wf-run` queues at its session's level. Old level kept in two windows: an exec between building its context and joining the queue (waits at the old level until granted), and a `wf-run` inside an exec started before the change (its `WF_PRIORITY` is from the spawn). Call `set_priority` only on the user's request — never raise your own session or change another project's
- **Flexible threads**: `threads: { min: A, max: B|budget }` (+ `wait_full: SEC`, default 0) / `wf-run --threads A-B [--wait-full SEC]` — gets B when B fits; otherwise, once `wait_full` has passed, everything free if it is ≥ A. While it waits (for B inside the window, for A after it) it closes the threads to those behind it like any waiter. `WF_THREADS` = what was granted — read it, never assume B. For work that scales with cores (test suites, parallel builds) where an earlier start beats a wider one
- `wf-run --status` / the `pool_status` tool: one line per lease and waiter — pid, held/wanted threads and locks (`, runs ~N (OVERRUN)`), priority + level, since when (`STARVED`), project (git root), session, step, label; a `STARVED:` line when the pool granted nothing for `starve_after`
- `threads: budget` (the only non-number value, strict) asks for the whole budget as `config.yaml` sets it when the request is made (a later raise does not grow a waiting or held lease) — no hardcoded core count; `wf-run --threads budget` is the same
- **The lease counts threads, it does not enforce them**: compilers, test runners and optimizers take every core by default. The command gets `WF_THREADS` = the threads granted (after `budget`/the clamp) — pass it on: `make -j"$WF_THREADS"`, `vitest --maxWorkers="$WF_THREADS"`, `HXCPP_COMPILE_THREADS="$WF_THREADS"`, `APQ_ORACLE_PARALLEL="$WF_THREADS"`. Env only (no template var); absent for a light exec, a lock-only lease and `--efficiency`
- `locks: [NAME, …]` (one word each: `port:3000`; a name may template a session value, `"{{context.cwd}}-land"` — rendered whitespace becomes `_`) — machine-wide mutual exclusion by name, for dev servers / bridges / devices on fixed ports. `threads` is optional beside `locks` (at least one of the two; lock-only takes no threads and is never blocked by load). Threads and locks are granted ATOMICALLY (all or nothing, nothing held while waiting → no deadlock); a lock goes to its waiters in queue order, and a waiter blocked by a held lock claims no threads, so a long-held lock does not stall the queue
- `wait_timeout` (seconds) expired → exit **75** (busy), routed through `cases`/`on_error` like any exit; without it the exec waits until granted or aborted (abort withdraws the wait)
- A `transition` / `start` / `resume` / `status` call that waits for an exec (pool lease queue included) sends an MCP progress notification every 60 s (`waiting for pool lease (Ns)` / `running <state> (Ns)`) when the client gave a `progressToken`, so Claude Code's no-response timeout does not cut the call.
- `timeout` counts the run, not the wait; the history entry and the ledger record `wait_ms` beside `duration_ms`; `{{wait_ms}}` is a template var
- Foreground exec only: `resource:` with `background: true` (or on a fetch) is a load error
- **Shards: `fanout:`** — `fanout: { count: N | items_command: "<prints one item per line>", threads_each: k, max_parallel?: M }` on an exec runs the command N times (`WF_SHARD=i/N`, 1-based — the `vitest`/`jest --shard` form) or once per non-empty line (`WF_ITEM=<line>`), each instance under its OWN lease of k threads (`WF_THREADS`), started as threads free up, at most M in flight (default: budget / k — what runs side by side). Leases take no `wait_timeout` / `locks` / step `priority`. `timeout` is PER SHARD (default 30s — set it). Exit 0 only if every shard exits 0; else the failing shards' common code (all timed out → 124 → `on_timeout`), or 1 when they differ. `{{stdout}}` = summary (`fanout: 3/4 ok, 1 failed (exit 1)`) + each failed shard's output tail. Abort kills running shards, withdraws waiting ones, starts no more. History/ledger: one `shards` entry per instance. Load error beside `background` or `resource`; a failing `items_command` fails the step without running a shard
- A shell step inside a larger command, or an agent's own Bash call, uses the CLI instead: `"$WF_PLUGIN_ROOT/scripts/wf-run" --threads 6|budget [--lock NAME]… [--priority P] [--wait-timeout SEC] [--est SEC] [--label TEXT] [--fail-open] -- <cmd> [args…]` — same pool and admission, the child runs in its own process group, SIGINT/SIGTERM/SIGHUP are forwarded, the exit code is the child's (75 = busy), the child gets `WF_THREADS`; `--lock` without `--threads` is lock-only; a SIGKILLed `wf-run` cannot release: the next pool pass kills its detached child's group (SIGTERM, SIGKILL after 3 s; never a group from another boot or with another leader) and frees the lease — an exec's group, by contrast, outlives its server for `adopt`; `--efficiency` (macOS) runs the command on efficiency cores via `taskpolicy -b`, outside the budget
- **Pool gate (agents' own Bash calls)**: the plugin's PreToolUse(Bash) hook rewrites a command the project's `.claude/workflows/pool-gate.yaml` (nearest from the call's cwd up to the git root — not from a `cd` inside the command) marks heavy into `<plugin>/scripts/wf-run --fail-open --threads <N|MIN-MAX> --label '<cmd>' -- <shell> -c '<cmd>'`; no config / no hit → untouched. Rules: `{ match: "<leading words>" | "/regex/", threads: N | "MIN-MAX", pass?: "--flag=$WF_THREADS" | "env:NAME", deny?: "<reason>", env?: { NAME: true | false | "/regex/" } }` (`env` tests the segment's own leading `NAME=value` assignments, which `match` never sees: `true` set, `false` unset, a regex on the value; first hit per segment wins; a flag goes before `--`, never doubled; `deny` refuses watch modes) + `wrappers: [scripts that call wf-run themselves]`. One `wf-run` for the whole command, the largest share of its hits; `--fail-open` = a pool that cannot be used (read-only / sandboxed dir) runs the command unleased. A segment that runs `wf-run` or a wrapper is never matched against the rules, `deny` included; the other segments of that command still are. Left alone: `WF_THREADS` already set (an exec under a lease), `wf-run` or a wrapper in the command, a background `&`, a heredoc; `WF_POOL_BYPASS=1 WF_POOL_BYPASS_REASON='…' <cmd>` skips it with a stderr note. Any hook failure → the command runs as is. With `rtk` on PATH the body goes through `rtk rewrite` (Claude Code keeps only the last `updatedInput`, i.e. the gate's); RTK's exit 0 → auto-allow. Never add an allow rule for `…/scripts/wf-run` (it would allow any wrapped chain). Not seen: `npx -y …`, `sudo …`, `nice …`, `$( )`; the inner shell has no Bash-tool snapshot (aliases, functions). Do not hand-write `wf-run` around a command the gate already covers — and never start a watch mode it refuses under another spelling

### Task queue: `batch`, `queue_next` / `queue_mark` / `queue_add` / `queue_edit` / `queue_header`, `wf-queue`

A queue is a YAML file the engine admits from: top-level keys are the header — `batch_size: N` (`0` = paused: running tasks finish, nothing new is admitted) with `reason:`, and any other key (`base: [path=sha]`, `land_test:`, `record_file:` — a file `batch-task`'s `mark_done` appends one record line to per landed task; relative = beside the queue; `overlap:`); `tasks:` is a list of `{id, status, difficulty, kind, priority, model, effort, repo, workflow, after: [ids], touches: [paths], owner, exclusive, breaking, parked, ended, text, notes: [{from, date, text}]}` (`ended` = the day queue_mark moved the line to done or failed; mark-written, queue_add / queue_edit refuse it). `status`: `pending | running | done | failed | backlog` (backlog = never picked). Keys: `model`, `effort` (`model: —` = parent-run, never admitted; so is a repo-bound line whose `touches:` entry git ignores in its repo, e.g. a live `.claude/` workflow — queue_add/queue_edit warn on it), `after:` (waits for done; an unknown id-like token or prose beside the ids = manual, not admitted), `touches:` (prefixes on a `/` boundary must not overlap a running or just-admitted task of the SAME repo; NO `touches:` = overlaps every task of its repo, runs alone there; header `overlap: files` = only FILE entries conflict, on the same file — no glob, and a regular file under the task's repo (`Makefile`), or, not there yet, a last segment holding a `.`; a directory or glob entry is then a hint; default `overlap: paths`; another value refuses the pick only), `owner:` (equal or `.`-prefix = one at a time, across repos too), `exclusive: true` (overlaps every task of every repo in either mode: mass moves, renames, reformats), `breaking: true` (a format/protocol change with no compat for running processes: admitted only into an empty window, nothing else admitted while it runs; that picker rule is the engine's — handing the land to the parent (`NEEDS-PARENT reason=breaking land ready`) is a route the project's task workflow must carry, and a line on plain `batch-task` lands as usual), `repo:` (absolute, or a name: the `base:` repo of that basename, else the dir beside the queue's project; default = the queue's project), `workflow:` (the task's own task workflow, found from its repo; default the dispatcher's `task_workflow`; not one word = not admitted), `difficulty:` (1..10, `-` = none; the task workflow's `model_table` maps it to model/effort — prefer it to `model`/`effort`; outside 1..10 = not admitted), `kind:` (`bug|feature|research`, absent or `-` = feature; any other value = not admitted; the pick only reports it, `queue_next` and the exec form's last column carry it, a task workflow reads it as `kind`; the dashboard's Plan tab and live map and the plan pane draw it as one glyph after the difficulty bar: `※` bug, `⚑` research, `◆` feature, GET `/api/queue` lines carry `kind` and `mark`), `priority:` (`urgent|high|normal|low`, default normal: the picker admits ready lines by priority, then file order; the pick's report shows it), `parked: true` (skipped until unparked), `text` (the brief, a block scalar). A bad status or a duplicate id refuses every read. A task key this server does not know (written by newer code) is kept on write and inert for the pick; `queue_next` / `queue_mark` name it (`unknown key priority on X: ignored by this server`); `queue_add` / `queue_edit` still refuse it in their input. Writes edit the parsed document in place (key order and comments kept).
- Admission: window = `batch_size` − running; pending tasks by `priority:`, then file order; each admitted task is set `running` under the queue's lock (`<file>.lock`, mkdir — two picks never admit one task).
- Which queue: every queue tool and `wf-queue` takes an optional `queue` NAME beside `file`; neither = the project's `.claude/batch/queue.yaml`, `queue: "<name>"` = `.claude/batch/<name>.yaml` (project = git root of the cwd, a worktree → its main checkout), a full `file` still works; both = error. The dispatcher resolves a name ONCE and `context.queue_file` stays the absolute path task sessions get (never re-resolve a name from a task's own repo). `queue_add` / `--add` on a missing queue addressed by name or by default CREATES it (`batch_size: 1`, `tasks: []`; a full `file` path that does not exist is an error, never created) and says so; the other ops error naming the resolved path.
- MCP: `queue_next({ queue?, file?, dry_run?, explain? })` → id / model / effort / repo / workflow, difficulty (when set), kind, priority (when set) / text per admitted task; `queue_mark({ queue?, file?, id, to: running|done|failed|released|promoted|shelved, note?, from?, retry?, force? })` — pending→running (refused when the picker would not admit the line — overlap, after, exclusive, breaking, parked — naming why; `force: "<reason>"` overrides and is noted), running→done/failed/pending, backlog→pending, pending→backlog only (`retry: true` + `running`: failed→running, its `difficulty:` +1, at most 10); `note` is appended to `notes:` as `{from, date, text}`. `queue_add({ queue?, file?, task: {id, …}, after_id?|before_id? })` (pending or backlog; refused: a known id, an unknown key, an `after:` id that names no task or closes a cycle, `workflow:` not one word, `repo:` unresolved, `difficulty:` outside 1..10, `kind:` not bug|feature|research), `queue_edit({ queue?, file?, id, set?: {field: value}, append_note?, from? })` (`""`/null removes a field; `after`/`touches` a list or a comma string; not the status), `queue_header({ queue?, file?, batch_size, reason })`. A write lands only if the file is unchanged since its read (else re-plan) — change a live queue through these, never a script. Keep the queue file untracked + ignored (a tracked one dirties the tree; the land refuses a dirty tree, exit 3)
- Exec form `"$WF_PLUGIN_ROOT/scripts/wf-queue" [<file>|--queue NAME] [--dry-run] [--explain|--explain-all]` (`--explain` folds the `window full` tasks into one, `--explain-all` lists each): stdout `ID\tmodel\teffort\trepo\tworkflow\tdifficulty\tkind` (`-` = no `workflow:` / `difficulty:`; `kind` is `feature` when the line has none) per admitted task, summary + reasons on stderr; exit **0** admitted · **10** none, running ones still run · **11** none, nothing runs (done) · **12** none, nothing runs, `batch_size: 0` · **2** error. `--done|--failed|--release|--running|--promote|--shelve <ID> [--note T] [--from W]` (`--running <ID> --retry`, `--running <ID> --force REASON`), `--header <key>`, `--path` (the resolved file), `--add '<YAML mapping>' [--after ID|--before ID]`, `--edit <ID> [--set k=v]… [--append-note T]`, `--batch-size <N> --reason T`. One-time conversion: `--convert <old.md> [--into <q.yaml>] [--status S]` (prints, writes, or APPENDS the old file's open lines with status S to an existing queue; `⏸` → parked, mark/dated fields → notes), `--convert <config.json> [--into <config.yaml>]` for the JSON configs.
- Bundled `batch` (dispatcher: `plan_queue` → `pick` exec → `dispatch` → `collect` → `slot_free` → `pick` …, `paused`, `cross_check`) starts one child session per admitted line: `context.task_workflow` (default `batch-task`: `claim` → `project_prepare` [worktree `<repo>/../.wt/<repo-name>/<ID>`, branch `batch/<ID>`] → `work` → `review_scope` [exec: the diff's class] → `review` [FIXES → `work`] → `project_land` [`git merge --no-ff` + the header's `land_test:`, a red test takes the merge back with `reset --keep` only while HEAD is that merge, else exit 4 untouched; lock `{{context.cwd}}-land`] → `mark_done` [exec: done + the `record_file:` line] → `cleanup`). With a `driver:` task workflow (bundled `batch-task`) `dispatch` starts each task with `start({…, context: {task, queue_file, difficulty}})`, spawns the DRIVER block of the answer unchanged and `link_agent`s it; `collect` routes on the drivers' one-line answers (`LANDED` / `CLOSED` / `NEEDS-PARENT`; a `LANDED` / `CLOSED` line ends with `lessons=<phrase (file)>; …|none` — the agents' own follow-ups, copied — and `collect` turns each into a `queue_add` line, a memory note or nothing; a reject or block → SendMessage the driver to take `reject` / `close`), ignores workers and reviewers under a driver (after a restart such a line is relayed to that P's driver), and re-spawns a lost driver from `status({session_id: P, key: "driver_call"})`. A re-spawned driver takes only a `current` agent of P's `LINKED AGENTS` as this visit's; none current → the prompt from its first step. A project heir: `extends: batch` overriding `plan_queue` with an exec that `context_set`s `queue_file` + `task_workflow` (master's `enqueue_plan` finds a heir by `extends: batch` in the project's workflow files, reads its `plan_queue` for the queue it names and `queue_add`s an approved multi-task plan there, header untouched — keep that queue readable from the exec; the bundled `plan_queue` resumes a queue whose `queue_file` is already in the context); its own task workflow (or `extends: batch-task` overriding the two extension points).
- **`driver:`** (workflow level, in the TASK workflow): `{ model, effort, prompt_ref }` — the cheap agent that runs the task session for the dispatcher. `prompt_ref`: a bare name = shipped `templates/drivers/<name>.md` (`task-driver`; unknown name fails the load), else a path (absolute, `~/…`, relative to the session's cwd). The initial state must be a prompt state (else the load fails). `start` of such a workflow ends its answer with a DRIVER block — the exact Agent call (model, effort, background, prompt filled with session id, `context.task`, `context.queue_file` or the parent's, the instructions path; a missing file → WARNING) + its `link_agent` — and keeps it in the context as `driver_call`. A driver messaged after its last line is NOT finished (P still holds the step): it calls `status` on P and continues. A driver never calls a tool on the dispatcher session: on a terminal prompt it replies with its last line. `start`'s `context` (string map) seeds the session's context (`cwd` / `claude_code_pid` refused; `difficulty` goes through the `model_table`). A transition into a state already visited answers `Revisit #N` without rendering its prompt: the values the agent remembers from that prompt are the FIRST visit's — a prompt that needs current values on a later visit names the context keys to read (`status` with `key`), never `{{visits.…}}` or `{{context.…}}` alone. Declaring `driver:` also opts the workflow's sessions into visit-scoped agent links: `agent_step`, the `LINKED AGENTS` block and the restart wake-skip of an earlier visit's agent (see `link_agent`).
- **Shipped agent types** (`agents/`, after a Claude restart): `workflow:driver` (haiku/low, workflow MCP tools + Agent/SendMessage/Read, no Edit/Write/Bash — the task-driver rules are its system prompt, so its spawn prompt is `P = <id>`), `workflow:recon` (sonnet/medium) and `workflow:reviewer` (opus/high), read-only by tool list (no Edit; a Write tool that the `read-only-gate` PreToolUse(Write) hook limits to the task's report directory — an absolute path under a `<task>.log` / `<task>-logs` directory in scratch space, outside a git work tree, no `..`) AND by the `read-only-gate` PreToolUse(Bash) hook: those types may run Bash only as an ALLOW list: the first word of every pipeline segment must be a declared reader (built-in: ls, cat, head, tail, wc, rg, grep, jq, find without actions, `sed -n '<n>p'`, git log/show/diff/status/grep/blame…), no `$( )`/backticks, brace expansion, `printf -v` or `$` in a command word, no `NAME=value` prefix unless its name is in the config's `envAllowed` (`GIT_*`, `LD_*`, `DYLD_*`, `PAGER`, `PATH`, `BASH_ENV`, `ENV`, `IFS` never), no redirect outside scratch (nor to a variable or glob), and the write list stays — a guard against ACCIDENTAL writes, not an adversary; the project's `.claude/read-only-commands.yaml` (`read`: extra readers, leading words or `/regex/` — its read-only CLIs; `write`: leading words or `/regex/`; `envAllowed`: variable names a `NAME=value` prefix may set; `env`: exported before the command only when a segment starts with a `read` CLI (the rewrite then carries `permissionDecision: "allow"`, so every other segment must be a project reader, a no-file default or a stdin filter behind a pipe, where a grep/rg flag value such as `-C 3` is not a file operand — else the call is denied, run it in its own call; other allowed calls pass unchanged), e.g. `APQ_READ_ONLY=1`; `agents`: override the type names) extends the built-in lists. A project may extend a type in its own `.claude/agents`.
- **Agents answer in one line, the text is in files**: bundled `batch-task`'s worker writes `report.md` (`handoff.md` when it stops unfinished), in `<worktree>.log` (kept after cleanup); the reviewer is the read-only `workflow:reviewer` (no workflow tools, no session; its Write is limited to scratch space), so its `review.md` is `/tmp/wf-batch-logs/<ID>/review.md`; answers `DONE <sha> report=…` / `BLOCKED …` / `VERDICT MERGE|FIXES|REJECT … review=… design=yes|no`; a fix round sends the line + "read <file> whole", never the text. The files carry named sections the driver copies as `lessons` (up to two): `report.md` / `handoff.md` `## Follow-up not done`, `## Tool defect found`, `## Open`; `review.md` `## Notes (non-blocking)`; a fix round or later review carries the previous file's items forward. Spawn prompts say once that a transition reply IS the next prompt — never `status` after it. The round cap stays: a third FIXES (the Nth by context `max_fixes`) is NEEDS-PARENT, decider or not. An earlier FIXES with `design=yes` goes to a fresh opus decider (context `memory_index`, optional) that writes `decisions.md` in `<worktree>.log` and answers `DECIDED file=…` or `ESCALATE reason=…`; only ESCALATE produces NEEDS-PARENT; the driver's `LANDED` line gains ` decided=<file>` and `batch` `collect` audits it.
- **`model_table:`** (workflow level, in the TASK workflow): `rows: [{ upto, model, effort }]` (ascending `upto`, last = 10; effort `low|medium|high|xhigh|max`) = the execute rows, or `stages: { <name>: rows[] }` (any name `^[a-z][a-z_]*$` except `model`/`effort`/`step`/`reached`, e.g. `recon` for a cheap recon spawn; plan/execute/review/review_verify/fix are the five the bundled workflows use; each stage its own rows; `stages.execute` replaces `rows`, giving both is refused; a malformed or reserved name, a stage short of 10, or a state reading `context.model_<x>` / `effort_<x>` for an undeclared stage fails the load) — `difficulty` then also writes `model_<stage>` / `effort_<stage>` for every declared stage and `model_reached`, while `model` / `effort` stay the execute row; `escalate` moves the execute and fix stages only, `escalate: { <state>: N }`, `review: { <class>: { model, effort } }`. `context_set` of `difficulty` (the claim sets the line's) → the engine writes `model`, `effort`, `model_step`, `escalations` (the answer names them; outside 1..10 refused). Every move into a state recomputes the row = the difficulty's + one per `escalate` entry whose state's visits reached N (capped); a moved row rewrites model/effort (a `model` history line). Escalation is per session: fix rounds, and a blocked re-entry within one session (a workflow whose `blocked` routes back declares `escalate: { blocked: 1 }`); no hidden state crosses sessions — in bundled `batch-task` `blocked` ends the session, and `queue_mark` `retry: true` (`wf-queue --running <ID> --retry`) rewrites the line's `difficulty: N` to `min(N+1, 10)` in the line itself (the answer says `(difficulty 4 → 5)`), so the re-run starts a row up; a line without `difficulty:` is retried unchanged. `review_class` set (an exec: `sh "$WF_PLUGIN_ROOT/scripts/review-class.sh" <base> <tip>` → `light` when every changed path is a test or a doc: root `docs/` / `specs/`, `tests/` / `__tests__/` anywhere, `*.md`/`.rst`/`.adoc`, `*.test.*` / `*Test.*`, CHANGELOG/LICENSE/README; a nested `docs/` package or a `.txt` build file is code; else `code`) → `review_model` / `review_effort` (the class's entry, which overrides the review stage; else the review stage's row; without stages the task's own). The nearest table down the stack applies. Bundled `batch-task` is stage-aware (plan 1–3 sonnet/high, 4–8 opus/high, 9–10 opus/xhigh; execute 1–6 sonnet/high, 7–8 opus/high, 9–10 opus/xhigh; review 1–8 opus/high, 9–10 opus/xhigh; review_verify sonnet/high; fix 1–6 sonnet/high, 7–10 opus/high), `escalate: { work: 3 }` (second fix round → a fresh worker on the new model), review `light` sonnet/medium and no `code` entry. Interactive workflows take it too: bundled `coding` and `bug-fix` declare the stage table without `escalate`; `difficulty` set at `start` or by the plan state (`think` / `diagnose`) makes their implementer and reviewer spawns use `model_execute` / `model_review` (+ `effort_*`), no difficulty = the prose rule. **Difficulty rubric** (by the WORK, for a queue line and a plan step alike): 2 one function; 3 one owner; 4 a few files at one owner; 5 a new rule or command on existing parts; 6 a new shared component or config key; 7 cross-file typing or an unknown cause; 8 a contract moving across packages; 9-10 a whole-tree redesign that must be split; +1 when the premise is a stale measurement or a hypothesis. Ledger lines carry `difficulty`, `model`, `effort`, `escalations`, `review_model`, `review_effort`, `claim_difficulty` (the first difficulty, what `wf-calibration` bands by), `stages` (model/effort each stage ran on: its row when a state reading it was entered (in a prompt state also the bare `model` / `effort` = execute, `review_model` / `review_effort` = review; an exec's env does not count), first value wins; only those stages, so one absent from the line did not run), `tokens` (`tokens` → total, `tokens_<role>` → role; the driver sets `tokens_worker` / `tokens_review`) — tune the table from them

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
