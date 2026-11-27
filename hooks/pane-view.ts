// What the plan pane draws, as data: a Snapshot (and the pane's own fold / tab / card state) in, a tree of the
// four primitives the pane is made of (box, text, button, link) out. Pure and import-free (types only), so the mod
// (hooks/plan-pane.tsx, which maps the tree onto Claude Code's elements) and the documentation site (the landing's
// scene, docs/.vitepress/theme/PaneView.vue, which maps it onto the DOM) draw the SAME pane: there is no second copy of its rows, glyphs, colors, bars or sections.

import type { DaySpend, FailedLine, FailedSpend, PoolCounts, PoolLine, PoolState, SessionRow, Snapshot, View } from '../types'

/** The engine's own dashboard: its API answers the workflow graphs, its page draws one session's graph. */
export const DASHBOARD = 'http://127.0.0.1:3100'
/**
 * The path and label of the link under each tab (the pane's `View` ids); src/dashboard-routes.test.ts pins the paths
 * to `routePath`. Waiting has no view of its own: its lines are the Plan view's pending section, so it links there.
 */
export const TAB_LINKS = {
  plan: { path: '/plan', label: 'plan ↗' },
  sessions: { path: '/sessions', label: 'sessions ↗' },
  waiting: { path: '/plan', label: 'plan ↗' },
  pool: { path: '/pool', label: 'pool ↗' },
} as const
/** The pane's title, as `$.ui.open` gives it. */
export const PANE_TITLE = 'Workflow plan'
/**
 * The pane's colours by role. A value is a theme key of Claude Code (the mod API's `Color` follows the person's theme),
 * never an ANSI name or a hex: a terminal profile maps ANSI names to a palette of its own, so a name readable on a dark
 * ground can vanish on a white one, where a theme key is chosen by the theme for its own ground. The site's terminal
 * (`docs/.vitepress/theme/PaneView.vue`) defines every value for both of its grounds.
 */
export const TONE = {
  ok: 'success',
  bad: 'error',
  warn: 'warning',
  info: 'suggestion',
  live: 'claude',
  quiet: 'inactive',
  next: 'remember',
  pool: 'autoAccept',
  high: 'claude',
} as const
/** What a report row of the Done tree draws where a land draws its sha: the line closed with a report, not a commit. */
export const REPORT_MARK = '✎ report'

/** How far back the Done tree goes: the Cost tab's own range. */
export const LAND_DAYS = 14
/** The Failed section lists the lines that ended within this many days; the rest fold under `+N older`. */
export const FAILED_DAYS = 2
/** Sections that start folded: a click on one unfolds it. Each `+N more` fold row of the pane is one (`next-more`, `waiting-more`, `sessions-more`): closed, the list stops at its cap; open, it lists every row. A day of the Done tree other than today starts folded too (`lands-DD.MM`). */
export const FOLDED_BY_DEFAULT = new Set(['failed', 'failed-older', 'next-more', 'waiting-more', 'sessions-more'])

/** What a press on a button of the pane asks for: the drawer owns the state and applies it. */
export type PaneAction =
  | { readonly kind: 'fold'; readonly key: string }
  | { readonly kind: 'landDay'; readonly key: string; readonly today: string }
  | { readonly kind: 'tab'; readonly id: View }
  | { readonly kind: 'expand'; readonly id: string }
  | { readonly kind: 'pane' }

/** A text's look: a color (a `TONE` value, a theme key), dim, bold. */
export type TextProps = { readonly color?: string; readonly dimColor?: boolean; readonly weight?: 'bold' }

export type PaneEl =
  | { readonly el: 'box'; readonly props: { readonly flexDirection?: 'row' | 'column'; readonly gap?: number }; readonly key?: string; readonly children: readonly PaneNode[] }
  | { readonly el: 'text'; readonly props: TextProps; readonly children: readonly PaneNode[] }
  | { readonly el: 'button'; readonly key: string; readonly hotkey?: string; readonly action: PaneAction; readonly children: readonly PaneNode[] }
  | { readonly el: 'link'; readonly href: string; readonly label: string }

/** A node of the pane: a run of text, an element, a list (flattened in place), or nothing. */
export type PaneNode = string | null | PaneEl | readonly PaneNode[]

const clean = <T extends object>(props: T): T =>
  Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined && v !== false)) as T

export const text = (props: TextProps, ...children: PaneNode[]): PaneEl => ({ el: 'text', props: clean(props), children })
export const box = (props: { flexDirection?: 'row' | 'column'; gap?: number; key?: string }, ...children: PaneNode[]): PaneEl => {
  const { key, ...rest } = props
  return key === undefined ? { el: 'box', props: clean(rest), children } : { el: 'box', props: clean(rest), key, children }
}
export const button = (key: string, action: PaneAction, children: PaneNode[], hotkey?: string): PaneEl =>
  hotkey === undefined ? { el: 'button', key, action, children } : { el: 'button', key, hotkey, action, children }
export const link = (href: string, label: string): PaneEl => ({ el: 'link', href, label })
const col = (...children: PaneNode[]): PaneEl => box({ flexDirection: 'column' }, ...children)

/** The text a node shows, its elements' text joined (a link shows its label). */
export function nodeText(n: PaneNode): string {
  if (n === null) return ''
  if (typeof n === 'string') return n
  if (Array.isArray(n)) return (n as readonly PaneNode[]).map(nodeText).join('')
  const el = n as PaneEl
  return el.el === 'link' ? el.label : el.children.map(nodeText).join('')
}

export const two = (n: number) => String(n).padStart(2, '0')

