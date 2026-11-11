import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentSeen, DaySpend, FailedLine, Land, PoolLine, PoolState, PoolView, QueueLine, QueueView, SessionRow, Snapshot, View } from '../types'

const PANE = 'workflow-plan'
const PERIOD_MS = 15000
/** A state file untouched this long is a finished or abandoned session: not read. */
const STALE_MS = 3 * 24 * 3600 * 1000

// Bump the tag when Snapshot changes shape: a reload then declines the old value.
const snap = atom({ plugin: 'workflow', key: 'snapshot' } as const, null, { shape: 'snap-7' })
const view = atom({ plugin: 'workflow', key: 'view' } as const, 'plan', { shape: 'view-1' })
/** Whether the pane is open: the band above the prompt hides while it is (the pane holds the same and more). */
const paneOpen = atom({ plugin: 'workflow', key: 'paneOpen' } as const, false, { shape: 'pane-open-1' })
/** Agents seen linked to a workflow session, kept after the session ends (its file is removed): the end
 * notification of a driver, worker or reviewer is drawn from this. */
const agentsSeen = atom({ plugin: 'workflow', key: 'agentsSeen' } as const, {}, { shape: 'agents-seen-1' })
/** The last read of the engine's /api/pool, kept only while the pane is open on the Pool tab ('null' otherwise). */
const poolAtom = atom({ plugin: 'workflow', key: 'pool' } as const, null, { shape: 'pool-1' })
/** The Plan tab sections whose fold the person flipped (running, next, lands, failed): none by default, so all sections show but FOLDED_BY_DEFAULT ones. A Landed day holds `+lands-DD.MM` (opened) or `-lands-DD.MM` (folded) instead, since its default moves with the date. */
const folded = atom({ plugin: 'workflow', key: 'folded' } as const, [], { shape: 'folded-2' })
/** Sections that start folded: a click on one unfolds it. A day of the Landed tree other than today starts folded too (`lands-DD.MM`). */
const FOLDED_BY_DEFAULT = new Set(['failed', 'failed-older'])
/** How far back the Landed tree goes: the Cost tab's own range. */
const LAND_DAYS = 14
/** The session whose card is open in the Sessions tab ('' none). */
const expanded = atom({ plugin: 'workflow', key: 'expanded' } as const, '', { shape: 'expanded-1' })

/** The engine's own dashboard: its API answers the workflow graphs, its page draws one session's graph. */
const DASHBOARD = 'http://127.0.0.1:3100'
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

/** The Failed section lists the lines that ended within this many days; the rest fold under `+N older`. */
const FAILED_DAYS = 2

/** One task of the engine's /api/queue answer (describeQueue). */
type ApiLine = { id: string; status: QueueLine['status']; difficulty?: string; mark?: string; model?: string; after?: string; exclusive: boolean; paused: boolean; reason?: string; pickOrder?: number; priority?: string; lastNote?: string; lastNoteDate?: string; ended?: string }

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
    waiting: pending
      .filter(l => l.reason !== 'ready' && !l.isParked)
      .map(l => ({ id: l.id, why: l.reason, difficulty: l.difficulty })),
    failedLines,
    marks: Object.fromEntries(api.lines.map(l => [l.id, l.mark ?? ' '])),
  }
}

