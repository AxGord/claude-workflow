import { expect, mock, test } from 'claude-code/testing'

import { agentIdOf, daySpends, failedSpend, landedUsd, ledgerParentOf, ledgerRunsOf, ledgerSpendOf, ledgerTotalsOf, landMs, parentUsd, projectDirOf, modelOf, movedTo, poolView, queueView, spawnOf, startText } from './plan-pane'
import { SINGLE_FOLD_LEVELS, SINGLE_FOLD_ORDER, TAB_LINKS, cells, dayOf, dayText, execDeadlineMs, failedHeading, fitCells, foldFlipped, nodeText, paneTree, prioGlyph, landedHeading, spanText, usdText } from './pane-view'
import type { PaneEl, PaneNode } from './pane-view'
import type { PoolState, SessionRow, Snapshot, View } from '../types'
import { API_POOL } from './fixtures/api-pool'
import { API_QUEUE } from './fixtures/api-queue'
import { START_REPLY, TRANSITION_REPLY } from './fixtures/engine-replies'

const STATE_DIR = '/state'
const QUEUE = '/proj/.claude/batch/queue.yaml'
const SID = 'claude-1'

/** A root workflow session of this Claude session, naming the queue. */
const SESSION = JSON.stringify({
  session_id: 'wf-root',
  claude_session_id: SID,
  started_at: '2026-11-07T10:00:00Z',
  context: { queue_file: QUEUE },
  stack: [{ workflow: 'batch', current_state: 'dispatch', state_visits: { dispatch: 1 } }],
  history: [],
})

const PANE = {
  plugin: 'workflow',
  component: 'Pane',
  requestId: 'workflow-plan',
  props: { title: 'Workflow plan', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

/** The panes the engine holds open, as the test's `ui.open` / `ui.close` stand-ins keep them. */
const panes: string[] = []
/** Every URL the pane fetched, in order. */
const fetched: string[] = []
/** What GET /api/pool answers: a status, or undefined for a refused connection. */
let queueDown = false
/** `ui.open` fails (the pane cannot be seated). */
let openFails = false
let poolReply: { status: number; text: string } | undefined = { status: 200, text: JSON.stringify(API_POOL) }
/** What GET /api/pool?counts=1 answers (the tab label's cheap read): a status, or undefined for a refused connection. */
let countsReply: { status: number; text: string } | undefined = { status: 200, text: JSON.stringify({ budget: 12, held: 6 }) }
const NOW = Date.parse('2026-11-07T10:05:00Z')

/** What a session file reads as; a test that needs an agent linked to it swaps it. */
let sessionText = SESSION

/** How far past NOW the non-ticking clock reads (a test moves it to cross midnight). */
let clockShift = 0

/** How much later the session file reads as written (a test that swaps `sessionText` moves it so the pane re-reads it). */
let sessionTouch = 0

/** What GET /api/workflows answers (the graph: where a state goes, an exec's command and timeout, a driver's model); undefined: 404. */
let workflowsReply: string | undefined

/** What an exec's `.wait` file reads as (the pool wait the engine counted, ms); undefined: no such file. */
let waitFileText: string | undefined

/** Every `process.run` request, as JSON (the git log of the Landed tree). */
const ran: string[] = []

/** `ticking`: the clock moves only when the test advances it, and the 15 s refresh fires on that (returned). */
function engine(on: any, withQueue: boolean, landed?: { git: string | ((req: unknown) => string); ledger: string }, ticking = false) {
  panes.splice(0)
  fetched.splice(0)
  ran.splice(0)
  sessionText = SESSION
  clockShift = 0
  sessionTouch = 0
  queueDown = false
  openFails = false
  poolReply = { status: 200, text: JSON.stringify(API_POOL) }
  countsReply = { status: 200, text: JSON.stringify({ budget: 12, held: 6 }) }
  workflowsReply = undefined
  waitFileText = undefined
  const clock = ticking ? mock.clock(on, { now: NOW }) : undefined
  on('session.id', () => ({ value: SID }))
  if (!ticking) on('clock.now', () => ({ value: NOW + clockShift }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'WF_STATE_DIR' ? STATE_DIR : undefined }))
  on('fs.list', () => ({
    value: [
      { name: 'wf-root.json', kind: 'file', size: 1, mtimeMs: Date.parse('2026-11-07T10:04:00Z') + sessionTouch },
      ...(landed ? [{ name: 'ledger.jsonl', kind: 'file', size: 9, mtimeMs: 1 }] : []),
    ],
  }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    if (e.path.endsWith('.wait')) {
      if (waitFileText === undefined) throw new Error('ENOENT')
      return { value: waitFileText }
    }
    return { value: e.path.endsWith('ledger.jsonl') ? (landed?.ledger ?? '') : withQueue ? sessionText : sessionText.replace(`"queue_file":"${QUEUE}"`, '"x":1') }
  })
  on('process.run', (_: unknown, e: unknown) => {
    ran.push(JSON.stringify(e))
    return { value: landed ? { exitCode: 0, stdout: typeof landed.git === 'function' ? landed.git(e) : landed.git, stderr: '' } : { exitCode: 1, stdout: '', stderr: '' } }
  })
  on('http.fetch', (_: unknown, e: { url: string }) => {
    fetched.push(e.url)
    if (queueDown) throw new Error('ECONNREFUSED')
    if (e.url.endsWith('/api/workflows') && workflowsReply !== undefined) return { value: { status: 200, ok: true, headers: {}, text: workflowsReply } }
    if (e.url.endsWith('/api/pool?counts=1')) {
      if (!countsReply) throw new Error('ECONNREFUSED')
      return { value: { status: countsReply.status, ok: countsReply.status === 200, headers: {}, text: countsReply.text } }
    }
    if (e.url.endsWith('/api/pool')) {
      if (!poolReply) throw new Error('ECONNREFUSED')
      return { value: { status: poolReply.status, ok: poolReply.status === 200, headers: {}, text: poolReply.text } }
    }
    return e.url.includes('/api/queue?file=')
      ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(API_QUEUE) } }
      : { value: { status: 404, ok: false, headers: {}, text: '{}' } }
  })
  if (!ticking) on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'wf-plan' } }))
  on('ui.panes', () => ({ value: panes.map(id => ({ id })) }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    if (openFails) throw new Error('no surface')
    panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: unknown, e: { id: string }) => {
    panes.splice(panes.indexOf(e.id), 1)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  return clock
}

test('the Plan tab is drawn from the engine\'s /api/queue answer', async ($, on) => {
  engine(on, true)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Plan 1\/2/ }))?.text).toContain('Plan 1/2')
    expect(await ui.find({ type: 'Text', text: /RUN-1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /NEXT-1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /NEXT-2/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Waiting/ }))?.text).toContain('Waiting 1')
    expect(await ui.find({ type: 'Text', text: /PARK-1/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('each row shows its kind glyph right after the bar: bug ※, research ⚑, feature and an absent kind ◆, the same column in all', async ($, on) => {
  engine(on, true, { git: ['ddd444\t07.11 10:00\tDONE-1', 'eee555\t07.11 09:00\tNOT-IN-QUEUE'].join('\n'), ledger: '' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /▰▰▰▰▱ ※ RUN-1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▰▱▱▱▱ ⚑ NEXT-2 ↑/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▰▰▱▱▱ ◆ NEXT-1  / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\?\?\?\?\? ◆ — \?    -10:00 ddd444 DONE-1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\?\?\?\?\?   — \?    -09:00 eee555 NOT-IN-QUEUE/ })).toBeDefined()
  await ui.press({ key: 'tab-waiting' })
  expect(await ui.find({ type: 'Text', text: /▰▰▰▱▱ ◆ WAIT-1/ })).toBeDefined()
  await ui.unmount()
})

test('no queue: no tabs, the session tree alone', async ($, on) => {
  engine(on, false)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^Plan/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /dispatch/ })).toBeDefined()
  await ui.unmount()
})

test('the Sessions tab: a session row opens its card', async ($, on) => {
  engine(on, true)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-sessions' })
  expect(await ui.find({ type: 'Text', text: /^now {3}$/ })).toBeUndefined()
  await ui.press({ key: 's-wf-root' })
  expect(await ui.find({ type: 'Text', text: /\(start\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^now {3}$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /waiting/ })).toBeDefined()
  await ui.unmount()
})

const WF = 'mcp__plugin_workflow_wf__'
const GROUP = {
  plugin: 'workflow',
  component: 'ToolGroup',
  props: {
    isActive: false,
    isExpanded: false,
    isCallsOnly: true,
    calls: [
      { tool: WF + 'start', input: { workflow: 'pipe' }, isRunning: false, isErrored: false, isInterrupted: false, output: [{ type: 'text', text: START_REPLY }] },
      { tool: WF + 'transition', input: { session_id: 'SID', transition: 'go' }, isRunning: false, isErrored: false, isInterrupted: false, output: [{ type: 'text', text: TRANSITION_REPLY }] },
      { tool: WF + 'queue_mark', input: {}, isRunning: false, isErrored: false, isInterrupted: false, output: 'A: running → done' },
    ],
  },
} as const

test('a group of engine calls draws as its chain of moves, read off the recorded replies', async ($, on) => {
  engine(on, true)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...GROUP, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text).join('')
    expect(texts).toContain('start pipe→plan')
    expect(texts).toContain('go→work')
    expect(texts).toContain('☰✓1')
    await ui.unmount()
  }
})

/** A session of the pipeline `ENG-X` (its queue line) with the agent `a6519b13` linked to it. */
const LINKED = JSON.stringify({ ...JSON.parse(SESSION), context: { queue_file: QUEUE, task: 'ENG-X' }, agent_id: 'a6519b13' })
const HARNESS_ROW = 'HARNESS ROW'
const SPAWN_INPUT = { description: 'drive ENG-X', subagent_type: 'workflow:driver', model: 'haiku', prompt: 'P = wf-root' }
const LAUNCHED = { status: 'async_launched', isAsync: true, agentId: 'a6519b13', description: 'drive ENG-X', resolvedModel: 'claude-haiku-5-5', prompt: 'p', outputFile: '/tmp/o' }

/** An Agent call's row as the plugin sees it, over the harness's own row (`HARNESS_ROW`). */
async function agentRow($: any, on: any, session: string, props: Record<string, unknown>) {
  engine(on, true)
  sessionText = session
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{HARNESS_ROW}</Text>
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'workflow',
    component: 'ToolUse',
    surface: 'terminal',
    props: { tool: 'Agent', tool_use_id: 'toolu_1', input: SPAWN_INPUT, isRunning: false, isErrored: false, isInterrupted: false, output: LAUNCHED, ...props },
  })
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('')
  return { ui, text }
}

test('an Agent call linked to a session draws one line in the group style instead of the harness row: role, slice, model, state, age, lane link', async ($, on) => {
  const { ui, text } = await agentRow($, on, LINKED, {})
  expect(text).not.toContain(HARNESS_ROW)
  expect(text).toContain('⚙ [ENG-X] ')
  expect(text).toContain('driver')
  expect(text).toContain('haiku 5.5')
  expect(text).toContain('batch @ dispatch')
  expect(text).toContain('5m')
  expect(JSON.stringify(await ui.find({ type: 'Link' }))).toContain('http://127.0.0.1:3100/map/wf-root')
  await ui.unmount()
})

for (const running of [true, false])
  test(`an Agent call not yet linked reads as a workflow line off its own input: subagent type, description, model (${running ? 'running' : 'launched'})`, async ($, on) => {
    const { ui, text } = await agentRow($, on, SESSION, running ? { isRunning: true, output: undefined } : {})
    expect(text).not.toContain(HARNESS_ROW)
    expect(text).toContain('⚙ [ENG-X] ')
    expect(text).toContain('driver')
    expect(text).toContain(running ? 'haiku' : 'haiku 5.5')
    await ui.unmount()
  })

test('an Agent call of no workflow keeps the harness row', async ($, on) => {
  const input = { description: 'find x', subagent_type: 'Explore', model: 'haiku', prompt: 'p' }
  const { ui, text } = await agentRow($, on, SESSION, { input, output: { ...LAUNCHED, agentId: 'zzz' } })
  expect(text).toBe(HARNESS_ROW)
  await ui.unmount()
})