/** `12m`, `1h05`; '' for no time. */
export function age(ms: number): string {
  if (ms <= 0) return ''
  const m = Math.floor(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

/** `DD.MM` of a moment, in local time: the key of a day of the Done tree. */
export function dayOf(ms: number): string {
  const d = new Date(ms)
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}`
}

/** Terminal cells a string takes: wide glyphs (CJK, emoji) two, combining marks none. */
export function cells(s: string): number {
  let n = 0
  for (const ch of s) {
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

/** A queue line's priority as one cell: urgent ⇈ `bad`, high ↑ `high` (Claude's orange), low ↓ `quiet`; normal (or none) has no glyph. */
export const PRIO_GLYPHS: Record<string, { glyph: string; color: string }> = {
  urgent: { glyph: '⇈', color: TONE.bad },
  high: { glyph: '↑', color: TONE.high },
  low: { glyph: '↓', color: TONE.quiet },
}
export function prioGlyph(priority: string | undefined): { glyph: string; color: string } | undefined {
  return priority !== undefined && Object.hasOwn(PRIO_GLYPHS, priority) ? PRIO_GLYPHS[priority] : undefined
}
const prioCell = (priority: string | undefined): PaneNode => {
  const g = prioGlyph(priority)
  return g ? text({ color: g.color }, g.glyph) : ' '
}

/** A text cut to `max` cells with a closing `…`; unchanged when it fits. */
export function fitCells(s: string, max: number): string {
  if (cells(s) <= max) return s
  let out = ''
  for (const ch of s) {
    if (cells(out + ch) > max - 1) break
    out += ch
  }
  return out + '…'
}

/** The bar `▰▰▱▱▱` and the kind glyph are five and one cells; a row's text is measured with them as blanks. */
const BAR_W = ' '.repeat(5)
/** The second line of a two-line row sits this far in from its first line's indent. */
const TAB = '    '

/** What keeps a Next row from starting (`QueueLine.wait`), dim, cut to the `room` cells left on its line so the id is never the part that is cut; nothing when there is none or the room is under a few cells. */
function waitTail(wait: string | undefined, room: number): PaneNode {
  if (wait === undefined || wait === '' || room < 8) return null
  return text({ dimColor: true }, fitCells(` ${wait}`, room))
}

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

/** The fold list after a click on `key`: the key leaves the list when it was there, joins it when not. */
export function foldFlipped(foldedKeys: string[], key: string): string[] {
  return foldedKeys.includes(key) ? foldedKeys.filter(k => k !== key) : [...foldedKeys, key]
}

/** A Done day (`lands-DD.MM`) is open when the person opened it, folded when they folded it, else open only on today. The fold list holds an explicit `+key` / `-key` for a day, never a flip of the default: a default that changes at midnight must not flip a day the person chose. */
export function landDayOpen(foldedKeys: string[], key: string, today: string): boolean {
  if (foldedKeys.includes('-' + key)) return false
  if (foldedKeys.includes('+' + key)) return true
  return key === today
}

/** The fold list after a click on a Done day: the opposite of what it showed, written explicitly. */
export function landDayToggled(foldedKeys: string[], key: string, today: string): string[] {
  const wasOpen = landDayOpen(foldedKeys, key, today)
  return [...foldedKeys.filter(k => k !== '+' + key && k !== '-' + key), (wasOpen ? '-' : '+') + key]
}

/** `$1.23`, `$12.34`, `$123`; `—` when the line has no measured cost (never `$0.00`); `≥$17.40` for a lower bound (`floor`: a run's sum left out an unmeasured agent). */
export function usdText(usd: number | undefined, floor?: number): string {
  if (usd === undefined) return floor === undefined ? '—' : '≥' + usdText(floor)
  return '$' + (usd < 100 ? usd.toFixed(2) : usd.toFixed(0))
}

/** A day row's spend: the sum (`—` when no line is measured) and what it includes besides its rows. */
export function dayText(d: DaySpend): string {
  const extra = [d.failed > 0 ? `${d.failed} failed` : '', d.closed > 0 ? `${d.closed} closed` : ''].filter(x => x !== '').join(', ')
  return `${d.measured === 0 ? '—' : usdText(d.usd)}${extra !== '' ? ` incl. ${extra}` : ''}`
}

/** `✓ Done · 14d (434) · $1234 · parent $310 (25%) · golf-int`: the count of rows (lands and reports), their spend (absent when none is measured), the parent's spend and its share of that sum (the share absent when there is no sum), the land branch when it is not `main`. */
export function doneHeading(count: number, done: number | undefined, parent: number | undefined, branch = 'main'): string {
  const share = done !== undefined && done > 0 && parent !== undefined ? ` (${String(Math.round((parent / done) * 100))}%)` : ''
  return `✓ Done · ${LAND_DAYS}d (${count})${done !== undefined ? ' · ' + usdText(done) : ''}${parent !== undefined ? ' · parent ' + usdText(parent) + share : ''}${branch !== 'main' ? ' · ' + branch : ''}`
}

/** `✗ Failed (28) · $41.20 (parent $6.10) · 3 not in the ledger · 2 unmeasured`: the count, the lines' spend, the parent's spend when it has one, how many lines the ledger has no row of (they add 0; `no ledger rows` when none has) and how many have a run with no recorded spend (left out of the sums; their rows show `—`). */
export function failedHeading(count: number, spend: FailedSpend | undefined): string {
  const head = `✗ Failed (${count})`
  if (!spend || count === 0) return head
  const measured = count - spend.missing - (spend.unmeasured ?? 0)
  const unmeasured = spend.unmeasured ? ` · ${spend.unmeasured} unmeasured` : ''
  return `${head}${measured > 0 ? ' · ' + usdText(spend.usd) + (spend.parentUsd > 0 ? ` (parent ${usdText(spend.parentUsd)})` : '') : ''}${spend.missing === count ? ' · no ledger rows' : spend.missing > 0 ? ` · ${spend.missing} not in the ledger` : ''}${unmeasured}`
}

/** The role a workflow's name gives its agent: reviewer, worker or recon; else the workflow's own name, never `driver` (only a workflow's `driver:` block makes an agent its driver). */
export function roleOf(workflow: string): string {
  if (/review/.test(workflow)) return 'reviewer'
  if (/worker/.test(workflow)) return 'worker'
  if (/recon/.test(workflow)) return 'recon'
  return workflow
}

/** What a session's agent is: the role the snapshot read (`driver`, or the stage its parent's step spawned it on), else the workflow's name. */
export function roleOfRow(r: SessionRow): string {
  return r.role !== undefined && r.role !== '' ? r.role : roleOf(r.workflow)
}

/** The stage names a state's text reads as `context.model_<x>` / `context.effort_<x>` (the engine's `stagesRead`; `model_step` and the like are not stages). */
export function stagesOfState(state: unknown): string[] {
  const names = new Set<string>()
  for (const m of JSON.stringify(state ?? null).matchAll(/context\.(?:model|effort)_([a-z][a-z_]*)/g)) {
    if (!['model', 'effort', 'step', 'reached'].includes(m[1]!)) names.add(m[1]!)
  }
  return [...names]
}

/** Difficulty as a five-cell track (one cell per two points): its fill the level, its colour the model the table gives it — 1–3 sonnet (green), 4–6 sonnet/high (yellow), 7–10 opus (red). */
export function level(d: string): PaneEl {
  const n = Number(d)
  if (!Number.isFinite(n) || n < 1) return text({ dimColor: true }, '?????')
  const full = Math.min(5, Math.max(1, Math.round(n / 2)))
  return text(
    {},
    text({ color: n <= 3 ? TONE.ok : n <= 6 ? TONE.warn : TONE.bad, weight: n >= 9 ? 'bold' : undefined }, '▰'.repeat(full)),
    text({ dimColor: true }, '▱'.repeat(5 - full)),
  )
}

/** The Pool tab, fitted to the pane: the pool's header, then per lease or waiter two lines (what and for how long with its flags; whose and for what, cut to the width). One dim line when there is no read. */
function poolBody(st: PoolState | null, now: number, columns: number): PaneNode {
  if (!st) return text({ dimColor: true }, 'Reading the pool…')
  const p = st.pool
  if (!p) return text({ dimColor: true }, `Pool: ${st.error}.`)
  const row = (l: PoolLine, mark: string) => {
    const who = [l.project, l.session, l.step, l.label].filter(x => x !== '').join(' · ')
    const flags = (l.overrun !== null ? ` OVERRUN ~${l.overrun}` : '') + (l.underuse !== null ? ` UNDERUSE ~${l.underuse}` : '') + (l.isStarved ? ' STARVED' : '')
    // a read that knows no priority ('') or no age (negative: the site's replay, cut from a log that carries neither) leaves it out
    const held = (l.priority === '' ? '' : ` prio ${l.priority}`) + (l.ageMs < 0 ? '' : ` · ${spanText(l.ageMs)}`)  + (l.eta === '' ? '' : ` · ${l.eta}`)
    // the flags keep their cells; what and for how long is cut to the rest of the line
    const lead = fitCells(`  ${mark} ${l.request}${held}`, Math.max(8, columns - cells(flags)))
    return col(
      text(
        {},
        lead,
        l.overrun !== null ? text({ color: TONE.bad, weight: 'bold' }, ` OVERRUN ~${l.overrun}`) : null,
        l.underuse !== null ? text({ color: TONE.warn, weight: 'bold' }, ` UNDERUSE ~${l.underuse}`) : null,
        l.isStarved ? text({ color: TONE.bad, weight: 'bold' }, ' STARVED') : null,
      ),
      who === '' ? null : text({ dimColor: true }, fitCells('     ' + who, columns)),
    )
  }
  return col(
    text({ weight: 'bold' }, fitCells(`budget ${p.budget} · held ${p.held} · load ${p.load.toFixed(2)}`, columns)),
    text({ dimColor: true }, fitCells(`external ${p.external.toFixed(1)} · threshold ${p.threshold}`, columns)),
    text({ dimColor: true }, fitCells(`locks: ${p.locks.length > 0 ? p.locks.join(', ') : 'none'}`, columns)),
    p.starvedNote !== '' ? text({ color: TONE.bad }, fitCells(p.starvedNote, columns)) : null,
    text({ color: TONE.ok, weight: 'bold' }, `▶ Leases (${p.leases.length})`),
    p.leases.length === 0 ? text({ dimColor: true }, '  none') : null,
    p.leases.map(l => row(l, '■')),
    text({ color: TONE.next, weight: 'bold' }, fitCells(`◷ Waiting (${p.waiting.length}), in admission order`, columns)),
    p.waiting.length === 0 ? text({ dimColor: true }, '  none') : null,
    p.waiting.map((l, i) => row(l, `${i + 1}.`)),
    text({ dimColor: true }, `read ${spanText(now - st.at)} ago`),
  )
}

/**
 * The status line's band above the prompt: the root session (◆ bold when it has children, else ⚙, bright while an
 * agent or a script works in it) with its workflow and state and the count of the other sessions, the queue's
 * running / ready / landed, and the button that toggles the pane. Nothing when the snapshot holds no session.
 */
export function statusBandTree(s: Snapshot): PaneEl | null {
  if (s.sessions.length === 0) return null
  const ids = new Set(s.sessions.map(r => r.id))
  const roots = s.sessions.filter(r => r.parent === '' || !ids.has(r.parent))
  const hasChildren = (r: SessionRow) => s.sessions.some(c => c.parent === r.id)
  const main = roots.find(hasChildren) ?? roots[0] ?? s.sessions[0]!
  const others = s.sessions.length - 1
  const q = s.queue
  return box(
    { flexDirection: 'row', gap: 2 },
    text(
      {},
      hasChildren(main) ? text({ color: TONE.live, weight: 'bold' }, '◆ ') : text({ color: main.isWorking ? TONE.live : TONE.info }, '⚙ '),
      `${main.workflow}:${main.state}`,
      others > 0 ? text({ color: TONE.info }, ` (${others})`) : null,
    ),
    q ? text({ dimColor: true }, `▶ ${q.running.length}/${q.window} · ⏭ ${q.ready.length} · ✓ ${s.recent}`) : null,
    button('band-plan', { kind: 'pane' }, [text({ color: TONE.info }, '[plan]')], 'p'),
  )
}

/** What the pane draws from: the snapshot and the pane's own state (the person's tab, open card and folds), the clock, its size. */
export type PaneInput = {
  readonly snapshot: Snapshot | null
  /** the tab chosen (a snapshot with no queue has only the Sessions view) */
  readonly tab: View
  /** the session whose card is open ('' none) */
  readonly expanded: string
  readonly folded: string[]
  readonly now: number
  /** the pane's body width in cells */
  readonly columns: number
  /** the viewport's height in rows */
  readonly rows: number
  readonly poolCounts: PoolCounts | null
  readonly pool: PoolState | null
}

/**
 * The sections of the single-task view (a session with no work queue) in the order they fold when the pane is too
 * short: the least important first. A section folds through its levels (`SINGLE_FOLD_LEVELS`), the last of which
 * drops it; the current session's own lines never drop, they shrink to its head line.
 */
export const SINGLE_FOLD_ORDER = ['transitions', 'holders', 'pool', 'running', 'current'] as const
export type SingleSection = (typeof SINGLE_FOLD_ORDER)[number]
/** How far each section folds: `transitions` three rows, one row, none; `holders` the other holders, none; `pool` the strip with this session's leases, the strip, none; `running` every row with its exec lines, the live rows only, none; `current` all its lines, the head line. */
export const SINGLE_FOLD_LEVELS: Record<SingleSection, number> = { transitions: 2, holders: 1, pool: 2, running: 2, current: 1 }

/** How many rows of the other holders and of the running section the unfolded view lists, and the section's short form keeps. */
const HOLDERS_CAP = 4
const RUNNING_CAP = 6
const RUNNING_CAP_SHORT = 3
/** An exec's deadline stretches by its pool wait up to this many times its timeout (`POOL_WAIT_CEILING_FACTOR` of src/types.ts, held equal by src/pane-exec-deadline.test.ts). */
const POOL_WAIT_CEILING_FACTOR = 4
/** The pool wait is stored in steps of a second: an exec is not called late inside this grace. */
const DEADLINE_GRACE_MS = 2000
/** How long an exec may run before the engine times it out: its timeout plus the pool wait counted, capped like the engine's `DeadlineClock`. */
export const execDeadlineMs = (timeoutMs: number, waitMs: number): number => Math.min(timeoutMs + waitMs, timeoutMs * POOL_WAIT_CEILING_FACTOR)
/** The states of the breadcrumb: the last few passed. */
const CRUMBS = 4

/** A run of text or a coloured run; `rowOf` lays them on one line cut to the pane width, never wrapped. */
type Seg = string | { readonly t: string; readonly p: TextProps }
function rowOf(columns: number, ...segs: Seg[]): PaneEl {
  let left = columns
  const out: PaneNode[] = []
  for (const g of segs) {
    if (left <= 0) break
    const t = typeof g === 'string' ? g : g.t
    const cut = fitCells(t, left)
    left -= cells(cut)
    out.push(typeof g === 'string' ? cut : text(g.p, cut))
    if (cut !== t) break
  }
  return text({}, ...out)
}

/** A span of ms as the pane writes a time in a state: seconds under a minute, else minutes. */
const sinceText = (ms: number): string => (ms < 60000 ? spanText(ms) : age(ms))

/** An exec's command on one line: whitespace folded, the first line of a script. */
const commandLine = (command: string): string => (command.trim().split('\n')[0] ?? '').replace(/\s+/g, ' ')

/**
 * The single-task view: the pane of a session that runs no work queue, one screen with no tabs. Top to bottom: the
 * current session (workflow @ state, time in it, the visit, the states passed, the transitions it offers), what runs
 * under it (child sessions, linked agents, an exec in flight, the last exec's exit), the pool (budget, held, load,
 * waiting; this session's own leases marked, the other holders), the last three transitions. A section with nothing
 * to show is left out; when the pane is too short the sections fold in `SINGLE_FOLD_ORDER`. The engine measures no
 * spend of a session still running (the ledger row is written when it ends), so none is drawn.
 */
function singleTaskBody(s: Snapshot, input: PaneInput, room: number): PaneNode {
  const columns = input.columns
  const now = input.now
  const byId = new Map(s.sessions.map(r => [r.id, r]))
  const childrenOf = (id: string): SessionRow[] => s.sessions.filter(r => r.parent === id)
  const roots = s.sessions.filter(r => r.parent === '' || !byId.has(r.parent))
  const main = roots.find(r => childrenOf(r.id).length > 0) ?? roots[0]
  if (!main) return text({ dimColor: true }, 'No active workflow in this session.')
  const mine = new Set(s.sessions.map(r => r.id))
  const row = (...segs: Seg[]) => rowOf(columns, ...segs)
  const dim = (t: string): Seg => ({ t, p: { dimColor: true } })
  const modelSeg = (r: SessionRow): Seg => (r.model !== undefined && r.model !== '' ? dim(` · ${r.model}`) : '')
  const tagSeg = (r: SessionRow): Seg => (r.tag !== '' ? { t: `[${r.tag}]`, p: { color: TONE.info } } : '')

  // (1) the current session
  const currentLines = (level: number): PaneNode[] => {
    const r = main
    const isParent = childrenOf(r.id).length > 0
    const head = row(
      isParent ? { t: '◆ ', p: { color: TONE.live, weight: 'bold' } } : { t: '⚙ ', p: { color: r.isWorking ? TONE.live : TONE.info } },
      r.workflow, tagSeg(r), ' @ ', { t: r.state, p: { weight: 'bold' } },
      dim(` ${sinceText(now - r.since)}${r.visit > 1 ? ` · visit ${r.visit}` : ''}`),
    )
    if (level >= 1) return [head]
    const passed = r.recent.length > 0 ? [r.recent[0]!.from, ...r.recent.map(m => m.to)].filter(x => x !== '') : []
    const crumbs = passed.at(-1) === r.state ? passed.slice(0, -1) : passed
    const shown = crumbs.slice(-CRUMBS)
    const path = crumbs.length === 0 ? '(start)' : `${crumbs.length > shown.length ? '… → ' : ''}${shown.join(' → ')}`
    return [
      head,
      row(dim('  done '), path, dim(' → '), { t: r.state, p: { weight: 'bold' } }),
      row(dim('  next '), r.next.length > 0 ? r.next.join('  ') : dim('(unknown: the dashboard is not answering)')),
    ]
  }

  // (2) what runs under it: the session's own agent and exec, its child sessions with theirs
  type Item = { primary: PaneEl; live: PaneEl[]; last: PaneEl[]; isLastOnly: boolean }
  const execLines = (r: SessionRow, pad: string): { live: PaneEl[]; last: PaneEl[] } => {
    if (r.exec) {
      const elapsed = Math.max(0, now - r.exec.since)
      const wait = r.exec.waitMs ?? 0
      const over = r.exec.timeoutMs > 0 && elapsed > execDeadlineMs(r.exec.timeoutMs, wait) + DEADLINE_GRACE_MS
      return {
        live: [row(pad, { t: '❯ ', p: { color: TONE.warn } }, r.exec.command !== '' ? commandLine(r.exec.command) : r.exec.state,
          { t: ` ${spanText(elapsed)}${r.exec.timeoutMs > 0 ? `/${spanText(r.exec.timeoutMs)}` : ''}${wait >= 1000 ? ` +${spanText(wait)} pool wait` : ''}`, p: over ? { color: TONE.bad } : { dimColor: true } })],
        last: [],
      }
    }
    if (!r.lastExec) return { live: [], last: [] }
    const e = r.lastExec
    return {
      live: [],
      last: [row(pad, dim('last exec '), e.state !== '' ? dim(`${e.state} `) : '', { t: `exit ${e.code}`, p: e.code === 0 ? { color: TONE.ok } : { color: TONE.bad, weight: 'bold' } },
        dim(e.ms > 0 ? ` in ${spanText(e.ms)}` : ''), e.at > 0 ? dim(` ${sinceText(now - e.at)} ago`) : '')],
    }
  }
  const agentSeg = (r: SessionRow): Seg[] => [dim(` · ${roleOfRow(r)}`), modelSeg(r), dim(` · agent ${r.agent.slice(0, 7)}`)]
  const items: Item[] = []
  if (main.agent !== '') items.push({ primary: row('  ', { t: '◇ ', p: { color: TONE.info } }, 'agent', ...agentSeg(main), main.agentAt !== undefined ? dim(` ${sinceText(now - main.agentAt)}`) : ''), live: [], last: [], isLastOnly: false })
  const self = execLines(main, '    ')
  if (self.live.length > 0) items.push({ primary: row('  ', dim('this session')), ...self, isLastOnly: false })
  else if (self.last.length > 0) items.push({ primary: row('  ', dim('this session')), live: [], last: self.last, isLastOnly: true })
  const walk = (r: SessionRow, depth: number) => {
    for (const c of childrenOf(r.id)) {
      const pad = '  '.repeat(depth + 1)
      items.push({
        primary: row(pad, { t: '⚙ ', p: { color: c.isWorking && childrenOf(c.id).length === 0 ? TONE.live : TONE.info } }, c.workflow, tagSeg(c), ' @ ', { t: c.state, p: { weight: 'bold' } },
          dim(` ${sinceText(now - c.since)}`), ...(c.agent !== '' ? agentSeg(c) : [])),
        ...execLines(c, pad + '    '),
        isLastOnly: false,
      })
      walk(c, depth + 1)
    }
  }
  walk(main, 0)
  // another root session of this Claude session is a row of its own
  for (const o of roots.filter(r => r.id !== main.id)) {
    items.push({ primary: row('  ', { t: '⚙ ', p: { color: TONE.info } }, o.workflow, tagSeg(o), ' @ ', { t: o.state, p: { weight: 'bold' } }, dim(` ${sinceText(now - o.since)}`)), ...execLines(o, '      '), isLastOnly: false })
    walk(o, 1)
  }
  const runningLines = (level: number): PaneNode[] => {
    if (level >= 2) return []
    const liveItems = items.filter(i => !i.isLastOnly)
    // the short form keeps what is alive: the rows and a running exec, no last-exec line
    const shown = level === 0 ? items : liveItems
    if (shown.length === 0) return []
    const cap = level === 0 ? RUNNING_CAP : RUNNING_CAP_SHORT
    const heading = liveItems.length > 0 ? text({ color: TONE.ok, weight: 'bold' }, fitCells(`▶ Running under it (${liveItems.length})`, columns)) : text({ dimColor: true, weight: 'bold' }, '▶ Nothing running')
    const out: PaneNode[] = [heading]
    for (const i of shown.slice(0, cap)) out.push(i.primary, ...i.live, ...(level === 0 ? i.last : []))
    if (shown.length > cap) out.push(row(dim(`  +${shown.length - cap} more`)))
    return out
  }

  // (3) the pool: the strip, this session's own leases and waiters marked, the other holders by label
  const pool = input.pool?.pool ?? null
  const counts = input.poolCounts
  const own = (l: PoolLine) => l.session !== '' && s.sessions.some(r => r.id.startsWith(l.session))
  const poolLines = (level: number): PaneNode[] => {
    if (level >= 2) return []
    if (!pool) {
      if (input.pool && input.pool.error !== '') return [row(dim(`▤ pool: ${input.pool.error}`))]
      return counts ? [row({ t: '▤ pool ', p: { color: TONE.pool, weight: 'bold' } }, dim(`held ${counts.held}/${counts.budget}`))] : []
    }
    const strip = row(
      { t: '▤ pool ', p: { color: TONE.pool, weight: 'bold' } }, `held ${pool.held}/${pool.budget} · load ${pool.load.toFixed(1)} · waiting ${pool.waiting.length}`,
      pool.starvedNote !== '' ? { t: ' STARVED', p: { color: TONE.bad, weight: 'bold' } } : '',
    )
    if (level >= 1) return [strip]
    return [
      strip,
      ...pool.leases.filter(own).map(l => row('  ', { t: '▸ ', p: { color: TONE.ok, weight: 'bold' } }, `${l.request} · ${spanText(l.ageMs)}`, dim(l.step !== '' ? ` ${l.step}` : ''), l.overrun !== null ? { t: ` OVERRUN ~${l.overrun}`, p: { color: TONE.bad, weight: 'bold' } } : '')),
      ...pool.waiting.filter(own).map(l => row('  ', { t: '◷ ', p: { color: TONE.next, weight: 'bold' } }, `${l.request} · waits ${spanText(l.ageMs)}`, dim(l.step !== '' ? ` ${l.step}` : ''))),
    ]
  }
  const holderLines = (level: number): PaneNode[] => {
    if (level >= 1 || !pool) return []
    const others = pool.leases.filter(l => !own(l))
    const out: PaneNode[] = others.slice(0, HOLDERS_CAP).map(l => row('  ', dim('· '), l.label !== '' ? l.label : l.project, dim(` ${l.request} · ${spanText(l.ageMs)}`)))
    if (others.length > HOLDERS_CAP) out.push(row(dim(`  +${others.length - HOLDERS_CAP} more`)))
    return out
  }

  // (4) the last three transitions
  const transitionLines = (level: number): PaneNode[] => {
    const last = main.recent.slice(-3).reverse()
    if (level >= 2 || last.length === 0) return []
    return [
      text({ dimColor: true, weight: 'bold' }, fitCells('↳ Last transitions', columns)),
      ...last.slice(0, level === 0 ? 3 : 1).map(m => row('  ', dim(m.from !== '' ? `${m.from} → ` : ''), m.to, dim(` ${sinceText(now - m.at)} ago`))),
    ]
  }

  const render: Record<SingleSection, (level: number) => PaneNode[]> = {
    current: currentLines, running: runningLines, pool: poolLines, holders: holderLines, transitions: transitionLines,
  }
  const level: Record<SingleSection, number> = { current: 0, running: 0, pool: 0, holders: 0, transitions: 0 }
  const layout = ['current', 'running', 'pool', 'holders', 'transitions'] as const
  const lines = () => layout.flatMap(k => render[k](level[k]))
  // fold the least important section one level at a time until the view fits
  for (;;) {
    if (lines().length <= room) break
    const next = SINGLE_FOLD_ORDER.find(k => level[k] < SINGLE_FOLD_LEVELS[k])
    if (next === undefined) break
    level[next]++
  }
  return col(lines())
}

/** The plan pane's whole body: the tab row, the chosen tab's rows, an error line and the footer. Pure. */
export function paneTree(input: PaneInput): PaneNode {
  const s = input.snapshot
  if (!s) return text({ dimColor: true }, 'Reading the workflow engine…')
  // no work queue: one view, the session tree — no tabs to choose between
  const tab: View = s.queue ? input.tab : 'sessions'
  const open = input.expanded
  const foldedNow = input.folded
  const now = input.now
  const today = 'lands-' + dayOf(now)
  const isOpen = (key: string) =>
    key.startsWith('lands-') ? landDayOpen(foldedNow, key, today) : foldedNow.includes(key) === FOLDED_BY_DEFAULT.has(key)
  // a section header of the Plan tab: a click folds or unfolds it (all unfolded by default but FOLDED_BY_DEFAULT ones and the days before today)
  const columns = input.columns
  // a long title (the Done heading with its sums) is cut with an ellipsis, never wrapped
  const header = (key: string, color: string, title: string) =>
    button('fold-' + key, { kind: 'fold', key }, [text({ color, weight: 'bold' }, fitCells(`${isOpen(key) ? '▾' : '▸'} ${title}`, columns))])
  // the `+N more` row that follows a capped list's first lines: a click lists the rest below it (▾) or caps the list again (▸), the fold kept across refreshes
  const moreRow = (key: string, label: string, indent = '') =>
    button('fold-' + key, { kind: 'fold', key }, [text({ dimColor: true }, fitCells(`${indent}${isOpen(key) ? '▾' : '▸'} ${label}`, columns))])
  const room = Math.max(4, input.rows - 6)
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
  const poolCounts = input.poolCounts
  const tabs: { id: View; key: string; label: string }[] = [
    { id: 'plan', key: '1', label: q ? `Plan ${q.running.length}/${q.window}` : 'Plan' },
    { id: 'sessions', key: '2', label: `Sessions ${s.sessions.length}` },
    { id: 'waiting', key: '3', label: `Waiting ${q?.waiting.length ?? 0}` },
    // held/budget from the cheap counts read of every refresh; bare until one answered
    { id: 'pool', key: '4', label: poolCounts ? `Pool ${poolCounts.held}/${poolCounts.budget}` : 'Pool' },
  ]
  // the kind glyph the engine's /api/queue gives each line (`kindMark`), right after the bar; a blank cell when the
  // line is not in the queue
  const markOf = (id: string) => (q && Object.hasOwn(q.marks, id) ? q.marks[id]! : ' ')
  const kindOf = (id: string) => text({ dimColor: true }, markOf(id))
  const tabRow = box(
    { flexDirection: 'row', gap: 2 },
    tabs.map(t =>
      button('tab-' + t.id, { kind: 'tab', id: t.id }, [t.id === tab ? text({ weight: 'bold', color: TONE.info }, t.label) : text({ dimColor: true }, t.label)], t.key),
    ),
  )
  const footer = text({ dimColor: true }, `updated ${age(now - s.at) || 'just now'}`)

  // a root with children ◆ bold; a working leaf (agent or exec, no
  // child) bright ⚙; any other session plain ⚙
  const sessionPlain = (r: SessionRow, depth: number) =>
    `${'  '.repeat(depth)}⚙ ${r.workflow}${r.tag !== '' ? `[${r.tag}]` : ''} @ ${r.state} ${age(now - r.since)}${open === r.id ? ' ▾' : ''}`
  const sessionLine = (r: SessionRow, depth: number, twoLines: boolean) => {
    const hasChildren = childrenOf(r.id).length > 0
    const isRoot = r.parent === '' || !byId.has(r.parent)
    const mark = isRoot && hasChildren
      ? text({ color: TONE.live, weight: 'bold' }, '◆')
      : text({ color: r.isWorking && !hasChildren ? TONE.live : TONE.info }, '⚙')
    const cardOpen = open === r.id
    const pad = '  '.repeat(depth)
    const tailText = ` ${age(now - r.since)}${cardOpen ? ' ▾' : ''}`
    const stateText = twoLines ? fitCells(r.state, Math.max(1, columns - pad.length - TAB.length - 2 - cells(tailText))) : r.state
    const state = text({ weight: cardOpen ? 'bold' : undefined }, stateText)
    const tail = text({ dimColor: true }, tailText)
    const press: PaneAction = { kind: 'expand', id: r.id }
    if (!twoLines) {
      return button('s-' + r.id, press, [
        pad, mark, ' ',
        r.workflow, r.tag !== '' ? text({ color: TONE.info }, `[${r.tag}]`) : null, ' @ ', state,
        tail,
      ])
    }
    // two lines: the workflow and its task, then the state and its age indented under them
    const room1 = Math.max(6, columns - pad.length - 2)
    const wf = fitCells(r.workflow, room1)
    const tag = r.tag !== '' ? fitCells(`[${r.tag}]`, Math.max(0, room1 - cells(wf))) : ''
    return button('s-' + r.id, press, [
      text({}, pad, mark, ' ', wf, text({ color: TONE.info }, tag), '\n', pad, TAB, '@ ', state, tail),
    ])
  }
  // The open session's card: where it came from, where it is, where it can go.
  const card = (r: SessionRow, depth: number) => {
    const pad = '  '.repeat(depth + 1)
    const path = r.recent.map(m => m.to)
    const from = r.recent.at(-1)
    return box(
      { key: 'c-' + r.id, flexDirection: 'column' },
      text({ dimColor: true }, `${pad}from  ${path.length > 1 ? '… ' + path.slice(0, -1).join(' → ') : '(start)'}${from ? `  (${age(now - from.at)} ago)` : ''}`),
      text({}, pad, text({ dimColor: true }, 'now   '), text({ weight: 'bold' }, r.state), text({ dimColor: true }, `${r.visit > 1 ? `  visit ${r.visit}` : ''}${r.isWorking ? '  working' : '  waiting'}`)),
      text({}, pad, text({ dimColor: true }, 'next  '), r.next.length > 0 ? r.next.join('  ') : text({ dimColor: true }, `(the dashboard at ${DASHBOARD} is not answering)`)),
      text({}, pad, link(`${DASHBOARD}/session/${r.id}`, 'open the graph in the dashboard')),
    )
  }
  const tree = (r: SessionRow, depth: number, twoLines: boolean): PaneNode[] => [
    sessionLine(r, depth, twoLines),
    ...(open === r.id ? [card(r, depth)] : []),
    ...childrenOf(r.id).flatMap(c => tree(c, depth + 1, twoLines)),
  ]
  const plainTree = (r: SessionRow, depth: number): string[] => [
    sessionPlain(r, depth),
    ...childrenOf(r.id).flatMap(c => plainTree(c, depth + 1)),
  ]

  let body: PaneNode
  if (!q) {
    // no work queue: the single-task view, one screen with no tabs (the height the header links, the error and the footer leave)
    body = singleTaskBody(s, input, Math.max(1, input.rows - 3 - (s.error !== '' ? 1 : 0)))
  } else if (tab === 'sessions') {
    const sessTwo = !fitsOneLine(roots.flatMap(x => plainTree(x, 0)), columns)
    const lines = roots.flatMap(r => tree(r, 0, sessTwo))
    // the height cap counts lines: a two-line row takes two
    const cap = sessTwo ? Math.max(1, Math.floor(room / 2)) : room
    body = lines.length === 0
      ? text({ dimColor: true }, 'No active workflow in this session.')
      : col(lines.slice(0, cap), lines.length > cap ? moreRow('sessions-more', `+${lines.length - cap} more`, '  ') : null, isOpen('sessions-more') ? lines.slice(cap) : null)
  } else if (tab === 'pool') {
    body = poolBody(input.pool, now, columns)
  } else if (tab === 'waiting') {
    const waitTwo = !fitsOneLine(q.waiting.map(w => `${BAR_W} ${markOf(w.id)} ${w.id}${prioGlyph(w.priority) ? ' ⇈' : ''} ${w.why}`), columns)
    // the height cap counts lines: a two-line row takes two
    const waitCap = waitTwo ? Math.max(1, Math.floor(room / 2)) : room
    body = col(
      q.waiting.length === 0 ? text({ dimColor: true }, 'Nothing waits.') : null,
      [...q.waiting.slice(0, waitCap), null, ...(isOpen('waiting-more') ? q.waiting.slice(waitCap) : [])].map(w =>
        w === null ? (q.waiting.length > waitCap ? moreRow('waiting-more', `+${q.waiting.length - waitCap} more`) : null) :
        waitTwo
          ? col(
              text({}, level(w.difficulty), ' ', kindOf(w.id), ' ', fitCells(w.id, Math.max(1, columns - (prioGlyph(w.priority) ? 10 : 8))), prioGlyph(w.priority) ? ' ' : '', prioGlyph(w.priority) ? prioCell(w.priority) : ''),
              text({ dimColor: true }, TAB, fitCells(w.why, Math.max(1, columns - TAB.length))),
            )
          : text({}, level(w.difficulty), ' ', kindOf(w.id), ' ', w.id, prioGlyph(w.priority) ? ' ' : '', prioGlyph(w.priority) ? prioCell(w.priority) : '', text({ dimColor: true }, ` ${w.why}`)),
      ),
    )
  } else {
    // Next shows up to 10, fitted to the pane; Done lists the whole day (the pane scrolls) and folds on a click
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
    const nextMore = isOpen('next-more')
    // nothing admittable now: Next lists what the running lines unblock, in the picker's order
    const nextRows = q.ready.length > 0 ? q.ready : q.unblocked
    const nextTwo = !fitsOneLine((nextMore ? nextRows : nextRows.slice(0, 10)).map(l => `  ${BAR_W} ${markOf(l.id)} ${l.id} ${prioGlyph(l.priority)?.glyph ?? ' '}`), columns)
    // the rows left for Next count lines: a two-line Running or Next row takes two
    // an Awaiting section takes its header, two lines per row and one per link
    // a snapshot of an older engine has no `awaiting`
    const awaiting = q.awaiting ?? []
    const awaitRows = awaiting.length === 0 ? 0 : 1 + awaiting.reduce((n, a) => n + 2 + a.show.length, 0)
    const spare = input.rows - 9 - q.running.length * (runTwo ? 2 : 1) - awaitRows
    const showReady = Math.max(4, Math.min(10, Math.ceil(spare / (nextTwo ? 4 : 2))))
    // a row's cost sits right after its kind, right-aligned to the section's widest figure: it is never cut, the id is
    const costCol = (all: { usd?: number; usdFloor?: number }[]) => {
      const w = Math.max(1, ...all.map(l => cells(usdText(l.usd, l.usdFloor))))
      return { w, text: (l: { usd?: number; usdFloor?: number }) => usdText(l.usd, l.usdFloor).padStart(w) }
    }
    const recentFailed = q.failedLines.filter(l => l.recent)
    const olderFailed = q.failedLines.filter(l => !l.recent)
    // the rows drawn: the recent ones, and the older ones once `+N older` is open
    const shownFailed = isOpen('failed-older') ? q.failedLines : recentFailed
    // only the rows drawn size the section: a row of a folded day is not on screen and must not widen the cost column or flip the layout
    const shownLands = isOpen('lands') ? s.lands.filter(l => isOpen('lands-' + l.at.slice(0, 5))) : []
    const landCost = costCol(shownLands)
    const failCost = costCol(shownFailed)
    const costOf = (l: { usd?: number; usdFloor?: number }, c: { text: (l: { usd?: number; usdFloor?: number }) => string }) => text({ dimColor: l.usd === undefined && l.usdFloor === undefined }, c.text(l))
    // a report row (a line that closed with no commit) names itself where a land names its sha
    const shaOf = (l: { sha: string; isReport?: true }) => (l.isReport ? REPORT_MARK : l.sha)
    const landTwo = !fitsOneLine(shownLands.map(l => `    ${BAR_W} ${markOf(l.slice)} ${landCost.text(l)} ${l.start}-${l.at.slice(6)} ${shaOf(l)} ${l.slice}`), columns)
    const stampOf = (date: string) => {
      // `YYYY-MM-DD` of the last note as `DD.MM`; a line with no dated note says so
      const when = /^\d{4}-(\d\d)-(\d\d)$/.exec(date)
      return when ? `${when[2]}.${when[1]}` : 'date unknown'
    }
    const reasonOf = (l: FailedLine) => (l.reason === '' ? 'no note' : l.reason)
    const failTwo = !fitsOneLine(shownFailed.map(l => `    ${BAR_W} ${markOf(l.id)} ${failCost.text(l)} ${l.id} ${stampOf(l.date)} ${reasonOf(l)}`), columns)
    body = col(
      text({}, text({ weight: 'bold' }, q.file.replace(/^.*\//, '')), text({ dimColor: true }, `  pending ${q.pending} · done ${q.done}${q.failed > 0 ? ` · failed ${q.failed}` : ''}`)),
      header('running', TONE.ok, `▶ Running ${q.running.length}/${q.window}`),
      isOpen('running') && q.running.length === 0 ? text({ dimColor: true }, '  nothing') : null,
      isOpen('running')
        ? q.running.map(l => {
            const p = pipelineOf.get(l.id)
            const since = sinceOf(l.id)
            if (!runTwo) {
              return text({}, '  ', level(l.difficulty), ' ', kindOf(l.id), ' ', l.id, '  ', text({ color: p ? TONE.info : TONE.warn }, whereOf(l.id)), text({ dimColor: true }, ` ${since}`))
            }
            // two lines: bar, kind, id; the state, the next step and the age indented under them
            const pad = '  ' + TAB
            return col(
              text({}, '  ', level(l.difficulty), ' ', kindOf(l.id), ' ', fitCells(l.id, Math.max(1, columns - 10))),
              text({}, pad, text({ color: p ? TONE.info : TONE.warn }, fitCells(whereOf(l.id), Math.max(1, columns - pad.length - (since === '' ? 0 : cells(since) + 1)))), text({ dimColor: true }, ` ${since}`)),
            )
          })
        : null,
      awaiting.length > 0 ? header('awaiting', TONE.warn, `⏸ Awaiting you (${awaiting.length})`) : null,
      awaiting.length > 0 && isOpen('awaiting')
        ? awaiting.map(a => {
            // the line, how long it has waited, then the question and each link indented under it
            const waited = age(now - a.since)
            const state = a.answered !== undefined ? `answered ${a.answered} · resumes first` : `waiting ${waited || '<1m'}`
            return col(
              text({}, '  ', level(a.difficulty), ' ', kindOf(a.id), ' ', fitCells(a.id, Math.max(1, columns - 10 - cells(state))), ' ', text({ color: a.answered !== undefined ? TONE.ok : TONE.warn }, state)),
              text({}, '  ', TAB, fitCells(a.question, Math.max(1, columns - 2 - TAB.length))),
              ...a.show.map(l => (/^https?:\/\//.test(l) ? text({}, '  ', TAB, link(l, fitCells(l, Math.max(1, columns - 2 - TAB.length)))) : text({ dimColor: true }, '  ', TAB, fitCells(l, Math.max(1, columns - 2 - TAB.length))))),
            )
          })
        : null,
      header('next', TONE.next, `⏭ Next (${nextRows.length})`),
      isOpen('next') && nextRows.length === 0 ? text({ dimColor: true }, '  nothing ready') : null,
      isOpen('next')
        ? [...nextRows.slice(0, showReady), null, ...(nextMore ? nextRows.slice(showReady) : [])].map(l =>
            l === null ? (nextRows.length > showReady ? moreRow('next-more', `+${nextRows.length - showReady} more ${q.ready.length > 0 ? 'can start (dependencies done)' : 'start once the running lines end'}, in the picker's order`, '  ') : null) :
            nextTwo
              // two lines: bar, kind; the id indented under them, the priority glyph after it, then what keeps it waiting
              ? col(
                  text({}, '  ', level(l.difficulty), ' ', kindOf(l.id)),
                  text({}, '  ', TAB, fitCells(l.id, Math.max(1, columns - 4 - TAB.length)), ' ', prioCell(l.priority), waitTail(l.wait, columns - 2 - TAB.length - cells(l.id) - 2)),
                )
              : text({}, '  ', level(l.difficulty), ' ', kindOf(l.id), ' ', l.id, ' ', prioCell(l.priority), waitTail(l.wait, columns - cells(`  ${BAR_W} ${markOf(l.id)} ${l.id} `) - 1)),
          )
        : null,
      header('lands', TONE.ok, doneHeading(s.lands.length, s.landedUsd, s.parentUsd, s.landBranch)),
      isOpen('lands')
        ? [...new Set(s.lands.map(l => l.at.slice(0, 5)))].flatMap(day => {
            // `at` is `DD.MM HH:MM` (numeric: locale-free): one foldable row per day with its spend, its lands one level deeper
            const mine = s.lands.filter(l => l.at.slice(0, 5) === day)
            const spend = s.days[day]
            const key = 'lands-' + day
            return [
              button('fold-' + key, { kind: 'landDay', key, today }, [text({ dimColor: true }, fitCells(`  ${isOpen(key) ? '▾' : '▸'} ▦ ${day} (${mine.length}${spend && spend.failed + spend.closed > 0 ? ' done' : ''})${spend ? ' ' + dayText(spend) : ''}`, columns))]),
              ...(isOpen(key)
                ? mine.map(l =>
                    landTwo
                      // two lines: bar, kind, cost, times, sha; the id indented under them
                      ? col(
                          text({}, '    ', level(l.difficulty), ' ', kindOf(l.slice), ' ', costOf(l, landCost), ' ', text({ dimColor: true }, fitCells(`${l.start}-${l.at.slice(6)} ${shaOf(l)}`, Math.max(1, columns - 13 - landCost.w)))),
                          text({}, '    ', TAB, fitCells(l.slice, Math.max(1, columns - 4 - TAB.length))),
                        )
                      : text({}, '    ', level(l.difficulty), ' ', kindOf(l.slice), ' ', costOf(l, landCost), ' ', text({ dimColor: true }, `${l.start}-${l.at.slice(6)} ${shaOf(l)}`), ' ', l.slice),
                  )
                : []),
            ]
          })
        : null,
      header('failed', TONE.bad, failedHeading(recentFailed.length, q.failedSpend)),
      isOpen('failed') && q.failedLines.length === 0 ? text({ dimColor: true }, '  nothing') : null,
      isOpen('failed') && q.failedLines.length > 0 && recentFailed.length === 0 ? text({ dimColor: true }, `  none in the last ${FAILED_DAYS} days`) : null,
      isOpen('failed')
        ? shownFailed.map(l => {
            const stamp = stampOf(l.date)
            if (!failTwo) {
              return text({}, '    ', level(l.difficulty), ' ', kindOf(l.id), ' ', costOf(l, failCost), ' ', l.id, ' ', text({ dimColor: true }, `${stamp} ${reasonOf(l)}`))
            }
            // two lines: bar, kind, cost, id, date; the reason indented under them
            const lead = 4 + 5 + 1 + 1 + 1 + failCost.w + 1
            const idFit = fitCells(l.id, Math.max(1, columns - lead - cells(stamp) - 1))
            const stampFit = fitCells(stamp, Math.max(1, columns - lead - cells(idFit) - 1))
            return col(
              text({}, '    ', level(l.difficulty), ' ', kindOf(l.id), ' ', costOf(l, failCost), ' ', idFit, ' ', text({ dimColor: true }, stampFit)),
              text({ dimColor: true }, '    ', TAB, fitCells(reasonOf(l), Math.max(1, columns - 4 - TAB.length))),
            )
          })
        : null,
      isOpen('failed') && olderFailed.length > 0
        ? button('fold-failed-older', { kind: 'fold', key: 'failed-older' }, [text({ dimColor: true }, fitCells(`  ${isOpen('failed-older') ? '▾' : '▸'} +${olderFailed.length} older`, columns))])
        : null,
    )
  }
  // the tab row alone on its row; under it the open tab's own dashboard view, then the live map
  const own = TAB_LINKS[tab]
  return col(
    s.queue ? tabRow : null,
    box({ flexDirection: 'row', gap: 2, key: 'header-links' }, link(`${DASHBOARD}${own.path}`, own.label), link(`${DASHBOARD}/map`, 'map ↗')),
    body,
    s.error !== '' ? text({ color: TONE.bad }, s.error) : null,
    footer,
  )
}

