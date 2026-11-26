/** One workflow session of this Claude Code session, as the engine's state file holds it. */
export type SessionRow = {
  id: string
  parent: string
  workflow: string
  state: string
  tag: string
  /** ms since the epoch of the last history entry: when it entered (or last moved in) its state */
  since: number
  isWorking: boolean
  /** the Agent id linked to the session (link_agent), '' none */
  agent: string
  /** how many times the session has entered its current state */
  visit: number
  /** the last moves, oldest first */
  recent: { from: string; to: string; at: number }[]
  /** where the current state can go, from the workflow's graph (`name→target`, exec `code→target`); empty unknown */
  next: string[]
  /** what the linked agent is: `driver` (the session's workflow declares a `driver:` block), else the stage its parent's step spawned it on; absent: the pane names it by its workflow */
  role?: string
  /** the model the workflow's agent runs on, from the workflow's `driver:` block of the dashboard's /api/workflows; absent: the workflow declares none, or the dashboard did not answer */
  model?: string
  /** ms since the epoch of the last `link_agent` of the session; absent: none */
  agentAt?: number
  /** the exec in flight (`running_exec`): its state, when it began, and the command and timeout the workflow's definition gives that state ('' and 0 until the dashboard answers), and `waitMs`, the pool wait the engine has counted against its deadline (the run's `.wait` file; absent: none) */
  exec?: { state: string; since: number; command: string; timeoutMs: number; waitMs?: number }
  /** the last exec the session finished: its state, exit code, run time and when it ended; absent: none yet */
  lastExec?: { state: string; code: number; ms: number; at: number }
}

/** One queue task, as the engine's dashboard answers it (/api/queue). */
export type QueueLine = {
  id: string
  status: 'pending' | 'running' | 'awaiting' | 'done' | 'failed' | 'backlog'
  difficulty: string
  isParked: boolean
  isExclusive: boolean
  /** `model: —`: the parent runs it by hand, the picker never admits it */
  isParentRun: boolean
  after: string[]
  /** urgent / high / low; absent = normal */
  priority?: string
  /** a `unblocked` row only: what keeps the line from starting, as the picker words it (`waits: <id> (overlap)`, `after: <id> (running)`); absent: nothing, the line is next to admit */
  wait?: string
}

/** An `awaiting` queue line: its task waits for the owner's answer at a human wait state, its window slot free. `since` is ms since the epoch; `answered` (the route) once the owner answered: it resumes before any Next line. */
export type AwaitingLine = { id: string; difficulty: string; priority: string; session: string; question: string; show: string[]; since: number; answered?: string }

/** A `failed` queue line: `recent` = it ended within the last two days (queue_mark's `ended`; a line with none is older), its reason is the first line of its last note (`''` none), its date that note's (`''` unknown), `usd` the ledger's real spend over every run of the line (absent: not measured); `usdFloor` stands in when a run recorded only a partial sum (an agent unmeasured): a lower bound drawn `≥$x`, never added to a total. */
export type FailedLine = { id: string; difficulty: string; date: string; reason: string; recent: boolean; usd?: number; usdFloor?: number }

/** The Failed header's spend over the lines it counts (the recent ones): the ledger's agent `usd` and parent `parentUsd` summed over every run of each line, and how many of those lines have no ledger row (they add 0) and, when any, how many have a run with no recorded spend (left out of the sums). */
export type FailedSpend = { usd: number; parentUsd: number; missing: number; unmeasured?: number }

export type QueueView = {
  file: string
  window: number
  done: number
  /** failed lines that ended within the last two days */
  failed: number
  pending: number
  running: QueueLine[]
  /** the lines waiting for the owner's answer (`awaiting`), the oldest wait first */
  awaiting: AwaitingLine[]
  /** pending tasks the picker would admit with the window ignored (file order) */
  ready: QueueLine[]
  /** while `ready` is empty: the pending lines kept out only by the running ones, in the order the picker admits them once those end (the picker's own pass with the running lines done); `[]` otherwise */
  unblocked: QueueLine[]
  /** pending tasks waiting (not parked), with the picker's own reason */
  waiting: { id: string; why: string; difficulty: string; priority: string }[]
  /** every failed line, newest first by the day it ended (an undated one after the dated, the later in the file first); `recent` marks the ones the pane draws before `+N older` */
  failedLines: FailedLine[]
  /** the ledger's spend over the recent failed lines, for the header; absent until the pane has read the ledger */
  failedSpend?: FailedSpend
  /** every queue line's kind glyph by id (`kindMark`, from /api/queue), drawn right after the difficulty bar; absent id = blank */
  marks: Record<string, string>
}