test('an expanded Agent row keeps the harness row', async ($, on) => {
  const { ui, text } = await agentRow($, on, LINKED, { isExpanded: true })
  expect(text).toBe(HARNESS_ROW)
  await ui.unmount()
})

for (const failure of [{ isErrored: true, output: 'Error: no such agent type' }, { isInterrupted: true }])
  test(`a failed or interrupted spawn keeps the harness row so the error stays readable (${Object.keys(failure)[0]})`, async ($, on) => {
    const { ui, text } = await agentRow($, on, LINKED, failure)
    expect(text).toBe(HARNESS_ROW)
    await ui.unmount()
  })

test('spawnOf, agentIdOf and modelOf read the call: the plugin\'s subagent types only, the result object or the text reply, the harness\'s model name', () => {
  expect(spawnOf(SPAWN_INPUT)).toEqual({ role: 'driver', label: 'ENG-X', model: 'haiku' })
  expect(spawnOf({ description: 'review the diff', subagent_type: 'workflow:reviewer' })).toEqual({ role: 'reviewer', label: 'review the diff', model: '' })
  expect(spawnOf({ description: 'x', subagent_type: 'Explore' })).toBeUndefined()
  expect(spawnOf({ description: 'x', subagent_type: 'other:workflow:driver' })).toBeUndefined()
  expect(spawnOf(undefined)).toBeUndefined()
  expect(agentIdOf(LAUNCHED)).toBe('a6519b13')
  expect(agentIdOf([{ type: 'text', text: 'Async agent launched.\nagentId: a6519b13dafdc6d3f (internal)' }])).toBe('a6519b13dafdc6d3f')
  expect(agentIdOf('Error: nope')).toBeUndefined()
  expect(agentIdOf(undefined)).toBeUndefined()
  expect(modelOf(LAUNCHED, 'haiku')).toBe('haiku 5.5')
  expect(modelOf({ resolvedModel: 'gpt-x' }, 'haiku')).toBe('gpt-x')
  expect(modelOf(undefined, 'haiku')).toBe('haiku')
})

const BAND = {
  plugin: 'workflow',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 3 },
} as const

test('the band hides while the pane is open and comes back after ui.close', async ($, on) => {
  engine(on, true)
  // the engine's own drawing, beneath the plugin: what a hidden band leaves
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ key: 'band-plan' })).toBeDefined()
  await band.press({ key: 'band-plan' })
  await band.unmount()
  const hidden = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await hidden.find({ key: 'band-plan' })).toBeUndefined()
  await hidden.unmount()
  // /wf-plan again closes the pane ($.ui.close through the plugin's own ui.close hook)
  await $.command.run({ command: 'wf-plan', args: '' })
  const back = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await back.find({ key: 'band-plan' })).toBeDefined()
  await back.unmount()
})

for (const withQueue of [true, false])
  test(`/wf-map prints the live map's URL; the pane's header links to it (${withQueue ? 'with' : 'without'} a queue)`, async ($, on) => {
    engine(on, withQueue)
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    const out = await $.command.run({ command: 'wf-map', args: '' })
    expect(JSON.stringify(out)).toContain('http://127.0.0.1:3100/map')
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const links = JSON.stringify(await ui.findAll({ type: 'Link' }))
    expect(links).toContain('http://127.0.0.1:3100/map')
    await ui.unmount()
  })

/** Every element of a pane tree, depth first. */
function elements(n: PaneNode): PaneEl[] {
  if (n === null || typeof n === 'string') return []
  if (Array.isArray(n)) return n.flatMap(elements)
  const el = n as PaneEl
  return [el, ...(el.el === 'link' ? [] : el.children.flatMap(elements))]
}

const EMPTY_QUEUE = { file: '/q', window: 3, done: 0, failed: 0, pending: 0, running: [], ready: [], unblocked: [], waiting: [], failedLines: [], marks: {} }

/** The pane's tree on a view, with or without a work queue. */
function treeOn(tab: View, withQueue = true): PaneEl[] {
  const snapshot = { at: 0, sessions: [], queue: withQueue ? EMPTY_QUEUE : null, lands: [], recent: 0, days: {}, error: '' } as unknown as Snapshot
  const tree = paneTree({ snapshot, tab, expanded: '', folded: [], now: 0, columns: 100, rows: 30, poolCounts: { held: 14, budget: 14 }, pool: null })
  return (tree as PaneEl).el === 'box' ? ((tree as PaneEl & { el: 'box' }).children as PaneEl[]) : []
}

test("the header's first link is the open tab's own dashboard view, `map ↗` beside it", () => {
  // the paths are pinned to the dashboard's `routePath` in src/dashboard-routes.test.ts
  for (const tab of ['plan', 'sessions', 'waiting', 'pool'] as const) {
    const links = elements(treeOn(tab)).filter(e => e.el === 'link') as (PaneEl & { el: 'link' })[]
    expect(links.slice(0, 2).map(l => [l.href, l.label])).toEqual([
      [`http://127.0.0.1:3100${TAB_LINKS[tab].path}`, TAB_LINKS[tab].label],
      ['http://127.0.0.1:3100/map', 'map ↗'],
    ])
  }
  // Waiting has no view of its own: the Plan view
  expect(TAB_LINKS.waiting).toEqual(TAB_LINKS.plan)
  // no queue: the pane is the Sessions tree whatever tab was chosen
  const bare = elements(treeOn('pool', false)).filter(e => e.el === 'link') as (PaneEl & { el: 'link' })[]
  expect(bare[0]!.href).toBe('http://127.0.0.1:3100/sessions')
})

test("the tab row never includes a link: it is its own row, the links on the row under it", () => {
  const rows = treeOn('pool')
  const tabRow = rows[0]!
  expect(tabRow.el).toBe('box')
  const inTabRow = elements(tabRow)
  expect(inTabRow.filter(e => e.el === 'button').map(e => (e as PaneEl & { el: 'button' }).key)).toEqual(['tab-plan', 'tab-sessions', 'tab-waiting', 'tab-pool'])
  expect(inTabRow.some(e => e.el === 'link')).toBe(false)
  const linksRow = rows[1]!
  expect(elements(linksRow).filter(e => e.el === 'link')).toHaveLength(2)
  expect(elements(linksRow).some(e => e.el === 'button')).toBe(false)
})

test('movedTo names the active frame of a nested reply, the flat line otherwise, else nothing', () => {
  expect(movedTo('slice-dispatch @ collect (visit 304)\n\nbody')).toBe('collect')
  expect(movedTo('SESSION: S\npipe @ plan\n\nPlan')).toBe('plan')
  expect(movedTo('SESSION: S @ claim')).toBe('claim')
  expect(movedTo('SESSION: S @ claim\n\n---\nDRIVER — body')).toBe('claim')
  expect(movedTo('  [0] master @ run_bug_fix (waiting)\n  [1] bug-fix @ classify ← ACTIVE\n\nbody')).toBe('classify')
  expect(movedTo('  [0] master @ a (waiting)\n  [1] mid @ b (waiting)\n  [2] leaf @ c (visit 2) ← ACTIVE\n\nx')).toBe('c')
  expect(movedTo('done, nothing here')).toBeUndefined()
})

const GIT = ['aaa111\t07.11 13:49\tL-ONE', 'bbb222\t07.11 09:10\tL-NOLEDGER', 'ccc333\t06.11 00:20\tL-MIDNIGHT'].join('\n')
const row = (task: string, started: string, difficulty?: number) =>
  JSON.stringify({ workflow: 'engine-task', task, started_at: started, ...(difficulty ? { difficulty } : {}) })
/** A finished task run as the ledger holds it: `usd` its real spend (none: the run recorded no spend), `how` how it ended. */
const ran1 = (task: string, ended: string, usd?: number, how: 'landed' | 'closed' | 'failed' = 'landed') =>
  JSON.stringify({
    workflow: 'engine-task',
    task,
    started_at: '2026-11-07T08:00:00Z',
    ended_at: ended,
    outcome: how === 'failed' ? 'abandoned' : 'completed',
    visits: how === 'landed' ? { land: 1 } : { work: 1 },
    ...(usd !== undefined ? { spend: { agents: 1, usd, input: 1, output: 1, cache_read: 1, cache_write: 1 } } : {}),
  })
const LEDGER = [row('L-ONE', '2026-11-07T11:02:00Z', 4), row('L-MIDNIGHT', '2026-11-05T12:00:00Z'), ran1('L-ONE', '2026-11-07T11:50:00Z', 1.234)].join('\n')

test('ledgerRunsOf: latest run per line, foreign rows skipped', () => {
  const text = [
    row('A', '2026-11-08T10:00:00Z', 2),
    row('A', '2026-11-08T11:00:00Z', 6),
    '{"task":"B","workflow":"other","started_at":"2026-11-08T11:00:00Z"}',
    'torn{"task"',
  ].join('\n')
  const runs = ledgerRunsOf(text)
  expect([...runs.keys()]).toEqual(['A'])
  expect(runs.get('A')?.difficulty).toBe('6')
})

test('ledgerSpendOf: a line costs the sum of its runs; one run with no spend leaves the line unmeasured, never $0; the latest run decides the outcome', () => {
  const text = [
    ran1('A', '2026-11-07T08:00:00Z', 1.5, 'failed'),
    ran1('A', '2026-11-07T09:00:00Z', 2, 'landed'),
    ran1('B', '2026-11-07T09:00:00Z', 4),
    ran1('B', '2026-11-07T10:00:00Z'),
    ran1('C', '2026-11-07T10:00:00Z', 0.5, 'closed'),
    ran1('D', '2026-11-07T10:00:00Z'),
    '{"task":"E","workflow":"other","ended_at":"2026-11-07T09:00:00Z","spend":{"usd":9}}',
    JSON.stringify({ workflow: 'engine-task', task: 'F', ended_at: '2026-11-07T09:00:00Z', outcome: 'completed', spend: { usd: 3 } }),
    'torn{"task"',
  ].join('\n')
  const m = ledgerSpendOf(text)
  expect([...m.keys()]).toEqual(['A', 'B', 'C', 'D', 'F'])
  expect(m.get('A')).toMatchObject({ usd: 3.5, outcome: 'landed' })
  expect(m.get('B')?.usd).toBeUndefined()
  expect(m.get('B')).toHaveProperty('outcome', 'landed')
  expect(m.get('C')).toMatchObject({ usd: 0.5, outcome: 'closed' })
  expect(m.get('D')?.usd).toBeUndefined()
  expect(m.get('F')).toMatchObject({ usd: 3, outcome: 'unknown' })
})

test('usdText: cents under $100, whole dollars above; no figure is `—`, never $0', () => {
  expect([usdText(1.234), usdText(0), usdText(12.345), usdText(412.6), usdText(undefined)]).toEqual(['$1.23', '$0.00', '$12.35', '$413', '—'])
})

test('landMs reads `DD.MM HH:MM` into the latest year that is not past now; dayOf is its `DD.MM`', () => {
  const now = new Date(2027, 0, 2, 10, 0).getTime()
  expect(landMs('31.12 23:50', now)).toBe(new Date(2026, 11, 31, 23, 50).getTime())
  expect(landMs('02.01 09:00', now)).toBe(new Date(2027, 0, 2, 9, 0).getTime())
  expect(landMs('garbage', now)).toBe(0)
  expect(dayOf(new Date(2027, 0, 2, 9, 0).getTime())).toBe('02.01')
})

