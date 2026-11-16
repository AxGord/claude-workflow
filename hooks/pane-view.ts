// What the plan pane draws, as data: a Snapshot (and the pane's own fold / tab / card state) in, a tree of the
// four primitives the pane is made of (box, text, button, link) out. Pure and import-free (types only), so the
// mod (hooks/plan-pane.tsx, which maps the tree onto Claude Code's elements) and the documentation site (the
// landing's scene, docs/.vitepress/theme/PaneView.vue, which maps it onto the DOM) draw the SAME pane: there is
// no second copy of its rows, glyphs, colors, bars or sections.

import type { DaySpend, FailedLine, FailedSpend, PoolCounts, PoolLine, PoolState, SessionRow, Snapshot, View } from '../types'

/** The engine's own dashboard: its API answers the workflow graphs, its page draws one session's graph. */
export const DASHBOARD = 'http://127.0.0.1:3100'
/** The pane's title, as `$.ui.open` gives it. */
export const PANE_TITLE = 'Workflow plan'
/** How far back the Landed tree goes: the Cost tab's own range. */
export const LAND_DAYS = 14
/** The Failed section lists the lines that ended within this many days; the rest fold under `+N older`. */
export const FAILED_DAYS = 2
/** Sections that start folded: a click on one unfolds it. Each `+N more` fold row of the pane is one (`next-more`, `waiting-more`, `sessions-more`): closed, the list stops at its cap; open, it lists every row. A day of the Landed tree other than today starts folded too (`lands-DD.MM`). */
export const FOLDED_BY_DEFAULT = new Set(['failed', 'failed-older', 'next-more', 'waiting-more', 'sessions-more'])

/** What a press on a button of the pane asks for: the drawer owns the state and applies it. */
export type PaneAction =
  | { readonly kind: 'fold'; readonly key: string }
  | { readonly kind: 'landDay'; readonly key: string; readonly today: string }
  | { readonly kind: 'tab'; readonly id: View }
  | { readonly kind: 'expand'; readonly id: string }
  | { readonly kind: 'pane' }

/** A text's look: a terminal color name or `#rrggbb`, dim, bold. */
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

/** `DD.MM` of a moment, in local time: the key of a day of the Landed tree. */
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

