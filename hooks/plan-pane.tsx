import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentSeen, DaySpend, FailedLine, FailedSpend, Land, PoolCounts, PoolLine, PoolState, PoolView, QueueLine, QueueView, SessionRow, Snapshot, View } from '../types'
import { age, dayOf, DASHBOARD, endLine, FAILED_DAYS, foldFlipped, handBackLine, LAND_DAYS, landDayToggled, movesLine, PANE_TITLE, paneTree, roleOf, spawnLine, two } from './pane-view'
import type { Move, PaneAction, PaneEl, PaneNode } from './pane-view'

const PANE = 'workflow-plan'
const PERIOD_MS = 15000
/** A state file untouched this long is a finished or abandoned session: not read. */
const STALE_MS = 3 * 24 * 3600 * 1000

// Bump the tag when Snapshot changes shape: a reload then declines the old value.
const snap = atom({ plugin: 'workflow', key: 'snapshot' } as const, null, { shape: 'snap-9' })
const view = atom({ plugin: 'workflow', key: 'view' } as const, 'plan', { shape: 'view-1' })
/** Whether the pane is open: the band above the prompt hides while it is (the pane holds the same and more). */
const paneOpen = atom({ plugin: 'workflow', key: 'paneOpen' } as const, false, { shape: 'pane-open-1' })
/** Agents seen linked to a workflow session, kept after the session ends (its file is removed): the end
 * notification of a driver, worker or reviewer is drawn from this. */
const agentsSeen = atom({ plugin: 'workflow', key: 'agentsSeen' } as const, {}, { shape: 'agents-seen-1' })
/** The last read of the engine's /api/pool, kept only while the pane is open on the Pool tab ('null' otherwise). */
const poolAtom = atom({ plugin: 'workflow', key: 'pool' } as const, null, { shape: 'pool-1' })
/** The pool's `held`/`budget` as of the last refresh with the pane open on any tab: the `Pool <held>/<budget>` tab label (null: not read, or the dashboard did not answer). */
const poolCountsAtom = atom({ plugin: 'workflow', key: 'poolCounts' } as const, null, { shape: 'pool-counts-1' })
/** The Plan tab sections whose fold the person flipped (running, next, lands, failed) and the `+N more` rows whose list the person opened (`next-more`, `waiting-more`, `sessions-more`): none by default, so all sections show but FOLDED_BY_DEFAULT ones, and every capped list stops at its cap. A Landed day holds `+lands-DD.MM` (opened) or `-lands-DD.MM` (folded) instead, since its default moves with the date. */
const folded = atom({ plugin: 'workflow', key: 'folded' } as const, [], { shape: 'folded-2' })
/** The session whose card is open in the Sessions tab ('' none). */
const expanded = atom({ plugin: 'workflow', key: 'expanded' } as const, '', { shape: 'expanded-1' })

const GRAPH_TTL_MS = 5 * 60 * 1000
const RECENT = 6

type Parsed = { mtime: number; row: SessionRow | null; claude: string; queueFile: string }
/** Parsed state files by name, re-read only when the file's mtime moved. */
const cache = new Map<string, Parsed>()
/** workflow → state → where it goes; empty until the dashboard answers. */
let graph = new Map<string, Map<string, string[]>>()
let graphAt = 0

function moves(history: unknown): { from: string; to: string; at: number }[] {
  if (!Array.isArray(history)) return []
  const out: { from: string; to: string; at: number }[] = []
  for (const raw of history) {
    const h = raw as { from?: string; to?: string; at?: string }
    if (h && typeof h.to === 'string' && typeof h.at === 'string') {
      out.push({ from: typeof h.from === 'string' ? h.from : '', to: h.to, at: Date.parse(h.at) })
    }
  }
  return out
}

/** Where a state goes, read off its definition: transitions, exec cases and outcomes, a sub-workflow's ends. */
function exits(st: Record<string, any>): string[] {
  const out: string[] = []
  const to = (label: string, target: unknown) => {
    if (typeof target === 'string') out.push(label === target ? target : `${label}→${target}`)
  }
  for (const [k, v] of Object.entries(st.transitions ?? {})) to(k, v)
  for (const [k, v] of Object.entries(st.cases ?? {})) to(k, v)
  to('*', st.default)
  to('ok', st.on_success)
  to('err', st.on_error)
  to('timeout', st.on_timeout)
  to('exhausted', st.on_exhausted)
  if (typeof st.sub_workflow === 'string') out.push(`⤵ ${st.sub_workflow}`)
  to('done', st.on_complete)
  to('fail', st.on_fail)
  if (st.terminal) out.push(`■ ${typeof st.outcome === 'string' ? st.outcome : 'end'}`)
  return out
}

async function loadGraph($: any, now: number): Promise<void> {
  if (now - graphAt < GRAPH_TTL_MS) return
  graphAt = now
  const res = await $.http.fetch(`${DASHBOARD}/api/workflows`).catch(() => undefined)
  if (!res || !res.ok) return
  const next = new Map<string, Map<string, string[]>>()
  try {
    for (const [name, wf] of Object.entries(JSON.parse(res.text) as Record<string, any>)) {
      const states = new Map<string, string[]>()
      for (const [s, def] of Object.entries((wf?.states ?? {}) as Record<string, any>)) states.set(s, exits(def ?? {}))
      next.set(name, states)
    }
  } catch {
    return
  }
  graph = next
}

function parseSession(text: string): Parsed | null {
  const j = JSON.parse(text) as Record<string, any>
  const stack = Array.isArray(j.stack) ? j.stack : []
  const claude = typeof j.claude_session_id === 'string' ? j.claude_session_id : ''
  const ctx = (j.context ?? {}) as Record<string, unknown>
  const queueFile = !j.parent_session_id && typeof ctx.queue_file === 'string' ? ctx.queue_file : ''
  if (stack.length === 0) return { mtime: 0, row: null, claude, queueFile: '' }
  const frame = stack[j.active_frame ?? 0] ?? stack[stack.length - 1]
  // the queue line a task session runs: slice-pipeline names it `slice`, engine-task and the generic task workflows `task`
  const tag = typeof ctx.slice === 'string' ? ctx.slice : typeof ctx.task === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(ctx.task) ? ctx.task : ''
  const state = String(frame?.current_state ?? '?')
  const done = moves(j.history)
  return {
    mtime: 0,
    claude,
    queueFile,
    row: {
      id: String(j.session_id ?? ''),
      parent: String(j.parent_session_id ?? ''),
      workflow: String(frame?.workflow ?? '?'),
      state,
      tag,
      since: done.at(-1)?.at || Date.parse(String(j.started_at ?? '')) || 0,
      isWorking: Boolean(j.running_exec) || typeof j.agent_id === 'string',
      agent: typeof j.agent_id === 'string' ? j.agent_id : '',
      visit: Number(frame?.state_visits?.[state] ?? 0),
      recent: done.slice(-RECENT),
      next: [],
    },
  }
}

/** One task of the engine's /api/queue answer (describeQueue). */
type ApiLine = { id: string; status: QueueLine['status']; difficulty?: string; mark?: string; model?: string; after?: string; exclusive: boolean; paused: boolean; reason?: string; pickOrder?: number; unblockOrder?: number; admitOrder?: number; priority?: string; lastNote?: string; lastNoteDate?: string; ended?: string }

