import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Land, QueueLine, QueueView, SessionRow, Snapshot, View } from '../types'

const PANE = 'workflow-plan'
const PERIOD_MS = 15000
/** A state file untouched this long is a finished or abandoned session: not read. */
const STALE_MS = 3 * 24 * 3600 * 1000

// Bump the tag when Snapshot changes shape: a reload then declines the old value.
const snap = atom({ plugin: 'workflow', key: 'snapshot' } as const, null, { shape: 'snap-2' })
const view = atom({ plugin: 'workflow', key: 'view' } as const, 'plan', { shape: 'view-1' })
/** The Plan tab sections the person folded (running, next, lands); none by default. */
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
    .run(['git', '-C', repo, 'log', '--since=midnight', '--first-parent', '-n', '300',
      '--format=%h%x09%cd%x09%(trailers:key=Slice,valueonly,separator=)', '--date=format:%H:%M', 'main'],
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

async function refresh($: any): Promise<Snapshot> {
  const s = await build($)
  await update($, snap, () => s)
  // the status line keeps the engine statusline script compact; the pane holds the detail
  $.ui.status(undefined)
  return s
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
    return next(e)
  })

  on('command.run', { command: 'wf-plan' }, async $ => {
    const isUp = (await $.ui.panes()).some(p => p.id === PANE)
    if (isUp) {
      await $.ui.close({ id: PANE })
      return { text: 'Plan pane closed.' }
    }
    await refresh($)
    await $.ui.open({ id: PANE, title: 'Workflow plan', backgroundColor: 'transparent' })
    return { text: 'Plan pane opened (refreshes every 15 s; /wf-plan again closes it).' }
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'wf-plan failed: see the debug log' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const s = await read($, snap)
    if (!s) return <Text dimColor>Reading the workflow engine…</Text>
    const tab: View = (await read($, view)) ?? 'plan'
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
          {header('lands', 'green', `✓ Landed today (${s.lands.length})`)}
          {isOpen('lands') && s.lands.map(l => <Text>{'  '}<Text dimColor>{l.at} {l.sha}</Text> {l.slice}</Text>)}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {tabRow}
        {body}
        {s.error !== '' && <Text color="red">{s.error}</Text>}
        {footer}
      </Box>
    )
  })
}
