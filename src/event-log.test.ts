import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { buildApp } from "./dashboard.js";
import { ASK_KEY, EventLog, fold, pruneRuns, seedEvents, MEMORY_TAIL } from "./event-log.js";
import { Storage } from "./storage.js";
import { InMemoryStorage, createTestLoader, cleanupDir } from "./test-helpers.js";
import type { Loader } from "./loader.js";

const WF = {
  initial: "work",
  states: {
    work: { prompt: "w", transitions: { ask: "question", done: "end" } },
    question: { prompt: "q", ask: "parent", transitions: { answered: "work" } },
    end: { prompt: "e", terminal: true, outcome: "complete" },
  },
};

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  for (const d of dirs.splice(0)) cleanupDir(d);
});

function setup(): { engine: Engine; storage: InMemoryStorage; loader: Loader } {
  const storage = new InMemoryStorage();
  const { loader, dir } = createTestLoader({ wf: WF });
  dirs.push(dir);
  return { engine: new Engine(storage, loader, new Executor()), storage, loader };
}

describe("event log", () => {
  it("fold(events) reproduces a session's history", async () => {
    const { engine, storage } = setup();
    const { sessionId } = await engine.start("wf");
    await engine.transition(sessionId, "ask");
    await engine.transition(sessionId, "answered");
    await engine.transition(sessionId, "done");
    const s = storage.read(sessionId)!;
    const folded = fold(storage.events.since(0)).get(sessionId)!;
    const moves = s.history.filter(h => h.from !== undefined).map(h => [h.from, h.to, h.via]);
    expect(folded.transitions.map(t => [t.from, t.to, t.name])).toEqual(moves);
    expect(folded.workflow).toBe("wf");
    expect(folded.outcome).toBe("completed");
    const seqs = storage.events.since(0).map(e => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("an `ask: parent` state logs ask on entry and answer on leaving", async () => {
    const { engine, storage } = setup();
    const { sessionId } = await engine.start("wf");
    await engine.transition(sessionId, "ask");
    expect(fold(storage.events.since(0)).get(sessionId)!.asks).toMatchObject([
      { state: "question" },
    ]);
    await engine.transition(sessionId, "answered");
    const asks = fold(storage.events.since(0)).get(sessionId)!.asks;
    expect(asks).toHaveLength(1);
    expect(asks[0].answered).toBeDefined();
  });

  describe("a driver's question to its parent (`ask_parent`), from any state", () => {
    it("the key set is an ask in the state the session stands in; the next move answers it", async () => {
      const { engine, storage } = setup();
      const { sessionId } = await engine.start("wf");
      await engine.setContext(sessionId, ASK_KEY, "regate the gate: needs a decision");
      const open = fold(storage.events.since(0)).get(sessionId)!.asks;
      expect(open).toMatchObject([{ state: "work", text: "regate the gate: needs a decision" }]);
      expect(open[0].answered).toBeUndefined();
      // the parent's own transition on the child is the answer
      await engine.transition(sessionId, "done");
      const [asked] = fold(storage.events.since(0)).get(sessionId)!.asks;
      expect(asked).toMatchObject({ state: "work", to: "end" });
      expect(asked.answered).toBeDefined();
      expect(storage.events.since(0).filter(e => e.kind === "answer")).toHaveLength(1);
      // the key outlives the question, ignored: a later write neither re-asks nor re-answers
      expect(storage.read(sessionId)!.context[ASK_KEY]).toBeDefined();
      expect(storage.events.since(0).filter(e => e.kind === "ask")).toHaveLength(1);
    });

    it("the driver clearing the key is the answer, and the session stays where it is", async () => {
      const { engine, storage } = setup();
      const { sessionId } = await engine.start("wf");
      await engine.setContext(sessionId, ASK_KEY, "which way?");
      await engine.setContext(sessionId, "other", "x");
      expect(fold(storage.events.since(0)).get(sessionId)!.asks[0].answered).toBeUndefined();
      await engine.setContext(sessionId, ASK_KEY, "");
      const [asked] = fold(storage.events.since(0)).get(sessionId)!.asks;
      expect(asked).toMatchObject({ state: "work", to: "work" });
      expect(asked.answered).toBeDefined();
      await engine.setContext(sessionId, ASK_KEY, "which way, again?");
      expect(fold(storage.events.since(0)).get(sessionId)!.asks).toHaveLength(2);
    });

    it("the same text written again while open is one ask; an abort answers it", async () => {
      const { engine, storage } = setup();
      const { sessionId } = await engine.start("wf");
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
        await engine.setContext(sessionId, ASK_KEY, "stuck");
        vi.setSystemTime(new Date("2030-01-01T00:00:05.000Z"));
        await engine.setContext(sessionId, ASK_KEY, "stuck");
      } finally {
        vi.useRealTimers();
      }
      const asks = storage.events.since(0).filter(e => e.kind === "ask");
      expect(asks).toHaveLength(1);
      expect(new Set(storage.events.since(0).map(e => e.ts)).size).toBeGreaterThan(1);
      // the fold too: the same ask logged again at a later time is not a second question
      const later = asks.map(e => ({ ...e, seq: e.seq + 1000, ts: "2030-01-01T00:01:00.000Z" }));
      expect(fold([...storage.events.since(0), ...later]).get(sessionId)!.asks).toHaveLength(1);
      await engine.abort(sessionId);
      const [asked] = fold(storage.events.since(0)).get(sessionId)!.asks;
      expect(asked.answered).toBeDefined();
    });

    it("asked inside an `ask: parent` state it is the one question that state logged, with its text", async () => {
      const { engine, storage } = setup();
      const { sessionId } = await engine.start("wf");
      await engine.transition(sessionId, "ask");
      await engine.setContext(sessionId, ASK_KEY, "which of the two?");
      await engine.transition(sessionId, "answered");
      const asks = fold(storage.events.since(0)).get(sessionId)!.asks;
      expect(asks).toMatchObject([{ state: "question", text: "which of the two?", to: "work" }]);
      expect(asks[0].answered).toBeDefined();
    });

    it("a session file holding the key seeds an open ask, so a restart keeps the lane lit", async () => {
      const { engine, storage } = setup();
      const { sessionId } = await engine.start("wf");
      await engine.setContext(sessionId, ASK_KEY, "waiting on the parent");
      const file = storage.read(sessionId)!;
      const seeded = fold(seedEvents([file])).get(sessionId)!.asks;
      expect(seeded).toMatchObject([{ state: "work", text: "waiting on the parent" }]);
      expect(seeded[0].answered).toBeUndefined();
      // the logged ask over the seeded one is not a second question
      const both = fold([...seedEvents([file]), ...storage.events.since(0)]).get(sessionId)!.asks;
      expect(both).toHaveLength(1);
    });
  });

  it("link, respawn, stop and rescore", async () => {
    const { engine, storage } = setup();
    const { sessionId } = await engine.start("wf");
    await engine.linkAgent(sessionId, "a1");
    await engine.linkAgent(sessionId, "a1");
    await engine.linkAgent(sessionId, "a2");
    await engine.setContext(sessionId, "difficulty", "4");
    await engine.abort(sessionId);
    const kinds = storage.events.since(0).map(e => e.kind);
    expect(kinds).toEqual([
      "session_start",
      "agent_link",
      "agent_respawn",
      "rescore",
      "agent_stop",
      "session_end",
    ]);
    const f = fold(storage.events.since(0)).get(sessionId)!;
    expect(f.agents.map(a => a.status)).toEqual(["respawned", "stopped"]);
    expect(f.difficulty).toBe("4");
  });

  it("keeps a bounded tail in memory and the whole run in its file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ev-"));
    dirs.push(dir);
    const log = new EventLog(dir);
    for (let i = 0; i < MEMORY_TAIL + 10; i++) log.append("rescore", "s", { i });
    expect(log.since(0)).toHaveLength(MEMORY_TAIL + 10);
    expect(log.since(MEMORY_TAIL + 5).map(e => e.seq)).toEqual([
      MEMORY_TAIL + 6,
      MEMORY_TAIL + 7,
      MEMORY_TAIL + 8,
      MEMORY_TAIL + 9,
      MEMORY_TAIL + 10,
    ]);
    const files = fs.readdirSync(path.join(dir, "events"));
    expect(files).toHaveLength(1);
  });

  it("prunes old run files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ev-"));
    dirs.push(dir);
    for (const n of ["a", "b", "c"]) fs.writeFileSync(path.join(dir, `run-${n}.jsonl`), "");
    pruneRuns(dir, 2);
    expect(fs.readdirSync(dir)).toEqual(["run-b.jsonl", "run-c.jsonl"]);
  });
});