async function loadQueue($: any, file: string, now: number): Promise<{ queue: QueueView | null; error: string }> {
  const res = await $.http.fetch(`${DASHBOARD}/api/queue?file=${encodeURIComponent(file)}`).catch((e: unknown) => String(e))
  if (typeof res === 'string') return { queue: null, error: 'queue: ' + res }
  try {
    const body = JSON.parse(res.text)
    if (!res.ok) return { queue: null, error: 'queue: ' + String(body?.error ?? res.status) }
    return { queue: queueView(file, body, now), error: '' }
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

type Ledger = { runs: Map<string, Run>; spends: Map<string, TaskSpend> }
const NO_LEDGER: Ledger = { runs: new Map(), spends: new Map() }
let ledgerRead: Ledger = NO_LEDGER

/** The ledger's runs and spend, re-read only when the file's size or mtime moved (the pane refreshes often). */
async function ledgerAt($: any, dir: string): Promise<Ledger> {
  const entries = await $.fs.list(dir).catch(() => [])
  const f = entries.find((x: any) => x.name === 'ledger.jsonl')
  if (!f) return NO_LEDGER
  const stamp = `${f.size}:${f.mtimeMs}`
  if (stamp !== ledgerSeen) {
    const text = String(await $.fs.read(`${dir}/ledger.jsonl`).catch(() => ''))
    ledgerRead = { runs: ledgerRunsOf(text), spends: ledgerSpendOf(text) }
    ledgerSeen = stamp
  }
  return ledgerRead
}

const two = (n: number) => String(n).padStart(2, '0')

/** `HH:MM` of a start, with its `DD.MM ` when it fell on another day than the land (a run across midnight). */
export function startText(start: number, endAt: string): string {
  const d = new Date(start)
  const day = `${two(d.getDate())}.${two(d.getMonth() + 1)}`
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  return day === endAt.slice(0, 5) ? hm : `${day} ${hm}`
}

/** `DD.MM` of a moment, in local time: the key of a day of the Landed tree. */
export function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}`
}

/** A land's `DD.MM HH:MM` as a moment: the latest year that does not put it past `now` by more than a day (the log is of the last 14 days, so the year only matters around New Year). */
export function landMs(at: string, now: number): number {
  const m = /^(\d\d)\.(\d\d) (\d\d):(\d\d)/.exec(at)
  if (!m) return 0
  const year = new Date(now).getFullYear()
  const t = new Date(year, Number(m[2]) - 1, Number(m[1]), Number(m[3]), Number(m[4])).getTime()
  return t > now + 24 * 3600 * 1000 ? new Date(year - 1, Number(m[2]) - 1, Number(m[1]), Number(m[3]), Number(m[4])).getTime() : t
}

/** A Landed day (`lands-DD.MM`) is open when the person opened it, folded when they folded it, else open only on today. The fold list holds an explicit `+key` / `-key` for a day, never a flip of the default: a default that changes at midnight must not flip a day the person chose. */
export function landDayOpen(foldedKeys: string[], key: string, today: string): boolean {
  if (foldedKeys.includes('-' + key)) return false
  if (foldedKeys.includes('+' + key)) return true
  return key === today
}

/** The fold list after a click on a Landed day: the opposite of what it showed, written explicitly. */
export function landDayToggled(foldedKeys: string[], key: string, today: string): string[] {
  const wasOpen = landDayOpen(foldedKeys, key, today)
  return [...foldedKeys.filter(k => k !== '+' + key && k !== '-' + key), (wasOpen ? '-' : '+') + key]
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

/** `$1.23`, `$12.34`, `$123`; `—` when the line has no measured cost (never `$0.00`). */
export function usdText(usd: number | undefined): string {
  if (usd === undefined) return '—'
  return '$' + (usd < 100 ? usd.toFixed(2) : usd.toFixed(0))
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

/** A day row's spend: the sum (`—` when no line is measured) and what it includes besides landed lines. */
export function dayText(d: DaySpend): string {
  const extra = [d.failed > 0 ? `${d.failed} failed` : '', d.closed > 0 ? `${d.closed} closed` : ''].filter(x => x !== '').join(', ')
  return `${d.measured === 0 ? '—' : usdText(d.usd)}${extra !== '' ? ` incl. ${extra}` : ''}`
}

async function lands($: any, queueFile: string, ledger: Ledger): Promise<Land[]> {
  const repo = queueFile.replace(/\/\.claude\/batch\/[^/]+$/, '')
  if (repo === queueFile) return []
  const run = await $.process
    .run(['git', '-C', repo, 'log', `--since=${LAND_DAYS} days ago`, '--first-parent', '-n', '2000',
      '--format=%h%x09%cd%x09%(trailers:key=Slice,valueonly,separator=)', '--date=format:%d.%m %H:%M', 'main'],
      { timeoutMs: 10000 })
    .catch(() => undefined)
  if (!run || run.exitCode !== 0) return []
  return String(run.stdout)
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
  } finally {
    poolBusy = false
  }
}

/** A refresh's pool step: reads the pool only while the pane is open on the Pool tab of a queue session, else drops what an earlier read left. */
async function refreshPool($: any, s: Snapshot): Promise<void> {
  if (s.queue && (await read($, paneOpen)) && (await read($, view)) === 'pool') {
    await loadPool($)
    return
  }
  if ((await read($, poolAtom)) !== null) await update($, poolAtom, () => null)
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
  }
  const landed = queue ? await lands($, queueFile, ledger) : []
  const recent = landed.filter(l => landMs(l.at, now) > now - 24 * 3600 * 1000).length
  return { at: now, sessions, queue, lands: landed, recent, days: daySpends(landed, ledger.spends, now), error: loaded.error }
}

/** The role an agent plays for the workflow its session runs. */
function roleOf(workflow: string): string {
  if (/review/.test(workflow)) return 'reviewer'
  if (/worker/.test(workflow)) return 'worker'
  if (/recon/.test(workflow)) return 'recon'
  return 'driver'
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
    await $.ui.open({ id: PANE, title: 'Workflow plan', backgroundColor: 'transparent' })
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

function age(ms: number): string {
  if (ms <= 0) return ''
  const m = Math.floor(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

/** Opens the Pool tab and reads the pool at once (the next refresh keeps it fresh while the tab stays open). */
async function openPool($: any): Promise<void> {
  await update($, view, () => 'pool')
  await loadPool($)
}

/** Terminal cells a string takes: wide glyphs (CJK, emoji) two, combining marks none. */
export function cells(text: string): number {
  let n = 0
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    if (c >= 0x300 && c <= 0x36f) continue
    const wide =
      (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) || (c >= 0x20000 && c <= 0x3fffd)
    n += wide ? 2 : 1
  }
  return n
}

/** A queue line's priority as one cell: urgent ⇈ red, high ↑ orange, low ↓ grey; normal (or none) has no glyph. */
export const PRIO_GLYPHS: Record<string, { glyph: string; color: string }> = {
  urgent: { glyph: '⇈', color: 'red' },
  high: { glyph: '↑', color: '#ff8800' },
  low: { glyph: '↓', color: 'gray' },
}
export function prioGlyph(priority: string | undefined): { glyph: string; color: string } | undefined {
  return priority !== undefined && Object.hasOwn(PRIO_GLYPHS, priority) ? PRIO_GLYPHS[priority] : undefined
}
const prioCell = (Text: any, priority: string | undefined) => {
  const g = prioGlyph(priority)
  return g ? <Text color={g.color}>{g.glyph}</Text> : ' '
}

/** A text cut to `max` cells with a closing `…`; unchanged when it fits. */
export function fitCells(text: string, max: number): string {
  if (cells(text) <= max) return text
  let out = ''
  for (const ch of text) {
    if (cells(out + ch) > max - 1) break
    out += ch
  }
  return out + '…'
}

/** The bar `▰▰▱▱▱` and the kind glyph are five and one cells; a row's text is measured with them as blanks. */
const BAR_W = ' '.repeat(5)
/** The second line of a two-line row sits this far in from its first line's indent. */
const TAB = '    '

/** A section lays out as one: its rows are on one line each when every row fits `columns`, else on two lines each. */
export function fitsOneLine(rows: string[], columns: number): boolean {
  return rows.every(r => cells(r) <= columns)
}

/** A span of ms for a lease or a wait: `45s`, `3m09s`, `1h05m`. */
export function spanText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${two(s % 60)}s` : `${Math.floor(m / 60)}h${two(m % 60)}m`
}

