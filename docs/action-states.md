---
title: Action states
description: exec, fetch, the thread pool, fan-out and template variables
---

# Action states

## Action States

### Restart: suspend and resume

When Claude Code exits (SessionEnd), its active sessions and their active descendants are **suspended**: stack, context and children stay, no ledger line is written. The SessionStart hook records which conversation each process runs (`$STATE_DIR/claude-session-<pid>`); the server stamps it on every session it starts, and SessionEnd stamps the ending one.

- **`claude --resume` / `--continue`** keep the conversation id, so the SessionStart hook (`source: "resume"`) PICKS UP that conversation's sessions by itself.
  - It takes the suspended ones and those a crash left to a dead process, with their sub-trees. A descendant another live process runs, or a session whose parent is active elsewhere, stays where it is.
  - Through `build/session-cli.js` it hands each to the new process under the session files' locks (`Storage.update`) and clears every suspension.
  - Its output names each picked-up session (`picked up: <session> @ <workflow @ state>`) and, below it, the sub-agent sessions with the `SendMessage` that wakes each agent. Only the main agent can send it; the agent continues its session with `status`, no `resume`.
  - A session below it with no `agent_id` on itself or on any session up to the root (e.g. a pipeline the main agent runs itself) is taken for the main agent's: one line `<session> → <state> — no agent linked — yours, unless a sub-agent you spawned runs it (then link_agent + SendMessage) → status({ session_id })`.
  - The action step a session stopped in is named apart: `exec in flight`, `exec finished while no server ran`, `exec killed by the restart` (no process, no exit code), `step interrupted before its exec started`.
  - That step is finished by the first `status` / `transition` of the session (a `transition` then is not taken — it answers as an error with the state the session moved on to):
    - a running exec is waited for,
    - a finished one gives its recorded result,
    - one killed or never started runs again.
  - The engine writes `pending_action` before an exec waits for its pool lease or spawns, so a server gone in between (e.g. waiting for a `resource:` lease) leaves the step to run again, lease wait included.
  - A previous server still alive (Claude crashed, the server did not exit) that gets its lease after the session left it — suspended or owned by another process — gives the lease back without starting the exec (`ExecContext.mayStart`).
  - Not covered:
    - a `fanout:` whose shards already run in such a surviving server (the rerun runs beside them),
    - a restart of the MCP server inside the same Claude process with the old one still alive (the same pid — `mayStart` cannot tell them apart).
  - `status` of a session sitting in an action state names it (`[exec state "<s>": running in this server | running in PID … | begun by a server that is gone … | not running …]`) instead of `[sub_workflow: unknown]`.
  - Without a build or node the hook lists the suspended roots for an explicit `resume` instead. A fresh `startup` picks up and lists nothing.
