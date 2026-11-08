import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./dashboard.js";
import { Pool, systemProbes } from "./pool.js";
import { Storage } from "./storage.js";
import type { Loader } from "./loader.js";
import type { SessionState } from "./types.js";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function setup(queueFile: string | undefined): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dash-"));
  dirs.push(dir);
  const storage = new Storage(path.join(dir, "state"));
  if (queueFile !== undefined) {
    const s = {
      session_id: "s1",
      stack: [],
      active_frame: -1,
      started_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      history: [],
      overrides: {},
      context: { queue_file: queueFile },
    } as unknown as SessionState;
    await storage.write("s1", s);
  }
  const server = buildApp(storage, {} as Loader).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise(r => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("dashboard queue API", () => {
  it("lists the queue files sessions name and answers their lines", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dashq-"));
    dirs.push(dir);
    const file = path.join(dir, "q.yaml");
    fs.writeFileSync(
      file,
      "batch_size: 1\ntasks:\n  - id: A\n    status: pending\n    repo: /tmp\n    text: text of a\n",
    );
    const base = await setup(file);
    expect(await (await fetch(`${base}/api/queues`)).json()).toEqual([file]);
    const res = await fetch(`${base}/api/queue?file=${encodeURIComponent(file)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: { id: string; reason?: string }[] };
    expect(body.lines).toMatchObject([{ id: "A", status: "pending", reason: "ready", notes: 0 }]);
  });

  it("404 for a file no session names", async () => {
    const base = await setup(undefined);
    const res = await fetch(`${base}/api/queue?file=${encodeURIComponent("/etc/hosts")}`);
    expect(res.status).toBe(404);
  });

  it("422 for a named queue that cannot be read", async () => {
    const missing = path.join(os.tmpdir(), "wf-dash-missing-queue.yaml");
    const base = await setup(missing);
    const res = await fetch(`${base}/api/queue?file=${encodeURIComponent(missing)}`);
    expect(res.status).toBe(422);
  });
});

// The plan pane draws from this answer (hooks/plan-pane.test.tsx reads the recorded copy): a field
// rename in describeQueue fails here, not on the screen. WF_RECORD_REPLIES=1 writes the copy afresh.
describe("the plan pane's recorded /api/queue answer", () => {
  it("is what /api/queue answers for its queue", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dashrec-"));
    dirs.push(dir);
    const file = path.join(dir, "queue.yaml");
    fs.writeFileSync(
      file,
      [
        "batch_size: 2",
        "tasks:",
        "  - {id: RUN-1, status: running, difficulty: 7, repo: /tmp, touches: [r], text: r}",
        "  - {id: NEXT-1, status: pending, difficulty: 3, repo: /tmp, touches: [n], text: n}",
        "  - {id: NEXT-2, status: pending, difficulty: 2, priority: high, repo: /tmp, touches: [n2], text: n2}",
        "  - {id: WAIT-1, status: pending, difficulty: 5, repo: /tmp, after: [NEXT-1], touches: [w], text: w}",
        "  - {id: PARK-1, status: pending, repo: /tmp, parked: true, touches: [p], text: p}",
        "  - id: DONE-1",
        "    status: done",
        "    repo: /tmp",
        "    text: d",
        "    notes: [{from: land, date: 2026-11-07, text: landed abc}]",
        "  - id: FAIL-LONG",
        "    status: failed",
        "    repo: /tmp",
        "    text: f4",
        "    notes: [{from: fail, date: 2026-11-08, text: a reason that runs on and on well past the width of any plan pane a person would open beside the chat}]",
        "  - id: FAIL-OLD",
        "    status: failed",
        "    difficulty: 4",
        "    repo: /tmp",
        "    text: f",
        '    notes: [{from: fail, date: 2026-11-06, text: "gate red: the suite\\nsecond line"}]',
        "  - id: FAIL-NEW",
        "    status: failed",
        "    repo: /tmp",
        "    text: f2",
        "    notes: [{from: fail, date: 2026-11-07, text: closed as a split}]",
        "  - {id: FAIL-BARE, status: failed, repo: /tmp, text: f3}",
        "",
      ].join("\n"),
    );
    const base = await setup(file);
    const res = await fetch(`${base}/api/queue?file=${encodeURIComponent(file)}`);
    const body = JSON.parse(
      JSON.stringify(await res.json())
        .split(file)
        .join("/proj/.claude/batch/queue.yaml"),
    ) as unknown;
    const rec = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "hooks",
      "fixtures",
      "api-queue.ts",
    );
    if (process.env.WF_RECORD_REPLIES === "1")
      fs.writeFileSync(
        rec,
        `// Recorded /api/queue answer (src/dashboard.test.ts checks it; WF_RECORD_REPLIES=1 re-records).\n` +
          `export const API_QUEUE = ${JSON.stringify(body, null, 2)};\n`,
      );
    const { API_QUEUE } = await import("../hooks/fixtures/api-queue.js");
    expect(body).toEqual(API_QUEUE);
  });
});

