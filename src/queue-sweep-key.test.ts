import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  addQueueLine,
  archiveQueue,
  describeQueue,
  editQueueLine,
  markQueue,
  planPick,
  readQueue,
  restoreQueue,
  TASK_KEYS,
  textHashOf,
} from "./queue.js";
import { formatQueueNext } from "./tools.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const CMD = "hxq lint --rule r --fix src test";

function queue(repoIsGit: boolean): { file: string; proj: string } {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sweep-key-"));
  dirs.push(proj);
  fs.mkdirSync(path.join(proj, ".claude", "batch"), { recursive: true });
  if (repoIsGit) {
    const g = (...a: string[]): string =>
      execFileSync("git", ["-C", proj, ...a], { encoding: "utf8" });
    g("init", "-q");
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first");
  }
  const file = path.join(proj, ".claude", "batch", "q.yaml");
  fs.writeFileSync(file, "batch_size: 3\narchive_after_days: 30\ntasks: []\n");
  return { file, proj };
}

const fieldsOf = (file: string, id: string): Record<string, unknown> =>
  (YAML.parse(fs.readFileSync(file, "utf8")) as { tasks: Record<string, unknown>[] }).tasks.find(
    t => t.id === id,
  ) ?? {};

const head = (proj: string): string =>
  execFileSync("git", ["-C", proj, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

function commit(proj: string, msg: string): string {
  execFileSync(
    "git",
    [
      "-C",
      proj,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      msg,
    ],
    { encoding: "utf8" },
  );
  return head(proj);
}

describe("task key sweep: (ENG-SWEEP-KEY)", () => {
  it("is a known key, ordered after owner and settable by edit", () => {
    const keys: readonly string[] = TASK_KEYS;
    expect(keys.indexOf("sweep")).toBe(keys.indexOf("owner") + 1);
  });

  it("add writes it, the line stays known, the view and the admitted row carry it", async () => {
    const { file } = queue(false);
    await addQueueLine(file, { id: "A", difficulty: 3, touches: ["a"], sweep: CMD, text: "t" });
    await addQueueLine(file, { id: "B", difficulty: 3, touches: ["b"], text: "t" });
    expect(Object.keys(fieldsOf(file, "A")).slice(0, 5)).toEqual([
      "id",
      "status",
      "difficulty",
      "touches",
      "sweep",
    ]);
    const q = readQueue(file);
    expect(q.lines[0].unknownKeys).toEqual([]);
    const plan = planPick(q, { dryRun: true });
    expect(plan.unknownKeys).toEqual([]);
    expect(plan.admitted.map(a => [a.id, a.sweep])).toEqual([
      ["A", CMD],
      ["B", undefined],
    ]);
    expect(describeQueue(q).lines.map(l => l.sweep)).toEqual([CMD, undefined]);
    const rows = formatQueueNext(plan, false)
      .split("\n")
      .filter(l => /^(WOULD ADMIT|ADMITTED \(running\)) /.test(l));
    expect(rows[0]).toMatch(/ \| kind: feature \| sweep: hxq lint --rule r --fix src test$/);
    expect(rows[1]).not.toContain("| sweep:");
  });

  it("gives the pick no meaning: a sweep line overlaps only what its touches overlap", async () => {
    const { file } = queue(false);
    await addQueueLine(file, { id: "A", difficulty: 3, touches: ["a"], sweep: CMD, text: "t" });
    await addQueueLine(file, { id: "B", difficulty: 3, touches: ["b"], text: "t" });
    await addQueueLine(file, { id: "C", difficulty: 3, touches: ["a/x"], text: "t" });
    const plan = planPick(readQueue(file), { dryRun: true });
    expect(plan.admitted.map(a => a.id)).toEqual(["A", "B"]);
    expect(plan.reasons).toEqual([{ id: "C", why: "overlaps A (touches a/x ~ a)" }]);
    expect(describeQueue(readQueue(file)).lines[0].exclusive).toBe(false);
  });

  it("edit sets, changes and removes it", async () => {
    const { file } = queue(false);
    await addQueueLine(file, { id: "A", difficulty: 3, touches: ["a"], text: "t" });
    await editQueueLine(file, "A", { sweep: CMD });
    expect(fieldsOf(file, "A").sweep).toBe(CMD);
    await editQueueLine(file, "A", { sweep: `  ${CMD} x  ` });
    expect(fieldsOf(file, "A").sweep).toBe(`${CMD} x`);
    await editQueueLine(file, "A", { sweep: "" });
    expect("sweep" in fieldsOf(file, "A")).toBe(false);
    await editQueueLine(file, "A", { sweep: CMD });
    await editQueueLine(file, "A", { sweep: null });
    expect("sweep" in fieldsOf(file, "A")).toBe(false);
  });

  it("a change of it rewrites base and text_hash like touches; the same value and a line without it keep them", async () => {
    const { file, proj } = queue(true);
    const first = head(proj);
    await addQueueLine(file, { id: "A", difficulty: 3, touches: ["a"], text: "brief" });
    // a line without sweep hashes exactly as before the key existed
    expect(fieldsOf(file, "A")).toMatchObject({
      base: first,
      text_hash: textHashOf("brief", "a", ""),
    });
    const second = commit(proj, "second");
    await editQueueLine(file, "A", { sweep: CMD });
    expect(fieldsOf(file, "A")).toMatchObject({
      base: second,
      text_hash: textHashOf("brief", "a", "", CMD),
    });
    expect(textHashOf("brief", "a", "", CMD)).not.toBe(textHashOf("brief", "a", ""));
    commit(proj, "third");
    await editQueueLine(file, "A", { sweep: CMD, priority: "high" });
    expect(fieldsOf(file, "A").base).toBe(second);
    const fourth = commit(proj, "fourth");
    await editQueueLine(file, "A", { sweep: "other --fix" });
    expect(fieldsOf(file, "A")).toMatchObject({
      base: fourth,
      text_hash: textHashOf("brief", "a", "", "other --fix"),
    });
    const fifth = commit(proj, "fifth");
    await editQueueLine(file, "A", { sweep: null });
    expect(fieldsOf(file, "A")).toMatchObject({
      base: fifth,
      text_hash: textHashOf("brief", "a", ""),
    });
  });

  it("survives archive and restore, and a mark", async () => {
    const { file } = queue(false);
    await addQueueLine(file, { id: "A", difficulty: 3, touches: ["a"], sweep: CMD, text: "t" });
    await addQueueLine(file, { id: "K", difficulty: 3, touches: ["k"], text: "t" });
    await markQueue(file, "A", "running");
    expect(fieldsOf(file, "A").sweep).toBe(CMD);
    await markQueue(file, "A", "done");
    const text = fs.readFileSync(file, "utf8").replace(/ended: .*/, "ended: 2025-01-01");
    fs.writeFileSync(file, text);
    await archiveQueue(file, { olderThanDays: 30 });
    expect(readQueue(file).lines.map(l => l.id)).toEqual(["K"]);
    await restoreQueue(file, "A");
    const l = readQueue(file).lines.find(x => x.id === "A");
    expect(l?.meta.sweep).toBe(CMD);
    expect(fieldsOf(file, "A").sweep).toBe(CMD);
    expect(l?.unknownKeys).toEqual([]);
  });

  it("refuses a value that is not one non-empty line, naming the key, and writes nothing", async () => {
    const { file } = queue(false);
    await addQueueLine(file, { id: "A", difficulty: 3, touches: ["a"], text: "t" });
    const before = fs.readFileSync(file, "utf8");
    for (const bad of ["   ", "a\nb", "a\r\nb", 5, ["a", "b"], true]) {
      await expect(
        addQueueLine(file, { id: "N", difficulty: 3, touches: ["n"], sweep: bad, text: "t" }),
      ).rejects.toThrow(/sweep/);
      await expect(editQueueLine(file, "A", { sweep: bad })).rejects.toThrow(/sweep/);
    }
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
