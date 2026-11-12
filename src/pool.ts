// The machine-wide thread pool for heavy work: every `wf-run` process and
// every exec with `resource:` takes a lease — threads, named locks, or both —
// from one directory shared by all sessions, projects and Claude config dirs
// on the machine. Admission happens under a file lock (the storage's
// proper-lockfile discipline) on `pool.json`.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYaml, warnLeftoverJson } from "./yaml-config.js";
import lockfile from "proper-lockfile";
import { LOCK_NAME_PATTERN, LOCK_STALE_MS, PRIORITY_LEVELS, type PriorityLevel } from "./types.js";
import { p90 } from "./estimate.js";
import {
  bootTimeMs,
  isGroupAlive,
  isPidAlive,
  killProcessGroup,
  processStart,
  sameBoot,
} from "./process.js";

/** EX_TEMPFAIL: no lease within the wait timeout ("busy"). */
export const EX_TEMPFAIL = 75;

const POOL_FILE = "pool.json";
const CONFIG_FILE = "config.yaml";
// One line per orphan reaped, over-running lease, starved waiter, backfill and load sample; rotated past LOG_MAX_BYTES.
const LOG_FILE = "pool.log";
const LOG_MAX_BYTES = 1 << 20;
// While a lease or waiter exists, a pass at least this long after the last sample logs one `sample:` line.
const SAMPLE_EVERY_MS = 60_000;
// A sample names this many waiters; the rest are counted.
const SAMPLE_WAITERS_SHOWN = 4;
// A waiter queued this long (or a pool that granted nothing this long) is starved (config `starve_after`, seconds).
const DEFAULT_STARVE_AFTER_SEC = 900;
// An orphaned group that survives its SIGTERM this long gets SIGKILL.
export const ORPHAN_KILL_GRACE_MS = 3000;
// The process table is sampled at most this often per pool (a `ps` per pass of every waiter is wasted work),
// outside the pool lock; after a failed sample (`ps` hung or broke) none is tried for PROCESS_BACKOFF_MS.
const PROCESS_SAMPLE_MS = 1000;
const PROCESS_BACKOFF_MS = 30_000;
// Cores left to light work (shells, editors, the agents themselves); light
// load up to the same amount is noise, not external heavy work.
const RESERVED_CORES = 2;
const DEFAULT_POLL_MS = 1000;
// The run times kept per label key, and how many keys: the pool file stays small.
export const HISTORY_SAMPLES = 10;
const HISTORY_KEYS = 200;
const DEFAULT_PROGRESS_MS = 30_000;
// `wf-run --status` / `pool_status`: the cpu tick window a status measures over.
const STATUS_WINDOW_MS = 600;
// CPU load is measured over the ticks between two passes: a window shorter
// than the minimum keeps the last measurement, one longer than the maximum
// is stale (an idle server's last pass) and restarts the measurement.
const LOAD_WINDOW_MIN_MS = 500;
const LOAD_WINDOW_MAX_MS = 5000;
// Every waiter polls the same file: a contended lock waits its turn.
const POOL_LOCK_RETRIES = {
  retries: 200,
  minTimeout: 5,
  maxTimeout: 50,
  randomize: true,
};

/** Cumulative CPU time of the machine, summed over its logical cpus (ms). */
export interface CpuTicks {
  readonly busy: number;
  readonly total: number;
  readonly cpus: number;
}

/** Where cpu count, load and liveness come from — injected by tests. */
export interface PoolProbes {
  perfCores(): number;
  /** The fallback load before a tick window exists: lags a minute, so it overstates a load that just ended. */
  loadavg(): number;
  cpuTicks(): CpuTicks;
  isAlive(pid: number): boolean;
  isGroupAlive(pgid: number): boolean;
  /** The process table (`ps`); throws when it cannot be read. Absent: no lease's own load is measured. */
  processes?(): readonly ProcSample[];
  /** When a process started (`ps -o lstart`), undefined when gone. Absent: a reaped group's leader is not re-identified. */
  processStart?(pid: number): string | undefined;
}

/** One process of the table: who it is, whose child, which group, how busy. */
export interface ProcSample {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** Busy cpus: 1 = one core (the kernel's recent average on macOS, the lifetime average on Linux). */
  readonly cpu: number;
}

function readProcesses(): readonly ProcSample[] {
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,%cpu="], {
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 16 << 20,
    env: { ...process.env, LC_ALL: "C" },
  });
  const procs: ProcSample[] = [];
  for (const line of out.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 4) continue;
    const [pid, ppid, pgid] = f.slice(0, 3).map(Number);
    const cpu = Number(f[3].replace(",", ".")) / 100;
    if ([pid, ppid, pgid, cpu].every(Number.isFinite)) procs.push({ pid, ppid, pgid, cpu });
  }
  return procs;
}

function readCpuTicks(): CpuTicks {
  let busy = 0;
  let total = 0;
  const cpus = os.cpus();
  for (const { times } of cpus) {
    const b = times.user + times.nice + times.sys + times.irq;
    busy += b;
    total += b + times.idle;
  }
  return { busy, total, cpus: cpus.length };
}

let perfCoresOfMachine: number | undefined;

function readPerfCores(): number {
  if (process.platform === "darwin") {
    try {
      const n = parseInt(
        execFileSync("sysctl", ["-n", "hw.perflevel0.physicalcpu"], {
          encoding: "utf8",
        }).trim(),
        10,
      );
      if (n > 0) return n;
    } catch {
      /* Intel / older macOS: no performance levels */
    }
  }
  return os.cpus().length;
}

export const systemProbes: PoolProbes = {
  perfCores: () => (perfCoresOfMachine ??= readPerfCores()),
  loadavg: () => os.loadavg()[0],
  cpuTicks: readCpuTicks,
  isAlive: isPidAlive,
  isGroupAlive,
  processes: readProcesses,
  processStart,
};

/**
 * The pool directory: `$WF_POOL_DIR`, else `$HOME/.claude/workflow-pool`.
 * Deliberately not under `CLAUDE_CONFIG_DIR`: every config dir shares one budget.
 */
export function resolvePoolDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WF_POOL_DIR) return path.resolve(env.WF_POOL_DIR);
  return path.join(env.HOME || os.homedir(), ".claude", "workflow-pool");
}

export interface PoolConfig {
  readonly budget: number;
  readonly load_threshold: number;
  /** Seconds: a waiter queued this long, or a pool with waiters that granted nothing this long, is starved. */
  readonly starve_after: number;
}