describe("dashboard paths", () => {
  it("answers the page for every view's path", async () => {
    const base = await setup(undefined);
    for (const p of [
      "/",
      "/sessions",
      "/session/abc",
      "/workflows",
      "/workflow/engine-task",
      "/plan",
      "/pool",
      "/cost",
      "/session/a%20b",
    ]) {
      const res = await fetch(`${base}${p}`);
      expect(res.status, p).toBe(200);
      expect(res.headers.get("content-type"), p).toMatch(/text\/html/);
      expect(await res.text(), p).toContain("<title>MCP Workflow Engine</title>");
    }
  });

  it("an unknown /api path is a JSON 404, never the page", async () => {
    const base = await setup(undefined);
    const res = await fetch(`${base}/api/unknown`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown API endpoint" });
  });

  it("the page carries no hash routing", () => {
    const html = fs.readFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), "..", "dashboard", "index.html"),
      "utf8",
    );
    expect(html).not.toMatch(/hashchange|location\.hash|#session=/);
  });
});

describe("GET /api/pool", () => {
  it("answers the pool module's snapshot: budget, a lease, a waiter in order", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dashpool-"));
    dirs.push(dir);
    fs.writeFileSync(
      path.join(dir, "config.yaml"),
      JSON.stringify({ budget: 2, load_threshold: 0 }),
    );
    const pool = new Pool(dir, { ...systemProbes, loadavg: () => 0 });
    const held = await pool.acquire({ threads: 2, label: "held", sessionId: "sess-1" });
    if (held.status !== "granted") throw new Error("not granted");
    const waiting = pool.acquire({ threads: 1, label: "next" }, { waitTimeoutMs: 5000 });
    const storage = new Storage(path.join(dir, "state"));
    const server = buildApp(storage, {} as Loader, undefined, pool).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise(r => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = (await (await fetch(`${base}/api/pool`)).json()) as {
      budget: number;
      held: number;
      leases: { request: string; entry: { label: string; session_id: string } }[];
      waiting: { request: string; entry: { label: string } }[];
    };
    expect(body.budget).toBe(2);
    expect(body.held).toBe(2);
    expect(body.leases).toMatchObject([
      { request: "2 threads", entry: { label: "held", session_id: "sess-1" } },
    ]);
    expect(body.waiting).toMatchObject([{ request: "1 threads", entry: { label: "next" } }]);
    await held.lease.release();
    const next = await waiting;
    if (next.status === "granted") await next.lease.release();
  });
});

describe("GET /api/cost", () => {
  it("answers the ledger's tasks with prices; a bad range is a 400", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dashcost-"));
    dirs.push(dir);
    const storage = new Storage(dir);
    await storage.appendLedger({
      session_id: "s1",
      parent_session_id: null,
      root_session_id: "s1",
      workflow: "w",
      outcome: "completed",
      started_at: "2026-11-08T10:00:00",
      ended_at: "2026-11-08T11:00:00",
      transitions: 1,
      exec_ms_total: 0,
      wait_ms_total: 0,
      execs: [],
      task: "T-1",
      tokens: { total: 1_000_000 },
      model: "sonnet",
      visits: { project_land: 1 },
    });
    const server = buildApp(storage, {} as Loader).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise(r => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = (await (await fetch(`${base}/api/cost?from=2026-11-08&to=2026-11-08`)).json()) as {
      totals: { landed: number; usd: number };
      prices: { updated: string };
      trend: unknown[];
    };
    expect(body.totals).toMatchObject({ landed: 1, usd: 6 });
    expect(body.prices.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.trend).toHaveLength(14);
    expect((await fetch(`${base}/api/cost?from=2026-11-09&to=2026-11-08`)).status).toBe(400);
  });
});