describe("event API", () => {
  async function serve(storage: InMemoryStorage): Promise<string> {
    const server = buildApp(storage as never, {} as Loader).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise(r => server.once("listening", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function readSse(
    url: string,
    init: RequestInit,
    count: number,
  ): Promise<{ seq: number }[]> {
    const ctl = new AbortController();
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const got: { seq: number }[] = [];
    while (got.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const m = /^data: (.*)$/m.exec(block);
        if (m) got.push(JSON.parse(m[1]) as { seq: number });
      }
    }
    ctl.abort();
    return got;
  }

  it("GET /api/events?since returns the later events", async () => {
    const { engine, storage } = setup();
    const { sessionId } = await engine.start("wf");
    await engine.transition(sessionId, "done");
    const base = await serve(storage);
    const all = (await (await fetch(`${base}/api/events`)).json()) as { events: { seq: number }[] };
    const later = (await (await fetch(`${base}/api/events?since=1`)).json()) as {
      events: { seq: number }[];
    };
    expect(later.events.map(e => e.seq)).toEqual(all.events.slice(1).map(e => e.seq));
  });

  it("SSE resumes from since and then streams live events", async () => {
    const { engine, storage } = setup();
    const { sessionId } = await engine.start("wf");
    const base = await serve(storage);
    const total = storage.events.since(0).length;
    const pending = readSse(`${base}/api/events/stream?since=1`, {}, total);
    await new Promise(r => setTimeout(r, 50));
    await engine.transition(sessionId, "done");
    const got = await pending;
    expect(got.map(e => e.seq)[0]).toBe(2);
    expect(got.map(e => e.seq)).toEqual(
      storage.events
        .since(1)
        .slice(0, got.length)
        .map(e => e.seq),
    );
    const resumed = await readSse(
      `${base}/api/events/stream`,
      { headers: { "Last-Event-ID": "2" } },
      1,
    );
    expect(resumed[0].seq).toBe(3);
  });
});

describe("event log across runs, files and frames", () => {
  function realEngine(workflows: Record<string, object>): {
    engine: Engine;
    storage: Storage;
    stateDir: string;
  } {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-evs-"));
    dirs.push(stateDir);
    const { loader, dir } = createTestLoader(workflows);
    dirs.push(dir);
    const storage = new Storage(stateDir);
    return { engine: new Engine(storage, loader, new Executor()), storage, stateDir };
  }

  it("through the real Storage: events reach the run's file with an ask pair and an exec", async () => {
    const { engine, storage, stateDir } = realEngine({
      wf: WF,
      act: {
        initial: "run",
        states: {
          run: { type: "exec", command: "echo hi", on_success: "ok", on_error: "ok" },
          ok: { prompt: "x", terminal: true, outcome: "complete" },
        },
      },
    });
    const { sessionId } = await engine.start("wf");
    await engine.transition(sessionId, "ask");
    await engine.transition(sessionId, "answered");
    await engine.transition(sessionId, "done");
    const act = await engine.start("act");
    const events = storage.events.since(0);
    const onDisk = fs
      .readFileSync(path.join(stateDir, "events", `run-${storage.events.run}.jsonl`), "utf8")
      .trim()
      .split("\n")
      .map(l => JSON.parse(l) as { seq: number });
    expect(onDisk.map(e => e.seq)).toEqual(events.map(e => e.seq));
    const f = fold(events);
    expect(f.get(sessionId)!.asks).toHaveLength(1);
    expect(events.filter(e => e.session === act.sessionId).map(e => e.kind)).toContain("exec_end");
    expect(f.get(act.sessionId)!.execs.some(x => x.end !== undefined)).toBe(true);
  });

  it("exec_start is logged when a running_exec appears, and closed by exec_end", () => {
    const log = new EventLog();
    const base = {
      session_id: "s",
      stack: [{ workflow: "w", current_state: "run", state_visits: {}, total_transitions: 0 }],
      active_frame: 0,
      started_at: "t0",
      updated_at: "t0",
      history: [],
      overrides: {},
      context: {},
    } as never as import("./types.js").SessionState;
    log.observe(null, base);
    const running = {
      ...base,
      running_exec: { state: "run", started_at: "t1" },
    } as never as typeof base;
    log.observe(base, running);
    const done = {
      ...base,
      history: [{ frame: 0, from: "run", to: "ok", event: "action", at: "t2", exit_code: 0 }],
    } as never as typeof base;
    log.observe(running, done);
    expect(log.since(0).map(e => e.kind)).toEqual([
      "session_start",
      "exec_start",
      "exec_end",
      "transition",
    ]);
    expect(fold(log.since(0)).get("s")!.execs).toMatchObject([
      { start: "t1", end: "t2", exit_code: 0 },
    ]);
  });

  it("a position of another run restarts from 0; this run's resumes", () => {
    const log = new EventLog();
    log.append("rescore", "s", {});
    log.append("rescore", "s", {});
    expect(log.resumeFrom(`${log.run}:2`)).toBe(2);
    expect(log.resumeFrom("2")).toBe(2);
    expect(log.resumeFrom("old-run-1:2")).toBe(0);
    expect(log.resumeFrom("junk")).toBe(0);
    expect(log.resumeFrom(undefined)).toBe(0);
  });

  it("SSE and /api/events treat another run's position as 0 and id events run:seq", async () => {
    const { engine, storage } = setup();
    await engine.start("wf");
    const server = buildApp(storage as never, {} as Loader).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise(r => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = (await (await fetch(`${base}/api/events?since=other-run:99`)).json()) as {
      events: unknown[];
    };
    expect(body.events).toHaveLength(storage.events.since(0).length);
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/events/stream`, {
      headers: { "Last-Event-ID": "other-run:99" },
      signal: ctl.signal,
    });
    const { value } = await res.body!.getReader().read();
    ctl.abort();
    expect(new TextDecoder().decode(value)).toContain(`id: ${storage.events.run}:1`);
  });

  it("pruning spares a run file whose pid is alive", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-ev-"));
    dirs.push(dir);
    for (const n of ["a-111", "b-222", "c-333"])
      fs.writeFileSync(path.join(dir, `run-${n}.jsonl`), "");
    pruneRuns(dir, 1, pid => pid === 111);
    expect(fs.readdirSync(dir).sort()).toEqual(["run-a-111.jsonl", "run-c-333.jsonl"]);
  });

  it("a sub-workflow pop logs the child's moves under the child, the parent's under the parent", async () => {
    const { engine, storage } = setup2();
    const { sessionId } = await engine.start("parent");
    await engine.transition(sessionId, "finish");
    const moves = storage.events.since(0).filter(e => e.kind === "transition");
    expect(moves[0].data).toMatchObject({ from: "work", to: "end", workflow: "child" });
    expect(storage.events.since(0).at(-1)!.kind).toBe("session_end");
    expect(fold(storage.events.since(0)).get(sessionId)!.outcome).toBe("completed");
  });

  const sess = (o: object): import("./types.js").SessionState => ({
    session_id: "s",
    stack: [{ workflow: "w", current_state: "run", state_visits: {}, total_transitions: 0 }],
    active_frame: 0,
    started_at: "t0",
    updated_at: "t0",
    history: [],
    overrides: {},
    context: {},
    ...o,
  });

  it("the model in force is the stage the parent's state reads, not the state's name", () => {
    const log = new EventLog();
    log.setStateResolver((_s, _w, state) =>
      state === "review_spawn"
        ? { prompt: "model {{context.model_review}} {{context.effort_review}}" }
        : undefined,
    );
    const parent = sess({
      session_id: "p",
      context: { model: "m-exec", effort: "e-exec", model_review: "m-rev", effort_review: "e-rev" },
    });
    const child = sess({
      session_id: "c",
      parent_session_id: "p",
      agent_id: "a1",
      agent_step: { workflow: "w", state: "review_spawn", visit: 1 },
      context: { model: "own", effort: "own" },
    });
    log.observe(null, sess({ session_id: "c", parent_session_id: "p" }), parent);
    log.observe(sess({ session_id: "c", parent_session_id: "p" }), child, parent);
    const link = log.since(0).find(e => e.kind === "agent_link")!;
    expect(link.data).toMatchObject({ model: "m-rev", effort: "e-rev" });
  });

  it("a bare position beyond this run's last seq restarts from 0 (API and SSE)", async () => {
    const storage = new InMemoryStorage();
    const server = buildApp(storage as never, {} as Loader).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise(r => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    storage.events.append("rescore", "s", {});
    expect(storage.events.resumeFrom("999")).toBe(0);
    const body = (await (await fetch(`${base}/api/events?since=999`)).json()) as {
      events: unknown[];
    };
    expect(body.events).toHaveLength(1);
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/events/stream`, {
      headers: { "Last-Event-ID": "999" },
      signal: ctl.signal,
    });
    const { value } = await res.body!.getReader().read();
    ctl.abort();
    expect(new TextDecoder().decode(value)).toContain(`id: ${storage.events.run}:1`);
  });

  it("a fanout exec logs exec_start from pending_action.run_at; an unrouted end closes the pair", () => {
    const log = new EventLog();
    const base = sess({});
    log.observe(null, base);
    const running = sess({ pending_action: { frame: 0, state: "run", at: "t1", run_at: "t2" } });
    log.observe(base, running);
    log.observe(running, sess({}));
    const ev = log.since(0);
    expect(ev.map(e => e.kind)).toEqual(["session_start", "exec_start", "exec_end"]);
    expect(ev[1].ts).toBe("t2");
    const execs = fold(ev).get("s")!.execs;
    expect(execs).toMatchObject([{ start: "t2" }]);
    expect(execs[0].end).toBeDefined();
  });

  function setup2(): { engine: Engine; storage: InMemoryStorage } {
    const storage = new InMemoryStorage();
    const { loader, dir } = createTestLoader({
      parent: {
        initial: "start",
        states: {
          start: { sub_workflow: "child", on_complete: "done", on_fail: "done" },
          done: { terminal: true, prompt: "d", outcome: "complete" },
        },
      },
      child: {
        initial: "work",
        states: {
          work: { prompt: "c", transitions: { finish: "end" } },
          end: { terminal: true, prompt: "e", outcome: "complete" },
        },
      },
    });
    dirs.push(dir);
    return { engine: new Engine(storage, loader, new Executor()), storage };
  }
});