test('daySpends: a day sums its landed lines and the failed and closed lines that ended on it, a line once; dayText says what it includes', () => {
  const spends = ledgerSpendOf(
    [
      ran1('L1', '2026-11-07T08:00:00Z', 1),
      ran1('L2', '2026-11-07T08:00:00Z'),
      ran1('X', new Date(2026, 10, 7, 12).toISOString(), 2, 'failed'),
      ran1('Y', new Date(2026, 10, 7, 12).toISOString(), 0.5, 'closed'),
      ran1('Z', new Date(2026, 10, 7, 12).toISOString(), undefined, 'failed'),
      ran1('OLD', new Date(2026, 10, 1, 12).toISOString(), 8, 'failed'),
    ].join('\n'),
  )
  const land = (slice: string, d: string): never => ({ sha: 'a', slice, at: d + ' 10:00', start: '?', difficulty: '', ...(spends.get(slice)?.usd !== undefined ? { usd: spends.get(slice)!.usd } : {}) }) as never
  const days = daySpends([land('L1', '07.11'), land('L2', '07.11'), land('L1', '07.11')], spends)
  expect(days).toEqual({ '07.11': { usd: 3.5, lines: 5, measured: 3, failed: 2, closed: 1 } })
  expect(dayText(days['07.11']!)).toBe('$3.50 incl. 2 failed, 1 closed')
  expect(dayText({ usd: 0, lines: 2, measured: 0, failed: 0, closed: 0 })).toBe('—')
  expect(dayText({ usd: 7.5, lines: 2, measured: 2, failed: 0, closed: 0 })).toBe('$7.50')
})

test('startText: the time, with its date when the run began on another day', () => {
  const at = new Date(2026, 10, 7, 23, 50).getTime()
  expect(startText(at, '08.11 00:20')).toBe('07.11 23:50')
  expect(startText(at, '07.11 23:59')).toBe('23:50')
})

/** A task run's ledger line holding the parent's stretch that ended at `to` and cost `usd`, from the conversation of project directory `project` (default: the queue's repo, `/proj`). */
const parentRow = (to: string, usd: number, project = '-proj') =>
  JSON.stringify({ workflow: 'engine-task', task: 'P', parent_spend: { conversation: 'c', project, from: '2026-11-01T00:00:00Z', to, offset: 1, usd } })

test('ledgerParentOf: the parent\'s recorded stretches; a row with no end, project or cost, a torn one and a row with none are skipped', () => {
  const text = [
    parentRow('2026-11-07T10:00:00Z', 2.5),
    parentRow('2026-11-07T11:00:00Z', 1, '-other'),
    '{"parent_spend":{"to":"nope","project":"-proj","usd":3}}',
    '{"parent_spend":{"to":"2026-11-07T10:00:00Z","project":"-proj"}}',
    '{"parent_spend":{"to":"2026-11-07T10:00:00Z","usd":4}}',
    '{"task":"A","spend":{"usd":9}}',
    'torn{"parent_spend"',
  ].join('\n')
  expect(ledgerParentOf(text).map(p => [p.project, p.usd])).toEqual([['-proj', 2.5], ['-other', 1]])
})

test('projectDirOf: the project directory name Claude Code gives a repo (every character but a letter or digit becomes a dash)', () => {
  expect(projectDirOf('/Users/axg/dev/lab/anyparse')).toBe('-Users-axg-dev-lab-anyparse')
  expect(projectDirOf('/Users/axg/.claude/x')).toBe('-Users-axg--claude-x')
})

test('landedUsd: each landed line once, a line with no spend adds nothing, none measured is no sum', () => {
  const land = (slice: string, usd?: number) => ({ sha: 'x', at: '07.11 10:00', slice, start: '10:00', difficulty: '', ...(usd !== undefined ? { usd } : {}) })
  expect(landedUsd([land('A', 1.5), land('B'), land('C', 2), land('A', 1.5)])).toBe(3.5)
  expect(landedUsd([land('A'), land('B')])).toBeUndefined()
  expect(landedUsd([])).toBeUndefined()
})

test('parentUsd: only the stretches that ended inside the 14 days and belong to the queue repo\'s project count; none recorded is no figure', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  const parent = ledgerParentOf([parentRow('2026-11-10T11:00:00Z', 10), parentRow('2026-10-27T13:00:00Z', 5), parentRow('2026-10-20T00:00:00Z', 100), parentRow('2026-11-10T11:00:00Z', 1000, '-another-repo')].join('\n'))
  expect(parentUsd(parent, now, '-proj')).toBe(15)
  expect(parentUsd(parent, now, '-another-repo')).toBe(1000)
  expect(parentUsd(parent, now, '-nobody')).toBeUndefined()
  expect(parentUsd(ledgerParentOf(parentRow('2026-10-20T00:00:00Z', 100)), now, '-proj')).toBeUndefined()
  expect(parentUsd([], now, '-proj')).toBeUndefined()
})

test('landedHeading: count, landed $, parent $ and the parent\'s share of the landed sum', () => {
  expect(landedHeading(434, 1234.4, 310.2)).toBe('✓ Landed · 14d (434) · $1234 · parent $310 (25%)')
  expect(landedHeading(434, 1234.4, undefined)).toBe('✓ Landed · 14d (434) · $1234')
  // a line with no spend adds nothing: no landed figure at all when none is measured, and no unpriced marker
  expect(landedHeading(3, undefined, undefined)).toBe('✓ Landed · 14d (3)')
  // the parent without a landed sum has no share to give
  expect(landedHeading(3, undefined, 12.5)).toBe('✓ Landed · 14d (3) · parent $12.50')
  expect(landedHeading(2, 8, 2)).toBe('✓ Landed · 14d (2) · $8.00 · parent $2.00 (25%)')
  expect(landedHeading(2, 3, 2)).toBe('✓ Landed · 14d (2) · $3.00 · parent $2.00 (67%)')
})

test('the Landed heading carries the landed lines\' $ and the parent\'s $ with its share, over the same 14 days', async ($, on) => {
  // L-ONE costs $1.234 (the one measured landed line); the parent spent $0.617 in the window, $50 on a stretch 20 days ago and $900 in another project's conversation
  const ledger = [LEDGER, parentRow('2026-11-07T11:50:00Z', 0.617), parentRow('2026-10-18T11:50:00Z', 50), parentRow('2026-11-07T11:55:00Z', 900, '-elsewhere')].join('\n')
  engine(on, true, { git: GIT, ledger })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ Landed · 14d \(3\) · \$1\.23 · parent \$0\.62 \(50%\)$/ })).toBeDefined()
  await ui.unmount()
})

test('a pane narrower than the Landed heading cuts it with an ellipsis: it never wraps', async ($, on) => {
  const ledger = [LEDGER, parentRow('2026-11-07T11:50:00Z', 0.617)].join('\n')
  engine(on, true, { git: GIT, ledger })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 }, surface: 'terminal' })
  const full = `▾ ${landedHeading(3, 1.234, 0.617)}`
  expect(cells(full)).toBeGreaterThan(30)
  expect(cells(fitCells(full, 30))).toBeLessThanOrEqual(30)
  expect(await ui.find({ type: 'Text', text: fitCells(full, 30) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: full })).toBeUndefined()
  await ui.unmount()
})

test('the Landed heading shows the landed $ and no parent figure while the ledger recorded none', async ($, on) => {
  engine(on, true, { git: GIT, ledger: LEDGER })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ Landed · 14d \(3\) · \$1\.23$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /parent/ })).toBeUndefined()
  await ui.unmount()
})

test('Landed is a tree of the last 14 days: today open, older days folded; per row the cost (`—` when not measured), per day its sum, a day folds alone', async ($, on) => {
  engine(on, true, { git: GIT, ledger: LEDGER })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(ran.some(r => r.includes('--since=14 days ago'))).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Landed · 14d \(3\)/ })).toBeDefined()
  // today: two lands, one measured; the older day's sum is there, its rows are not
  expect(await ui.find({ type: 'Text', text: /▾ ▦ 07\.11 \(2\) \$1\.23$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▸ ▦ 06\.11 \(1\) —$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▰▰▱▱▱   \$1\.23 \d\d:\d\d-13:49 aaa111 L-ONE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\?\?\?\?\? {7}— \?    -09:10 bbb222 L-NOLEDGER/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\$0/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /L-MIDNIGHT/ })).toBeUndefined()
  await ui.press({ key: 'fold-lands-06.11' })
  expect(await ui.find({ type: 'Text', text: /▾ ▦ 06\.11/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\?\?\?\?\? {7}— 05\.11 \d\d:\d\d-00:20 ccc333/ })).toBeDefined()
  await ui.press({ key: 'fold-lands-07.11' })
  expect(await ui.find({ type: 'Text', text: /L-ONE/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /L-MIDNIGHT/ })).toBeDefined()
  await ui.unmount()
})

test('a day the person folded while it was today stays folded the next day; one they opened stays open', async ($, on) => {
  engine(on, true, { git: GIT, ledger: LEDGER })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'fold-lands-07.11' })
  await ui.press({ key: 'fold-lands-06.11' })
  expect(await ui.find({ type: 'Text', text: /▸ ▦ 07\.11/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▾ ▦ 06\.11/ })).toBeDefined()
  // midnight: the pane's `today` is the next day, the folds stay as chosen
  clockShift = 24 * 3600 * 1000
  await ui.press({ key: 'tab-plan' })
  expect(await ui.find({ type: 'Text', text: /▸ ▦ 07\.11/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /L-ONE/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /▾ ▦ 06\.11/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /L-MIDNIGHT/ })).toBeDefined()
  await ui.unmount()
})

test('a row too long inside a folded day does not put the open days on two lines', async ($, on) => {
  const long = 'L-' + 'A-VERY-LONG-IDENTIFIER-'.repeat(4)
  engine(on, true, { git: [GIT, `ddd444\t06.11 08:00\t${long}`].join('\n'), ledger: LEDGER })
  const all = await paneTexts($, 60)
  // 06.11 is folded: its long row is not drawn and does not size the section
  expect(all.some(t => t.includes(long.slice(0, 12)))).toBe(false)
  expect(all.some(t => /aaa111.*L-ONE/.test(t))).toBe(true)
  // opened, the long row is drawn and the section takes the two-line form
  const open = await paneTexts($, 60, ['fold-lands-06.11'])
  expect(open.some(t => /aaa111.*L-ONE/.test(t))).toBe(false)
})

test('a driver\'s end notification drawn more than 2 days after its land still says landed: the land is looked up from the agent\'s own time, not the clock', async ($, on) => {
  engine(on, true, { git: 'aaa111\t07.11 09:00\tENG-X', ledger: '' })
  sessionText = LINKED
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{HARNESS_ROW}</Text>
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  // the refresh that sees the linked agent stamps it (the pane's first draw waits for it); 2.5 days later the agent is no
  // longer linked (so it is not stamped again) and the session is still fresh, so the land stays in the snapshot
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /aaa111/ })).toBeDefined()
  await pane.unmount()
  sessionText = SESSION
  sessionTouch = 1000
  clockShift = 2.5 * 24 * 3600 * 1000
  const ui = await $.ui.mount({
    plugin: 'workflow',
    component: 'UserMessage',
    surface: 'terminal',
    props: { origin: { kind: 'task-notification' }, task: { id: 'a6519b13', status: 'completed', durationMs: 120000 }, isExpanded: false },
  })
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('')
  expect(text).toContain('⚙ [ENG-X] ')
  expect(text).toContain('✓ landed aaa111')
  await ui.unmount()
})

test('ready lines come in the picker\'s order, the priority named', () => {
  const view = queueView('/proj/q.yaml', API_QUEUE as never)
  expect(view.ready.map(l => l.id)).toEqual(['NEXT-2', 'NEXT-1'])
  expect(view.ready[0].priority).toBe('high')
})

// Waiting is in the picker's own visiting order: the engine's `admitOrder` (priority, then file order), not the file's
test('Waiting lists the lines in the picker\'s order: a high line below a low one in the file shows above it', () => {
  const held = (id: string, extra: object) => ({ id, status: 'pending' as const, exclusive: false, paused: false, reason: 'overlaps RUN (exclusive RUN)', ...extra })
  const view = queueView('/q.yaml', {
    batchSize: 1,
    lines: [
      held('W-LOW', { priority: 'low', admitOrder: 2 }),
      held('W-NORMAL', { admitOrder: 1 }),
      held('W-HIGH', { priority: 'high', admitOrder: 0 }),
      held('W-OLD-ENGINE', {}),
    ],
  })
  expect(view.waiting.map(w => w.id)).toEqual(['W-HIGH', 'W-NORMAL', 'W-LOW', 'W-OLD-ENGINE'])
  // an answer with no `admitOrder` at all keeps the file's order
  const plain = queueView('/q.yaml', { batchSize: 1, lines: [held('B', {}), held('A', {})] })
  expect(plain.waiting.map(w => w.id)).toEqual(['B', 'A'])
})