/** The Plan tab's queue, from the engine's /api/queue answer: the picker's own reasons, no parsing of the file here. */
export function queueView(file: string, api: { batchSize: number; lines: ApiLine[] }, now: number = Date.now()): QueueView {
  const lines: (QueueLine & { reason: string })[] = api.lines.map(l => ({
    id: l.id,
    status: l.status,
    difficulty: l.difficulty ?? '',
    isParked: l.paused,
    isExclusive: l.exclusive,
    isParentRun: /^(—|-)/.test(l.model ?? ''),
    after: (l.after ?? '').split(',').map(a => a.trim()).filter(a => a !== ''),
    priority: l.priority ?? '',
    reason: l.reason ?? '',
  }))
  const order = new Map(api.lines.map(l => [l.id, l.pickOrder ?? 0]))
  const admitOrder = new Map(api.lines.flatMap(l => (l.admitOrder === undefined ? [] : [[l.id, l.admitOrder] as const])))
  const unblockOrder = new Map(api.lines.flatMap(l => (l.unblockOrder === undefined ? [] : [[l.id, l.unblockOrder] as const])))
  // newest first by the day the line ended (else the date of its last note); an undated line after the dated; ties: the later in the file first
  const endOf = (l: ApiLine) => l.ended ?? l.lastNoteDate ?? ''
  // recent = ended within the last FAILED_DAYS days; a line with no `ended` (written before the key) is older
  const since = new Date(now)
  since.setDate(since.getDate() - FAILED_DAYS)
  const cutoff = `${since.getFullYear()}-${two(since.getMonth() + 1)}-${two(since.getDate())}`
  const failedLines: FailedLine[] = api.lines
    .map((l, i) => ({ l, i }))
    .filter(x => x.l.status === 'failed')
    .sort((a, b) => endOf(b.l).localeCompare(endOf(a.l)) || b.i - a.i)
    .map(({ l }) => ({ id: l.id, difficulty: l.difficulty ?? '', date: l.lastNoteDate ?? '', reason: l.lastNote ?? '', recent: l.ended !== undefined && l.ended >= cutoff }))
  const strip = ({ reason: _r, ...l }: QueueLine & { reason: string }): QueueLine => l
  const pending = lines.filter(l => l.status === 'pending')
  return {
    file,
    window: api.batchSize,
    done: lines.filter(l => l.status === 'done').length,
    failed: failedLines.filter(l => l.recent).length,
    pending: pending.length,
    running: lines.filter(l => l.status === 'running').map(strip),
    ready: pending.filter(l => l.reason === 'ready').sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).map(strip),
    unblocked: pending.filter(l => unblockOrder.has(l.id)).sort((a, b) => (unblockOrder.get(a.id) ?? 0) - (unblockOrder.get(b.id) ?? 0)).map(strip),
    // the picker's own visiting order (`admitOrder`: priority, then file order): the top row is the line that goes next once its wait clears
    waiting: pending
      .filter(l => l.reason !== 'ready' && !l.isParked)
      .sort((a, b) => (admitOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (admitOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER))
      .map(l => ({ id: l.id, why: l.reason, difficulty: l.difficulty, priority: l.priority ?? '' })),
    failedLines,
    marks: Object.fromEntries(api.lines.map(l => [l.id, l.mark ?? ' '])),
  }
}

async function loadQueue($: any, file: string, now: number): Promise<{ queue: QueueView | null; error: string; landBranch?: string; taskIds?: string[] }> {
  const res = await $.http.fetch(`${DASHBOARD}/api/queue?file=${encodeURIComponent(file)}`).catch((e: unknown) => String(e))
  if (typeof res === 'string') return { queue: null, error: 'queue: ' + res }
  try {
    const body = JSON.parse(res.text)
    if (!res.ok) return { queue: null, error: 'queue: ' + String(body?.error ?? res.status) }
    return { queue: queueView(file, body, now), error: '', ...(typeof body?.landBranch === 'string' ? { landBranch: body.landBranch } : {}), taskIds: [...(Array.isArray(body?.lines) ? body.lines.map((l: any) => String(l?.id)) : []), ...(Array.isArray(body?.archivedIds) ? body.archivedIds.map(String) : [])] }
  } catch (e) {
    return { queue: null, error: 'queue: ' + String(e) }
  }
}

/** A finished task's run, from the ledger: when its pipeline began and the difficulty it ended at. */
type Run = { start: number; difficulty: string }
let ledgerSeen = ''
const TASK_WORKFLOWS = new Set(['slice-pipeline', 'engine-task'])

/** The task runs of the ledger by queue line id (the latest run of a line wins); rows without `task` are skipped. */
export function ledgerRunsOf(text: string): Map<string, Run> {
  const out = new Map<string, Run>()
  for (const line of text.split('\n')) {
    if (!line.includes('"task"')) continue
    try {
      const j = JSON.parse(line) as Record<string, unknown>
      const start = Date.parse(String(j.started_at ?? ''))
      if (typeof j.task !== 'string' || j.task === '' || !TASK_WORKFLOWS.has(String(j.workflow)) || !Number.isFinite(start)) continue
      const old = out.get(j.task)
      if (!old || old.start < start) out.set(j.task, { start, difficulty: typeof j.difficulty === 'number' ? String(j.difficulty) : '' })
    } catch {
      // a torn or foreign line is not a run
    }
  }
  return out
}

/** What the ledger says of a queue line over every run of it: `usd` is the sum of the runs' real spend, absent when ANY run recorded none (a line is measured whole or not at all, never $0); the latest run's end and how it ended. */
export type TaskSpend = { usd?: number; endedAt: number; outcome: 'landed' | 'closed' | 'failed' | 'unknown' }

/** How a task run ended, as the Cost tab reads it (`costOutcome`): not completed = failed; completed through a `land` state = landed; completed without = closed; no visits recorded = unknown. */
function outcomeOf(j: Record<string, unknown>): TaskSpend['outcome'] {
  if (j.outcome !== 'completed') return 'failed'
  if (!j.visits || typeof j.visits !== 'object') return 'unknown'
  return Object.entries(j.visits).some(([n, v]) => typeof v === 'number' && v > 0 && /(^|_)land$/.test(n)) ? 'landed' : 'closed'
}

/** The spend of the ledger's task runs by queue line id; rows without `task`, of other workflows or with no end are skipped. */
export function ledgerSpendOf(text: string): Map<string, TaskSpend> {
  const acc = new Map<string, { usd: number; isMeasured: boolean; endedAt: number; outcome: TaskSpend['outcome'] }>()
  for (const line of text.split('\n')) {
    if (!line.includes('"task"')) continue
    try {
      const j = JSON.parse(line) as Record<string, unknown>
      const ended = Date.parse(String(j.ended_at ?? ''))
      if (typeof j.task !== 'string' || j.task === '' || !TASK_WORKFLOWS.has(String(j.workflow)) || !Number.isFinite(ended)) continue
      const usd = (j.spend as { usd?: unknown } | undefined)?.usd
      const cur = acc.get(j.task) ?? { usd: 0, isMeasured: true, endedAt: -Infinity, outcome: 'unknown' as const }
      if (typeof usd === 'number' && Number.isFinite(usd)) cur.usd += usd
      else cur.isMeasured = false
      if (ended >= cur.endedAt) {
        cur.endedAt = ended
        cur.outcome = outcomeOf(j)
      }
      acc.set(j.task, cur)
    } catch {
      // a torn or foreign line is not a run
    }
  }
  return new Map([...acc].map(([task, a]) => [task, { ...(a.isMeasured ? { usd: a.usd } : {}), endedAt: a.endedAt, outcome: a.outcome }]))
}

