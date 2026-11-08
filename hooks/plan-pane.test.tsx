import { expect, test } from 'claude-code/testing'

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

function engine(on: any, withQueue: boolean): void {
  panes.splice(0)
  on('session.id', () => ({ value: SID }))
  on('clock.now', () => ({ value: Date.parse('2026-11-07T10:05:00Z') }))
  on('env.get', (_: unknown, e: { name: string }) => ({ value: e.name === 'WF_STATE_DIR' ? STATE_DIR : undefined }))
  on('fs.list', () => ({ value: [{ name: 'wf-root.json', kind: 'file', size: 1, mtimeMs: Date.parse('2026-11-07T10:04:00Z') }] }))
  on('fs.read', () => ({ value: withQueue ? SESSION : SESSION.replace(`"queue_file":"${QUEUE}"`, '"x":1') }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }))
  on('http.fetch', (_: unknown, e: { url: string }) =>
    e.url.includes('/api/queue?file=')
      ? { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(API_QUEUE) } }
      : { value: { status: 404, ok: false, headers: {}, text: '{}' } },
  )
  on('clock.every', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'wf-plan' } }))
  on('ui.panes', () => ({ value: panes.map(id => ({ id })) }))
  on('ui.open', (_: unknown, e: { id: string }) => {
    panes.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: unknown, e: { id: string }) => {
    panes.splice(panes.indexOf(e.id), 1)
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}

test('the Plan tab is drawn from the engine\'s /api/queue answer', async ($, on) => {
  engine(on, true)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Plan 1\/2/ }))?.text).toContain('Plan 1/2')
    expect(await ui.find({ type: 'Text', text: /RUN-1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /NEXT-1/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Waiting/ }))?.text).toContain('Waiting 1')
    expect(await ui.find({ type: 'Text', text: /PARK-1/ })).toBeUndefined()
    await ui.unmount()
  }
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
