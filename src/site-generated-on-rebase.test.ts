import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { SITE_WORKFLOWS_FILE, writeSiteWorkflows } from "./site-workflows.js";
import { graphModuleExpression } from "./test-helpers.js";

interface Graph {
  escapeHtml(v: unknown): string;
  box(text: unknown): string;
}
const graph = vm.runInNewContext(graphModuleExpression()) as Graph;

describe("ENG-SITE-GENERATED-ON-REBASE: the shared graph module's escapeHtml", () => {
  it("renders null and undefined as empty, as the dashboard's former textContent did", () => {
    expect(graph.escapeHtml(null)).toBe("");
    expect(graph.escapeHtml(undefined)).toBe("");
    expect(graph.box(null)).not.toContain("null");
  });
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();

describe("ENG-SITE-GENERATED-ON-REBASE: docs/public/workflows.json is a build product", () => {
  it("is git-ignored and not tracked, so a template edit cannot leave a stale copy", () => {
    expect(git("ls-files", "docs/public/workflows.json")).toBe("");
    expect(git("check-ignore", "docs/public/workflows.json")).toBe("docs/public/workflows.json");
  });

  it("every site script writes it before the site is built, served or previewed", () => {
    const { scripts } = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(scripts["docs:prepare"]).toBe("npm run build && npm run docs:workflows");
    for (const name of ["docs:dev", "docs:build"]) {
      expect(scripts[name]).toMatch(/^npm run docs:prepare && vitepress /);
    }
    expect(scripts["docs:preview"]).toMatch(/^npm run docs:build && /);
  });

  it("the test run writes it through the one writer the export script uses", () => {
    expect(read("vitest.config.ts")).toContain('globalSetup: ["src/site-workflows-setup.ts"]');
    expect(read("src/site-workflows-setup.ts")).toContain("writeSiteWorkflows(root)");
    expect(read("scripts/export-workflows.mjs")).toContain("writeSiteWorkflows(root)");
  });

  it("writeSiteWorkflows rewrites a stale file from the templates (on a temp root, never the checkout's file)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-site-root-"));
    try {
      fs.symlinkSync(path.join(ROOT, "templates"), path.join(root, "templates"));
      const file = path.join(root, SITE_WORKFLOWS_FILE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "stale");
      const out = writeSiteWorkflows(root);
      expect(out.file).toBe(file);
      expect(fs.readFileSync(file, "utf8")).toBe(read(SITE_WORKFLOWS_FILE));
      expect(out.text).toBe(read(SITE_WORKFLOWS_FILE));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writeSiteWorkflows replaces the file atomically: it never writes the file itself, only renames a finished one onto it", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-site-root-"));
    const write = vi.spyOn(fs, "writeFileSync");
    const rename = vi.spyOn(fs, "renameSync");
    try {
      fs.symlinkSync(path.join(ROOT, "templates"), path.join(root, "templates"));
      const { file } = writeSiteWorkflows(root);
      const wrote = write.mock.calls.map(c => String(c[0]));
      expect(wrote, "the export's own file is never opened for writing").not.toContain(file);
      expect(rename.mock.calls.map(c => String(c[1]))).toEqual([file]);
      expect(fs.readdirSync(path.dirname(file)), "no partial file is left beside it").toEqual([
        path.basename(file),
      ]);
    } finally {
      write.mockRestore();
      rename.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
