import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  browserInstalled,
  browserPath,
  ROOT,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";
import type { UseCaseSnapshot, UseCaseStatsSnapshot } from "./use-case.js";
import { PATH_SCENARIOS, slicePath, stageRow } from "./use-case-path.js";
import {
  ANCHORS,
  LESSON_PLACE_NAMES,
  LESSONS,
  LINE_FIELDS,
  maxFixes,
  roundsLane,
  toyStart,
  toyStep,
  type ToyState,
} from "./use-case-scenes.js";

// Pins of ENG-SITE-USE-CASE-ANYPARSE, the page side: the use-case page (docs/use-case-anyparse.md) is linked from
// the landing and the docs nav, and each of its scenes (theme/UseCase*.vue) draws the committed snapshot's facts and
// numbers and answers the reader's choice: the queue line, the pick, the path by difficulty, the review rounds, the
// lessons, the curator, the numbers. Real browser, the built site.
// Pins of ENG-DOCS-USE-CASE-ENGINE: the second page (docs/use-case-engine.md) is in the sidebar and the Docs menu, draws
// the engine's own snapshot (docs/use-case-engine.json) through the numbers scene, and leaves out the panels that
// snapshot has no figures for.

const HAVE_BROWSER = browserInstalled();
const snapshot = JSON.parse(
  fs.readFileSync(path.join(ROOT, "docs/use-case-anyparse.json"), "utf8"),
) as UseCaseSnapshot;
const facts = snapshot.workflow;
const stats = snapshot.stats;
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const engine = JSON.parse(read("docs/use-case-engine.json")) as UseCaseStatsSnapshot;

describe("the engine's use-case page is a page of the site, drawn from its own snapshot", () => {
  const page = read("docs/use-case-engine.md");

  it("is in the sidebar and the Docs menu, and the landing and the README link it", () => {
    expect(read("docs/.vitepress/config.mts").match(/link: "\/use-case-engine"/g)?.length).toBe(2);
    expect(read("docs/index.md")).toContain("](/use-case-engine)");
    expect(read("README.md")).toContain("/use-case-engine)");
  });

  it("places the numbers scene on the engine's snapshot, links the first page, and types no ledger number", () => {
    expect(page).toContain('\n<UseCaseNumbers of="engine" />\n');
    expect(page).toContain("](/use-case-anyparse)");
    for (const n of [engine.stats.runs.total, engine.stats.runs.landed, engine.stats.cost.median])
      expect(page, `the page's text does not type ${n}`).not.toContain(String(n));
  });

  it("names no machine path and no id, and is shorter than the first page", () => {
    expect(page).not.toMatch(/\/Users\/|\/home\/|~\//);
    expect(page).not.toMatch(/\b[0-9a-f]{16,}\b/);
    expect(page.length).toBeLessThan(read("docs/use-case-anyparse.md").length);
  });

  it("is written by the same script, behind --engine, beside the anyparse snapshot", () => {
    const script = read("scripts/export-use-case.mjs");
    expect(script).toContain('"engine" in args');
    expect(script).toContain('landVisit: "mark_done"');
    expect(engine.project).toBe("mcp-workflow-engine");
    expect(engine.task_workflow).toBe("engine-task");
    expect("workflow" in engine).toBe(false);
  });
});

describe("the use-case page is a page of the site", () => {
  it("is in the sidebar and the Docs menu, and the landing links it", () => {
    const config = read("docs/.vitepress/config.mts");
    expect(config.match(/link: "\/use-case-anyparse"/g)?.length).toBe(2);
    expect(read("docs/index.md")).toContain("](/use-case-anyparse)");
  });

  it("places every scene, keeps no storyboard frame, and types no ledger number", () => {
    const page = read("docs/use-case-anyparse.md");
    for (const scene of ["Line", "Pick", "Flow", "Rounds", "Lessons", "Curator", "Numbers"])
      expect(page, scene).toContain(`\n<UseCase${scene} />\n`);
    expect(page).not.toMatch(/storyboard|not built/i);
    for (const n of [stats.runs.total, stats.runs.landed, stats.recon.up, stats.cost.median])
      expect(page, `the page's text does not type ${n}`).not.toContain(String(n));
    // the loop's last scene links back to its first by this heading
    expect(page).toContain("\n## A line enters the queue\n");
  });

  it("the snapshot is written by a script of this repository, named in package.json", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["docs:use-case"]).toBe("node scripts/export-use-case.mjs");
    expect(fs.existsSync(path.join(ROOT, "scripts/export-use-case.mjs"))).toBe(true);
  });
});

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-use-case");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

const SCENE = ".ucf-box";
const look = (page: Page, node: string): Promise<string> =>
  page
    .locator(`${SCENE} [data-node="${node}"]`)
    .evaluate(el => [...el.classList].find(c => c.startsWith("is-")) ?? "");