test('the Waiting tab draws the top row first: the high line, though it sits below a low one in the file', async ($, on) => {
  engine(on, true)
  const saved = API_QUEUE.lines.splice(0, API_QUEUE.lines.length)
  const base = saved.find(l => l.id === 'WAIT-1')!
  API_QUEUE.lines.push(
    { ...base, id: 'W-LOW', priority: 'low', admitOrder: 1 },
    { ...base, id: 'W-HIGH', priority: 'high', admitOrder: 0 },
  ) as never
  try {
    const all = await paneTexts($, 100, ['tab-waiting'])
    const order = all.map(t => /W-(LOW|HIGH)/.exec(t)?.[0]).filter(Boolean)
    expect(order).toEqual(['W-HIGH', 'W-LOW'])
  } finally {
    API_QUEUE.lines.splice(0, API_QUEUE.lines.length, ...saved)
  }
})

// the engine's /api/queue answer for one running exclusive line and pending lines of its repo: `unblockOrder` is the picker's own
// pass with the running lines done; a line kept out by something else (`after:` a pending line) has none
const unblockQueue = (pending: { id: string; unblockOrder?: number; priority?: string }[]) => {
  const base = API_QUEUE.lines.find(l => l.id === 'NEXT-1')!
  const mk = (id: string, status: string, extra: object = {}) => ({ ...base, id, status, priority: undefined, pickOrder: undefined, ...extra })
  return {
    ...API_QUEUE,
    lines: [mk('EXCL-RUN', 'running', { exclusive: true, reason: undefined }), ...pending.map(p => mk(p.id, 'pending', { reason: 'overlaps EXCL-RUN (exclusive EXCL-RUN)', ...p }))],
  }
}

test('nothing admittable: Next lists what the running lines unblock, in the picker\'s order; a line still blocked after them is not listed', () => {
  const view = queueView('/proj/q.yaml', unblockQueue([
    { id: 'P-2', unblockOrder: 1 },
    { id: 'P-AFTER' },
    { id: 'P-1', unblockOrder: 0, priority: 'high' },
  ]) as never)
  expect(view.ready).toEqual([])
  expect(view.unblocked.map(l => l.id)).toEqual(['P-1', 'P-2'])
  expect(view.unblocked[0].priority).toBe('high')
  expect(queueView('/proj/q.yaml', API_QUEUE as never).unblocked).toEqual([])
})

test('Next: with a running exclusive line the pane lists the two lines it unblocks and not the one that waits for a pending line', async ($, on) => {
  engine(on, true)
  const saved = API_QUEUE.lines.splice(0, API_QUEUE.lines.length)
  API_QUEUE.lines.push(...(unblockQueue([{ id: 'P-1', unblockOrder: 0 }, { id: 'P-2', unblockOrder: 1 }, { id: 'P-AFTER' }]).lines as never[]))
  try {
    const all = (await paneTexts($, 100, [])).join('\n')
    expect(all).toContain('Next (2)')
    expect(all).not.toContain('nothing ready')
    expect(all).toContain('P-1')
    expect(all).toContain('P-2')
    // P-AFTER shows in Waiting only (a tab the pane has not opened)
    expect(all).not.toContain('P-AFTER')
  } finally {
    API_QUEUE.lines.splice(0, API_QUEUE.lines.length, ...saved)
  }
})

test('Next: nothing pending keeps `nothing ready`', async ($, on) => {
  engine(on, true)
  const saved = API_QUEUE.lines.splice(0, API_QUEUE.lines.length)
  API_QUEUE.lines.push(...(unblockQueue([]).lines as never[]))
  try {
    const all = (await paneTexts($, 100, [])).join('\n')
    expect(all).toContain('Next (0)')
    expect(all).toContain('nothing ready')
  } finally {
    API_QUEUE.lines.splice(0, API_QUEUE.lines.length, ...saved)
  }
})

test('failed lines come newest first, undated last, each with its reason', () => {
  const view = queueView('/proj/q.yaml', API_QUEUE as never, NOW)
  expect(view.failedLines.map(l => l.id)).toEqual(['FAIL-LONG', 'FAIL-NEW', 'FAIL-OLD', 'FAIL-BARE'])
  expect(view.failedLines.slice(1)).toEqual([
    { id: 'FAIL-NEW', difficulty: '', date: '2026-11-07', reason: 'closed as a split', recent: true },
    { id: 'FAIL-OLD', difficulty: '4', date: '2026-11-06', reason: 'gate red: the suite', recent: false },
    { id: 'FAIL-BARE', difficulty: '', date: '', reason: '', recent: false },
  ])
})

test('a line that ended today shows; one that ended 3 days ago and one with no `ended` are older; the header count is of the recent ones', () => {
  const at = (ended?: string) => ({ id: 'X' + (ended ?? 'NONE'), status: 'failed' as const, exclusive: false, paused: false, ...(ended ? { ended } : {}) })
  const now = new Date(2026, 10, 9, 12).getTime()
  const view = queueView('/q.yaml', { batchSize: 1, lines: [at('2026-11-09'), at('2026-11-06'), at()] }, now)
  expect(view.failedLines.map(l => [l.id, l.recent])).toEqual([['X2026-11-09', true], ['X2026-11-06', false], ['XNONE', false]])
  expect(view.failed).toBe(1)
  // the edge: two days ago is still recent
  expect(queueView('/q.yaml', { batchSize: 1, lines: [at('2026-11-07')] }, now).failedLines[0].recent).toBe(true)
})

test('Failed is folded by default, shows its count, and unfolds on a click with bar, id, date and reason per row', async ($, on) => {
  engine(on, true)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  // wide enough for the longest reason: the one-line form
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 200 }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /▸ ✗ Failed \(2\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /FAIL-NEW/ })).toBeUndefined()
  await ui.press({ key: 'fold-failed' })
  expect(await ui.find({ type: 'Text', text: /▾ ✗ Failed \(2\)/ })).toBeDefined()
  // the two older lines sit under one row until it is pressed
  expect(await ui.find({ type: 'Text', text: /▸ \+2 older/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /FAIL-OLD|FAIL-BARE/ })).toBeUndefined()
  await ui.press({ key: 'fold-failed-older' })
  expect(await ui.find({ type: 'Text', text: /▾ \+2 older/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▰▰▱▱▱ ※ — FAIL-OLD 06\.11 gate red: the suite/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\?\?\?\?\? ◆ — FAIL-NEW 07\.11 closed as a split/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\?\?\?\?\? ◆ — FAIL-BARE date unknown no note/ })).toBeDefined()
  const order = (await ui.findAll({ type: 'Text', text: /FAIL-/ })).map(t => /FAIL-\w+/.exec(t.text)?.[0])
  expect(order).toEqual(['FAIL-LONG', 'FAIL-NEW', 'FAIL-OLD', 'FAIL-BARE'])
  await ui.press({ key: 'fold-failed' })
  expect(await ui.find({ type: 'Text', text: /FAIL-NEW/ })).toBeUndefined()
  await ui.unmount()
})

/** A task's ledger row with the parent's own spend of that stretch beside the agents' (`parent_spend`). */
const withParent = (row: string, usd: number) => JSON.stringify({ ...JSON.parse(row), parent_spend: { conversation: 'c1', project: '-proj', from: '2026-11-07T08:00:00Z', to: '2026-11-07T09:00:00Z', usd } })

test('ledgerTotalsOf sums every run of a line: the agents\' usd and the parent\'s, a row with neither adding 0 and marking its line unmeasured, a row with no task skipped', () => {
  const text = [
    ran1('F-1', noon(5), 1.5, 'failed'),
    withParent(ran1('F-1', noon(6), 2, 'failed'), 0.25),
    ran1('F-2', noon(6), undefined, 'failed'),
    '{"workflow":"x","spend":{"usd":99}}',
    'not json',
  ].join('\n')
  expect([...ledgerTotalsOf(text)]).toEqual([['F-1', { usd: 3.5, parentUsd: 0.25 }], ['F-2', { usd: 0, parentUsd: 0, isUnmeasured: true }]])
})

test('ledgerTotalsOf: a row nested under a same-task row adds only its parent spend (the parent row\'s spend already covers it); a row under another task\'s row counts whole', () => {
  const row = (task: string, session: string, parent: string | null, usd: number, parentUsd?: number) =>
    JSON.stringify({ workflow: 'x', task, session_id: session, parent_session_id: parent, spend: { usd }, ...(parentUsd !== undefined ? { parent_spend: { usd: parentUsd } } : {}) })
  const text = [row('F-1', 'pipe', null, 5, 0.5), row('F-1', 'recon', 'pipe', 2, 0.25), row('F-2', 'other', 'pipe', 1)].join('\n')
  expect([...ledgerTotalsOf(text)]).toEqual([['F-1', { usd: 5, parentUsd: 0.75 }], ['F-2', { usd: 1, parentUsd: 0 }]])
})

test('failedSpend sums the counted lines and counts the ones the ledger has no row of; the heading says both, the parent only when it spent', () => {
  const line = (id: string) => ({ id, difficulty: '', date: '', reason: '', recent: true })
  const totals = new Map([['F-1', { usd: 3.5, parentUsd: 0.25 }], ['F-2', { usd: 0, parentUsd: 0 }]])
  const sp = failedSpend([line('F-1'), line('F-2'), line('F-3')], totals)
  expect(sp).toEqual({ usd: 3.5, parentUsd: 0.25, missing: 1 })
  expect(failedSpend([line('F-1'), line('F-2')], new Map([['F-1', { usd: 3.5, parentUsd: 0 }], ['F-2', { usd: 2, parentUsd: 1, isUnmeasured: true as const }]]))).toEqual({ usd: 3.5, parentUsd: 0, missing: 0, unmeasured: 1 })
  expect(failedHeading(3, sp)).toBe('✗ Failed (3) · $3.50 (parent $0.25) · 1 not in the ledger')
  expect(failedHeading(2, { usd: 41.2, parentUsd: 0, missing: 0 })).toBe('✗ Failed (2) · $41.20')
  expect(failedHeading(2, { usd: 0, parentUsd: 0, missing: 2 })).toBe('✗ Failed (2) · no ledger rows')
  expect(failedHeading(0, { usd: 0, parentUsd: 0, missing: 0 })).toBe('✗ Failed (0)')
  expect(failedHeading(2, undefined)).toBe('✗ Failed (2)')
  expect(failedHeading(3, { usd: 3.5, parentUsd: 0, missing: 0, unmeasured: 1 })).toBe('✗ Failed (3) · $3.50 · 1 unmeasured')
  expect(failedHeading(1, { usd: 0, parentUsd: 0, missing: 0, unmeasured: 1 })).toBe('✗ Failed (1) · 1 unmeasured')
})

test('the Failed header carries the summed spend of the lines it counts over every run of each, the parent beside it, and how many the ledger lacks', async ($, on) => {
  const ledger = [ran1('FAIL-LONG', noon(6), 2, 'failed'), withParent(ran1('FAIL-LONG', noon(7), 7.5, 'failed'), 1.25), ran1('FAIL-OLD', noon(7), 100, 'failed')].join('\n')
  engine(on, true, { git: '', ledger })
  const all = await paneTexts($, 200)
  // the recent lines are FAIL-LONG and FAIL-NEW (no row); FAIL-OLD is older and not summed
  expect(all.some(t => t.includes('✗ Failed (2) · $9.50 (parent $1.25) · 1 not in the ledger'))).toBe(true)
})

