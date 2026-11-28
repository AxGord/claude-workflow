import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCuratorConfig } from "./curator.js";
import { applyPlan, parsePlan } from "./curator-apply.js";
import { historyEdit } from "./curator-history.js";

// ENG-CURATOR-SKILL-EDIT-DRIFT: the curator's skills job edits a live skill that has a bundled copy and leaves the
// bundled side stale, so check-skill-sync.sh reports DRIFT and engine commits are refused. After the curator
// applies a change to such a skill, the change is not applied live: it is a proposal that edits the bundled copy, and the land syncs live.

const repoRoot = path.join(__dirname, "..");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-cur-drift-")));
  dirs.push(d);
  return d;
}

function syncCheck(live: string): { code: number; out: string } {
  const r = spawnSync("sh", [path.join(repoRoot, "scripts", "check-skill-sync.sh")], {
    env: { PATH: process.env.PATH, HOME: path.dirname(live), CLAUDE_SKILLS_DIR: live },
    encoding: "utf8",
  });
  return { code: r.status ?? -1, out: r.stdout + r.stderr };
}

describe("curator skills job and a bundled skill", () => {
  it("an edit of a skill that has a bundled copy is proposed, not applied live; one without a bundled copy is applied", () => {
    const root = tmp();
    // the live skills dir equals the bundled copies, so the sync check starts clean
    const live = path.join(root, "live");
    fs.mkdirSync(live);
    for (const set of ["skills", "skills-stack"]) {
      const from = path.join(repoRoot, "templates", set);
      for (const name of fs.readdirSync(from))
        if (name !== "coding-skill-selector")
          // intentionally divergent: .skillsyncignore
          fs.cpSync(path.join(from, name), path.join(live, name), { recursive: true });
    }
    expect(syncCheck(live).code).toBe(0);

    const file = path.join(live, "hxq", "SKILL.md");
    const old = "# hxq — structural Haxe query CLI";
    expect(fs.readFileSync(file, "utf8").split(old).length - 1).toBe(1);
    const config = parseCuratorConfig(
      `edits: direct\njobs:\n  skills: {dirs: [${live}]}\n`,
      path.join(root, "curator.yaml"),
      root,
    );
    const plan = parsePlan(
      JSON.stringify({
        jobs: { skills: { found: 1 } },
        ops: [
          {
            id: "s1",
            job: "skills",
            op: "replace",
            file,
            old,
            new: `${old} (curator edit)`,
            reason: "a tool-skill sentence",
            shape: "no such file <path>",
            shape_transcripts: 4,
          },
        ],
        proposals: [],
        decisions: [],
      }),
      ["skills"],
    ).plan!;
    const r = applyPlan(
      plan,
      { s1: "ok" },
      config,
      { memory: [], skills: [live] },
      "R1",
      path.join(root, "state"),
    );

    // the edit of a skill with a bundled copy is a proposal that names the bundled file; the live side is untouched
    expect(r.applied).toEqual([]);
    expect(r.proposed.map(p => [p.id, p.why])).toEqual([
      [
        "s1",
        "skill hxq has a bundled copy: proposed as an engine-task line that edits templates/skills-stack/hxq; the land syncs the live copy",
      ],
    ]);
    expect(fs.readFileSync(file, "utf8")).not.toContain("(curator edit)");
    const check = syncCheck(live);
    expect(check.code, check.out).toBe(0);

    // a skill with no bundled copy is still applied live
    const own = path.join(live, "my-own-skill");
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, "SKILL.md"), "# mine\n");
    const plan2 = parsePlan(
      JSON.stringify({
        jobs: { skills: { found: 1 } },
        ops: [
          {
            id: "s2",
            job: "skills",
            op: "replace",
            file: path.join(own, "SKILL.md"),
            old: "# mine",
            new: "# mine (curator edit)",
            reason: "a tool-skill sentence",
            shape: "no such file <path>",
            shape_transcripts: 4,
          },
        ],
        proposals: [],
        decisions: [],
      }),
      ["skills"],
    ).plan!;
    const r2 = applyPlan(
      plan2,
      { s2: "ok" },
      config,
      { memory: [], skills: [live] },
      "R1",
      path.join(root, "state"),
    );
    expect(r2.applied.map(a => a.id)).toEqual(["s2"]);

    // a revert of a commit that touched a skill with a bundled copy is a proposal too
    const state = path.join(root, "state");
    const commit = historyEdit(
      live,
      [file],
      "hand edit",
      () => fs.appendFileSync(file, "\nx\n"),
      state,
    );
    const plan3 = parsePlan(
      JSON.stringify({
        jobs: { skills: { found: 1 } },
        ops: [
          {
            id: "s3",
            job: "skills",
            op: "revert",
            target: live,
            commit,
            reason: "shape did not go down",
          },
        ],
        proposals: [],
        decisions: [],
      }),
      ["skills"],
    ).plan!;
    const r3 = applyPlan(plan3, {}, config, { memory: [], skills: [live] }, "R2", state);
    expect(r3.applied).toEqual([]);
    expect(r3.proposed.map(p => p.id)).toEqual(["s3"]);
    expect(r3.proposed[0]?.why).toContain("has a bundled copy");
  });
});
