// The live workflow map's page side: keeps the event log (SSE, a 2 s poll when the stream fails), folds
// it over the sessions it seeds from, lays it out with src/map-layout.ts (served as /map-layout.js) and
// reconciles the keyed scene into one SVG: every change animates over ~300 ms, nothing moves between
// events but the live step's glow and the age counters (re-laid once a minute). Follow mode keeps the
// running lanes in view until the reader scrolls away; a pill then counts the new events.
import { fold, seedEvents } from '/event-fold.js';
import { layout, scene } from '/map-layout.js';

const NS = 'http://www.w3.org/2000/svg';
const MS = 300;
const SESSIONS_EVERY = 30_000;
const POLL_EVERY = 2_000;

export function createMap({ root, fetchJSON }) {
  root.innerHTML = '<div class="map-status" id="map-status"></div><div class="map-wrap"><svg xmlns="http://www.w3.org/2000/svg"></svg></div><button class="m-pill" type="button"></button>';
  const status = root.querySelector('.map-status');
  const svg = root.querySelector('svg');
  const pill = root.querySelector('.m-pill');
  let run = '';
  let seq = 0;
  let events = [];
  let sessions = [];
  let workflows = {};
  let next = [];
  let lane = null; // the lane /map/<id> highlights
  let shown = false;
  let follow = true;
  let unseen = 0;
  let source = null;
  let pollTimer = null;
  let ownScroll = 0;
  let pending = false;

  function accept(list) {
    let added = 0;
    for (const e of list) {
      if (e.run !== run) {
        // another server run: its sequence starts again, the seeds carry what came before
        run = e.run;
        seq = 0;
        events = [];
      }
      if (e.seq <= seq) continue;
      seq = e.seq;
      events.push(e);
      added++;
    }
    if (added > 0) {
      if (!follow) unseen += added;
      schedule();
    }
  }

  async function loadSessions() {
    const [s, w, queues] = await Promise.all([fetchJSON('/api/sessions'), fetchJSON('/api/workflows'), fetchJSON('/api/queues')]);
    if (s) sessions = s;
    if (w) workflows = w;
    const ready = [];
    for (const file of queues || []) {
      const q = await fetchJSON('/api/queue?file=' + encodeURIComponent(file));
      for (const l of q?.lines || []) if (l.status === 'pending' && l.reason === 'ready') ready.push({ id: l.id, difficulty: l.difficulty });
    }
    next = ready;
    schedule();
  }

  async function poll() {
    const r = await fetchJSON('/api/events?since=' + encodeURIComponent(run ? `${run}:${seq}` : '0'));
    if (r) {
      if (r.run !== run && r.events.length === 0) {
        run = r.run;
        seq = 0;
        events = [];
      }
      accept(r.events);
      status.textContent = 'live · polling every 2 s';
    }
  }

  function connect() {
    if (source || typeof EventSource === 'undefined') return startPoll();
    source = new EventSource('/api/events/stream' + (run ? '?since=' + encodeURIComponent(`${run}:${seq}`) : ''));
    source.addEventListener('wf', m => accept([JSON.parse(m.data)]));
    source.onopen = () => {
      status.textContent = 'live';
      stopPoll();
    };
    source.onerror = () => {
      // the stream reconnects by itself; meanwhile the poll keeps the map moving
      status.textContent = 'stream lost · polling every 2 s';
      startPoll();
    };
  }

  function startPoll() {
    if (!pollTimer) pollTimer = setInterval(poll, POLL_EVERY);
  }

  function stopPoll() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function schedule() {
    if (pending || !shown) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      render();
    });
  }

  function render() {
    const folded = fold([...seedEvents(sessions), ...events]);
    const pool = sessions.filter(s => s.pool_starved).map(s => s.session_id);
    const map = layout(folded, workflows, { now: Date.now(), width: root.clientWidth || 1200, highlight: lane || undefined, next, pool });
    svg.setAttribute('width', map.width);
    svg.setAttribute('height', Math.max(80, map.height));
    svg.setAttribute('viewBox', `0 0 ${map.width} ${Math.max(80, map.height)}`);
    reconcile(svg, [scene(map)]);
    if (map.bands.length === 0) status.textContent = 'No workflow session to draw yet';
    pill.textContent = `↓ ${unseen} new event${unseen === 1 ? '' : 's'}`;
    pill.classList.toggle('on', !follow && unseen > 0);
    if (lane) {
      const el = svg.querySelector(`[data-key="${CSS.escape('lane:' + lane)}"]`);
      if (el && !el.dataset.shown) {
        el.dataset.shown = '1';
        follow = false;
        scrollTo(el, 'center');
      }
    } else if (follow) {
      const live = svg.querySelectorAll('g.m-lane.running');
      const last = live[live.length - 1];
      if (last) scrollTo(last, 'end');
    }
  }

  function scrollTo(el, block) {
    ownScroll = Date.now();
    el.scrollIntoView({ block, behavior: 'smooth' });
  }

  // a scroll the reader makes leaves follow mode; scrolling back to the bottom returns to it
  window.addEventListener('scroll', () => {
    if (!shown || Date.now() - ownScroll < 800) return;
    const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 80;
    follow = atBottom && !lane;
    if (follow) unseen = 0;
    pill.classList.toggle('on', !follow && unseen > 0);
  });
  pill.addEventListener('click', () => {
    lane = null;
    follow = true;
    unseen = 0;
    render();
  });

  // --- keyed reconciliation: a group per band and lane, an element per primitive ---

  function setAttrs(el, item) {
    for (const [k, v] of Object.entries(item.attrs)) if (el.getAttribute(k) !== String(v)) el.setAttribute(k, v);
    if (item.c) el.style.setProperty('--c', `var(${item.c})`);
    else el.style.removeProperty('--c');
    if (item.text !== undefined && el.textContent !== item.text) el.textContent = item.text;
  }

  function enter(el, item) {
    if (item.draw && item.tag === 'path' && el.getTotalLength) {
      const len = el.getTotalLength();
      el.style.strokeDasharray = `${len}`;
      el.style.strokeDashoffset = `${len}`;
      el.classList.add('m-draw');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el.style.strokeDashoffset = '0';
      }));
      setTimeout(() => {
        el.style.removeProperty('stroke-dasharray');
        el.style.removeProperty('stroke-dashoffset');
        el.classList.remove('m-draw');
      }, MS + 50);
    } else {
      el.classList.add('m-fade', 'm-enter');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('m-enter')));
    }
  }

  function leave(el) {
    el.dataset.leaving = '1';
    el.classList.add('m-fade', 'm-enter');
    setTimeout(() => el.remove(), MS);
  }

  function reconcile(parent, groups, els = []) {
    const kids = new Map();
    for (const el of parent.children) if (el.dataset && el.dataset.key && !el.dataset.leaving) kids.set(el.dataset.key, el);
    const keep = new Set();
    for (const item of els) {
      keep.add(item.key);
      let el = kids.get(item.key);
      const fresh = !el;
      if (fresh) {
        el = document.createElementNS(NS, item.tag);
        el.dataset.key = item.key;
        parent.appendChild(el);
      }
      el.setAttribute('class', item.cls + (fresh ? '' : el.classList.contains('m-draw') ? ' m-draw' : ''));
      setAttrs(el, item);
      if (fresh && parent.dataset.entered) enter(el, item);
    }
    for (const g of groups) {
      keep.add(g.key);
      let el = kids.get(g.key);
      const fresh = !el;
      if (fresh) {
        el = document.createElementNS(NS, 'g');
        el.dataset.key = g.key;
        parent.appendChild(el);
      }
      el.setAttribute('class', g.cls + (fresh && parent.dataset.entered ? ' m-enter' : ''));
      el.style.transform = `translate(0px, ${g.y}px)`;
      reconcile(el, g.groups, g.els);
      if (fresh && parent.dataset.entered) {
        // the space opens first (the lanes below slide), then the new group fades in
        setTimeout(() => el.classList.remove('m-enter'), MS);
      }
      el.dataset.entered = '1';
    }
    for (const [key, el] of kids) if (!keep.has(key)) leave(el);
  }

  setInterval(() => {
    if (shown) render();
  }, 60_000);
  setInterval(() => {
    if (shown) loadSessions();
  }, SESSIONS_EVERY);

  let started = false;
  return {
    async show(id) {
      shown = true;
      lane = id || null;
      follow = !lane;
      unseen = 0;
      if (!started) {
        started = true;
        await loadSessions();
        const r = await fetchJSON('/api/events?since=0');
        if (r) {
          run = r.run;
          accept(r.events);
        }
        unseen = 0; // what was there when the map opened is not news
        connect();
      }
      svg.querySelectorAll('[data-shown]').forEach(el => delete el.dataset.shown);
      schedule();
    },
    hide() {
      shown = false;
    },
  };
}
