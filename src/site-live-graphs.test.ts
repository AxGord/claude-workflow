import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { nodeText, statusBandTree, type PaneEl } from "../hooks/pane-view.js";
import { buildApp } from "./dashboard.js";
import { Loader } from "./loader.js";
import { snapshotAt, type ReplayFile } from "./replay.js";
import { Storage } from "./storage.js";
import { graphModuleExpression } from "./test-helpers.js";
import { describeWorkflows, renderWorkflows } from "./workflow-describe.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const PAGE = read("dashboard/index.html");
const GRAPH = read("dashboard/graph.js");
const GRAPHS_VUE = read("docs/.vitepress/theme/WorkflowGraphs.vue");
const STATUS_VUE = read("docs/.vitepress/theme/StatusLine.vue");
const THEME = read("docs/.vitepress/theme/index.ts");
const LANDING = read("docs/index.md");
const PLAN_PANE = read("hooks/plan-pane.tsx");

/** What the tests call of dashboard/graph.js (a plain module with no declarations): run as the dashboard's page runs it. */
interface Graph {
  renderGraph(
    dagre: unknown,
    name: string,
    wf: object | undefined,
    current: string | null,
    stack: object[],
    liveKey?: string,
  ): string;
  stateDetailHtml(state: object): string;
  workflowViewHtml(dagre: unknown, name: string, wf: object | undefined, title?: boolean): string;
}
const graph = vm.runInNewContext(graphModuleExpression()) as Graph;
const dagre = createRequire(import.meta.url)("@dagrejs/dagre") as unknown;

const WORKFLOW = {
  initial: "start",
  states: {
    start: { prompt: "Plan <it>", transitions: { go: "build", "back & forth": "start" } },
    build: { type: "exec", command: "make && test", on_success: "end", on_error: "start" },
    gate: { skills: ["lang-haxe"], transitions: { ok: "end" } },
    outer: { sub_workflow: "inner", on_complete: "end", on_fail: "end" },
    end: { terminal: true },
  },
};

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("the dashboard and the site draw a workflow with one module (dashboard/graph.js)", () => {
  it("the dashboard page keeps no graph renderer of its own: it imports /graph.js", () => {
    expect(PAGE).toContain("import('/graph.js')");
    expect(PAGE).toContain("Graph.renderGraph(dagre,");
    expect(PAGE).toContain("Graph.workflowViewHtml(dagre,");
    expect(PAGE).toContain("Graph.workflowClick(");
    expect(PAGE).not.toMatch(
      /function (renderGraph|pointsToPath|graphNodeKind|toggleStatePrompt)\b/,
    );
    expect(PAGE).not.toContain("dagre.layout(g);\n\n  if (g.nodes().length === 0)");
    // the plan card's edges are drawn with the module's path too
    expect(PAGE).toContain("Graph.pointsToPath(");
  });

  it("the site's component imports the same file and lays out with the dagre package, no copy", () => {
    expect(GRAPHS_VUE).toContain('from "../../../dashboard/graph.js"');
    expect(GRAPHS_VUE).toContain('import dagre from "@dagrejs/dagre"');
    expect(GRAPHS_VUE).toContain("workflowViewHtml(dagre, current.value, wf, false)");
    expect(GRAPHS_VUE).toContain("workflowClick(e, definitions.value,");
    expect(GRAPHS_VUE).not.toMatch(/function (renderGraph|pointsToPath)\b|dagre\.layout/);
  });

  it("a reader who followed a sub-workflow can go back to the workflow the page asked for", () => {
    expect(GRAPHS_VUE).toContain('v-if="current !== workflow"');
    expect(GRAPHS_VUE).toContain('@click="current = workflow"');
  });

  it("the dashboard server serves the module", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-livegraphs-"));
    dirs.push(dir);
    const app = buildApp(new Storage(path.join(dir, "state")), {} as Loader);
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise(r => server.once("listening", r));
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/graph.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/javascript/);
    expect(await res.text()).toBe(GRAPH);
  });

  it("is pure: no DOM or global at load, so the site can render it and a test can run it", () => {
    expect(GRAPH).not.toMatch(/^import /m);
    expect(GRAPH).not.toMatch(
      /\bwindow\b|\bdocument\.(getElementById|querySelector|createElementNS)/,
    );
    expect(typeof graph.renderGraph).toBe("function");
    expect(Object.keys(graph)).toContain("workflowClick");
  });
});