/** One stretch of the parent's own spend, as a task's ledger line records it (`parent_spend`): the end of the stretch, the project directory of the conversation's transcript and its real cost. */
export type ParentSpend = { to: number; project: string; usd: number }

/** The parent's recorded stretches (`parent_spend` of any ledger line; the engine tiles a conversation's time, so a turn is in one). A row with no readable end, project or cost is skipped. */
export function ledgerParentOf(text: string): ParentSpend[] {
  const out: ParentSpend[] = []
  for (const line of text.split('\n')) {
    if (!line.includes('"parent_spend"')) continue
    try {
      const p = (JSON.parse(line) as { parent_spend?: { to?: unknown; project?: unknown; usd?: unknown } }).parent_spend
      const to = Date.parse(String(p?.to ?? ''))
      if (Number.isFinite(to) && typeof p?.project === 'string' && p.project !== '' && typeof p.usd === 'number' && Number.isFinite(p.usd)) out.push({ to, project: p.project, usd: p.usd })
    } catch {
      // a torn or foreign line is not a stretch
    }
  }
  return out
}

/** The name Claude Code gives a repo's project directory under `projects/` (every character but a letter or digit becomes `-`): how a stretch of the parent is matched to the pane's queue repo. */
export function projectDirOf(repo: string): string {
  return repo.replace(/[^A-Za-z0-9]/g, '-')
}

/** A task's latest run that went through a `land` state, of any workflow (a queue's own task workflow is not one of `TASK_WORKFLOWS`): when it began and ended, its difficulty and its own spend. */
export type LedgerLand = { start: number; endedAt: number; difficulty: string; usd?: number }

/** The landed task runs of the ledger by queue line id, whatever the workflow; the latest landed run of a line wins. */
export function ledgerLandedOf(text: string): Map<string, LedgerLand> {
  const out = new Map<string, LedgerLand>()
  for (const line of text.split('\n')) {
    if (!line.includes('"task"')) continue
    try {
      const j = JSON.parse(line) as Record<string, unknown>
      const ended = Date.parse(String(j.ended_at ?? ''))
      if (typeof j.task !== 'string' || j.task === '' || !Number.isFinite(ended) || outcomeOf(j) !== 'landed') continue
      if ((out.get(j.task)?.endedAt ?? -Infinity) > ended) continue
      const usd = (j.spend as { usd?: unknown } | undefined)?.usd
      const start = Date.parse(String(j.started_at ?? ''))
      out.set(j.task, { start: Number.isFinite(start) ? start : NaN, endedAt: ended, difficulty: typeof j.difficulty === 'number' ? String(j.difficulty) : '', ...(typeof usd === 'number' && Number.isFinite(usd) ? { usd } : {}) })
    } catch {
      // a torn or foreign line is not a run
    }
  }
  return out
}

/** What the ledger rows of a queue line add up to: the agents' `spend.usd` and the parent's `parent_spend.usd` (a row records either as absent: it adds 0). */
export type TaskTotals = { usd: number; parentUsd: number }

/** The totals of the ledger's rows by queue line id, over every run of a line and whatever workflow ran it; a row with no `task` is skipped. A row's `spend` already covers its descendant sessions, so a row whose `parent_session_id` is a row of the same task (a recon child of the pipeline) adds only its `parent_spend`. */
export function ledgerTotalsOf(text: string): Map<string, TaskTotals> {
  type Row = { task: string; session: string; parentSession: string; usd: number; parentUsd: number }
  const rows: Row[] = []
  const usdOf = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  for (const line of text.split('\n')) {
    if (!line.includes('"task"')) continue
    try {
      const j = JSON.parse(line) as { task?: unknown; session_id?: unknown; parent_session_id?: unknown; spend?: { usd?: unknown }; parent_spend?: { usd?: unknown } }
      if (typeof j.task !== 'string' || j.task === '') continue
      rows.push({
        task: j.task,
        session: typeof j.session_id === 'string' ? j.session_id : '',
        parentSession: typeof j.parent_session_id === 'string' ? j.parent_session_id : '',
        usd: usdOf(j.spend?.usd),
        parentUsd: usdOf(j.parent_spend?.usd),
      })
    } catch {
      // a torn or foreign line is not a run
    }
  }
  const sessions = new Set(rows.filter(r => r.session !== '').map(r => `${r.task}\n${r.session}`))
  const out = new Map<string, TaskTotals>()
  for (const r of rows) {
    const cur = out.get(r.task) ?? { usd: 0, parentUsd: 0 }
    if (r.parentSession === '' || !sessions.has(`${r.task}\n${r.parentSession}`)) cur.usd += r.usd
    cur.parentUsd += r.parentUsd
    out.set(r.task, cur)
  }
  return out
}

/** The Failed header's spend over the lines it counts: the sum of their ledger totals, and how many have no ledger row. */
export function failedSpend(lines: FailedLine[], totals: Map<string, TaskTotals>): FailedSpend {
  let usd = 0
  let parentUsd = 0
  let missing = 0
  for (const l of lines) {
    const t = totals.get(l.id)
    if (!t) missing++
    else {
      usd += t.usd
      parentUsd += t.parentUsd
    }
  }
  return { usd, parentUsd, missing }
}

type Ledger = { runs: Map<string, Run>; spends: Map<string, TaskSpend>; parent: ParentSpend[]; landed: Map<string, LedgerLand>; totals: Map<string, TaskTotals> }
const NO_LEDGER: Ledger = { runs: new Map(), spends: new Map(), parent: [], landed: new Map(), totals: new Map() }
let ledgerRead: Ledger = NO_LEDGER

/** The ledger's runs and spend, re-read only when the file's size or mtime moved (the pane refreshes often). */
async function ledgerAt($: any, dir: string): Promise<Ledger> {
  const entries = await $.fs.list(dir).catch(() => [])
  // the full ledger outgrows the 4 MiB the plugin API reads; the engine keeps the recent lines in a small file beside it
  const f = entries.find((x: any) => x.name === 'ledger-recent.jsonl') ?? entries.find((x: any) => x.name === 'ledger.jsonl')
  if (!f) return NO_LEDGER
  const stamp = `${f.name}:${f.size}:${f.mtimeMs}`
  if (stamp !== ledgerSeen) {
    const text = String(await $.fs.read(`${dir}/${f.name}`).catch(() => ''))
    ledgerRead = { runs: ledgerRunsOf(text), spends: ledgerSpendOf(text), parent: ledgerParentOf(text), landed: ledgerLandedOf(text), totals: ledgerTotalsOf(text) }
    ledgerSeen = stamp
  }
  return ledgerRead
}

/** `HH:MM` of a start, with its `DD.MM ` when it fell on another day than the land (a run across midnight). */
export function startText(start: number, endAt: string): string {
  const d = new Date(start)
  const day = `${two(d.getDate())}.${two(d.getMonth() + 1)}`
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  return day === endAt.slice(0, 5) ? hm : `${day} ${hm}`
}

/** A land's `DD.MM HH:MM` as a moment: the latest year that does not put it past `now` by more than a day (the log is of the last 14 days, so the year only matters around New Year). */
export function landMs(at: string, now: number): number {
  const m = /^(\d\d)\.(\d\d) (\d\d):(\d\d)/.exec(at)
  if (!m) return 0
  const year = new Date(now).getFullYear()
  const t = new Date(year, Number(m[2]) - 1, Number(m[1]), Number(m[3]), Number(m[4])).getTime()
  return t > now + 24 * 3600 * 1000 ? new Date(year - 1, Number(m[2]) - 1, Number(m[1]), Number(m[3]), Number(m[4])).getTime() : t
}

