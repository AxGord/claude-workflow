import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { AgentSeen, Land, QueueLine, QueueView, SessionRow, Snapshot, View } from '../types'

const PANE = 'workflow-plan'
const PERIOD_MS = 15000
/** A state file untouched this long is a finished or abandoned session: not read. */
const STALE_MS = 3 * 24 * 3600 * 1000

// Bump the tag when Snapshot changes shape: a reload then declines the old value.
const snap = atom({ plugin: 'workflow', key: 'snapshot' } as const, null, { shape: 'snap-3' })
const view = atom({ plugin: 'workflow', key: 'view' } as const, 'plan', { shape: 'view-1' })
/** The Plan tab sections the person folded (running, next, lands); none by default. */
/** Whether the pane is open: the band above the prompt hides while it is (the pane holds the same and more). */
const paneOpen = atom({ plugin: 'workflow', key: 'paneOpen' } as const, false, { shape: 'pane-open-1' })
/** Agents seen linked to a workflow session, kept after the session ends (its file is removed): the end
 * notification of a driver, worker or reviewer is drawn from this. */
const agentsSeen = atom({ plugin: 'workflow', key: 'agentsSeen' } as const, {}, { shape: 'agents-seen-1' })
const folded = atom({ plugin: 'workflow', key: 'folded' } as const, [], { shape: 'folded-1' })
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

function field(parts: string[], key: string): string {
  const hit = parts.find(p => p.startsWith(key + ':'))
  return hit ? hit.slice(key.length + 1).trim() : ''
}

function parseQueue(file: string, text: string): QueueView {
  const lines: QueueLine[] = []
  let window = 0
  for (const raw of text.split('\n')) {
    const size = /^batch_size:\s*(\d+)/.exec(raw)
    if (size) window = Number(size[1])
    const m = /^- \[([ >x!])\] ([A-Za-z0-9][A-Za-z0-9-]*) \|(.*)$/.exec(raw)
    if (!m) continue
    const parts = (m[3] ?? '').split(' | ').map(p => p.trim())
    const after = field(parts, 'after')
    lines.push({
      id: m[2] ?? '',
      mark: m[1] as QueueLine['mark'],
      difficulty: field(parts, 'difficulty'),
      isParked: raw.includes('⏸'),
      isExclusive: field(parts, 'exclusive') !== '',
      isParentRun: /^(—|-)$/.test(field(parts, 'model')),
      after: after === '' ? [] : after.split(',').map(a => a.trim()).filter(a => a !== ''),
    })
  }
  const mark = new Map(lines.map(l => [l.id, l.mark]))
  const ready: QueueLine[] = []
  const waiting: { id: string; why: string; difficulty: string }[] = []
  for (const l of lines) {
    if (l.mark !== ' ') continue
    const open = l.after.filter(a => mark.get(a) !== 'x')
    if (l.isParked) waiting.push({ id: l.id, difficulty: l.difficulty, why: '⏸' })
    else if (open.length > 0) waiting.push({ id: l.id, difficulty: l.difficulty, why: 'after ' + open.join(', ') })
    else if (l.isParentRun) waiting.push({ id: l.id, difficulty: l.difficulty, why: 'parent-run (model —)' })
    else if (l.isExclusive) waiting.push({ id: l.id, difficulty: l.difficulty, why: 'exclusive — runs alone' })
    else ready.push(l)
  }
  return {
    file,
    window,
    done: lines.filter(l => l.mark === 'x').length,
    failed: lines.filter(l => l.mark === '!').length,
    pending: lines.filter(l => l.mark === ' ').length,
    running: lines.filter(l => l.mark === '>'),
    ready,
    waiting: waiting.filter(w => w.why !== '⏸'),
  }
}