const litEdges = (page: Page): Promise<string[]> =>
  page
    .locator(`${SCENE} .e-lit path`)
    .evaluateAll(els => els.map(el => el.getAttribute("data-edge") ?? ""));
const steps = (page: Page): Promise<string[]> =>
  page
    .locator(`${SCENE} [data-step]`)
    .evaluateAll(els => els.map(el => el.getAttribute("data-step") ?? ""));
const bars = (effort: string): string =>
  ({ low: "▮▯▯▯", medium: "▮▮▯▯", high: "▮▮▮▯", xhigh: "▮▮▮▮", max: "▮▮▮▮" })[effort] ?? "";

async function open(
  width: number,
  theme: "dark" | "light" = "dark",
  route = "use-case-anyparse",
  ready = `${SCENE} [data-node="execute"]`,
): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(t => localStorage.setItem("vitepress-theme-appearance", t), theme);
  const page = await ctx.newPage();
  await page.goto(`${site?.url ?? ""}${route}`);
  await page.waitForSelector(ready);
  // hydrated: a click is answered
  await page.waitForFunction(
    () =>
      (document.querySelector("#app") as { __vue_app__?: unknown } | null)?.__vue_app__ !==
      undefined,
  );
  await page.waitForTimeout(300);
  return page;
}

describe.skipIf(!HAVE_BROWSER)("the scene: difficulty picks the path", () => {
  it("is drawn in the page's HTML, with its colours, before any script runs", async () => {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      javaScriptEnabled: false,
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${site?.url ?? ""}use-case-anyparse`);
      expect(await page.locator(`${SCENE} [data-node]`).count(), "stations").toBeGreaterThan(8);
      expect(await page.locator(`${SCENE} [data-step]`).count(), "steps").toBeGreaterThan(4);
      expect(await page.locator(`${SCENE} .ucf-run`).count(), "table bars").toBeGreaterThan(4);
      const tokens = await page.locator("head style#dash-tokens").textContent();
      expect(tokens).toContain(".dash-tokens {");
      expect(tokens).toContain("html.dark .dash-tokens {");
      expect(tokens).not.toContain(":root");
      // no script has set a theme: the light set is the one that applies
      expect(await page.locator(SCENE).evaluate(el => getComputedStyle(el).backgroundColor)).toBe(
        "rgb(255, 255, 255)",
      );
      expect(
        await page
          .locator(`${SCENE} [data-node="recon"] rect`)
          .evaluate(el => getComputedStyle(el).stroke),
      ).toBe("rgb(3, 105, 161)");
    } finally {
      await ctx.close();
    }
  });

  it("follows the site's theme: the panel and a stage's colour are the dashboard's tokens", async () => {
    const colours: Record<string, { panel: string; recon: string }> = {};
    for (const theme of ["dark", "light"] as const) {
      const page = await open(1280, theme);
      try {
        colours[theme] = {
          panel: await page.locator(SCENE).evaluate(el => getComputedStyle(el).backgroundColor),
          recon: await page
            .locator(`${SCENE} [data-node="recon"] rect`)
            .evaluate(el => getComputedStyle(el).stroke),
        };
      } finally {
        await page.context().close();
      }
    }
    expect(colours.dark.panel).toBe("rgb(17, 20, 28)");
    expect(colours.light.panel).toBe("rgb(255, 255, 255)");
    expect(colours.dark.recon).toBe("rgb(125, 211, 252)");
    expect(colours.light.recon).toBe("rgb(3, 105, 161)");
  });

  it("opens on the scout's scenario and shows the snapshot's facts and numbers", async () => {
    const page = await open(1280);
    try {
      const first = PATH_SCENARIOS.find(s => s.id === "harder");
      expect(first).toBeDefined();
      const p = slicePath(facts, first ?? PATH_SCENARIOS[0]);
      expect(
        await page
          .locator(`${SCENE} [data-scenario][aria-pressed="true"]`)
          .getAttribute("data-scenario"),
      ).toBe("harder");
      expect(await steps(page)).toEqual(p.steps.map(s => s.node));
      expect(await look(page, "recon")).toBe("is-run");
      expect(await look(page, "plan")).toBe("is-skip");
      expect(await look(page, "execute")).toBe("is-run");
      expect(await look(page, "closed")).toBe("is-off");
      expect(await litEdges(page)).toEqual([
        "claim",
        "prepare",
        "gate",
        "recon",
        "verdict",
        "plan",
        "execute",
        "tail",
      ]);
      const text = ((await page.locator(SCENE).textContent()) ?? "").replace(/\s+/g, " ");
      // the thresholds, from the workflow files
      expect(text).toContain(`difficulty ≥ ${facts.recon_from} ?`);
      expect(text).toContain(`score ≥ ${facts.split_from}`);
      // the agents' rows, from the model table
      const recon = stageRow(facts.table, "recon", first?.line ?? 0);
      const execute = stageRow(facts.table, "execute", p.difficulty);
      expect(await page.locator(`${SCENE} [data-node="recon"] .t-chip`).textContent()).toBe(
        `${recon?.model} ${bars(recon?.effort ?? "")}`,
      );
      expect(await page.locator(`${SCENE} [data-node="execute"] .t-chip`).textContent()).toBe(
        `${execute?.model} ${bars(execute?.effort ?? "")}`,
      );
      expect(await page.locator(`${SCENE} [data-node="claim"] .t-chip`).textContent()).toBe(
        `${facts.driver.model} ${bars(facts.driver.effort)}`,
      );
      expect(await page.locator(`${SCENE} [data-node="rescore"]`).textContent()).toContain(
        `${first?.line} → ${p.difficulty}`,
      );
      // the ledger's numbers
      const scored = stats.recon.kept + stats.recon.up + stats.recon.down;
      expect(await page.locator(`${SCENE} [data-note]`).innerText()).toContain(
        `${stats.recon.up} of ${scored} recon scores were higher`,
      );
      expect(text).toContain(
        `${stats.runs.total} runs of the pipeline, ${stats.runs.landed} landed`,
      );
      expect(snapshot.table_of).toBe("window");
      expect(text).toContain("the model table is the one in force while these runs were made");
      // the model table: a bar per row of every stage, the column at the difficulty the stages run on
      for (const [stage, rows] of Object.entries(facts.table))
        expect(await page.locator(`${SCENE} .ucf-run[data-stage="${stage}"]`).count(), stage).toBe(
          rows.length,
        );
      // the tinted column stands under the difficulty the stages run on; the line's own number is the dashed one
      const centre = (sel: string): Promise<number> =>
        page.locator(`${SCENE} ${sel}`).evaluate(el => {
          const r = el.getBoundingClientRect();
          return Math.round(r.x + r.width / 2);
        });
      expect(await page.locator(`${SCENE} .ucf-col.on`).innerText()).toBe(String(p.difficulty));
      expect(await page.locator(`${SCENE} .ucf-col.was`).innerText()).toBe(String(first?.line));
      expect(
        Math.abs((await centre('[data-band="runs"]')) - (await centre(".ucf-col.on"))),
      ).toBeLessThanOrEqual(1);
      // the column has no edge: nothing is drawn through a bar's label
      expect(
        await page
          .locator(`${SCENE} [data-band="runs"]`)
          .evaluate(el => getComputedStyle(el).borderTopWidth),
      ).toBe("0px");
      const median = stats.difficulty.find(d => d.difficulty === p.difficulty)?.median;
      expect(median).toBeTypeOf("number");
      expect(await page.locator(`${SCENE} .ucf-usd.on`).innerText()).toBe((median ?? 0).toFixed(1));
    } finally {
      await page.context().close();
    }
  });

  it("a choice changes the way: no recon below the threshold, a split, a closed line, a hand-off", async () => {
    const page = await open(1280);
    try {
      // below the threshold: round the recon
      await page.click(`${SCENE} [data-scenario="small"]`);
      expect(await look(page, "recon")).toBe("is-skip");
      expect(await look(page, "verdict")).toBe("is-off");
      expect(await look(page, "plan")).toBe("is-run");
      expect(await litEdges(page)).toEqual([
        "claim",
        "prepare",
        "gate",
        "around",
        "execute",
        "tail",
      ]);
      expect(await steps(page)).not.toContain("recon");
      expect(await page.locator(`${SCENE} .ucf-col.was`).count()).toBe(0);
      expect(await page.locator(`${SCENE} [data-note]`).innerText()).toContain(
        `${stats.runs.total - stats.recon.ran} of ${stats.runs.total} runs took no recon`,
      );

      // the line's own number, by its button: the threshold is where the recon appears
      await page.click(`${SCENE} [data-line="${facts.recon_from - 1}"]`);
      expect(await look(page, "recon")).toBe("is-skip");
      await page.click(`${SCENE} [data-line="${facts.recon_from}"]`);
      expect(await look(page, "recon")).toBe("is-run");
      expect(
        await page
          .locator(`${SCENE} [data-line="${facts.recon_from}"]`)
          .getAttribute("aria-pressed"),
      ).toBe("true");

      // the code's number: at the split threshold the line is split and nothing executes
      await page.click(`${SCENE} [data-seen="${facts.split_from}"]`);
      expect(await look(page, "split")).toBe("is-run");
      expect(await look(page, "execute")).toBe("is-off");
      expect(await look(page, "tail")).toBe("is-off");
      expect(await litEdges(page)).toContain("reconSplit");
      expect((await steps(page)).at(-1)).toBe("split");
      expect(await page.locator(`${SCENE} [data-note]`).innerText()).toContain(
        `The recon split ${stats.recon.split} lines`,
      );
      expect(await page.locator(`${SCENE} [data-note]`).innerText()).toContain(
        `$${stats.recon.stopped.median?.toFixed(2)}`,
      );

      // a premise that fails closes it
      await page.click(`${SCENE} [data-premise]`);
      expect(await look(page, "closed")).toBe("is-run");
      expect(await look(page, "split")).toBe("is-off");
      expect(await litEdges(page)).toContain("reconClosed");
      expect(await page.locator(`${SCENE} [data-premise]`).innerText()).toBe("fails");
      await page.click(`${SCENE} [data-premise]`);

      // a small line that was not: the plan hands its plan to an executor
      await page.click(`${SCENE} [data-scenario="hidden"]`);
      expect(await look(page, "recon")).toBe("is-skip");
      expect(await look(page, "plan")).toBe("is-run");
      const hidden = PATH_SCENARIOS.find(s => s.id === "hidden") ?? PATH_SCENARIOS[0];
      const execute = stageRow(facts.table, "execute", hidden.seen);
      expect(await page.locator(`${SCENE} [data-node="execute"] .t-chip`).textContent()).toBe(
        `${execute?.model} ${bars(execute?.effort ?? "")}`,
      );
      expect(await page.locator(`${SCENE} [data-node="execute"]`).textContent()).toContain(
        "a new agent runs the plan",
      );
      expect(
        await page.locator(`${SCENE} [data-scenario="hidden"]`).getAttribute("aria-pressed"),
      ).toBe("true");
    } finally {
      await page.context().close();
    }
  });

  it("fits a phone: at 390 px the page does not scroll sideways and the chart sits under the choices", async () => {
    for (const theme of ["dark", "light"] as const) {
      const page = await open(390, theme);
      try {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, `${theme}: horizontal overflow`).toBe(0);
        const box = async (
          sel: string,
        ): Promise<{ x: number; y: number; width: number; height: number }> =>
          (await page.locator(`${SCENE} ${sel}`).boundingBox()) ?? {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
          };
        const pick = await box(".ucf-pick");
        const flow = await box(".ucf-flow");
        const scene = await box("");
        expect(flow.y, "the chart is under the choices").toBeGreaterThanOrEqual(
          pick.y + pick.height,
        );
        expect(flow.x + flow.width).toBeLessThanOrEqual(scene.x + scene.width + 0.5);
        // every cost of the last row is its own cell: none runs into the next
        const cells = await page.locator(`${SCENE} .ucf-usd`).evaluateAll(els =>
          els.map(el => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return {
              text: range.getBoundingClientRect().width,
              cell: el.getBoundingClientRect().width,
            };
          }),
        );
        for (const c of cells)
          expect(c.text + 6, "a cost has room in its column").toBeLessThanOrEqual(c.cell);
        // a stage's name stands over its bars, never against them
        const rows = await page.locator(`${SCENE} .ucf-run`).evaluateAll(els =>
          els.map(el => {
            const stage = el.getAttribute("data-stage");
            const label = [...document.querySelectorAll(".ucf-box .ucf-th")].find(
              th => th.textContent === stage,
            ) as Element;
            return {
              stage,
              labelBottom: label.getBoundingClientRect().bottom,
              barTop: el.getBoundingClientRect().top,
            };
          }),
        );
        expect(rows.length).toBeGreaterThan(4);
        for (const r of rows)
          expect(r.labelBottom, `${r.stage}'s label is over its bar`).toBeLessThanOrEqual(r.barTop);
      } finally {
        await page.context().close();
      }
    }
  });

  it("at 1280 px the chart stands beside the choices, the table and the walk in words", async () => {
    const page = await open(1280);
    try {
      const box = async (
        sel: string,
      ): Promise<{ x: number; y: number; width: number; height: number }> =>
        (await page.locator(`${SCENE} ${sel}`).boundingBox()) ?? {
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        };
      const flow = await box(".ucf-flow");
      const pick = await box(".ucf-pick");
      expect(pick.x, "the choices are right of the chart").toBeGreaterThanOrEqual(
        flow.x + flow.width,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        ),
      ).toBe(0);
    } finally {
      await page.context().close();
    }
  });
});