/** The fold list without the signed keys (`+lands-DD.MM` / `-lands-DD.MM`) of days outside `liveDays`: a key kept past its day would, a year on, fold or open the same DD.MM. An empty `liveDays` (a failed git read) drops nothing. */
export function pruneLandFolds(foldedKeys: string[], liveDays: Set<string>): string[] {
  if (liveDays.size === 0) return foldedKeys
  const gone = (k: string) => {
    const m = /^[+-]lands-(\d\d\.\d\d)$/.exec(k)
    return m !== null && !liveDays.has(m[1]!)
  }
  return foldedKeys.some(gone) ? foldedKeys.filter(k => !gone(k)) : foldedKeys
}

/** The land of a slice that a notification can be about: the lands are newest first, and an agent's land falls within two days of the refresh `at` that last saw it, so rows outside that window are skipped unread and the scan stops at its older edge. The window is anchored on the agent's own time, not the clock's: a notification drawn days later still finds its land. `now` only resolves a row's year. */
export function recentLand(lands: Land[], label: string, at: number, now: number): Land | undefined {
  const day = 24 * 3600 * 1000
  for (const l of lands) {
    const ms = landMs(l.at, now)
    if (ms > at + 2 * day) continue
    if (ms < at - 2 * day) break
    if (l.slice === label) return l
  }
  return undefined
}

/** Each day of the Landed tree: the sum of its landed lines' cost plus the failed and closed lines whose latest run ended that day (a line counts once), how many lines that is and how many were measured. */
export function daySpends(lands: Land[], spends: Map<string, TaskSpend>, now: number = Date.now()): Record<string, DaySpend> {
  const days: Record<string, DaySpend> = {}
  // a day's full date: a label is DD.MM with no year, so a line that ended a year ago on the same DD.MM must not match it
  const dateOf = (ms: number) => {
    const d = new Date(ms)
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  }
  const fullDay = new Map<string, string>()
  for (const l of lands) if (!fullDay.has(l.at.slice(0, 5))) fullDay.set(l.at.slice(0, 5), dateOf(landMs(l.at, now)))
  const counted = new Set<string>()
  const add = (day: string, line: string, usd: number | undefined, kind?: 'failed' | 'closed') => {
    const d = (days[day] ??= { usd: 0, lines: 0, measured: 0, failed: 0, closed: 0 })
    counted.add(line)
    d.lines++
    if (usd !== undefined) {
      d.measured++
      d.usd += usd
    }
    if (kind) d[kind]++
  }
  for (const l of lands) if (!counted.has(l.slice)) add(l.at.slice(0, 5), l.slice, l.usd)
  const landed = new Set(lands.map(l => l.slice))
  for (const [task, sp] of spends) {
    const day = dayOf(sp.endedAt)
    if (landed.has(task) || !days[day] || fullDay.get(day) !== dateOf(sp.endedAt) || (sp.outcome !== 'failed' && sp.outcome !== 'closed')) continue
    add(day, task, sp.usd, sp.outcome)
  }
  return days
}

/** The $ sum of the landed lines of the Landed tree: each line once (a line that landed twice has one cost), a line with no spend row adds nothing; undefined when no line is measured. */
export function landedUsd(lands: Land[]): number | undefined {
  const seen = new Set<string>()
  let sum = 0
  let measured = false
  for (const l of lands) {
    if (seen.has(l.slice)) continue
    seen.add(l.slice)
    if (l.usd === undefined) continue
    sum += l.usd
    measured = true
  }
  return measured ? sum : undefined
}

/** The parent's spend over the Landed window: the stretches of the queue repo's own conversations (`project` is its directory under `projects/`, so another project's session adds nothing) that ended in the last `LAND_DAYS` days; undefined when none is recorded. */
export function parentUsd(parent: ParentSpend[], now: number, project: string): number | undefined {
  const since = now - LAND_DAYS * 24 * 3600 * 1000
  const mine = parent.filter(p => p.to >= since && p.project === project)
  return mine.length > 0 ? mine.reduce((a, p) => a + p.usd, 0) : undefined
}

/** The repo a queue file lives in (`<repo>/.claude/batch/<file>`); the file itself when it is not under one. */
function repoOf(queueFile: string): string {
  return queueFile.replace(/\/\.claude\/batch\/[^/]+$/, '')
}

/** The branch a branch name read from git or a queue header may be: no whitespace or control characters, so a stray answer is never taken for a name. */
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** The branch the queue's lands target: the header's `land_branch:` when set, else the queue repo's checked-out branch, else `main`. */
async function landBranchOf($: any, repo: string, header: string | undefined): Promise<string> {
  const declared = (header ?? '').trim()
  if (BRANCH_RE.test(declared)) return declared
  const cur = await $.process.run(['git', '-C', repo, 'branch', '--show-current'], { timeoutMs: 10000 }).catch(() => undefined)
  const name = cur && cur.exitCode === 0 ? String(cur.stdout).trim() : ''
  return BRANCH_RE.test(name) ? name : 'main'
}

/** The landed task runs of the ledger inside the window that `seen` (the slices git shows) lacks, of the lines of THIS queue (`own`: its lines and its archive; the ledger holds every project's runs) in whatever workflow they ran: a land made before the repo wrote a `Slice:` trailer. They carry no sha. */
function ledgerLands(ledger: Ledger, seen: Set<string>, own: Set<string>, now: number): Land[] {
  const since = now - LAND_DAYS * 24 * 3600 * 1000
  const out: Land[] = []
  for (const [slice, lp] of ledger.landed) {
    if (!own.has(slice) || seen.has(slice) || lp.endedAt < since || lp.endedAt > now + 24 * 3600 * 1000) continue
    const d = new Date(lp.endedAt)
    const at = `${dayOf(lp.endedAt)} ${two(d.getHours())}:${two(d.getMinutes())}`
    const start = ledger.runs.get(slice)?.start ?? lp.start
    const difficulty = ledger.runs.get(slice)?.difficulty ?? lp.difficulty
    const usd = ledger.spends.has(slice) ? ledger.spends.get(slice)?.usd : lp.usd
    out.push({ sha: '—', at, slice, start: Number.isFinite(start) ? startText(start, at) : '?'.padEnd(5), difficulty, ...(usd !== undefined ? { usd } : {}) })
  }
  return out
}

/** The Landed tree's rows, newest first, and the branch they were read from: the commits of the land branch carrying a `Slice:` trailer, then the ledger's landed task runs of the window that git does not show (each slice once). */
async function lands($: any, queueFile: string, ledger: Ledger, header: string | undefined, own: Set<string>, now: number): Promise<{ lands: Land[]; branch: string }> {
  const repo = repoOf(queueFile)
  if (repo === queueFile) return { lands: [], branch: 'main' }
  const branch = await landBranchOf($, repo, header)
  const run = await $.process
    .run(['git', '-C', repo, 'log', `--since=${LAND_DAYS} days ago`, '--first-parent', '-n', '2000',
      '--format=%h%x09%cd%x09%(trailers:key=Slice,valueonly,separator=)', '--date=format:%d.%m %H:%M', branch],
      { timeoutMs: 10000 })
    .catch(() => undefined)
  if (!run || run.exitCode !== 0) return { lands: [], branch }
  const fromGit: Land[] = String(run.stdout)
    .split('\n')
    .map(l => l.split('\t'))
    .filter(p => p.length >= 3 && (p[2] ?? '').trim() !== '')
    .map(p => {
      const slice = (p[2] ?? '').trim()
      const r = ledger.runs.get(slice)
      const usd = ledger.spends.get(slice)?.usd
      const at = p[1] ?? ''
      return { sha: p[0] ?? '', at, slice, start: r ? startText(r.start, at) : '?'.padEnd(5), difficulty: r?.difficulty ?? '', ...(usd !== undefined ? { usd } : {}) }
    })
  const extra = ledgerLands(ledger, new Set(fromGit.map(l => l.slice)), own, now)
  return { lands: extra.length === 0 ? fromGit : [...fromGit, ...extra].sort((a, b) => landMs(b.at, now) - landMs(a.at, now)), branch }
}

