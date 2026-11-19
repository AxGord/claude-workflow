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
import { graphModuleExpression } from "./test-helpers.js";
import type { Loader } from "./loader.js";
import * as dashTokens from "../docs/.vitepress/theme/dash-tokens.js";

const DASH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dashboard");
const read = (name: string): string => fs.readFileSync(path.join(DASH, name), "utf8");

const TOKENS = read("tokens.css");
const COMPONENTS = read("components.css");
const PAGE = read("index.html");
const MAP = read("map.js");
const SCENE_DOM = read("scene-dom.js");
const DASH_CSS_TS = fs.readFileSync(
  path.join(DASH, "..", "docs", ".vitepress", "theme", "dashboard-css.ts"),
  "utf8",
);
const SCRIPT = PAGE.split("<script>")[1]?.split("</script>")[0] ?? "";

/** A colour written out: a hex literal, or an rgb()/hsl()/hwb()/lab()/lch()/oklch() function. */
const COLOUR_LITERAL =
  /(?<![&\w])#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\s*\(/g;

function literals(text: string): string[] {
  return text.match(COLOUR_LITERAL) ?? [];
}

// tokens.css holds three colour rules: the light set (the default), the dark set the system's preference
// turns on (a media block) and the dark set the switch pins.
const LIGHT_RULE = /^:root, :root\[data-theme="light"\] \{([^}]*)\}/m;
const SYSTEM_DARK_RULE =
  /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/;
const DARK_RULE = /^:root\[data-theme="dark"\] \{([^}]*)\}/m;

