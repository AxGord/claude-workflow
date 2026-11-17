import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readQueue } from "./queue.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

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

describe("wf-queue --convert --into <new file> --status pending", () => {
  it("refuses (exit 2, no file written) a pending line with no difficulty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-convdiff-"));
    dirs.push(root);
    const md = path.join(root, "old.md");
    const file = path.join(root, "new.yaml");
    fs.writeFileSync(md, OLD_MD);
    const r = await wfQueue(["--convert", md, "--into", file, "--status", "pending"]);
    expect({ code: r.code, written: fs.existsSync(file) }).toEqual({ code: 2, written: false });
  });

  it("names the line and writes nothing when printing with --status pending", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-convdiff-"));
    dirs.push(root);
    const md = path.join(root, "old.md");
    fs.writeFileSync(md, OLD_MD);
    const r = await wfQueue(["--convert", md, "--status", "pending"]);
    expect({
      code: r.code,
      out: r.out,
      named: r.err.includes("NODIFF: difficulty: <1-10> is required"),
    }).toEqual({ code: 2, out: "", named: true });
  });

  it("still writes the new file with --status backlog and with a difficulty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-convdiff-"));
    dirs.push(root);
    const md = path.join(root, "old.md");
    const backlog = path.join(root, "b.yaml");
    const pending = path.join(root, "p.yaml");
    fs.writeFileSync(md, OLD_MD);
    const a = await wfQueue(["--convert", md, "--into", backlog, "--status", "backlog"]);
    fs.writeFileSync(md, OLD_MD.replace("| touches:", "| difficulty: 3 | touches:"));
    const b = await wfQueue(["--convert", md, "--into", pending, "--status", "pending"]);
    expect({ a: a.code, b: b.code, ids: readQueue(pending).lines.map(l => l.id) }).toEqual({
      a: 0,
      b: 0,
      ids: ["NODIFF"],
    });
  });
});