/** A lease (granted, `started` set) or a waiter (queued since `arrived`). */
export interface PoolEntry {
  readonly id: string;
  readonly pid: number;
  /** A waiter: the threads it asks for (a flexible one: its max). A lease: the threads granted. */
  readonly threads: number;
  /** A flexible request: the fewest threads it accepts (`threads` is its max). */
  readonly min_threads?: number;
  /** A flexible waiter takes fewer than its max only from this time on (ms since epoch). */
  readonly full_until?: number;
  /**
   * A flexible waiter that holds locks: its `wait_full` window in ms, not started yet.
   * The window starts when the waiter's locks are first free (`full_until` is then set
   * and this dropped), so time queued behind a lock does not use it up.
   */
  readonly full_ms?: number;
  /** A lease from a flexible request, or one the budget clamped: the threads it asked for (a flexible one: its max). */
  readonly asked_threads?: number;
  readonly priority: number;
  /** The session level `priority` includes; `set_priority` moves a waiter that has one. */
  readonly level?: PriorityLevel;
  /** The git root (main worktree) of the requester's cwd, else the cwd. */
  readonly project?: string;
  /** The workflow step a session exec leases for: `workflow/state`. */
  readonly step?: string;
  readonly label: string;
  readonly cwd: string;
  readonly session_id: string;
  readonly arrived: number;
  readonly started?: number;
  /** The leased command's process group: the lease lives while `pid` OR this group does. */
  readonly pgid?: number;
  /** The boot the group was recorded under (`bootTimeMs`): under another boot `pgid` names some other group. */
  readonly boot_ms?: number;
  /** When the group's leader started (`ps -o lstart`): a different leader under that pgid is not the leased group. */
  readonly pgid_start?: string;
  /** Named locks, held exclusively machine-wide for the lease's life; granted together with the threads. */
  readonly locks?: readonly string[];
  /**
   * The leased group dies with `pid` (a `wf-run` lease): once `pid` is dead the
   * reaper kills the group and frees the lease. An exec's group outlives its
   * server instead — a resumed session adopts the run.
   */
  readonly owns_group?: true;
  /** When the reaper first signalled the orphaned group (SIGKILL follows after ORPHAN_KILL_GRACE_MS). */
  readonly orphaned?: number;
  /** When the lease's process tree was first seen running well above its threads (logged once). */
  readonly overrun?: number;
  /** When the waiter was first seen starved (logged once). */
  readonly starved?: number;
  /**
   * The p90 run time (ms) of the step from the ledger or of the label's recent runs in the
   * pool's `history`: what backfill trusts. Absent: unknown, never backfilled by time.
   */
  readonly est_ms?: number;
  /**
   * A flexible waiter: its estimated run (ms, a p90) on each of `min_threads..threads` threads,
   * by thread count. With it the pool picks the size that ends earliest (waiting for more
   * threads when their ETA beats starting small); the lease keeps the granted size's as `est_ms`.
   */
  readonly est_curve?: Readonly<Record<string, number>>;
  /** A lease granted ahead of a waiting head (backfill): that head's id. */
  readonly backfill_for?: string;
}

export interface PoolState {
  readonly leases: readonly PoolEntry[];
  readonly waiting: readonly PoolEntry[];
  /** The last grant (ms since epoch): a pool with waiters and no grant for `starve_after` is starved. */
  readonly last_grant?: number;
  /** A head nothing is backfilled past any more: a lease backfilled ahead of it ran past twice its estimate. */
  readonly backfill_off?: string;
  /** The last `sample:` line written to `pool.log` (ms since epoch); absent while the pool is empty. */
  readonly last_sample?: number;
  /**
   * The run times (ms, oldest first, the last `HISTORY_SAMPLES`) of finished leases by label
   * key (`labelKey`): an entry with no estimate of its own takes the p90 of its key's.
   */
  readonly history?: Readonly<Record<string, readonly number[]>>;
}

// What differs between runs of one command and is no part of its identity: a slice or task id
// (`ENG-POOL-FLEX`, `S201`), a commit hash.
const RUN_SPECIFIC =
  /\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b|\b[A-Z]\d+\b|\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g;

/** The identity of a lease's work across runs: its label with the slice id (and commit hashes) dropped. Empty: no identity. */
export function labelKey(label: string): string {
  return label.trim() === "" ? "" : label.replace(RUN_SPECIFIC, "*");
}

/** The p90 of the last runs with `label`'s key, or undefined below `MIN_SAMPLES`: strict order, as without history. */
export function historyEstimate(
  state: Pick<PoolState, "history">,
  label: string,
): number | undefined {
  const key = labelKey(label);
  return key === "" ? undefined : p90(state.history?.[key] ?? []);
}

/** `history` with one more run of `label`: the key moves to the newest, past `HISTORY_KEYS` the oldest key goes. */
export function recordRun(
  state: Pick<PoolState, "history">,
  label: string,
  ms: number,
): NonNullable<PoolState["history"]> {
  const key = labelKey(label);
  if (key === "" || !(ms > 0) || !Number.isFinite(ms)) return state.history ?? {};
  const { [key]: old = [], ...rest } = state.history ?? {};
  const kept = Object.entries({
    ...rest,
    [key]: [...old, Math.round(ms)].slice(-HISTORY_SAMPLES),
  });
  return Object.fromEntries(kept.slice(-HISTORY_KEYS));
}

/** The pool after one admission pass. */
export interface PoolView extends PoolState, PoolConfig {
  readonly load: number;
  /** Load not taken through the pool, measured before this pass's grants: a lease's own process tree is not external. */
  readonly external: number;
  /** Threads leased after this pass's grants. */
  readonly held: number;
  /** Busy cpus of each measured lease's process tree, by lease id. */
  readonly runs: Readonly<Record<string, number>>;
}

/** A request larger than the budget counts as the whole budget: it waits for an empty machine. */
export function effectiveThreads(entry: Pick<PoolEntry, "threads">, budget: number): number {
  return Math.min(entry.threads, budget);
}

/** Queue order: priority descending, then arrival; the id breaks exact ties. */
export function byQueueOrder(a: PoolEntry, b: PoolEntry): number {
  return (
    b.priority - a.priority || a.arrived - b.arrived || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The fewest threads a waiter accepts: `min_threads` of a flexible request, else all it asks for. */
function minThreads(entry: Pick<PoolEntry, "threads" | "min_threads">, budget: number): number {
  return Math.min(entry.min_threads ?? entry.threads, effectiveThreads(entry, budget));
}

/** What an entry asks for: `6 threads`, `2-8 threads`, `lock port:3000`, `6 threads + lock a + lock b`. */
export function describeRequest(
  entry: Pick<PoolEntry, "threads" | "min_threads" | "locks">,
  budget: number,
): string {
  const n = effectiveThreads(entry, budget);
  const min = minThreads(entry, budget);
  const threads = min < n ? `${min}-${n} threads` : `${n} threads`;
  return [...(n > 0 ? [threads] : []), ...(entry.locks ?? []).map(l => `lock ${l}`)].join(" + ");
}

/**
 * The project a cwd belongs to: the nearest directory holding `.git`; a linked
 * worktree (`.git` file pointing into `<main>/.git/worktrees/`) maps to its
 * main worktree, so every worktree of a repo is one project. No repo: the cwd.
 */
export function projectRoot(cwd: string): string {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      /* not here */
    }
    if (stat?.isDirectory()) return dir;
    if (stat?.isFile()) {
      const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1].trim();
      const main = gitdir && /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(path.resolve(dir, gitdir))?.[1];
      return main || dir;
    }
    if (path.dirname(dir) === dir) return path.resolve(cwd);
  }
}

/** The project name a session's cwd belongs to: the main checkout's directory name, so every worktree of a repo is one project. Null when the cwd is not a path. */
export function projectNameOf(cwd: unknown): string | null {
  if (typeof cwd !== "string" || cwd === "") return null;
  return path.basename(projectRoot(cwd)) || null;
}

/** The pool priority of a request at `level` with the step's own `priority` added. */
export function levelPriority(level: PriorityLevel, stepPriority = 0): number {
  return PRIORITY_LEVELS[level] + stepPriority;
}

