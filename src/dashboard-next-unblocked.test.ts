// Reproduces ENG-DASHBOARD-NEXT-UNBLOCKED: with an exclusive line running, the dashboard's Next stays empty.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { describeQueue, parseQueue } from "./queue.js";
import { markdownToYaml } from "./queue-convert.js";

const PAGE = fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dashboard", "index.html"),
  "utf8",
);
const SCRIPT = PAGE.split("<script>")[1]?.split("</script>")[0] ?? "";

function el(): Record<string, unknown> {
  let text = "";
  return {
    innerHTML: "",
    get textContent() {
      return text;
    },
    // escapeHtml reads innerHTML back after setting textContent
    set textContent(v: string) {
      text = v;
      this.innerHTML = v;
    },
    className: "",
    style: {},
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollIntoView() {},
    after() {},
  };
}

function renderPlan(q: unknown): string {
  const marker = "// The page opens on the view its path names";
  const ctx = vm.createContext({
    document: {
      getElementById: () => el(),
      createElement: el,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    location: { pathname: "/" },
    fetch: () => Promise.resolve({ ok: false }),
    console,
  });
  vm.runInContext(SCRIPT.slice(0, SCRIPT.indexOf(marker)), ctx);
  const layoutJs = ts.transpileModule(
    fs.readFileSync(fileURLToPath(new URL("./map-layout.ts", import.meta.url)), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  vm.runInContext(`Layout = (() => { const exports = {}; ${layoutJs}\n return exports; })();`, ctx);
  return vm.runInContext(`renderPlan(${JSON.stringify(q)})`, ctx) as string;
}

describe("ENG-DASHBOARD-NEXT-UNBLOCKED", () => {
  it("Next lists the lines a running exclusive line unblocks, as the pane does", () => {
    const body = (id: string, rest: string) =>
      `- [ ] ${id} | repo: /tmp | ${rest} | text of ${id} is long enough to be prose here`;
    const md = [
      "# x",
      "batch_size: 1",
      "## Tasks",
      "- [>] RUN | repo: /tmp | exclusive: yes | text of run is long enough to be prose here",
      body("P-LOW", "touches: src/a.ts | priority: low"),
      body("P-HIGH", "touches: src/b.ts | priority: high"),
      body("P-AFTER", "after: P-LOW"),
      "",
    ].join("\n");
    const view = describeQueue(parseQueue(markdownToYaml(md), "/tmp/q.md"));
    expect(
      view.lines
        .filter(l => l.unblockOrder !== undefined)
        .map(l => l.id)
        .sort(),
    ).toEqual(["P-HIGH", "P-LOW"]);
    const html = renderPlan(view);
    const next = html.slice(html.indexOf("next:"), html.indexOf("Running ("));
    expect(next).toContain("P-HIGH");
    expect(next).toContain("P-LOW");
    expect(next.indexOf("P-HIGH")).toBeLessThan(next.indexOf("P-LOW"));
    expect(next).not.toContain("P-AFTER");
  });
});