/** A ledger run ended at noon, local time, of the given `DD` of November 2026. */
const noon = (d: number) => new Date(2026, 10, d, 12).toISOString()
const DAY_GIT = ['aaa111\t07.11 13:49\tL-ONE', 'bbb222\t07.11 09:10\tL-TWO', 'ccc333\t07.11 08:00\tL-THREE'].join('\n')
const DAY_LEDGER = [
  ran1('L-ONE', noon(7), 1.5),
  ran1('L-TWO', noon(7), 2.25),
  ran1('L-THREE', noon(7)),
  ran1('FAIL-OLD', noon(7), 3, 'failed'),
  ran1('FAIL-LONG', noon(7), 7.5, 'failed'),
  ran1('CLOSED-1', noon(7), 0.5, 'closed'),
].join('\n')

test('a day header sums its landed lines and the failed and closed lines that ended that day, and says so', async ($, on) => {
  engine(on, true, { git: DAY_GIT, ledger: DAY_LEDGER })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 200 }, surface: 'terminal' })
  // 1.5 + 2.25 landed, 3 + 7.5 failed, 0.5 closed; L-THREE has no spend: 5 of 6 lines measured
  expect((await ui.find({ type: 'Text', text: /▦ 07\.11/ }))?.text).toBe('  ▾ ▦ 07.11 (3 landed) $14.75 incl. 2 failed, 1 closed')
  // each landed row its own line cost; the unmeasured one `—`
  expect(await ui.find({ type: 'Text', text: /\$1\.50 \d\d:\d\d-13:49 aaa111 L-ONE|\$1\.50 \?    -13:49 aaa111 L-ONE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / {4}— .*ccc333 L-THREE/ })).toBeDefined()
  await ui.unmount()
})

test('a day whose every line is measured states its sum alone; a day with none says `—`, never $0', () => {
  const days = daySpends(
    [{ sha: 'a', slice: 'A', at: '07.11 10:00', start: '?', difficulty: '', usd: 2 }, { sha: 'b', slice: 'B', at: '06.11 10:00', start: '?', difficulty: '' }],
    new Map(),
  )
  expect(dayText(days['07.11']!)).toBe('$2.00')
  expect(dayText(days['06.11']!)).toBe('—')
})

test('Failed: each row carries the line\'s cost in front of its id, `—` when the ledger has none', async ($, on) => {
  engine(on, true, { git: '', ledger: DAY_LEDGER })
  const all = await paneTexts($, 200, ['fold-failed', 'fold-failed-older'])
  expect(all.some(t => /▰▰▱▱▱ ※ \$3\.00 FAIL-OLD 06\.11 gate red: the suite/.test(t))).toBe(true)
  expect(all.some(t => /\$7\.50 FAIL-LONG/.test(t))).toBe(true)
  expect(all.some(t => /\?\?\?\?\? ◆ {5}— FAIL-NEW 07\.11/.test(t))).toBe(true)
  expect(all.some(t => t.includes('$0'))).toBe(false)
})

test('a narrow pane keeps the cost and cuts the id: Landed and Failed rows on two lines, none past the width', async ($, on) => {
  const LONG = 'L-AN-IDENTIFIER-THAT-IS-VERY-LONG'
  engine(on, true, { git: [`ddd444\t07.11 13:49\t${LONG}`, DAY_GIT].join('\n'), ledger: [DAY_LEDGER, ran1(LONG, noon(7), 12.5)].join('\n') })
  const all = await paneTexts($, 30, ['fold-failed', 'fold-failed-older'])
  const land = all.find(t => t.includes('$12.50')) ?? ''
  // the first line is cut (times, sha) before the cost is
  expect(land).toMatch(/\$12\.50 .*…$/)
  expect(all.some(t => t.includes('L-AN-IDENT') && t.includes('…'))).toBe(true)
  const fail = all.find(t => t.includes('$7.50') && !t.includes('Failed')) ?? ''
  expect(fail).toContain('…')
  expect(fail).toMatch(/FAIL-/)
  for (const t of [land, fail, ...all.filter(t => /L-AN-|FAIL-|▦/.test(t))]) expect(cells(t)).toBeLessThanOrEqual(30)
})

test('the band counts the lands of the last 24 hours, the tree holds 14 days', async ($, on) => {
  engine(on, true, { git: ['aaa111\t07.11 09:00\tL-ONE', 'bbb222\t04.11 09:00\tL-OLD'].join('\n'), ledger: '' })
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /· ✓ 1$/ })).toBeDefined()
  await band.unmount()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Landed · 14d \(2\)/ })).toBeDefined()
  await ui.unmount()
})

/** Every Text of a pane mounted `columns` wide after the given presses. */
async function paneTexts($: any, columns: number, presses: string[] = []): Promise<string[]> {
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: columns }, surface: 'terminal' })
  for (const key of presses) await ui.press({ key })
  const all = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  await ui.unmount()
  return all
}

test('Failed: all rows fit one line each; one reason too long puts EVERY row on two lines, the reason indented and cut with an ellipsis, a width change flips the form', async ($, on) => {
  engine(on, true)
  const wide = await paneTexts($, 200, ['fold-failed', 'fold-failed-older'])
  expect(wide.some(t => /FAIL-OLD 06\.11 gate red: the suite/.test(t))).toBe(true)
  const narrow = await paneTexts($, 50) // the fold persists: the section is still open
  // FAIL-LONG's reason does not fit 50 cells, so FAIL-OLD, which would, is on two lines as well
  expect(narrow.some(t => /FAIL-OLD 06\.11/.test(t) && !t.includes('gate red'))).toBe(true)
  const second = narrow.filter(t => /^ {5,}\S/.test(t) && /gate red|closed as a split|no note|a reason that/.test(t))
  expect(second).toHaveLength(4)
  expect(second.find(t => t.includes('a reason that'))).toMatch(/…$/)
  for (const t of narrow.filter(t => /FAIL-|reason that|gate red|closed as|no note/.test(t))) expect(cells(t)).toBeLessThanOrEqual(50)
})

test('Next: every row on one line while they fit; one row too long for the pane puts EVERY row on two lines, the id indented', async ($, on) => {
  engine(on, true)
  const long = { ...API_QUEUE.lines.find(l => l.id === 'NEXT-1')!, id: 'NEXT-WITH-A-LONG-ID' }
  API_QUEUE.lines.push(long as never)
  try {
    const wide = await paneTexts($, 100)
    expect(wide.some(t => /▰▱▱▱▱ ⚑ NEXT-2 ↑/.test(t))).toBe(true)
    expect(wide.some(t => /NEXT-1/.test(t) && !/^ {5,}\S/.test(t))).toBe(true)
    // `  ▰▰▱▱▱ ◆ NEXT-1  ` is 18 cells and fits 20; the long row (31 cells) does not: the short rows go to two lines too
    const narrow = await paneTexts($, 20)
    expect(narrow.some(t => /NEXT-[12]/.test(t) && !/^ {5,}\S/.test(t))).toBe(false)
    expect(narrow.filter(t => /^ {5,}NEXT-/.test(t))).toHaveLength(3)
    expect(narrow.some(t => /^ {5,}NEXT-2 ↑$/.test(t))).toBe(true)
  } finally {
    API_QUEUE.lines.pop()
  }
})

test('priority glyphs: urgent red, high orange, low grey, normal and none no glyph; the text form is gone', () => {
  expect(prioGlyph('urgent')).toEqual({ glyph: '⇈', color: 'red' })
  expect(prioGlyph('high')).toEqual({ glyph: '↑', color: '#ff8800' })
  expect(prioGlyph('low')).toEqual({ glyph: '↓', color: 'gray' })
  expect(prioGlyph('normal')).toBeUndefined()
  expect(prioGlyph(undefined)).toBeUndefined()
  expect(prioGlyph('constructor')).toBeUndefined()
})

test('Next: the priority glyph follows the id after ONE space, never padded to a column; no row prints [priority]', async ($, on) => {
  engine(on, true)
  const wide = await paneTexts($, 100)
  expect(wide.some(t => /\[(urgent|high|low|normal)\]/.test(t))).toBe(false)
  expect(wide.some(t => /◆ NEXT-1 {1,2}$/.test(t))).toBe(true)
  expect(wide.some(t => /⚑ NEXT-2 ↑/.test(t))).toBe(true)
  expect(wide.some(t => /[↑⇈↓] NEXT-/.test(t))).toBe(false)
})

test('Waiting: the one-line form while every reason fits; otherwise EVERY row on two lines, the reason indented and cut with an ellipsis', async ($, on) => {
  engine(on, true)
  const wide = await paneTexts($, 100, ['tab-waiting'])
  expect(wide.some(t => /▰▰▰▱▱ ◆ WAIT-1 after: NEXT-1 \(pending\)/.test(t))).toBe(true)
  const narrow = await paneTexts($, 30, ['tab-waiting'])
  expect(narrow.some(t => t.includes('WAIT-1') && !t.includes('after:'))).toBe(true)
  expect(narrow.some(t => /^ {3,}\S/.test(t) && t.includes('after:'))).toBe(true)
  const tight = await paneTexts($, 14, ['tab-waiting'])
  expect(tight.find(t => t.includes('after:'))).toMatch(/…$/)
})

test('Waiting: the height cap counts lines, so a two-line list shows half as many rows and says how many more', async ($, on) => {
  engine(on, true)
  const extra = Array.from({ length: 30 }, (_, i) => ({ ...API_QUEUE.lines.find(l => l.id === 'WAIT-1')!, id: `W-${String(i).padStart(2, '0')}` }))
  API_QUEUE.lines.push(...(extra as never[]))
  try {
    const wide = await paneTexts($, 100, ['tab-waiting'])
    expect(wide.filter(t => /^.*W-\d\d after: /.test(t))).toHaveLength(23)
    expect(wide.some(t => /^▸ \+7 more$/.test(t))).toBe(true)
    const narrow = await paneTexts($, 30)
    // 31 waiting rows at 24 lines of room: 12 rows of two lines, not 24
    expect(narrow.filter(t => /^ {3,}after: /.test(t))).toHaveLength(12)
    expect(narrow.some(t => /^▸ \+19 more$/.test(t))).toBe(true)
  } finally {
    API_QUEUE.lines.splice(-30)
  }
})

test('Waiting: a high line shows its glyph after the id, a normal line none', async ($, on) => {
  engine(on, true)
  const base = API_QUEUE.lines.find(l => l.id === 'WAIT-1')!
  API_QUEUE.lines.push({ ...base, id: 'WAIT-HI', priority: 'high' } as never, { ...base, id: 'WAIT-NO', priority: 'normal' } as never)
  try {
    const wide = await paneTexts($, 100, ['tab-waiting'])
    expect(wide.some(t => /◆ WAIT-HI ↑/.test(t))).toBe(true)
    expect(wide.some(t => /WAIT-NO +after:/.test(t) && !/[↑⇈↓]/.test(t))).toBe(true)
  } finally {
    API_QUEUE.lines.splice(-2)
  }
})

test('foldFlipped: a key joins the fold list when it was absent and leaves it when present', () => {
  expect(foldFlipped([], 'next-more')).toEqual(['next-more'])
  expect(foldFlipped(['failed', 'next-more'], 'next-more')).toEqual(['failed'])
})

/** `n` more ready lines after the fixture's two, in the order the picker gives them (the fixture's own take 0 and 1). */
const readyExtra = (n: number, priority?: string) =>
  Array.from({ length: n }, (_, i) => ({
    ...API_QUEUE.lines.find(l => l.id === 'NEXT-1')!,
    id: `R-${String(i).padStart(2, '0')}`,
    pickOrder: 2 + i,
    ...(priority && i === n - 1 ? { priority } : {}),
  }))