async function lands($: any, queueFile: string): Promise<Land[]> {
  const repo = queueFile.replace(/\/\.claude\/batch\/[^/]+$/, '')
  if (repo === queueFile) return []
  const run = await $.process
    .run(['git', '-C', repo, 'log', '--since=24 hours ago', '--first-parent', '-n', '300',
      '--format=%h%x09%cd%x09%(trailers:key=Slice,valueonly,separator=)', '--date=format:%d.%m %H:%M', 'main'],
      { timeoutMs: 10000 })
    .catch(() => undefined)
  if (!run || run.exitCode !== 0) return []
  return String(run.stdout)
    .split('\n')
    .map(l => l.split('\t'))
    .filter(p => p.length >= 3 && (p[2] ?? '').trim() !== '')
    .map(p => ({ sha: p[0] ?? '', at: p[1] ?? '', slice: (p[2] ?? '').trim() }))
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
  let queue: QueueView | null = null
  let error = ''
  if (queueFile !== '') {
    const text = await $.fs.read(queueFile).catch((e: unknown) => {
      error = 'queue: ' + String(e)
      return ''
    })
    if (text !== '') queue = parseQueue(queueFile, text)
  }
  return { at: now, sessions, queue, lands: queue ? await lands($, queueFile) : [], error }
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
  return s
}