/** The Pool tab's data, cut to what the pane draws, from the engine's /api/pool answer (`poolSnapshot`). */
export function poolView(api: any): PoolView {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const line = (r: any): PoolLine => {
    const e = r?.entry ?? {}
    const project = String(e.project ?? e.cwd ?? '')
    return {
      pid: num(e.pid),
      request: String(r?.request ?? ''),
      ageMs: num(r?.ageMs),
      priority: `${num(e.priority)}${e.level ? ` ${String(e.level)}` : ''}`,
      project: project.replace(/\/+$/, '').replace(/^.*\//, ''),
      session: String(e.session_id ?? '').slice(0, 8),
      step: String(e.step ?? ''),
      label: String(e.label ?? '').split('\n')[0] ?? '',
      overrun: r?.overrun ? Math.round(num(r.runs)) : null,
      isStarved: Boolean(r?.starved),
    }
  }
  return {
    budget: num(api?.budget),
    held: num(api?.held),
    load: num(api?.load),
    external: num(api?.external),
    threshold: num(api?.load_threshold),
    starvedNote: typeof api?.starvedNote === 'string' ? api.starvedNote : '',
    locks: Array.isArray(api?.locks) ? api.locks.map(String) : [],
    leases: Array.isArray(api?.leases) ? api.leases.map(line) : [],
    waiting: Array.isArray(api?.waiting) ? api.waiting.map(line) : [],
  }
}

let poolBusy = false

/** One GET /api/pool into the pool atom: the engine measures the pool over a short window, so a call takes about 0.6 s. Only a refresh or a tab press whose open tab is Pool calls it. */
async function loadPool($: any): Promise<void> {
  if (poolBusy) return
  poolBusy = true
  try {
    const res = await $.http.fetch(`${DASHBOARD}/api/pool`).catch(() => undefined)
    const at = await $.clock.now()
    let state: PoolState
    if (!res) state = { at, pool: null, error: `the dashboard at ${DASHBOARD} is not answering` }
    else if (!res.ok) state = { at, pool: null, error: `the dashboard at ${DASHBOARD} answered ${String(res.status)}` }
    else {
      try {
        state = { at, pool: poolView(JSON.parse(res.text)), error: '' }
      } catch {
        state = { at, pool: null, error: `the dashboard at ${DASHBOARD} answered something else than the pool` }
      }
    }
    await update($, poolAtom, () => state)
    await update($, poolCountsAtom, () => (state.pool ? { held: state.pool.held, budget: state.pool.budget } : null))
  } finally {
    poolBusy = false
  }
}

/** One GET /api/pool?counts=1 into the counts atom: the pool's `held` and `budget` with no measuring window, for the tab label. */
async function loadPoolCounts($: any): Promise<void> {
  if (poolBusy) return
  poolBusy = true
  try {
    const res = await $.http.fetch(`${DASHBOARD}/api/pool?counts=1`).catch(() => undefined)
    let counts: PoolCounts | null = null
    if (res?.ok) {
      try {
        const body = JSON.parse(res.text)
        if (typeof body?.held === 'number' && typeof body?.budget === 'number') counts = { held: body.held, budget: body.budget }
      } catch {
        // an answer that is not the counts leaves the label bare
      }
    }
    await update($, poolCountsAtom, () => counts)
  } finally {
    poolBusy = false
  }
}

/** A refresh's pool step, for a queue session with the pane open: the full read on the Pool tab (it also gives the label's counts), the cheap counts read on any other tab; else it drops what an earlier read left. */
async function refreshPool($: any, s: Snapshot): Promise<void> {
  const isOpen = Boolean(s.queue) && (await read($, paneOpen))
  if (isOpen && (await read($, view)) === 'pool') {
    await loadPool($)
    return
  }
  if ((await read($, poolAtom)) !== null) await update($, poolAtom, () => null)
  if (isOpen) await loadPoolCounts($)
  else if ((await read($, poolCountsAtom)) !== null) await update($, poolCountsAtom, () => null)
}

async function build($: any): Promise<Snapshot> {
  const now = await $.clock.now()
  const sid = await $.session.id()
  const home = (await $.env.get('HOME')) ?? ''
  const dir = (await $.env.get('WF_STATE_DIR')) ?? `${home}/.claude/workflow-state`
  await loadGraph($, now)
  const entries = await $.fs.list(dir).catch(() => [])
  const sessions: SessionRow[] = []
  let queueFile = ''
  for (const f of entries) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || now - f.mtimeMs > STALE_MS) continue
    let p = cache.get(f.name)
    if (!p || p.mtime !== f.mtimeMs) {
      const text = await $.fs.read(`${dir}/${f.name}`).catch(() => '')
      let parsed: Parsed | null = null
      try {
        parsed = text === '' ? null : parseSession(text)
      } catch {
        parsed = null
      }
      if (!parsed) continue
      p = { ...parsed, mtime: f.mtimeMs }
      cache.set(f.name, p)
    }
    if (p.claude !== sid || !p.row) continue
    sessions.push({ ...p.row, next: graph.get(p.row.workflow)?.get(p.row.state) ?? [] })
    if (p.queueFile !== '') queueFile = p.queueFile
  }
  const loaded = queueFile !== '' ? await loadQueue($, queueFile, now) : { queue: null, error: '' }
  const ledger = loaded.queue ? await ledgerAt($, dir) : NO_LEDGER
  // a failed line carries what the ledger says it cost
  const queue = loaded.queue && {
    ...loaded.queue,
    failedLines: loaded.queue.failedLines.map(l => {
      const usd = ledger.spends.get(l.id)?.usd
      return usd !== undefined ? { ...l, usd } : l
    }),
    ...(ledger !== NO_LEDGER ? { failedSpend: failedSpend(loaded.queue.failedLines.filter(l => l.recent), ledger.totals) } : {}),
  }
  const read = queue ? await lands($, queueFile, ledger, loaded.landBranch, new Set(loaded.taskIds ?? []), now) : { lands: [], branch: 'main' }
  const landed = read.lands
  const recent = landed.filter(l => landMs(l.at, now) > now - 24 * 3600 * 1000).length
  const landedSum = landedUsd(landed)
  const parentSum = parentUsd(ledger.parent, now, projectDirOf(repoOf(queueFile)))
  return {
    at: now,
    sessions,
    queue,
    lands: landed,
    landBranch: read.branch,
    recent,
    days: daySpends(landed, ledger.spends, now),
    ...(landedSum !== undefined ? { landedUsd: landedSum } : {}),
    ...(parentSum !== undefined ? { parentUsd: parentSum } : {}),
    error: loaded.error,
  }
}