const usd = (n: number | null | undefined): string => (n == null ? "—" : `$${n.toFixed(2)}`);
const flat = async (page: Page, sel: string): Promise<string> =>
  ((await page.locator(sel).first().textContent()) ?? "").replace(/\s+/g, " ").trim();
const attrs = (page: Page, sel: string, name: string): Promise<string[]> =>
  page.locator(sel).evaluateAll((els, n) => els.map(el => el.getAttribute(n) ?? ""), name);

describe.skipIf(!HAVE_BROWSER)("the other scenes of the use-case page", () => {
  it("a line enters the queue: every field says who reads it, the ruler is the ledger's lands", async () => {
    const page = await open(1280);
    try {
      expect(await attrs(page, ".ucl [data-field]", "data-field")).toEqual(
        LINE_FIELDS.map(f => f.key),
      );
      const lit = (): Promise<string[]> => attrs(page, ".ucl .ucl-reader.on", "data-reader");
      const field = (key: string) => LINE_FIELDS.find(f => f.key === key) ?? LINE_FIELDS[0];
      expect(await lit()).toEqual(field("difficulty").readers);
      expect(await flat(page, ".ucl [data-says]")).toContain(field("difficulty").says);
      await page.click('.ucl [data-field="touches"]');
      expect(await lit()).toEqual(field("touches").readers);
      expect(await flat(page, ".ucl [data-says]")).toContain(field("touches").says);
      // the ruler: a bar per difficulty with the ledger's count, an anchor's words, and where such a line goes
      expect(await page.locator(".ucl [data-anchor]").count()).toBe(10);
      for (const d of stats.difficulty)
        expect(
          await page.locator(`.ucl [data-anchor="${d.difficulty}"]`).getAttribute("title"),
        ).toBe(`${d.lands} landed lines ran at difficulty ${d.difficulty}`);
      await page.click(`.ucl [data-anchor="${facts.split_from}"]`);
      const top = ANCHORS.find(a => facts.split_from >= a.from && facts.split_from <= a.to);
      expect(await flat(page, ".ucl [data-anchor-says]")).toContain(top?.says);
      expect(await flat(page, ".ucl [data-anchor-says]")).toContain("cut into smaller lines");
      expect(await flat(page, '.ucl [data-field="difficulty"] .ucl-value')).toBe(
        String(facts.split_from),
      );
      expect(await flat(page, '.ucl [data-field="exclusive"] .ucl-value')).toBe("true");
      await page.click(`.ucl [data-anchor="${facts.recon_from}"]`);
      expect(await flat(page, ".ucl [data-anchor-says]")).toContain(
        "read by a recon before any worker",
      );
      await page.click(`.ucl [data-anchor="${facts.recon_from - 1}"]`);
      expect(await flat(page, ".ucl [data-anchor-says]")).toContain(
        "taken straight to the plan stage",
      );
    } finally {
      await page.context().close();
    }
  });

  it("the pick: the scene's states are the pick's own, a land frees a slot and the pick runs again", async () => {
    const page = await open(1280);
    try {
      const shows = async (state: ToyState): Promise<void> => {
        expect(await attrs(page, ".ucp [data-line]", "data-status")).toEqual(
          state.lines.map(l => l.status),
        );
        for (const [id, why] of Object.entries(state.reasons))
          expect(await flat(page, `.ucp [data-line="${id}"] [data-why]`), id).toBe(why);
        expect(
          (await attrs(page, ".ucp [data-slot]", "data-slot")).filter(id => id !== ""),
        ).toEqual(state.lines.filter(l => l.status === "running").map(l => l.id));
      };
      let state = toyStart(3, snapshot.exclusive_hold);
      await shows(state);
      expect(Object.keys(state.reasons).length).toBeGreaterThan(3);
      // land a running line
      await page.click('.ucp [data-line="WRITER-CHAIN-BREAK"] button');
      state = toyStep(state, { land: "WRITER-CHAIN-BREAK" });
      await shows(state);
      expect(state.admitted).toEqual(["WRITER-CHAIN-TESTS"]);
      // a wider window, a promoted backlog line, and back to the start
      await page.click('.ucp [data-window="5"]');
      state = toyStep(state, { window: 5 });
      await shows(state);
      await page.click('.ucp [data-line="IDEA-PARSE-CACHE"] button');
      state = toyStep(state, { promote: "IDEA-PARSE-CACHE" });
      await shows(state);
      await page.click(".ucp [data-restart]");
      await shows(toyStart(3, snapshot.exclusive_hold));
      // whether a waiting exclusive line holds the lines behind it is the project's queue header's word
      expect(await flat(page, ".ucp [data-hold]")).toContain(
        snapshot.exclusive_hold
          ? "which anyparse's queue keeps"
          : "anyparse's queue header turns that hold off",
      );
      expect(Object.values(toyStart(3, true).reasons).some(why => why.startsWith("held for"))).toBe(
        true,
      );
      expect(Object.values(state.reasons).some(why => why.startsWith("held for"))).toBe(
        snapshot.exclusive_hold,
      );
      // the ledger's hours
      expect(await attrs(page, ".ucp [data-open]", "data-open")).toEqual(
        stats.slots.map(s => String(s.open)),
      );
      const busiest = [...stats.slots].sort((a, b) => b.hours - a.hours)[0];
      expect(await flat(page, `.ucp [data-open="${busiest.open}"]`)).toContain(
        `${busiest.hours} h`,
      );
    } finally {
      await page.context().close();
    }
  });

  it("the review rounds: the lane follows the choice, the meter is the ledger's cost by rounds", async () => {
    const page = await open(1280);
    try {
      const lane = (fixes: number, gateFail = false) =>
        roundsLane(facts, { difficulty: 5, fixes, gateFail });
      const shows = async (fixes: number, gateFail = false): Promise<void> => {
        const want = lane(fixes, gateFail);
        expect(await page.locator(".ucr [data-row]").count()).toBe(want.rows.length);
        expect(await attrs(page, ".ucr [data-step]", "data-step")).toEqual(
          want.rows.flat().map(s => s.id),
        );
        const on = await attrs(page, ".ucr .ucr-bar.on", "data-rounds");
        expect(on).toEqual(want.outcome === "landed" ? [String(want.reviews)] : []);
      };
      await shows(1);
      const two = stats.rounds.find(r => r.rounds === 2);
      expect(await flat(page, '.ucr [data-rounds="2"]')).toContain(usd(two?.median));
      expect(await flat(page, '.ucr [data-rounds="2"]')).toContain(`${two?.lands} lines`);
      expect(await flat(page, ".ucr [data-sum]")).toContain(
        `lands after 2 reviews: the median such line cost ${usd(two?.median)}`,
      );
      await page.click('.ucr [data-fixes="0"]');
      await shows(0);
      await page.click(`.ucr [data-fixes="${maxFixes(facts)}"]`);
      await shows(maxFixes(facts));
      expect(await page.locator('.ucr [data-step="reject"]').count()).toBe(1);
      expect(await flat(page, ".ucr [data-sum]")).toContain(
        `after ${facts.fix_rounds} fix rounds one more FIXES rejects`,
      );
      await page.click('.ucr [data-fixes="1"]');
      await page.click(".ucr [data-gate]");
      await shows(1, true);
      // a step says what happens in it; the review's row is the table's
      await page.click('.ucr [data-row="0"] [data-step="review"]');
      const review = lane(1, true).rows[0].find(s => s.id === "review");
      expect(await flat(page, ".ucr [data-says]")).toContain(review?.says);
      expect(await flat(page, '.ucr [data-row="0"] [data-step="review"]')).toContain(
        stageRow(facts.table, "review", 5)?.model,
      );
      expect(await flat(page, '.ucr [data-row="1"] [data-step="fix"]')).toContain(
        stageRow(facts.table, "fix", 5)?.model,
      );
      // the split by stage
      const parts = stats.stages.rows.filter(r => r.usd > 0);
      expect(await attrs(page, ".ucr .ucr-legend [data-stage]", "data-stage")).toEqual(
        parts.map(r => r.stage),
      );
      const reviewPart = parts.find(r => r.stage === "review");
      expect(await flat(page, '.ucr .ucr-legend [data-stage="review"]')).toContain(
        `${(((reviewPart?.usd ?? 0) / stats.stages.usd) * 100).toFixed(0)}%`,
      );
    } finally {
      await page.context().close();
    }
  });

  it("the lessons: each row goes where its rule sends it, and the places count what arrived", async () => {
    const page = await open(1280);
    try {
      expect(await page.locator(".ucs [data-lesson]").count()).toBe(LESSONS.length);
      for (const [i, lesson] of LESSONS.entries()) {
        await page.click(`.ucs [data-lesson="${i}"]`);
        expect(await attrs(page, ".ucs .ucs-place.on", "data-place"), lesson.says).toEqual([
          lesson.to,
        ]);
        expect(await flat(page, ".ucs [data-rule]")).toBe(lesson.rule);
        expect(await flat(page, `.ucs [data-lesson="${i}"]`)).toContain(
          `→ ${LESSON_PLACE_NAMES[lesson.to]}`,
        );
      }
      for (const place of new Set(LESSONS.map(l => l.to)))
        expect(
          await page
            .locator(`.ucs [data-place="${place}"] [data-count]`)
            .getAttribute("data-count"),
        ).toBe(String(LESSONS.filter(l => l.to === place).length));
      const queued = LESSONS.filter(l => ["high", "normal", "low", "tool"].includes(l.to)).length;
      expect(await flat(page, ".ucs [data-loop]")).toContain(`${queued} new lines in the queue`);
      expect(await page.locator(".ucs [data-loop] a").getAttribute("href")).toBe(
        "#a-line-enters-the-queue",
      );
      expect(await page.locator("h2#a-line-enters-the-queue").count()).toBe(1);
    } finally {
      await page.context().close();
    }
  });

  it("the curator: a run shows its window against the one before, a band opens into its stages", async () => {
    const page = await open(1280);
    try {
      const w = stats.windows;
      expect(await page.locator(".ucc [data-run]").count()).toBe(w.rows.length);
      expect(w.rows.length * w.every + w.rest).toBe(stats.runs.landed);
      const last = w.rows[w.rows.length - 1];
      expect(await flat(page, ".ucc [data-now-usd]")).toBe(usd(last.median));
      expect(await flat(page, ".ucc [data-now-rounds]")).toBe(last.rounds.toFixed(2));
      expect(await flat(page, ".ucc [data-read]")).toContain(
        `Window ${w.rows.length}: lands ${(w.rows.length - 1) * w.every + 1} to ${w.rows.length * w.every}, what a run at today's cadence of ${w.every} lands has in front of it`,
      );
      expect(await flat(page, ".ucc figcaption")).toContain("not the runs that happened");
      expect(await page.locator(".ucc [data-run]").first().getAttribute("aria-label")).toMatch(
        /^Window 1: lands 1 to /,
      );
      const k = w.rows.findIndex(r => r.measured > 0) + 2;
      expect(k).toBeGreaterThan(1);
      await page.click(`.ucc [data-run="${k}"]`);
      expect(await flat(page, ".ucc [data-now-usd]")).toBe(usd(w.rows[k - 1].median));
      expect(await flat(page, ".ucc [data-read]")).toContain(
        `the window before ${usd(w.rows[k - 2].median)}`,
      );
      expect(await attrs(page, ".ucc .ucc-win.before", "data-run")).toEqual([String(k - 1)]);
      // the calibration table
      expect(await attrs(page, ".ucc [data-band]", "data-band")).toEqual(
        stats.bands.map(b => b.band),
      );
      for (const b of stats.bands) {
        const row = await flat(page, `.ucc [data-band="${b.band}"]`);
        expect(row, b.band).toContain(String(b.lands));
        expect(row, b.band).toContain(usd(b.median));
        expect(row, b.band).toContain(b.rounds.toFixed(2));
      }
      const band = stats.bands[stats.bands.length - 1];
      await page.click(`.ucc [data-band="${band.band}"]`);
      expect(await attrs(page, ".ucc [data-stages] [data-stage]", "data-stage")).toEqual(
        band.stages.map(s => s.stage),
      );
      const execute = band.stages.find(s => s.stage === "execute");
      expect(execute).toBeDefined();
      const shown = await flat(page, '.ucc [data-stages] [data-stage="execute"]');
      expect(shown).toContain(usd(execute?.usd));
      for (const model of execute?.models ?? []) expect(shown).toContain(model);
    } finally {
      await page.context().close();
    }
  });

  it("the numbers: every figure is the snapshot's and says how it is counted; the $ is named a yardstick", async () => {
    const page = await open(1280);
    try {
      expect(await flat(page, '.ucn [data-figure="lands"]')).toContain(String(stats.runs.landed));
      expect(await flat(page, '.ucn [data-figure="lands"]')).toContain(
        `of ${stats.runs.total} runs`,
      );
      expect(await flat(page, '.ucn [data-figure="cost"]')).toContain(usd(stats.cost.median));
      expect(await flat(page, '.ucn [data-figure="cost"]')).toContain(
        `mean ${usd(stats.cost.mean)}`,
      );
      expect(await flat(page, '.ucn [data-figure="recon"]')).toContain(
        usd(stats.recon.stopped.median),
      );
      expect(await attrs(page, ".ucn [data-day]", "data-day")).toEqual(stats.days.map(d => d.day));
      for (const r of stats.rounds) {
        const row = await flat(page, `.ucn [data-rounds="${r.rounds}"]`);
        expect(row).toContain(String(r.lands));
        expect(row).toContain(usd(r.median));
      }
      expect(await flat(page, '.ucn [data-recon="raised"]')).toContain(String(stats.recon.up));
      expect(await flat(page, '.ucn [data-recon="closed"]')).toContain(String(stats.recon.closed));
      expect(await attrs(page, ".ucn [data-open]", "data-open")).toEqual(
        stats.slots.map(s => String(s.open)),
      );
      // how a figure is counted
      expect(await flat(page, ".ucn [data-how]")).toContain(
        `${stats.cost.measured} of the ${stats.cost.lands} landed lines`,
      );
      await page.click('.ucn [data-figure="rounds"]');
      expect(await flat(page, ".ucn [data-how]")).toContain("Entries into the review");
      await page.click('.ucn [data-figure="stages"]');
      expect(await flat(page, ".ucn [data-how]")).toContain(`${stats.stages.lands} landed lines`);
      expect(await page.locator('.ucn [data-figure="stages"]').getAttribute("aria-pressed")).toBe(
        "true",
      );
      // the subscription line, and the file itself
      const yard = await flat(page, ".ucn [data-yardstick]");
      expect(yard).toContain("On a subscription no such bill arrives");
      expect(yard).toContain("yardstick of how much of the limit a task used");
      expect(yard).toContain("Exact limit accounting is not published");
      expect(await page.locator(".ucn figcaption a").getAttribute("href")).toBe(
        "https://github.com/AxGord/claude-workflow/blob/master/docs/use-case-anyparse.json",
      );
    } finally {
      await page.context().close();
    }
  });

  it("no scene scrolls a phone sideways or logs an error, in either theme", async () => {
    for (const theme of ["dark", "light"] as const) {
      const page = await open(390, theme);
      const errors: string[] = [];
      page.on("pageerror", e => errors.push(String(e)));
      try {
        for (const scene of ["ucl", "ucp", "ucf-box", "ucr", "ucs", "ucc", "ucn"]) {
          const box = await page.locator(`.${scene}`).boundingBox();
          expect(box, scene).not.toBeNull();
          expect(
            (box?.x ?? 0) + (box?.width ?? 0),
            `${theme} ${scene} ends inside the page`,
          ).toBeLessThanOrEqual(390);
          const inner = await page
            .locator(`.${scene}`)
            .evaluate(el => el.scrollWidth - el.clientWidth);
          expect(inner, `${theme} ${scene} holds what it draws`).toBeLessThanOrEqual(0);
        }
        await page.click('.ucp [data-window="5"]');
        await page.click('.ucr [data-fixes="3"]');
        await page.click('.ucc [data-run="1"]');
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
          theme,
        ).toBe(0);
        expect(errors).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  });
});

describe.skipIf(!HAVE_BROWSER)(
  "the engine's page: the numbers scene on the engine's snapshot",
  () => {
    const st = engine.stats;
    const openEngine = (width: number, theme: "dark" | "light" = "dark"): Promise<Page> =>
      open(width, theme, "use-case-engine", '.ucn[data-of="engine"] [data-figure="lands"]');

    it("draws the engine's figures, says what they are, and leaves out the panels it has no figures for", async () => {
      const page = await openEngine(1280);
      try {
        expect(await flat(page, '.ucn [data-figure="lands"]')).toContain(String(st.runs.landed));
        expect(await flat(page, '.ucn [data-figure="lands"]')).toContain(
          `of ${st.runs.total} runs`,
        );
        expect(await flat(page, '.ucn [data-figure="cost"]')).toContain(usd(st.cost.median));
        expect(await flat(page, '.ucn [data-figure="unlanded"]')).toContain(
          String(st.runs.total - st.runs.landed),
        );
        expect(await attrs(page, ".ucn [data-day]", "data-day")).toEqual(st.days.map(d => d.day));
        for (const r of st.rounds)
          expect(await flat(page, `.ucn [data-rounds="${r.rounds}"]`)).toContain(String(r.lands));
        expect(await attrs(page, ".ucn [data-open]", "data-open")).toEqual(
          st.slots.map(x => String(x.open)),
        );
        // no recon ran and no agent is recorded by stage: those panels and their tile are not drawn
        for (const gone of ["recon", "recon-parts", "stages"])
          expect(await page.locator(`.ucn [data-figure="${gone}"]`).count(), gone).toBe(0);
        await page.click('.ucn [data-figure="unlanded"]');
        expect(await flat(page, ".ucn [data-how]")).toContain("did not land");
        expect(await page.locator(".ucn figcaption a").getAttribute("href")).toBe(
          "https://github.com/AxGord/claude-workflow/blob/master/docs/use-case-engine.json",
        );
        expect(await flat(page, ".ucn figcaption")).toContain("engine-task runs only");
      } finally {
        await page.context().close();
      }
    });

    it("the anyparse page keeps its recon and stage panels", async () => {
      const page = await open(1280);
      try {
        for (const kept of ["recon", "recon-parts", "stages"])
          expect(await page.locator(`.ucn [data-figure="${kept}"]`).count(), kept).toBe(1);
      } finally {
        await page.context().close();
      }
    });

    it("fits a phone in both themes without a sideways scroll or an error", async () => {
      for (const theme of ["dark", "light"] as const) {
        const page = await openEngine(390, theme);
        const errors: string[] = [];
        page.on("pageerror", e => errors.push(String(e)));
        try {
          const inner = await page.locator(".ucn").evaluate(el => el.scrollWidth - el.clientWidth);
          expect(inner, `${theme} the scene holds what it draws`).toBeLessThanOrEqual(0);
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            ),
            theme,
          ).toBe(0);
          expect(errors).toEqual([]);
        } finally {
          await page.context().close();
        }
      }
    });
  },
);
