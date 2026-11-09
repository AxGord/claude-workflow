import { expect, mock, test } from 'claude-code/testing'

import { cells, fitCells, ledgerRunsOf, movedTo, poolView, queueView, spanText, startText } from './plan-pane'
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
const NOW = Date.parse('2026-11-07T10:05:00Z')

/** `ticking`: the clock moves only when the test advances it, and the 15 s refresh fires on that (returned). */
function engine(on: any, withQueue: boolean, landed?: { git: string; ledger: string }, ticking = false) {
  panes.splice(0)
  fetched.splice(0)
  queueDown = false
  openFails = false
  poolReply = { status: 200, text: JSON.stringify(API_POOL) }
  const clock = ticking ? mock.clock(on, { now: NOW }) : undefined
  on('session.id', () => ({ value: SID }))
  if (!ticking) on('clock.now', () => ({ value: NOW }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'WF_STATE_DIR' ? STATE_DIR : undefined }))
  on('fs.list', () => ({
    value: [
      { name: 'wf-root.json', kind: 'file', size: 1, mtimeMs: Date.parse('2026-11-07T10:04:00Z') },
      ...(landed ? [{ name: 'ledger.jsonl', kind: 'file', size: 9, mtimeMs: 1 }] : []),
    ],
  }))
  on('fs.read', (_: unknown, e: { path: string }) => ({
    value: e.path.endsWith('ledger.jsonl') ? (landed?.ledger ?? '') : withQueue ? SESSION : SESSION.replace(`"queue_file":"${QUEUE}"`, '"x":1'),
  }))
  on('process.run', () => ({ value: landed ? { exitCode: 0, stdout: landed.git, stderr: '' } : { exitCode: 1, stdout: '', stderr: '' } }))
  on('http.fetch', (_: unknown, e: { url: string }) => {
    fetched.push(e.url)
    if (queueDown) throw new Error('ECONNREFUSED')
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
    expect(await ui.find({ type: 'Text', text: /NEXT-2 \[high\]/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Waiting/ }))?.text).toContain('Waiting 1')
    expect(await ui.find({ type: 'Text', text: /PARK-1/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('each row shows its kind glyph right after the bar: bug ※, research ⚑, feature and an absent kind ◆, the same column in all', async ($, on) => {
  engine(on, true, { git: ['ddd444\t08.11 10:00\tDONE-1', 'eee555\t08.11 09:00\tNOT-IN-QUEUE'].join('\n'), ledger: '' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /▰▰▰▰▱ ※ RUN-1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▰▱▱▱▱ ⚑ NEXT-2 \[high\]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▰▰▱▱▱ ◆ NEXT-1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\?\?\?\?\? ◆ \?    -10:00 ddd444 DONE-1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\?\?\?\?\?   \?    -09:00 eee555 NOT-IN-QUEUE/ })).toBeDefined()
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
    const link = await ui.find({ type: 'Link' })
    expect(JSON.stringify(link)).toContain('http://127.0.0.1:3100/map')
    await ui.unmount()
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

const GIT = ['aaa111\t08.11 13:49\tL-ONE', 'bbb222\t08.11 09:10\tL-NOLEDGER', 'ccc333\t07.11 00:20\tL-MIDNIGHT'].join('\n')
const row = (task: string, started: string, difficulty?: number) =>
  JSON.stringify({ workflow: 'engine-task', task, started_at: started, ...(difficulty ? { difficulty } : {}) })
const LEDGER = [row('L-ONE', '2026-11-08T13:02:00Z', 4), row('L-MIDNIGHT', '2026-11-05T12:00:00Z')].join('\n')

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

test('startText: the time, with its date when the run began on another day', () => {
  const at = new Date(2026, 10, 7, 23, 50).getTime()
  expect(startText(at, '08.11 00:20')).toBe('07.11 23:50')
  expect(startText(at, '07.11 23:59')).toBe('23:50')
})

test('Landed is a tree: day rows with counts, bar + start-end per land, `?` without a ledger row, a day folds alone', async ($, on) => {
  engine(on, true, { git: GIT, ledger: LEDGER })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /▦ 08\.11 \(2\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▦ 07\.11 \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▰▰▱▱▱   \d\d:\d\d-13:49 aaa111 L-ONE/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\?\?\?\?\?   \?    -09:10 bbb222 L-NOLEDGER/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\?\?\?\?\?   05\.11 \d\d:\d\d-00:20 ccc333/ })).toBeDefined()
  await ui.press({ key: 'fold-lands-08.11' })
  expect(await ui.find({ type: 'Text', text: /L-ONE/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /L-MIDNIGHT/ })).toBeDefined()
  await ui.unmount()
})

test('ready lines come in the picker\'s order, the priority named', () => {
  const view = queueView('/proj/q.yaml', API_QUEUE as never)
  expect(view.ready.map(l => l.id)).toEqual(['NEXT-2', 'NEXT-1'])
  expect(view.ready[0].priority).toBe('high')
})

test('failed lines come newest first, undated last, each with its reason', () => {
  const view = queueView('/proj/q.yaml', API_QUEUE as never)
  expect(view.failedLines.map(l => l.id)).toEqual(['FAIL-LONG', 'FAIL-NEW', 'FAIL-OLD', 'FAIL-BARE'])
  expect(view.failedLines.slice(1)).toEqual([
    { id: 'FAIL-NEW', difficulty: '', date: '2026-11-07', reason: 'closed as a split' },
    { id: 'FAIL-OLD', difficulty: '4', date: '2026-11-06', reason: 'gate red: the suite' },
    { id: 'FAIL-BARE', difficulty: '', date: '', reason: '' },
  ])
})

test('Failed is folded by default, shows its count, and unfolds on a click with bar, id, date and reason per row', async ($, on) => {
  engine(on, true)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  // wide enough for the longest reason: the one-line form
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 200 }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /▸ ✗ Failed \(4\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /FAIL-NEW/ })).toBeUndefined()
  await ui.press({ key: 'fold-failed' })
  expect(await ui.find({ type: 'Text', text: /▾ ✗ Failed \(4\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▰▰▱▱▱ ※ FAIL-OLD 06\.11 gate red: the suite/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\?\?\?\?\? ◆ FAIL-NEW 07\.11 closed as a split/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\?\?\?\?\? ◆ FAIL-BARE date unknown no note/ })).toBeDefined()
  const order = (await ui.findAll({ type: 'Text', text: /FAIL-/ })).map(t => /FAIL-\w+/.exec(t.text)?.[0])
  expect(order).toEqual(['FAIL-LONG', 'FAIL-NEW', 'FAIL-OLD', 'FAIL-BARE'])
  await ui.press({ key: 'fold-failed' })
  expect(await ui.find({ type: 'Text', text: /FAIL-NEW/ })).toBeUndefined()
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
  const wide = await paneTexts($, 200, ['fold-failed'])
  expect(wide.some(t => /FAIL-OLD 06\.11 gate red: the suite/.test(t))).toBe(true)
  const narrow = await paneTexts($, 50) // the fold persists: the section is still open
  // FAIL-LONG's reason does not fit 50 cells, so FAIL-OLD, which would, is on two lines as well
  expect(narrow.some(t => /FAIL-OLD 06\.11/.test(t) && !t.includes('gate red'))).toBe(true)
  const second = narrow.filter(t => /^ {5,}\S/.test(t) && /gate red|closed as a split|no note|a reason that/.test(t))
  expect(second).toHaveLength(4)
  expect(second.find(t => t.includes('a reason that'))).toMatch(/…$/)
  for (const t of narrow.filter(t => /FAIL-|reason that|gate red|closed as|no note/.test(t))) expect(cells(t)).toBeLessThanOrEqual(50)
})

test('Next: every row on one line while they fit; a priority row too long for the pane puts EVERY row on two lines, the id indented', async ($, on) => {
  engine(on, true)
  const wide = await paneTexts($, 100)
  expect(wide.some(t => /▰▱▱▱▱ ⚑ NEXT-2 \[high\]/.test(t))).toBe(true)
  const narrow = await paneTexts($, 20)
  // `  ▰▱▱▱▱ ⚑ NEXT-2 [high]` is 23 cells: NEXT-1 (which would fit) is on two lines too
  expect(narrow.some(t => /NEXT-1/.test(t) && !/^ {5,}\S/.test(t))).toBe(false)
  expect(narrow.filter(t => /^ {5,}NEXT-\d$/.test(t))).toHaveLength(2)
  expect(narrow.some(t => /⚑ \[high\]/.test(t))).toBe(true)
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
    expect(wide.some(t => /^\+7 more$/.test(t))).toBe(true)
    const narrow = await paneTexts($, 30)
    // 31 waiting rows at 24 lines of room: 12 rows of two lines, not 24
    expect(narrow.filter(t => /^ {3,}after: /.test(t))).toHaveLength(12)
    expect(narrow.some(t => /^\+19 more$/.test(t))).toBe(true)
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

test('poolView keeps what the pane draws: the project\'s last name, an 8-character session, the label\'s first line, the overrun only on a lease that overruns', () => {
  const v = poolView(API_POOL)
  expect(v.leases.map(l => [l.pid, l.project, l.session, l.overrun, l.priority])).toEqual([
    [55908, 'proj', '94fe30d6', 9, '0'],
    [1548, 'proj', 'af2cce95', null, '0 normal'],
  ])
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
