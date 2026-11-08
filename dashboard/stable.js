// The page's stable refresh, one owner for both views. `patchHtml` takes new markup into a live
// container in place: nodes that did not change stay the same nodes (scroll, focus, text selection,
// hover and running CSS animations survive), only what differs is written. The scroll memory lets F5
// return to the same place: the page builds its content after load, where the browser's own
// restoration finds nothing to scroll.

// An element that has an identity of its own is matched by it, not by its place among the siblings.
function keyOf(n) {
  if (n.nodeType !== 1) return null;
  if (n.dataset && n.dataset.key) return 'k:' + n.dataset.key;
  if (n.localName === 'a' && n.getAttribute('href')) return 'a:' + n.getAttribute('href');
  return n.id ? '#' + n.id : null;
}

function syncAttributes(a, b) {
  for (const at of Array.from(a.attributes)) if (!b.hasAttribute(at.name)) a.removeAttribute(at.name);
  for (const at of Array.from(b.attributes)) {
    if (a.getAttribute(at.name) === at.value) continue;
    if (at.namespaceURI) a.setAttributeNS(at.namespaceURI, at.name, at.value);
    else a.setAttribute(at.name, at.value);
  }
}

function morphNode(a, b) {
  if (a.nodeType !== 1) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  syncAttributes(a, b);
  morphChildren(a, b);
}

function morphChildren(from, to) {
  const wanted = Array.from(to.childNodes);
  const wantedKeys = new Set(wanted.map(keyOf).filter(Boolean));
  const old = new Map();
  for (const c of from.childNodes) {
    const k = keyOf(c);
    if (k && !old.has(k)) old.set(k, c);
  }
  let cur = from.firstChild;
  for (const n of wanted) {
    // a keyed node nothing asks for any more must not block the places after it
    while (cur && keyOf(cur) && !wantedKeys.has(keyOf(cur))) {
      const gone = cur;
      cur = cur.nextSibling;
      gone.remove();
    }
    const k = keyOf(n);
    let match = null;
    if (k) {
      match = old.get(k) || null;
      old.delete(k);
    } else if (cur && !keyOf(cur)) {
      match = cur;
    }
    if (match && (match.nodeType !== n.nodeType || match.nodeName !== n.nodeName)) {
      if (match === cur) cur = cur.nextSibling;
      match.remove();
      match = null;
    }
    if (!match) {
      from.insertBefore(from.ownerDocument.importNode(n, true), cur);
      continue;
    }
    if (match === cur) cur = cur.nextSibling;
    else from.insertBefore(match, cur);
    morphNode(match, n);
  }
  while (cur) {
    const gone = cur;
    cur = cur.nextSibling;
    gone.remove();
  }
}

/** Put `html` into `el` as its content, touching only the nodes that differ. */
export function patchHtml(el, html) {
  const t = document.createElement('template');
  t.innerHTML = html;
  morphChildren(el, t.content);
}

/** True when the page is scrolled to its end (a reader who follows the newest content). */
export function atBottom() {
  return window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 80;
}

const SCROLL_KEY = 'wf-dash-scroll';
let note = null;

/** A view that can name what the reader is looking at (the map: a lane key and its offset) adds it to the remembered position. */
export function noteScroll(fn) {
  note = fn;
}

/** Remember where the reader is when the page goes away (reload, close, navigation). */
export function rememberScroll() {
  history.scrollRestoration = 'manual';
  window.addEventListener('pagehide', () => {
    try {
      const at = { path: location.pathname, y: Math.round(window.scrollY), bottom: atBottom(), ...(note ? note() : {}) };
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify(at));
    } catch {
      // storage can be blocked: the page then opens at the top, as before
    }
  });
}

/** The position this path was left at, once: the first call after a load answers, the next ones do not. */
export function takeScroll() {
  try {
    const raw = sessionStorage.getItem(SCROLL_KEY);
    sessionStorage.removeItem(SCROLL_KEY);
    const at = raw ? JSON.parse(raw) : null;
    return at && at.path === location.pathname ? at : null;
  } catch {
    return null;
  }
}

/** Go to a position `takeScroll` answered, at once. */
export function restoreScroll(at) {
  const top = at.bottom ? document.documentElement.scrollHeight : at.y;
  window.scrollTo({ top, behavior: 'instant' });
}