/** The Pool tab, fitted to the pane: the pool's header, then per lease or waiter two lines (what and for how long with its flags; whose and for what, cut to the width). One dim line when there is no read. */
function poolBody(st: PoolState | null, now: number, columns: number, ui: { Box: any; Text: any }) {
  const { Box, Text } = ui
  if (!st) return <Text dimColor>Reading the pool…</Text>
  const p = st.pool
  if (!p) return <Text dimColor>Pool: {st.error}.</Text>
  const row = (l: PoolLine, mark: string) => {
    const who = [l.project, l.session, l.step, l.label].filter(x => x !== '').join(' · ')
    const flags = (l.overrun !== null ? ` OVERRUN ~${l.overrun}` : '') + (l.isStarved ? ' STARVED' : '')
    // the flags keep their cells; what and for how long is cut to the rest of the line
    const lead = fitCells(`  ${mark} ${l.request} prio ${l.priority} · ${spanText(l.ageMs)}`, Math.max(8, columns - cells(flags)))
    return (
      <Box flexDirection="column">
        <Text>
          {lead}
          {l.overrun !== null ? <Text color="red" weight="bold"> OVERRUN ~{l.overrun}</Text> : null}
          {l.isStarved ? <Text color="red" weight="bold"> STARVED</Text> : null}
        </Text>
        <Text dimColor>{fitCells('     ' + who, columns)}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text weight="bold">{fitCells(`budget ${p.budget} · held ${p.held} · load ${p.load.toFixed(2)}`, columns)}</Text>
      <Text dimColor>{fitCells(`external ${p.external.toFixed(1)} · threshold ${p.threshold}`, columns)}</Text>
      <Text dimColor>{fitCells(`locks: ${p.locks.length > 0 ? p.locks.join(', ') : 'none'}`, columns)}</Text>
      {p.starvedNote !== '' && <Text color="red">{fitCells(p.starvedNote, columns)}</Text>}
      <Text color="green" weight="bold">▶ Leases ({p.leases.length})</Text>
      {p.leases.length === 0 && <Text dimColor>  none</Text>}
      {p.leases.map(l => row(l, '■'))}
      <Text color="blue" weight="bold">{fitCells(`◷ Waiting (${p.waiting.length}), in admission order`, columns)}</Text>
      {p.waiting.length === 0 && <Text dimColor>  none</Text>}
      {p.waiting.map((l, i) => row(l, `${i + 1}.`))}
      <Text dimColor>read {spanText(now - st.at)} ago</Text>
    </Box>
  )
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
    const { Text } = $.ui.resolve(e)
    const land = recentLand(s?.lands ?? [], seen.label, seen.at, await $.clock.now())
    const dur = task.durationMs !== undefined ? ` · ${age(task.durationMs) || '<1m'}` : ''
    const outcome =
      task.status === 'killed' ? <Text color="red">✗ stopped by hand at {seen.state}</Text>
      : task.status === 'failed' ? <Text color="red">✗ failed at {seen.state}</Text>
      : land && seen.role === 'driver' ? <Text color="green">✓ landed {land.sha}</Text>
      : <Text dimColor>ended at {seen.state}</Text>
    return (
      <Text>
        <Text color="cyan">⚙ [{seen.label}] </Text>
        <Text dimColor>{seen.role}{dur} · </Text>
        {outcome}
      </Text>
    )
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
    return (
      <Text>
        <Text color="cyan">⚙ [{spawn.label}] </Text>
        <Text dimColor>{spawn.role}</Text>
        {modelText}
      </Text>
    )
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
    const { Text } = $.ui.resolve(e)
    const short = (r: string) => (r.length > 140 ? r.slice(0, 139) + '…' : r)
    return (
      <Text>
        {landed ? <Text color="green">✓ [{id}] landed {landed[1]}</Text>
          : needs ? <Text><Text color="yellow">⏸ [{id}] needs the parent: </Text>{short(needs[2] ?? '')}</Text>
          : <Text dimColor>… [{id}] waiting</Text>}
      </Text>
    )
  })

  // A collapsed group of tool calls that holds workflow-engine calls draws as the chain of moves they made
  // (`[slice] transition→state …`) instead of "Called plugin:workflow:wf N times"; other tools keep a count.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.props.isExpanded || e.props.isCallsOnly === false) return next(e)
    const calls = e.props.calls
    const wf = calls.filter(c => isEngineTool(c.tool))
    if (wf.length === 0) return next(e)
    const { Text } = $.ui.resolve(e)
    const s = await read($, snap)
    const label = (sid: string) => {
      const r = s?.sessions.find(x => x.id === sid)
      return r ? (r.tag !== '' ? r.tag : r.workflow) : sid.slice(0, 8)
    }
    const moves: any[] = []
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
        if (sid !== '' && sid !== lastSid) moves.push(<Text color="cyan">[{label(sid)}] </Text>)
        lastSid = sid
        moves.push(
          <Text>
            <Text dimColor>{name}→</Text>
            <Text color={c.isErrored ? 'red' : 'cyanBright'} weight="bold">{c.isRunning ? '…' : to ?? '?'}</Text>{' '}
          </Text>,
        )
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
    return (
      <Text>
        <Text color="cyan">⚙ </Text>
        {moves}
        {tail.length > 0 ? <Text dimColor>{moves.length > 0 ? '· ' : ''}{tail.join(' ')}</Text> : null}
      </Text>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const s = await read($, snap)
    if (!s) return <Text dimColor>Reading the workflow engine…</Text>
    // no work queue: one view, the session tree — no tabs to choose between
    const tab: View = s.queue ? ((await read($, view)) ?? 'plan') : 'sessions'
    const open: string = (await read($, expanded)) ?? ''
    const foldedNow: string[] = (await read($, folded)) ?? []
    const now = await $.clock.now()
    const today = 'lands-' + dayOf(now)
    const isOpen = (key: string) =>
      key.startsWith('lands-') ? landDayOpen(foldedNow, key, today) : foldedNow.includes(key) === FOLDED_BY_DEFAULT.has(key)
    // a section header of the Plan tab: a click folds or unfolds it (all unfolded by default but FOLDED_BY_DEFAULT ones and the days before today)
    const header = (key: string, color: string, title: string) => (
      <Button key={'fold-' + key} plain onPress={() => void update($, folded, f => (f.includes(key) ? f.filter(k => k !== key) : [...f, key]))}>
        <Text color={color} weight="bold">{isOpen(key) ? '▾' : '▸'} {title}</Text>
      </Button>
    )
    const columns: number = e.props?.bodyColumns ?? 100
    const room = Math.max(4, (e.viewport?.rows ?? 30) - 6)
    const byId = new Map(s.sessions.map(r => [r.id, r]))
    const childrenOf = (id: string): SessionRow[] => s.sessions.filter(r => r.parent === id)
    const leafOf = (id: string): SessionRow | undefined => {
      // the deepest child of a pipeline: where its work stands now
      let cur = byId.get(id)
      for (let i = 0; cur && i < 8; i++) {
        const child = childrenOf(cur.id)[0]
        if (!child) break
        cur = child
      }
      return cur
    }
    const roots = s.sessions.filter(r => r.parent === '' || !byId.has(r.parent))
    const q = s.queue
    const tabs: { id: View; key: string; label: string }[] = [
      { id: 'plan', key: '1', label: q ? `Plan ${q.running.length}/${q.window}` : 'Plan' },
      { id: 'sessions', key: '2', label: `Sessions ${s.sessions.length}` },
      { id: 'waiting', key: '3', label: `Waiting ${q?.waiting.length ?? 0}` },
      // no count: the pool is read only while this tab is open
      { id: 'pool', key: '4', label: 'Pool' },
    ]
    // difficulty as a five-cell track (one cell per two points): its fill the level, its colour the model the
    // table gives it — 1–3 sonnet (green), 4–6 sonnet/high (yellow), 7–10 opus (red)
    const level = (d: string) => {
      const n = Number(d)
      if (!Number.isFinite(n) || n < 1) return <Text dimColor>?????</Text>
      const full = Math.min(5, Math.max(1, Math.round(n / 2)))
      return (
        <Text>
          <Text color={n <= 3 ? 'green' : n <= 6 ? 'yellow' : 'red'} weight={n >= 9 ? 'bold' : undefined}>{'▰'.repeat(full)}</Text>
          <Text dimColor>{'▱'.repeat(5 - full)}</Text>
        </Text>
      )
    }
    // the kind glyph the engine's /api/queue gives each line (`kindMark`), right after the bar; a blank cell when the
    // line is not in the queue
    const markOf = (id: string) => (q && Object.hasOwn(q.marks, id) ? q.marks[id] : ' ')
    const kindOf = (id: string) => <Text dimColor>{markOf(id)}</Text>
    const tabRow = (
      <Box flexDirection="row" gap={2}>
        {tabs.map(t => (
          <Button key={'tab-' + t.id} hotkey={t.key} plain onPress={() => void (t.id === 'pool' ? openPool($) : update($, view, () => t.id))}>
            {t.id === tab ? <Text weight="bold" color="cyan">{t.label}</Text> : <Text dimColor>{t.label}</Text>}
          </Button>
        ))}
      </Box>
    )
    const footer = (
      <Text dimColor>
        updated {age(now - s.at) || 'just now'}{s.error !== '' ? '' : ''}
      </Text>
    )

    // as the engine statusline script draws them: a root with children ◆ bold; a working leaf (agent or exec, no
    // child) bright ⚙; any other session plain ⚙
    const sessionPlain = (r: SessionRow, depth: number) =>
      `${'  '.repeat(depth)}⚙ ${r.workflow}${r.tag !== '' ? `[${r.tag}]` : ''} @ ${r.state} ${age(now - r.since)}${open === r.id ? ' ▾' : ''}`
    const sessionLine = (r: SessionRow, depth: number, twoLines: boolean) => {
      const hasChildren = childrenOf(r.id).length > 0
      const isRoot = r.parent === '' || !byId.has(r.parent)
      const mark = isRoot && hasChildren
        ? <Text color="cyanBright" weight="bold">◆</Text>
        : <Text color={r.isWorking && !hasChildren ? 'cyanBright' : 'cyan'}>⚙</Text>
      const isOpen = open === r.id
      const pad = '  '.repeat(depth)
      const tailText = ` ${age(now - r.since)}${isOpen ? ' ▾' : ''}`
      const stateText = twoLines ? fitCells(r.state, Math.max(1, columns - pad.length - TAB.length - 2 - cells(tailText))) : r.state
      const state = <Text weight={isOpen ? 'bold' : undefined}>{stateText}</Text>
      const tail = <Text dimColor>{tailText}</Text>
      if (!twoLines) {
        return (
          <Button key={'s-' + r.id} plain onPress={() => void update($, expanded, cur => (cur === r.id ? '' : r.id))}>
            {pad}{mark}{' '}
            {r.workflow}{r.tag !== '' ? <Text color="cyan">[{r.tag}]</Text> : null} @ {state}
            {tail}
          </Button>
        )
      }
      // two lines: the workflow and its task, then the state and its age indented under them
      const room1 = Math.max(6, columns - pad.length - 2)
      const wf = fitCells(r.workflow, room1)
      const tag = r.tag !== '' ? fitCells(`[${r.tag}]`, Math.max(0, room1 - cells(wf))) : ''
      return (
        <Button key={'s-' + r.id} plain onPress={() => void update($, expanded, cur => (cur === r.id ? '' : r.id))}>
          <Text>
            {pad}{mark} {wf}<Text color="cyan">{tag}</Text>{'\n'}
            {pad}{TAB}@ {state}{tail}
          </Text>
        </Button>
      )
    }
    // The open session's card: where it came from, where it is, where it can go.
    const card = (r: SessionRow, depth: number) => {
      const pad = '  '.repeat(depth + 1)
      const path = r.recent.map(m => m.to)
      const from = r.recent.at(-1)
      return (
        <Box key={'c-' + r.id} flexDirection="column">
          <Text dimColor>{pad}from  {path.length > 1 ? '… ' + path.slice(0, -1).join(' → ') : '(start)'}{from ? `  (${age(now - from.at)} ago)` : ''}</Text>
          <Text>{pad}<Text dimColor>now   </Text><Text weight="bold">{r.state}</Text><Text dimColor>{r.visit > 1 ? `  visit ${r.visit}` : ''}{r.isWorking ? '  working' : '  waiting'}</Text></Text>
          <Text>{pad}<Text dimColor>next  </Text>{r.next.length > 0 ? r.next.join('  ') : <Text dimColor>(the dashboard at {DASHBOARD} is not answering)</Text>}</Text>
          <Text>{pad}<Link href={`${DASHBOARD}/session/${r.id}`} label="open the graph in the dashboard" /></Text>
        </Box>
      )
    }
    const tree = (r: SessionRow, depth: number, twoLines: boolean): any[] => [
      sessionLine(r, depth, twoLines),
      ...(open === r.id ? [card(r, depth)] : []),
      ...childrenOf(r.id).flatMap(c => tree(c, depth + 1, twoLines)),
    ]
    const plainTree = (r: SessionRow, depth: number): string[] => [
      sessionPlain(r, depth),
      ...childrenOf(r.id).flatMap(c => plainTree(c, depth + 1)),
    ]

    let body: any
    if (tab === 'sessions' || (tab === 'plan' && !q)) {
      const sessTwo = !fitsOneLine(roots.flatMap(x => plainTree(x, 0)), columns)
      const lines = roots.flatMap(r => tree(r, 0, sessTwo))
      // the height cap counts lines: a two-line row takes two
      const cap = sessTwo ? Math.max(1, Math.floor(room / 2)) : room
      body = lines.length === 0
        ? <Text dimColor>No active workflow in this session.</Text>
        : <Box flexDirection="column">{lines.slice(0, cap)}{lines.length > cap ? <Text dimColor>  +{lines.length - cap} more</Text> : null}</Box>
    } else if (!q) {
      body = <Text dimColor>No work queue in this session: the Sessions tab shows its workflow.</Text>
    } else if (tab === 'pool') {
      const st = (await read($, poolAtom)) as PoolState | null
      body = poolBody(st, now, columns, { Box, Text })
    } else if (tab === 'waiting') {
      const waitTwo = !fitsOneLine(q.waiting.map(w => `${BAR_W} ${markOf(w.id)} ${w.id} ${w.why}`), columns)
      // the height cap counts lines: a two-line row takes two
      const waitCap = waitTwo ? Math.max(1, Math.floor(room / 2)) : room
      body = (
        <Box flexDirection="column">
          {q.waiting.length === 0 && <Text dimColor>Nothing waits.</Text>}
          {q.waiting.slice(0, waitCap).map(w =>
            waitTwo ? (
              <Box flexDirection="column">
                <Text>{level(w.difficulty)} {kindOf(w.id)} {fitCells(w.id, Math.max(1, columns - 8))}</Text>
                <Text dimColor>{TAB}{fitCells(w.why, Math.max(1, columns - TAB.length))}</Text>
              </Box>
            ) : (
              <Text>{level(w.difficulty)} {kindOf(w.id)} {w.id}<Text dimColor> {w.why}</Text></Text>
            ),
          )}
          {q.waiting.length > waitCap && <Text dimColor>+{q.waiting.length - waitCap} more</Text>}
        </Box>
      )
    } else {
      // Next shows up to 10, fitted to the pane; Landed lists the whole day (the pane scrolls) and folds on a click
      const pipelineOf = new Map(s.sessions.filter(r => r.tag !== '').map(r => [r.tag, r]))
      const whereOf = (id: string) => {
        const p = pipelineOf.get(id)
        const leaf = p ? leafOf(p.id) : undefined
        return !p ? 'no pipeline' : leaf && leaf.id !== p.id ? `${p.state} › ${leaf.state}` : p.state
      }
      const sinceOf = (id: string) => {
        const p = pipelineOf.get(id)
        return p ? age(now - (leafOf(p.id) ?? p).since) : ''
      }
      // a section lays out as one: when ANY of its rows does not fit the pane, EVERY row takes two lines
      const runTwo = !fitsOneLine(q.running.map(l => `  ${BAR_W} ${markOf(l.id)} ${l.id}  ${whereOf(l.id)} ${sinceOf(l.id)}`), columns)
      const nextTwo = !fitsOneLine(q.ready.slice(0, 10).map(l => `  ${BAR_W} ${markOf(l.id)} ${prioGlyph(l.priority)?.glyph ?? ' '} ${l.id}`), columns)
      // the rows left for Next count lines: a two-line Running or Next row takes two
      const spare = (e.viewport?.rows ?? 30) - 9 - q.running.length * (runTwo ? 2 : 1)
      const showReady = Math.max(4, Math.min(10, Math.ceil(spare / (nextTwo ? 4 : 2))))
      // a row's cost sits right after its kind, right-aligned to the section's widest figure: it is never cut, the id is
      const costCol = (all: (number | undefined)[]) => {
        const w = Math.max(1, ...all.map(u => cells(usdText(u))))
        return { w, text: (u: number | undefined) => usdText(u).padStart(w) }
      }
      const recentFailed = q.failedLines.filter(l => l.recent)
      const olderFailed = q.failedLines.filter(l => !l.recent)
      // the rows drawn: the recent ones, and the older ones once `+N older` is open
      const shownFailed = isOpen('failed-older') ? q.failedLines : recentFailed
      // only the rows drawn size the section: a row of a folded day is not on screen and must not widen the cost column or flip the layout
      const shownLands = isOpen('lands') ? s.lands.filter(l => isOpen('lands-' + l.at.slice(0, 5))) : []
      const landCost = costCol(shownLands.map(l => l.usd))
      const failCost = costCol(shownFailed.map(l => l.usd))
      const costOf = (u: number | undefined, col: { text: (u: number | undefined) => string }) => <Text dimColor={u === undefined}>{col.text(u)}</Text>
      const landTwo = !fitsOneLine(shownLands.map(l => `    ${BAR_W} ${markOf(l.slice)} ${landCost.text(l.usd)} ${l.start}-${l.at.slice(6)} ${l.sha} ${l.slice}`), columns)
      const stampOf = (date: string) => {
        // `YYYY-MM-DD` of the last note as `DD.MM`; a line with no dated note says so
        const when = /^\d{4}-(\d\d)-(\d\d)$/.exec(date)
        return when ? `${when[2]}.${when[1]}` : 'date unknown'
      }
      const reasonOf = (l: FailedLine) => (l.reason === '' ? 'no note' : l.reason)
      const failTwo = !fitsOneLine(shownFailed.map(l => `    ${BAR_W} ${markOf(l.id)} ${failCost.text(l.usd)} ${l.id} ${stampOf(l.date)} ${reasonOf(l)}`), columns)
      body = (
        <Box flexDirection="column">
          <Text>
            <Text weight="bold">{q.file.replace(/^.*\//, '')}</Text>
            <Text dimColor>  pending {q.pending} · done {q.done}{q.failed > 0 ? ` · failed ${q.failed}` : ''}</Text>
          </Text>
          {header('running', 'green', `▶ Running ${q.running.length}/${q.window}`)}
          {isOpen('running') && q.running.length === 0 && <Text dimColor>  nothing</Text>}
          {isOpen('running') && q.running.map(l => {
            const p = pipelineOf.get(l.id)
            const since = sinceOf(l.id)
            if (!runTwo) {
              return (
                <Text>
                  {'  '}{level(l.difficulty)} {kindOf(l.id)} {l.id}  <Text color={p ? 'cyan' : 'yellow'}>{whereOf(l.id)}</Text>
                  <Text dimColor> {since}</Text>
                </Text>
              )
            }
            // two lines: bar, kind, id; the state, the next step and the age indented under them
            const pad = '  ' + TAB
            return (
              <Box flexDirection="column">
                <Text>{'  '}{level(l.difficulty)} {kindOf(l.id)} {fitCells(l.id, Math.max(1, columns - 10))}</Text>
                <Text>
                  {pad}<Text color={p ? 'cyan' : 'yellow'}>{fitCells(whereOf(l.id), Math.max(1, columns - pad.length - (since === '' ? 0 : cells(since) + 1)))}</Text>
                  <Text dimColor> {since}</Text>
                </Text>
              </Box>
            )
          })}
          {header('next', 'blue', `⏭ Next (${q.ready.length})`)}
          {isOpen('next') && q.ready.length === 0 && <Text dimColor>  nothing ready</Text>}
          {isOpen('next') &&
            q.ready.slice(0, showReady).map(l =>
              nextTwo ? (
                // two lines: bar, kind, priority; the id indented under them
                <Box flexDirection="column">
                  <Text>{'  '}{level(l.difficulty)} {kindOf(l.id)} {prioCell(Text, l.priority)}</Text>
                  <Text>{'  '}{TAB}{fitCells(l.id, Math.max(1, columns - 2 - TAB.length))}</Text>
                </Box>
              ) : (
                <Text>{'  '}{level(l.difficulty)} {kindOf(l.id)} {prioCell(Text, l.priority)} {l.id}</Text>
              ),
            )}
          {isOpen('next') && q.ready.length > showReady && <Text dimColor>  +{q.ready.length - showReady} more can start (dependencies done), in the picker's order</Text>}
          {header('lands', 'green', `✓ Landed · ${LAND_DAYS}d (${s.lands.length})`)}
          {isOpen('lands') &&
            [...new Set(s.lands.map(l => l.at.slice(0, 5)))].flatMap(day => {
              // `at` is `DD.MM HH:MM` (numeric: locale-free): one foldable row per day with its spend, its lands one level deeper
              const mine = s.lands.filter(l => l.at.slice(0, 5) === day)
              const spend = s.days[day]
              const key = 'lands-' + day
              return [
                <Button key={'fold-' + key} plain onPress={() => void update($, folded, f => landDayToggled(f, key, today))}>
                  <Text dimColor>{fitCells(`  ${isOpen(key) ? '▾' : '▸'} ▦ ${day} (${mine.length})${spend ? ' ' + dayText(spend) : ''}`, columns)}</Text>
                </Button>,
                ...(isOpen(key)
                  ? mine.map(l =>
                      landTwo ? (
                        // two lines: bar, kind, cost, times, sha; the id indented under them
                        <Box flexDirection="column">
                          <Text>{'    '}{level(l.difficulty)} {kindOf(l.slice)} {costOf(l.usd, landCost)} <Text dimColor>{fitCells(`${l.start}-${l.at.slice(6)} ${l.sha}`, Math.max(1, columns - 13 - landCost.w))}</Text></Text>
                          <Text>{'    '}{TAB}{fitCells(l.slice, Math.max(1, columns - 4 - TAB.length))}</Text>
                        </Box>
                      ) : (
                        <Text>{'    '}{level(l.difficulty)} {kindOf(l.slice)} {costOf(l.usd, landCost)} <Text dimColor>{l.start}-{l.at.slice(6)} {l.sha}</Text> {l.slice}</Text>
                      ),
                    )
                  : []),
              ]
            })}
          {header('failed', 'red', `✗ Failed (${recentFailed.length})`)}
          {isOpen('failed') && q.failedLines.length === 0 && <Text dimColor>  nothing</Text>}
          {isOpen('failed') && q.failedLines.length > 0 && recentFailed.length === 0 && <Text dimColor>  none in the last {FAILED_DAYS} days</Text>}
          {isOpen('failed') &&
            shownFailed.map(l => {
              const stamp = stampOf(l.date)
              if (!failTwo) {
                return <Text>{'    '}{level(l.difficulty)} {kindOf(l.id)} {costOf(l.usd, failCost)} {l.id} <Text dimColor>{stamp} {reasonOf(l)}</Text></Text>
              }
              // two lines: bar, kind, cost, id, date; the reason indented under them
              const lead = 4 + 5 + 1 + 1 + 1 + failCost.w + 1
              const idFit = fitCells(l.id, Math.max(1, columns - lead - cells(stamp) - 1))
              const stampFit = fitCells(stamp, Math.max(1, columns - lead - cells(idFit) - 1))
              return (
                <Box flexDirection="column">
                  <Text>{'    '}{level(l.difficulty)} {kindOf(l.id)} {costOf(l.usd, failCost)} {idFit} <Text dimColor>{stampFit}</Text></Text>
                  <Text dimColor>{'    '}{TAB}{fitCells(reasonOf(l), Math.max(1, columns - 4 - TAB.length))}</Text>
                </Box>
              )
            })}
          {isOpen('failed') && olderFailed.length > 0 && (
            <Button key="fold-failed-older" plain onPress={() => void update($, folded, f => (f.includes('failed-older') ? f.filter(k => k !== 'failed-older') : [...f, 'failed-older']))}>
              <Text dimColor>{fitCells(`  ${isOpen('failed-older') ? '▾' : '▸'} +${olderFailed.length} older`, columns)}</Text>
            </Button>
          )}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          {s.queue ? tabRow : null}
          <Link href={`${DASHBOARD}/map`} label="map ↗" />
        </Box>
        {body}
        {s.error !== '' && <Text color="red">{s.error}</Text>}
        {footer}
      </Box>
    )
  })
}
