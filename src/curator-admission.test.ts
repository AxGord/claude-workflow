import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { curatorMain } from "./curator-cli.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { formatPickSummary, pickQueue, readQueue } from "./queue.js";
import { InMemoryStorage } from "./test-helpers.js";

// ENG-CURATOR-SERVICE: under a dispatcher the engine admits a due curator run as a queue line into a free slot
// (the pick adds `CURATOR-<date>-<n>`, workflow curator, and admits it like any line); with no dispatcher above it,
// the transition that ends a task session says `CURATOR-DUE: … start it: …`.

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const dirs: string[] = [];
let savedState: string | undefined;
beforeEach(() => {
  savedState = process.env.STATE_DIR;
});
afterEach(() => {
  if (savedState === undefined) delete process.env.STATE_DIR;
  else process.env.STATE_DIR = savedState;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function fixture(
  lands: number,
  config = "jobs:\n  hygiene: {}\n",
): { project: string; queue: string; state: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wf-cur-adm-")));
  dirs.push(root);
  const project = path.join(root, "proj");
  fs.mkdirSync(path.join(project, ".claude", "batch"), { recursive: true });
  execFileSync("git", ["init", "-q", project]);
  fs.writeFileSync(path.join(project, ".claude", "curator.yaml"), config);
  const ids = Array.from({ length: 12 }, (_, i) => `D${i}`);
  const queue = path.join(project, ".claude", "batch", "queue.yaml");
  fs.writeFileSync(
    queue,
    [
      "batch_size: 2",
      "tasks:",
      ...ids.map(
        id =>
          `  - id: ${id}\n    status: done\n    difficulty: 3\n    touches: [a]\n    text: done ${id}`,
      ),
      "  - id: NEXT\n    status: pending\n    difficulty: 3\n    touches: [b]\n    text: the next line",
      "",
    ].join("\n"),
  );
  const state = path.join(root, "state");
  fs.mkdirSync(state);
  fs.writeFileSync(
    path.join(state, "ledger.jsonl"),
    ids
      .slice(0, lands)
      .map(task =>
        JSON.stringify({
          session_id: `s-${task}`,
          root_session_id: `s-${task}`,
          parent_session_id: null,
          workflow: "batch-task",
          outcome: "completed",
          started_at: "2026-11-25T00:00:00Z",
          ended_at: "2026-11-25T01:00:00Z",
          task,
          project,
        }),
      )
      .map(l => `${l}\n`)
      .join(""),
  );
  process.env.STATE_DIR = state;
  return { project, queue, state };
}

describe("curator admission under a dispatcher", () => {
  it("a due job adds a CURATOR line and the pick admits it into a free slot, ahead of the pending lines", async () => {
    const { queue } = fixture(10);
    const r = await pickQueue(queue);
    const cur = r.admitted.find(a => a.id.startsWith("CURATOR-"));
    expect(cur).toMatchObject({ workflow: "curator", difficulty: 5, priority: "high" });
    expect(cur?.text).toMatch(/hygiene \(10 lands since the start \(interval 10\)\)/);
    expect(r.admitted.map(a => a.id)).toContain("NEXT");
    expect(formatPickSummary(r, true)).toContain(`curator: added ${cur?.id} (hygiene due)`);
    const line = readQueue(queue).lines.find(l => l.id === cur?.id);
    expect(line?.status).toBe("running");
    expect(line?.meta.touches).toBe("");
    // the run occupies its slot: the next pick adds no second curator line while it runs
    const again = await pickQueue(queue);
    expect(again.admitted).toEqual([]);
    expect(readQueue(queue).lines.filter(l => l.id.startsWith("CURATOR-"))).toHaveLength(1);
  });

  it("the config's priority: sets the admitted line's priority; an unknown word is a config error the pick reports", async () => {
    const urgent = fixture(10, "priority: urgent\njobs:\n  hygiene: {}\n");
    const r = await pickQueue(urgent.queue);
    expect(r.admitted.find(a => a.id.startsWith("CURATOR-"))?.priority).toBe("urgent");
    const low = fixture(10, "priority: low\njobs:\n  hygiene: {}\n");
    const l = await pickQueue(low.queue);
    expect(readQueue(low.queue).lines.find(x => x.id.startsWith("CURATOR-"))?.meta.priority).toBe(
      "low",
    );
    expect(l.admitted.map(a => a.id)).toContain("NEXT");
    const bad = fixture(10, "priority: soon\njobs:\n  hygiene: {}\n");
    const b = await pickQueue(bad.queue);
    expect(b.admitted.map(a => a.id)).toEqual(["NEXT"]);
    expect(b.curator).toMatch(
      /^curator: not admitted, .*priority: one of urgent, high, normal, low, not "soon"/,
    );
  });

  it("a user's high line ahead of it in the file is admitted before the default (high) curator line when one slot is free", async () => {
    const { queue } = fixture(10);
    fs.writeFileSync(
      queue,
      fs
        .readFileSync(queue, "utf8")
        .replace("batch_size: 2", "batch_size: 1")
        .concat(
          "  - {id: HOT, status: pending, difficulty: 3, priority: high, touches: [h], text: hot}\n",
        ),
    );
    const r = await pickQueue(queue);
    expect(r.admitted.map(a => a.id)).toEqual(["HOT"]);
  });

  it("nothing due, no config, a full window or a paused queue add no line", async () => {
    const few = fixture(9);
    expect((await pickQueue(few.queue)).admitted.map(a => a.id)).toEqual(["NEXT"]);
    const none = fixture(10);
    fs.rmSync(path.join(none.project, ".claude", "curator.yaml"));
    expect((await pickQueue(none.queue)).admitted.map(a => a.id)).toEqual(["NEXT"]);
    const off = fixture(10);
    fs.writeFileSync(
      off.queue,
      fs.readFileSync(off.queue, "utf8").replace("batch_size: 2", "batch_size: 2\ncurator: off"),
    );
    expect((await pickQueue(off.queue)).admitted.map(a => a.id)).toEqual(["NEXT"]);
    const paused = fixture(10);
    fs.writeFileSync(
      paused.queue,
      fs.readFileSync(paused.queue, "utf8").replace("batch_size: 2", "batch_size: 0"),
    );
    expect((await pickQueue(paused.queue)).admitted).toEqual([]);
    expect(readQueue(paused.queue).lines.some(l => l.id.startsWith("CURATOR-"))).toBe(false);
  });

  it("a broken config never fails the pick: the summary says why the run was not admitted", async () => {
    const { queue } = fixture(10, "jobs: [hygiene]\n");
    const r = await pickQueue(queue);
    expect(r.admitted.map(a => a.id)).toEqual(["NEXT"]);
    expect(r.curator).toMatch(/^curator: not admitted, .*jobs: a mapping/);
  });
});

describe("curator admission: the engine's own lines", () => {
  it("a curator line that failed today holds the next run until tomorrow, and the summary says so", async () => {
    const { queue } = fixture(10);
    const today = new Date();
    const p = (n: number): string => String(n).padStart(2, "0");
    const day = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`;
    const failed = `  - {id: CURATOR-2026-01-01-1, status: failed, workflow: curator, touches: [], ended: ${day}, text: closed}\n`;
    fs.appendFileSync(queue, failed);
    const r = await pickQueue(queue);
    expect(r.admitted.map(a => a.id)).toEqual(["NEXT"]);
    expect(r.curator).toBe(
      "curator: held, CURATOR-2026-01-01-1 failed today; the next run is admitted tomorrow",
    );
    // a failure of an earlier day holds nothing
    fs.writeFileSync(
      queue,
      fs.readFileSync(queue, "utf8").replace(`ended: ${day}`, "ended: 2026-01-01"),
    );
    expect((await pickQueue(queue)).admitted.some(a => a.id.startsWith("CURATOR-2"))).toBe(true);
  });

  it("a user's own CURATOR-… line is an ordinary line: it neither holds admission nor drops out of the land count", async () => {
    const { queue, state } = fixture(9);
    fs.appendFileSync(
      queue,
      "  - {id: CURATOR-FOO, status: running, difficulty: 3, touches: [c], text: configure the curator}\n",
    );
    fs.appendFileSync(
      path.join(state, "ledger.jsonl"),
      `${JSON.stringify({ session_id: "s-foo", workflow: "engine-task", outcome: "completed", started_at: "2026-11-25T00:00:00Z", ended_at: "2026-11-25T02:00:00Z", task: "CURATOR-FOO" })}\n`,
    );
    const r = await pickQueue(queue);
    expect(r.curator).toMatch(/^curator: added CURATOR-\d{4}-\d{2}-\d{2}-1 \(hygiene due\)$/);
    expect(r.admitted.find(a => /^CURATOR-\d{4}/.test(a.id))?.text).toMatch(
      /10 lands since the start/,
    );
  });
});

describe("curator due with no dispatcher", () => {
  it("the transition that ends a task session started by hand names the due jobs and the exact start", async () => {
    const { project, queue, state } = fixture(10);
    const storage = new InMemoryStorage();
    const engine = new Engine(storage, new Loader(TEMPLATES, project, null), new Executor(), {
      stateDir: state,
    });
    const s = await engine.start("explore", undefined, undefined, project, undefined, {
      task: "NEXT",
      queue_file: queue,
    });
    const cur = storage.read(s.sessionId)!;
    cur.stack = [];
    await storage.write(s.sessionId, cur);
    const lines = engine.curatorDueLines(s.sessionId);
    expect(lines).toEqual([
      `CURATOR-DUE: hygiene (10 lands since the start (interval 10)) — start it: start({workflow: "curator", cwd: "${project}", context: {difficulty: "5", queue_file: "${queue}"}}) and spawn its DRIVER block`,
    ]);
    // a run started from that line plans with the queue's scope: its hygiene and lessons jobs read the queue
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(chunk => {
      out.push(String(chunk));
      return true;
    });
    let code: number;
    try {
      code = curatorMain(["plan", "--queue", queue, "--project", project]);
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);
    const meta = JSON.parse(fs.readFileSync(path.join(out.join(""), "meta.json"), "utf8")) as {
      queue?: string;
      jobs: string[];
    };
    expect(meta).toMatchObject({ queue, jobs: ["hygiene"] });
    // under a dispatching session (one that names a task workflow) the pick admits it: no notice
    const disp = await engine.start("explore", undefined, undefined, project, undefined, {
      task_workflow: "batch-task",
    });
    const child = await engine.start("explore", undefined, disp.sessionId, project, undefined, {
      task: "NEXT",
      queue_file: queue,
    });
    const c = storage.read(child.sessionId)!;
    c.stack = [];
    await storage.write(child.sessionId, c);
    expect(engine.curatorDueLines(child.sessionId)).toEqual([]);
  });
});