describe("the graph markup", () => {
  const svg = graph.renderGraph(dagre, "w", WORKFLOW, "build", [], "opus");

  it("is an SVG with a node per state, each carrying its state name, classed by kind", () => {
    expect(svg.startsWith("<svg ")).toBe(true);
    expect([...svg.matchAll(/data-gnode="([^"]+)"/g)].map(m => m[1]).sort()).toEqual(
      Object.keys(WORKFLOW.states).sort(),
    );
    expect(svg).toContain('class="g-node live opus"');
    expect(svg).toContain('class="g-node skill"');
    expect(svg).toContain('class="g-node terminal"');
    expect(svg).toContain('class="g-halo"');
    expect(svg).not.toContain("onclick");
  });

  it("escapes what a definition holds", () => {
    expect(svg).toContain("<title>make &amp;&amp; test</title>");
    expect(graph.stateDetailHtml(WORKFLOW.states.start)).toContain("Plan &lt;it&gt;");
  });

  it("a state's panel is its prompt, or its skills, or an action's command, and where it goes", () => {
    const start = graph.stateDetailHtml(WORKFLOW.states.start);
    expect(start).toContain('<div class="box-label">Prompt</div>');
    expect(start).toContain('<div class="transition">go <span class="arrow">→</span> build</div>');
    expect(graph.stateDetailHtml(WORKFLOW.states.gate)).toContain("Required Skills");
    expect(graph.stateDetailHtml(WORKFLOW.states.build)).toContain(
      '<div class="box-label">Command</div>',
    );
    expect(graph.stateDetailHtml({})).toContain("(no prompt)");
  });

  it("a view is the graph and a row per state, named for the workflow", () => {
    const html = graph.workflowViewHtml(dagre, "w", WORKFLOW);
    expect(html).toContain('data-wfview="w"');
    expect(html).toContain("Workflow: w");
    expect([...html.matchAll(/class="frame state-item" data-state="([^"]+)"/g)]).toHaveLength(5);
    expect(html).toContain("[initial]");
    expect(html).toContain("sub: inner");
    expect(graph.workflowViewHtml(dagre, "w", WORKFLOW, false)).not.toContain("Workflow: w");
    expect(graph.workflowViewHtml(dagre, "x", undefined)).toContain(
      "Workflow definition not available",
    );
  });
});

describe("the workflows the site draws (docs/public/workflows.json)", () => {
  it("is what the engine's loader makes of the bundled templates: the file is current", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wf-site-workflows-"));
    dirs.push(empty);
    const loader = new Loader(path.join(ROOT, "templates"), empty, null);
    expect(read("docs/public/workflows.json")).toBe(
      renderWorkflows(describeWorkflows(loader.getAll())),
    );
  });

  it("holds master and coding with their states", () => {
    const all = JSON.parse(read("docs/public/workflows.json")) as Record<
      string,
      { initial: string; states: object }
    >;
    for (const name of ["master", "coding"]) {
      expect(Object.keys(all[name].states).length).toBeGreaterThan(5);
      expect(Object.keys(all[name].states)).toContain(all[name].initial);
    }
    expect(Object.keys(all).length).toBeGreaterThanOrEqual(20);
  });

  it("the REST endpoint and the export share one description", () => {
    expect(read("src/dashboard.ts")).toContain("res.json(describeWorkflows(loader.getAll()))");
    expect(read("scripts/export-workflows.mjs")).toContain("describeWorkflows(loader.getAll())");
    expect(read("package.json")).toContain('"docs:workflows": "node scripts/export-workflows.mjs"');
  });
});