test('Next: the `+N more` row is a fold row, closed by default; pressed, it lists every folded line in the picker\'s order with the same row form, and pressed again it closes', async ($, on) => {
  engine(on, true)
  const extra = readyExtra(12, 'urgent')
  API_QUEUE.lines.push(...(extra as never[]))
  try {
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const rows = async () => (await ui.findAll({ type: 'Text', text: /R-\d\d/ })).map((t: any) => /R-\d\d/.exec(t.text)![0])
    // 14 ready lines, 10 shown: 4 are folded, behind one closed row
    expect(await ui.find({ type: 'Text', text: /^ {2}▸ \+4 more can start \(dependencies done\), in the picker's order$/ })).toBeDefined()
    expect(await rows()).toHaveLength(8)
    await ui.press({ key: 'fold-next-more' })
    expect(await ui.find({ type: 'Text', text: /^ {2}▾ \+4 more can start/ })).toBeDefined()
    // all 12, in the picker's order, the last one with its glyph one space after the id
    expect(await rows()).toEqual(extra.map(l => l.id))
    expect(await ui.find({ type: 'Text', text: /^ {2}▰▰▱▱▱ ◆ R-11 ⇈$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ {2}▰▰▱▱▱ ◆ R-10 {2}$/ })).toBeDefined()
    await ui.press({ key: 'fold-next-more' })
    expect(await rows()).toHaveLength(8)
    expect(await ui.find({ type: 'Text', text: /▸ \+4 more can start/ })).toBeDefined()
    await ui.unmount()
  } finally {
    API_QUEUE.lines.splice(-12)
  }
})

test('the `+N more` fold survives a refresh and a reopened pane', async ($, on) => {
  const clock = engine(on, true, undefined, true)!
  API_QUEUE.lines.push(...(readyExtra(12) as never[]))
  try {
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    await clock.settle()
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'fold-next-more' })
    expect(await ui.find({ type: 'Text', text: /R-11/ })).toBeDefined()
    await clock.advance(15000)
    expect(await ui.find({ type: 'Text', text: /R-11/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▾ \+4 more can start/ })).toBeDefined()
    await ui.unmount()
    const again = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await again.find({ type: 'Text', text: /R-11/ })).toBeDefined()
    await again.unmount()
  } finally {
    API_QUEUE.lines.splice(-12)
  }
})

test('Waiting: the `+N more` row folds out the same way, every waiting line in the same row form, one mechanism with Next\'s', async ($, on) => {
  engine(on, true)
  const extra = Array.from({ length: 30 }, (_, i) => ({ ...API_QUEUE.lines.find(l => l.id === 'WAIT-1')!, id: `W-${String(i).padStart(2, '0')}` }))
  API_QUEUE.lines.push(...(extra as never[]))
  try {
    const open = await paneTexts($, 100, ['tab-waiting', 'fold-waiting-more'])
    expect(open.filter(t => /^.*W-\d\d after: /.test(t))).toHaveLength(30)
    expect(open.some(t => /WAIT-1 after: NEXT-1/.test(t))).toBe(true)
    expect(open.some(t => /^▾ \+7 more$/.test(t))).toBe(true)
    // pressed again: capped, as before
    const closed = await paneTexts($, 100, ['fold-waiting-more'])
    expect(closed.filter(t => /^.*W-\d\d after: /.test(t))).toHaveLength(23)
    expect(closed.some(t => /^▸ \+7 more$/.test(t))).toBe(true)
  } finally {
    API_QUEUE.lines.splice(-30)
  }
})

test('Sessions: a tree row too long for the pane puts EVERY row on two lines, the state indented under the workflow', async ($, on) => {
  engine(on, true)
  const wide = await paneTexts($, 100, ['tab-sessions'])
  expect(wide.some(t => t === 'dispatch')).toBe(true) // one line: bare strings in the button, the state its own Text
  expect(wide.some(t => t.includes('@ dispatch'))).toBe(false)
  const narrow = await paneTexts($, 12, ['tab-sessions'])
  const row = narrow.find(t => t.includes('\n')) ?? ''
  // `⚙ batch` on the first line, `    @ di… 5m` indented under it, the state cut, each line within the pane
  expect(row.split('\n')).toHaveLength(2)
  expect(row.split('\n')[0]).toMatch(/^.*⚙ batch$/)
  expect(row.split('\n')[1]).toMatch(/^ {4,}@ di…/)
  for (const line of row.split('\n')) expect(cells(line)).toBeLessThanOrEqual(12)
})

const poolFetches = () => fetched.filter(u => u.endsWith('/api/pool')).length

test('the Pool tab reads /api/pool only while the pane is open on it: never on the other tabs, never while the pane is closed', async ($, on) => {
  const clock = engine(on, true, undefined, true)!
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await clock.settle()
  // the pane is closed: a refresh, and several, call the queue but never the pool
  await clock.advance(15000)
  expect(fetched.some(u => u.includes('/api/queue?file='))).toBe(true)
  expect(poolFetches()).toBe(0)
  // open on the Plan tab: still none, on every refresh
  await $.command.run({ command: 'wf-plan', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(45000)
  expect(poolFetches()).toBe(0)
  await ui.press({ key: 'tab-sessions' })
  await ui.press({ key: 'tab-waiting' })
  await clock.advance(30000)
  expect(poolFetches()).toBe(0)
  // the Pool tab reads at once, then once per refresh
  await ui.press({ key: 'tab-pool' })
  expect(poolFetches()).toBe(1)
  await clock.advance(15000)
  expect(poolFetches()).toBe(2)
  // back to another tab: the reads stop
  await ui.press({ key: 'tab-plan' })
  await clock.advance(45000)
  expect(poolFetches()).toBe(2)
  // on the Pool tab with the pane closed: none
  await ui.press({ key: 'tab-pool' })
  expect(poolFetches()).toBe(3)
  await $.command.run({ command: 'wf-plan', args: '' })
  await clock.advance(60000)
  expect(poolFetches()).toBe(3)
  // a pane opened on the Pool tab reads the pool with its first refresh
  await $.command.run({ command: 'wf-plan', args: '' })
  expect(poolFetches()).toBe(4)
  await ui.unmount()
})

const countsFetches = () => fetched.filter(u => u.endsWith('/api/pool?counts=1')).length

test('the Pool tab label reads `Pool <held>/<budget>` from the cheap counts read of every refresh with the pane open, on any tab, and the full read stays for the open tab', async ($, on) => {
  const clock = engine(on, true, undefined, true)!
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await clock.settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // the pane is closed: the label is not drawn, so nothing reads the counts
  await clock.advance(15000)
  expect(countsFetches()).toBe(0)
  await $.command.run({ command: 'wf-plan', args: '' })
  expect(countsFetches()).toBeGreaterThan(0)
  expect((await ui.find({ key: 'tab-pool' }))?.text ?? '').toBe('Pool 6/12')
  const before = countsFetches()
  countsReply = { status: 200, text: JSON.stringify({ budget: 12, held: 9 }) }
  await clock.advance(15000)
  expect(countsFetches()).toBe(before + 1)
  expect(poolFetches()).toBe(0)
  expect((await ui.find({ key: 'tab-pool' }))?.text ?? '').toBe('Pool 9/12')
  // on the Pool tab the full read is the one that refreshes the label: no counts call beside it
  await ui.press({ key: 'tab-pool' })
  const open = countsFetches()
  await clock.advance(15000)
  expect(poolFetches()).toBeGreaterThan(0)
  expect(countsFetches()).toBe(open)
  expect((await ui.find({ key: 'tab-pool' }))?.text ?? '').toBe('Pool 6/12')
  // an engine that does not answer the counts leaves the label bare
  await ui.press({ key: 'tab-plan' })
  countsReply = undefined
  await clock.advance(15000)
  expect((await ui.find({ key: 'tab-pool' }))?.text ?? '').toBe('Pool')
  await ui.unmount()
})

test('the Pool tab: budget, load, locks, the STARVED note, leases and waiters in two lines each, flags beside the age', async ($, on) => {
  const clock = engine(on, true, undefined, true)!
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wf-plan', args: '' })
  await clock.advance(1)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 70 }, surface: 'terminal' })
  await ui.press({ key: 'tab-pool' })
  const texts = async (re: RegExp) => (await ui.findAll({ type: 'Text', text: re })).map(t => t.text)
  expect((await texts(/^budget 12/))[0]).toBe('budget 12 · held 6 · load 9.09')
  expect((await texts(/^external/))[0]).toBe('external 0.0 · threshold 2')
  expect(await texts(/^locks:/)).toEqual(['locks: land'])
  expect(await texts(/nothing was granted/)).toHaveLength(1)
  expect((await texts(/Leases/))[0]).toContain('Leases (2)')
  expect((await texts(/Waiting \(1\)/))[0]).toContain('in admission order')
  // a lease: what it holds, how long, the OVERRUN flag; then whose and for what
  expect((await texts(/4 threads \(asked 2-4\)/))[0]).toContain('prio 0 · 3m10s')
  expect((await texts(/^\s*OVERRUN ~9$/))).toHaveLength(1)
  // an idle reservation shows beside it: held 2, running well below
  expect((await texts(/^\s*UNDERUSE ~0$/))).toHaveLength(1)
  expect(await texts(/proj · 94fe30d6 · post-land 0002ab99/)).toHaveLength(1)
  // the step shows, the label's second line does not
  expect(await texts(/proj · af2cce95 · slice-worker\/sync_gate_run · tree=\$\(pwd -P\)$/)).toHaveLength(1)
  expect(await texts(/second line/)).toEqual([])
  // a waiter: its place, STARVED, a label cut to the pane width with an ellipsis
  expect((await texts(/1\. 4 threads/))[0]).toContain('prio 1 high · 16m40s')
  expect(await texts(/^\s*STARVED$/)).toHaveLength(1)
  const who = (await texts(/bf8d7d5f/))[0] ?? ''
  expect(who.endsWith('…')).toBe(true)
  expect(cells(who)).toBeLessThanOrEqual(70)
  await ui.unmount()
})

test('at a narrow pane no line reaches past the width and both flags survive the cut', async ($, on) => {
  const clock = engine(on, true, undefined, true)!
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wf-plan', args: '' })
  await clock.advance(1)
  // a lease holding more (locks beside its threads), as describeHeld prints it
  const pool = structuredClone(API_POOL)
  pool.leases[0]!.request = '4 threads (asked 2-4) + lock land + lock port:3000'
  poolReply = { status: 200, text: JSON.stringify(pool) }
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'terminal' })
  await ui.press({ key: 'tab-pool' })
  const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  for (const t of all.filter(t => !/^(Plan|Sessions|Waiting|Pool|updated)\b/.test(t))) expect(cells(t)).toBeLessThanOrEqual(40)
  const lease = all.find(t => t.includes('(asked 2-4)')) ?? ''
  expect(lease.endsWith(' OVERRUN ~9')).toBe(true)
  expect(lease).toContain('…')
  expect(all.find(t => t.includes('(asked 1-2)'))?.endsWith(' UNDERUSE ~0')).toBe(true)
  expect(all.find(t => t.includes('1. 4 threads'))?.endsWith(' STARVED')).toBe(true)
  await ui.unmount()
})

test('with the dashboard down the queue fails too: no tab row, the queue line, and no pool read even with the Pool tab chosen', async ($, on) => {
  const clock = engine(on, true, undefined, true)!
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wf-plan', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-pool' })
  expect(poolFetches()).toBe(1)
  queueDown = true
  await clock.advance(15000)
  expect(poolFetches()).toBe(1)
  expect(await ui.find({ key: 'tab-pool' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^queue: / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Pool: / })).toBeUndefined()
  await ui.unmount()
})

test('a pane that cannot be seated leaves the pool unread: paneOpen is reset, later refreshes make no pool call', async ($, on) => {
  const clock = engine(on, true, undefined, true)!
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-pool' })
  const before = poolFetches()
  openFails = true
  // the opening refresh reads the pool (the pane is meant to be open), then ui.open throws
  await $.command.run({ command: 'wf-plan', args: '' })
  expect(poolFetches()).toBe(before + 1)
  await clock.advance(60000)
  expect(poolFetches()).toBe(before + 1)
  await ui.unmount()
})

