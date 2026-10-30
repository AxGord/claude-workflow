---
name: workflow-authoring
description: Reference for authoring workflow YAML — state types, skill gates, exec/fetch action states, terminals, routing, and engine gotchas
---

## Workflow Authoring Reference

### Deployment & reload

- Bundled templates load from `templates/` next to the server's `build/` (i.e. `${CLAUDE_PLUGIN_ROOT}/templates`) — once, at server boot. Editing them does NOT hot-reload a running server.
- Load order (later overrides earlier by workflow name): bundled `templates/` → `~/.claude/workflows/` → project `.claude/workflows/`. The project is the server's cwd — except a session started with `cwd:` in ANOTHER project that has its own `.claude/workflows/` (a worktree counts as its main checkout): that session sees the workflows that project defines itself laid by name over the server's (a server-only name is still found; the home dir is no project) — a queue line's `workflow:` runs in its `repo:`.
- `~/.claude/workflows/` and the project dir ARE fs.watch'ed; ANY `.yaml` change there triggers a FULL reload that also re-reads bundled templates. Hot-reload trick after editing bundled templates (no server restart): `echo "# t" > ~/.claude/workflows/_trigger.yaml && sleep 1 && rm ~/.claude/workflows/_trigger.yaml`, then verify via `list` (state counts change).
- Active sessions keep their definition snapshot; only NEW `start()` sessions see reloaded workflows.
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

- Merge: base states + heir states by name; `initial` / `max_transitions` / `description` from the heir when set. Validation (initial, transitions, routes) runs on the MERGED result, so a heir may route to base-only states
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
every session end appends one line to `$STATE_DIR/ledger.jsonl` with them.

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

