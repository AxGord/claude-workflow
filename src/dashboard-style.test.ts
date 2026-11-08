import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./dashboard.js";
import { Storage } from "./storage.js";
import type { Loader } from "./loader.js";

const DASH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dashboard");
const read = (name: string): string => fs.readFileSync(path.join(DASH, name), "utf8");

const TOKENS = read("tokens.css");
const COMPONENTS = read("components.css");
const PAGE = read("index.html");
const MAP = read("map.js");
const SCRIPT = PAGE.split("<script>")[1]?.split("</script>")[0] ?? "";

/** A colour written out: a hex literal, or an rgb()/hsl()/hwb()/lab()/lch()/oklch() function. */
const COLOUR_LITERAL =
  /(?<![&\w])#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/g;

function literals(text: string): string[] {
  return text.match(COLOUR_LITERAL) ?? [];
}

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function serve(routesModule?: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dashstyle-"));
  dirs.push(dir);
  const app = buildApp(new Storage(path.join(dir, "state")), {} as Loader, routesModule);
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise(r => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("the dashboard has one style", () => {
  it("only tokens.css holds a colour literal", () => {
    expect(literals(TOKENS).length).toBeGreaterThan(40);
    expect(literals(COMPONENTS)).toEqual([]);
    expect(literals(PAGE)).toEqual([]);
    expect(literals(MAP)).toEqual([]);
  });

  it("the colour scan sees a literal", () => {
    expect(literals("a{color:#fff}")).toEqual(["#fff"]);
    expect(literals('<rect fill="#1a2b3c" stroke="rgba(0,0,0,1)">')).toEqual(["#1a2b3c", "rgba("]);
    expect(literals("&#8212; var(--text) href=/session/ab#c")).toEqual([]);
  });

  it("tokens.css carries the map's palette", () => {
    const token = (name: string): string | undefined =>
      new RegExp(`--${name}:\\s*([^;]+);`).exec(TOKENS)?.[1]?.trim();
    expect(token("page")).toBe("#0f1117");
    expect(token("panel")).toBe("#11141c");
    expect(token("panel-border")).toBe("#222838");
    expect(token("panel-radius")).toBe("16px");
    expect(token("raised")).toBe("#1e293b");
    expect(token("grid")).toBe("#1a1f2b");
    expect(
      [1, 2, 3, 4].map(i => token(["text", "text-2", "text-3", "text-4"][i - 1] ?? "")),
    ).toEqual(["#e5e7eb", "#cbd5e1", "#94a3b8", "#64748b"]);
    expect([token("ok"), token("ok-text")]).toEqual(["#22c55e", "#86efac"]);
    expect([token("warn"), token("warn-text")]).toEqual(["#eab308", "#fde68a"]);
    expect([token("bad"), token("bad-text")]).toEqual(["#ef4444", "#fca5a5"]);
    expect(token("slow")).toBe("#f472b6");
    expect(["haiku", "sonnet", "opus", "script"].map(m => token(`model-${m}`))).toEqual([
      "#94a3b8",
      "#38bdf8",
      "#c084fc",
      "#64748b",
    ]);
    expect(Array.from({ length: 10 }, (_, i) => token(`diff-${i + 1}`))).toEqual(
      "#22c55e #22c55e #84cc16 #84cc16 #eab308 #f59e0b #f97316 #f97316 #ef4444 #ef4444".split(" "),
    );
    expect(token("font")).toMatch(/^Inter, system-ui/);
    expect(token("mono")).toMatch(/monospace$/);
  });

  it("works offline: no web font, no remote stylesheet or script", () => {
    for (const text of [TOKENS, COMPONENTS, PAGE, MAP]) {
      expect(text).not.toMatch(/@import|@font-face|url\(\s*["']?https?:|googleapis|gstatic/);
      expect(text.replaceAll("http://www.w3.org/2000/svg", "")).not.toMatch(/https?:\/\//);
    }
  });

  it("every var(--x) names a token", () => {
    const defined = new Set([...TOKENS.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
    // component-local custom properties: set by a state class or an inline style, read with var()
    const local = new Set(["--c"]);
    const used = new Set(
      [COMPONENTS, PAGE, MAP].flatMap(t =>
        [...t.matchAll(/var\((--[\w-]+)/g)].map(m => m[1] ?? ""),
      ),
    );
    const unknown = [...used].filter(n => !defined.has(n) && !local.has(n));
    expect(unknown).toEqual([]);
    // the difficulty tokens the page builds at run time exist for the whole scale
    for (let i = 1; i <= 10; i++) expect(defined.has(`--diff-${i}`)).toBe(true);
    for (let i = 0; i < 8; i++) expect(defined.has(`--actor-${i}`)).toBe(true);
  });

  it("the server serves both stylesheets and the page links them", async () => {
    expect(PAGE).toContain('<link rel="stylesheet" href="/tokens.css">');
    expect(PAGE).toContain('<link rel="stylesheet" href="/components.css">');
    const base = await serve();
    for (const [file, body] of [
      ["tokens.css", TOKENS],
      ["components.css", COMPONENTS],
    ] as const) {
      const res = await fetch(`${base}/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/text\/css/);
      expect(await res.text()).toBe(body);
    }
  });
});

describe("GET /routes.js", () => {
  it("serves the route table as a module the page can import", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dashroutes-"));
    dirs.push(dir);
    const source = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "dashboard-routes.ts"),
      "utf8",
    );
    const file = path.join(dir, "dashboard-routes.js");
    fs.writeFileSync(
      file,
      ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
    const res = await fetch(`${await serve(file)}/routes.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    const body = await res.text();
    for (const name of ["parseRoute", "routePath", "routeTab"]) expect(body).toContain(name);
    // the page awaits this import before its first render: it must be a real module
    const mod = (await import(
      `data:text/javascript;base64,${Buffer.from(body).toString("base64")}`
    )) as {
      parseRoute: (p: string) => unknown;
    };
    expect(mod.parseRoute("/plan")).toEqual({ view: "plan" });
  });

  it("serves the live map's fold and layout beside it, as modules the page can import", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dashmap-"));
    dirs.push(dir);
    const src = path.dirname(fileURLToPath(import.meta.url));
    for (const name of ["dashboard-routes", "event-fold", "map-layout"])
      fs.writeFileSync(
        path.join(dir, `${name}.js`),
        ts.transpileModule(fs.readFileSync(path.join(src, `${name}.ts`), "utf8"), {
          compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
        }).outputText,
      );
    const base = await serve(path.join(dir, "dashboard-routes.js"));
    const load = async (file: string): Promise<Record<string, unknown>> => {
      const res = await fetch(`${base}/${file}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/javascript/);
      const body = await res.text();
      // the page imports them by absolute path: nothing else may be imported at run time
      expect(body).not.toMatch(/^\s*import\s/m);
      return (await import(
        `data:text/javascript;base64,${Buffer.from(body).toString("base64")}`
      )) as Record<string, unknown>;
    };
    const foldMod = (await load("event-fold.js")) as {
      fold: (e: unknown[]) => Map<string, unknown>;
      seedEvents: (s: unknown[]) => unknown[];
    };
    const layoutMod = (await load("map-layout.js")) as {
      layout: (f: unknown, w: unknown, o: unknown) => { bands: unknown[] };
      scene: (m: unknown) => unknown;
    };
    const folded = foldMod.fold([
      { seq: 1, run: "r", ts: "t", kind: "session_start", session: "s", data: { workflow: "w" } },
    ]);
    const m = layoutMod.layout(folded, { w: { stations: [{ name: "a" }] } }, { now: 0 });
    expect(m.bands).toHaveLength(1);
    expect(layoutMod.scene(m)).toBeTruthy();
    // map.js is a static file of the dashboard and imports both by those paths
    const page = await fetch(`${base}/map.js`);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(MAP);
    expect(MAP).toContain("from '/event-fold.js'");
    expect(MAP).toContain("from '/map-layout.js'");
    expect(MAP).toContain("from '/stable.js'");
  });

  it("is a 404, not the page, when the compiled module is missing", async () => {
    const res = await fetch(
      `${await serve(path.join(os.tmpdir(), "wf-no-such-routes.js"))}/routes.js`,
    );
    expect(res.status).toBe(404);
  });
});

// --- every view, rendered by the page's own script against a stub document ---

interface FakeEl {
  innerHTML: string;
  textContent: string;
  className: string;
  style: Record<string, string>;
  classList: {
    add(c: string): void;
    remove(c: string): void;
    toggle(c: string, on?: boolean): void;
  };
  dataset: Record<string, string>;
  [k: string]: unknown;
}

function fakeEl(): FakeEl {
  return {
    innerHTML: "",
    textContent: "",
    className: "",
    style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollIntoView() {},
    after() {},
  };
}

interface Page {
  els: Map<string, FakeEl>;
  run(code: string): unknown;
}

function loadPage(): Page {
  const marker = "// The page opens on the view its path names";
  expect(SCRIPT).toContain(marker);
  const els = new Map<string, FakeEl>();
  const require = createRequire(import.meta.url);
  const context = vm.createContext({
    dagre: require("@dagrejs/dagre/dist/dagre.min.js") as unknown,
    document: {
      getElementById(id: string) {
        let el = els.get(id);
        if (!el) els.set(id, (el = fakeEl()));
        return el;
      },
      createElement() {
        const el = fakeEl();
        return Object.defineProperty(el, "innerHTML", {
          get: () =>
            el.textContent.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
          set: () => {},
        });
      },
      querySelectorAll: () => [],
      addEventListener() {},
    },
    location: { pathname: "/" },
    fetch: () => Promise.resolve({ ok: false }),
    console,
  });
  // the bootstrap tail imports /routes.js and starts the timer: a render test runs the rest
  vm.runInContext(SCRIPT.slice(0, SCRIPT.indexOf(marker)), context);
  // /stable.js morphs real nodes (src/dashboard-browser.test.ts runs it in a browser); here it just writes the markup
  vm.runInContext("Stable = { patchHtml(el, html) { el.innerHTML = html; } };", context);
  // /map-layout.js (the one difficultyBar) is the module the page imports; the test runs its transpiled copy
  const layoutJs = ts.transpileModule(
    fs.readFileSync(fileURLToPath(new URL("./map-layout.ts", import.meta.url)), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  vm.runInContext(
    `Layout = (() => { const exports = {}; ${layoutJs}\n return exports; })();`,
    context,
  );
  return { els, run: code => vm.runInContext(code, context) as unknown };
}

const WORKFLOW = {
  initial: "work",
  states: {
    work: {
      prompt: "do the work",
      transitions: { done: "gate", retry: "work", redo: "plan" },
    },
    plan: { prompt: "plan it", transitions: { go: "work" } },
    gate: {
      type: "exec",
      command: "npm run check",
      on_success: "review",
      on_error: "work",
    },
    review: { skills: ["lang-haxe"], transitions: { ok: "end", back: "work" } },
    sub: { sub_workflow: "inner", on_complete: "end", on_fail: "work" },
    bg: { type: "exec", command: "serve", background: true, on_success: "end" },
    fetch: { type: "fetch", url: "http://x", on_success: "end" },
    end: { terminal: true },
  },
};

const SESSION = {
  session_id: "s-1",
  stack: [
    { workflow: "task", current_state: "gate", state_visits: { gate: 2 } },
    { workflow: "task", current_state: "work", state_visits: { work: 1 } },
  ],
  active_frame: 1,
  started_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  history: [
    { frame: 0, event: "start", actor: "driver", workflow: "task" },
    { frame: 0, from: "work", to: "gate", via: "done", actor: "worker" },
    { frame: 0, event: "action", from: "gate", to: "review", detail: "exit 0" },
    { frame: 0, event: "skill_gate", from: "review", to: "end" },
  ],
  overrides: {},
  context: { task: "T1", model_work: "sonnet", effort_work: "high", display_name: "Demo" },
  background_pids: { bg: 4242 },
  loaded_skills: { "lang-haxe": 1, old: 0 },
  skill_epoch: 1,
};

const QUEUE = {
  file: "/tmp/queue.yaml",
  batchSize: 2,
  lines: [
    {
      id: "RUN-1",
      status: "running",
      difficulty: 6,
      model: "opus",
      exclusive: false,
      paused: false,
      text: "t",
    },
    {
      id: "NEXT-1",
      status: "pending",
      reason: "ready",
      difficulty: 3,
      model: "sonnet",
      exclusive: true,
      paused: false,
      text: "t",
    },
    {
      id: "WAIT-1",
      status: "pending",
      reason: "after RUN-1",
      difficulty: 9,
      exclusive: false,
      paused: true,
      text: "t",
    },
    { id: "BAD-1", status: "failed", difficulty: 5, exclusive: false, paused: false, text: "t" },
    {
      id: "DONE-1",
      status: "done",
      lastNoteDate: new Date().toLocaleDateString("sv"),
      difficulty: 2,
      exclusive: false,
      paused: false,
      text: "t",
    },
  ],
};

describe("every view renders with the shared components", () => {
  function rendered(): Record<string, string> {
    const page = loadPage();
    page.run(
      `allWorkflows = { task: ${JSON.stringify(WORKFLOW)}, inner: ${JSON.stringify(WORKFLOW)} };
       allSessions = [${JSON.stringify(SESSION)},
         ${JSON.stringify({ ...SESSION, session_id: "s-2", parent_session_id: "s-1" })},
         ${JSON.stringify({ ...SESSION, session_id: "s-3", stack: [], outcome: "abandoned" })},
         ${JSON.stringify({ ...SESSION, session_id: "s-4", stack: [], outcome: "completed" })}];
       selectedSessionId = "s-1";
       renderSessions(allSessions);
       renderWorkflows(allWorkflows);
       renderDetail(allSessions[0]);`,
    );
    const sessionsList = page.els.get("sessions-list")?.innerHTML ?? "";
    const workflowsList = page.els.get("workflows-list")?.innerHTML ?? "";
    const detail = page.els.get("detail-content")?.innerHTML ?? "";
    page.run(`showWorkflowGraph("task")`);
    const workflow = page.els.get("detail-content")?.innerHTML ?? "";
    const plan = page.run(`renderPlan(${JSON.stringify(QUEUE)})`) as string;
    const planWithSession = page.run(
      `allSessions = [${JSON.stringify(SESSION)}]; renderPlan(${JSON.stringify({
        ...QUEUE,
        lines: [{ ...QUEUE.lines[0], id: "T1" }],
      })})`,
    ) as string;
    page.run(
      `allSessions = [${JSON.stringify({ ...SESSION, context: { model_work: "opus", effort_work: "xhigh", model_review: "haiku" } })}]; renderDetail(allSessions[0])`,
    );
    const detailOpus = page.els.get("detail-content")?.innerHTML ?? "";
    page.run(
      `allSessions = [${JSON.stringify({ ...SESSION, pool_starved: { since: "2026-01-01T00:00:00.000Z", note: "busy" } })}]; renderDetail(allSessions[0]); renderSessions(allSessions)`,
    );
    const detailPool = page.els.get("detail-content")?.innerHTML ?? "";
    const sessionsPool = page.els.get("sessions-list")?.innerHTML ?? "";
    const planOpus = page.run(
      `renderPlan(${JSON.stringify({ ...QUEUE, lines: [QUEUE.lines[0]] })})`,
    ) as string;
    const planOrder = page.run(
      `renderPlan(${JSON.stringify({
        ...QUEUE,
        lines: [
          { ...QUEUE.lines[1], id: "FILE-FIRST", pickOrder: 1 },
          { ...QUEUE.lines[1], id: "PICK-FIRST", pickOrder: 0, priority: "high" },
        ],
      })})`,
    ) as string;
    return {
      planOrder,
      sessionsList,
      workflowsList,
      detail,
      workflow,
      plan,
      planWithSession,
      detailOpus,
      detailPool,
      sessionsPool,
      planOpus,
    };
  }

  const views = rendered();

  it("sessions: items with state plaques, in the state colour classes", () => {
    const html = views.sessionsList;
    expect(html).toContain('class="item active"');
    expect(html).toMatch(/class="plaque st-run sonnet"/);
    expect(html).toContain('class="plaque st-stop"');
    expect(html).toContain('class="plaque st-done"');
    expect(html).toContain('class="plaque st-wait"');
    expect(html).toContain('class="label gap"');
  });

  it("workflows list: the same item component", () => {
    expect(views.workflowsList).toContain('class="item"');
    expect(views.workflowsList).toContain('href="/workflow/task"');
  });

  it("session detail: labels, frames with step dots, boxes, kv rows, actor tags, graph", () => {
    const html = views.detail;
    for (const c of [
      'class="label"',
      'class="frame active-frame st-run sonnet"',
      'class="dot st-run sonnet live"',
      'class="box"',
      'class="kv"',
      'class="entry"',
      'class="transition"',
      'class="sq"',
      'class="graph"',
    ]) {
      expect(html).toContain(c);
    }
    expect(html).toMatch(/class="actor actor-[0-7]"/);
    expect(html).toContain('class="dot stop"');
    expect(html).toContain("<svg");
  });

  it("graphs: dagre nodes are classed by state kind, current glows, backward edges dashed", () => {
    const html = views.detail;
    expect(html).toContain('class="g-node live sonnet"');
    expect(html).toContain("g-node stacked");
    expect(views.workflow).toContain("g-node script");
    expect(html).toContain("g-node skill");
    expect(html).toContain("g-node bg");
    expect(html).toContain("g-node fetch");
    expect(html).toContain("g-node terminal");
    expect(html).toContain("g-edge  back");
    expect(html).toContain("g-edge complete");
    expect(html).toContain("g-edge fail");
    // the workflow view draws the same graph and lists its states with the same frame component
    expect(views.workflow).toContain('class="g-halo"');
    expect(views.workflow).toContain("g-node");
    expect(views.workflow).toContain('class="frame state-item"');
  });

  it("plan: plaques in the difficulty colour, model chips, next / landed rows", () => {
    const html = views.plan;
    for (const d of [6, 3, 9, 5, 2]) expect(html).toContain(`style="--c:var(--diff-${d})"`);
    expect(html).toContain('class="chip opus"');
    expect(html).toContain('class="chip sonnet"');
    expect(html).toContain('<div class="strip next"><span class="lead">next:</span>');
    expect(html).toContain('<div class="strip landed"><span class="lead">landed earlier:</span>');
    expect(html).toContain('class="dot st-run opus live"');
    expect(html).toContain('class="dot st-wait"');
    expect(html).toContain('class="dot st-stop"');
    expect(html).toContain('class="dot st-done"');
    expect(views.planWithSession).toContain('href="/session/s-1"');
  });

  it("the difficulty bar is the first element of every plan row and strip item, one component", () => {
    const html = views.plan;
    expect(html).not.toMatch(/>d\d+</);
    expect(PAGE).not.toContain("planDifficulty");
    // RUN-1 is difficulty 6: three of five cells, in its token, before the state dot
    expect(html).toMatch(
      /<span class="diffbar" style="--c:var\(--diff-6\)">▰▰▰▱▱<\/span> <span class="dot st-run opus live">/,
    );
    // the strip item: bar, then the plaque
    expect(html).toMatch(
      /<span class="diffbar" style="--c:var\(--diff-3\)">▰▰▱▱▱<\/span><span class="plaque">NEXT-1/,
    );
    // unknown difficulty: five wide placeholder
    const page = loadPage();
    expect(page.run("ui.difficulty(undefined)")).toBe(
      '<span class="diffbar unknown" style="--c:var(--text-4)">?????</span>',
    );
  });

  it("an ask: parent step reads as waiting (yellow) in the list and the detail", () => {
    const page = loadPage();
    const wf = {
      ...WORKFLOW,
      states: { ...WORKFLOW.states, work: { ...WORKFLOW.states.work, ask: "parent" } },
    };
    page.run(
      `allWorkflows = { task: ${JSON.stringify(wf)} }; allSessions = [${JSON.stringify(SESSION)}]; selectedSessionId = "s-1"; renderSessions(allSessions); renderDetail(allSessions[0]);`,
    );
    const list = page.els.get("sessions-list")?.innerHTML ?? "";
    const detail = page.els.get("detail-content")?.innerHTML ?? "";
    expect(list).toContain('class="plaque st-wait">waiting for parent');
    expect(detail).toContain('class="frame active-frame st-wait"');
    expect(page.run("sessionState(allSessions[0]).text")).toBe("waiting for parent");
    const plan = page.run(
      `renderPlan(${JSON.stringify({ ...QUEUE, lines: [{ ...QUEUE.lines[0], id: "T1" }] })})`,
    ) as string;
    expect(plan).toContain('class="dot st-wait"');
    expect(plan).not.toContain("live");
    // a state without the tag stays running
    page.run(`allWorkflows = { task: ${JSON.stringify(WORKFLOW)} }`);
    expect(page.run("sessionState(allSessions[0]).text")).toBe("active");
  });

  it("running reads as the model's colour everywhere, never the --ok default", () => {
    const live = (html: string, re: RegExp): string[] => html.match(re) ?? [];
    for (const [html, model] of [
      [views.detail, "sonnet"],
      [views.detailOpus, "opus"],
    ] as const) {
      expect(html).toContain(`class="dot st-run ${model} live"`);
      expect(html).toContain(`class="frame active-frame st-run ${model}"`);
      expect(html).toContain(`class="plaque st-run ${model}"`);
      expect(html).toContain(`class="g-node live ${model}"`);
      expect(html).toContain(`class="g-name  live ${model}"`);
    }
    expect(views.planOrder.indexOf("PICK-FIRST")).toBeGreaterThan(-1);
    expect(views.planOrder.indexOf("PICK-FIRST")).toBeLessThan(
      views.planOrder.indexOf("FILE-FIRST"),
    );
    expect(views.planOrder).toMatch(/PICK-FIRST[\s\S]*?>high</);
    expect(views.planOpus).toContain('class="dot st-run opus live"');
    // no live dot, node or frame without the running state class
    for (const html of Object.values(views)) {
      for (const dot of live(html, /class="dot[^"]*\blive\b[^"]*"/g))
        expect(dot).toMatch(/st-run|st-pool/);
      for (const node of live(html, /class="g-node[^"]*\blive\b[^"]*"/g))
        expect(node).toMatch(/live (haiku|sonnet|opus|pool)/);
    }
    // the stylesheet: a running rule takes its colour from --c (the model), never from --ok
    const running = [...COMPONENTS.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(m =>
      /\.live\b|active-frame|\.st-run/.test(m[1] ?? ""),
    );
    expect(running.length).toBeGreaterThan(4);
    for (const [, selector, body] of running) expect(body, selector).not.toMatch(/--ok/);
  });

  it("a session waiting on the pool reads pink in every view", () => {
    expect(views.sessionsPool).toContain('class="plaque st-pool">waiting for pool');
    const html = views.detailPool;
    expect(html).toContain('class="dot st-pool live"');
    expect(html).toContain('class="frame active-frame st-pool"');
    expect(html).toContain('class="plaque st-pool">waiting for pool');
    expect(html).toContain('class="g-node live pool"');
    expect(html).not.toContain("st-run");
    expect(COMPONENTS).toMatch(/\.st-pool\s*\{\s*--c:\s*var\(--slow\)/);
    expect(COMPONENTS).toMatch(/\.g-node\.live\.pool\s*\{\s*--c:\s*var\(--slow\)/);
  });

  it("session detail shows each stage's agent chip: model, effort bars, role", () => {
    expect(views.detail).toContain(
      '<span class="chip sonnet">sonnet <span class="bars">▮▮▮▯</span> high <span class="role">· work</span></span>',
    );
    expect(views.detailOpus).toContain(
      '<span class="chip opus">opus <span class="bars">▮▮▮▮</span> xhigh <span class="role">· work</span></span>',
    );
    // a stage with no effort recorded: model and role only
    expect(views.detailOpus).toContain(
      '<span class="chip haiku">haiku <span class="role">· review</span></span>',
    );
  });

  it("no view writes a colour literal or an inline colour", () => {
    for (const [view, html] of Object.entries(views)) {
      expect(literals(html), view).toEqual([]);
      expect(html, view).not.toMatch(/style="[^"]*(?:color|background|fill|stroke)\s*:/);
      expect(html, view).not.toMatch(/\s(?:fill|stroke|stop-color|flood-color)="/);
    }
  });

  it("every class a view emits is a component defined in components.css", () => {
    const defined = new Set([...COMPONENTS.matchAll(/\.([A-Za-z][\w-]*)/g)].map(m => m[1] ?? ""));
    const used = new Set<string>();
    for (const html of [PAGE, MAP, ...Object.values(views)])
      for (const m of html.matchAll(/class="([^"$]*)"/g))
        for (const c of (m[1] ?? "").split(/\s+/)) if (c) used.add(c);
    // state / model / difficulty modifiers the script appends to a base class through a template
    const extra = ["state-prompt-wrapper"];
    const missing = [...used].filter(c => !defined.has(c) && !extra.includes(c));
    expect(missing).toEqual([]);
  });

  it("a Plan-tab row selects its line: the side card draws the queueGraph of /map-layout.js", () => {
    expect(PAGE).toContain("data-plan-id");
    expect(PAGE).toContain('id="plan-card"');
    expect(PAGE).toContain("Layout.queueGraph(");
    expect(PAGE).toContain("Layout.queueNodeKind(");
    for (const k of ["done", "running", "ready", "waiting", "failed"])
      expect(COMPONENTS).toContain(`.qnode.${k} `);
  });
});
