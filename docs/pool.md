---
title: Thread pool
description: Why parallel agents queue instead of choking the machine, and how leases, budget, priority, locks and backfill work
---

# Thread pool

Four agents each start a build, and the laptop stops answering. The pool is the fix: every heavy command, from every session, every project and every Claude Code config on the machine, asks one shared pool for threads first.

When the pool has them, the command starts. When it has not, the command waits in a queue, in order, and starts the moment threads are free. The machine stays usable and nothing is lost, because a waiting command is a patient one.

The reference text (every flag, every rule of admission) is in [Action states](/action-states#heavy-work-—-the-machine-wide-thread-pool). This page is the picture.

## Watch it

Below is the pool of a real window of hours, recorded by the pool's own log while the open-source anyparse project ran several pipelines at once.

The strip is the whole window: threads held against the budget (the dashed line), and the amber band along the top is the number of commands that were waiting. The panel under it is the Pool tab of the plan pane, drawn by the mod's own code at the cursor. Press play, or drag the slider.

<PoolDemo />

The log samples a pool once a minute while it has a lease or a waiter, and not at all while it is empty, so a flat stretch with nothing in it is an idle pool.

A sample lists no holders: the log names a lease only on an `overrun:`, `underuse:` or `backfill:` line, and a name appears on the sample after that line, only when it is a slice or session of the replayed project. Every other lease is one row, "leases the log does not name (this project or another)", because a sample cannot say whose threads they are.

The log keeps no priority and no age for a lease, so the rows here show none; the live tab shows both.

## How it works

<svg viewBox="0 0 720 250" role="img" aria-label="Commands ask the pool for threads: the pool holds leases up to its budget, the rest wait in a queue, ordered by priority" style="width:100%;max-width:720px;display:block;margin:16px auto;font:13px ui-monospace,Menlo,monospace">
  <text x="10" y="22" fill="currentColor" font-weight="700">commands ask</text>
  <g fill="none" stroke="currentColor" stroke-opacity=".5">
    <rect x="10" y="34" width="150" height="34" rx="6"/><rect x="10" y="78" width="150" height="34" rx="6"/>
    <rect x="10" y="122" width="150" height="34" rx="6"/><rect x="10" y="166" width="150" height="34" rx="6"/>
  </g>
  <g fill="currentColor"><text x="22" y="56">test suite · 6</text><text x="22" y="100">build · 2-8</text><text x="22" y="144">corpus · 4</text><text x="22" y="188">land · lock</text></g>
  <path d="M170 51h60M170 95h60M170 139h60M170 183h60" stroke="currentColor" stroke-opacity=".5"/>
  <rect x="230" y="30" width="250" height="180" rx="10" fill="none" stroke="currentColor" stroke-width="2"/>
  <text x="244" y="52" fill="currentColor" font-weight="700">the pool · budget 14</text>
  <rect x="244" y="64" width="222" height="22" rx="4" fill="#4ec98a" fill-opacity=".75"/><text x="252" y="80" fill="#fff">lease · 6 threads</text>
  <rect x="244" y="92" width="150" height="22" rx="4" fill="#61a8ff" fill-opacity=".75"/><text x="252" y="108" fill="#fff">lease · 4 threads</text>
  <rect x="244" y="120" width="76" height="22" rx="4" fill="#61a8ff" fill-opacity=".75"/><text x="252" y="136" fill="#fff">2</text>
  <rect x="324" y="120" width="142" height="22" rx="4" fill="none" stroke="currentColor" stroke-opacity=".4" stroke-dasharray="4 4"/><text x="332" y="136" fill="currentColor" fill-opacity=".6">free</text>
  <text x="244" y="172" fill="currentColor" fill-opacity=".7">held 12 of 14 threads</text>
  <text x="244" y="192" fill="currentColor" fill-opacity=".7">one holder per lock</text>
  <text x="500" y="22" fill="currentColor" font-weight="700">waiting, in order</text>
  <g fill="none" stroke="#e5c07b"><rect x="500" y="34" width="200" height="34" rx="6"/><rect x="500" y="78" width="200" height="34" rx="6" stroke-opacity=".7"/><rect x="500" y="122" width="200" height="34" rx="6" stroke-opacity=".45"/></g>
  <g fill="currentColor"><text x="512" y="56">high · 4-8 threads</text><text x="512" y="100">normal · 2 threads</text><text x="512" y="144">low · 6 threads</text></g>
  <path d="M480 51h18" stroke="#e5c07b"/>
  <text x="500" y="190" fill="currentColor" fill-opacity=".7">the head may be passed by a</text><text x="500" y="208" fill="currentColor" fill-opacity=".7">short job that ends first</text>
</svg>

**Lease.** A lease is a claim on some threads for as long as a command runs. The command is told how many it got (`WF_THREADS`) and is expected to use that many: `make -j"$WF_THREADS"`. A lease is released when the command exits, or when its process is found dead.

**Budget.** The pool has a number of threads to give out, by default the performance cores minus two. Granted leases never add up to more than the budget, and beside a running lease, load that did not come through the pool (a video call, a browser) counts against the budget too, so the pool backs off when the machine is busy with something else.

**Priority.** A session has a level: `low`, `normal` (the default), `high` or `urgent`, set when it starts and inherited by its children. A project can set one level for all its tasks. The queue is ordered by priority, then by arrival. A waiter that has queued past `starve_after` (15 minutes by default) is marked STARVED everywhere it can be seen, so a stuck queue is never silent.

**Locks.** Some work is one at a time whatever the threads: a dev server on a fixed port, a simulator, the step that lands a change. A lease can ask for a named lock, and the pool grants threads and locks together or neither, so two tasks that want the same pair can never deadlock each other.

**Backfill.** When the first in line needs more threads than are free, the pool does not leave them idle. A later, smaller job starts ahead of it only if it is expected to finish before the head's threads would be free, so it can never delay the head. The estimates come from the command's own past runs. A job that runs past twice its estimate switches backfill off for that head.

**Overrun.** A lease counts threads, but a command can run more processes than that. The pool reads the process table and flags a lease whose tree runs well above its threads as OVERRUN (`OVERRUN ~12` in the tab), and counts what the tree runs as the lease's own load, never as foreign load.

**Underuse.** The other way round is just as visible: a lease asks for threads the caller says it will use. A lease whose tree runs at least half its threads (and at least one cpu) below them for 30 seconds is logged as UNDERUSE in `pool.log` and marked `(UNDERUSE)` in `wf-run --status`, `pool_status` and the dashboard's Pool tab (an `UNDERUSE ~N` plaque).

The 30 seconds are real time: a lease nobody sampled for longer than a meter credits (nobody polls the pool and its holder never passes) is judged by ONE status call over the stretch since its last sample (its meter, else its grant), by the process table's own cpu average, not from that call.

- `wf-run --status` and `pool_status` also show what every measured lease runs against what it holds (`holds 4 threads, runs ~3`); the dashboard shows `runs` only in the OVERRUN and UNDERUSE plaques.
- The pool only reports it: the size of a lease is its caller's declaration, and the caller fixes it.
- `wf-run --usage` adds up the leases that ended, per label, so a project can right-size its own callers.

## Using it

A workflow's `exec` state asks with `resource: { threads: 6, priority: 0, wait_timeout: 900 }` and the engine does the rest. Anywhere else, `wf-run` puts any command through the pool:

```bash
wf-run --threads 2-8 --wait-full 60 --lock land --label "build" -- make -j"$WF_THREADS"
wf-run --status    # the pool: budget, load, every lease and waiter, in admission order
wf-run --usage --since 24h    # per label: leases, threads held and used, idle and overrun thread-minutes
```

Agents' own heavy Bash commands go through it too, without asking: the pool gate hook rewrites the commands a project marks heavy. See [Pool gate](/action-states#pool-gate-—-agents-heavy-bash-commands-through-the-pool).

The pool lives in `~/.claude/workflow-pool` (`WF_POOL_DIR`), one directory for the machine. Its optional `config.yaml` takes three keys:

| Key | Meaning | Default |
| --- | --- | --- |
| `budget` | threads to give out | performance cores minus 2 |
| `load_threshold` | load below this is noise, not external work | 2 |
| `starve_after` | seconds before a waiter is marked STARVED | 900 |

To look at it: the Pool tab of the plan pane (key `4`) and the dashboard's Pool tab show the same rows as the panel above, live; `wf-run --status` and the `pool_status` tool print them as text; `pool.log` in the pool directory keeps the minute-by-minute samples this page replays.
