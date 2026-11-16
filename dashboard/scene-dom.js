// The keyed reconciliation of a scene (src/map-layout.ts `scene()`) into SVG: a group per band and lane, an
// element per primitive, every change animating over ~300 ms (CSS transitions, set by dashboard/components.css).
// Shared by the live map (dashboard/map.js) and the documentation site's replay (docs/.vitepress/theme/MapReplay.vue):
// one renderer, so a replay draws exactly what the dashboard draws. No state of its own: the caller owns the SVG.

const NS = 'http://www.w3.org/2000/svg';
const MS = 300;

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

export function reconcile(parent, groups, els = []) {
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