/** Opens the pane, or closes it when it is up; true when it is open after the call. */
async function togglePane($: any): Promise<boolean> {
  const isUp = (await $.ui.panes()).some((p: { id: string }) => p.id === PANE)
  if (isUp) {
    await $.ui.close({ id: PANE })
    return false
  }
  await refresh($)
  await $.ui.open({ id: PANE, title: 'Workflow plan', backgroundColor: 'transparent' })
  await update($, paneOpen, () => true)
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

/** The state a `transition` / `start` reply names on its first `<workflow> @ <state>` line. */
function movedTo(o: unknown): string | undefined {
  const m = /^([A-Za-z0-9_.-]+) @ ([A-Za-z0-9_.-]+)/m.exec(outputText(o))
  return m?.[2]
}

function age(ms: number): string {
  if (ms <= 0) return ''
  const m = Math.floor(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'wf-plan', description: 'Toggle the workflow plan pane (running pipelines, next lines, lands)' })
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
            ▶ {q.running.length}/{q.window} · ⏭ {q.ready.length} · ✓ {s.lands.length}
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
        <Text dimColor>✻ Waiting for {total}: </Text>
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
    const land = s?.lands.find(l => l.slice === seen.label)
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
    const isOpen = (key: string) => !foldedNow.includes(key)
    // a section header of the Plan tab: a click folds or unfolds it (all unfolded by default)
    const header = (key: string, color: string, title: string) => (
      <Button key={'fold-' + key} plain onPress={() => void update($, folded, f => (f.includes(key) ? f.filter(k => k !== key) : [...f, key]))}>
        <Text color={color} weight="bold">{isOpen(key) ? '▾' : '▸'} {title}</Text>
      </Button>
    )
    const now = await $.clock.now()
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
    const tabRow = (
      <Box flexDirection="row" gap={2}>
        {tabs.map(t => (
          <Button key={'tab-' + t.id} hotkey={t.key} plain onPress={() => void update($, view, () => t.id)}>
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
    const sessionLine = (r: SessionRow, depth: number) => {
      const hasChildren = childrenOf(r.id).length > 0
      const isRoot = r.parent === '' || !byId.has(r.parent)
      const mark = isRoot && hasChildren
        ? <Text color="cyanBright" weight="bold">◆</Text>
        : <Text color={r.isWorking && !hasChildren ? 'cyanBright' : 'cyan'}>⚙</Text>
      const isOpen = open === r.id
      return (
        <Button key={'s-' + r.id} plain onPress={() => void update($, expanded, cur => (cur === r.id ? '' : r.id))}>
          {'  '.repeat(depth)}{mark}{' '}
          {r.workflow}{r.tag !== '' ? <Text color="cyan">[{r.tag}]</Text> : null} @ <Text weight={isOpen ? 'bold' : undefined}>{r.state}</Text>
          <Text dimColor> {age(now - r.since)}{isOpen ? ' ▾' : ''}</Text>
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
          <Text>{pad}<Link href={`${DASHBOARD}/#session=${r.id}`} label="open the graph in the dashboard" /></Text>
        </Box>
      )
    }
    const tree = (r: SessionRow, depth: number): any[] => [
      sessionLine(r, depth),
      ...(open === r.id ? [card(r, depth)] : []),
      ...childrenOf(r.id).flatMap(c => tree(c, depth + 1)),
    ]

    let body: any
    if (tab === 'sessions' || (tab === 'plan' && !q)) {
      const lines = roots.flatMap(r => tree(r, 0))
      body = lines.length === 0
        ? <Text dimColor>No active workflow in this session.</Text>
        : <Box flexDirection="column">{lines.slice(0, room)}{lines.length > room ? <Text dimColor>  +{lines.length - room} more</Text> : null}</Box>
    } else if (!q) {
      body = <Text dimColor>No work queue in this session: the Sessions tab shows its workflow.</Text>
    } else if (tab === 'waiting') {
      body = (
        <Box flexDirection="column">
          {q.waiting.length === 0 && <Text dimColor>Nothing waits.</Text>}
          {q.waiting.slice(0, room).map(w => <Text>{w.id} {level(w.difficulty)}<Text dimColor> {w.why}</Text></Text>)}
          {q.waiting.length > room && <Text dimColor>+{q.waiting.length - room} more</Text>}
        </Box>
      )
    } else {
      // Next shows up to 10, fitted to the pane; Landed lists the whole day (the pane scrolls) and folds on a click
      const spare = (e.viewport?.rows ?? 30) - 9 - q.running.length
      const showReady = Math.max(4, Math.min(10, Math.ceil(spare / 2)))
      const pipelineOf = new Map(s.sessions.filter(r => r.tag !== '').map(r => [r.tag, r]))
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
            const leaf = p ? leafOf(p.id) : undefined
            const where = !p ? 'no pipeline' : leaf && leaf.id !== p.id ? `${p.state} › ${leaf.state}` : p.state
            return (
              <Text>
                {'  '}{l.id} {level(l.difficulty)}  <Text color={p ? 'cyan' : 'yellow'}>{where}</Text>
                <Text dimColor> {p ? age(now - (leaf ?? p).since) : ''}</Text>
              </Text>
            )
          })}
          {header('next', 'blue', `⏭ Next (${q.ready.length})`)}
          {isOpen('next') && q.ready.length === 0 && <Text dimColor>  nothing ready</Text>}
          {isOpen('next') && q.ready.slice(0, showReady).map(l => <Text>{'  '}{l.id} {level(l.difficulty)}</Text>)}
          {isOpen('next') && q.ready.length > showReady && <Text dimColor>  +{q.ready.length - showReady} more can start (dependencies done), in file order</Text>}
          {header('lands', 'green', `✓ Landed · 24h (${s.lands.length})`)}
          {isOpen('lands') &&
            s.lands.flatMap((l, i) => {
              // `at` is `DD.MM HH:MM` (numeric: locale-free): a dim date row where the day changes (the window spans midnight)
              const day = l.at.slice(0, 5)
              const prev = i > 0 ? (s.lands[i - 1]?.at ?? '').slice(0, 5) : ''
              const days = new Set(s.lands.map(x => x.at.slice(0, 5)))
              const row = <Text>{'  '}<Text dimColor>{l.at.slice(6)} {l.sha}</Text> {l.slice}</Text>
              return days.size > 1 && day !== prev ? [<Text dimColor>{'  — '}{day}{' —'}</Text>, row] : [row]
            })}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {s.queue ? tabRow : null}
        {body}
        {s.error !== '' && <Text color="red">{s.error}</Text>}
        {footer}
      </Box>
    )
  })
}
