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

async function serve(storage: Storage, routes: string): Promise<string> {
  const loader = { getAll: () => new Map([["w", LINE]]) } as unknown as Loader;
  // the first read of the event log is slow: the map draws its first scene before it returns, as on a loaded machine
  const outer = express();
  outer.use("/api/events", (req, _res, next) => {
    if (req.path === "/" && req.query.since === "0") setTimeout(next, 300);
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
    await page.eval("scrollTo({ top: 1e6, behavior: 'instant' })");
    await sleep(600);
    const end = await look(page);
    await page.reload();
    await until(page, `${view}.lanes === ${lanes} && ${view}.y === ${end.y}`, "back at the bottom");
    await sleep(1500);
    expect(await look(page)).toMatchObject({ y: end.y, bottom: true });
  }, 90_000);
});
