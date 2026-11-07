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
  /** how many times the session has entered its current state */
  visit: number
  /** the last moves, oldest first */
  recent: { from: string; to: string; at: number }[]
  /** where the current state can go, from the workflow's graph (`name→target`, exec `code→target`); empty unknown */
  next: string[]
}

/** One queue line, parsed from the queue file. */
export type QueueLine = {
  id: string
  mark: ' ' | '>' | 'x' | '!'
  difficulty: string
  isParked: boolean
  isExclusive: boolean
  /** `model: —`: the parent runs it by hand, the picker never admits it */
  isParentRun: boolean
  after: string[]
}

export type QueueView = {
  file: string
  window: number
  done: number
  failed: number
  pending: number
  running: QueueLine[]
  /** pending lines whose `after:` are all done, not parked: what the picker can take next (file order) */
  ready: QueueLine[]
  /** pending lines waiting, with why */
  waiting: { id: string; why: string; difficulty: string }[]
}

export type Land = { sha: string; slice: string; at: string }

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
    'workflow': { snapshot: Shaped<Snapshot | null>; view: Shaped<View>; expanded: Shaped<string>; folded: Shaped<string[]> }
  }
}
