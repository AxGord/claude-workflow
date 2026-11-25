import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addQueueLine, describeQueue, editQueueLine, planPick, readQueue } from "./queue.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A git project with a default task workflow and its own research-task workflow. */
function project(): string {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "wf-research-wf-"));
  dirs.push(proj);
  fs.mkdirSync(path.join(proj, ".claude", "batch"), { recursive: true });
  fs.mkdirSync(path.join(proj, ".claude", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(proj, ".claude", "workflows", "research-task.yaml"),
    "name: research-task\n",
  );
  execFileSync("git", ["-C", proj, "init", "-q"]);
  execFileSync("git", [
    "-C",
    proj,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "i",
  ]);
  const file = path.join(proj, ".claude", "batch", "q.yaml");
  fs.writeFileSync(file, "batch_size: 3\ntask_workflow: slice-pipeline\ntasks: []\n");
  return file;
}

describe("kind: research picks the research workflow (ENG-RESEARCH-KIND-PICKS-RESEARCH-WORKFLOW)", () => {
  it("a research line without workflow: is admitted with research-task, not the default", async () => {
    const file = project();
    await addQueueLine(file, {
      id: "R",
      difficulty: 3,
      kind: "research",
      touches: ["a"],
      text: "t",
    });
    const plan = planPick(readQueue(file), { dryRun: true });
    expect(plan.admitted.map(a => [a.id, a.kind, a.workflow])).toEqual([
      ["R", "research", "research-task"],
    ]);
  });

  it("a research line with workflow: slice-pipeline is warned in the add answer", async () => {
    const file = project();
    const r = await addQueueLine(file, {
      id: "R",
      difficulty: 3,
      kind: "research",
      workflow: "slice-pipeline",
      touches: ["a"],
      text: "t",
    });
    expect((r.warnings ?? []).join("\n")).toMatch(/research/i);
    expect((r.warnings ?? []).join("\n")).toMatch(/slice-pipeline/);
  });

  it("the add answer says which workflow the line runs", async () => {
    const file = project();
    const r = await addQueueLine(file, {
      id: "R",
      difficulty: 3,
      kind: "research",
      touches: ["a"],
      text: "t",
    });
    expect(r.runs).toBe("runs workflow research-task");
    expect(r.warnings ?? []).toEqual([]);
  });

  it("the pane's view of the line names the workflow the pick starts", async () => {
    const file = project();
    await addQueueLine(file, {
      id: "R",
      difficulty: 3,
      kind: "research",
      touches: ["a"],
      text: "t",
    });
    await addQueueLine(file, { id: "F", difficulty: 3, touches: ["b"], text: "t" });
    const q = readQueue(file);
    const view = describeQueue(q).lines;
    expect(view.map(l => [l.id, l.workflow])).toEqual([
      ["R", "research-task"],
      ["F", undefined],
    ]);
    expect(planPick(q, { dryRun: true }).admitted.find(a => a.id === "R")?.workflow).toBe(
      view.find(l => l.id === "R")?.workflow,
    );
  });

  it("an explicit research workflow is neither warned nor replaced", async () => {
    const file = project();
    const r = await addQueueLine(file, {
      id: "R",
      difficulty: 3,
      kind: "research",
      workflow: "my-research",
      touches: ["a"],
      text: "t",
    });
    expect(r.warnings ?? []).toEqual([]);
    expect(planPick(readQueue(file), { dryRun: true }).admitted[0]?.workflow).toBe("my-research");
  });

  it("a research line in a project without research-task is warned and keeps the default", async () => {
    const file = project();
    fs.rmSync(path.join(path.dirname(file), "..", "workflows", "research-task.yaml"));
    const r = await addQueueLine(file, {
      id: "R",
      difficulty: 3,
      kind: "research",
      touches: ["a"],
      text: "t",
    });
    expect((r.warnings ?? []).join("\n")).toMatch(/research-task/);
    expect(planPick(readQueue(file), { dryRun: true }).admitted[0]?.workflow).toBeUndefined();
  });

  it("a non-research line keeps its workflow and gets no research note", async () => {
    const file = project();
    const r = await addQueueLine(file, {
      id: "F",
      difficulty: 3,
      workflow: "slice-pipeline",
      touches: ["a"],
      text: "t",
    });
    expect(r.warnings ?? []).toEqual([]);
    expect(planPick(readQueue(file), { dryRun: true }).admitted[0]?.workflow).toBe(
      "slice-pipeline",
    );
  });

  it("queue_edit warns when it makes a line research on a non-research workflow", async () => {
    const file = project();
    await addQueueLine(file, {
      id: "F",
      difficulty: 3,
      workflow: "slice-pipeline",
      touches: ["a"],
      text: "t",
    });
    const r = await editQueueLine(file, "F", { kind: "research" });
    expect((r.warnings ?? []).join("\n")).toMatch(/slice-pipeline/);
    const back = await editQueueLine(file, "F", { workflow: "" });
    expect(back.runs).toBe("runs workflow research-task");
    expect(back.warnings ?? []).toEqual([]);
  });

  it("a research line in another repo is admitted with the queue project's research-task, not warned", async () => {
    const file = project();
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "wf-research-other-"));
    dirs.push(other);
    execFileSync("git", ["-C", other, "init", "-q"]);
    const r = await addQueueLine(file, {
      id: "R",
      difficulty: 3,
      kind: "research",
      repo: other,
      touches: ["a"],
      text: "t",
    });
    expect(r.warnings ?? []).toEqual([]);
    expect(r.runs).toBe("runs workflow research-task");
    expect(planPick(readQueue(file), { dryRun: true }).admitted[0]?.workflow).toBe("research-task");
  });
});