test('an engine that does not answer shows one dim line on the Pool tab, as an answer that is not the pool does', async ($, on) => {
  const clock = engine(on, true, undefined, true)!
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'wf-plan', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  poolReply = undefined
  await ui.press({ key: 'tab-pool' })
  expect((await ui.find({ type: 'Text', text: /^Pool: / }))?.text).toBe('Pool: the dashboard at http://127.0.0.1:3100 is not answering.')
  expect(await ui.find({ type: 'Text', text: /Leases/ })).toBeUndefined()
  poolReply = { status: 404, text: '{}' }
  await clock.advance(15000)
  expect((await ui.find({ type: 'Text', text: /^Pool: / }))?.text).toContain('answered 404')
  poolReply = { status: 200, text: 'not json' }
  await clock.advance(15000)
  expect((await ui.find({ type: 'Text', text: /^Pool: / }))?.text).toContain('something else than the pool')
  poolReply = { status: 200, text: JSON.stringify(API_POOL) }
  await clock.advance(15000)
  expect(await ui.find({ type: 'Text', text: /Leases \(2\)/ })).toBeDefined()
  await ui.unmount()
})

test('poolView keeps what the pane draws: the project\'s last name, an 8-character session, the label\'s first line, the overrun only on a lease that overruns, the underuse only on one that underuses', () => {
  const v = poolView(API_POOL)
  expect(v.leases.map(l => [l.pid, l.project, l.session, l.overrun, l.priority])).toEqual([
    [55908, 'proj', '94fe30d6', 9, '0'],
    [1548, 'proj', 'af2cce95', null, '0 normal'],
  ])
  expect(v.leases.map(l => l.underuse)).toEqual([null, 0])
  expect(v.leases[1]?.label).toBe('tree=$(pwd -P)')
  expect(v.waiting[0]).toMatchObject({ isStarved: true, priority: '1 high', step: '' })
  expect(poolView({}).leases).toEqual([])
})

test('cells counts wide glyphs twice; fitCells cuts to the cells with an ellipsis; spanText', () => {
  expect(cells('ab')).toBe(2)
  expect(cells('日本')).toBe(4)
  expect(fitCells('short', 10)).toBe('short')
  expect(fitCells('日本語日本語', 7)).toBe('日本語…')
  expect(cells(fitCells('abcdefghij', 5))).toBe(5)
  expect([spanText(45000), spanText(189835), spanText(3900000)]).toEqual(['45s', '3m10s', '1h05m'])
})

const ranOf = (task: string, ended: string, usd: number, workflow = 'engine-task') =>
  JSON.stringify({ workflow, task, started_at: '2026-11-07T08:00:00Z', ended_at: ended, outcome: 'completed', visits: { land: 1 },
    spend: { agents: 1, usd, input: 1, output: 1, cache_read: 1, cache_write: 1 } })

/** A git whose `log` answers only for `branch` (the lands of that branch), and whose checked-out branch is `current`. */
const gitOn = (branch: string, current: string, rows: string) => (e: unknown) => {
  const req = JSON.stringify(e)
  if (req.includes('"branch"')) return current + '\n'
  return req.includes(`"${branch}"`) ? rows : ''
}

test('Landed reads the queue repo\'s checked-out branch, not a hard-coded main, and names it in the heading', async ($, on) => {
  engine(on, true, { git: gitOn('golf-int', 'golf-int', 'aaa111\t07.11 13:49\tL-ONE\nbbb222\t07.11 09:10\tL-TWO'), ledger: '' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ Landed · 14d \(2\) · golf-int/ })).toBeDefined()
  expect(ran.some(r => r.includes('"log"') && r.includes('"golf-int"') && !r.includes('"main"'))).toBe(true)
  await ui.unmount()
})

test('the queue header\'s land_branch wins over the checked-out branch', async ($, on) => {
  engine(on, true, { git: gitOn('release', 'golf-int', 'aaa111\t07.11 13:49\tL-ONE'), ledger: '' })
  ;(API_QUEUE as Record<string, unknown>).landBranch = 'release'
  try {
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /✓ Landed · 14d \(1\) · release/ })).toBeDefined()
    expect(ran.some(r => r.includes('"golf-int"'))).toBe(false)
    await ui.unmount()
  } finally {
    delete (API_QUEUE as Record<string, unknown>).landBranch
  }
})

test('a git that names no usable branch reads main', async ($, on) => {
  engine(on, true, { git: gitOn('main', 'HEAD detached at abc', 'aaa111\t07.11 13:49\tL-ONE'), ledger: '' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ Landed · 14d \(1\)$/ })).toBeDefined()
  await ui.unmount()
})

test('a land with no Slice trailer is found through the ledger\'s landed rows of the queue\'s own lines, in any workflow, once', async ($, on) => {
  const ledger = [ranOf('DONE-1', '2026-11-07T09:50:00Z', 1.5, 'golf-task'), ranOf('L-BOTH', '2026-11-07T09:00:00Z', 2), ranOf('L-OTHER', '2026-11-07T09:30:00Z', 3)].join('\n')
  engine(on, true, { git: 'ccc333\t07.11 08:00\t\nddd444\t07.11 09:00\tL-BOTH', ledger })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✓ Landed · 14d \(2\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /DONE-1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ddd444 L-BOTH/ })).toBeDefined()
  // a landed task of another queue (the ledger holds every project's runs) is not this pane's land
  expect(await ui.find({ type: 'Text', text: /L-OTHER/ })).toBeUndefined()
  await ui.unmount()
})

test('the ledger fallback also finds a land of a line the queue has archived', async ($, on) => {
  engine(on, true, { git: '', ledger: ranOf('ARCH-1', '2026-11-07T09:50:00Z', 1.5) })
  ;(API_QUEUE as Record<string, unknown>).archivedIds = ['ARCH-1']
  try {
    await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /✓ Landed · 14d \(1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ARCH-1/ })).toBeDefined()
    await ui.unmount()
  } finally {
    delete (API_QUEUE as Record<string, unknown>).archivedIds
  }
})

// --- the single-task view: a session with no work queue, one screen with no tabs ---

/** The text of every line of a tree: a column lays its children one per line, a row, a text and a button are one line. */
function paneLines(n: PaneNode): string[] {
  if (n === null) return []
  if (typeof n === 'string') return [n]
  if (Array.isArray(n)) return n.flatMap(paneLines)
  const el = n as PaneEl
  if (el.el === 'box' && el.props.flexDirection === 'column') return el.children.flatMap(paneLines)
  return [nodeText(el)]
}

const T0 = 1_800_000_000_000
const MIN = 60_000
const sessionRow = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: '94fe30d6-aaaa-bbbb', parent: '', workflow: 'slice-pipeline', state: 'review', tag: 'ENG-X', since: T0 - 5 * MIN, isWorking: false, agent: '', visit: 1,
  recent: [], next: [], ...over,
})
const MOVES = [
  { from: 'plan', to: 'work', at: T0 - 40 * MIN },
  { from: 'work', to: 'gate', at: T0 - 20 * MIN },
  { from: 'gate', to: 'review', at: T0 - 5 * MIN },
]
const poolState = (): PoolState => ({ at: T0, pool: poolView(API_POOL), error: '' })

/** The single-task view's lines for sessions, at a pane size. */
function singleLines(sessions: SessionRow[], opt: { rows?: number; columns?: number; pool?: PoolState | null; error?: string } = {}): string[] {
  const snapshot = { at: T0, sessions, queue: null, lands: [], recent: 0, days: {}, error: opt.error ?? '' } as unknown as Snapshot
  const tree = paneTree({ snapshot, tab: 'sessions', expanded: '', folded: [], now: T0, columns: opt.columns ?? 100, rows: opt.rows ?? 40, poolCounts: null, pool: opt.pool === undefined ? poolState() : opt.pool })
  return paneLines(tree)
}

/** A full single-task view: a pipeline with an agent, a child running an exec, a last exec, history, and the pool. */
const FULL = (): SessionRow[] => [
  sessionRow({ agent: 'agent-0123456789', agentAt: T0 - 30 * MIN, model: 'opus', visit: 2, recent: MOVES, next: ['approve→land', 'rework→work'], lastExec: { state: 'gate', code: 1, ms: 93_000, at: T0 - 6 * MIN } }),
  sessionRow({ id: 'c1', parent: '94fe30d6-aaaa-bbbb', workflow: 'slice-worker', state: 'sync_gate_run', tag: '', since: T0 - 2 * MIN, isWorking: true, agent: 'worker-9876543', model: 'sonnet',
    exec: { state: 'sync_gate_run', since: T0 - 75_000, command: 'node bin/dev.js   slice-gate\nsecond line', timeoutMs: 600_000 } }),
]

test('single-task view: each section reads off the session, top to bottom, with no tab row and no spend', () => {
  const lines = singleLines(FULL())
  const at = (re: RegExp) => lines.findIndex(l => re.test(l))
  expect(lines.some(l => /Plan|Waiting/.test(l))).toBe(false)
  // (1) the current session: workflow[task] @ state, time in it, the visit; the states passed, the transitions it offers
  expect(lines[at(/slice-pipeline/)]).toMatch(/^◆ slice-pipeline\[ENG-X\] @ review 5m · visit 2$/)
  expect(lines[at(/ done /)]).toBe('  done plan → work → gate → review')
  expect(lines[at(/ next /)]).toBe('  next approve→land  rework→work')
  // (2) what runs under it: the linked agent (role, model, id, age), the child session, its exec with elapsed / timeout, the last exec's exit
  expect(lines[at(/Running under it/)]).toBe('▶ Running under it (2)')
  expect(lines[at(/◇ agent/)]).toBe('  ◇ agent · driver · opus · agent agent-0 30m')
  expect(lines[at(/slice-worker/)]).toBe('  ⚙ slice-worker @ sync_gate_run 2m · worker · sonnet · agent worker-')
  expect(lines[at(/❯/)]).toBe('      ❯ node bin/dev.js slice-gate 1m15s/10m00s')
  expect(lines[at(/last exec/)]).toBe('    last exec gate exit 1 in 1m33s 6m ago')
  // (3) the pool: the cheap strip, this session's own lease marked, the other holders by label
  expect(lines[at(/▤ pool/)]).toBe('▤ pool held 6/12 · load 9.1 · waiting 1 STARVED')
  expect(lines[at(/▸/)]).toBe('  ▸ 4 threads (asked 2-4) · 3m10s OVERRUN ~9')
  expect(lines[at(/tree=\$\(pwd -P\)/)]).toBe('  · tree=$(pwd -P) 2 threads (asked 1-2) · 1m08s')
  // (4) the last transitions, newest first, with their age
  expect(lines.slice(at(/Last transitions/))).toEqual(['↳ Last transitions', '  gate → review 5m ago', '  work → gate 20m ago', '  plan → work 40m ago', 'updated just now'])
  // (5) spend: the engine measures none for a running session, so no section and no figure
  expect(lines.some(l => /\$|spend/i.test(l.replace('tree=$(pwd -P)', '')))).toBe(false)
  // the sections come in order
  const order = [/slice-pipeline/, /Running under it/, /▤ pool/, /Last transitions/].map(at)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(order.every(i => i >= 0)).toBe(true)
})

test('single-task view: a section with nothing to show is left out', () => {
  const bare = singleLines([sessionRow()], { pool: null })
  expect(bare.some(l => /Running|Nothing running/.test(l))).toBe(false)
  expect(bare.some(l => /pool/.test(l))).toBe(false)
  expect(bare.some(l => /Last transitions/.test(l))).toBe(false)
  expect(bare.some(l => / done /.test(l))).toBe(true)
  // no history: `(start)`; a state the dashboard has no exits for says so
  expect(bare.find(l => / done /.test(l))).toBe('  done (start) → review')
  expect(bare.find(l => / next /.test(l))).toContain('the dashboard is not answering')
  // the pool alone, from a read with no leases of this session and no waiters: the strip and the others
  const others = singleLines([sessionRow({ id: 'zzzzzzzz-1' })])
  expect(others.filter(l => /▸|◷/.test(l))).toEqual([])
  expect(others.filter(l => /^ {2}· /.test(l))).toHaveLength(2)
  // a pool read that failed is one dim line; with no session there is nothing to draw
  expect(singleLines([sessionRow()], { pool: { at: T0, pool: null, error: 'the dashboard is not answering' } }).some(l => /▤ pool: the dashboard is not answering/.test(l))).toBe(true)
  expect(singleLines([])).toContain('No active workflow in this session.')
})