async function refresh($: any): Promise<Snapshot> {
  const s = await build($)
  await update($, snap, () => s)
  // a day's fold key leaves with the day: the folded atom does not grow
  await update($, folded, f => pruneLandFolds(f, new Set(s.lands.map(l => l.at.slice(0, 5)))))
  // remember each linked agent's slice and where it stood: its session file is gone once the pipeline ends
  const seen: Record<string, AgentSeen> = {}
  for (const r of s.sessions) {
    if (r.agent === '') continue
    let top = r
    for (let i = 0; i < 8 && top.tag === '' && top.parent !== ''; i++) top = s.sessions.find(x => x.id === top.parent) ?? top
    seen[r.agent] = { label: top.tag !== '' ? top.tag : r.workflow, role: roleOf(r.workflow), state: r.state, at: s.at }
  }
  if (Object.keys(seen).length > 0) {
    await update($, agentsSeen, old => {
      const merged = { ...old, ...seen }
      // keep the newest 300
      const keys = Object.keys(merged).sort((a, b) => (merged[b]?.at ?? 0) - (merged[a]?.at ?? 0)).slice(0, 300)
      return Object.fromEntries(keys.map(k => [k, merged[k]!]))
    })
  }
  // the status line keeps the engine statusline script compact; the pane holds the detail
  $.ui.status(undefined)
  // last: the pool read (about 0.6 s) delays nothing above; only the caller waits for it
  await refreshPool($, s)
  return s
}

/** Opens the pane, or closes it when it is up; true when it is open after the call. */
async function togglePane($: any): Promise<boolean> {
  const isUp = (await $.ui.panes()).some((p: { id: string }) => p.id === PANE)
  if (isUp) {
    await $.ui.close({ id: PANE })
    return false
  }
  // open before the first refresh: a pane that comes up on the Pool tab reads the pool with it
  await update($, paneOpen, () => true)
  try {
    await refresh($)
    await $.ui.open({ id: PANE, title: PANE_TITLE, backgroundColor: 'transparent' })
  } catch (err) {
    await update($, paneOpen, () => false)
    throw err
  }
  return true
}

/** A tool of this plugin's workflow MCP server (`mcp__plugin_workflow_wf__<op>`). */
function isEngineTool(tool: string): boolean {
  return /^mcp__plugin_workflow_wf__/.test(tool)
}

function engineOp(tool: string): string {
  return tool.replace(/^mcp__plugin_workflow_wf__/, '')
}

/** A tool output as text: a string, an MCP content array, or an object holding one. */
function outputText(o: unknown): string {
  if (typeof o === 'string') return o
  if (Array.isArray(o)) return o.map(outputText).join('\n')
  if (o && typeof o === 'object') {
    const r = o as Record<string, unknown>
    if (typeof r.text === 'string') return r.text
    if (r.content !== undefined) return outputText(r.content)
  }
  return ''
}

/** What an Agent call's own input says about a workflow spawn: `workflow:*` is the plugin's subagent types; the label is the queue line's id of `drive <ID>`, else the description. */
export function spawnOf(input: unknown): { role: string; label: string; model: string } | undefined {
  const i = (input ?? {}) as { subagent_type?: unknown; description?: unknown; model?: unknown }
  const type = typeof i.subagent_type === 'string' ? /^workflow:([A-Za-z0-9_-]+)$/.exec(i.subagent_type)?.[1] : undefined
  if (!type) return undefined
  const description = typeof i.description === 'string' ? i.description.trim() : ''
  return { role: type, label: /^drive (\S+)$/.exec(description)?.[1] ?? (description !== '' ? description : type), model: typeof i.model === 'string' ? i.model : '' }
}

/** The id of the agent an Agent call launched: the stored result's `agentId` (an object), else the `agentId:` line of a text reply. */
export function agentIdOf(output: unknown): string | undefined {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const id = (output as { agentId?: unknown }).agentId
    if (typeof id === 'string' && id !== '') return id
  }
  return /agentId: ([A-Za-z0-9]+)/.exec(outputText(output))?.[1]
}

/** The model an agent runs on, as the harness names it (`claude-haiku-5-5` is `haiku 5.5`); the call's own alias until the result says. */
export function modelOf(output: unknown, alias = ''): string {
  const r = output && typeof output === 'object' ? (output as { resolvedModel?: unknown }).resolvedModel : undefined
  if (typeof r !== 'string' || r === '') return alias
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(r)
  return m ? `${m[1]} ${m[2]}.${m[3]}` : r
}

/** The state a `transition` / `start` reply names: the `← ACTIVE` frame when a stack is printed, else the flat `<workflow> @ <state>` line or the one-line `SESSION: <id> @ <state>` of `start({ reply: "id" })`. */
export function movedTo(o: unknown): string | undefined {
  const t = outputText(o)
  const frame = /^\s*\[\d+\]\s+[A-Za-z0-9_.-]+ @ ([A-Za-z0-9_.-]+)[^\n]*←\s*ACTIVE/m.exec(t)
  if (frame) return frame[1]
  return /^(?:SESSION: )?([A-Za-z0-9_.-]+) @ ([A-Za-z0-9_.-]+)/m.exec(t)?.[2]
}

