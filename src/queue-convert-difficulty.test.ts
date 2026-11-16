import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readQueue } from "./queue.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const QUEUE =
  "batch_size: 3\ntasks:\n  - id: EXISTING\n    status: backlog\n    text: |-\n      an existing line\n";
// an old-format row with no `difficulty:`
const OLD_MD =
  "batch_size: 3\n\n## Tasks\n- [ ] NODIFF | touches: src/a.ts | a task with no difficulty |\n";

/** Runs the real wf-queue CLI entry with `args`; returns its exit code and output. */
async function wfQueue(
  args: string[],
): Promise<{ code: number | string | undefined; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const argv = process.argv;
  vi.spyOn(process.stdout, "write").mockImplementation(c => (out.push(String(c)), true));
  vi.spyOn(process.stderr, "write").mockImplementation(c => (err.push(String(c)), true));
  process.argv = ["node", "wf-queue", ...args];
  process.exitCode = undefined;
  try {
    vi.resetModules();
    await import("./queue-cli.js");
    for (let i = 0; i < 200 && process.exitCode === undefined; i++)
      await new Promise(r => setTimeout(r, 10));
    return { code: process.exitCode, out: out.join(""), err: err.join("") };
  } finally {
    process.argv = argv;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  }
}

describe("wf-queue --convert --into <existing> --status pending", () => {
  it("refuses (exit 2, file unchanged) a pending line with no difficulty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-convdiff-"));
    dirs.push(root);
    const md = path.join(root, "old.md");
    const file = path.join(root, "queue.yaml");
    fs.writeFileSync(md, OLD_MD);
    fs.writeFileSync(file, QUEUE);
    const r = await wfQueue(["--convert", md, "--into", file, "--status", "pending"]);
    const ids = readQueue(file).lines.map(l => l.id);
    expect({
      code: r.code,
      unchanged: fs.readFileSync(file, "utf8") === QUEUE,
      ids,
      err: r.err,
    }).toMatchObject({
      code: 2,
      unchanged: true,
      ids: ["EXISTING"],
    });
  });
  it("still appends the line as backlog, and a pending line that carries a difficulty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-convdiff-"));
    dirs.push(root);
    const md = path.join(root, "old.md");
    const file = path.join(root, "queue.yaml");
    fs.writeFileSync(md, OLD_MD);
    fs.writeFileSync(file, QUEUE);
    expect((await wfQueue(["--convert", md, "--into", file])).code).toBe(0);
    expect(readQueue(file).lines.map(l => l.id)).toEqual(["EXISTING", "NODIFF"]);
    fs.writeFileSync(file, QUEUE);
    fs.writeFileSync(md, OLD_MD.replace("| touches:", "| difficulty: 3 | touches:"));
    expect((await wfQueue(["--convert", md, "--into", file, "--status", "pending"])).code).toBe(0);
    expect(readQueue(file).lines.map(l => l.id)).toEqual(["EXISTING", "NODIFF"]);
  });
});
