import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const flat = (p: string) => read(p).replace(/\s+/g, " ");

type State = { prompt?: string; transitions?: Record<string, string> };
const states = (): Record<string, State> =>
  (parse(read("templates/reflection.yaml")) as { states: Record<string, State> }).states;

describe("reflection: a lesson bound for memory asks for its skill home first", () => {
  it("update_memory goes through home_check, whose `skill` is the ENRICH route and `none` reaches action", () => {
    const s = states();
    expect(s.classify?.transitions?.update_memory).toBe("home_check");
    expect(s.home_check?.transitions).toEqual({ skill: "load_skill_manager", none: "action" });
    expect(s.load_skill_manager?.transitions?.continue).toBe("action");
    expect(s.home_check?.prompt).toContain(
      "Name the bundled skill this lesson would have prevented in a DIFFERENT",
    );
  });

  it("the classify table sends a user-corrected approach to a skill", () => {
    const prompt = states().classify?.prompt ?? "";
    expect(prompt).toMatch(
      /\| The user corrected my approach \(not a project fact\) \| Skill \(ENRICH\) \|/,
    );
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

  it("docs/concepts.md says the batch task workflows have no reflect step and names home_check", () => {
    const doc = flat("docs/concepts.md");
    expect(doc).toContain("`home_check`");
    expect(doc).toContain("The batch task workflows have no reflect step by design");
  });
});