/** Opens the Pool tab and reads the pool at once (the next refresh keeps it fresh while the tab stays open). */
async function openPool($: any): Promise<void> {
  await update($, view, () => 'pool')
  await loadPool($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'wf-plan', description: 'Toggle the workflow plan pane (running pipelines, next lines, lands)' })
    await $.command.register({ name: 'wf-map', description: "Print the live workflow map's URL (the engine's dashboard)" })
    void refresh($)
    $.clock.every(PERIOD_MS, () => void refresh($))
    // a reload keeps an open pane: the band follows the engine's record, not the module's memory
    const isUp = (await $.ui.panes()).some((p: { id: string }) => p.id === PANE)
    await update($, paneOpen, () => isUp)
    return next(e)
  })

  // however the pane closes (the command, Esc, its mark, an unload), the band comes back
  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) await update($, paneOpen, () => false)
    return closed
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('command.run', { command: 'wf-plan' }, async $ => {
    const isOpen = await togglePane($)
    return { text: isOpen ? 'Plan pane opened (refreshes every 15 s; /wf-plan again closes it).' : 'Plan pane closed.' }
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'wf-plan failed: see the debug log' }))

  on('command.run', { command: 'wf-map' }, async () => ({ text: `${DASHBOARD}/map` }))

  // The band above the prompt is the status line: the root session (◆ with children) and the others' count, the
  // queue's running/next/landed, and a button that toggles the pane. Nothing when this session runs no workflow.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const s = await read($, snap)
    if (!s || s.sessions.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    // an agent's transcript in view: the band shows that agent's workflow session (linked by link_agent)
    const viewed = e.props.view?.agentId
    if (viewed) {
      const r = s.sessions.find(x => x.agent === viewed)
      if (!r) return next(e)
      let leaf = r
      for (let i = 0; i < 8; i++) {
        const child = s.sessions.find(c => c.parent === leaf.id)
        if (!child) break
        leaf = child
      }
      const now = await $.clock.now()
      return (
        <Text>
          <Text color="cyan">[{r.tag !== '' ? r.tag : r.workflow}] </Text>
          {r.workflow} @ <Text weight="bold">{r.state}</Text>
          {leaf.id !== r.id ? <Text> › {leaf.workflow} @ <Text weight="bold">{leaf.state}</Text></Text> : null}
          <Text dimColor> {age(now - leaf.since)} · {r.id}</Text>
        </Text>
      )
    }
    if (await read($, paneOpen)) return next(e)
    const ids = new Set(s.sessions.map(r => r.id))
    const roots = s.sessions.filter(r => r.parent === '' || !ids.has(r.parent))
    const hasChildren = (r: SessionRow) => s.sessions.some(c => c.parent === r.id)
    const main = roots.find(hasChildren) ?? roots[0] ?? s.sessions[0]!
    const others = s.sessions.length - 1
    const q = s.queue
    return (
      <Box flexDirection="row" gap={2}>
        <Text>
          {hasChildren(main) ? <Text color="cyanBright" weight="bold">◆ </Text> : <Text color={main.isWorking ? 'cyanBright' : 'cyan'}>⚙ </Text>}
          {main.workflow}:{main.state}
          {others > 0 ? <Text color="cyan"> ({others})</Text> : null}
        </Text>
        {q ? (
          <Text dimColor>
            ▶ {q.running.length}/{q.window} · ⏭ {q.ready.length} · ✓ {s.recent}
          </Text>
        ) : null}
        <Button key="band-plan" hotkey="p" plain onPress={() => void togglePane($)}>
          <Text color="cyan">[plan]</Text>
        </Button>
      </Box>
    )
  })

  // The turn's closing "Waiting for N background agents to finish" names what it waits on: each agent linked to a
  // workflow session (link_agent) as its slice and where its pipeline stands; agents of no session stay counted.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    const waiting = e.props.waitingFor
    if (!waiting || e.props.isExpanded || waiting.agents.length === 0) return next(e)
    const s = await read($, snap)
    if (!s) return next(e)
    const byAgent = new Map(s.sessions.filter(r => r.agent !== '').map(r => [r.agent, r]))
    // one entry per slice: a driver and its worker are two agents of one pipeline
    const bySlice = new Map<string, { state: string; agents: number }>()
    let others = 0
    for (const a of waiting.agents) {
      const r = byAgent.get(a.id)
      if (!r) {
        others++
        continue
      }
      // the pipeline that holds this agent's session: its slice, and the deepest state under it
      let top = r
      for (let i = 0; i < 8 && top.tag === '' && top.parent !== ''; i++) top = s.sessions.find(x => x.id === top.parent) ?? top
      let leaf = top
      for (let i = 0; i < 8; i++) {
        const child = s.sessions.find(c => c.parent === leaf.id)
        if (!child) break
        leaf = child
      }
      const label = top.tag !== '' ? top.tag : r.workflow
      const seen = bySlice.get(label)
      bySlice.set(label, { state: leaf.state, agents: (seen?.agents ?? 0) + 1 })
    }
    if (bySlice.size === 0) return next(e)
    const { Text } = $.ui.resolve(e)
    const SHOW = 4
    const slices = [...bySlice]
    const total = waiting.agents.length + waiting.workflows
    const hidden = slices.length - Math.min(slices.length, SHOW)
    const rest = [
      hidden > 0 ? `+${hidden} ${hidden === 1 ? 'slice' : 'slices'}` : '',
      others > 0 ? `+${others} without a session` : '',
      waiting.workflows > 0 ? `+${waiting.workflows} workflow${waiting.workflows === 1 ? '' : 's'}` : '',
    ].filter(x => x !== '')
    return (
      <Text>
        <Text color="cyan">⧗ </Text>
        <Text dimColor>{slices.length} {slices.length === 1 ? 'slice' : 'slices'} · {total} {total === 1 ? 'agent' : 'agents'}: </Text>
        {slices.slice(0, SHOW).map(([label, v], i) => (
          <Text>
            {i > 0 ? <Text dimColor> · </Text> : null}
            <Text color="cyan">{label}</Text> <Text dimColor>{v.state}{v.agents > 1 ? ` ×${v.agents}` : ''}</Text>
          </Text>
        ))}
        {rest.length > 0 ? <Text dimColor> · {rest.join(' · ')}</Text> : null}
      </Text>
    )
  })

  // A background agent's end notification, for an agent of a workflow pipeline: its slice, role and run time, and
  // how it ended — stopped by hand or failed (red, with the step), landed (the commit), or the step it ended at.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const task = e.props.task
    if (e.props.origin.kind !== 'task-notification' || !task?.id || e.props.isExpanded) return next(e)
    const seen = (await read($, agentsSeen))[task.id]
    if (!seen) return next(e)
    const s = await read($, snap)
    const ui = $.ui.resolve(e)
    const land = recentLand(s?.lands ?? [], seen.label, seen.at, await $.clock.now())
    const dur = task.durationMs !== undefined ? age(task.durationMs) || '<1m' : ''
    const end =
      task.status === 'killed' || task.status === 'failed' ? { kind: task.status, state: seen.state } as const
      : land && seen.role === 'driver' ? { kind: 'landed', sha: land.sha } as const
      : { kind: 'ended', state: seen.state } as const
    return draw(endLine(seen.label, seen.role, dur, end), ui, $)
  })

  // An Agent call of a workflow pipeline draws as ONE line in the style of the engine-call group's line (`⚙ [slice] …`),
  // in the place of the harness's row: role, the queue line's id, model, where the pipeline stands (the deepest state
  // under it), its age and the lane link. Before the session is linked the line is read off the call's own input
  // (`workflow:*` subagent type, description); once it ended, off the agent kept in `agentsSeen`. A call of no workflow,
  // an expanded row (ctrl+o) and a failed or interrupted spawn keep the harness's row. The call's input is never
  // rewritten, only drawn. The harness folds only reads, searches and listings into a ToolGroup, so a spawn cannot join
  // the group's line: it is the next line, drawn alike.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== 'Agent' || e.props.isExpanded || e.props.isErrored || e.props.isInterrupted) return next(e)
    const spawn = spawnOf(e.props.input)
    const id = agentIdOf(e.props.output)
    const s = await read($, snap)
    const live = id !== undefined ? s?.sessions.find(r => r.agent === id) : undefined
    const seen = id !== undefined && !live ? (await read($, agentsSeen))[id] : undefined
    const { Text, Link } = $.ui.resolve(e)
    const model = modelOf(e.props.output, spawn?.model)
    const modelText = model !== '' ? <Text dimColor> · {model}</Text> : null
    if (live && s) {
      let top = live
      for (let i = 0; i < 8 && top.tag === '' && top.parent !== ''; i++) top = s.sessions.find(x => x.id === top.parent) ?? top
      let leaf = live
      for (let i = 0; i < 8; i++) {
        const child = s.sessions.find(c => c.parent === leaf.id)
        if (!child) break
        leaf = child
      }
      const now = await $.clock.now()
      return (
        <Text>
          <Text color="cyan">⚙ [{top.tag !== '' ? top.tag : live.workflow}] </Text>
          <Text dimColor>{spawn?.role ?? roleOf(live.workflow)}</Text>
          {modelText}
          <Text dimColor> · </Text>
          {live.workflow} @ <Text weight="bold">{live.state}</Text>
          {leaf.id !== live.id ? <Text> › {roleOf(leaf.workflow)} @ <Text weight="bold">{leaf.state}</Text></Text> : null}
          <Text dimColor> {age(now - leaf.since)} </Text>
          <Link href={`${DASHBOARD}/map/${encodeURIComponent(top.id)}`} label="lane ↗" />
        </Text>
      )
    }
    if (seen) {
      const land = s?.lands.find(l => l.slice === seen.label)
      return (
        <Text>
          <Text color="cyan">⚙ [{seen.label}] </Text>
          <Text dimColor>{spawn?.role ?? seen.role}</Text>
          {modelText}
          <Text dimColor> · </Text>
          {land && seen.role === 'driver' ? <Text color="green">✓ landed {land.sha}</Text> : <Text dimColor>ended at {seen.state}</Text>}
        </Text>
      )
    }
    if (!spawn) return next(e)
    return draw(spawnLine(spawn.label, spawn.role, model), $.ui.resolve(e), $)
  })

  // A driver's one-line hand-back (another session's message) drawn by its outcome. Only when ALL hold: the row is a
  // peer message; its whole text is ONE line in the exact protocol shape (LANDED <sha> slice=|task=<ID> …,
  // NEEDS-PARENT slice=|task=<ID> …, WAITING slice=|task=<ID> …); and that ID is a slice this session knows (running in
  // the queue, landed in the last 14 days, or an agent seen on it). Anything else draws as the engine draws it.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind !== 'peer' || e.props.isExpanded) return next(e)
    const text = e.props.text.trim()
    if (text.includes('\n')) return next(e)
    const landed = /^LANDED ([0-9a-f]{7,40}) (?:slice|task)=([A-Za-z0-9][A-Za-z0-9-]*)(?: .*)?$/.exec(text)
    const needs = /^NEEDS-PARENT (?:slice|task)=([A-Za-z0-9][A-Za-z0-9-]*) .*?reason=(.+?)(?: see=\S+)?$/.exec(text)
    const waits = /^WAITING (?:slice|task)=([A-Za-z0-9][A-Za-z0-9-]*)(?: .*)?$/.exec(text)
    const id = landed?.[2] ?? needs?.[1] ?? waits?.[1]
    if (!id) return next(e)
    const s = await read($, snap)
    const seen = await read($, agentsSeen)
    const known =
      (s?.queue?.running.some(l => l.id === id) ?? false) ||
      (s?.lands.some(l => l.slice === id) ?? false) ||
      Object.values(seen).some(a => a.label === id)
    if (!known) return next(e)
    const back = landed ? { kind: 'landed', sha: landed[1] ?? '' } as const : needs ? { kind: 'needs', reason: needs[2] ?? '' } as const : { kind: 'waiting' } as const
    return draw(handBackLine(id, back), $.ui.resolve(e), $)
  })

  // A collapsed group of tool calls that holds workflow-engine calls draws as the chain of moves they made
  // (`[slice] transition→state …`) instead of "Called plugin:workflow:wf N times"; other tools keep a count.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || e.props.isCallsOnly === false) return next(e)
    const calls = e.props.calls
    const wf = calls.filter(c => isEngineTool(c.tool))
    if (wf.length === 0) return next(e)
    const s = await read($, snap)
    const label = (sid: string) => {
      const r = s?.sessions.find(x => x.id === sid)
      return r ? (r.tag !== '' ? r.tag : r.workflow) : sid.slice(0, 8)
    }
    const moves: Move[] = []
    let lastSid = ''
    // the other engine calls by what they did: plan changes (queue_*), context writes, and the rest (reads, links)
    const ICON: Record<string, string> = {
      queue_add: '☰+', queue_edit: '☰✎', queue_mark: '☰✓', queue_next: '☰▶', queue_header: '☰⇅', context_set: '✎',
    }
    const counted = new Map<string, number>()
    for (const c of wf) {
      const op = engineOp(c.tool)
      const input = (c.input ?? {}) as Record<string, unknown>
      const sid = typeof input.session_id === 'string' ? input.session_id : ''
      if (op === 'transition' || op === 'start') {
        const to = movedTo(c.output)
        const name = op === 'start' ? `start ${String(input.workflow ?? '')}` : String(input.transition ?? '?')
        moves.push({ ...(sid !== '' && sid !== lastSid ? { label: label(sid) } : {}), name, to: c.isRunning ? '…' : to ?? '?', isErrored: Boolean(c.isErrored) })
        lastSid = sid
      } else {
        const icon = ICON[op] ?? '·'
        counted.set(icon, (counted.get(icon) ?? 0) + 1)
      }
    }
    const otherTools = new Map<string, number>()
    for (const c of calls) {
      if (isEngineTool(c.tool)) continue
      const k = c.tool === 'Bash' ? '❯' : c.tool.toLowerCase() + ' '
      otherTools.set(k, (otherTools.get(k) ?? 0) + 1)
    }
    // ☰± plan changes, ✎ context writes, · other engine calls, ❯ shell, any other tool by its name
    const tail = [
      ...[...counted].map(([icon, n]) => `${icon}${n}`),
      ...[...otherTools].map(([k, n]) => `${k}${n}`),
    ].filter(x => x !== '')
    return draw(movesLine(moves, tail), $.ui.resolve(e), $)
  })

  // What the pane shows is hooks/pane-view.ts's `paneTree` (pure, shared with the documentation site's scene); this
  // hook gathers its input from the atoms and draws the tree with this surface's elements.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const s = await read($, snap)
    const tab: View = s?.queue ? ((await read($, view)) ?? 'plan') : 'sessions'
    const tree = paneTree({
      snapshot: s,
      tab,
      expanded: (await read($, expanded)) ?? '',
      folded: (await read($, folded)) ?? [],
      now: await $.clock.now(),
      columns: e.props?.bodyColumns ?? 100,
      rows: e.viewport?.rows ?? 30,
      poolCounts: (await read($, poolCountsAtom)) as PoolCounts | null,
      // the pool atom is read only on the Pool tab: a read subscribes the pane to it
      pool: tab === 'pool' ? ((await read($, poolAtom)) as PoolState | null) : null,
    })
    return draw(tree, ui, $)
  })
}