/**
 * One admission pass: drop dead entries, then grant waiters in queue order.
 * A waiter gets everything it asks for at once or nothing: its threads fit
 * (`held + N <= budget` and, unless the pool is empty, also
 * `held + N + external <= budget` — external load never blocks an empty pool:
 * a head of N >= budget would otherwise wait forever on background load) AND
 * none of its locks is held or wanted by an earlier waiter. A lock is handed
 * out in queue order. The first waiter that fits by locks but not by threads
 * is the head: a later waiter takes threads ahead of it (backfill) only when
 * its estimate (`est_ms`: its own, else the p90 of the recent runs of its label key,
 * `history`) ends before the threads the head waits for are expected free (`headAt`), so it
 * cannot delay the head. No estimate on either side: strict order. (Threads "left over after the head's min" do not exist
 * now: a head blocked by threads has less room than it needs.) A lease
 * backfilled past a head that runs twice its estimate stops backfill past
 * that head (`backfill_off`). A waiter
 * blocked only by a held lock claims no threads, so a long-held lock does not
 * stall the rest of the queue; holding nothing while waiting, nobody deadlocks.
 *
 * A flexible waiter (`min_threads` below its max) gets its max when that fits;
 * otherwise, once `full_until` has passed, all the threads that fit if they
 * are at least its min. A waiter that asks for locks starts that window when
 * its locks are first free (`full_ms`), not at its arrival. While it waits —
 * for its max inside the `full_until` window, or for its min after it — it
 * closes the threads to everyone behind it like any waiter: what the window
 * waits for is the threads being freed, and a later task taking them would
 * defeat it.
 *
 * A flexible waiter with an estimate by threads (`est_curve`) does not use that
 * window: for each size k in min..max it takes the start of k (now when k fits,
 * else `headAt` of k over the running leases' estimated ends) plus its run on k
 * threads, and takes the size that ends earliest — now, or after a short wait for
 * more threads, in which case it is the head and waits for exactly that size. A size
 * whose threads free at an unknown time is not a candidate. Behind a head it
 * backfills only a size that ends before the head's start. A lease from it carries
 * the granted size's estimate. No (or an incomplete) curve: the rule above.
 *
 * `runs` (busy cpus of a lease's own process tree): a lease with threads
 * accounts for the larger of its threads and its tree, so a lease whose
 * command runs more processes than it leased is not external load that
 * blocks every waiter (`overruns` flags it instead). A lock-only lease takes
 * no threads: its tree stays external.
 */
export function schedule(
  state: PoolState,
  config: PoolConfig,
  load: number,
  isLive: (entry: PoolEntry) => boolean,
  now: number,
  runs: Readonly<Record<string, number>> = {},
): PoolView {
  // An entry with no estimate of its own takes the p90 of its label's recent runs (`history`).
  const estimateOf = (e: PoolEntry): number | undefined =>
    e.est_ms ?? historyEstimate(state, e.label);
  const leases = state.leases.filter(isLive).map(e => {
    const est = e.threads > 0 && e.started !== undefined ? estimateOf(e) : undefined;
    return est !== undefined && e.est_ms === undefined ? { ...e, est_ms: est } : e;
  });
  const waiting = state.waiting.filter(isLive).sort(byQueueOrder);
  let held = leases.reduce((sum, e) => sum + effectiveThreads(e, config.budget), 0);
  const own = leases.reduce((sum, e) => {
    const n = effectiveThreads(e, config.budget);
    return sum + (n > 0 ? Math.max(n, runs[e.id] ?? 0) : 0);
  }, 0);
  const external = Math.max(0, load - own - config.load_threshold);
  let lastGrant = state.last_grant;
  const locked = new Set(leases.flatMap(e => e.locks ?? []));
  const claimed = new Set<string>();
  const still: PoolEntry[] = [];
  // the head is the first waiter that fits by locks but not by threads
  let head: Reservation | undefined;
  let backfillOff = waiting.some(w => w.id === state.backfill_off) ? state.backfill_off : undefined;
  // The threads a waiter takes out of `avail`: its max, else (window over) all of `avail` down to its min.
  const fit = (w: PoolEntry, avail: number, until: number): number | undefined => {
    const max = effectiveThreads(w, config.budget);
    if (avail >= max) return max;
    if (now >= until && avail >= minThreads(w, config.budget)) return avail;
    return undefined;
  };
  for (const w of waiting) {
    const locks = w.locks ?? [];
    const max = effectiveThreads(w, config.budget);
    const locksFree = !locks.some(l => locked.has(l) || claimed.has(l));
    // the window of a waiter that holds locks starts when they are first free
    const until = w.full_until ?? now + (w.full_ms ?? 0);
    // The most threads that fit now: external load counts only beside a live lease.
    const room = held === 0 ? config.budget : Math.floor(config.budget - held - external);
    const curve = max === 0 ? undefined : curveOfEntry(w, config.budget);
    const estimate = estimateOf(w);
    let n: number | undefined;
    let waitAt: number | undefined;
    if (max === 0) n = 0;
    else if (curve) {
      const pick = pickByEta(curve, room, head, now, leases, config.budget, external, runs);
      n = pick.n;
      waitAt = pick.waitAt;
    } else if (!head) n = fit(w, room, until);
    else if (head.at !== undefined && now + (estimate ?? Infinity) <= head.at)
      n = fit(w, room, until);
    if (locksFree && n !== undefined) {
      const { full_until: _window, ...granted } = w;
      const asked =
        w.min_threads !== undefined || n !== w.threads ? { asked_threads: w.threads } : {};
      const backfill = head && n > 0 ? { backfill_for: head.id } : {};
      const est = curve ? curve.get(n) : estimate;
      // a waiter's starved mark is not the lease's (undefined: never written)
      leases.push({
        ...granted,
        threads: n,
        started: now,
        ...asked,
        ...backfill,
        starved: undefined,
        full_ms: undefined,
        est_curve: undefined,
        ...(est !== undefined ? { est_ms: est } : {}),
      });
      held += n;
      lastGrant = now;
      for (const l of locks) locked.add(l);
      continue;
    }
    if (locksFree && w.full_until === undefined && w.full_ms !== undefined) {
      still.push({ ...w, full_ms: undefined, full_until: until });
    } else still.push(w);
    for (const l of locks) claimed.add(l);
    if (locksFree && !head) {
      // A lease backfilled past this head that ran twice its estimate: estimates are not trusted for it any more.
      if (
        leases.some(
          e =>
            e.backfill_for === w.id &&
            e.est_ms !== undefined &&
            e.started !== undefined &&
            now - e.started > 2 * e.est_ms,
        )
      )
        backfillOff = w.id;
      // inside its wait_full window a flexible head waits for its max; one with a curve, for its picked size
      const need = curve || now >= until ? minThreads(w, config.budget) : max;
      const at =
        backfillOff === w.id
          ? undefined
          : (waitAt ?? headAt(leases, need, config.budget, external, runs, now));
      head = { id: w.id, ...(at !== undefined ? { at } : {}) };
    }
  }
  return {
    ...config,
    load,
    external,
    held,
    leases,
    waiting: still,
    ...(lastGrant !== undefined ? { last_grant: lastGrant } : {}),
    ...(backfillOff !== undefined ? { backfill_off: backfillOff } : {}),
    ...(state.history ? { history: state.history } : {}),
    runs,
  };
}

