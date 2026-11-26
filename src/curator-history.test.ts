import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCuratorConfig } from "./curator.js";
import { applyPlan, parsePlan } from "./curator-apply.js";
import {
  historyDiff,
  historyEdit,
  historyGitDir,
  historyLog,
  historyRevert,
} from "./curator-history.js";

// ENG-CURATOR-SERVICE: every curator edit of a target directory is one commit of a shadow git directory in the
// engine's state (never a `.git` in the target), with a diff and a revert of its own; and the apply step edits
// nothing unless the project consents (`edits: direct`), and even then never a memory rule's meaning or a
// preferences skill.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-cur-hist-")));
  dirs.push(d);
  return d;
}

function memory(root: string): string {
  const mem = path.join(root, "memory");
  fs.mkdirSync(mem);
  fs.writeFileSync(
    path.join(mem, "MEMORY.md"),
    "# Index\n\n- [A](a.md) — rule a\n- [B](b.md) — rule b\n",
  );
  fs.writeFileSync(path.join(mem, "ARCHIVE.md"), "# Archive\n");
  fs.writeFileSync(path.join(mem, "a.md"), "---\ndescription: a\n---\nAlways a.\n");
  fs.writeFileSync(path.join(mem, "b.md"), "---\ndescription: b\n---\nAlways b.\n");
  return mem;
}