- **`/compact`** (and `/clear`): the hook's output becomes part of the new context, so it prints this process's active sessions as a tree (id, workflow @ state, the stack when nested, agent, the action step it stopped in) — a compacted orchestrator knows where it is.
- **`resume({ session_id })`** — the explicit path (startup, another account, `--fork-session`) — hands the session and its sub-tree to the current process and returns the session's state.
  - Its suspended sub-agent sessions are listed as agent → session → state, each with the `SendMessage` that wakes its agent; the agent continues ITS OWN session with `resume`, not a new `start`.
  - A suspended child no agent drives (no `agent_id` up to the resumed session) is taken for the caller's: `no agent linked — yours, unless a sub-agent you spawned runs it (then link_agent + SendMessage) → resume({ session_id })`.
  - `link_agent({ session_id, agent_id })` records which agent drives a child session (call it after the spawn, once the child's session id is known), and the parent's state and visit it was linked at (see `driver:`).
- **Another account** (the conversation cannot be resumed), or `--fork-session` (a new conversation id — the SessionStart hint lists nothing): `suspended()` lists the suspended sessions of this project (git root of the server's cwd; `all: true` for every project) — `resume` any of them.
- **An exec in flight**: every foreground exec runs detached in its own process group, its output in files and its exit code written to a file when it ends (`$STATE_DIR/exec/`), so it outlives the server. The session records it (`running_exec`) while it runs.
  - `resume` of a session stopped in that exec state finishes it:
    - still running → waits (`abort` kills it);
    - finished → takes the recorded exit code and output;
    - neither (the machine rebooted) → runs the step again.
  - The `timeout` of a running exec counts from its start, stretched by the pool wait of its command.
  - The run's `.wait` file keeps that wait across a restart: the file holds the count as of its last write, about once a second. The taking-over server counts the wait since that write's time, or since the run's start when there is no file, so the gap of the restart is in the deadline too.
  - Its pool lease lives while its process group does.
  - A `fanout:` state runs again.
  - The run dir is owner-only (0700); server start removes run files older than a day that no session references.
  - The output files are not capped while the command runs (`yes` writes until its `timeout`) — only the tail of `max_output` BYTES is read back.
- A crash that skipped SessionEnd: the next server start suspends the sessions of dead processes. A session suspended longer than `WF_SUSPENDED_TTL_DAYS` (default 7) is abandoned at server start, with its ledger line.
- `transition` / `context_set` / `modify` refuse a suspended session and name `resume`.

States can run shell commands or HTTP requests automatically — the agent doesn't participate, the engine handles execution and routes to the next state based on the result.

### `exec` — run a shell command

```yaml
run_tests:
  type: exec
  command: "npm test"
  cwd: "{{context.cwd}}"
  timeout: 30000
  on_success: analyze
  on_error: fix
  success_prompt: "Tests passed:\n{{stdout}}"
  error_prompt: "Tests failed (exit {{exit_code}}):\n{{stderr}}"
```

An `exec` or `fetch` state comes only from a workflow FILE: `modify` and `create` refuse one, and a project file (`.claude/workflows/`) that declares one loads only in a trusted project: a folder you trusted in Claude Code (the engine reads that answer), or a project you approved once with `wf-trust` (an untrusted project's file is left out; `list` and a failed `start` say how to trust it).

With `WF_TRUST_STRICT=1` each file's exact content must be approved instead, so an edited file asks again; a restarted server that finds an approved file edited since does not run the edited state either: the session meets the tier below, or a missing workflow, and `transition` errors. See [Trusting project workflows](/getting-started#trusting-project-workflows).

An exec without `cwd:` runs in the session's cwd (`start`'s `cwd`, else the server's); a relative `cwd:` resolves against it.

Its env carries:

- `WF_PLUGIN_ROOT`, `WF_SESSION_ID`, `WF_PARENT_SESSION_ID` (empty at the root), `WF_ROOT_SESSION_ID`,
- `WF_PRIORITY` / `WF_PRIORITY_LEVEL` (the session's priority, below),
- `AGENT_CONTEXT`: the context size in tokens — input + cache read + cache write — of the last assistant turn of the agent `link_agent` recorded for the session, read from its transcript when the exec spawns. It is empty when no agent is linked or its transcript cannot be read, so a `{{...}}`-free `[ "${AGENT_CONTEXT:-0}" -gt 250000 ]` routes a hand-off to a fresh agent,
- plus `WF_THREADS` under a `resource:` lease with threads (below).

How it runs:

- Every exec runs in its own process group: a timeout, `abort`, or a parent's abort cascade kills `sh -c` together with everything it started.
- A foreground exec writes its output to files, not pipes to the server, and resolves when its shell exits — a background child it left behind keeps running, but no longer holds the step open.
- A command killed by a signal exits 128+signal.
- On `timeout` the group gets SIGTERM, then SIGKILL after 5 s if anything in it is still alive, and the step resolves only once the group is gone (a lease is released with it).
- `max_output` counts bytes of the output's tail. The history entry records `exit_code` and `duration_ms`.

### Heavy work — the machine-wide thread pool

This is the reference. [Thread pool](/pool) explains the idea in plain language with a diagram and a live recorded window.

A `transition` / `start` / `resume` / `status` call that waits for an exec (pool lease queue included) sends an MCP progress notification every 60 s (`waiting for pool lease (Ns)` / `running <state> (Ns)`) when the client gave a `progressToken`, so Claude Code's no-response timeout does not cut the call.

Light commands run as plain execs and never wait. Heavy ones (test suites, release builds, corpus runs) take a lease from one pool shared by every session, project and Claude config dir on the machine — `$WF_POOL_DIR`, default `~/.claude/workflow-pool` (deliberately not under `CLAUDE_CONFIG_DIR`):

```yaml
run_suite:
  type: exec
  command: "npm test"
  resource: { threads: 6, priority: 0, wait_timeout: 900 }
  cases: { "0": analyze, "75": machine_busy }
  default: fix

test_wide:
  type: exec
  command: 'vitest run --maxWorkers="$WF_THREADS"'
  resource: { threads: { min: 2, max: budget }, wait_full: 60 }   # flexible: 2..budget threads
  on_success: done
  on_error: fix

dev_server_smoke:
  type: exec
  command: "npm run e2e"            # binds the fixed port 3000
  resource: { threads: 2, locks: ["port:3000"] }
  on_success: done
  on_error: fix
```

The same admission is a CLI for shell steps and agents' own commands (`bin` of the package; `scripts/wf-run` for execs: `"$WF_PLUGIN_ROOT/scripts/wf-run"`):

```bash
wf-run [--threads N|budget|MIN-MAX [--wait-full SEC]] [--lock NAME]… [--priority P] [--wait-timeout SEC] [--est SEC] [--est-by-threads K:SEC,…] [--label TEXT] [--efficiency] [--fail-open] -- <cmd> [args…]
wf-run --status    # one line per lease and waiter
```

**The lease only counts threads — the command must actually use that many.** Compilers, test runners and optimizers take every core by default, whatever the lease says.

The leased command gets `WF_THREADS` = the threads granted (after `budget` and the clamp to the budget); pass it on: `make -j"$WF_THREADS"`, `vitest --maxWorkers="$WF_THREADS"`, `HXCPP_COMPILE_THREADS="$WF_THREADS" haxe build.hxml`, `oxipng -t "$WF_THREADS"`, `APQ_ORACLE_PARALLEL="$WF_THREADS"`.

It is set only for a lease with threads — never for a light exec, a lock-only lease or `--efficiency` (an inherited value is dropped).

It is env only, not a template variable: write `$WF_THREADS` in the command.

A step that empties its environment (`env -i`) drops `WF_THREADS` too: carry it over by name.

A serial pipeline with a narrow half and a wide half cannot match held to used with one lease: take a lease per half, one after the other from the command (two `wf-run`, never nested: a lease around a second `wf-run` waits on itself).

Size a range's `max` from a measurement of held against used (`LC_ALL=C ps`), not `budget`: a run that is not wide enough to use the grant holds threads it does not use.

- **Admission** (under a proper-lockfile lock on `<pool dir>/pool.json`):
  - `held + N <= budget`, and beside a live lease also `held + N + external <= budget` — external load never blocks an EMPTY pool (a head with N ≥ budget would otherwise wait forever on background load).
  - `external = max(0, load − own − load_threshold)` is the load not taken through the pool, where `own` sums over the leases with threads the larger of a lease's threads and what its own process tree runs (below).
  - `load` is measured from cpu ticks (`os.cpus()`): busy cpus over the window since the pool's previous pass (≥ 0.5 s; a window over 5 s is stale and restarts). Without a window (first pass, stale) it falls back to `loadavg1`, which is conservative — it lags a minute and still holds load that has ended.
  - `<pool dir>/config.yaml` (optional) takes:
    - `budget`: default performance cores − 2 — `hw.perflevel0.physicalcpu` on macOS, else `os.cpus().length` − 2, at least 1;
    - `load_threshold`: default 2, the noise floor of light work;
    - `starve_after`: seconds, default 900 — below.
- **A lease's own load**: a lease records its command's process group (`wf-run`'s child, an exec's `sh -c`).
  - Each pass reads the process table (`ps`, at most once a second per process, outside the pool lock; a failed read is not retried for 30 s and leaves the trees unmeasured) and sums the busy cpus of the group's members and their descendants. Another lease's group is excluded, so a `wf-run` nested in a leased exec counts once, as its own lease.
  - That tree is the lease's own load, never `external`. A lease of 4 threads whose command spawns twelve busy compilers no longer reads as 8 cores of foreign load that admits nobody (the incident behind this: `budget 10, held 4, load 13.77 (external 7.8)`, seven waiters for two hours).
  - A tree below its threads still counts as its threads; a lock-only lease takes no threads, so what it runs stays external.
  - A tree that runs at least `max(2, threads/2)` cpus over its threads is OVERRUN:
    - `--status` / `pool_status` show `holds 4 threads, runs ~12 (OVERRUN)` (a measured lease inside both bounds shows `holds 4 threads, runs ~3`),
    - a waiting `wf-run`'s progress line names it beside its holder (`label (4, runs ~12)`),
    - and `<pool dir>/pool.log` gets one line per lease.
  - **An over-running lease is no longer bounded by admission**: the pool only keeps the threads it hands out within the budget (`held ≤ budget`), so while a lease runs 12 cpus on 4 threads the waiters are still admitted and the machine is oversubscribed.
  - The lease is flagged and logged, not throttled — the fix belongs to the command that ignores `WF_THREADS`: pass it on.
  - CPU per process is the kernel's recent average on macOS, the lifetime average on Linux.
- **Underuse**: the reverse of OVERRUN, reported and never acted on.
  - A measured lease whose tree runs at least `max(1, threads/2)` cpus BELOW its threads for `UNDERUSE_GRACE_MS` (30 s) is logged once as `underuse: pid … holds 4 threads, runs ~0 — <label>` and shown as `holds 4 threads, runs ~0 (UNDERUSE)` by `--status` / `pool_status` / the dashboard's Pool tab (`PoolRow.underuse`).
  - A lease that runs its threads again starts the grace over (`underuse_since` in `pool.json`).
  - The size of a lease is its caller's declaration — a command that holds one parallel lease across a serial phase is the caller's defect; the pool makes it visible. Admission, priority and order are unchanged.
- **Usage**: each lease carries a meter in `pool.json` (what it held and what its tree ran, as thread-ms over the time it was sampled).
  - The meter is advanced at most every 10 s by any pass, and every 5 s by the lease's holder while its command runs, so a lease nobody polls is still sampled; a gap over 30 s is credited to nobody.
  - A lease that ends through `release` appends one line to `<pool dir>/usage.jsonl` (rotated to `.1` past 1 MiB): its label key, threads, wall ms and the meter.
  - `wf-run --usage [--since 90m|24h|2d]` (default 24h) prints, per label key (slice ids and hashes as `*`), over the leases that ended in the window, most idle first:
    - `n`,
    - mean `held` and `used` threads weighted by the sampled time,
    - `idle thr-min` (threads held above what the tree ran),
    - `over thr-min` (what it ran above its threads),
    - `sampled` (the share of the leases' wall time that was sampled).
  - A lease reaped as an orphan or dropped dead leaves no record.
- **Starvation**: a waiter queued `starve_after` or longer is STARVED, and so is a pool with waiters that granted nothing that long.
  - `--status` / `pool_status` mark the waiter (`since … (Ns, STARVED)`) and print `STARVED: nothing granted for 2h10m, 7 waiting (held 4/10, external 7.8; over-running: pid … holds 4, runs ~12)` under the header.
  - `pool.log` gets one line per waiter; a waiting `wf-run` adds `— STARVED: queued 17m` to its progress line.
  - An exec waiting on a lease checks every 10 s: once starved, its session records it (`pool_starved`) until the lease is granted or the step ends.
    - The MCP progress heartbeat says `waiting for pool lease (Ns) — STARVED: <why>`.
    - `sessions` marks the session `[POOL STARVED since …]`.
    - `status` / `transition` of the session or any ancestor start or end with `POOL STARVED: session <id> (<workflow @ state>) waits for a pool lease since … — <why>`, so the parent sees it at its next call while the starved child's own call is blocked.
- **Named locks**: `resource: { locks: [NAME, …] }` / `--lock NAME` (repeatable) — machine-wide mutual exclusion by name, for dev servers, bridges and anything else on a fixed port or a single device.
  - A name is one word, no whitespace: `port:3000`, `ios-simulator`. It may template a session value — `"{{context.cwd}}-land"` — and whitespace it renders becomes `_`.
  - `threads` is optional beside `locks` (a lock-only lease takes no threads and is never blocked by load; `wf-run --lock` without `--threads` is lock-only), at least one of the two is required.
  - Locks and threads are granted ATOMICALLY in one pass: a task gets everything it asked for or keeps waiting holding nothing — no partial hold, so no deadlock between two tasks wanting the same pair.
  - A dead holder is reaped like any lease; `abort` withdraws a lock wait; `--status` lists held locks; `wait_timeout` → 75.
- **Order**: priority descending, then arrival; a lock goes to its waiters in queue order.
  - The first waiter that fits by locks but not by threads is the **head**. A later task starts ahead of it (**backfill**) only when that cannot delay it: its estimated run ends before the threads the head waits for are expected free. The head waits for its minimum; a flexible head inside its `wait_full` window waits for its max.
  - The estimates are the p90 of the step's last successful runs on the same threads in the ledger (at least 3, within 30 days; a `fanout:` step has none; a flexible lease carries the estimate of the size it was granted, below) or `wf-run --est SEC`.
  - A request with neither takes the p90 of the last 10 runs of the same command in the pool's own `history` (see **Run history**, below).
  - The head's start is when the running leases' estimated ends free its minimum (a lease with no estimate, past it or over-running ends at an unknown time).
  - No estimate on either side: strict order, a smaller task never overtakes the head — starved or not.
  - A lease backfilled past a head that runs twice its estimate stops backfill past that head (`backfill off:` in `pool.log`; each backfill is a `backfill:` line). Nothing is preempted.
  - A waiter blocked by a held lock claims no threads, so a long-held lock (a dev server) does not stall the rest of the queue.
  - `N` above the budget counts as the budget: it waits for an empty machine and runs alone.
  - `threads: budget` / `--threads budget` asks for the whole budget as `config.yaml` sets it when the request is made — no hardcoded core count in a workflow.
- **Run history**: every lease that ends cleanly adds its run time to `history` in `pool.json`, by the lease's **label key**.
  - Cleanly: `wf-run` command exits 0, exec step succeeds; a lock-only lease, a failed or aborted run does not.
  - The label key is the label with a slice or task id (`ENG-POOL-FLEX`, `S201`) and commit hashes replaced by `*`, so one command is one key across slices; the last 10 runs of at most 200 keys are kept.
  - An entry that has no estimate of its own (no ledger p90 — a flexible or `fanout:` lease, a step with fewer than 3 successful runs on those threads — and no `--est`) takes the p90 of its key's samples, at least 3 of them, as its `est_ms`. A waiter can then backfill ahead of a head, and a running lease's end is known to the head's reservation.
  - Fewer than 3 samples: no estimate, strict order as before. `backfill off:` trips at twice the estimate however it was taken.
  - A flexible lease's samples mix every size it ran on: the estimate is rougher than a ledger curve, which still wins when there is one.
  - The samples are per machine and survive an empty pool (they live in `pool.json`).
- **Priority levels**: a session has a level — `low` (−100), `normal` (0, the default), `high` (100), `urgent` (200) — set by `start({ priority })` and inherited by its child sessions (an explicit `priority` on a child's `start` overrides it for that subtree).
  - A project can set the level of ALL its root sessions: `{ "priority": "urgent" }` in `.claude/workflows/settings.json` at the project root (a worktree resolves to its main checkout; the file is not a workflow, the loader reads only `*.yaml`).
  - `start` reads it from the session's cwd when neither an explicit `priority` nor a parent gives one. A `wf-run` outside a session (no `WF_PRIORITY`, no `--priority`) takes the same level from its cwd's project, keeping it as `WF_PRIORITY_LEVEL`. Without the file everything is as before (`normal` / 0).
  - A child still inherits its parent, never the file; `set_priority` still changes a session later.
  - The only key is `priority` (`low` / `normal` / `high` / `urgent`). An unknown key, a bad level or invalid JSON makes `start` fail naming the file, and `wf-run` exit 64.
    - `wf-run --fail-open` prints one stderr line and runs at 0; `wf-run --status` and `--usage` queue nothing and never read the file.
  - A lease's priority = the session level + the step's own `resource.priority`, so a step fine-tunes within its level (keep it under ±100).
  - `set_priority({ session_id, level })` changes the level of a session and of its active descendants at once (later children inherit it) and re-ranks their WAITING pool entries in the same pass; running leases keep theirs — there is no preemption.
  - Every exec gets `WF_PRIORITY` (that sum) and `WF_PRIORITY_LEVEL`; `wf-run` without `--priority` queues at `WF_PRIORITY` (outside a session: the project default above) and keeps the level, so a nested `wf-run` is re-ranked with its session.
  - Two windows keep the old level:
    - an exec whose context was built just before `set_priority` but had not yet joined the queue waits at the old level until it is granted,
    - and a `wf-run` inside an exec started before `set_priority` takes that exec's old `WF_PRIORITY`.
  - An explicit `--priority P` is the whole priority and has no level.
  - `set_priority` is for the user's request — an agent never raises its own session or changes another project's.
- **Flexible threads**: `threads: { min: A, max: B|budget }` with `wait_full: SEC` (default 0), or `wf-run --threads A-B [--wait-full SEC]` (`B` may be `budget`).
  - The waiter gets `B` when `B` fits; otherwise, once `wait_full` seconds have passed since it queued, it takes every thread that fits if that is at least `A`.
  - A waiter that also asks for `--lock`s counts those seconds from the moment its locks are first free, so time queued behind a lock does not use the window up.
  - `WF_THREADS` = the threads granted.
  - Order is unchanged: while a flexible head waits — for `B` inside its window, or for `A` after it — it closes the threads to everyone behind it like any waiter (the window waits for threads being freed; a smaller task taking them would defeat it).
  - `A`/`B` above the budget clamp to it. `wait_full` without a `{ min, max }` is a load error, `--wait-full` without a range a usage error. `threads: N` is `{ min: N, max: N }`.
- **By estimate instead of by window**: when the history has an estimate for every size A..B, or `wf-run --est-by-threads K:SEC,…` gives one, the waiter does not use `wait_full`.
  - The history estimate for a size is the p90 of the step's runs on that many threads. A size with no run of its own is read off `t(k) = a + b/k` fitted through the sizes that have 3 runs, at least two of them.
  - With `wf-run --est-by-threads K:SEC,…` a range needs at least two points or all its sizes.
  - For each size `k` it takes `start(k) + estimate(k)`: `start(k)` is now when `k` threads fit, else the moment the running leases' estimated ends free `k` (a lease with no estimate, past it or over-running ends at an unknown time: that size is not a candidate).
  - It takes the size that ends earliest, the larger on a tie: now on the room that is free, or — when more threads soon enough beat starting small — it waits for exactly that size, as the head, closing the threads to everyone behind it.
  - Behind another head it backfills only a size that ends before the head starts.
  - Its lease carries the granted size's estimate (`est_ms`), so later waiters see when it ends.
  - No history for some size: the `wait_full` rule above — but the granted lease still carries an `est_ms` read off the measured sizes (the granted size's own time, else the nearest measured size's as is), so backfill behind it sees its end.
- **Status**: `wf-run --status` and the `pool_status` MCP tool print the budget, the load (and a `STARVED:` line, above) and one line per lease and per waiter (in admission order):
  - `pid`,
  - what it holds or wants (`holds 6 threads (asked 2-8) + lock sim` / `wants 2-8 threads`, `, runs ~N` for a measured lease with threads, flagged `(OVERRUN)` or `(UNDERUSE)`),
  - `prio` with the level,
  - `since HH:MM:SS (Ns[, STARVED])`,
  - the project (the git root of its cwd, a linked worktree mapped to its main repo, `~`-shortened),
  - `session`,
  - `step` (`workflow/state`),
  - and the label (the command).
- **Load samples**: while a lease or waiter exists, a pass at least 60 s after the last one writes `<pool dir>/pool.log` one `sample:` line — `sample: load 7.5 external 1.1 held 8/10 runs 11.4 leases 2 waiting 3 [2-8, 4, lock a]`.
  - It holds: machine load (busy cpus), load not taken through the pool, threads held / budget, the sum of busy cpus of the leases' process trees (`-`: none measured), and the waiters with what they ask (`min-max` or `N` threads, locks; the first four, then `+N`).
  - It answers whether the CPUs were busy while a waiter waited on threads.
  - It is sampled by passes, so by a polling waiter (each second), `--status`, `pool_status` or a release; a pool with only leases and nobody polling is silent.
  - The clock is `last_sample` in `pool.json` (one rewrite a minute; the first pass with an entry starts it without a line, an empty pool drops it), shared by every process on the pool.
  - `pool.log` moves to `pool.log.1` past 1 MiB, so the two files stay under 2 MiB.
- **Reaping**: leases and waiters whose pid is dead are dropped on every pass. A lease lives while its pid OR its recorded process group does.
  - A `wf-run` lease owns its group: a SIGKILLed `wf-run` cannot release, and its child runs detached in a group of its own. So the next pass that finds the `wf-run` dead SIGTERMs that group (one `orphan:` line in `pool.log`), SIGKILLs it once it outlives a 3 s grace, and frees the lease when the group is gone.
  - The group is recorded with the boot it ran under and its leader's start time (`ps -o lstart`): a lease from another boot, or whose pgid now leads another process (the pid wrapped), is dropped without signalling anything.
  - A driver that SIGKILLs a job's `wf-run` therefore leaves no live child and no lease behind (it needs some pass: any waiter, `--status` or `pool_status`).
  - An exec's group is NOT killed when its server dies: the run survives for the resumed session to adopt, and its lease lives with it.
  - A waiter polls each second and wakes at once when `pool.json` changes; `wf-run` prints a progress line to stderr when it starts waiting and every 30 s.
- **Busy**: no lease within `--wait-timeout` / `wait_timeout` → exit **75** (EX_TEMPFAIL).
  - An exec routes it through `cases`/`on_error`.
  - Its `timeout` counts the run only: the lease wait of the exec itself, and the time a `wf-run` its command started has a waiter queued in the pool under the session's id, do not use it up. The deadline stretches by that wait, up to 4x the `timeout`, so a pool that never grants still ends the exec.
  - `wait_ms` is recorded beside `duration_ms` in the history and the ledger, together with `threads_granted` and `step_key` (below).
  - `abort` withdraws a waiting exec. `resource:` is for foreground execs only (a load error on `background: true` or a fetch).
- **`wf-run`**: the child runs in its own process group with inherited stdio; `--status` measures over a 0.6 s tick window; SIGINT/SIGTERM/SIGHUP are forwarded to the group; the exit code is the child's; the lease is released on exit.
  - `--efficiency` (macOS) runs the command under `taskpolicy -b` (efficiency cores, low priority) outside the budget — its `--lock`s still hold; elsewhere it warns and goes through the pool.
  - `--fail-open`: when the pool itself cannot be used (dir not writable or not creatable, broken `config.yaml`, lock not taken) the command runs without a lease, `WF_THREADS` = the smallest share asked, plus one stderr line — busy still waits; without it such a failure is exit 1 and the command never starts.

#### Pool gate — agents' heavy Bash commands through the pool

Agents do not call `wf-run` themselves. The plugin's PreToolUse(Bash) hook (`hooks/pool-gate.sh` → `build/pool-gate-hook.js`) rewrites a command the project marks heavy into `<plugin>/scripts/wf-run --fail-open --threads <N|MIN-MAX> --label '<command>' -- <shell> -c '<command>'` (absolute path, not `PATH`; `<shell>` = the Bash tool's `$SHELL` when it is sh/bash/zsh/dash/ksh, else `sh`).

What is heavy is decided ONLY by the project's `.claude/workflows/pool-gate.yaml`, the nearest one from the directory the command runs in up to the git root (none outside a git repo). That directory is the call's cwd, moved by the command's leading `cd <dir>` segments joined by `&&`, `;` or a newline: `cd /tmp/wf-X && npx vitest run …` is judged by `/tmp/wf-X`'s config, not by the project the session started in.

- A `cd` to an option, a variable, a substitution, `~` or a missing directory ends that walk.
- A directory with no config (outside a git repo, or a repo without one) falls back to the call's cwd's config, its `deny` rules included.
- The `deny` rules of the call's cwd's own config (the session's project) apply even when the target has a config of its own, so `cd /tmp/wf-X && git stash` is refused by the session project's `git stash` deny. Which command is heavy, and its share, follow the target's config alone, and a deny in either config refuses.
- No config, or no rule hit → the command is untouched and the hook says nothing.
- The no-config case is decided in the shell script itself (no node started), so a project without a `pool-gate.yaml` pays a few milliseconds per Bash call (a command that starts with `cd` always goes to node, which resolves the target).

Example (a sample — the plugin creates no project config):

```json
{
  "rules": [
    { "match": "npx vitest run", "threads": "2-8", "pass": "--maxWorkers=$WF_THREADS" },
    { "match": "npx vitest", "deny": "watch mode never ends under the pool — use `npx vitest run`" },
    { "match": "/^turbo run (build|test)\\b/", "threads": 6, "pass": "--concurrency=$WF_THREADS" },
    { "match": "haxe", "threads": 4, "pass": "env:HXCPP_COMPILE_THREADS" },
    { "match": "make", "threads": "2-6", "pass": "-j $WF_THREADS" }
  ],
  "wrappers": ["build-run.sh", "app-run.sh"]
}
```

- **`match`**: the leading words of a simple command (the first word also by basename: `haxe` hits `/opt/bin/haxe`; leading `VAR=x`, `env`, `time`, `exec`, `!` and `if`/`then`/`do` … are skipped), or `/regex/flags` tested on the command's text. The first rule that hits a segment wins, so put `npx vitest run` before the `npx vitest` refusal.
- **`env`** (optional): conditions on the segment's leading assignments (`NAME=value` before the command, also after `env` / `time` …), all of which must hold for the rule to hit:
  - Values:
    - `true` = set (any value, empty too),
    - `false` = not set,
    - `"/regex/flags"` = set and its unquoted value matches.
  - `match` alone cannot tell `APQ_TEST=unit. node bin/test.js` from a bare `node bin/test.js` (it sees the text from the command word on). `{ "match": "node bin/test.js", "env": { "APQ_TEST": true }, "threads": 1 }` before `{ "match": "node bin/test.js", "threads": 8 }` can.
  - Only the segment's own assignments count — not `export` in an earlier segment, not the hook's environment.
- **`threads`**: `N` or `"MIN-MAX"` (a flexible lease, `WF_THREADS` = what was granted).
- **`pass`** (optional) tells the command its share:
  - Forms:
    - a flag holding `$WF_THREADS`, put after the matched words (a regex hit: at the end, or before a `--` word when there is one) unless the command already gives that flag (`-j 2`, `-j8`, `--concurrency=2` stay),
    - or `env:NAME` → `env NAME="$WF_THREADS"` in front of the command.
  - `$WF_THREADS` is expanded by the shell under `wf-run`.
- **`deny`**: instead of `threads` — for what does not belong in a queue (watch modes, dev servers); the call is refused with the reason (`permissionDecision: deny`).
  - Order: a segment that runs `wf-run` or a `wrappers` script is never matched against the rules, `deny` included — its command already runs under a lease, by an explicit choice (the gate's own wrapped form too, so a `/regex/` needs no `^` anchor to keep off it).
  - Every other segment of the same command is still matched, and a `deny` hit there refuses the whole call.
- **`wrappers`**: project scripts that take their own lease (they call `wf-run` inside); a command running one is never wrapped again. A wrapper that takes no lease is not listed — a rule matching its name wraps the whole call, the script stays unchanged.
- **Splitting**: quotes, escapes, `$( )` and backticks are honoured; segments split at `&&` `||` `;` `|` `(` `)` and newlines.
  - A hit anywhere wraps the WHOLE command under ONE `wf-run` with the largest share any hit asks (mins and maxes each take their largest).
  - That is simpler and safer than cutting a shell line apart (redirections, pipes, `cd` all keep working; segments run one after another, so the largest is enough; a pipe of two heavy commands is under-counted).
  - A heavy command inside `$( )` is not seen.
- **Left alone**:
  - `WF_THREADS` already in the hook's environment (Claude Code itself runs under a lease),
  - a command holding `wf-run` or a `wrappers` script anywhere (a nested lease could wait on its own outer one),
  - a background `&` (the lease would end before the work),
  - a heredoc or an unterminated quote (not plain enough to edit).
- **Bypass**: `WF_POOL_BYPASS=1 [WF_POOL_BYPASS_REASON='…'] <command>` — untouched, one stderr line naming the reason.
- **Output**: unchanged — `wf-run` writes only to stderr (waits, progress) and exits with the command's code.
  - The gate passes no `--wait-timeout`, so a busy pool means a wait, never exit 75.
  - A Bash call that reaches its own timeout while waiting is moved to the background like any long command, not killed.
- **Never breaks Bash**: no node, no build, a broken `pool-gate.yaml` or any error in the gate → the command passes as it is plus one stderr line.
  - `--fail-open` does the same for the pool: a pool `wf-run` cannot use (an unwritable or uncreatable `$WF_POOL_DIR` — a sandbox, a read-only `~/.claude` —, a broken `config.yaml`, a lock it cannot take) runs the command without a lease, `WF_THREADS` = the smallest share asked, plus one stderr line.
  - Busy is not a failure: it waits.
- **With RTK**: Claude Code (2.1.312) keeps the LAST `updatedInput` of parallel PreToolUse hooks, which is almost always this gate's — RTK's own rewrite of the same command would be lost.
  - So when `rtk` is on `PATH` the gate puts the body through `rtk rewrite` itself, from the command's cwd:
    - exit 0 → RTK's rewrite and `permissionDecision: "allow"` (RTK checked that the user's allow rules cover every command in the chain — the decision Claude Code would take on the original line, whereas its own check sees the rewritten one);
    - 3 → RTK's rewrite, no decision;
    - 2 (a deny matched) → the gate leaves the whole command alone, so Claude Code's deny sees the original line;
    - anything else → the body as it is.
  - Without `rtk` there is no decision: the usual permission flow checks the rewritten line.
- **Never add an allow rule for `…/scripts/wf-run`**: `Bash(<plugin>/scripts/wf-run:*)` would allow ANY chain wrapped behind it, and the path changes with every plugin version anyway.
- **Limits**:
  - the inner `<shell> -c` does not get the Bash tool's shell snapshot (aliases, functions, `setopt`);
  - `npx -y …`, `sudo …`, `nice …` and commands inside `$( )` are not recognised;
  - the config is found from the call's `cwd` moved by the command's leading `cd` segments only (not from a `cd` after another command, in a subshell or through a variable);
  - and a `cd` inside a wrapped command does not move the Bash tool's working directory.

### `fetch` — make an HTTP request

```yaml
check_api:
  type: fetch
  url: "http://localhost:8888/ping"
  method: GET
  timeout: 5000
  retry:
    max: 60
    interval: 500
  on_success: ready
  on_error: wait
  success_prompt: "API ready: {{body}}"
  error_prompt: "Not responding: {{error}}"
```

### Routing

Action states route via `on_success`/`on_error`, or by specific codes using `cases`:

```yaml
run_tests:
  type: exec
  command: "npm test"
  cases:
    "0": all_passed
    "1": tests_failed
    "2": no_tests_found
  default: unknown_error
```

An exec killed by its `timeout` exits 124. `on_timeout: <state>` routes that apart from every other
outcome (it wins over `on_error` and `cases`) — a gate that timed out on a loaded machine is not a
code defect and should not enter the fix loop. Foreground exec only; beside `cases: { "124": … }` it
is a load error (two routes for one outcome).

### Fan-out — one command, many shards

```yaml
suite:
  type: exec
  command: "npx vitest run --shard=$WF_SHARD"
  timeout: 600000                      # per shard
  fanout: { count: 4, threads_each: 3, max_parallel: 4 }
  on_success: green
  on_error: red
  on_timeout: slow_machine
```

The engine runs the command in one of two forms:

- `count` times with `WF_SHARD=i/N` (1-based, `vitest`/`jest` `--shard` form);
- once per non-empty line `items_command` prints, with `WF_ITEM=<line>` (`fanout: { items_command: "ls test/suites", threads_each: 2 }`). Lines of `items_command` lose a trailing `\r`.

Leases and limits:

- Each instance takes its own lease of `threads_each` threads from the pool (`WF_THREADS`), so shards start as threads free up and the machine-wide budget holds.
- `max_parallel` caps the instances in flight (default: as many as the budget runs side by side, `budget / threads_each`). The rest wait outside the pool queue, so other sessions are not stuck behind the whole fan-out.
- `timeout` bounds each shard.

The result:

- The step exits 0 only if every shard does. Otherwise it exits with the failing shards' common exit code (all of them timed out → 124, which `on_timeout` routes), or 1 when they differ.
- `{{stdout}}` is the summary: `fanout: 3/4 ok, 1 failed (exit 1)` and each failed shard's output tail.
- Abort kills the running shards, withdraws the waiting ones and starts no more.
- History and ledger keep one `shards` entry per instance (`shard`, `exit_code`, `duration_ms`, `wait_ms`, `threads_granted`).

Refusals:

- `fanout` is a load error beside `background` or `resource`.
- A failing `items_command` fails the step without running a shard.

Known limitation: a fan-out's leases take no `resource:` options — no `wait_timeout` (so no exit 75 route), no `locks`, no step `priority` (the session level only).

### Template variables

All prompts support `{{mustache}}` templates. Context values are available everywhere via `{{context.key}}`, as are:

- `{{visits.<state>}}` (visit count in the active stack frame; empty if never visited);
- `{{root_workflow}}` (the workflow at the stack root, e.g. `subagent`);
- `{{session_id}}` and `{{parent_session_id}}` (empty at the root);
- `{{stale_sessions}}` (one `STALE:` line per stale session below this one — § Stall detection — or `none`; computed only when a template names it).

After action execution, result variables are also available:

| Source | Variables |
|--------|-----------|
| `exec` | `{{stdout}}`, `{{stderr}}`, `{{exit_code}}`, `{{pid}}` (background), `{{wait_ms}}` (`resource:`) |
| `fetch` | `{{status}}`, `{{body}}`, `{{error}}` |

They come from the session's last action result (`last_action_result` in the session JSON), so they are not limited to the action's own `success_prompt` / `error_prompt` / `context_set`:

- the state an action routes into renders them in its own `prompt`;
- later prompt states still see them;
- the next action state reads them in its `command` / `env` — until that action replaces them.

`context_set` a value to keep it past the next action.

Action states can be chained — `exec` → `exec` → `fetch` → `prompt` — up to 20 steps without agent involvement.

### `revisit_prompt` — per-visit data on a revisit

On a revisit of a prompt state the engine sends only "Revisit #N — follow the instructions from your first visit". A state whose prompt carries per-visit data (for example the `{{stdout}}` of the exec before it) can set `revisit_prompt`, a template rendered with the same variables as `prompt`, shown on revisits instead of that line.

- Absent = the generic line.
- `status()` (and any forced full prompt) still returns the full `prompt`, and so does a state with `full_on_revisit: true` (it wins over `revisit_prompt`).

```yaml
dispatch:
  prompt: "Admitted:\n{{stdout}}\n1. ..."
  revisit_prompt: "Admitted:\n{{stdout}}\nSame steps as your first visit."
```

### Stations — the columns of the live workflow map

`/api/workflows` returns per workflow `stations: [{name, script, terminal}]`: the states on the shortest route from `initial` to the success terminal, in order; `script` is an exec state.

- The route follows the happy moves (`transitions`, `on_success`, `on_complete`, `cases["0"]`; every move when the terminal is out of their reach).
- The success terminal is the farthest terminal whose `outcome` is not `fail`, or the one terminal with `station: true` (a mark on a failure terminal, or on several terminals, is ignored and the loader warns on stderr).
- A state's `station: false` leaves it out (an exec helper such as `prepare` or a `*_route`).
- `station: true` adds a reachable state that lies off the route, placed by its distance from `initial`.

Computed in `src/stations.ts`.

### Guards and the exhausted route

`max_transitions` (per workflow, per stack frame, default 50) and a state's `max_visits` refuse a move past them with an error.

- A move that only closes the run is exempt from `max_transitions`: one into a terminal, or into a state no route leads back to that leads on to a terminal (batch's `stop` -> `report` -> `finish`), so a run at its cap can still end cleanly.
- Within 5% of the cap every status / transition reply carries a `WARNING:` line naming what to do.
- The bundled `batch` sets 100000 (a queue loop takes about 3 transitions per task).

A state may instead name where a move past its `max_visits` goes:

```yaml
fix:
  prompt: "Fix attempt {{visits.fix}}"
  max_visits: 3
  on_exhausted: escalate      # the 4th move into fix enters escalate instead
  transitions: { retry: verify }
```

The route applies to every move into the state — an agent `transition`, an action state's `on_success`/`on_error`/`cases`, a skill gate's auto-transition; a pop's `on_complete`/`on_fail` does not check `max_visits`.

- Chained routes are followed (an exhausted `escalate` with its own route goes on), a cycle is an error, and the history entry's `detail` names the exhausted states.
- A rerouted action move shows the routed-to state's own prompt, not the action's `success_prompt`/`error_prompt` (written for the default target); the result stays readable there as `{{stdout}}`/`{{exit_code}}`.
- `on_exhausted` without `max_visits`, or to an unknown state, fails the load.
- `{{visits.<state>}}` counts visits in the active frame, so the routed-to state can say how many tries ran.

### Question states — `ask: parent`

A state tagged `ask: parent` asks its parent session a question: entering it logs an `ask` event in the event log, leaving it an `answer` (the dashboard's live map draws the pair).

A question from ANY state is asked through the context key `ask_parent` (a driver has no shell, so it is one `context_set`). The hand-back sets it to the reason, in the state the session stands in, and the pair is derived from the session alone:

- the question is OPEN while the key holds text and no move or end of the session came after the write that set it;
- the answer is the session's next move or end (the parent's own `transition` on the child: a regate, a close), or the key cleared to `""` (the driver, once the parent has answered); `to` = the state it moved to (or the state it stays in).

Details:

- A stale key is ignored.
- The same text written again while the question is open is still one question, and a question asked after an answer is a new `context_set`.
- The bundled driver instructions (`agents/driver.md`, `templates/drivers/task-driver.md`) set it before a NEEDS-PARENT line and clear it on resume.
- Asked inside an `ask: parent` state it is that state's one question, with its text.

The log:

- It is `GET /api/events?since=<run>:<seq>` and the SSE stream `/api/events/stream` (ids are `<run>:<seq>`; a position from another run — a server restart — restarts from 0).
- It covers only the server process that holds the dashboard port. Other Claude Code servers write their own `events/run-*.jsonl` under the state dir, which the dashboard does not serve.

### Stall detection — `stale_after`

A session whose state saw no engine call (no `transition`, `context_set`, … — any write) for longer than the state's `stale_after` seconds is **STALE**: its agent may be dead or stuck.

Unset, the state's type decides:

- a prompt state 1800 s (its agent calls the engine as it works);
- an `exec` / `fetch` 3600 s;
- a heavy exec (`resource:` or `fanout:`) 14400 s.

An exec's default is never below its own `timeout` x 4 (the most a pool wait stretches it) + 300 s, before which the timeout bounds it.

`stale_after: 0` = never (a state that waits for the user). On a terminal or `sub_workflow` state it is a load error (never read).

Never stale:

- an ended or suspended session (suspension is its own mark);
- a session with an active child (it waits for its children, each judged on its own);
- a `resource:` / `fanout:` exec waiting for its pool lease (before its run began, or marked `pool_starved`) while the process that owns the session is alive — the pool's wait, reported as `POOL STARVED`; a dead owner's wait counts.

The clock runs from the session's last write, or from the start of the state's run when that is later (`running_exec`, else `pending_action.run_at`, written when the step's first lease is granted — a `fanout:` has no `running_exec`). So a takeover, resume or `context_set` during a run resets it. A fetch or a light exec is timed from its last write.

Where it shows:

- `sessions` marks one `[STALE: no engine call for 47m (since …), past its state's stale_after 30m]`.
- `status` of a session lists the STALE sessions below it on top (the session itself is its parent's `status` and `sessions`' to show) (`STALE: session <id> (<workflow @ state>, child of <parent>, agent <agent id>) — …`) with what to do once: SendMessage the agent; no answer → abort the session, or let a new agent continue it from `status` — the session holds the step, so a restart loses nothing.
  - `transition` appends the same lines.
  - A line the answer's prompt already renders (`{{stale_sessions}}`) is not repeated; a revisit's digest renders no prompt, so there they come back as the notice.
  - A step run again (resume, an interrupted lease wait) drops its old `run_at`: its own first lease starts its clock.
- The bundled `batch` `collect` prompt lists the run's stale sessions (`{{stale_sessions}}`), so the dispatcher messages or restarts a stuck driver/worker; its `paused` state (waits for the user) is `stale_after: 0`.

```yaml
work:
  prompt: "Implement the change"       # a long single step: give it longer than the 30-min default
  stale_after: 7200
  transitions: { done: review }
```

### Strict schema

An unknown key in a workflow, a state, a `retry:`, `resource:`, `fanout:` or `model_table:` block fails that workflow's load (stderr names the file, the state, the key and the nearest known key) — a typo is never silently ignored.

### Ledger

Every session end appends one JSON line to `$STATE_DIR/ledger.jsonl`; this section lists what a line holds.

A line is written at: complete, fail, abort, cascade, and expiry of a suspended session.

**Always recorded**

- ids: session, parent, root; the workflow;
- `outcome`: `completed` / `failed` / `abandoned`;
- start/end time; transition count;
- exec durations by state and their pool waits (`wait_ms`, `wait_ms_total`);
- `segs`: each stretch of a state as `{s, a, b, w?}` in epoch ms, `w` the pool waits flat. The Timeline tab draws a pruned session from it.

**Resource and fan-out execs**

- a `resource:` exec records `threads_granted` (absent when it got no lease);
- a `fanout:` exec records its `shards`;
- both record `step_key` = `<project>|<workflow>|<state>`, where project is the git root of the session cwd (every worktree of a repo maps to its main one). This is the raw data a model of step time against threads keys its runs by; the engine only records it.

**From the session's context, when set** (what a `model_table` is tuned from)

- `difficulty`; `claim_difficulty` (the first one the table saw; `wf-calibration` counts a line off by >=2 from it in its `claim` column);
- `model`, `effort`, `escalations`, `review_model`, `review_effort`;
- `stages`: the `model` / `effort` each stage ran on.
  - A row is taken when a state reading `context.model_<stage>` was entered, or, in a prompt state, from `context.model` / `context.effort` (execute) or `context.review_model` / `context.review_effort` (review).
  - An exec's env does not count. First value wins; a later rescore does not replace it.
  - Only those rows exist, so a stage absent from the line did not run;
- `tokens`: `tokens` → `total`, `tokens_<role>` → `<role>`; whole numbers only.

**`spend`: the REAL cost of the task**

Summed at the task's end from the transcripts of every agent that worked on it, over the session and all its descendants. Agents counted:

- every agent `link_agent` ever linked to a session of the task (`agent_id` is only the latest; a respawned worker's predecessor is kept in `linked_agents`);
- any context key `agent_id_<stage>` or `<role>_agent`, such as `recon_agent` / `worker_agent` / `reviewer_agent`.

`spend.agents` counts them. Each turn is priced by its own model id at input, output, cache-read and cache-write rates:

- the table is `TURN_RATES_USD_PER_MTOK` in `src/calibration.ts`, keyed by model id with a family fallback for an unknown id of a known family;
- the rates are the Anthropic list of 2026-11-18; a 1-hour cache write costs twice the input rate.

A turn is counted once, only inside the task's start..end window.

- An agent whose transcript cannot be read, or whose model has no rate, leaves `usd` absent and its id in `spend.unmeasured`. The task is unmeasured, never $0.
- An agent nothing links or names (an unlinked decider, a respawned worker nobody linked) is counted in `spend.unnamed`: transcripts of the task's conversations active in its window, possibly a concurrent task's, so the figure is not presented as complete.

`spend.by_agent` lists the same spend per agent and linked state: `{agent, state?, stage?, model?, usd?, input, output, cache_read, cache_write}`.

- `state` is the parent's active state at the agent's `link_agent` call; `stage` is the first model-table stage that state spawns on. Every call is recorded in the session's `agent_links`, under any parent, `driver:` or not.
- An agent linked again (a worker for a fix round) splits at each call's time. A call at a state that spawns no stage keeps the stage before it. An agent nothing linked has neither.
- `model` is the model that cost the most there; `usd` is absent for an agent that could not be read or priced. The rows' `usd` sum to `spend.usd`.

**`parent_spend`**

A task's line (a line with a `task`, of a session that knows its Claude conversation) also records `parent_spend` `{conversation, project, from, to, offset, usd, input, output, cache_read, cache_write}`: what the PARENT (the top-level Claude Code session that dispatches, not a sub-agent) spent in its own turns.

- Source: `<projects>/<project>/<conversation>.jsonl`; `project` is that directory's name. Priced by the same table as `spend`.
- The transcript is read from the byte `offset` the conversation's previous line recorded, so a task's end reads the new turns only.
- A conversation's lines tile its time: each starts just after the latest `to` the ledger holds for that conversation (the first at the session's start). So the sum of `parent_spend.usd` over any lines counts a turn once (the plan pane's Landed heading sums those that ended in its 14 days).
- The appends of ended sessions run one after the other.
- A transcript that cannot be read, a model with no rate or an empty stretch leaves the line without `parent_spend`, and the next line covers the stretch. The turns after the last task end are in no line until the next one.

**Files and locking**

- Appends follow the session files' lock discipline with the ledger's own lock file. The ledger is never pruned with old sessions.
- Each append also rewrites `$STATE_DIR/ledger-recent.jsonl`: the task and parent-spend lines that ended in the last 30 days, cut to the fields the plan pane reads (`task`, `workflow`, `started_at`, `ended_at`, `outcome`, `visits`, `difficulty`, `spend.usd`, `parent_spend` `{to, project, usd}`), capped at 3 MiB, the oldest lines dropped first.
- The plan pane reads it (the plugin API rejects a read of a file over 4 MiB, which the never-pruned ledger outgrows), falling back to `ledger.jsonl` while it is absent.
- Exception: the Failed header's totals and each failed row's `$cost`. The dashboard's `GET /api/ledger-rows?tasks=<ids>` answers the cost rows of those lines from the whole `ledger.jsonl`.
