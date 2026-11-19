import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { takeTriage } from "./lessons-file.js";
import { readQueue } from "./queue.js";

const dirs: string[] = [];
const argv = process.argv;
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.argv = argv;
  process.exitCode = undefined;
});

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-take-repo-")));
  dirs.push(root);
  const eng = path.join(root, "eng");
  const other = path.join(root, "other");
  const proj = path.join(root, "proj");
  for (const d of [eng, other, proj]) {
    fs.mkdirSync(d, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: d });
  }
  fs.mkdirSync(path.join(eng, "src"));
  fs.writeFileSync(path.join(eng, "src", "a.ts"), "a\n");
  fs.mkdirSync(path.join(proj, ".claude", "batch"), { recursive: true });
  const queue = path.join(proj, ".claude", "batch", "q.yaml");
  fs.writeFileSync(
    queue,
    `batch_size: 2
tasks:
  - id: ORIGIN
    status: done
    difficulty: 3
    repo: ${eng}
    workflow: engine-task
    touches: [src/a.ts]
    text: the origin task
`,
  );
  return {
    root,
    eng,
    other,
    queue,
    triage: path.join(root, "triage.txt"),
    records: path.join(root, "rec.json"),
  };
}

async function cli(...args: string[]): Promise<{ code: unknown; out: string }> {
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((c: unknown, cb?: unknown) => {
    out.push(String(c));
    if (typeof cb === "function") (cb as () => void)();
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  process.argv = ["node", "wf-queue", ...args];
  process.exitCode = undefined;
  vi.resetModules();
  await import("./queue-cli.js");
  for (let i = 0; i < 100 && process.exitCode === undefined; i++)
    await new Promise(r => setTimeout(r, 10));
  vi.restoreAllMocks();
  return { code: process.exitCode, out: out.join("") };
}

describe("wf-queue --lessons-take: a row leaves the file only after it is out", () => {
  it("a stdout that fails (closed pipe, killed reader) leaves the taken rows in the triage file", async () => {
    const e = setup();
    const rows = "== T1\nrow-one [loss] r :: t :: p :: f\n";
    fs.writeFileSync(e.triage, rows);
    vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw new Error("EPIPE: stdout is gone");
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.argv = ["node", "wf-queue", e.queue, "--lessons-take", "--triage", e.triage];
    process.exitCode = undefined;
    vi.resetModules();
    await import("./queue-cli.js");
    for (let i = 0; i < 100 && process.exitCode === undefined; i++)
      await new Promise(r => setTimeout(r, 10));
    vi.restoreAllMocks();
    expect(process.exitCode).not.toBe(0);
    expect(fs.readFileSync(e.triage, "utf8")).toBe(rows);
  });
});

describe("takeTriage: the file is emptied after the rows are out", () => {
  it("the rows are still in the file while they are being emitted", async () => {
    const e = setup();
    fs.writeFileSync(e.triage, "== T1\nrow\n");
    let seen = "";
    const got = await takeTriage(e.triage, () => {
      seen = fs.readFileSync(e.triage, "utf8");
    });
    expect(seen).toBe("== T1\nrow\n");
    expect(got).toBe("== T1\nrow\n");
    expect(fs.readFileSync(e.triage, "utf8")).toBe("");
  });

  it("an emit that fails leaves every row in the file", async () => {
    const e = setup();
    fs.writeFileSync(e.triage, "== T1\nrow\n");
    await expect(
      takeTriage(e.triage, () => Promise.reject(new Error("killed between the steps"))),
    ).rejects.toThrow("killed");
    expect(fs.readFileSync(e.triage, "utf8")).toBe("== T1\nrow\n");
  });

  it("a stdout whose callback reports an error (closed pipe) leaves the rows in the file", async () => {
    const e = setup();
    const rows = "== T1\nrow\n";
    fs.writeFileSync(e.triage, rows);
    vi.spyOn(process.stdout, "write").mockImplementation((_c: unknown, cb?: unknown) => {
      (cb as (err: Error) => void)(new Error("EPIPE"));
      return false;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.argv = ["node", "wf-queue", e.queue, "--lessons-take", "--triage", e.triage];
    process.exitCode = undefined;
    vi.resetModules();
    await import("./queue-cli.js");
    for (let i = 0; i < 100 && process.exitCode === undefined; i++)
      await new Promise(r => setTimeout(r, 10));
    vi.restoreAllMocks();
    expect(process.exitCode).not.toBe(0);
    expect(fs.readFileSync(e.triage, "utf8")).toBe(rows);
  });
});

describe("wf-queue --lessons --repo for a task whose line has an origin", () => {
  it("the repo the touches are checked against is the repo of the filed line", async () => {
    const e = setup();
    fs.writeFileSync(
      e.records,
      JSON.stringify({
        lessons: [
          {
            id: "ENG-L1",
            kind: "unverified",
            touches: ["src/a.ts"],
            repro: "run it and read the output",
            text: "A defect found while doing the origin task, with enough words to be a brief.",
          },
        ],
      }),
    );
    const r = await cli(
      e.queue,
      "--lessons",
      "ORIGIN",
      "--records",
      e.records,
      "--repo",
      e.other,
      "--triage",
      e.triage,
    );
    expect(r.code).toBe(0);
    // src/a.ts exists only in `eng` (the origin's repo): a line filed with `other` was checked against `eng`
    const filed = readQueue(e.queue).lines.find(l => l.id === "ENG-L1");
    expect(filed?.meta.repo).toBe(e.eng);
  });

  it("a touches path only the --repo directory holds is refused, not filed with that repo", async () => {
    const e = setup();
    fs.mkdirSync(path.join(e.other, "src"));
    fs.writeFileSync(path.join(e.other, "src", "b.ts"), "b\n");
    fs.writeFileSync(
      e.records,
      JSON.stringify({
        lessons: [
          {
            id: "ENG-L2",
            kind: "unverified",
            touches: ["src/b.ts"],
            repro: "run it and read the output",
            text: "A defect found while doing the origin task, with enough words to be a brief.",
          },
        ],
      }),
    );
    const r = await cli(
      e.queue,
      "--lessons",
      "ORIGIN",
      "--records",
      e.records,
      "--repo",
      e.other,
      "--triage",
      e.triage,
    );
    expect(r.code).toBe(0);
    expect(readQueue(e.queue).lines.find(l => l.id === "ENG-L2")).toBeUndefined();
    expect(fs.readFileSync(e.triage, "utf8")).toContain("ENG-L2");
  });
});
