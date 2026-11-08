// The live workflow map's page side: keeps the event log (SSE, a 2 s poll when the stream fails), folds
// it over the sessions it seeds from, lays it out with src/map-layout.ts (served as /map-layout.js) and
// reconciles the keyed scene into one SVG: every change animates over ~300 ms, nothing moves between
// events but the live step's glow and the age counters (re-laid once a minute). The view holds still:
// follow mode (the reader is at the bottom) scrolls only when a NEW lane appears; a reader who has
// scrolled away keeps the lane at the top of the view where it is while content above it grows, and
// a pill counts the new events. A reload puts the reader back by lane key (the lane at the top of the
// view and its offset), not by pixels: the first scene is drawn from the session files and grows when
// the event log arrives, so a pixel offset is clamped by the shorter page and lands on another lane.
import { fold, seedEvents } from '/event-fold.js';
import { layout, scene } from '/map-layout.js';
import { atBottom, noteScroll, restoreScroll, takeScroll } from '/stable.js';

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
  let bottomAt = 0; // when a scroll to the bottom was last started (it may still be under way)
  let pending = false;
  let drawn = false; // the first scene stands
  let loaded = false; // the event log's first answer is in, so scenes from here on are the full ones
  let placing = null; // where a reload left the reader, kept until the full scene stands
  let glide = 0; // when the smooth scroll to the lane /map/<id> names was last started
  const known = new Set(); // lane keys already on the map

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
    const sc = scene(map);
    // what the reader sees before anything moves: the lane at the top of the view stays where it is, and
    // only a reader who is at the bottom now is carried to a new lane
    const wasBottom = atBottom() || Date.now() - bottomAt < 1000;
    const settling = drawn && placing !== null;
    // a scene that lands while the view glides to its lane moves the lane: aim again instead of holding
    const gliding = drawn && Date.now() - glide < 1000;
    const anchor = drawn && !settling && !gliding ? anchorOf(sc) : null;
    svg.setAttribute('width', map.width);
    svg.setAttribute('height', Math.max(80, map.height));
    svg.setAttribute('viewBox', `0 0 ${map.width} ${Math.max(80, map.height)}`);
    if (anchor || settling || gliding) svg.classList.add('m-still');
    reconcile(svg, [sc]);
    if (anchor) holdAnchor(anchor);
    else if (settling || gliding) {
      if (settling) place();
      else aim(svg.querySelector(`[data-key="${CSS.escape('lane:' + lane)}"]`));
      requestAnimationFrame(() => svg.classList.remove('m-still'));
    }
    if (map.bands.length === 0) status.textContent = 'No workflow session to draw yet';
    pill.textContent = `↓ ${unseen} new event${unseen === 1 ? '' : 's'}`;
    pill.classList.toggle('on', !follow && unseen > 0);
    const fresh = newLanes();
    const first = !drawn && map.bands.length > 0;
    if (first) drawn = true;
    const laneEl = lane ? svg.querySelector(`[data-key="${CSS.escape('lane:' + lane)}"]`) : null;
    if (first) {
      // opening the map: back where a reload left it, else at the lane /map/<id> names, else at the running lanes
      const at = takeScroll();
      if (at) {
        placing = at;
        place();
        follow = at.bottom && !lane;
        if (laneEl) laneEl.dataset.shown = '1';
      } else if (laneEl) {
        showLane(laneEl);
      } else if (follow) {
        const live = svg.querySelectorAll('g.m-lane.running');
        const last = live[live.length - 1];
        if (last) scrollTo(() => last.scrollIntoView({ block: 'end', behavior: 'smooth' }));
      }
    } else if (lane) {
      if (laneEl && !laneEl.dataset.shown) showLane(laneEl);
    } else if (follow && wasBottom && fresh) {
      // the one thing that moves the view by itself: a new lane, for a reader who was at the bottom
      bottomAt = Date.now();
      scrollTo(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));
    }
  }

  // puts the reader back where the reload left them: at the end, else the remembered lane at its offset
  // in the view, else (no lane was named, or it is gone) the pixel offset; done once the full scene stands
  function place() {
    ownScroll = Date.now();
    const el = placing.key ? svg.querySelector(`[data-key="${CSS.escape(placing.key)}"]`) : null;
    if (placing.bottom || !el) restoreScroll(placing);
    else window.scrollBy({ top: el.getBoundingClientRect().top - placing.top, behavior: 'instant' });
    if (loaded) placing = null;
  }

  // true when a lane key is on the map that was not there at the last scene (the first scene excepted)
  function newLanes() {
    let fresh = false;
    for (const el of svg.querySelectorAll('g.m-lane')) {
      if (el.dataset.leaving || known.has(el.dataset.key)) continue;
      known.add(el.dataset.key);
      fresh = true;
    }
    return fresh && drawn;
  }

  function showLane(el) {
    el.dataset.shown = '1';
    follow = false;
    glide = Date.now(); // only the start opens the window: a re-aim must not renew it
    aim(el);
  }

  function aim(el) {
    if (el) scrollTo(() => el.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }

  function scrollTo(go) {
    ownScroll = Date.now();
    go();
  }

  // where a group stands inside the svg, from the scene's own numbers (the target) or from what is drawn now
  function sceneY(g, key, base = 0) {
    const y = base + g.y;
    if (g.key === key) return y;
    for (const c of g.groups) {
      const found = sceneY(c, key, y);
      if (found !== null) return found;
    }
    return null;
  }

  function shownY(el) {
    let y = 0;
    for (let e = el; e && e !== svg; e = e.parentNode) y += new DOMMatrix(getComputedStyle(e).transform).m42;
    return y;
  }

  // the topmost lane with any part in the view, and where its top edge is in the view
  function topLane() {
    let top = null;
    for (const el of svg.querySelectorAll('g.m-lane')) {
      if (el.dataset.leaving) continue;
      const r = el.getBoundingClientRect();
      if (r.bottom > 0 && (!top || r.top < top.top)) top = { el, top: r.top };
    }
    return top;
  }

  // the lane at the top of the view and how far its origin moves with the next scene (null: not at all)
  function anchorOf(target) {
    const top = topLane();
    if (!top) return null;
    const to = sceneY(target, top.el.dataset.key);
    const delta = to === null ? 0 : to - shownY(top.el);
    return Math.abs(delta) >= 1 ? { delta } : null;
  }

  // the lanes jumped to their new places without a slide (m-still), so the view can move with the anchor lane
  function holdAnchor(a) {
    void svg.getBoundingClientRect();
    ownScroll = Date.now();
    window.scrollBy({ top: a.delta, behavior: 'instant' });
    requestAnimationFrame(() => svg.classList.remove('m-still'));
  }

  // the reader takes the view (wheel, touch, keys, a click on the scrollbar): nothing is put back or aimed at any more
  for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) window.addEventListener(ev, () => { placing = null; glide = 0; }, { passive: true });

  // a scroll the reader makes leaves follow mode; scrolling back to the bottom returns to it
  window.addEventListener('scroll', () => {
    if (!shown || Date.now() - ownScroll < 800) return;
    follow = atBottom() && !lane;
    if (follow) unseen = 0;
    pill.classList.toggle('on', !follow && unseen > 0);
  });
  // what the page remembers of this view across a reload, besides the pixel offset
  noteScroll(() => {
    const top = shown && !placing ? topLane() : null;
    return top ? { key: top.el.dataset.key, top: Math.round(top.top) } : {};
  });
  pill.addEventListener('click', () => {
    lane = null;
    follow = true;
    unseen = 0;
    render();
    bottomAt = Date.now();
    scrollTo(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));
  });

  // --- keyed reconciliation: a group per band and lane, an element per primitive ---

  function setAttrs(el, item) {
    for (const [k, v] of Object.entries(item.attrs)) if (el.getAttribute(k) !== String(v)) el.setAttribute(k, v);
    if (item.c) el.style.setProperty('--c', `var(${item.c})`);
    else el.style.removeProperty('--c');
    // a tooltip is a <title> child, so the text is compared with what was set, not with textContent
    if (item.text !== undefined && el._text !== item.text) {
      el.textContent = item.text;
      el._text = item.text;
      el._title = undefined;
    }
    if (item.title !== el._title) {
      el.querySelector(':scope > title')?.remove();
      if (item.title !== undefined) {
        const t = document.createElementNS(NS, 'title');
        t.textContent = item.title;
        el.appendChild(t);
      }
      el._title = item.title;
    }
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
      drawn = false; // the view is placed afresh when the tab opens: ahead of the first load, so it has one first scene
      svg.querySelectorAll('[data-shown]').forEach(el => delete el.dataset.shown);
      if (!started) {
        started = true;
        await loadSessions();
        const r = await fetchJSON('/api/events?since=0');
        if (r) {
          run = r.run;
          accept(r.events);
        }
        loaded = true;
        unseen = 0; // what was there when the map opened is not news
        connect();
      }
      schedule();
    },
    hide() {
      shown = false;
    },
  };
}
