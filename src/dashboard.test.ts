import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./dashboard.js";
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
    const file = path.join(dir, "q.md");
    fs.writeFileSync(
      file,
      "# x\nbatch_size: 1\n## Tasks\n- [ ] A | repo: /tmp | text of a is long enough to be prose here\n",
    );
    const base = await setup(file);
    expect(await (await fetch(`${base}/api/queues`)).json()).toEqual([file]);
    const res = await fetch(`${base}/api/queue?file=${encodeURIComponent(file)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lines: { id: string; reason?: string }[] };
    expect(body.lines).toMatchObject([{ id: "A", reason: "ready" }]);
  });

  it("404 for a file no session names", async () => {
    const base = await setup(undefined);
    const res = await fetch(`${base}/api/queue?file=${encodeURIComponent("/etc/hosts")}`);
    expect(res.status).toBe(404);
  });

  it("422 for a named queue that cannot be read", async () => {
    const missing = path.join(os.tmpdir(), "wf-dash-missing-queue.md");
    const base = await setup(missing);
    const res = await fetch(`${base}/api/queue?file=${encodeURIComponent(missing)}`);
    expect(res.status).toBe(422);
  });
});