/** A waiter's estimate by threads for every size it accepts, else undefined. */
function curveOfEntry(w: PoolEntry, budget: number): ReadonlyMap<number, number> | undefined {
  if (!w.est_curve) return undefined;
  const out = new Map<number, number>();
  for (let k = minThreads(w, budget); k <= effectiveThreads(w, budget); k++) {
    const t = w.est_curve[k];
    if (!(typeof t === "number" && t > 0 && Number.isFinite(t))) return undefined;
    out.set(k, t);
  }
  return out;
}

/**
 * The size a flexible waiter with a curve takes: `n` now, or it waits (`waitAt`: when the
 * threads of the size that ends earliest are expected free), or neither (nothing fits and no
 * size has a known start). Ties end at the earlier start, then the larger size.
 */
function pickByEta(
  curve: ReadonlyMap<number, number>,
  room: number,
  head: Reservation | undefined,
  now: number,
  leases: readonly PoolEntry[],
  budget: number,
  external: number,
  runs: Readonly<Record<string, number>>,
): { n?: number; waitAt?: number } {
  let best: { k: number; start: number; end: number } | undefined;
  const better = (c: { k: number; start: number; end: number }): boolean =>
    !best ||
    c.end < best.end ||
    (c.end === best.end && (c.start < best.start || (c.start === best.start && c.k > best.k)));
  for (const [k, ms] of curve) {
    if (head) {
      // behind a head only a size that fits now and ends before the head starts
      if (k > room || head.at === undefined || now + ms > head.at) continue;
      if (better({ k, start: now, end: now + ms })) best = { k, start: now, end: now + ms };
      continue;
    }
    const start = k <= room ? now : headAt(leases, k, budget, external, runs, now);
    if (start === undefined) continue;
    if (better({ k, start, end: start + ms })) best = { k, start, end: start + ms };
  }
  if (!best) return {};
  return best.start <= now ? { n: best.k } : { waitAt: best.start };
}

/** The head's reservation in one admission pass. */
interface Reservation {
  readonly id: string;
  /** When the threads the head waits for are expected free; absent: unknown, nothing passes it. */
  readonly at?: number;
}

/**
 * When `need` threads are expected free: the leases end in the order of their
 * estimated ends (start + `est_ms`) until the room fits. A lease with no
 * estimate, past its estimate or over-running ends at an unknown time: if the
 * room needs it, the answer is undefined.
 */
function headAt(
  leases: readonly PoolEntry[],
  need: number,
  budget: number,
  external: number,
  runs: Readonly<Record<string, number>>,
  now: number,
): number | undefined {
  const ends = leases
    .map(e => {
      const n = effectiveThreads(e, budget);
      const end =
        e.est_ms !== undefined && e.started !== undefined ? e.started + e.est_ms : Infinity;
      return {
        n,
        end: end > now && !overruns(e, { budget, runs }) ? end : Infinity,
      };
    })
    .filter(e => e.n > 0)
    .sort((a, b) => a.end - b.end);
  let held = ends.reduce((sum, e) => sum + e.n, 0);
  for (const { n, end } of ends) {
    if (end === Infinity) return undefined;
    held -= n;
    if ((held === 0 ? budget : Math.floor(budget - held - external)) >= need) return end;
  }
  return undefined;
}

/**
 * Busy cpus of each lease's process tree: the members of its group and their
 * descendants, without the group of another lease (a `wf-run` nested in a
 * leased exec counts once, as its own lease). A lease with no group, or whose
 * group has no member in the table, is not measured.
 */
export function treeLoads(
  leases: readonly PoolEntry[],
  procs: readonly ProcSample[],
): Record<string, number> {
  const children = new Map<number, ProcSample[]>();
  const members = new Map<number, ProcSample[]>();
  const add = (m: Map<number, ProcSample[]>, k: number, p: ProcSample): void => {
    const list = m.get(k);
    if (list) list.push(p);
    else m.set(k, [p]);
  };
  for (const p of procs) {
    add(children, p.ppid, p);
    add(members, p.pgid, p);
  }
  const groups = new Set(leases.flatMap(e => (e.pgid !== undefined ? [e.pgid] : [])));
  const runs: Record<string, number> = {};
  for (const e of leases) {
    if (e.pgid === undefined || !members.has(e.pgid)) continue;
    const seen = new Set<number>();
    const stack = [...members.get(e.pgid)!];
    let cpu = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      if (seen.has(p.pid) || (p.pgid !== e.pgid && groups.has(p.pgid))) continue;
      seen.add(p.pid);
      cpu += p.cpu;
      stack.push(...(children.get(p.pid) ?? []));
    }
    runs[e.id] = Math.round(cpu * 10) / 10;
  }
  return runs;
}

/** A lease's tree runs well above its threads: at least max(2, threads/2) cpus over them. A lock-only lease never. */
export function overruns(lease: PoolEntry, view: Pick<PoolView, "budget" | "runs">): boolean {
  const n = effectiveThreads(lease, view.budget);
  const runs = view.runs[lease.id];
  return n > 0 && runs !== undefined && runs - n >= Math.max(2, n / 2);
}

/** `45s`, `17m`, `2h10m`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** A waiter queued for `starve_after` or longer. */
export function isStarved(
  e: PoolEntry,
  view: Pick<PoolView, "starve_after">,
  now: number,
): boolean {
  return e.started === undefined && now - e.arrived >= view.starve_after * 1000;
}

/** Since when a pool with waiters has granted nothing (the later of its last grant and its oldest waiter's arrival). */
function idleSince(view: PoolView): number | undefined {
  if (view.waiting.length === 0) return undefined;
  const oldest = Math.min(...view.waiting.map(e => e.arrived));
  return Math.max(view.last_grant ?? 0, oldest);
}

/** What keeps the pool from granting: the threads held and the external load, the over-running leases. */
function blockers(view: PoolView): string {
  const over = view.leases
    .filter(e => overruns(e, view))
    .map(
      e =>
        `pid ${e.pid} holds ${effectiveThreads(e, view.budget)}, runs ~${Math.round(view.runs[e.id])}`,
    );
  return (
    `held ${view.held}/${view.budget}, external ${view.external.toFixed(1)}` +
    (over.length > 0 ? `; over-running: ${over.join(", ")}` : "")
  );
}

/** The pool-wide starvation line, or undefined: waiters and no grant for `starve_after`. */
export function poolStarvation(view: PoolView, now: number): string | undefined {
  const since = idleSince(view);
  if (since === undefined || now - since < view.starve_after * 1000) return undefined;
  return `STARVED: nothing granted for ${formatDuration(now - since)}, ${view.waiting.length} waiting (${blockers(view)})`;
}

/**
 * The notice a starved waiter reports (its exec to the session, `wf-run` to
 * stderr), or undefined while it is not starved.
 */
export function starvationNotice(self: PoolEntry, view: PoolView, now: number): string | undefined {
  if (!isStarved(self, view, now)) return undefined;
  const ahead = view.waiting.findIndex(e => e.id === self.id);
  const idle = idleSince(view);
  return (
    `queued ${formatDuration(now - self.arrived)} for ${describeRequest(self, view.budget)} (starve_after ${formatDuration(view.starve_after * 1000)}): ` +
    `${blockers(view)}${ahead > 0 ? `, ${ahead} ahead in queue` : ""}` +
    (idle !== undefined && now - idle >= view.starve_after * 1000
      ? `, nothing granted for ${formatDuration(now - idle)}`
      : "")
  );
}

