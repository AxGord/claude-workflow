import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { Loader } from "./loader.js";
import { planPick, parseQueue } from "./queue.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** The first fenced yaml block of `rel` that contains `needle`. */
const yamlBlock = (rel: string, needle: string): string => {
  const blocks = [...read(rel).matchAll(/```yaml\n([\s\S]*?)```/g)].map(m => m[1] ?? "");
  const hit = blocks.find(b => b.includes(needle));
  if (hit === undefined) throw new Error(`${rel}: no yaml block containing ${needle}`);
  return hit;
};

const GETTING_STARTED = "docs/getting-started.md";

/** The mode summary paragraph (lines joined), up to the link that follows it. */
const summary = (rel: string): string => {
  const lines = read(rel).split("\n");
  const from = lines.findIndex(l => l.startsWith("**Two ways to use it.**"));
  if (from < 0) throw new Error(`${rel}: no "Two ways to use it" paragraph`);
  let to = from;
  while (lines[to] !== undefined && lines[to] !== "") to++;
  const para = lines.slice(from, to).join(" ");
  return para.slice(0, para.indexOf("Step by step:"));
};

describe("docs: getting started teaches use before authoring", () => {
  it("orders install, the CLAUDE.md snippet, one task, a queue, then your own workflow", () => {
    const text = read(GETTING_STARTED);
    const at = (h: string): number => text.indexOf(`\n${h}\n`);
    const order = [
      "## Quick Start",
      "## Recommended CLAUDE.md Snippet",
      "## Mode 1 — one task at a time",
      "## Mode 2 — a queue of tasks",
      "## Your own workflow",
      "### Ask the agent",
      "### Write the YAML by hand",
      "## Recommended Permissions",
    ].map(at);
    expect(order.every(i => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("the queue example is a real queue: the pick admits T1 and T2 and holds T3 behind T1", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-doc-modes-"));
    dirs.push(dir);
    const file = path.join(dir, "demo.yaml");
    const plan = planPick(parseQueue(yamlBlock(GETTING_STARTED, "batch_size:"), file));
    expect(plan.admitted.map(a => a.id)).toEqual(["T1", "T2"]);
    expect(plan.reasons.map(r => r.id)).toEqual(["T3"]);
    // with a window that is not full, T3 still waits: for T1, by its after:
    const wide = yamlBlock(GETTING_STARTED, "batch_size:").replace(
      "batch_size: 2",
      "batch_size: 5",
    );
    const open = planPick(parseQueue(wide, file));
    expect(open.admitted.map(a => a.id)).toEqual(["T1", "T2"]);
    expect(open.reasons.find(r => r.id === "T3")?.why).toContain("T1");
  });

  it("the by-hand hello.yaml loads through the real loader", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-doc-modes-"));
    dirs.push(dir);
    const project = path.join(dir, ".claude", "workflows");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, "hello.yaml"), yamlBlock(GETTING_STARTED, "name: hello"));
    const hello = new Loader(null, path.join(dir, "global"), project).get("hello");
    expect(hello?.initial).toBe("plan");
  });

  it("the agent path names the skill and the tool that saves, and its quoted file is YAML with the quoted states", () => {
    const text = read(GETTING_STARTED);
    expect(text).toContain("`wf-yaml-authoring`");
    expect(text).toContain("`create`");
    const doc = YAML.parse(yamlBlock(GETTING_STARTED, "name: release")) as {
      initial: string;
      states: Record<string, { transitions?: Record<string, string> }>;
    };
    expect(doc.initial).toBe("choose_bump");
    expect(doc.states["confirm_publish"]?.transitions).toEqual({
      publish: "publish",
      cancel: "cancelled",
    });
  });

  it("says plainly what was not checked", () => {
    const text = read(GETTING_STARTED);
    expect(text).toMatch(/Not checked: running `release` itself/);
    expect(text).toMatch(/Not re-run: a whole dispatch/);
    expect(text).toMatch(/the pane and the dashboard were not looked at/);
  });
});

describe("docs: the two-mode summary is mirrored", () => {
  it("README and the top of concepts carry the same paragraph, before the vocabulary", () => {
    const readme = summary("README.md");
    expect(readme).toBe(summary("docs/concepts.md"));
    expect(readme).toContain("`master`");
    expect(readme).toContain("`batch`");
    expect(readme).toContain("`wf-yaml-authoring`");
    const concepts = read("docs/concepts.md");
    expect(concepts.indexOf("**Two ways to use it.**")).toBeLessThan(
      concepts.indexOf("## The vocabulary"),
    );
  });

  it("the bundled wf-yaml-authoring skill says how to answer a request for a workflow", () => {
    const skill = read("templates/skills/wf-yaml-authoring/SKILL.md");
    expect(skill).toContain("### When a user asks for a workflow");
    expect(skill).toContain('create({ name, scope: "project", definition })');
  });
});
