import { spawn, type ChildProcess } from "node:child_process";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./dashboard.js";
import { Storage } from "./storage.js";
import { WorkflowDefinitionSchema } from "./types.js";
import type { Loader } from "./loader.js";
import type { SessionState } from "./types.js";

// The dashboard's block view refreshes in place (dashboard/stable.js): this runs the real page in a
// headless Chrome and looks at what a reader would see. Opt-in: it runs only with CHROME_BIN set to a
// Chrome binary (a headless launch on macOS can raise a keychain window), so `npm run check` skips it.

const CHROME = process.env.CHROME_BIN;
const HAVE_CHROME = CHROME !== undefined && CHROME !== "" && fs.existsSync(CHROME);

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

function session(id: string, state: string, context: object = {}): SessionState {
  const at = "2026-01-01T00:00:00.000Z";
  return {
    session_id: id,
    stack: [
      { workflow: "w", current_state: state, state_visits: { [state]: 1 }, total_transitions: 0 },
    ],
    active_frame: 0,
    started_at: at,
    updated_at: at,
    history: [{ frame: 0, event: "start", workflow: "w", at }],
    overrides: {},
    context: { display_name: id, ...context },
  };
}

/** The compiled modules the page imports (/routes.js, and the map's /event-fold.js and /map-layout.js): a test transpiles them. */
function routesModule(dir: string): string {
  const src = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ["dashboard-routes", "event-fold", "map-layout"])
    fs.writeFileSync(
      path.join(dir, `${name}.js`),
      ts.transpileModule(fs.readFileSync(path.join(src, `${name}.ts`), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
  return path.join(dir, "dashboard-routes.js");
}

/** A workflow with five stations, for the map. */
const LINE = WorkflowDefinitionSchema.parse({
  name: "w",
  initial: "a",
  states: {
    a: { transitions: { go: "b" } },
    b: { transitions: { go: "c", back: "a" } },
    c: { transitions: { go: "d", back: "a" } },
    d: { transitions: { go: "end", back: "a" } },
    end: { terminal: true, outcome: "complete" },
  },
});

/** The session moves to `to` (a recorded transition, so the event log sees it). */
async function move(storage: Storage, id: string, to: string): Promise<void> {
  const s = storage.read(id) as SessionState;
  const frame = s.stack[0];
  const at = new Date().toISOString();
  s.history.push({ frame: 0, from: frame.current_state, to, via: "go", at });
  frame.current_state = to;
  frame.state_visits[to] = (frame.state_visits[to] ?? 0) + 1;
  frame.total_transitions++;
  s.updated_at = at;
  await storage.write(id, s);
}

async function serve(storage: Storage, routes: string, logDelayMs = 300): Promise<string> {
  const loader = { getAll: () => new Map([["w", LINE]]) } as unknown as Loader;
  // the first read of the event log is slow: the map draws its first scene before it returns, as on a loaded machine
  const outer = express();
  outer.use("/api/events", (req, _res, next) => {
    if (req.path === "/" && req.query.since === "0") setTimeout(next, logDelayMs);
    else next();
  });
  outer.use(buildApp(storage, loader, routes));
  const server: Server = outer.listen(0, "127.0.0.1");
  closers.push(() => server.close());
  await new Promise(r => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Page {
  eval(expr: string): Promise<unknown>;
  reload(): Promise<void>;
  /** The reader's input (a wheel event on the window), which a script's `scrollTo` is not; a real wheel would also start a scroll animation of its own. */
  wheel(): Promise<void>;
}

/** A page of a headless Chrome driven over the DevTools protocol. */
async function openPage(url: string): Promise<Page> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-chrome-"));
  const chrome: ChildProcess = spawn(
    CHROME ?? "",
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${dir}`,
      "--window-size=1200,700",
      "--no-first-run",
      "--use-mock-keychain",
      "--password-store=basic",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  closers.push(() => {
    chrome.kill();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Chrome may still be writing its profile while it exits: the temp folder is swept later
    }
  });
  const portFile = path.join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
  const target = (await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
  ).json()) as { webSocketDebuggerUrl: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  closers.push(() => ws.close());
  await new Promise(r => ws.addEventListener("open", r));
  let nextId = 0;
  const pending = new Map<number, (r: { result?: { result?: { value?: unknown } } }) => void>();
  ws.addEventListener("message", m => {
    const d = JSON.parse(String(m.data)) as { id?: number };
    if (d.id !== undefined) pending.get(d.id)?.(d as never);
  });
  const send = (method: string, params: object = {}) =>
    new Promise<{ result?: { result?: { value?: unknown } } }>((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => reject(new Error(`DevTools ${method}: no answer`)), 15_000);
      pending.set(id, r => {
        clearTimeout(timer);
        resolve(r);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 700,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url });
  return {
    async eval(expr) {
      const r = await send("Runtime.evaluate", {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      return r.result?.result?.value;
    },
    async reload() {
      await send("Page.reload");
    },
    async wheel() {
      await send("Runtime.evaluate", {
        expression: "window.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }))",
      });
    },
  };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function until(page: Page, expr: string, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await page.eval(expr)) === true) return;
    await sleep(100);
  }
  throw new Error(`the page never reached: ${what}`);
}

describe.skipIf(!HAVE_CHROME)("the block view in a real browser", () => {
  it("takes a refresh in place: scroll, selection and nodes stay; F5 returns to the position", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dashbr-"));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storage = new Storage(path.join(dir, "state"), { eventLog: false });
    for (let i = 0; i < 30; i++)
      await storage.write(
        `s${String(i).padStart(2, "0")}`,
        session(`s${String(i).padStart(2, "0")}`, "a"),
      );
    const base = await serve(storage, routesModule(dir));

    const page = await openPage(`${base}/sessions`);
    const items = "document.querySelectorAll('#sessions-list a.item')";
    await until(page, `${items}.length === 30`, "30 session rows");

    // the reader scrolls to a row, selects its title and tags the node
    const picked = (await page.eval(`(() => {
      const it = ${items}[20];
      it.scrollIntoView({ block: 'center' });
      it._mark = 1;
      const r = document.createRange();
      r.selectNodeContents(it.querySelector('.title'));
      getSelection().removeAllRanges();
      getSelection().addRange(r);
      return { y: Math.round(scrollY), sel: String(getSelection()), href: it.getAttribute('href') };
    })()`)) as { y: number; sel: string; href: string };
    expect(picked.y).toBeGreaterThan(300);
    expect(picked.sel).not.toBe("");

    // a session changes state: the next refresh rewrites that row's text only
    await storage.write("s20", session("s20", "b"));
    await until(page, `${items}[20].textContent.includes('@ b')`, "the refreshed state text");
    expect(
      await page.eval(`({ y: Math.round(scrollY), sel: String(getSelection()),
        same: !!${items}[20]._mark })`),
    ).toEqual({ y: picked.y, sel: picked.sel, same: true });

    // F5 comes back to the position: the page builds its content after load, the browser cannot
    await page.eval("scrollTo(0, 400)");
    await sleep(200);
    await page.reload();
    await until(
      page,
      `${items}.length === 30 && Math.round(scrollY) === 400`,
      "scroll back at 400",
    );
  }, 40_000);
});

describe.skipIf(!HAVE_CHROME)("the live map in a real browser", () => {
  interface View {
    y: number;
    h: number;
    bottom: boolean;
    lanes: number;
    top: { k: string; t: number } | null;
  }
  const view = `(() => {
    const lanes = [...document.querySelectorAll('g.m-lane')].filter(e => !e.dataset.leaving);
    let top = null;
    for (const e of lanes) {
      const r = e.getBoundingClientRect();
      if (r.bottom > 0 && (!top || r.top < top.t)) top = { k: e.dataset.key, t: r.top };
    }
    return { y: Math.round(scrollY), h: document.documentElement.scrollHeight,
      bottom: scrollY + innerHeight >= document.documentElement.scrollHeight - 80,
      lanes: lanes.length, top };
  })()`;
  const look = async (page: Page) => (await page.eval(view)) as View;
  const id = (i: number) => `s${String(i).padStart(2, "0")}`;

  it("holds still on an event, follows a new lane only from the bottom, anchors the top lane, F5 returns", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dashmap-"));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storage = new Storage(path.join(dir, "state"));
    // a ready queue line draws a `next:` row under the last lane, so the end of that lane is not the page's end
    const queue = path.join(dir, "queue.yaml");
    fs.writeFileSync(
      queue,
      "batch_size: 1\ntasks:\n  - {id: A, status: pending, repo: /tmp, text: a}\n  - {id: B, status: pending, repo: /tmp, text: b}\n",
    );
    for (let i = 0; i < 30; i++)
      await storage.write(id(i), session(id(i), "a", i === 0 ? { queue_file: queue } : {}));
    const base = await serve(storage, routesModule(dir));
    let lanes = 30;
    const addLane = async () => {
      await storage.write(id(lanes), session(id(lanes), "a"));
      lanes++;
      await until(page, `${view}.lanes === ${lanes}`, `${lanes} lanes`);
    };

    const page = await openPage(`${base}/map`);
    await until(page, `${view}.lanes === 30`, "30 lanes");

    // what a reader sees stays: the lane at the top of the view is where it was (the page may move under it)
    const stays = async (before: View) => {
      const now = await look(page);
      expect(now.top?.k).toBe(before.top?.k);
      expect(Math.abs((now.top?.t ?? 1e9) - (before.top?.t ?? 0))).toBeLessThanOrEqual(1);
      expect(now.bottom).toBe(false);
    };

    // a reader who scrolls away at once (inside the map's own opening scroll) is not carried to a new lane
    await page.eval("scrollTo({ top: 300, behavior: 'instant' })");
    await sleep(900);
    let seen = await look(page);
    await addLane();
    await sleep(1200);
    await stays(seen);

    // an ordinary event moves nothing
    seen = await look(page);
    await move(storage, id(10), "b");
    await sleep(1500);
    await stays(seen);

    // a new lane does not carry a reader who is not at the bottom
    seen = await look(page);
    await addLane();
    await sleep(1200);
    await stays(seen);

    // ... and does carry one who is at the bottom
    await page.eval("scrollTo({ top: 1e6, behavior: 'instant' })");
    await sleep(600);
    const atEnd = await look(page);
    expect(atEnd.bottom).toBe(true);
    await addLane();
    await sleep(1500);
    const carried = await look(page);
    expect(carried.bottom).toBe(true);
    expect(carried.y).toBeGreaterThan(atEnd.y);

    // lanes above the one at the top of the view grow: that lane stays where the reader sees it
    await page.eval("scrollTo({ top: 900, behavior: 'instant' })");
    await sleep(600);
    const anchored = await look(page);
    for (const to of ["b", "c", "d", "a", "b", "c", "a"]) await move(storage, id(0), to);
    await until(page, `${view}.h > ${anchored.h}`, "the loops drawn (the page grew)");
    await sleep(1500);
    const held = await look(page);
    expect(held.h).toBeGreaterThan(anchored.h);
    expect(held.top?.k).toBe(anchored.top?.k);
    expect(Math.abs((held.top?.t ?? 1e9) - (anchored.top?.t ?? 0))).toBeLessThanOrEqual(1);

    // F5 returns to the position, mid-page and at the bottom
    await page.eval("scrollTo({ top: 400, behavior: 'instant' })");
    await sleep(300);
    await page.reload();
    await until(page, `${view}.lanes === ${lanes} && ${view}.y === 400`, "back at 400");
    // the event log lands a moment after the first scene and the page puts the position back once more: a
    // scroll made by the script before that cannot be told from the page's own (a reader's input can)
    await sleep(1200);
    await page.eval("scrollTo({ top: 1e6, behavior: 'instant' })");
    await sleep(600);
    const end = await look(page);
    await page.reload();
    await until(page, `${view}.lanes === ${lanes} && ${view}.y === ${end.y}`, "back at the bottom");
    await sleep(1500);
    expect(await look(page)).toMatchObject({ y: end.y, bottom: true });
  }, 90_000);

  // Sessions that landed and were pruned have no file any more, but their events are in the log: the first
  // scene (drawn from the session files) is shorter than the one the log completes, and the landed lanes
  // come on top of the running ones, so the lanes the reader looks at move down. 12 + 30 lanes.
  const prunedLanes = async (storage: Storage) => {
    for (let i = 0; i < 12; i++) {
      await storage.write(`d${i}`, session(`d${i}`, "a"));
      await move(storage, `d${i}`, "b");
      const ended = storage.read(`d${i}`) as SessionState;
      ended.stack = [];
      ended.outcome = "completed";
      ended.updated_at = new Date().toISOString();
      await storage.write(`d${i}`, ended);
    }
    for (let i = 0; i < 12; i++) storage.delete(`d${i}`);
    for (let i = 0; i < 30; i++) await storage.write(id(i), session(id(i), "a"));
  };
  const tempState = (what: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wf-dash${what}-`));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return { dir, storage: new Storage(path.join(dir, "state")) };
  };

  // the distance of a lane's middle from the middle of the view
  const laneOffset = (key: string) => `(() => {
    const e = document.querySelector('g.m-lane[data-key="lane:${key}"]');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return Math.round(r.top + r.height / 2 - innerHeight / 2);
  })()`;

  it("F5 returns to the same lane when the event log makes the scene taller than the first one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dashmap-"));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storage = new Storage(path.join(dir, "state"));
    await prunedLanes(storage);
    const base = await serve(storage, routesModule(dir));

    const page = await openPage(`${base}/map`);
    await until(page, `${view}.lanes === 42`, "42 lanes");
    await sleep(1500);
    const full = await look(page);
    const y = full.h - 1000;
    await page.eval(`scrollTo({ top: ${y}, behavior: 'instant' })`);
    await sleep(600);
    const left = await look(page);
    expect(left.bottom).toBe(false);

    await page.reload();
    let first = await look(page);
    for (let i = 0; i < 200 && first.lanes === 0; i++) {
      await sleep(10);
      first = await look(page);
    }
    // the premise: the first scene is too short to hold the position by its pixel offset
    expect(first.lanes).toBe(30);
    expect(first.h - 700).toBeLessThan(y);
    // ... yet the view is on the lane the reader left from the first scene on, not on whatever the clamped offset shows
    expect(first.top?.k).toBe(left.top?.k);

    await until(page, `${view}.lanes === 42`, "the log's lanes drawn");
    await sleep(1500);
    const back = await look(page);
    expect(back.top?.k).toBe(left.top?.k);
    expect(Math.abs((back.top?.t ?? 1e9) - (left.top?.t ?? 0))).toBeLessThanOrEqual(1);
  }, 60_000);

  it("F5 returns to a lane that only the event log has: the position is held until the log lands", async () => {
    const { dir, storage } = tempState("map");
    await prunedLanes(storage);
    const base = await serve(storage, routesModule(dir));
    const page = await openPage(`${base}/map`);
    await until(page, `${view}.lanes === 42`, "42 lanes");
    await sleep(1500);
    // the landed lanes of the pruned sessions are on top: the reader is looking at one of them
    await page.eval("scrollTo({ top: 300, behavior: 'instant' })");
    await sleep(600);
    const left = await look(page);
    expect(left.top?.k).toMatch(/^lane:d/);

    await page.reload();
    await until(page, `${view}.lanes === 42`, "the log's lanes drawn");
    await sleep(1500);
    const back = await look(page);
    expect(back.top?.k).toBe(left.top?.k);
    expect(Math.abs((back.top?.t ?? 1e9) - (left.top?.t ?? 0))).toBeLessThanOrEqual(1);
  }, 60_000);

  it("/map/<id> with lanes only the log has above the target ends with the lane centred", async () => {
    const { dir, storage } = tempState("map");
    await prunedLanes(storage);
    const base = await serve(storage, routesModule(dir));
    const page = await openPage(`${base}/map/${id(12)}`);
    await until(page, `${view}.lanes === 42`, "42 lanes");
    await sleep(2000);
    expect(Math.abs(((await page.eval(laneOffset(id(12)))) as number) ?? 1e9)).toBeLessThanOrEqual(
      2,
    );
  }, 60_000);

  it("a reader's input ends what the page does by itself: nothing glides back to the lane, nothing is put back", async () => {
    // /map/<id> under a stream of events: the glide to the lane is a second long and never renewed by a
    // scene that lands in it, and the reader's input ends it at once
    const one = tempState("map");
    for (let i = 0; i < 30; i++) await one.storage.write(id(i), session(id(i), "a"));
    const base = await serve(one.storage, routesModule(one.dir));
    const stream = async (to: string) => {
      for (let i = 0; i < 20; i++) {
        await sleep(120);
        await move(one.storage, id(i), to);
      }
    };
    const holds = async (input: boolean, to: string, wait: number) => {
      const page = await openPage(`${base}/map/${id(12)}`);
      await until(page, `${view}.lanes === 30`, "30 lanes");
      const events = stream(to);
      await sleep(wait);
      if (input) await page.wheel();
      await page.eval("scrollTo({ top: 1200, behavior: 'instant' })");
      const put = await look(page);
      await events;
      await sleep(600);
      const after = await look(page);
      expect(after.top?.k).toBe(put.top?.k);
      expect(Math.abs((after.top?.t ?? 1e9) - (put.top?.t ?? 0))).toBeLessThanOrEqual(1);
    };
    await holds(false, "b", 1500); // no input: the window ended a second after the glide began
    await holds(true, "c", 650); // input inside the window: the glide ends with it

    // F5 puts the reader back until the event log lands, unless the reader takes the view first
    const two = tempState("map");
    for (let i = 0; i < 30; i++) await two.storage.write(id(i), session(id(i), "a"));
    const slow = await serve(two.storage, routesModule(two.dir), 1500);
    const map = await openPage(`${slow}/map`);
    await until(map, `${view}.lanes === 30`, "30 lanes");
    await sleep(2500);
    await map.eval("scrollTo({ top: 800, behavior: 'instant' })");
    await sleep(600);
    await map.reload();
    let first = await look(map);
    for (let i = 0; i < 300 && first.lanes === 0; i++) {
      await sleep(10);
      first = await look(map);
    }
    expect(first.lanes).toBe(30);
    await map.wheel();
    await map.eval("scrollTo({ top: 100, behavior: 'instant' })");
    await sleep(2500);
    expect((await look(map)).y).toBe(100);
  }, 90_000);

  it("on /map/<id>: opens at the lane, never follows a new lane, counts events in the pill, F5 keeps the reader's place", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dashmap-"));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const storage = new Storage(path.join(dir, "state"));
    for (let i = 0; i < 30; i++) await storage.write(id(i), session(id(i), "a"));
    const base = await serve(storage, routesModule(dir));
    let lanes = 30;
    const addLane = async () => {
      await storage.write(id(lanes), session(id(lanes), "a"));
      lanes++;
      await until(page, `${view}.lanes === ${lanes}`, `${lanes} lanes`);
    };
    // the lane's centre against the view's centre, and whether it carries the highlight
    const lane = `(() => {
      const e = document.querySelector('g.m-lane[data-key="lane:${id(12)}"]');
      const r = e.getBoundingClientRect();
      return { off: Math.round(r.top + r.height / 2 - innerHeight / 2),
        hl: document.querySelectorAll('g.m-lane.m-hl').length,
        pill: document.querySelector('.m-pill.on')?.textContent ?? null };
    })()`;

    const page = await openPage(`${base}/map/${id(12)}`);
    await until(page, `${view}.lanes === 30`, "30 lanes");
    await sleep(1500);
    // the lane the path names is in the middle of the view and highlighted
    expect(await page.eval(lane)).toMatchObject({ hl: 1, pill: null });
    expect(Math.abs(((await page.eval(lane)) as { off: number }).off)).toBeLessThanOrEqual(2);

    // the status line takes its room before it has text: "live" arriving moves no lane (it shifted the lane off the middle)
    expect(
      await page.eval(`(() => { const s = document.getElementById('map-status'), t = s.textContent;
        s.textContent = ''; const a = s.offsetHeight; s.textContent = 'live'; const b = s.offsetHeight;
        s.textContent = t; return a === b && a > 0; })()`),
    ).toBe(true);

    // a reader at the bottom is not carried to a new lane: this view does not follow
    await page.eval("scrollTo({ top: 1e6, behavior: 'instant' })");
    await sleep(600);
    const atEnd = await look(page);
    expect(atEnd.bottom).toBe(true);
    await addLane();
    await sleep(1500);
    const held = await look(page);
    expect(held.h).toBeGreaterThan(atEnd.h);
    expect(held.y).toBe(atEnd.y);
    // ... and the pill counts the event; it leaves the lane view and goes to the end
    expect(await page.eval(lane)).toMatchObject({ hl: 1, pill: "↓ 1 new event" });
    await page.eval("document.querySelector('.m-pill').click()");
    await sleep(1500);
    expect(await look(page)).toMatchObject({ bottom: true });
    expect(await page.eval(lane)).toMatchObject({ hl: 0, pill: null });

    // F5 returns to where the reader was, and the lane is not scrolled to again
    await page.eval("scrollTo({ top: 200, behavior: 'instant' })");
    await sleep(300);
    const left = await look(page);
    await page.reload();
    await until(page, `${view}.lanes === ${lanes} && ${view}.y === ${left.y}`, "back at 200");
    await sleep(2000);
    expect(await look(page)).toMatchObject({ y: left.y });
    expect(await page.eval(lane)).toMatchObject({ hl: 1 });
  }, 90_000);
});