export interface LeaseRequest {
  /** 0 only beside `locks`: a lock-only lease takes no threads and is never blocked by load. A flexible request: its max. */
  readonly threads: number;
  /** A flexible request: the fewest threads it accepts (1..threads). */
  readonly minThreads?: number;
  /** A flexible request: wait this long for `threads` before taking fewer. Default 0. */
  readonly waitFullMs?: number;
  readonly locks?: readonly string[];
  /** The whole pool priority (a session request: its level's value plus the step's). */
  readonly priority?: number;
  /** The session level `priority` includes: `set_priority` re-ranks the waiter. */
  readonly level?: PriorityLevel;
  /** Default: the git root of `cwd`. */
  readonly project?: string;
  readonly step?: string;
  readonly label?: string;
  readonly cwd?: string;
  readonly sessionId?: string;
  /** The process whose death frees the lease. Default: this process. */
  readonly pid?: number;
  /** The group attached later dies with `pid`: once `pid` is dead the reaper kills it (a `wf-run` lease). */
  readonly ownsGroup?: boolean;
  /** The run's expected time (ms, a p90): lets the pool backfill it ahead of a waiting head. Absent: the p90 of its label's recent runs in the pool's `history`. */
  readonly estMs?: number;
  /**
   * A flexible request: the run's expected time (ms, a p90) on each of `minThreads..threads`
   * threads. With every size covered the pool takes the size that ends earliest, waiting
   * for more threads when their ETA beats starting small, instead of `waitFullMs`.
   */
  readonly estCurve?: Readonly<Record<number, number>>;
}

export interface AcquireOptions {
  /** Give up after this long; undefined waits until granted or aborted. */
  readonly waitTimeoutMs?: number;
  readonly pollMs?: number;
  readonly progressMs?: number;
  readonly signal?: AbortSignal;
  /** Called when the wait begins and then once per `progressMs`. */
  readonly onProgress?: (self: PoolEntry, view: PoolView) => void;
}

export interface Lease {
  readonly entry: PoolEntry;
  /** Threads granted: the request clamped to the budget at the grant (`WF_THREADS` of the leased command). */
  readonly threads: number;
  /** Record the leased command's process group: it keeps the lease alive if the leaseholder dies first. */
  attach(pgid: number): Promise<void>;
  /**
   * Idempotent; also grants the waiters the freed threads now fit. The lease's run time goes
   * into the pool's `history` of its label unless the run `failed` (a failed run's time says
   * nothing about a good one's).
   */
  release(opts?: { readonly failed?: boolean }): Promise<void>;
}

export type AcquireResult =
  | {
      readonly status: "granted";
      readonly waitMs: number;
      readonly lease: Lease;
    }
  | {
      readonly status: "timeout" | "aborted";
      readonly waitMs: number;
      readonly view: PoolView;
    };

/** Sleep until `ms` pass, `signal` aborts, or the function handed to `setWake` is called. */
function sleep(
  ms: number,
  signal: AbortSignal | undefined,
  setWake: (wake: (() => void) | undefined) => void,
): Promise<void> {
  return new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      setWake(undefined);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    setWake(done);
  });
}

function readState(raw: string, fp: string): PoolState {
  if (raw.trim() === "") return { leases: [], waiting: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<PoolState>;
    return {
      leases: parsed.leases ?? [],
      waiting: parsed.waiting ?? [],
      ...(typeof parsed.last_grant === "number" ? { last_grant: parsed.last_grant } : {}),
      ...(typeof parsed.backfill_off === "string" ? { backfill_off: parsed.backfill_off } : {}),
      ...(typeof parsed.last_sample === "number" ? { last_sample: parsed.last_sample } : {}),
      ...(parsed.history && typeof parsed.history === "object" ? { history: parsed.history } : {}),
    };
  } catch {
    console.error(`wf-pool: ${fp} is not valid JSON — starting from an empty pool`);
    return { leases: [], waiting: [] };
  }
}

export class Pool {
  readonly dir: string;
  private readonly _probes: PoolProbes;
  private _ticks: CpuTicks | undefined;
  private _measuredLoad: number | undefined;
  private _procs: { readonly at: number; readonly list: readonly ProcSample[] } | undefined;
  private _procsFailedAt: number | undefined;

  constructor(dir: string, probes: PoolProbes = systemProbes) {
    this.dir = dir;
    this._probes = probes;
  }

