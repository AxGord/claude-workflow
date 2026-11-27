import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const flat = (p: string) => read(p).replace(/\s+/g, " ");

type State = {
  prompt?: string;
  on_complete?: string;
  on_fail?: string;
  transitions?: Record<string, string>;
};
const master = (): Record<string, State> =>
  (parse(read("templates/master.yaml")) as { states: Record<string, State> }).states;

describe("placement routes: every moment something is learned reaches the reflect state", () => {
  it("chat has a `lesson` transition to reflect and ONE prompt line for it", () => {
    const chat = master().chat;
    expect(chat?.transitions?.lesson).toBe("reflect");
    expect(chat?.transitions?.next_task).toBe("route");
    const lines = (chat?.prompt ?? "").split("\n").filter(l => l.includes("`lesson`"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("correction");
    expect(lines[0]).toContain("remember");
  });

  it("research, explore, quick_commit and a failed review_push no longer skip reflect", () => {
    const s = master();
    expect(s.run_research?.on_complete).toBe("reflect");
    expect(s.run_research?.on_fail).toBe("reflect");
    expect(s.run_explore?.on_fail).toBe("reflect");
    expect(s.explore_outcome?.transitions?.done).toBe("reflect");
    expect(s.quick_commit?.transitions?.done).toBe("reflect");
    expect(s.run_review_push?.on_fail).toBe("reflect");
  });

  it("no state but init_generate reaches done while skipping reflect", () => {
    const skipping: string[] = [];
    for (const [name, st] of Object.entries(master())) {
      if (name === "suggest_commit" || name === "route") continue;
      const targets = [st.on_complete, st.on_fail, ...Object.values(st.transitions ?? {})];
      if (targets.includes("done")) skipping.push(name);
    }
    expect(skipping).toEqual([]);
  });

  it("the memory-note forks cite the knowledge-placement skill instead", () => {
    const files = [
      "templates/batch.yaml",
      "templates/curator.yaml",
      "templates/drivers/dispatch-driver.md",
      "templates/skills/wf-yaml-authoring/SKILL.md",
      "docs/queue.md",
    ];
    for (const f of files) {
      const t = flat(f);
      expect(t, f).not.toContain("memory note");
      expect(t, f).toContain("knowledge-placement");
    }
  });
});
