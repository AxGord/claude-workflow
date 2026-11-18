import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { InMemoryStorage, cleanupDir, createTestLoader } from "./test-helpers.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const names = (dir: string): string[] =>
  fs
    .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

/** Every `skills:` array of a workflow file, however deep. */
function skillGroups(node: unknown, out: string[][] = []): string[][] {
  if (Array.isArray(node)) for (const n of node) skillGroups(n, out);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "skills" && Array.isArray(v) && v.every(x => typeof x === "string")) out.push(v);
      else skillGroups(v, out);
    }
  }
  return out;
}

describe("stack skills never block a skills: gate", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanupDir(d);
  });

  it("no bundled or project workflow requires a stack skill: a stack skill in a skills: group is optional (?name)", () => {
    const stack = new Set(names("templates/skills-stack"));
    const dirsToScan = ["templates", ".claude/workflows"];
    let groups = 0;
    const required: string[] = [];
    for (const d of dirsToScan) {
      const abs = path.join(ROOT, d);
      if (!fs.existsSync(abs)) continue;
      for (const f of fs.readdirSync(abs).filter(n => n.endsWith(".yaml"))) {
        for (const group of skillGroups(parse(fs.readFileSync(path.join(abs, f), "utf8")))) {
          groups++;
          for (const s of group) if (stack.has(s)) required.push(`${d}/${f}: ${s}`);
        }
      }
    }
    expect(groups).toBeGreaterThan(5);
    expect(required).toEqual([]);
  });

  it("a gate that names an absent stack skill as optional says to skip it if not found, and the transition goes through", async () => {
    const storage = new InMemoryStorage();
    const { loader, dir } = createTestLoader({
      wf: {
        initial: "start",
        states: {
          start: { prompt: "go", transitions: { load_skills: "gate" } },
          gate: {
            prompt: "gate",
            skills: ["coding-skill-selector", "?lang-not-installed"],
            transitions: { continue: "work" },
          },
          work: { prompt: "work", transitions: { done: "end" } },
          end: { prompt: "done", terminal: true, outcome: "complete" },
        },
      },
    });
    dirs.push(dir);
    const engine = new Engine(storage, loader, new Executor());
    const { sessionId } = await engine.start("wf");
    const gate = await engine.transition(sessionId, "load_skills");
    expect(gate.currentStateName).toBe("gate");
    expect(JSON.stringify(gate)).toContain("Load these skills if available (skip if not found)");
    const after = await engine.transition(sessionId, "continue");
    expect(after.currentStateName).toBe("work");
  });
});

describe("coding-skill-selector offers a stack skill, never installs one silently", () => {
  const selector = fs.readFileSync(
    path.join(ROOT, "templates/skills/coding-skill-selector/SKILL.md"),
    "utf8",
  );

  it("names the install command, the available and deleted states, and the user's yes", () => {
    const rule = selector.slice(selector.indexOf("**Stack skills"));
    expect(rule).toContain("wf-skills add <name>");
    expect(rule).toContain("list --json");
    expect(rule).toMatch(/"state": "available"[^]*ONCE/);
    expect(rule).toMatch(/"state": "deleted"[^]*never offer it again/);
    expect(rule).toContain("Never run `wf-skills add` without the user's yes");
  });

  it("every stack skill the selector maps is one the plugin ships in the pack", () => {
    const stack = new Set(names("templates/skills-stack"));
    const mapped = [...selector.matchAll(/Skill\("([a-z0-9-]+)"\)/g)].map(m => m[1]);
    const inPack = mapped.filter(n => stack.has(n));
    // the selector's own language, domain and tool rows all resolve to the pack or to the default set
    const defaults = new Set(names("templates/skills"));
    const unknown = mapped.filter(
      n => !stack.has(n) && !defaults.has(n) && !n.startsWith("preferences-") && n !== "lint-setup",
    );
    expect(unknown).toEqual([]);
    expect(inPack.length).toBeGreaterThan(8);
  });
});
