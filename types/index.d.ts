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
}

/** One queue task, as the engine's dashboard answers it (/api/queue). */
export type QueueLine = {
  id: string
  status: 'pending' | 'running' | 'done' | 'failed' | 'backlog'
  difficulty: string
  isParked: boolean
  isExclusive: boolean
  /** `model: —`: the parent runs it by hand, the picker never admits it */
  isParentRun: boolean
  after: string[]
  /** urgent / high / low; absent = normal */
  priority?: string
}

/** A `failed` queue line: its reason is the first line of its last note (`''` none), its date that note's (`''` unknown). */
export type FailedLine = { id: string; difficulty: string; date: string; reason: string }

export type QueueView = {
  file: string
  window: number
  done: number
  failed: number
  pending: number
  running: QueueLine[]
  /** pending tasks the picker would admit with the window ignored (file order) */
  ready: QueueLine[]
  /** pending tasks waiting (not parked), with the picker's own reason */
  waiting: { id: string; why: string; difficulty: string }[]
  /** every failed line, newest first (an undated one after the dated, the later in the file first) */
  failedLines: FailedLine[]
  /** every queue line's kind glyph by id (`kindMark`, from /api/queue), drawn right after the difficulty bar; absent id = blank */
  marks: Record<string, string>
}

/** A landed line: `start` is the pipeline's start (`HH:MM`, `?` when the ledger has none), `difficulty` its final score ('' unknown). */
export type Land = { sha: string; slice: string; at: string; start: string; difficulty: string }

/** An agent seen linked to a workflow session: its slice (or workflow), role and last step. */
export type AgentSeen = { label: string; role: string; state: string; at: number }

/** The pane's tab. */
export type View = 'plan' | 'sessions' | 'waiting'

export type Snapshot = {
  at: number
  sessions: SessionRow[]
  queue: QueueView | null
  lands: Land[]
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'workflow': { snapshot: Shaped<Snapshot | null>; view: Shaped<View>; expanded: Shaped<string>; folded: Shaped<string[]>; paneOpen: Shaped<boolean>; agentsSeen: Shaped<Record<string, AgentSeen>> }
  }
}