/** A landed line: `start` is the pipeline's start (`HH:MM`, `?` when the ledger has none), `difficulty` its final score ('' unknown), `usd` the ledger's real spend over every run of the line (absent: not measured, never $0); `usdFloor` stands in when a run recorded only a partial sum (an agent unmeasured): a lower bound drawn `≥$x`, never added to a total. */
export type Land = { sha: string; slice: string; at: string; start: string; difficulty: string; usd?: number; usdFloor?: number }

/** One day of the Landed tree (`DD.MM`): the sum of the measured lines' `usd` over its landed lines and the failed and closed lines that ended that day, how many lines the sum covers, and how many of them were measured. */
export type DaySpend = { usd: number; lines: number; measured: number; failed: number; closed: number }

/** An agent seen linked to a workflow session: its slice (or workflow), role and last step. */
export type AgentSeen = { label: string; role: string; state: string; at: number }

/** One lease or waiter of the pool, cut to what the pane draws (the engine's /api/pool `PoolRow`). */
export type PoolLine = {
  pid: number
  /** what it holds (a lease) or wants (a waiter), as `pool_status` prints it */
  request: string
  /** ms held (a lease) or queued (a waiter), as of the read; negative: not known */
  ageMs: number
  /** `3` or `3 normal`; '' not known */
  priority: string
  /** the project directory's last name, '' none */
  project: string
  /** the first 8 characters of the session id, '' none */
  session: string
  step: string
  /** the first line of the label */
  label: string
  /** a lease whose processes run well above its threads: the busy cpus it runs, else null */
  overrun: number | null
  /** a lease whose processes have run well below its threads for 30 s (the pool's UNDERUSE): the busy cpus it runs, else null */
  underuse: number | null
  isStarved: boolean
  /** a lease's approximate time left or its overrun of the typical time, as `pool_status` prints it (`~45m left (typ. 3h35m, 5 runs)`); '' none */
  eta: string
}

/** The machine-wide pool as the Pool tab draws it. */
export type PoolView = {
  budget: number
  held: number
  load: number
  external: number
  threshold: number
  /** the pool-wide STARVED line, '' none */
  starvedNote: string
  locks: string[]
  leases: PoolLine[]
  /** in admission order */
  waiting: PoolLine[]
}

/** What the last read of /api/pool left: the pool and when it was read, or why there is none ('' none). */
export type PoolState = { at: number; pool: PoolView | null; error: string }

/** The pool's `held` threads of its `budget`, from `GET /api/pool?counts=1`. */
export type PoolCounts = { held: number; budget: number }

/** The pane's tab. */
export type View = 'plan' | 'sessions' | 'waiting' | 'pool'

export type Snapshot = {
  at: number
  sessions: SessionRow[]
  queue: QueueView | null
  lands: Land[]
  /** the branch `lands` was read from (the queue header's `land_branch:`, else the queue repo's checked-out branch, else `main`) */
  landBranch?: string
  /** the lands of the last 24 hours (`lands` holds the 14 days the tree shows) */
  recent: number
  /** per `DD.MM` of `lands`: the day's spend */
  days: Record<string, DaySpend>
  /** the $ sum of the landed lines of `lands` (each line once; a line with no spend adds nothing); absent when none is measured */
  landedUsd?: number
  /** the parent's own spend recorded in the last 14 days in the queue repo's project (ledger `parent_spend`); absent when none is recorded */
  parentUsd?: number
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'workflow': { snapshot: Shaped<Snapshot | null>; view: Shaped<View>; expanded: Shaped<string>; folded: Shaped<string[]>; paneOpen: Shaped<boolean>; agentsSeen: Shaped<Record<string, AgentSeen>>; pool: Shaped<PoolState | null>; poolCounts: Shaped<PoolCounts | null> }
  }
}