describe("the status line is the mod's own band", () => {
  const file: ReplayFile = {
    version: 1,
    project: "p",
    start: "2026-01-01T00:00:00.000Z",
    durationMs: 1000,
    sessions: ["aaaa", "bbbb"],
    workflows: {},
    taskKinds: {},
    events: [
      [0, "session_start", 0, { workflow: "slice-pipeline", task: "A", difficulty: "7" }],
      [5, "transition", 0, { from: "claim", to: "work", name: "a", workflow: "slice-pipeline" }],
      [20, "session_start", 1, { workflow: "slice-review", parent: "aaaa" }],
    ],
  };

  it("statusBandTree draws the root with children as ◆, the others' count, the queue and the [plan] button", () => {
    const band = statusBandTree(snapshotAt(file, 30)) as PaneEl;
    expect(nodeText(band)).toBe("◆ slice-pipeline:work (1)▶ 1/1 · ⏭ 0 · ✓ 0[plan]");
    expect(JSON.stringify(band)).toContain('"action":{"kind":"pane"}');
    expect(nodeText(statusBandTree(snapshotAt(file, 10)) as PaneEl)).toContain(
      "⚙ slice-pipeline:work",
    );
    expect(statusBandTree({ ...snapshotAt(file, 30), sessions: [] })).toBeNull();
  });

  it("the mod draws that tree, no band of its own; the site draws it from the replay at a chosen moment", () => {
    expect(PLAN_PANE).toContain("draw(statusBandTree(s), $.ui.resolve(e), $)");
    expect(PLAN_PANE).not.toContain('key="band-plan"');
    expect(PLAN_PANE).toContain("case 'pane':");
    expect(STATUS_VUE).toContain('from "../../../hooks/pane-view"');
    expect(STATUS_VUE).toContain("statusBandTree(snapshotAt(file.value, at.value))");
    expect(STATUS_VUE).toContain('type="range"');
    // the band sits above the prompt box, as the mod's AbovePrompt slot places it
    expect(STATUS_VUE.indexOf('class="sl-band"')).toBeGreaterThan(-1);
    expect(STATUS_VUE.indexOf('class="sl-band"')).toBeLessThan(
      STATUS_VUE.indexOf('class="sl-prompt"'),
    );
    expect(STATUS_VUE).toContain("<PaneView");
  });
});

describe("the landing page", () => {
  it("places both as components on a line of their own and keeps no screenshot", () => {
    expect(LANDING).toMatch(/^<WorkflowGraphs \/>$/m);
    expect(LANDING).toMatch(/^<StatusLine \/>$/m);
    expect(THEME).toContain('app.component("WorkflowGraphs", WorkflowGraphs)');
    expect(THEME).toContain('app.component("StatusLine", StatusLine)');
    expect(fs.existsSync(path.join(ROOT, "docs/public/screenshots"))).toBe(false);
    for (const f of ["README.md", "docs/index.md", "docs/concepts.md", "docs/dashboard.md"])
      expect(read(f), f).not.toMatch(/screenshots\/|\.png\)/);
  });

  it("the coding graph and the status line are on the pages that had their pictures", () => {
    expect(read("docs/concepts.md")).toMatch(
      /^<WorkflowGraphs workflow="coding" :picker="false" \/>$/m,
    );
    expect(read("docs/dashboard.md")).toMatch(/^<StatusLine \/>$/m);
  });
});

describe("the install steps come right after the scene", () => {
  const INSTALL = read("docs/.vitepress/theme/Install.vue");

  it("a component in the hero's after-slot behind the scene, so it sits above the features; the markdown no longer has it", () => {
    expect(THEME).toContain('"home-hero-after": () => [h(Scene), h(Install)]');
    expect(LANDING).not.toContain("## Install");
    expect(INSTALL).toContain(
      "/plugin marketplace add https://github.com/anthropics/claude-plugins-community",
    );
    expect(INSTALL).toContain("/plugin install workflow");
    expect(INSTALL).toContain("withBase('/getting-started')");
  });
});

describe("the Status Line page section describes the band; the old script is gone", () => {
  const section = read("docs/dashboard.md").split("## Status Line")[1]?.split("\n## ")[0] ?? "";

  it("says what the band shows and names the last commit that ships the removed script", () => {
    expect(section).toMatch(/^<StatusLine \/>$/m);
    expect(section).toContain("hooks/plan-pane.tsx");
    expect(section).toContain("`[plan]`");
    expect(section).toContain("is removed");
    expect(section).toContain("`4f17809`");
    expect(section).not.toContain("statusLine");
    expect(section).not.toContain("WF_STATUS_LIST");
  });

  it("no script of that name ships", () => {
    expect(fs.existsSync(path.join(ROOT, "scripts/statusline-workflows.sh"))).toBe(false);
  });
});