/** A queue line's priority as one cell: urgent ⇈ red, high ↑ orange, low ↓ grey; normal (or none) has no glyph. */
export const PRIO_GLYPHS: Record<string, { glyph: string; color: string }> = {
  urgent: { glyph: '⇈', color: 'red' },
  high: { glyph: '↑', color: '#ff8800' },
  low: { glyph: '↓', color: 'gray' },
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

/** `$1.23`, `$12.34`, `$123`; `—` when the line has no measured cost (never `$0.00`). */
export function usdText(usd: number | undefined): string {
  if (usd === undefined) return '—'
  return '$' + (usd < 100 ? usd.toFixed(2) : usd.toFixed(0))
}

/** A day row's spend: the sum (`—` when no line is measured) and what it includes besides landed lines. */
export function dayText(d: DaySpend): string {
  const extra = [d.failed > 0 ? `${d.failed} failed` : '', d.closed > 0 ? `${d.closed} closed` : ''].filter(x => x !== '').join(', ')
  return `${d.measured === 0 ? '—' : usdText(d.usd)}${extra !== '' ? ` incl. ${extra}` : ''}`
}

/** `✓ Landed · 14d (434) · $1234 · parent $310 (25%) · golf-int`: the count, the landed lines' spend (absent when none is measured), the parent's spend and its share of the landed sum (the share absent when there is no landed sum), the land branch when it is not `main`. */
export function landedHeading(count: number, landed: number | undefined, parent: number | undefined, branch = 'main'): string {
  const share = landed !== undefined && landed > 0 && parent !== undefined ? ` (${String(Math.round((parent / landed) * 100))}%)` : ''
  return `✓ Landed · ${LAND_DAYS}d (${count})${landed !== undefined ? ' · ' + usdText(landed) : ''}${parent !== undefined ? ' · parent ' + usdText(parent) + share : ''}${branch !== 'main' ? ' · ' + branch : ''}`
}

/** `✗ Failed (28) · $41.20 (parent $6.10) · 3 not in the ledger`: the count, the lines' spend, the parent's spend when it has one, how many lines the ledger has no row of (they add 0; `no ledger rows` when none has). */
export function failedHeading(count: number, spend: FailedSpend | undefined): string {
  const head = `✗ Failed (${count})`
  if (!spend || count === 0) return head
  const measured = count - spend.missing
  return `${head}${measured > 0 ? ' · ' + usdText(spend.usd) + (spend.parentUsd > 0 ? ` (parent ${usdText(spend.parentUsd)})` : '') : ''}${spend.missing === count ? ' · no ledger rows' : spend.missing > 0 ? ` · ${spend.missing} not in the ledger` : ''}`
}

/** The role an agent plays for the workflow its session runs. */
export function roleOf(workflow: string): string {
  if (/review/.test(workflow)) return 'reviewer'
  if (/worker/.test(workflow)) return 'worker'
  if (/recon/.test(workflow)) return 'recon'
  return 'driver'
}

/** Difficulty as a five-cell track (one cell per two points): its fill the level, its colour the model the table gives it — 1–3 sonnet (green), 4–6 sonnet/high (yellow), 7–10 opus (red). */
export function level(d: string): PaneEl {
  const n = Number(d)
  if (!Number.isFinite(n) || n < 1) return text({ dimColor: true }, '?????')
  const full = Math.min(5, Math.max(1, Math.round(n / 2)))
  return text(
    {},
    text({ color: n <= 3 ? 'green' : n <= 6 ? 'yellow' : 'red', weight: n >= 9 ? 'bold' : undefined }, '▰'.repeat(full)),
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
    const flags = (l.overrun !== null ? ` OVERRUN ~${l.overrun}` : '') + (l.isStarved ? ' STARVED' : '')
    // a read that knows no priority ('') or no age (negative: the site's replay, cut from a log that carries neither) leaves it out
    const held = (l.priority === '' ? '' : ` prio ${l.priority}`) + (l.ageMs < 0 ? '' : ` · ${spanText(l.ageMs)}`)
    // the flags keep their cells; what and for how long is cut to the rest of the line
    const lead = fitCells(`  ${mark} ${l.request}${held}`, Math.max(8, columns - cells(flags)))
    return col(
      text(
        {},
        lead,
        l.overrun !== null ? text({ color: 'red', weight: 'bold' }, ` OVERRUN ~${l.overrun}`) : null,
        l.isStarved ? text({ color: 'red', weight: 'bold' }, ' STARVED') : null,
      ),
      who === '' ? null : text({ dimColor: true }, fitCells('     ' + who, columns)),
    )
  }
  return col(
    text({ weight: 'bold' }, fitCells(`budget ${p.budget} · held ${p.held} · load ${p.load.toFixed(2)}`, columns)),
    text({ dimColor: true }, fitCells(`external ${p.external.toFixed(1)} · threshold ${p.threshold}`, columns)),
    text({ dimColor: true }, fitCells(`locks: ${p.locks.length > 0 ? p.locks.join(', ') : 'none'}`, columns)),
    p.starvedNote !== '' ? text({ color: 'red' }, fitCells(p.starvedNote, columns)) : null,
    text({ color: 'green', weight: 'bold' }, `▶ Leases (${p.leases.length})`),
    p.leases.length === 0 ? text({ dimColor: true }, '  none') : null,
    p.leases.map(l => row(l, '■')),
    text({ color: 'blue', weight: 'bold' }, fitCells(`◷ Waiting (${p.waiting.length}), in admission order`, columns)),
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
      hasChildren(main) ? text({ color: 'cyanBright', weight: 'bold' }, '◆ ') : text({ color: main.isWorking ? 'cyanBright' : 'cyan' }, '⚙ '),
      `${main.workflow}:${main.state}`,
      others > 0 ? text({ color: 'cyan' }, ` (${others})`) : null,
    ),
    q ? text({ dimColor: true }, `▶ ${q.running.length}/${q.window} · ⏭ ${q.ready.length} · ✓ ${s.recent}`) : null,
    button('band-plan', { kind: 'pane' }, [text({ color: 'cyan' }, '[plan]')], 'p'),
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
  // a long title (the Landed heading with its sums) is cut with an ellipsis, never wrapped
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
      button('tab-' + t.id, { kind: 'tab', id: t.id }, [t.id === tab ? text({ weight: 'bold', color: 'cyan' }, t.label) : text({ dimColor: true }, t.label)], t.key),
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
      ? text({ color: 'cyanBright', weight: 'bold' }, '◆')
      : text({ color: r.isWorking && !hasChildren ? 'cyanBright' : 'cyan' }, '⚙')
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
        r.workflow, r.tag !== '' ? text({ color: 'cyan' }, `[${r.tag}]`) : null, ' @ ', state,
        tail,
      ])
    }
    // two lines: the workflow and its task, then the state and its age indented under them
    const room1 = Math.max(6, columns - pad.length - 2)
    const wf = fitCells(r.workflow, room1)
    const tag = r.tag !== '' ? fitCells(`[${r.tag}]`, Math.max(0, room1 - cells(wf))) : ''
    return button('s-' + r.id, press, [
      text({}, pad, mark, ' ', wf, text({ color: 'cyan' }, tag), '\n', pad, TAB, '@ ', state, tail),
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
  if (tab === 'sessions' || (tab === 'plan' && !q)) {
    const sessTwo = !fitsOneLine(roots.flatMap(x => plainTree(x, 0)), columns)
    const lines = roots.flatMap(r => tree(r, 0, sessTwo))
    // the height cap counts lines: a two-line row takes two
    const cap = sessTwo ? Math.max(1, Math.floor(room / 2)) : room
    body = lines.length === 0
      ? text({ dimColor: true }, 'No active workflow in this session.')
      : col(lines.slice(0, cap), lines.length > cap ? moreRow('sessions-more', `+${lines.length - cap} more`, '  ') : null, isOpen('sessions-more') ? lines.slice(cap) : null)
  } else if (!q) {
    body = text({ dimColor: true }, 'No work queue in this session: the Sessions tab shows its workflow.')
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
    const nextMore = isOpen('next-more')
    // nothing admittable now: Next lists what the running lines unblock, in the picker's order
    const nextRows = q.ready.length > 0 ? q.ready : q.unblocked
    const nextTwo = !fitsOneLine((nextMore ? nextRows : nextRows.slice(0, 10)).map(l => `  ${BAR_W} ${markOf(l.id)} ${l.id} ${prioGlyph(l.priority)?.glyph ?? ' '}`), columns)
    // the rows left for Next count lines: a two-line Running or Next row takes two
    const spare = input.rows - 9 - q.running.length * (runTwo ? 2 : 1)
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
    const costOf = (u: number | undefined, c: { text: (u: number | undefined) => string }) => text({ dimColor: u === undefined }, c.text(u))
    const landTwo = !fitsOneLine(shownLands.map(l => `    ${BAR_W} ${markOf(l.slice)} ${landCost.text(l.usd)} ${l.start}-${l.at.slice(6)} ${l.sha} ${l.slice}`), columns)
    const stampOf = (date: string) => {
      // `YYYY-MM-DD` of the last note as `DD.MM`; a line with no dated note says so
      const when = /^\d{4}-(\d\d)-(\d\d)$/.exec(date)
      return when ? `${when[2]}.${when[1]}` : 'date unknown'
    }
    const reasonOf = (l: FailedLine) => (l.reason === '' ? 'no note' : l.reason)
    const failTwo = !fitsOneLine(shownFailed.map(l => `    ${BAR_W} ${markOf(l.id)} ${failCost.text(l.usd)} ${l.id} ${stampOf(l.date)} ${reasonOf(l)}`), columns)
    body = col(
      text({}, text({ weight: 'bold' }, q.file.replace(/^.*\//, '')), text({ dimColor: true }, `  pending ${q.pending} · done ${q.done}${q.failed > 0 ? ` · failed ${q.failed}` : ''}`)),
      header('running', 'green', `▶ Running ${q.running.length}/${q.window}`),
      isOpen('running') && q.running.length === 0 ? text({ dimColor: true }, '  nothing') : null,
      isOpen('running')
        ? q.running.map(l => {
            const p = pipelineOf.get(l.id)
            const since = sinceOf(l.id)
            if (!runTwo) {
              return text({}, '  ', level(l.difficulty), ' ', kindOf(l.id), ' ', l.id, '  ', text({ color: p ? 'cyan' : 'yellow' }, whereOf(l.id)), text({ dimColor: true }, ` ${since}`))
            }
            // two lines: bar, kind, id; the state, the next step and the age indented under them
            const pad = '  ' + TAB
            return col(
              text({}, '  ', level(l.difficulty), ' ', kindOf(l.id), ' ', fitCells(l.id, Math.max(1, columns - 10))),
              text({}, pad, text({ color: p ? 'cyan' : 'yellow' }, fitCells(whereOf(l.id), Math.max(1, columns - pad.length - (since === '' ? 0 : cells(since) + 1)))), text({ dimColor: true }, ` ${since}`)),
            )
          })
        : null,
      header('next', 'blue', `⏭ Next (${nextRows.length})`),
      isOpen('next') && nextRows.length === 0 ? text({ dimColor: true }, '  nothing ready') : null,
      isOpen('next')
        ? [...nextRows.slice(0, showReady), null, ...(nextMore ? nextRows.slice(showReady) : [])].map(l =>
            l === null ? (nextRows.length > showReady ? moreRow('next-more', `+${nextRows.length - showReady} more ${q.ready.length > 0 ? 'can start (dependencies done)' : 'start once the running lines end'}, in the picker's order`, '  ') : null) :
            nextTwo
              // two lines: bar, kind; the id indented under them, the priority glyph after it
              ? col(
                  text({}, '  ', level(l.difficulty), ' ', kindOf(l.id)),
                  text({}, '  ', TAB, fitCells(l.id, Math.max(1, columns - 4 - TAB.length)), ' ', prioCell(l.priority)),
                )
              : text({}, '  ', level(l.difficulty), ' ', kindOf(l.id), ' ', l.id, ' ', prioCell(l.priority)),
          )
        : null,
      header('lands', 'green', landedHeading(s.lands.length, s.landedUsd, s.parentUsd, s.landBranch)),
      isOpen('lands')
        ? [...new Set(s.lands.map(l => l.at.slice(0, 5)))].flatMap(day => {
            // `at` is `DD.MM HH:MM` (numeric: locale-free): one foldable row per day with its spend, its lands one level deeper
            const mine = s.lands.filter(l => l.at.slice(0, 5) === day)
            const spend = s.days[day]
            const key = 'lands-' + day
            return [
              button('fold-' + key, { kind: 'landDay', key, today }, [text({ dimColor: true }, fitCells(`  ${isOpen(key) ? '▾' : '▸'} ▦ ${day} (${mine.length})${spend ? ' ' + dayText(spend) : ''}`, columns))]),
              ...(isOpen(key)
                ? mine.map(l =>
                    landTwo
                      // two lines: bar, kind, cost, times, sha; the id indented under them
                      ? col(
                          text({}, '    ', level(l.difficulty), ' ', kindOf(l.slice), ' ', costOf(l.usd, landCost), ' ', text({ dimColor: true }, fitCells(`${l.start}-${l.at.slice(6)} ${l.sha}`, Math.max(1, columns - 13 - landCost.w)))),
                          text({}, '    ', TAB, fitCells(l.slice, Math.max(1, columns - 4 - TAB.length))),
                        )
                      : text({}, '    ', level(l.difficulty), ' ', kindOf(l.slice), ' ', costOf(l.usd, landCost), ' ', text({ dimColor: true }, `${l.start}-${l.at.slice(6)} ${l.sha}`), ' ', l.slice),
                  )
                : []),
            ]
          })
        : null,
      header('failed', 'red', failedHeading(recentFailed.length, q.failedSpend)),
      isOpen('failed') && q.failedLines.length === 0 ? text({ dimColor: true }, '  nothing') : null,
      isOpen('failed') && q.failedLines.length > 0 && recentFailed.length === 0 ? text({ dimColor: true }, `  none in the last ${FAILED_DAYS} days`) : null,
      isOpen('failed')
        ? shownFailed.map(l => {
            const stamp = stampOf(l.date)
            if (!failTwo) {
              return text({}, '    ', level(l.difficulty), ' ', kindOf(l.id), ' ', costOf(l.usd, failCost), ' ', l.id, ' ', text({ dimColor: true }, `${stamp} ${reasonOf(l)}`))
            }
            // two lines: bar, kind, cost, id, date; the reason indented under them
            const lead = 4 + 5 + 1 + 1 + 1 + failCost.w + 1
            const idFit = fitCells(l.id, Math.max(1, columns - lead - cells(stamp) - 1))
            const stampFit = fitCells(stamp, Math.max(1, columns - lead - cells(idFit) - 1))
            return col(
              text({}, '    ', level(l.difficulty), ' ', kindOf(l.id), ' ', costOf(l.usd, failCost), ' ', idFit, ' ', text({ dimColor: true }, stampFit)),
              text({ dimColor: true }, '    ', TAB, fitCells(reasonOf(l), Math.max(1, columns - 4 - TAB.length))),
            )
          })
        : null,
      isOpen('failed') && olderFailed.length > 0
        ? button('fold-failed-older', { kind: 'fold', key: 'failed-older' }, [text({ dimColor: true }, fitCells(`  ${isOpen('failed-older') ? '▾' : '▸'} +${olderFailed.length} older`, columns))])
        : null,
    )
  }
  return col(
    box({ flexDirection: 'row', gap: 2 }, s.queue ? tabRow : null, link(`${DASHBOARD}/map`, 'map ↗')),
    body,
    s.error !== '' ? text({ color: 'red' }, s.error) : null,
    footer,
  )
}

/** A spawn of a workflow agent, before its session is linked: `⚙ [slice] driver · opus`. */
export function spawnLine(label: string, role: string, model: string): PaneEl {
  return text({}, text({ color: 'cyan' }, `⚙ [${label}] `), text({ dimColor: true }, role), model !== '' ? text({ dimColor: true }, ` · ${model}`) : null)
}

/** How a workflow agent ended, as its end notification draws it. */
export type AgentEnd =
  | { readonly kind: 'killed' | 'failed' | 'ended'; readonly state: string }
  | { readonly kind: 'landed'; readonly sha: string }

/** A workflow agent's end notification: `⚙ [slice] driver · 12m · ✓ landed abc1234` (or stopped / failed / the step it ended at). */
export function endLine(label: string, role: string, duration: string, end: AgentEnd): PaneEl {
  const outcome =
    end.kind === 'killed' ? text({ color: 'red' }, `✗ stopped by hand at ${end.state}`)
    : end.kind === 'failed' ? text({ color: 'red' }, `✗ failed at ${end.state}`)
    : end.kind === 'landed' ? text({ color: 'green' }, `✓ landed${end.sha !== '' ? ' ' + end.sha : ''}`)
    : text({ dimColor: true }, `ended at ${end.state}`)
  return text({}, text({ color: 'cyan' }, `⚙ [${label}] `), text({ dimColor: true }, `${role}${duration !== '' ? ` · ${duration}` : ''} · `), outcome)
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
    h.kind === 'landed' ? text({ color: 'green' }, `✓ [${id}] landed${h.sha !== '' ? ' ' + h.sha : ''}`)
    : h.kind === 'needs' ? text({}, text({ color: 'yellow' }, `⏸ [${id}] needs the parent: `), short(h.reason))
    : text({ dimColor: true }, `… [${id}] waiting`),
  )
}

/** One engine move of a tool group's line: the session's label when it changes, the move's name and where it went. */
export type Move = { readonly label?: string; readonly name: string; readonly to: string; readonly isErrored?: boolean }

/** A group of engine calls as the chain of moves they made: `⚙ [slice] transition→state …`, then the counted rest (`☰+1 ❯2`). */
export function movesLine(moves: readonly Move[], tail: readonly string[]): PaneEl {
  const parts: PaneNode[] = []
  for (const m of moves) {
    if (m.label !== undefined) parts.push(text({ color: 'cyan' }, `[${m.label}] `))
    parts.push(text({}, text({ dimColor: true }, `${m.name}→`), text({ color: m.isErrored ? 'red' : 'cyanBright', weight: 'bold' }, m.to), ' '))
  }
  return text(
    {},
    text({ color: 'cyan' }, '⚙ '),
    parts,
    tail.length > 0 ? text({ dimColor: true }, `${parts.length > 0 ? '· ' : ''}${tail.join(' ')}`) : null,
  )
}