- Claude Code exiting SUSPENDS its sessions (and their sub-agents' sessions) — never abandons them; nothing ends, no ledger line. `claude --resume` / `--continue` (same conversation id) PICKS THEM UP in the SessionStart hook: the sessions and their sub-trees belong to the new process, nothing to call — the hook names each (`picked up: <session> @ <workflow @ state>`) and the sub-agent sessions with the `SendMessage` that wakes each agent (the agent calls `status` on its OWN session — no `resume`, never a new `start`); a session with no `agent_id` up to the root is taken for the main agent's own (`no agent linked — yours, unless a sub-agent you spawned runs it`) — so `link_agent` every spawned agent. The action step a session stopped in — an exec in flight, finished, killed by the restart, or never started (e.g. waiting for a pool lease) — is finished by the first `status` / `transition` of its session: waited for, its result taken, or run again (that `transition` is not taken — the session moved on). `startup`, another account, `--fork-session`: explicit — `suspended()` lists them by project, `resume({ session_id })` continues one (and lists its sub-agents to wake, each calling `resume` on its own session). Unresumed for `WF_SUSPENDED_TTL_DAYS` (7) → abandoned
- After `/compact` (or `/clear`) the hook output, which lands in the new context, lists the process's active sessions as a tree (id, workflow @ state, nested stack, agent) — the orchestrator knows where it is; `status()` gives the full prompt
- A spawner that wants its sub-agents woken by name after a restart calls `link_agent({ session_id: <child>, agent_id })` once the child session id is known
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

- Admission: `held + N <= budget` and, beside a live lease, `held + N + external <= budget` — external load never blocks an EMPTY pool. `budget` defaults to performance cores − 2; `external = max(0, load − own − load_threshold)` is load not taken through the pool (`own`: per lease with threads, the larger of its threads and the busy cpus of its own process tree — a command that spawns more than it leased does not block the queue as "external"; it is flagged `runs ~N (OVERRUN)` instead — and NOT bounded: admission only keeps `held ≤ budget`, so pass `WF_THREADS` on or the machine is oversubscribed), `load` = busy cpus measured from cpu ticks over the window since the pool's previous pass (loadavg1 only before a window exists — it lags a minute), `load_threshold` (default 2) is the noise floor. These settings and `starve_after` (seconds, default 900: a waiter queued that long, or a pool that granted nothing that long, is STARVED — marked in `pool_status`, logged in `<pool dir>/pool.log`, and a starved exec's session shows `POOL STARVED` in its and its ancestors' `status` / `transition`) live in `<pool dir>/config.json`
- Strict queue order: priority descending, then arrival — a smaller task never overtakes the head, so big tasks do not starve. `threads` above the budget counts as the budget: it waits for an empty machine and runs alone
- **Priority = session level + step `priority`**: levels `low` −100, `normal` 0, `high` 100, `urgent` 200 — `start({ priority })`, inherited by child sessions, default `normal`; keep a step's own `priority` under ±100 so it only fine-tunes within the level. `set_priority({ session_id, level })` changes a session and its descendants on the fly and re-ranks their WAITING entries at once (running leases keep theirs — no preemption). Every exec gets `WF_PRIORITY` (the sum) and `WF_PRIORITY_LEVEL`; `wf-run` without `--priority` takes them, so a nested `wf-run` queues at its session's level. Old level kept in two windows: an exec between building its context and joining the queue (waits at the old level until granted), and a `wf-run` inside an exec started before the change (its `WF_PRIORITY` is from the spawn). Call `set_priority` only on the user's request — never raise your own session or change another project's
- **Flexible threads**: `threads: { min: A, max: B|budget }` (+ `wait_full: SEC`, default 0) / `wf-run --threads A-B [--wait-full SEC]` — gets B when B fits; otherwise, once `wait_full` has passed, everything free if it is ≥ A. While it waits (for B inside the window, for A after it) it closes the threads to those behind it like any waiter. `WF_THREADS` = what was granted — read it, never assume B. For work that scales with cores (test suites, parallel builds) where an earlier start beats a wider one
- `wf-run --status` / the `pool_status` tool: one line per lease and waiter — pid, held/wanted threads and locks (`, runs ~N (OVERRUN)`), priority + level, since when (`STARVED`), project (git root), session, step, label; a `STARVED:` line when the pool granted nothing for `starve_after`
- `threads: budget` (the only non-number value, strict) asks for the whole budget as `config.json` sets it when the request is made (a later raise does not grow a waiting or held lease) — no hardcoded core count; `wf-run --threads budget` is the same
- **The lease counts threads, it does not enforce them**: compilers, test runners and optimizers take every core by default. The command gets `WF_THREADS` = the threads granted (after `budget`/the clamp) — pass it on: `make -j"$WF_THREADS"`, `vitest --maxWorkers="$WF_THREADS"`, `HXCPP_COMPILE_THREADS="$WF_THREADS"`, `APQ_ORACLE_PARALLEL="$WF_THREADS"`. Env only (no template var); absent for a light exec, a lock-only lease and `--efficiency`
- `locks: [NAME, …]` (one word each: `port:3000`; a name may template a session value, `"{{context.cwd}}-land"` — rendered whitespace becomes `_`) — machine-wide mutual exclusion by name, for dev servers / bridges / devices on fixed ports. `threads` is optional beside `locks` (at least one of the two; lock-only takes no threads and is never blocked by load). Threads and locks are granted ATOMICALLY (all or nothing, nothing held while waiting → no deadlock); a lock goes to its waiters in queue order, and a waiter blocked by a held lock claims no threads, so a long-held lock does not stall the queue
- `wait_timeout` (seconds) expired → exit **75** (busy), routed through `cases`/`on_error` like any exit; without it the exec waits until granted or aborted (abort withdraws the wait)
- A `transition` / `start` / `resume` / `status` call that waits for an exec (pool lease queue included) sends an MCP progress notification every 60 s (`waiting for pool lease (Ns)` / `running <state> (Ns)`) when the client gave a `progressToken`, so Claude Code's no-response timeout does not cut the call.
- `timeout` counts the run, not the wait; the history entry and the ledger record `wait_ms` beside `duration_ms`; `{{wait_ms}}` is a template var
- Foreground exec only: `resource:` with `background: true` (or on a fetch) is a load error
- **Shards: `fanout:`** — `fanout: { count: N | items_command: "<prints one item per line>", threads_each: k, max_parallel?: M }` on an exec runs the command N times (`WF_SHARD=i/N`, 1-based — the `vitest`/`jest --shard` form) or once per non-empty line (`WF_ITEM=<line>`), each instance under its OWN lease of k threads (`WF_THREADS`), started as threads free up, at most M in flight (default: budget / k — what runs side by side). Leases take no `wait_timeout` / `locks` / step `priority`. `timeout` is PER SHARD (default 30s — set it). Exit 0 only if every shard exits 0; else the failing shards' common code (all timed out → 124 → `on_timeout`), or 1 when they differ. `{{stdout}}` = summary (`fanout: 3/4 ok, 1 failed (exit 1)`) + each failed shard's output tail. Abort kills running shards, withdraws waiting ones, starts no more. History/ledger: one `shards` entry per instance. Load error beside `background` or `resource`; a failing `items_command` fails the step without running a shard
- A shell step inside a larger command, or an agent's own Bash call, uses the CLI instead: `"$WF_PLUGIN_ROOT/scripts/wf-run" --threads 6|budget [--lock NAME]… [--priority P] [--wait-timeout SEC] [--label TEXT] [--fail-open] -- <cmd> [args…]` — same pool and admission, the child runs in its own process group, SIGINT/SIGTERM/SIGHUP are forwarded, the exit code is the child's (75 = busy), the child gets `WF_THREADS`; `--lock` without `--threads` is lock-only; a SIGKILLed `wf-run` cannot release: the next pool pass kills its detached child's group (SIGTERM, SIGKILL after 3 s; never a group from another boot or with another leader) and frees the lease — an exec's group, by contrast, outlives its server for `adopt`; `--efficiency` (macOS) runs the command on efficiency cores via `taskpolicy -b`, outside the budget
- **Pool gate (agents' own Bash calls)**: the plugin's PreToolUse(Bash) hook rewrites a command the project's `.claude/workflows/pool-gate.json` (nearest from the call's cwd up to the git root — not from a `cd` inside the command) marks heavy into `<plugin>/scripts/wf-run --fail-open --threads <N|MIN-MAX> --label '<cmd>' -- <shell> -c '<cmd>'`; no config / no hit → untouched. Rules: `{ match: "<leading words>" | "/regex/", threads: N | "MIN-MAX", pass?: "--flag=$WF_THREADS" | "env:NAME", deny?: "<reason>", env?: { NAME: true | false | "/regex/" } }` (`env` tests the segment's own leading `NAME=value` assignments, which `match` never sees: `true` set, `false` unset, a regex on the value; first hit per segment wins; a flag goes before `--`, never doubled; `deny` refuses watch modes) + `wrappers: [scripts that call wf-run themselves]`. One `wf-run` for the whole command, the largest share of its hits; `--fail-open` = a pool that cannot be used (read-only / sandboxed dir) runs the command unleased. A segment that runs `wf-run` or a wrapper is never matched against the rules, `deny` included; the other segments of that command still are. Left alone: `WF_THREADS` already set (an exec under a lease), `wf-run` or a wrapper in the command, a background `&`, a heredoc; `WF_POOL_BYPASS=1 WF_POOL_BYPASS_REASON='…' <cmd>` skips it with a stderr note. Any hook failure → the command runs as is. With `rtk` on PATH the body goes through `rtk rewrite` (Claude Code keeps only the last `updatedInput`, i.e. the gate's); RTK's exit 0 → auto-allow. Never add an allow rule for `…/scripts/wf-run` (it would allow any wrapped chain). Not seen: `npx -y …`, `sudo …`, `nice …`, `$( )`; the inner shell has no Bash-tool snapshot (aliases, functions). Do not hand-write `wf-run` around a command the gate already covers — and never start a watch mode it refuses under another spelling

### Task queue: `batch`, `queue_next` / `queue_mark` / `queue_add` / `queue_edit` / `queue_header`, `wf-queue`

A queue is a Markdown file the engine admits from: the header (up to `## Tasks`) holds `batch_size: N` (`batch_size: 0  # why, was N` = paused: running tasks finish, nothing new is admitted) and other `key: value` lines (`base:`, `land_test:`); a task is `- [ ] ID | key: value | … | free text |`. Keys: `model`, `effort` (`model: —` = parent-run, never admitted), `after: ID, ID` (waits for `[x]`; an unknown id-like token or prose beside the ids = manual, not admitted), `touches: path, path` (prefixes on a `/` boundary must not overlap a running or just-admitted line of the SAME repo; NO `touches:` = overlaps every line of its repo, runs alone there; header `overlap: files` = only FILE entries conflict, on the same file — no glob, and a regular file under the line's repo (`Makefile`), or, not there yet, a last segment holding a `.`; a directory or glob entry is then a hint; default `overlap: paths`; another value refuses the pick only), `owner: name` (equal or `.`-prefix = one at a time, across repos too), `exclusive: <any>` (overlaps every line of every repo in either mode: mass moves, renames, reformats; `—` = not exclusive), `repo:` (absolute, or a name: the `base:` repo of that basename, else the dir beside the queue's project; default = the queue's project), `workflow:` (the line's own task workflow, found from its repo; default the dispatcher's `task_workflow`; not one word = not admitted). `⏸` in a metadata field or `after:` skips the line (inside prose ≥160 chars it is a mention).
- Admission: window = `batch_size` − `[>]`; `[ ]` lines in file order; each admitted line is marked `[>]` under the queue's lock (`<file>.lock`, mkdir — two picks never admit one line). Only `[.]` marks change.
- MCP: `queue_next({ file, dry_run?, explain? })` → id / model / effort / repo / workflow (when set) / text per admitted line; `queue_mark({ file, id, to: running|done|failed|released, note?, retry? })` — from `[ ]`/`[>]`/`[>]`/`[>]` only (`retry: true` + `running`: `[!]`→`[>]`); `note` lands after the id (no `|`, `⏸`, leading `key:`). `queue_add({ file, line, after_id?|before_id? })` (new `[ ]` line; refused: a known id, a `key:` field unknown or twice, an `after:` id that names no line or closes a cycle, `workflow:` not one word, `repo:` unresolved), `queue_edit({ file, id, set?: {field: value}, append_note? })` (`""` removes a field; not the mark), `queue_header({ file, batch_size, reason })` (`batch_size: N  # reason`). A write lands only if the file is unchanged since its read (else re-plan) — change a live queue through these, never a script. Keep the queue file untracked + ignored (a tracked one dirties the tree; the land refuses a dirty tree, exit 3)
- Exec form `"$WF_PLUGIN_ROOT/scripts/wf-queue" <file> [--dry-run] [--explain|--explain-all]` (`--explain` folds the `window full` lines into one, `--explain-all` lists each): stdout `ID\tmodel\teffort\trepo\tworkflow` (`-` = no `workflow:`) per admitted line, summary + reasons on stderr; exit **0** admitted · **10** none, `[>]` still run · **11** none, nothing runs (done) · **12** none, nothing runs, `batch_size: 0` · **2** error. `--done|--failed|--release|--running <ID> [--note T]` (`--running <ID> --retry`), `--header <key>`, `--add <LINE> [--after ID|--before ID]`, `--edit <ID> [--set k=v]… [--append-note T]`, `--batch-size <N> --reason T`.
- Bundled `batch` (dispatcher: `plan_queue` → `pick` exec → `dispatch` → `collect` → `slot_free` → `pick` …, `paused`, `cross_check`) starts one child session per admitted line: `context.task_workflow` (default `batch-task`: `claim` → `project_prepare` [worktree `<repo>/../.wt/<repo-name>/<ID>`, branch `batch/<ID>`] → `work` → `project_land` [`git merge --no-ff` + the header's `land_test:`, a red test takes the merge back with `reset --keep` only while HEAD is that merge, else exit 4 untouched; lock `{{context.cwd}}-land`] → `mark_done` → `cleanup`). A project heir: `extends: batch` overriding `plan_queue` with an exec that `context_set`s `queue_file` + `task_workflow`; its own task workflow (or `extends: batch-task` overriding the two extension points).

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
- **Guards throw unless routed**: a move past a state's `max_visits` throws (the transition is refused) — unless that state has `on_exhausted: <state>`, which enters that state instead (agent transitions, action-state routes and skill-gate auto-transitions alike; chained routes are followed, a route cycle throws; the history entry's `detail` names the exhausted states; a rerouted action move shows the routed-to state's own prompt, not the action's `success_prompt`/`error_prompt`; `on_exhausted` without `max_visits` or to an unknown state is a load error). `{{visits.<state>}}` in the exhausted-route state's prompt shows how many tries ran. A pop's `on_complete`/`on_fail` move does not check `max_visits`. Hitting `max_transitions` always throws
- `max_transitions` accounting is **per stack frame** — each sub-workflow push starts a fresh counter checked against that workflow's own `max_transitions` (default 50)
- **Duplicate YAML keys** — parser rejects the entire file with a `YAMLParseError`; the loader logs it to stderr and skips the file (workflow not loaded). Always validate YAML before deploying (no duplicate `success_prompt`, `error_prompt`, etc. on the same state)
- **Long-running commands** (dev servers, log tailers, watchers — anything that doesn't exit) — always use `background: true`. A foreground exec resolves when its `sh -c` exits (output goes to files, not pipes): a command that never exits blocks until its `timeout`; a grandchild it leaves running keeps running in the exec's process group, untracked — and is killed by the next abort of the session. On `timeout` the group gets SIGTERM, then SIGKILL after 5 s, and the step resolves only once the group is gone
- **Foreground build + background deploy** pattern: use foreground `build` (catches errors) then background `test/run` (streams logs), then poll readiness via `fetch` with retry
