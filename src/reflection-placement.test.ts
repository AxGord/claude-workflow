import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const flat = (p: string) => read(p).replace(/\s+/g, " ");

type State = { prompt?: string; skills?: string[]; transitions?: Record<string, string> };
const states = (): Record<string, State> =>
  (parse(read("templates/reflection.yaml")) as { states: Record<string, State> }).states;
const SKILL = "templates/skills/knowledge-placement/SKILL.md";

describe("reflection: one placement table, loaded from the bundled knowledge-placement skill", () => {
  it("a lesson loads the skill before classify, and memory is reached with no second question", () => {
    const s = states();
    expect(s.evaluate?.transitions?.has_lesson).toBe("load_placement");
    expect(s.load_placement?.skills).toEqual(["knowledge-placement"]);
    expect(s.load_placement?.transitions).toEqual({ continue: "classify" });
    expect(s.classify?.transitions?.update_memory).toBe("action");
    expect(s.home_check).toBeUndefined();
  });

  it("classify keeps its five routes and holds no table of its own", () => {
    const c = states().classify;
    expect(Object.keys(c?.transitions ?? {}).sort()).toEqual([
      "create_skill",
      "enrich_skill",
      "evolve_workflow",
      "suggest_improvements",
      "update_memory",
    ]);
    expect(c?.prompt).toContain("`knowledge-placement` table");
    expect(c?.prompt).not.toContain("| Destination |");
  });

  it("the skill is the one table: seven rows in order, a repo column, a never-in-memory list, the map line", () => {
    const skill = read(SKILL);
    expect(skill).toMatch(/^name: knowledge-placement$/m);
    const rows = skill.split("\n").filter(l => /^\| [1-7] \|/.test(l));
    expect(rows.map(r => r.split("|")[1]?.trim())).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect(rows[2]).toContain("a user's correction of how to work");
    expect(skill).toContain("| Repo |");
    expect(skill).toContain("**Never in memory**");
    expect(skill).toContain("`Placement: <file> § <heading>`");
    expect(skill).toContain("never memory");
    expect(skill).not.toMatch(/\/Users\/|~\/dev/);
  });

  it("the other templates cite the table and no longer carry a classification of their own", () => {
    const sm = flat("templates/skills/skill-manager/SKILL.md");
    expect(sm).toContain("Load `knowledge-placement`");
    expect(sm).not.toContain("Log optimizations");
    expect(sm).not.toContain("note in MEMORY.md");
    expect(sm).not.toContain("belong in memory");
    const cleanup = flat("templates/skills/cleanup/SKILL.md");
    expect(cleanup).toContain("Load the `knowledge-placement` skill");
    expect(cleanup).not.toContain("common knowledge / project-specific");
    const lint = flat("templates/lint-review.yaml");
    expect(lint).toContain("baseline or suppression in the project's lint config");
    expect(lint).not.toContain("BY-DESIGN in project memory");
    expect(flat("templates/reflection.yaml")).not.toContain("prefer skills over memory");
  });

  it("suggest_improvements ends the turn on the suggestion and moves only on the user's answer", () => {
    const prompt = (states().suggest_improvements?.prompt ?? "").replace(/\s+/g, " ");
    expect(prompt).toContain("END YOUR TURN with the list and call no transition");
    expect(prompt).toContain("Call the transition on the user's next message");
    expect(prompt).toContain("no interactive user");
    expect(states().suggest_improvements?.transitions?.evolve).toBe("load_workflow_authoring");
  });

  it("skill-manager ENRICH is also triggered by a user-corrected process pattern, with no code verification", () => {
    const skill = flat("templates/skills/skill-manager/SKILL.md");
    expect(skill).toContain(
      "a verifiable mistake or a user-corrected process pattern (state the rule and the tell; no code verification needed)",
    );
    expect(skill).toContain("A factual gotcha keeps this verified path unchanged");
  });

  it("docs/concepts.md names the placement skill and says the batch task workflows have no reflect step", () => {
    const doc = flat("docs/concepts.md");
    expect(doc).toContain("loads the bundled `knowledge-placement` skill");
    expect(doc).not.toContain("`home_check`");
    expect(doc).toContain("The batch task workflows have no reflect step by design");
  });
});
