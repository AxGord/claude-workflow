// The workflow graph and its inspector: the one renderer of a workflow definition, shared by the dashboard
// (the Workflows tab, a session's detail) and the documentation site's landing page. A pure module: no DOM at
// load, no global but the `dagre` the caller passes (the dashboard's script tag, the site's bundle), so the
// graph markup and the state panel are the same string on both. The dashboard styles them with
// dashboard/components.css; every colour is a class or a token there, never a literal here.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export function escapeHtml(str) {
  return String(str).replace(/[&<>"]/g, ch => ESCAPES[ch]);
}

// The shared components of dashboard/components.css that a graph and its panels are built from.
export const label = (html, gap) => `<h2 class="label${gap ? ' gap' : ''}">${html}</h2>`;
export const empty = (text, tight) => `<div class="empty${tight ? ' tight' : ''}">${text}</div>`;
export const square = () => '<span class="sq"></span>';
export const box = (text, caption) => (caption ? `<div class="box-label">${caption}</div>` : '') + `<div class="box">${escapeHtml(text)}</div>`;
export const transition = (name, target) => `<div class="transition">${escapeHtml(name)} <span class="arrow">→</span> ${escapeHtml(target)}</div>`;

export function pointsToPath(points) {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M${points[0].x},${points[0].y}L${points[1].x},${points[1].y}`;
  }
  // Catmull-Rom to cubic bezier through dagre control points
  let d = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const t = 1 / 6;
    const cp1x = p1.x + (p2.x - p0.x) * t;
    const cp1y = p1.y + (p2.y - p0.y) * t;
    const cp2x = p2.x - (p3.x - p1.x) * t;
    const cp2y = p2.y - (p3.y - p1.y) * t;
    d += `C${cp1x},${cp1y},${cp2x},${cp2y},${p2.x},${p2.y}`;
  }
  return d;
}

// A node's class: the same state colours as the lists (live = running, stacked = waiting on a child).
export function graphNodeKind(state, isCurrent, isInStack, liveKey) {
  if (isCurrent) return 'live ' + liveKey;
  if (isInStack) return 'stacked';
  if (state.skills && state.skills.length > 0) return 'skill';
  if (state.type === 'exec') return state.background ? 'bg' : 'script';
  if (state.type === 'fetch') return 'fetch';
  if (state.terminal) return 'terminal';
  return '';
}

export function renderGraph(dagre, workflowName, wf, currentState, stack, liveKey = '') {
  if (!wf) return empty('Workflow definition not available');

  const states = Object.entries(wf.states);
  const nodeW = 160;
  const nodeH = 48;

  // Auto-detect layout direction: wide fan-out → left-to-right
  let maxFanOut = 0;
  for (const [, state] of states)
    if (state.transitions) maxFanOut = Math.max(maxFanOut, Object.keys(state.transitions).length);
  const rankdir = maxFanOut > 4 ? 'LR' : 'TB';

  // Build dagre graph
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir, nodesep: 60, ranksep: 80, marginx: 30, marginy: 30 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const [name, state] of states) {
    g.setNode(name, { width: nodeW, height: nodeH, state });
  }

  // Edges: transitions, on_complete, on_fail
  for (const [name, state] of states) {
    if (state.transitions) {
      for (const [label, target] of Object.entries(state.transitions)) {
        if (g.hasNode(target))
          g.setEdge(name, target, { label, type: 'transition' }, `t:${name}:${label}`);
      }
    }
    if (state.sub_workflow) {
      if (state.on_complete && g.hasNode(state.on_complete))
        g.setEdge(name, state.on_complete, { label: 'on_complete', type: 'on_complete' }, `oc:${name}`);
      if (state.on_fail && g.hasNode(state.on_fail))
        g.setEdge(name, state.on_fail, { label: 'on_fail', type: 'on_fail' }, `of:${name}`);
    }
    // Action state routing edges
    if (state.type === 'exec' || state.type === 'fetch') {
      if (state.cases) {
        for (const [code, target] of Object.entries(state.cases)) {
          if (g.hasNode(target))
            g.setEdge(name, target, { label: code, type: 'on_complete' }, `case:${name}:${code}`);
        }
        if (state.default && g.hasNode(state.default))
          g.setEdge(name, state.default, { label: 'default', type: 'on_fail' }, `def:${name}`);
      } else {
        if (state.on_success && g.hasNode(state.on_success))
          g.setEdge(name, state.on_success, { label: 'success', type: 'on_complete' }, `os:${name}`);
        if (state.on_error && g.hasNode(state.on_error))
          g.setEdge(name, state.on_error, { label: 'error', type: 'on_fail' }, `oe:${name}`);
      }
    }
  }

  dagre.layout(g);

  if (g.nodes().length === 0) return empty('No states');

  // Compute actual bounding box including edge control points
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const name of g.nodes()) {
    const node = g.node(name);
    minX = Math.min(minX, node.x - nodeW / 2);
    minY = Math.min(minY, node.y - nodeH / 2);
    maxX = Math.max(maxX, node.x + nodeW / 2);
    maxY = Math.max(maxY, node.y + nodeH / 2);
  }
  for (const e of g.edges()) {
    const edgeData = g.edge(e);
    for (const p of (edgeData.points || [])) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  const pad = 40;
  minX = Math.floor(minX - pad); minY = Math.floor(minY - pad);
  maxX = Math.ceil(maxX + pad); maxY = Math.ceil(maxY + pad);
  const svgW = maxX - minX;
  const svgH = maxY - minY;

  // Collect active states from stack for highlighting
  const activeStates = new Set();
  for (const frame of stack) {
    if (frame.workflow === workflowName) activeStates.add(frame.current_state);
  }

  // Unique ID suffix to avoid marker collisions when multiple graphs on page
  const uid = workflowName.replace(/[^a-zA-Z0-9]/g, '');
  const EDGE_KIND = { on_complete: 'complete', on_fail: 'fail' };

  let svg = `<svg viewBox="${minX} ${minY} ${svgW} ${svgH}" width="${svgW}" style="max-width:${svgW}px" xmlns="http://www.w3.org/2000/svg">`;

  // Defs: one arrow head per edge kind, coloured by class
  svg += '<defs>';
  for (const kind of ['', 'complete', 'fail'])
    svg += `<marker id="arr-${uid}-${kind || 'plain'}" viewBox="0 0 10 6" refX="10" refY="3" markerWidth="10" markerHeight="6" orient="auto"><path class="g-arrow ${kind}" d="M0,0 L10,3 L0,6z"/></marker>`;
  svg += '</defs>';

  // Draw edges
  for (const e of g.edges()) {
    const edgeData = g.edge(e);
    const points = edgeData.points || [];
    if (points.length === 0) continue;

    const isSelfLoop = e.v === e.w;
    const kind = EDGE_KIND[edgeData.type] || '';
    const from = g.node(e.v);
    const to = g.node(e.w);
    const isBack = !isSelfLoop && (rankdir === 'LR' ? to.x < from.x : to.y < from.y);
    const cls = `g-edge ${kind}${isBack ? ' back' : ''}`;
    const marker = `url(#arr-${uid}-${kind || 'plain'})`;

    if (isSelfLoop) {
      // Self-loop: arc above the node
      const cx = from.x;
      const cy = from.y - nodeH / 2;
      const r = 22;
      svg += `<path class="${cls}" d="M${cx - 12},${cy} A${r},${r} 0 1,1 ${cx + 12},${cy}" marker-end="${marker}"/>`;
    } else {
      svg += `<path class="${cls}" d="${pointsToPath(points)}" marker-end="${marker}"/>`;
    }

    // Edge label
    if (edgeData.label && edgeData.x != null && !isSelfLoop) {
      svg += `<text class="g-elabel ${kind}" x="${edgeData.x}" y="${edgeData.y - 5}" text-anchor="middle">${escapeHtml(edgeData.label)}</text>`;
    }
  }

  // Draw nodes
  for (const name of g.nodes()) {
    const node = g.node(name);
    const state = node.state || wf.states[name];
    const x = node.x;
    const y = node.y;
    const w = nodeW;
    const h = nodeH;
    const isInitial = name === wf.initial;
    const isTerminal = !!state.terminal;
    const hasSubWorkflow = !!state.sub_workflow;
    const isCurrent = name === currentState;
    const isInStack = !isCurrent && activeStates.has(name);

    const isExec = state.type === 'exec';
    const isFetch = state.type === 'fetch';
    const isAction = isExec || isFetch;
    const isSkillGate = state.skills && state.skills.length > 0;
    const kind = graphNodeKind(state, isCurrent, isInStack, liveKey);

    // State nodes are plaques, exec states squares
    const rx = isExec ? 4 : (isTerminal ? 24 : 18);

    // Initial state: outer halo
    if (isInitial && !isCurrent && !isInStack) {
      svg += `<rect class="g-halo" x="${x - w / 2 - 4}" y="${y - h / 2 - 4}" width="${w + 8}" height="${h + 8}" rx="${rx + 2}"/>`;
    }

    // Wrap node elements in <g> so <title> tooltip works correctly
    svg += `<g>`;

    // Tooltip for action states
    if (isAction) {
      const tip = isExec ? (state.command || '') : (state.url || '');
      svg += `<title>${escapeHtml(tip)}</title>`;
    }

    svg += `<rect class="g-node ${kind}" data-gnode="${escapeHtml(name)}" x="${x - w / 2}" y="${y - h / 2}" width="${w}" height="${h}" rx="${rx}"/>`;

    // Sub-workflow: inner nested rect
    if (hasSubWorkflow) {
      svg += `<rect class="g-inner" x="${x - w / 2 + 5}" y="${y - h / 2 + 5}" width="${w - 10}" height="${h - 10}" rx="${Math.max(2, rx - 5)}"/>`;
    }

    // Node label
    svg += `<text class="g-name ${name.length > 16 ? 'small' : ''} ${kind}" x="${x}" y="${y + 1}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(name)}</text>`;

    // Sub-workflow name, action type or skill-gate tag below the label
    if (hasSubWorkflow) {
      svg += `<text class="g-tag sub" x="${x}" y="${y + 14}" text-anchor="middle" dominant-baseline="middle">${escapeHtml(state.sub_workflow)}</text>`;
    }
    if (isAction && !isCurrent && !isInStack) {
      const label = isExec ? (state.background ? 'exec (bg)' : 'exec') : 'fetch';
      svg += `<text class="g-tag ${kind}" x="${x}" y="${y + 14}" text-anchor="middle" dominant-baseline="middle">${label}</text>`;
    }
    if (isSkillGate && !isCurrent && !isInStack) {
      svg += `<text class="g-tag skill" x="${x}" y="${y + 14}" text-anchor="middle" dominant-baseline="middle">skills</text>`;
    }

    svg += `</g>`;
  }

  svg += '</svg>';
  return svg;
}

// What a state shows when it is picked: its prompt (or its required skills, or an action's command or URL and
// its prompts) and where it can go.
export function stateDetailHtml(state) {
  let html = '';
  if (state.skills && state.skills.length > 0) {
    html += box(state.skills.join('\n'), 'Required Skills');
  } else if (state.type === 'exec' || state.type === 'fetch') {
    const caption = state.type === 'exec' ? 'Command' : 'URL';
    const value = state.type === 'exec' ? (state.command || '?') : (state.url || '?');
    html += box(value, caption);
    if (state.success_prompt) html += box(state.success_prompt, 'Success Prompt');
    if (state.error_prompt) html += box(state.error_prompt, 'Error Prompt');
  } else {
    html += box(state.prompt || '(no prompt)', 'Prompt');
  }
  const transitions = state.transitions ? Object.entries(state.transitions) : [];
  if (transitions.length > 0)
    html += `<div class="transitions">${transitions.map(([name, target]) => transition(name, target)).join('')}</div>`;
  return html;
}

// One row of the States list under the graph.
function stateRowHtml(name, wf, state) {
  const flags = [];
  if (name === wf.initial) flags.push('initial');
  if (state.terminal) flags.push('terminal');
  if (state.sub_workflow) flags.push('sub: ' + state.sub_workflow);
  if (state.type === 'exec') flags.push(state.background ? 'exec (bg)' : 'exec');
  if (state.type === 'fetch') flags.push('fetch');
  if (state.skills && state.skills.length > 0) flags.push('skills: ' + state.skills.join(', '));
  const flagStr = flags.length > 0 ? ` <span class="muted">[${escapeHtml(flags.join(', '))}]</span>` : '';
  const mark = state.type === 'exec' ? square() : '';
  return `<div class="frame state-item" data-state="${escapeHtml(name)}">${mark}<span class="state-name">${escapeHtml(name)}</span>${flagStr}</div>`;
}

// A workflow as a page shows it: the graph, then every state as a row. `workflowClick` makes it interactive.
export function workflowViewHtml(dagre, name, wf, title = true) {
  let html = `<div data-wfview="${escapeHtml(name)}">`;
  if (title) html += label('Workflow: ' + escapeHtml(name));
  html += `<div class="graph">${renderGraph(dagre, name, wf, null, [])}</div>`;
  if (wf) {
    html += label('States', true) + '<div>';
    for (const [stateName, state] of Object.entries(wf.states)) html += stateRowHtml(stateName, wf, state);
    html += '</div>';
  }
  return html + '</div>';
}

function selectNode(view, stateName) {
  for (const rect of view.querySelectorAll('.g-node.sel')) rect.classList.remove('sel');
  if (!stateName) return;
  for (const rect of view.querySelectorAll('[data-gnode]')) if (rect.dataset.gnode === stateName) rect.classList.add('sel');
}

// Picks a state row: opens its panel under it, or closes it when it is the open one.
function toggleState(view, item, state) {
  const same = item.classList.contains('selected');
  for (const row of view.querySelectorAll('.state-item.selected')) row.classList.remove('selected');
  for (const panel of view.querySelectorAll('.state-prompt-wrapper')) panel.remove();
  selectNode(view, null);
  if (same) return;
  item.classList.add('selected');
  selectNode(view, item.dataset.state);
  const panel = view.ownerDocument.createElement('div');
  panel.className = 'state-prompt-wrapper';
  panel.innerHTML = stateDetailHtml(state);
  item.after(panel);
}

// The click of a workflow view (`workflowViewHtml`), delegated: a state's row picks it; a node of the graph picks
// its row, or, on a sub-workflow state, `open`s that workflow (when it is among `workflows`). True when the
// click was the view's.
export function workflowClick(event, workflows, open) {
  const from = event.target instanceof Element ? event.target : null;
  const node = from ? from.closest('[data-gnode]') : null;
  const row = from ? from.closest('.state-item') : null;
  const view = (node || row)?.closest('[data-wfview]');
  if (!view) return false;
  const wf = workflows[view.dataset.wfview];
  if (!wf) return false;
  if (row && !node) {
    const state = wf.states[row.dataset.state];
    if (state) toggleState(view, row, state);
    return true;
  }
  const stateName = node.dataset.gnode;
  const state = wf.states[stateName];
  if (state && state.sub_workflow && workflows[state.sub_workflow]) {
    open(state.sub_workflow);
    return true;
  }
  for (const item of view.querySelectorAll('.state-item')) {
    if (item.dataset.state !== stateName || !state) continue;
    toggleState(view, item, state);
    item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  return true;
}