describe("curator shadow history", () => {
  it("commits each edit outside the target, shows its diff, and reverts one edit while keeping the others", () => {
    const root = tmp();
    const state = path.join(root, "state");
    const mem = memory(root);
    const a = path.join(mem, "a.md");
    const b = path.join(mem, "b.md");
    const c1 = historyEdit(
      mem,
      [a],
      "edit 1: a",
      () => fs.writeFileSync(a, "Always a, twice.\n"),
      state,
    );
    const c2 = historyEdit(
      mem,
      [b],
      "edit 2: b",
      () => fs.writeFileSync(b, "Always b, twice.\n"),
      state,
    );
    expect(c1).toMatch(/^[0-9a-f]{40}$/);
    expect(fs.existsSync(path.join(mem, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(historyGitDir(mem, state), "HEAD"))).toBe(true);
    expect(
      historyLog(mem, state)
        .split("\n")
        .map(l => l.slice(41)),
    ).toEqual([
      "edit 2: b",
      "baseline: the files as found before the next edit",
      "edit 1: a",
      "baseline: the files as found before the next edit",
    ]);
    expect(historyDiff(mem, c1 as string, state)).toContain("+Always a, twice.");
    historyRevert(mem, c1 as string, state);
    expect(fs.readFileSync(a, "utf8")).toBe("---\ndescription: a\n---\nAlways a.\n");
    expect(fs.readFileSync(b, "utf8")).toBe("Always b, twice.\n");
    expect(c2).not.toBeNull();
    // an edit that changes nothing is no commit
    expect(historyEdit(mem, [b], "no-op", () => {}, state)).toBeNull();
  });

  it("a revert whose lines were edited since by hand is refused and leaves the target as it was", () => {
    const root = tmp();
    const state = path.join(root, "state");
    const mem = memory(root);
    const a = path.join(mem, "a.md");
    const c1 = historyEdit(
      mem,
      [a],
      "edit",
      () => fs.writeFileSync(a, "Always a, twice.\n"),
      state,
    ) as string;
    fs.writeFileSync(a, "A hand edit.\n");
    expect(() => historyRevert(mem, c1, state)).toThrow(/refused/);
    expect(fs.readFileSync(a, "utf8")).toBe("A hand edit.\n");
  });
});

describe("curator apply: consent", () => {
  const planText = (mem: string, skills: string): string =>
    JSON.stringify({
      jobs: { memory: { found: 3 }, skills: { found: 2 } },
      ops: [
        {
          id: "m1",
          job: "memory",
          op: "move-index",
          file: path.join(mem, "b.md"),
          from: "MEMORY.md",
          to: "ARCHIVE.md",
          reason: "b is cold",
        },
        {
          id: "m2",
          job: "memory",
          op: "replace",
          file: path.join(mem, "a.md"),
          old: "Always a.",
          new: "Never a.",
          meaning: true,
          reason: "a is wrong",
        },
        {
          id: "s1",
          job: "skills",
          op: "replace",
          file: path.join(skills, "tool", "SKILL.md"),
          old: "Use x.",
          new: "Use x; quote the path.",
          reason: "error shape",
          shape: "no such file <path>",
          shape_transcripts: 4,
        },
        {
          id: "s2",
          job: "skills",
          op: "replace",
          file: path.join(skills, "preferences-x", "SKILL.md"),
          old: "Prefer a.",
          new: "Prefer b.",
          reason: "taste",
        },
      ],
      proposals: ["queue: add a tool fix"],
      decisions: [],
    });

  function setup(edits: string): {
    mem: string;
    skills: string;
    state: string;
    run: () => ReturnType<typeof applyPlan>;
  } {
    const root = tmp();
    const state = path.join(root, "state");
    const mem = memory(root);
    const skills = path.join(root, "skills");
    for (const [n, t] of [
      ["tool", "Use x.\n"],
      ["preferences-x", "Prefer a.\n"],
    ]) {
      fs.mkdirSync(path.join(skills, n), { recursive: true });
      fs.writeFileSync(path.join(skills, n, "SKILL.md"), t);
    }
    const config = parseCuratorConfig(
      `edits: ${edits}\njobs:\n  memory: {dirs: [${mem}]}\n  skills: {dirs: [${skills}]}\n`,
      path.join(root, "curator.yaml"),
      root,
    );
    const plan = parsePlan(planText(mem, skills), ["memory", "skills"]).plan!;
    const verdicts = { m2: "ok", s1: "ok", s2: "ok" };
    return {
      mem,
      skills,
      state,
      run: () =>
        applyPlan(plan, verdicts, config, { memory: [mem], skills: [skills] }, "R1", state),
    };
  }

  it("by default (edits: propose) applies nothing and lists every op as a proposal", () => {
    const { mem, skills, state, run } = setup("propose");
    const before = fs.readFileSync(path.join(mem, "MEMORY.md"), "utf8");
    const r = run();
    expect(r.applied).toEqual([]);
    expect(r.proposed.map(p => [p.id, p.why])).toEqual(
      ["m1", "m2", "s1", "s2"].map(id => [
        id,
        "consent: propose (the default; `edits: direct` in the config applies)",
      ]),
    );
    expect(fs.readFileSync(path.join(mem, "MEMORY.md"), "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(skills, "tool", "SKILL.md"), "utf8")).toBe("Use x.\n");
    expect(fs.existsSync(path.join(state, "curator-history"))).toBe(false);
  });

  it("edits: direct applies the mechanical move and a verified tool-skill sentence; a memory meaning edit and a preferences skill stay proposed", () => {
    const { mem, skills, state, run } = setup("direct");
    const r = run();
    expect(r.applied.map(a => a.id)).toEqual(["m1", "s1"]);
    expect(Object.fromEntries(r.proposed.map(p => [p.id, p.why]))).toEqual({
      m2: "changes a memory rule's meaning: proposed only",
      s2: "a preferences skill: the user's own taste, proposed only",
    });
    expect(fs.readFileSync(path.join(mem, "MEMORY.md"), "utf8")).not.toContain("b.md");
    expect(fs.readFileSync(path.join(mem, "ARCHIVE.md"), "utf8")).toContain("- [B](b.md) — rule b");
    expect(fs.readFileSync(path.join(skills, "tool", "SKILL.md"), "utf8")).toBe(
      "Use x; quote the path.\n",
    );
    // the commit names the run, the job and the shape the next run measures
    const s1 = r.applied.find(a => a.id === "s1")?.commit as string;
    expect(historyDiff(skills, s1, state)).toMatch(
      /curator R1 skills s1[\s\S]*shape: no such file <path>\nshape_transcripts: 4/,
    );
    expect(fs.existsSync(path.join(skills, ".git"))).toBe(false);
  });

  it("edits: direct moves a file to another memory dir with its index line (two commits), and a link into an index that does not exist yet", () => {
    const root = tmp();
    const state = path.join(root, "state");
    const mem = memory(root);
    fs.rmSync(path.join(mem, "ARCHIVE.md"));
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    const config = parseCuratorConfig(
      `edits: direct\njobs:\n  memory: {dirs: [${mem}, ${other}]}\n`,
      path.join(root, "curator.yaml"),
      root,
    );
    const plan = parsePlan(
      JSON.stringify({
        jobs: { memory: { found: 2 } },
        ops: [
          {
            id: "f1",
            job: "memory",
            op: "move-file",
            file: path.join(mem, "a.md"),
            to_dir: other,
            reason: "engine knowledge",
          },
          {
            id: "i1",
            job: "memory",
            op: "move-index",
            file: path.join(mem, "b.md"),
            from: "MEMORY.md",
            to: "ARCHIVE.md",
            reason: "cold",
          },
        ],
      }),
      ["memory"],
    ).plan;
    if (!plan) throw new Error("plan");
    const r = applyPlan(plan, {}, config, { memory: [mem, other], skills: [] }, "R2", state);
    expect(r.proposed).toEqual([]);
    expect(r.applied.map(a => [a.id, a.target])).toEqual([
      ["f1", other],
      ["f1", mem],
      ["i1", mem],
    ]);
    expect(r.applied.every(a => a.commit !== null)).toBe(true);
    expect(fs.readFileSync(path.join(other, "a.md"), "utf8")).toBe(
      "---\ndescription: a\n---\nAlways a.\n",
    );
    expect(fs.readFileSync(path.join(other, "MEMORY.md"), "utf8")).toBe("- [A](a.md) — rule a\n");
    expect(fs.existsSync(path.join(mem, "a.md"))).toBe(false);
    expect(fs.readFileSync(path.join(mem, "MEMORY.md"), "utf8")).toBe("# Index\n\n");
    expect(fs.readFileSync(path.join(mem, "ARCHIVE.md"), "utf8")).toBe("- [B](b.md) — rule b\n");
  });

  it("an unverified text edit is never applied, whatever the consent", () => {
    const { run } = setup("direct");
    const r = run();
    expect(r.applied.some(a => a.id === "m2")).toBe(false);
    const plan = parsePlan(JSON.stringify({ jobs: { memory: { found: 0 } }, ops: [] }), [
      "memory",
      "skills",
    ]);
    expect(plan.errors).toEqual([
      "jobs.skills.found: a whole number (the findings of this job; 0 = none)",
    ]);
  });
});