/** A spawn of a workflow agent, before its session is linked: `⚙ [slice] driver · opus`. */
export function spawnLine(label: string, role: string, model: string): PaneEl {
  return text({}, text({ color: TONE.info }, `⚙ [${label}] `), text({ dimColor: true }, role), model !== '' ? text({ dimColor: true }, ` · ${model}`) : null)
}

/** How a workflow agent ended, as its end notification draws it. */
export type AgentEnd =
  | { readonly kind: 'killed' | 'failed' | 'ended'; readonly state: string }
  | { readonly kind: 'landed'; readonly sha: string }

/** A workflow agent's end notification: `⚙ [slice] driver · 12m · ✓ landed abc1234` (or stopped / failed / the step it ended at). */
export function endLine(label: string, role: string, duration: string, end: AgentEnd): PaneEl {
  const outcome =
    end.kind === 'killed' ? text({ color: TONE.bad }, `✗ stopped by hand at ${end.state}`)
    : end.kind === 'failed' ? text({ color: TONE.bad }, `✗ failed at ${end.state}`)
    : end.kind === 'landed' ? text({ color: TONE.ok }, `✓ landed${end.sha !== '' ? ' ' + end.sha : ''}`)
    : text({ dimColor: true }, `ended at ${end.state}`)
  return text({}, text({ color: TONE.info }, `⚙ [${label}] `), text({ dimColor: true }, `${role}${duration !== '' ? ` · ${duration}` : ''} · `), outcome)
}