/** The `--name: value` pairs a rule body declares. */
function declared(body: string | undefined): Map<string, string> {
  return new Map(
    [...(body ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [
      m[1] ?? "",
      (m[2] ?? "").trim(),
    ]),
  );
}
const LIGHT = declared(LIGHT_RULE.exec(TOKENS)?.[1]);
const DARK = declared(DARK_RULE.exec(TOKENS)?.[1]);
const SYSTEM_DARK = declared(SYSTEM_DARK_RULE.exec(TOKENS)?.[1]);

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5]
    .map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
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
    expect(literals(SCENE_DOM)).toEqual([]);
  });

  it("the colour scan sees a literal", () => {
    expect(literals("a{color:#fff}")).toEqual(["#fff"]);
    expect(literals('<rect fill="#1a2b3c" stroke="rgba(0,0,0,1)">')).toEqual(["#1a2b3c", "rgba("]);
    expect(literals("&#8212; var(--text) href=/session/ab#c")).toEqual([]);
  });

  it("the page declares both schemes to the browser, and each set sets its own native controls", () => {
    // `color-scheme` on the root decides how the date field and its calendar popup, selects and scrollbars are drawn
    expect(LIGHT_RULE.exec(TOKENS)?.[1]).toMatch(/(?:^|[;\s])color-scheme:\s*light\s*;/);
    for (const rule of [SYSTEM_DARK_RULE, DARK_RULE])
      expect(rule.exec(TOKENS)?.[1]).toMatch(/(?:^|[;\s])color-scheme:\s*dark\s*;/);
    // before the stylesheet loads, and for a viewer that reads only the head, the page says so too
    expect(PAGE).toContain('<meta name="color-scheme" content="light dark">');
    // no other stylesheet or element pins a scheme: components follow the root's
    for (const [file, text] of [
      ["components.css", COMPONENTS],
      ["index.html", PAGE],
    ] as const) {
      const pinned = [...text.matchAll(/color-scheme[^;}>]*/g)]
        .map(m => m[0])
        .filter(m => !/^color-scheme"\s+content="light dark"$/.test(m));
      expect(pinned, file).toEqual([]);
    }
    // the Cost tab's date inputs are native controls inside that root
    expect(SCRIPT).toContain('<input type="date" id="cost-from"');
    expect(SCRIPT).toContain('<input type="date" id="cost-to"');
  });

  it("tokens.css carries the map's palette (dark set)", () => {
    const token = (name: string): string | undefined => DARK.get(`--${name}`);
    expect(token("page")).toBe("#0f1117");
    expect(token("panel")).toBe("#11141c");
    expect(token("panel-border")).toBe("#222838");
    expect(/^:root \{[^}]*--panel-radius: 16px;/m.test(TOKENS)).toBe(true);
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
    expect(/--font: Inter, system-ui/.test(TOKENS)).toBe(true);
    expect(/--mono: [^;]*monospace;/.test(TOKENS)).toBe(true);
  });

  it("the light set names every token of the dark set, and the system's dark set is the pinned one", () => {
    expect(LIGHT.size).toBeGreaterThan(50);
    expect([...LIGHT.keys()]).toEqual([...DARK.keys()]);
    expect(SYSTEM_DARK).toEqual(DARK);
    // a colour differs between the sets: the light one is not a copy of the dark one
    expect(LIGHT.get("--panel")).toBe("#ffffff");
    expect(LIGHT.get("--text")).not.toBe(DARK.get("--text"));
    // the shared rule holds what a theme does not change; no set repeats it
    expect(/^:root \{[^}]*--font:/m.test(TOKENS)).toBe(true);
    for (const set of [LIGHT, DARK]) {
      expect(set.has("--font")).toBe(false);
      expect(set.has("--panel-radius")).toBe(false);
    }
  });

  it("light set contrast: text on the panel reads at 4.5:1, and every state, model, stage and actor colour with it", () => {
    const light = (name: string): string => LIGHT.get(`--${name}`) ?? "#000000";
    const panel = light("panel");
    const accent = [
      "link",
      "link-hover",
      "ok",
      "ok-text",
      "warn",
      "warn-text",
      "bad",
      "bad-text",
      "slow",
      "skill",
      "sub",
      "prio-urgent",
      "prio-high",
      "prio-low",
      ...["recon", "plan", "work", "gate", "review", "land", "wait"].map(n => `stage-${n}`),
      ...["haiku", "sonnet", "opus", "script"].map(n => `model-${n}`),
      ...Array.from({ length: 10 }, (_, i) => `diff-${i + 1}`),
      ...Array.from({ length: 8 }, (_, i) => `actor-${i}`),
    ];
    const low: string[] = [];
    for (const name of ["text", "text-2", "text-3", "text-4", ...accent])
      if (contrast(light(name), panel) < 4.5) low.push(`${name} ${light(name)}`);
    expect(low).toEqual([]);
    // body text sits on the page, the plaque's state text on its state background, a chip on the raised surface
    expect(contrast(light("text-2"), light("page"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(light("text-3"), light("raised"))).toBeGreaterThanOrEqual(4.5);
    for (const state of ["ok", "warn", "bad"])
      expect(contrast(light(`${state}-text`), light(`${state}-bg`))).toBeGreaterThanOrEqual(4.5);
    // the panel stands out of the page, and a border out of the panel, as in the dark set
    expect(light("panel")).not.toBe(light("page"));
    expect(light("panel-border")).not.toBe(light("panel"));
    // the check itself: white on white fails, black on white passes
    expect(contrast("#ffffff", "#ffffff")).toBe(1);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  });

  it("the page follows the system until the switch chooses, and remembers the choice (#theme-boot, applyTheme)", () => {
    // header: a switch of three, system first
    const switchHtml =
      /<div class="theme-switch" id="theme-switch"[^>]*>([\s\S]*?)<\/div>/.exec(PAGE)?.[1] ?? "";
    expect([...switchHtml.matchAll(/data-theme-choice="(\w+)"/g)].map(m => m[1])).toEqual([
      "system",
      "light",
      "dark",
    ]);
    // before the first paint the saved choice is on <html>; a missing or throwing storage and a stray value leave the system's
    const boot = /<script id="theme-boot">([\s\S]*?)<\/script>/.exec(PAGE)?.[1] ?? "";
    expect(boot).toContain("try");
    const booted = (storage: unknown): string | undefined => {
      const root: { dataset: { theme?: string } } = { dataset: {} };
      vm.runInNewContext(boot, { localStorage: storage, document: { documentElement: root } });
      return root.dataset.theme;
    };
    const saved = (v: string | null) => ({
      getItem: (k: string) => (k === "wf-theme" ? v : "light"),
    });
    expect(booted(saved("dark"))).toBe("dark");
    expect(booted(saved("light"))).toBe("light");
    expect(booted(saved("system"))).toBeUndefined();
    expect(booted(saved(null))).toBeUndefined();
    expect(
      booted({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBeUndefined();
    expect(booted(undefined)).toBeUndefined();
    // the switch: a choice sets data-theme and the key; system clears both; a storage that throws does not stop it
    const page = loadPage();
    const choose = (choices: string[], blocked = false): string =>
      page.run(`(() => {
        const store = {};
        const root = { dataset: {} };
        const win = { get localStorage() {
          if (${blocked}) throw new Error('blocked');
          return { setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } };
        } };
        const seen = [];
        for (const c of ${JSON.stringify(choices)}) { applyTheme(c, root, win); seen.push([root.dataset.theme ?? null, store[THEME_KEY] ?? null]); }
        return JSON.stringify(seen);
      })()`) as string;
    expect(JSON.parse(choose(["dark", "light", "system"]))).toEqual([
      ["dark", "dark"],
      ["light", "light"],
      [null, null],
    ]);
    expect(JSON.parse(choose(["dark", "system"], true))).toEqual([
      ["dark", null],
      [null, null],
    ]);
    expect(page.run("THEME_KEY")).toBe("wf-theme");
  });

  it("the docs site scopes the light set to .dash and the dark set to VitePress's html.dark, with no system query", () => {
    expect(DASH_CSS_TS).toContain("html.dark");
    // the module itself, run with the two stylesheets as its inputs and a head to put its style in
    const code = ts.transpileModule(DASH_CSS_TS, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: { useDashboardCss?: () => void } = {};
    let styled = "";
    vm.runInNewContext(code, {
      exports,
      // the rewrite the module shares with the site's config is the real one; the stylesheets are its inputs
      require: (id: string) =>
        id === "./dash-tokens"
          ? dashTokens
          : { default: id.endsWith("tokens.css?raw") ? TOKENS : COMPONENTS },
      document: {
        getElementById: () => null,
        createElement: () => ({
          set textContent(t: string) {
            styled = t;
          },
        }),
        head: { appendChild() {} },
      },
    });
    exports.useDashboardCss?.();
    expect(styled).toContain("@scope (.dash)");
    expect(styled.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(
      /prefers-color-scheme|:root|data-theme/,
    );
    // `.dash` is two rules (the shared one, the light set): every declaration of the selector, merged
    const rule = (sel: string): Map<string, string> =>
      new Map(
        [
          ...styled.matchAll(
            new RegExp(`(?:^|\\n)${sel.replaceAll(".", "\\.")} \\{([^}]*)\\}`, "g"),
          ),
        ].flatMap(m => [...declared(m[1])]),
      );
    expect(rule(".dash").get("--panel")).toBe(LIGHT.get("--panel"));
    expect(rule(".dash").get("--font")).toMatch(/^Inter/);
    expect(rule("html.dark .dash")).toEqual(DARK);
    expect(rule(".dash").get("--text")).toBe(LIGHT.get("--text"));
    expect(styled).toMatch(/\.dash \{[^}]*color-scheme: light;/);
    expect(styled).toMatch(/html\.dark \.dash \{[^}]*color-scheme: dark;/);
  });

  it("works offline: no web font, no remote stylesheet or script", () => {
    for (const text of [TOKENS, COMPONENTS, PAGE, MAP, SCENE_DOM]) {
      expect(text).not.toMatch(/@import|@font-face|url\(\s*["']?https?:|googleapis|gstatic/);
      expect(text.replaceAll("http://www.w3.org/2000/svg", "")).not.toMatch(/https?:\/\//);
    }
  });

  it("every var(--x) names a token", () => {
    const defined = new Set([...TOKENS.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
    // component-local custom properties: set by a state class or an inline style, read with var()
    // (--lab / --stat: the timeline's column widths; --f: the now-line's place in the window)
    const local = new Set(["--c", "--lab", "--stat", "--f"]);
    const used = new Set(
      [COMPONENTS, PAGE, MAP, SCENE_DOM].flatMap(t =>
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
    // the keyed renderer is its own static file, shared with the documentation site's replay
    expect(MAP).toContain("from '/scene-dom.js'");
    const dom = await fetch(`${base}/scene-dom.js`);
    expect(dom.status).toBe(200);
    expect(await dom.text()).toBe(SCENE_DOM);
  });

  it("the map hands the layout every queue line's kind and each ready line's own", () => {
    // /api/queue's `kind` per id feeds the lanes' marks; a ready line carries its own, and its queue file, into `next:`
    expect(MAP).toContain("byId[l.id] = l.kind;");
    expect(MAP).toContain("kind: l.kind, queue: file });");
    expect(MAP).toMatch(/highlight: lane \|\| undefined, next, kinds, pool/);
  });

  it("the map opens and folds a group of repeated rounds on a click and keeps it across a reload", () => {
    expect(MAP).toContain("closest('[data-group]')");
    expect(MAP).toContain("open: [...openGroups]");
    expect(MAP).toContain("sessionStorage.setItem(OPEN_KEY");
    expect(MAP).toContain("new Set(readOpen())");
  });

  it("a folded group's loop path takes hits on its stroke only, its label anywhere", () => {
    const css = fs.readFileSync(path.join(DASH, "components.css"), "utf8");
    expect(css).toMatch(/path\[data-group\]\s*\{\s*pointer-events:\s*stroke;/);
    expect(css).toMatch(/text\[data-group\]\s*\{\s*pointer-events:\s*all;/);
    expect(css).not.toMatch(/(^|\n)\[data-group\][^}]*pointer-events:\s*all/);
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
  vm.runInContext(`Graph = ${graphModuleExpression()};`, context);
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
      kind: "bug",
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
      kind: "research",
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
      /<span class="diffbar" style="--c:var\(--diff-6\)">▰▰▰▱▱<\/span><span class="kindmark">※<\/span> <span class="dot st-run opus live">/,
    );
    // the strip item: bar, the kind mark (a line with no kind reads as feature), then the plaque
    expect(html).toMatch(
      /<span class="diffbar" style="--c:var\(--diff-3\)">▰▰▱▱▱<\/span><span class="kindmark">◆<\/span><span class="plaque">NEXT-1/,
    );
    // a research line shows its glyph in the plan row
    expect(html).toMatch(/<span class="kindmark">⚑<\/span> <span class="dot st-wait">/);
    // unknown difficulty: five wide placeholder
    const page = loadPage();
    expect(page.run("ui.difficulty(undefined)")).toBe(
      '<span class="diffbar unknown" style="--c:var(--text-4)">?????</span>',
    );
    // no queue line: a blank of the mark's width
    expect(page.run("ui.kind(undefined)")).toBe('<span class="kindmark"> </span>');
  });

  it("the plan card's heading carries the bar and the kind mark of the selected line", () => {
    const page = loadPage();
    page.run(
      `planLines = ${JSON.stringify(QUEUE.lines.map(l => ({ ...l, afterIds: [] })))}; planSelected = "RUN-1"; renderPlanCard();`,
    );
    expect(page.els.get("plan-card")?.innerHTML).toMatch(
      /<span class="diffbar" style="--c:var\(--diff-6\)">▰▰▰▱▱<\/span><span class="kindmark">※<\/span> <span class="plaque">RUN-1/,
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
    expect(views.planOrder).toMatch(/PICK-FIRST[\s\S]*?prio prio-high[^>]*>↑</);
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

  it("timeline: a bar per pipeline, segments in the stage group classes, waits hatched, a day axis", () => {
    const at = (hms: string): number => Date.parse(`2026-11-08T${hms}`);
    const seg = (state: string, group: string, a: string, b: string, waits: object[] = []) => ({
      state,
      group,
      start: at(a),
      end: at(b),
      waits,
    });
    const row = (session: string, name: string, depth: number, segments: object[]) => ({
      session,
      workflow: "w",
      depth,
      role: depth ? name.split(" ")[0] : null,
      model: null,
      round: null,
      name,
      segments,
    });
    const bar = (id: string, label: string, project: string, extra: object = {}) => ({
      id,
      root: "r",
      kind: "task",
      task: label,
      label,
      workflow: "w",
      outcome: "completed",
      result: "landed",
      project,
      duration_ms: 3600000,
      rounds: 2,
      usd: 1.5,
      start: at("10:00:00"),
      end: at("11:00:00"),
      detailed: true,
      rows: [
        row(id, label, 0, [
          seg("gate", "gate", "10:00:00", "11:00:00", [
            { start: at("10:00:00"), end: at("10:15:00") },
          ]),
        ]),
        row(`${id}-w`, "worker r2 · opus", 1, [seg("work", "work", "10:00:00", "10:30:00")]),
        row(`${id}-late`, "review", 1, [seg("review", "review", "11:00:00", "11:00:01")]),
      ],
      ...extra,
    });
    const t = {
      day: "2026-11-08",
      from: at("00:00:00"),
      to: Date.parse("2026-11-09T00:00:00"),
      bars: [
        bar("t1", "LINE-1", "anyparse"),
        bar("t2", "LINE-2", "golf", { result: "failed", usd: null, rounds: 0 }),
        bar("d", "parent · slice-dispatch", "anyparse", {
          kind: "parent",
          rows: [
            row("d", "parent · slice-dispatch", 0, [
              seg("dispatch", "work", "10:00:00", "11:00:00"),
            ]),
          ],
        }),
      ],
    };
    const page = loadPage();
    const html = page.run(`renderTimeline(${JSON.stringify(t)})`) as string;
    expect(html).toContain('<span class="tl-seg gate" style="left:0.000%;width:50.000%"');
    expect(html).toContain('class="tl-wait" style="left:0.000%;width:25.000%"');
    expect(html).toContain('title="gate (gate) · ');
    expect(html).toContain('<a href="/session/t1">LINE-1</a>');
    expect(html).toContain('<a href="/timeline/2026-11-07">');
    expect(html).toContain('<span style="left:0.000%">10:00</span>');
    expect(literals(html)).toEqual([]);
    expect(PAGE).toContain('id="tab-timeline"');
    expect(PAGE).toContain("/api/timeline");

    // folded by default: one row per task (and the dispatcher), a fold button naming how many sessions hide
    expect(html.match(/class="tl-row/g)?.length).toBe(3);
    expect(html).not.toContain("worker r2 · opus");
    expect(html).toContain('data-fold="t1" aria-expanded="false"');

    // the right column: duration, review rounds, $, outcome
    const stats = (html.match(/<div class="tl-stats">(.*?)<\/div>/g) ?? [])[0] ?? "";
    expect(stats).toContain("1h00m");
    expect(stats).toContain(">r2<");
    expect(stats).toContain("$1.50");
    expect(stats).toContain("landed");
    expect(html).toContain(">—<");
    expect(html).toContain("failed");
    // the dispatcher's row is last and carries no $ or outcome
    expect(html.lastIndexOf("parent · slice-dispatch")).toBeGreaterThan(html.indexOf("LINE-2"));

    // an unfold shows the agent rows named by role, model and round; a row with no segment in the window stays out
    page.run('tlOpen.add("t1")');
    const open = page.run(`renderTimeline(${JSON.stringify(t)})`) as string;
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain(">worker r2 · opus</a>");
    expect(open).toContain('<div class="tl-row sub" data-key="tl:t1-w">');

    // zoom buttons, project chips from the bars' projects (none selected = all)
    expect(html).toContain('data-zoom="1"');
    expect(html).toContain('data-zoom="6"');
    expect(html).toContain('data-zoom="day"');
    expect(html).toContain('data-project="anyparse"');
    expect(html).toContain('data-project="golf"');
    page.run('tlProjects.add("golf")');
    const golf = page.run(`renderTimeline(${JSON.stringify(t)})`) as string;
    expect(golf).toContain("LINE-2");
    expect(golf).not.toContain("LINE-1</a>");

    // a zoom of 1 h makes the track wider than the screen; the day fits it again
    page.run('tlProjects.clear(); tlZoom = "1"');
    expect(page.run(`renderTimeline(${JSON.stringify(t)})`)).toMatch(
      /class="tl" style="width:2[0-9]{2}\./,
    );
    page.run('tlZoom = "day"');
    expect(page.run(`renderTimeline(${JSON.stringify(t)})`)).toContain(
      'class="tl" style="width:100.00%"',
    );
    page.run('tlZoom = "fit"; tlOpen.clear()');

    // the now-line is drawn where now falls in the window: today's page only
    expect(html).not.toContain("tl-now");
    const d = new Date();
    const pad = (n: number): string => String(n).padStart(2, "0");
    const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const todayAt = (h: number): number =>
      new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime();
    const today = {
      day,
      from: todayAt(0),
      to: todayAt(24),
      bars: [
        bar("n", "LINE-N", "anyparse", {
          start: Date.now() - 3600000,
          end: Date.now() - 60000,
          rows: [
            row(
              "n",
              "LINE-N",
              0,
              [seg("work", "work", "10:00:00", "11:00:00")].map(g => ({
                ...g,
                start: Date.now() - 3600000,
                end: Date.now() - 60000,
              })),
            ),
          ],
        }),
      ],
    };
    expect(page.run(`renderTimeline(${JSON.stringify(today)})`)).toContain(
      '<div class="tl-now" style="--f:',
    );
  });

  it("cost: totals, the price table's source and date, a trend bar per day", () => {
    const stage = (stage: string, model: string, tokens: number, usd: number) => ({
      stage,
      model,
      effort: "high",
      tokens,
      usd,
    });
    const c = {
      from: "2026-11-08",
      to: "2026-11-08",
      prices: { usd_per_mtok: { sonnet: 6 }, updated: "2026-11-08", source: "src/calibration.ts" },
      tasks: [
        {
          task: "LINE-1",
          outcome: "landed",
          rounds: 2,
          tokens: 1000,
          usd: 0.5,
          stages: [stage("execute", "sonnet", 1000, 0.5)],
        },
      ],
      totals: {
        tasks: 1,
        landed: 1,
        measured_landed: 1,
        tokens: 1000,
        usd: 0.5,
        usd_per_landed: 0.5,
      },
      trend: [
        { day: "2026-11-07", tasks: 0, landed: 0, tokens: 0, usd: 0, usd_per_landed: null },
        { day: "2026-11-08", tasks: 1, landed: 1, tokens: 1000, usd: 0.5, usd_per_landed: 0.5 },
      ],
    };
    const html = loadPage().run(`renderCost(${JSON.stringify(c)})`) as string;
    expect(html).toContain("per landed <b>$0.50</b>");
    expect(html).toContain("LINE-1");
    expect(html).toContain("execute sonnet 1000 $0.50");
    expect(html).toContain("nothing landed");
    expect(html).toContain("updated 2026-11-08");
    expect(html).toContain("src/calibration.ts");
    expect(literals(html)).toEqual([]);
    expect(PAGE).toContain('id="tab-cost"');
    expect(PAGE).toContain("/api/cost");
  });

  it("cost: the price note rounds a blend that is inexact in binary", () => {
    const c = {
      from: "2026-11-08",
      to: "2026-11-08",
      prices: {
        usd_per_mtok: { opus: 0.75 * 1.3 + 0.25 * 5.7 },
        updated: "2026-11-08",
        source: "src/calibration.ts",
      },
      tasks: [],
      totals: { tasks: 0, landed: 0, measured_landed: 0, tokens: 0, usd: 0, usd_per_landed: null },
      trend: [],
    };
    expect(c.prices.usd_per_mtok.opus.toString()).toBe("2.4000000000000004");
    const html = loadPage().run(`renderCost(${JSON.stringify(c)})`) as string;
    expect(html).toContain("opus $2.4;");
    expect(html).not.toMatch(/\d\.\d{6,}/);
  });

  it("plan: an overlaps reason that names a ready line says it is only admitted ahead", () => {
    const q = {
      ...QUEUE,
      lines: [
        { ...QUEUE.lines[1], id: "A", status: "pending", reason: "ready" },
        { ...QUEUE.lines[1], id: "B", status: "pending", reason: "overlaps A (touches x)" },
        { ...QUEUE.lines[0], id: "R" },
        { ...QUEUE.lines[1], id: "C", status: "pending", reason: "overlaps R (touches x)" },
      ],
    };
    const html = loadPage().run(`renderPlan(${JSON.stringify(q)})`) as string;
    expect(html).toContain("overlaps A (touches x) (ready, admitted ahead in the same pass)");
    expect(html).toContain("overlaps R (touches x)<");
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

describe("the Pool tab", () => {
  it("draws the budget, each lease and each waiter with its flags and a session link", () => {
    const page = loadPage();
    const routesJs = ts.transpileModule(
      fs.readFileSync(fileURLToPath(new URL("./dashboard-routes.ts", import.meta.url)), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    page.run(`Routes = (() => { const exports = {}; ${routesJs}\n return exports; })();`);
    const row = (over: object, extra: object) => ({
      entry: {
        id: "e",
        pid: 41,
        threads: 4,
        priority: 0,
        label: "gate",
        cwd: "/w/proj",
        project: "/w/proj",
        session_id: "abcdef123456",
        step: "task/gate",
        arrived: 0,
        ...over,
      },
      request: "4 threads",
      ageMs: 65000,
      overrun: false,
      starved: false,
      ...extra,
    });
    const html = page.run(
      `renderPool(${JSON.stringify({
        budget: 10,
        held: 4,
        load: 3.5,
        external: 0.5,
        load_threshold: 2,
        starve_after: 900,
        locks: ["port:3000"],
        starvedNote: "STARVED: nothing granted for 20m",
        leases: [
          row({ started: 1 }, { overrun: true, runs: 12.3 }),
          row({ started: 2 }, { underuse: true, runs: 0.4 }),
        ],
        waiting: [row({ pid: 42 }, { starved: true, request: "7 threads" })],
      })})`,
    ) as string;
    expect(html).toContain("budget <b>10</b>");
    expect(html).toContain("port:3000");
    expect(html).toContain("STARVED: nothing granted for 20m");
    expect(html).toContain("OVERRUN ~12");
    expect(html).toContain("UNDERUSE ~0");
    expect(html).toContain('href="/session/abcdef123456"');
    expect(html).toContain("7 threads");
    expect(html).toContain("task/gate");
  });

  describe("queue line priority glyphs", () => {
    it("the page draws urgent / high / low as one glyph in token colours and no text, normal as none", () => {
      expect(SCRIPT).toContain("{ urgent: '⇈', high: '↑', low: '↓' }");
      expect(SCRIPT).toContain("PRIO_GLYPHS[l.priority]");
      expect(SCRIPT).not.toContain('flags mono">${escapeHtml(l.priority)');
      for (const k of ["urgent", "high", "low"]) {
        expect(TOKENS).toContain(`--prio-${k}:`);
        expect(COMPONENTS).toContain(`.prio-${k} { color: var(--prio-${k}); }`);
      }
    });
  });
});