/** What a press on the pane's button does: the fold, tab and card state lives in this mod's atoms. */
function act($: any, a: PaneAction): Promise<unknown> {
  switch (a.kind) {
    case 'fold':
      return update($, folded, f => foldFlipped(f, a.key))
    case 'landDay':
      return update($, folded, f => landDayToggled(f, a.key, a.today))
    case 'tab':
      return a.id === 'pool' ? openPool($) : update($, view, () => a.id)
    case 'expand':
      return update($, expanded, cur => (cur === a.id ? '' : a.id))
  }
}

/** A tree of hooks/pane-view.ts drawn with the surface's own elements (`$.ui.resolve(e)`). */
function draw(n: PaneNode, ui: { Box: any; Text: any; Button: any; Link: any }, $: any): any {
  if (n === null) return null
  if (typeof n === 'string') return n
  if (Array.isArray(n)) return n.map(c => draw(c, ui, $))
  const el = n as PaneEl
  const { Box, Text, Button, Link } = ui
  switch (el.el) {
    case 'link':
      return <Link href={el.href} label={el.label} />
    case 'text':
      return <Text {...el.props}>{el.children.map(c => draw(c, ui, $))}</Text>
    case 'box':
      return el.key !== undefined
        ? <Box key={el.key} {...el.props}>{el.children.map(c => draw(c, ui, $))}</Box>
        : <Box {...el.props}>{el.children.map(c => draw(c, ui, $))}</Box>
    case 'button':
      return el.hotkey !== undefined
        ? <Button key={el.key} hotkey={el.hotkey} plain onPress={() => void act($, el.action)}>{el.children.map(c => draw(c, ui, $))}</Button>
        : <Button key={el.key} plain onPress={() => void act($, el.action)}>{el.children.map(c => draw(c, ui, $))}</Button>
  }
}