  /** `config.yaml` (optional): `budget` (default: performance cores − 2, at least 1), `load_threshold`, `starve_after` (seconds, default 900). */
  config(): PoolConfig {
    const fp = path.join(this.dir, CONFIG_FILE);
    warnLeftoverJson(fp);
    let raw: unknown = {};
    try {
      if (fs.existsSync(fp)) raw = parseYaml(fs.readFileSync(fp, "utf8"));
    } catch (err) {
      throw new Error(`${fp}: ${(err as Error).message}`);
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw new Error(`${fp}: expected a mapping`);
    const obj = raw as Record<string, unknown>;
    for (const key of Object.keys(obj))
      if (key !== "budget" && key !== "load_threshold" && key !== "starve_after")
        throw new Error(`${fp}: unknown key "${key}"`);
    const { budget, load_threshold: threshold, starve_after: starve } = obj;
    if (budget !== undefined && !(Number.isInteger(budget) && (budget as number) > 0))
      throw new Error(`${fp}: budget must be a positive integer`);
    if (threshold !== undefined && !(typeof threshold === "number" && threshold >= 0))
      throw new Error(`${fp}: load_threshold must be a non-negative number`);
    if (starve !== undefined && !(typeof starve === "number" && starve > 0))
      throw new Error(`${fp}: starve_after must be a positive number of seconds`);
    return {
      budget:
        (budget as number | undefined) ?? Math.max(1, this._probes.perfCores() - RESERVED_CORES),
      load_threshold: threshold ?? RESERVED_CORES,
      starve_after: (starve as number | undefined) ?? DEFAULT_STARVE_AFTER_SEC,
    };
  }

  /** Reap dead entries, grant what fits, and report the pool. */
  status(): Promise<PoolView> {
    return this._pass();
  }

  async acquire(req: LeaseRequest, opts: AcquireOptions = {}): Promise<AcquireResult> {
    const locks = [...new Set(req.locks ?? [])];
    for (const l of locks)
      if (!LOCK_NAME_PATTERN.test(l))
        throw new Error(`a lock name is one word without whitespace, got "${l}"`);
    if (!Number.isInteger(req.threads) || req.threads < (locks.length > 0 ? 0 : 1))
      throw new Error(
        `threads must be a positive integer${locks.length > 0 ? " or 0" : ""}, got ${req.threads}`,
      );
    const flexible = req.minThreads !== undefined;
    if (
      flexible &&
      !(Number.isInteger(req.minThreads) && req.minThreads! >= 1 && req.minThreads! <= req.threads)
    )
      throw new Error(`min threads must be an integer in 1..${req.threads}, got ${req.minThreads}`);
    if (req.waitFullMs !== undefined && !flexible)
      throw new Error("waiting for the full threads needs a min");
    if (req.estCurve !== undefined && !flexible)
      throw new Error("an estimate by threads needs a min");
    const priority = req.priority ?? 0;
    if (!Number.isInteger(priority))
      throw new Error(`priority must be an integer, got ${priority}`);
    const pid = req.pid ?? process.pid;
    const arrived = Date.now();
    const cwd = req.cwd ?? process.cwd();
    const self: PoolEntry = {
      id: `${pid}-${randomUUID().slice(0, 8)}`,
      pid,
      threads: req.threads,
      ...(flexible
        ? {
            min_threads: req.minThreads,
            // behind a lock the window starts when the lock is free, not now
            ...(locks.length > 0 && (req.waitFullMs ?? 0) > 0
              ? { full_ms: req.waitFullMs }
              : { full_until: arrived + (req.waitFullMs ?? 0) }),
          }
        : {}),
      priority,
      ...(req.level ? { level: req.level } : {}),
      label: req.label ?? "",
      cwd,
      project: req.project ?? projectRoot(cwd),
      ...(req.step ? { step: req.step } : {}),
      session_id: req.sessionId ?? "",
      arrived,
      ...(locks.length > 0 ? { locks } : {}),
      ...(req.ownsGroup ? { owns_group: true as const } : {}),
      ...(req.estMs !== undefined && req.estMs > 0 ? { est_ms: req.estMs } : {}),
      ...(req.estCurve !== undefined ? { est_curve: { ...req.estCurve } } : {}),
    };
    const progressMs = opts.progressMs ?? DEFAULT_PROGRESS_MS;
    let lastProgress: number | undefined;
    // A release or a grant rewrites pool.json: wake at once instead of at the next poll.
    let wake: (() => void) | undefined;
    let watcher: fs.FSWatcher | undefined;
    try {
      for (;;) {
        if (opts.signal?.aborted) return await this._giveUp(self, "aborted", arrived);
        const view = await this._pass(self);
        if (view.leases.some(e => e.id === self.id)) return this._granted(self, arrived, view);
        const now = Date.now();
        if (lastProgress === undefined || now - lastProgress >= progressMs) {
          opts.onProgress?.(self, view);
          lastProgress = now;
        }
        const left =
          opts.waitTimeoutMs === undefined ? Infinity : arrived + opts.waitTimeoutMs - now;
        if (left <= 0) return await this._giveUp(self, "timeout", arrived);
        watcher ??= this._watch(() => wake?.());
        // A flexible waiter's window ending changes what it accepts: pass again right then.
        const until = view.waiting.find(e => e.id === self.id)?.full_until;
        const window = until !== undefined && until > now ? until - now : Infinity;
        await sleep(Math.min(opts.pollMs ?? DEFAULT_POLL_MS, left, window), opts.signal, w => {
          wake = w;
        });
      }
    } finally {
      watcher?.close();
    }
  }

  /** Call `onChange` whenever pool.json is replaced; polling stays the fallback. */
  private _watch(onChange: () => void): fs.FSWatcher | undefined {
    try {
      return fs.watch(this.dir, (_event, filename) => {
        if (filename === POOL_FILE) onChange();
      });
    } catch {
      return undefined;
    }
  }

  private _granted(self: PoolEntry, arrived: number, view: PoolView): AcquireResult {
    let released = false;
    const entry = view.leases.find(e => e.id === self.id)!;
    const lease: Lease = {
      entry,
      threads: effectiveThreads(entry, view.budget),
      attach: async pgid => {
        // read outside the pool lock: a slow `ps` must not hold every waiter
        const start = this._probes.processStart?.(pgid);
        const group = {
          pgid,
          boot_ms: bootTimeMs(),
          ...(start ? { pgid_start: start } : {}),
        };
        await this._update(state => ({
          ...state,
          leases: state.leases.map(e => (e.id === self.id ? { ...e, ...group } : e)),
        }));
      },
      release: async (opts = {}) => {
        if (released) return;
        released = true;
        await this._remove(self.id, opts.failed !== true);
      },
    };
    return { status: "granted", waitMs: Date.now() - arrived, lease };
  }

  /** Withdraw from the queue; a timeout that raced a grant keeps the lease. */
  private async _giveUp(
    self: PoolEntry,
    why: "timeout" | "aborted",
    arrived: number,
  ): Promise<AcquireResult> {
    const view = await this._update(state => {
      const granted = state.leases.some(e => e.id === self.id);
      const keep = granted && why === "timeout";
      return {
        ...state,
        leases: keep ? state.leases : state.leases.filter(e => e.id !== self.id),
        waiting: state.waiting.filter(e => e.id !== self.id),
      };
    });
    if (view.leases.some(e => e.id === self.id)) return this._granted(self, arrived, view);
    return { status: why, waitMs: Date.now() - arrived, view };
  }

  /**
   * Move the waiters of `sessionIds` that carry a level to `level`: their
   * priority shifts by the difference, and this same pass re-ranks the queue.
   * Leases keep theirs (nothing is preempted). Resolves the number moved.
   */
  async reprioritize(sessionIds: ReadonlySet<string>, level: PriorityLevel): Promise<number> {
    let moved = 0;
    await this._update(state => ({
      ...state,
      waiting: state.waiting.map(e => {
        if (!e.level || e.level === level || !sessionIds.has(e.session_id)) return e;
        moved++;
        return {
          ...e,
          priority: e.priority - PRIORITY_LEVELS[e.level] + PRIORITY_LEVELS[level],
          level,
        };
      }),
    }));
    return moved;
  }

  /** A status pass over a fresh cpu-tick window (the first pass only opens it). */
  async measuredStatus(windowMs = STATUS_WINDOW_MS): Promise<PoolView> {
    await this._pass();
    await new Promise(r => setTimeout(r, windowMs));
    return this._pass();
  }

  private _remove(id: string, record: boolean): Promise<PoolView> {
    return this._update(state => {
      const lease = state.leases.find(e => e.id === id);
      const ran = record && lease?.started !== undefined && lease.threads > 0;
      return {
        ...state,
        leases: state.leases.filter(e => e.id !== id),
        waiting: state.waiting.filter(e => e.id !== id),
        ...(ran
          ? {
              history: recordRun(state, lease.label, Date.now() - lease.started),
            }
          : {}),
      };
    });
  }

  /** One admission pass; `self` joins the queue unless it is already queued or leased. */
  private _pass(self?: PoolEntry): Promise<PoolView> {
    return this._update(state => {
      const known =
        !self ||
        state.leases.some(e => e.id === self.id) ||
        state.waiting.some(e => e.id === self.id);
      return known ? state : { ...state, waiting: [...state.waiting, self] };
    });
  }

  /**
   * Machine load in busy cpus over the ticks since this pool's previous
   * measurement. No window yet (first pass, or a stale one) falls back to
   * loadavg — conservative, it still holds the echo of load that has ended.
   */
  private _load(): number {
    const now = this._probes.cpuTicks();
    const prev = this._ticks;
    const windowMs = prev ? (now.total - prev.total) / now.cpus : 0;
    if (!prev || windowMs > LOAD_WINDOW_MAX_MS || windowMs < 0) {
      this._ticks = now;
      this._measuredLoad = undefined;
    } else if (windowMs >= LOAD_WINDOW_MIN_MS) {
      this._measuredLoad = ((now.busy - prev.busy) / (now.total - prev.total)) * now.cpus;
      this._ticks = now;
    }
    return this._measuredLoad ?? this._probes.loadavg();
  }

  /**
   * A `wf-run` lease whose `wf-run` is dead (SIGKILLed: it could not release)
   * while its detached group still runs: SIGTERM the group, SIGKILL it once it
   * outlives the grace. The lease lives until the group is gone. A group
   * recorded under another boot, or whose leader is another process than the
   * one recorded (the pgid was reused), is not the leased one: the lease is
   * dropped and nothing is signalled.
   */
  private _reapOrphans(state: PoolState, now: number): PoolState {
    let changed = false;
    const leases: PoolEntry[] = [];
    for (const e of state.leases) {
      if (!e.owns_group || e.pgid === undefined || this._probes.isAlive(e.pid)) {
        leases.push(e);
        continue;
      }
      if (e.boot_ms === undefined || !sameBoot(e.boot_ms)) {
        changed = true;
        continue;
      }
      if (!this._probes.isGroupAlive(e.pgid)) {
        leases.push(e);
        continue;
      }
      if (e.orphaned === undefined) {
        // checked once, before the first signal; a gone leader leaves members of the same group
        const leader = e.pgid_start !== undefined ? this._probes.processStart?.(e.pgid) : undefined;
        changed = true;
        if (leader !== undefined && leader !== e.pgid_start) {
          this._log(
            now,
            `orphan: pid ${e.pid} is dead, its group ${e.pgid} is another process's now — lease dropped, nothing signalled`,
          );
          continue;
        }
        killProcessGroup(e.pgid, "SIGTERM");
        this._log(
          now,
          `orphan: pid ${e.pid} is dead, SIGTERM its group ${e.pgid} — ${e.label || "-"}`,
        );
        leases.push({ ...e, orphaned: now });
        continue;
      }
      if (now - e.orphaned >= ORPHAN_KILL_GRACE_MS) killProcessGroup(e.pgid, "SIGKILL");
      leases.push(e);
    }
    return changed ? { ...state, leases } : state;
  }

  /**
   * Refresh the process table, OUTSIDE the pool lock, when some lease has a
   * group (`raw`: pool.json read without the lock) and the last sample is
   * PROCESS_SAMPLE_MS old; a failed sample backs off PROCESS_BACKOFF_MS.
   */
  private _sampleProcesses(raw: string, now: number): void {
    if (!this._probes.processes || !raw.includes('"pgid"')) return;
    if (this._procs && now - this._procs.at < PROCESS_SAMPLE_MS && now >= this._procs.at) return;
    if (this._procsFailedAt !== undefined && now - this._procsFailedAt < PROCESS_BACKOFF_MS) return;
    try {
      this._procs = { at: now, list: this._probes.processes() };
      this._procsFailedAt = undefined;
    } catch {
      this._procs = undefined;
      this._procsFailedAt = now;
    }
  }

  /** The process trees of the leases with a group, from the last sample (none recent: unmeasured). */
  private _runs(leases: readonly PoolEntry[], now: number): Record<string, number> {
    if (!this._procs || now - this._procs.at > PROCESS_BACKOFF_MS) return {};
    return treeLoads(leases, this._procs.list);
  }

  /** Mark (and log once) the leases newly over-running and the waiters newly starved. */
  private _mark(view: PoolView, now: number): PoolView {
    const leases = view.leases.map(e => {
      if (e.overrun !== undefined || !overruns(e, view)) return e;
      this._log(
        now,
        `overrun: pid ${e.pid} holds ${effectiveThreads(e, view.budget)} threads, runs ~${Math.round(view.runs[e.id])} — ${e.label || "-"}`,
      );
      return { ...e, overrun: now };
    });
    const waiting = view.waiting.map(e => {
      if (e.starved !== undefined || !isStarved(e, view, now)) return e;
      this._log(now, `starved: pid ${e.pid} ${starvationNotice(e, view, now)} — ${e.label || "-"}`);
      return { ...e, starved: now };
    });
    return { ...view, leases, waiting };
  }

  /** Log the leases this pass backfilled ahead of a head, and a head newly closed to backfill. */
  private _logBackfill(before: PoolState, view: PoolView, now: number): void {
    const known = new Set(before.leases.map(e => e.id));
    for (const e of view.leases)
      if (e.backfill_for !== undefined && !known.has(e.id))
        this._log(
          now,
          `backfill: pid ${e.pid} takes ${e.threads} threads ahead of ${e.backfill_for}` +
            `${e.est_ms !== undefined ? ` (est ${formatDuration(e.est_ms)})` : ""} — ${e.label || "-"}`,
        );
    if (view.backfill_off !== undefined && view.backfill_off !== before.backfill_off)
      this._log(
        now,
        `backfill off: a lease backfilled ahead of ${view.backfill_off} ran past twice its estimate — nothing passes it any more`,
      );
  }

  /**
   * Log a load sample when the last one is SAMPLE_EVERY_MS old; returns the new `last_sample`. The
   * first pass with an entry starts the clock without a line, an empty pool clears it.
   */
  private _sample(view: PoolView, last: number | undefined, now: number): number | undefined {
    if (view.leases.length === 0 && view.waiting.length === 0) return undefined;
    if (last === undefined || now < last) return now;
    if (now - last < SAMPLE_EVERY_MS) return last;
    this._log(now, sampleLine(view));
    return now;
  }

  /** One line to `pool.log`; a log that cannot be written is not the pool's failure. */
  private _log(now: number, line: string): void {
    const fp = path.join(this.dir, LOG_FILE);
    try {
      if (fs.existsSync(fp) && fs.statSync(fp).size > LOG_MAX_BYTES) fs.renameSync(fp, `${fp}.1`);
      fs.appendFileSync(fp, `${new Date(now).toISOString()} ${line}\n`);
    } catch {
      /* best effort */
    }
  }

  /** Under the pool lock: apply `change`, run an admission pass, write the result. */
  private async _update(change: (state: PoolState) => PoolState): Promise<PoolView> {
    fs.mkdirSync(this.dir, { recursive: true });
    const fp = path.join(this.dir, POOL_FILE);
    if (!fs.existsSync(fp)) fs.writeFileSync(fp, "", { flag: "a" });
    this._sampleProcesses(fs.readFileSync(fp, "utf8"), Date.now());
    const release = await lockfile.lock(fp, {
      stale: LOCK_STALE_MS,
      retries: POOL_LOCK_RETRIES,
    });
    try {
      const raw = fs.readFileSync(fp, "utf8");
      const live = (e: PoolEntry): boolean =>
        this._probes.isAlive(e.pid) ||
        (e.pgid !== undefined &&
          (e.boot_ms === undefined || sameBoot(e.boot_ms)) &&
          this._probes.isGroupAlive(e.pgid));
      const now = Date.now();
      const state = this._reapOrphans(change(readState(raw, fp)), now);
      const view = this._mark(
        schedule(state, this.config(), this._load(), live, now, this._runs(state.leases, now)),
        now,
      );
      this._logBackfill(state, view, now);
      const lastSample = this._sample(view, state.last_sample, now);
      const next = JSON.stringify(
        {
          leases: view.leases,
          waiting: view.waiting,
          // only a waiter can starve: with none, the next one's wait counts from its arrival
          ...(view.last_grant !== undefined && view.waiting.length > 0
            ? { last_grant: view.last_grant }
            : {}),
          ...(view.backfill_off !== undefined ? { backfill_off: view.backfill_off } : {}),
          ...(lastSample !== undefined ? { last_sample: lastSample } : {}),
          ...(view.history ? { history: view.history } : {}),
        },
        null,
        2,
      );
      // An unchanged pool is not rewritten: every rewrite wakes every waiter.
      if (next !== raw) {
        const tmp = `${fp}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, next);
        fs.renameSync(tmp, fp);
      }
      return view;
    } finally {
      await release();
    }
  }
}

/**
 * The `pool.log` load sample: machine load, load not taken through the pool, threads held, the busy
 * cpus the measured leases' trees run (`-`: none measured), and the waiters with what they ask.
 */
export function sampleLine(view: PoolView): string {
  const measured = Object.values(view.runs);
  const runs = measured.length > 0 ? measured.reduce((a, b) => a + b, 0).toFixed(1) : "-";
  const asks = view.waiting
    .slice(0, SAMPLE_WAITERS_SHOWN)
    .map(e => describeRequest(e, view.budget).replace(/ threads/g, ""));
  const more = view.waiting.length - asks.length;
  const waiting =
    view.waiting.length > 0 ? ` [${asks.join(", ")}${more > 0 ? `, +${more}` : ""}]` : "";
  return (
    `sample: load ${view.load.toFixed(1)} external ${view.external.toFixed(1)} ` +
    `held ${view.held}/${view.budget} runs ${runs} leases ${view.leases.length} waiting ${view.waiting.length}${waiting}`
  );
}

function holder(e: PoolEntry, view: PoolView): string {
  const runs = overruns(e, view) ? `, runs ~${Math.round(view.runs[e.id])}` : "";
  return `${e.label || `pid ${e.pid}`} (${effectiveThreads(e, view.budget)}${runs})`;
}

/** The line a waiter prints when it starts waiting and every progress interval. */
export function describeWait(self: PoolEntry, view: PoolView, now: number = Date.now()): string {
  const ahead = view.waiting.findIndex(e => e.id === self.id);
  const holders = view.leases.map(e => holder(e, view)).join(", ") || "nobody";
  const starved = isStarved(self, view, now)
    ? ` — STARVED: queued ${formatDuration(now - self.arrived)} (starve_after ${formatDuration(view.starve_after * 1000)})`
    : "";
  const lockHolders = (self.locks ?? []).flatMap(l => {
    const h = view.leases.find(e => e.locks?.includes(l));
    return h ? [`, lock ${l} held by ${h.label || `pid ${h.pid}`}`] : [];
  });
  return (
    `wf-run: waiting for ${describeRequest(self, view.budget)} — held ${view.held}/${view.budget} by ${holders}, ` +
    `external ${view.external.toFixed(1)}${lockHolders.join("")}${ahead > 0 ? `, ${ahead} ahead in queue` : ""}${starved}`
  );
}

/** What `formatEntry` flags: a lease's tree running well above its threads, a starved waiter. */
export interface EntryMarks {
  /** The busy cpus of an over-running lease's tree. */
  readonly runs?: number;
  readonly starved?: boolean;
}

/** What a lease holds: `4 threads (asked 2-8) + lock a`. */
export function describeHeld(
  e: Pick<PoolEntry, "threads" | "min_threads" | "asked_threads" | "locks">,
): string {
  const asked =
    e.asked_threads === undefined
      ? ""
      : ` (asked ${e.min_threads !== undefined ? `${e.min_threads}-` : ""}${e.asked_threads})`;
  return [
    ...(e.threads > 0 ? [`${e.threads} threads${asked}`] : []),
    ...(e.locks ?? []).map(l => `lock ${l}`),
  ].join(" + ");
}

/** One row per lease or waiter: who (project, session, step), what (threads, locks, priority), since when. */
export function formatEntry(
  e: PoolEntry,
  budget: number,
  now: number = Date.now(),
  home: string = os.homedir(),
  marks: EntryMarks = {},
): string {
  const since = e.started ?? e.arrived;
  let what: string;
  if (e.started === undefined) {
    what = `wants ${describeRequest(e, budget)}`;
  } else {
    what = `holds ${describeHeld(e)}`;
    if (marks.runs !== undefined) what += `, runs ~${Math.round(marks.runs)} (OVERRUN)`;
  }
  const project = e.project ?? e.cwd;
  const shown =
    project === home || project.startsWith(`${home}/`) ? `~${project.slice(home.length)}` : project;
  const clock = new Date(since).toTimeString().slice(0, 8);
  return (
    `  pid ${e.pid}  ${what}  prio ${e.priority}${e.level ? ` ${e.level}` : ""}  since ${clock} (${Math.round((now - since) / 1000)}s${marks.starved ? ", STARVED" : ""})` +
    `  ${shown}${e.session_id ? `  session ${e.session_id}` : ""}${e.step ? `  step ${e.step}` : ""}  ${e.label || "-"}`
  );
}

/** One lease or waiter as the dashboard's Pool panel and `GET /api/pool` carry it. */
export interface PoolRow {
  readonly entry: PoolEntry;
  /** A waiter: what it wants, as `describeRequest` prints it. A lease: what it holds, as `describeHeld` prints it. */
  readonly request: string;
  /** Lease: ms since it started. Waiter: ms queued. */
  readonly ageMs: number;
  /** A measured lease: the busy cpus of its process tree. */
  readonly runs?: number;
  readonly overrun: boolean;
  readonly starved: boolean;
}

/** The pool as JSON: the data `formatStatus` prints, one reader for both. */
export interface PoolSnapshot extends PoolConfig {
  readonly now: number;
  readonly load: number;
  readonly external: number;
  readonly held: number;
  /** The pool-wide STARVED line, when nothing was granted for `starve_after`. */
  readonly starvedNote?: string;
  readonly locks: readonly string[];
  readonly leases: readonly PoolRow[];
  /** In admission order. */
  readonly waiting: readonly PoolRow[];
}

export function poolSnapshot(view: PoolView, now: number = Date.now()): PoolSnapshot {
  const starvedNote = poolStarvation(view, now);
  const row = (e: PoolEntry): PoolRow => {
    const runs = view.runs[e.id];
    return {
      entry: e,
      request: e.started !== undefined ? describeHeld(e) : describeRequest(e, view.budget),
      ageMs: now - (e.started ?? e.arrived),
      ...(runs !== undefined ? { runs } : {}),
      overrun: e.started !== undefined && overruns(e, view),
      starved: isStarved(e, view, now),
    };
  };
  return {
    now,
    budget: view.budget,
    load_threshold: view.load_threshold,
    starve_after: view.starve_after,
    load: view.load,
    external: view.external,
    held: view.held,
    ...(starvedNote !== undefined ? { starvedNote } : {}),
    locks: view.leases.flatMap(e => e.locks ?? []),
    leases: view.leases.map(row),
    waiting: view.waiting.map(row),
  };
}

/** `wf-run --status` and the `pool_status` tool. */
export function formatStatus(view: PoolView, dir: string, now: number = Date.now()): string {
  const starved = poolStarvation(view, now);
  const home = os.homedir();
  return [
    `pool ${dir}: budget ${view.budget}, held ${view.held}, load ${view.load.toFixed(2)} ` +
      `(external ${view.external.toFixed(1)}, threshold ${view.load_threshold})`,
    ...(starved ? [starved] : []),
    `locks held: ${view.leases.flatMap(e => e.locks ?? []).join(", ") || "none"}`,
    `leases (${view.leases.length}):`,
    ...view.leases.map(e =>
      formatEntry(e, view.budget, now, home, overruns(e, view) ? { runs: view.runs[e.id] } : {}),
    ),
    `waiting (${view.waiting.length}, in admission order):`,
    ...view.waiting.map(e =>
      formatEntry(e, view.budget, now, home, {
        starved: isStarved(e, view, now),
      }),
    ),
  ].join("\n");
}