test('single-task view: an exec past its timeout is red; a last exec shows only while none runs, its exit green at 0 and red otherwise', () => {
  const over = paneTree({ snapshot: { at: T0, sessions: [sessionRow({ exec: { state: 'x', since: T0 - 90_000, command: 'sleep 99', timeoutMs: 30_000 } })], queue: null, lands: [], recent: 0, days: {}, error: '' } as unknown as Snapshot, tab: 'sessions', expanded: '', folded: [], now: T0, columns: 100, rows: 40, poolCounts: null, pool: null })
  const execEl = elements(over).find(e => e.el === 'text' && nodeText(e) === ' 1m30s/30s')
  expect(execEl && execEl.el === 'text' ? execEl.props.color : undefined).toBe('red')
  const ok = singleLines([sessionRow({ lastExec: { state: 'gate', code: 0, ms: 2000, at: T0 - 3 * MIN } })], { pool: null })
  expect(ok).toContain('▶ Nothing running')
  expect(ok).toContain('    last exec gate exit 0 in 2s 3m ago')
  // a running exec replaces the last one in the session's rows
  const both = singleLines([sessionRow({ lastExec: { state: 'gate', code: 0, ms: 2000, at: T0 - 3 * MIN }, exec: { state: 'x', since: T0 - 5000, command: 'make', timeoutMs: 0 } })], { pool: null })
  expect(both.some(l => /last exec/.test(l))).toBe(false)
  expect(both).toContain('    ❯ make 5s')
})

test('single-task view: the fold order is spend-less transitions, the other holders, the pool, what runs, and the current session keeps its head line', () => {
  expect([...SINGLE_FOLD_ORDER]).toEqual(['transitions', 'holders', 'pool', 'running', 'current'])
  expect(SINGLE_FOLD_LEVELS).toEqual({ transitions: 2, holders: 1, pool: 2, running: 2, current: 1 })
  /** the smallest pane height at which a line of the view still shows */
  const lowest = (re: RegExp): number => {
    for (let rows = 4; rows <= 60; rows++) if (singleLines(FULL(), { rows }).some(l => re.test(l))) return rows
    return Infinity
  }
  const keep = {
    transitionsAll: lowest(/plan → work 40m ago/),
    transitionsHead: lowest(/Last transitions/),
    holders: lowest(/^ {2}· tree=/),
    poolOwn: lowest(/▸ 4 threads/),
    pool: lowest(/▤ pool/),
    runningAll: lowest(/last exec/),
    running: lowest(/Running under it/),
    breadcrumb: lowest(/ done /),
    head: lowest(/^◆ slice-pipeline/),
  }
  // the less important a section, the taller the pane it needs
  expect(keep.transitionsAll).toBeGreaterThan(keep.transitionsHead)
  expect(keep.transitionsHead).toBeGreaterThan(keep.holders)
  expect(keep.holders).toBeGreaterThan(keep.poolOwn)
  expect(keep.poolOwn).toBeGreaterThan(keep.pool)
  expect(keep.pool).toBeGreaterThan(keep.runningAll)
  expect(keep.runningAll).toBeGreaterThan(keep.running)
  expect(keep.running).toBeGreaterThan(keep.breadcrumb)
  expect(keep.breadcrumb).toBeGreaterThan(keep.head)
  expect(keep.head).toBe(4)
  // never taller than the pane: the sum of the unfolded lines fits `rows` minus the header links and footer
  for (let rows = 5; rows <= 40; rows++) expect(singleLines(FULL(), { rows }).length).toBeLessThanOrEqual(Math.max(rows, 4))
})

test('single-task view: every line is cut to the pane width, at any width', () => {
  for (const columns of [20, 33, 60, 100])
    for (const l of singleLines(FULL(), { columns })) expect(cells(l)).toBeLessThanOrEqual(columns)
})

test('the single-task view is the pane of a session with no queue; a queue keeps its tabs and its Sessions tree', () => {
  const noQueue = singleLines([sessionRow()])
  expect(noQueue.some(l => /^Plan|^Sessions|^Waiting/.test(l))).toBe(false)
  const queued = paneLines(paneTree({ snapshot: { at: T0, sessions: [sessionRow()], queue: EMPTY_QUEUE, lands: [], recent: 0, days: {}, error: '' } as unknown as Snapshot, tab: 'sessions', expanded: '', folded: [], now: T0, columns: 100, rows: 40, poolCounts: null, pool: null }))
  expect(queued.some(l => /Sessions 1/.test(l))).toBe(true)
  expect(queued.some(l => /Last transitions|Running under it/.test(l))).toBe(false)
})

const WORKFLOWS = JSON.stringify({
  'slice-pipeline': { name: 'slice-pipeline', driver: { model: 'opus', effort: 'high' }, states: { review: { transitions: { approve: 'land', rework: 'work' } }, gate: { type: 'exec', command: 'node bin/dev.js slice-gate', timeout: 600000, on_success: 'review', on_error: 'work' } } },
})
const EXEC_SESSION = JSON.stringify({
  session_id: '94fe30d6-aaaa-bbbb',
  claude_session_id: SID,
  started_at: '2026-11-07T09:00:00Z',
  agent_id: 'agent-0123456789',
  agent_links: [{ agent_id: 'agent-0123456789', at: '2026-11-07T09:30:00Z' }],
  running_exec: { state: 'gate', frame: 0, started_at: '2026-11-07T10:03:45Z', pgid: 1, out: '/run/o', err: '/run/e', rc: '/run/r', boot_ms: 1 },
  stack: [{ workflow: 'slice-pipeline', current_state: 'gate', state_visits: { gate: 2 } }],
  history: [
    { frame: 0, from: 'plan', to: 'gate', at: '2026-11-07T10:00:00Z', event: 'transition' },
    { frame: 0, from: 'gate', to: 'work', at: '2026-11-07T10:01:00Z', event: 'action', exit_code: 3, duration_ms: 4000 },
    { frame: 0, from: 'work', to: 'gate', at: '2026-11-07T10:02:00Z', event: 'transition' },
  ],
})

test('an unanswered /api/workflows is asked again on the next refresh, and once it answers, not again', async ($, on) => {
  const clock = engine(on, false, undefined, true)!
  const asked = () => fetched.filter(u => u.endsWith('/api/workflows')).length
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await clock.settle()
  expect(asked()).toBe(1)
  await clock.advance(15000)
  expect(asked()).toBe(2)
  workflowsReply = WORKFLOWS
  await clock.advance(15000)
  expect(asked()).toBe(3)
  await clock.advance(15000)
  expect(asked()).toBe(3)
})

test('the pane of a session with no queue draws the exec in flight, the last exit and the agent from the session file and the dashboard\'s workflows', async ($, on) => {
  engine(on, false)
  workflowsReply = WORKFLOWS
  sessionText = EXEC_SESSION
  sessionTouch = 1000
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  expect(texts).toContain('⚙ slice-pipeline @ gate 3m · visit 2')
  expect(texts).toContain('    ❯ node bin/dev.js slice-gate 1m15s/10m00s')
  expect(texts).toContain('  ◇ agent · driver · opus · agent agent-0 35m')
  expect(texts.some(t => /^ {2}next /.test(t) && t.includes('ok→review') && t.includes('err→work'))).toBe(true)
  await ui.unmount()
})

test('single-task view: the pool is read once per refresh with the pane open, never per render and never while it is closed', async ($, on) => {
  const clock = engine(on, false, undefined, true)!
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(30000)
  expect(poolFetches()).toBe(0)
  await $.command.run({ command: 'wf-plan', args: '' })
  expect(poolFetches()).toBe(1)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // drawing again and again reads nothing
  for (let i = 0; i < 3; i++) await ui.findAll({ type: 'Text' })
  expect(poolFetches()).toBe(1)
  await clock.advance(15000)
  expect(poolFetches()).toBe(2)
  expect(countsFetches()).toBe(0)
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  expect(texts.some(t => /^▤ pool held 6\/12 · load 9\.1 · waiting 1/.test(t))).toBe(true)
  // closed again: no reads
  await $.command.run({ command: 'wf-plan', args: '' })
  await clock.advance(60000)
  expect(poolFetches()).toBe(2)
  await ui.unmount()
})

test('single-task view: a pane exactly as tall as the unfolded view keeps every section, with other holders or none', () => {
  // the header links row and the footer are the two lines around the body
  for (const [sessions, pool] of [[FULL(), poolState()], [[sessionRow({ id: '94fe30d6-aaaa-bbbb', recent: MOVES })], poolState()]] as const) {
    const full = singleLines(sessions, { rows: 60, pool })
    expect(singleLines(sessions, { rows: full.length + 1, pool })).toEqual(full)
    expect(singleLines(sessions, { rows: full.length, pool })).not.toEqual(full)
  }
  // only this session's own leases in the pool: no holders, no blank row counted for them
  const mineOnly: PoolState = { at: T0, pool: { ...poolView(API_POOL), leases: poolView(API_POOL).leases.slice(0, 1), waiting: [] }, error: '' }
  const alone = [sessionRow({ id: '94fe30d6-aaaa-bbbb', recent: MOVES })]
  const full = singleLines(alone, { rows: 60, pool: mineOnly })
  expect(singleLines(alone, { rows: full.length + 1, pool: mineOnly })).toEqual(full)
})

test('single-task view: a second root session brings its child sessions and their execs', () => {
  const lines = singleLines([
    ...FULL(),
    sessionRow({ id: 'r2-0000', workflow: 'recon-pipe', state: 'scan', tag: 'ENG-Y', since: T0 - 3 * MIN }),
    sessionRow({ id: 'r2-child', parent: 'r2-0000', workflow: 'recon-worker', state: 'build', tag: '', since: T0 - MIN, exec: { state: 'build', since: T0 - 20_000, command: 'make all', timeoutMs: 60_000 } }),
  ])
  expect(lines).toContain('  ⚙ recon-pipe[ENG-Y] @ scan 3m')
  expect(lines).toContain('    ⚙ recon-worker @ build 1m')
  expect(lines).toContain('        ❯ make all 20s/1m00s')
  expect(lines).toContain('▶ Running under it (4)')
})

test('single-task view: an exec is late only past its timeout stretched by the pool wait the engine counted, up to four timeouts', () => {
  const colorOf = (exec: NonNullable<SessionRow['exec']>) => {
    const tree = paneTree({ snapshot: { at: T0, sessions: [sessionRow({ exec })], queue: null, lands: [], recent: 0, days: {}, error: '' } as unknown as Snapshot, tab: 'sessions', expanded: '', folded: [], now: T0, columns: 100, rows: 40, poolCounts: null, pool: null })
    const el = elements(tree).find(e => e.el === 'text' && /^ \d\S*\/\S+/.test(nodeText(e)))
    return { color: el && el.el === 'text' ? el.props.color : undefined, text: el ? nodeText(el) : '' }
  }
  const base = { state: 'x', since: T0 - 90_000, command: 'gate', timeoutMs: 30_000 }
  expect(colorOf(base).color).toBe('red')
  expect(colorOf({ ...base, waitMs: 5000 }).color).toBe('red')
  // 90 s run, 30 s timeout, 70 s of pool wait counted: deadline 100 s, not late
  const waiting = colorOf({ ...base, waitMs: 70_000 })
  expect(waiting.color).toBeUndefined()
  expect(waiting.text).toBe(' 1m30s/30s +1m10s pool wait')
  // the stretch is capped at four timeouts (120 s): a 130 s run is late whatever the wait
  expect(colorOf({ ...base, since: T0 - 130_000, waitMs: 500_000 }).color).toBe('red')
  expect(execDeadlineMs(30_000, 500_000)).toBe(120_000)
  expect(execDeadlineMs(30_000, 0)).toBe(30_000)
})

test('the pool wait of an exec is read from the .wait file beside its exit-code file', async ($, on) => {
  engine(on, false)
  workflowsReply = WORKFLOWS
  waitFileText = '70000'
  sessionText = EXEC_SESSION.replace('"timeout":600000', '"timeout":600000')
  sessionTouch = 2000
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text as string)
  expect(texts).toContain('    ❯ node bin/dev.js slice-gate 1m15s/10m00s +1m10s pool wait')
  await ui.unmount()
})