/** A driver's one-line hand-back by its outcome: landed, needs the parent (with the reason), waiting. */
export type HandBack =
  | { readonly kind: 'landed'; readonly sha: string }
  | { readonly kind: 'needs'; readonly reason: string }
  | { readonly kind: 'waiting' }

export function handBackLine(id: string, h: HandBack): PaneEl {
  const short = (r: string) => (r.length > 140 ? r.slice(0, 139) + '…' : r)
  return text(
    {},
    h.kind === 'landed' ? text({ color: TONE.ok }, `✓ [${id}] landed${h.sha !== '' ? ' ' + h.sha : ''}`)
    : h.kind === 'needs' ? text({}, text({ color: TONE.warn }, `⏸ [${id}] needs the parent: `), short(h.reason))
    : text({ dimColor: true }, `… [${id}] waiting`),
  )
}

/** One engine move of a tool group's line: the session's label when it changes, the move's name and where it went. */
export type Move = { readonly label?: string; readonly name: string; readonly to: string; readonly isErrored?: boolean }

/** A group of engine calls as the chain of moves they made: `⚙ [slice] transition→state …`, then the counted rest (`☰+1 ❯2`). */
export function movesLine(moves: readonly Move[], tail: readonly string[]): PaneEl {
  const parts: PaneNode[] = []
  for (const m of moves) {
    if (m.label !== undefined) parts.push(text({ color: TONE.info }, `[${m.label}] `))
    parts.push(text({}, text({ dimColor: true }, `${m.name}→`), text({ color: m.isErrored ? TONE.bad : TONE.live, weight: 'bold' }, m.to), ' '))
  }
  return text(
    {},
    text({ color: TONE.info }, '⚙ '),
    parts,
    tail.length > 0 ? text({ dimColor: true }, `${parts.length > 0 ? '· ' : ''}${tail.join(' ')}`) : null,
  )
}
