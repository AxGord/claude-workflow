// Pins of ENG-PANE-LANDED-SPEND: the parent's own spend is recorded on a task's ledger line, tiled over the
// conversation's time (a turn in exactly one line), priced by the same table as an agent's turn.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { measureParentSpend } from "./spend.js";
import type { LedgerEntry } from "./ledger.js";
import { InMemoryStorage, SIMPLE_WORKFLOW, cleanupDir, createTestLoader } from "./test-helpers.js";

const turn = (mid: string, at: string, model: string, usage: object) =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { id: mid, model, usage } });

/** One million output tokens of sonnet 5.5: $10. */
const TEN = { output_tokens: 1_000_000 };

describe("measureParentSpend", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) cleanupDir(d);
  });
  function projects(lines: string[] | undefined): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "parent-spend-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, "proj"), { recursive: true });
    if (lines)
      fs.writeFileSync(path.join(root, "proj", "conv.jsonl"), lines.map(l => `${l}\n`).join(""));
    return root;
  }
  const held = (to: string): LedgerEntry[] =>
    [
      { parent_spend: { conversation: "conv", project: "proj", from: "x", to, offset: 0, usd: 1 } },
    ] as unknown as LedgerEntry[];

  it("sums the conversation's own turns inside the window, a turn once, priced by its model", () => {
    const root = projects([
      turn("a", "2026-11-09T09:00:00Z", "claude-sonnet-5-5", TEN), // before the window
      turn("b", "2026-11-09T10:05:00Z", "claude-sonnet-5-5", TEN),
      turn("b", "2026-11-09T10:05:01Z", "claude-sonnet-5-5", TEN), // the same turn, a second block
      turn("c", "2026-11-09T10:06:00Z", "claude-opus-5-5", TEN),
    ]);
    const p = measureParentSpend("conv", "2026-11-09T10:00:00Z", "2026-11-09T10:10:00Z", [], root)!;
    expect(p.usd).toBeCloseTo(30, 6); // sonnet 10 + opus 20
    expect(p.conversation).toBe("conv");
    expect(p.project).toBe("proj"); // the transcript's project directory
    expect(p.from).toBe("2026-11-09T10:00:00.000Z");
    expect(p.to).toBe("2026-11-09T10:10:00.000Z");
  });

  it("starts just after the latest stretch the ledger holds for that conversation, so a turn is in one line", () => {
    const root = projects([
      turn("b", "2026-11-09T10:05:00Z", "claude-sonnet-5-5", TEN),
      turn("c", "2026-11-09T10:20:00Z", "claude-sonnet-5-5", TEN),
    ]);
    const p = measureParentSpend(
      "conv",
      "2026-11-09T10:00:00Z",
      "2026-11-09T10:30:00Z",
      held("2026-11-09T10:10:00.000Z"),
      root,
    )!;
    expect(p.usd).toBeCloseTo(10, 6);
    expect(p.from).toBe("2026-11-09T10:10:00.001Z");
    // another conversation's stretch moves nothing
    const other = [
      { parent_spend: { conversation: "else", to: "2026-11-09T11:00:00.000Z" } },
    ] as unknown as LedgerEntry[];
    expect(
      measureParentSpend("conv", "2026-11-09T10:00:00Z", "2026-11-09T10:30:00Z", other, root)!.usd,
    ).toBeCloseTo(20, 6);
  });

  it("records nothing for an unreadable transcript, an unpriced model, an empty stretch or an end before the held stretch", () => {
    const W = ["2026-11-09T10:00:00Z", "2026-11-09T10:30:00Z"] as const;
    expect(measureParentSpend("conv", W[0], W[1], [], projects(undefined))).toBeUndefined();
    expect(
      measureParentSpend(
        "conv",
        W[0],
        W[1],
        [],
        projects([turn("a", "2026-11-09T10:05:00Z", "mystery-1", TEN)]),
      ),
    ).toBeUndefined();
    expect(
      measureParentSpend(
        "conv",
        W[0],
        W[1],
        [],
        projects([turn("a", "2026-11-09T09:00:00Z", "claude-sonnet-5-5", TEN)]),
      ),
    ).toBeUndefined();
    const root = projects([turn("a", "2026-11-09T10:05:00Z", "claude-sonnet-5-5", TEN)]);
    expect(
      measureParentSpend("conv", W[0], W[1], held("2026-11-09T10:45:00.000Z"), root),
    ).toBeUndefined();
  });

  it("reads only what is new: a line starts at the offset the conversation's last line recorded, the earlier part is not read again", () => {
    const root = projects([
      turn("b", "2026-11-09T10:05:00Z", "claude-sonnet-5-5", TEN),
      turn("c", "2026-11-09T10:20:00Z", "claude-sonnet-5-5", TEN),
    ]);
    const file = path.join(root, "proj", "conv.jsonl");
    const first = measureParentSpend(
      "conv",
      "2026-11-09T10:00:00Z",
      "2026-11-09T10:10:00Z",
      [],
      root,
    )!;
    expect(first.usd).toBeCloseTo(10, 6);
    // the line stops at the first turn after its end: what is recorded is the bytes of `b` alone
    expect(first.offset).toBe(
      Buffer.byteLength(`${turn("b", "2026-11-09T10:05:00Z", "claude-sonnet-5-5", TEN)}\n`),
    );
    // the part already accounted for is not read again: what stands there now would count if it were (a turn inside the next window of the same length)
    const rest = fs.readFileSync(file).subarray(first.offset);
    const stale = `${turn("b", "2026-11-09T10:12:00Z", "claude-sonnet-5-5", TEN)}\n`;
    expect(Buffer.byteLength(stale)).toBe(first.offset);
    fs.writeFileSync(file, Buffer.concat([Buffer.from(stale), rest]));
    fs.appendFileSync(file, `${turn("d", "2026-11-09T10:25:00Z", "claude-sonnet-5-5", TEN)}\n`);
    const second = measureParentSpend(
      "conv",
      "2026-11-09T10:00:00Z",
      "2026-11-09T10:30:00Z",
      [{ parent_spend: first } as unknown as LedgerEntry],
      root,
    )!;
    expect(second.usd).toBeCloseTo(20, 6); // c and d
    expect(second.offset).toBe(fs.statSync(file).size);
  });

  it("a line that is still being written is left for the next read; an offset past a rewritten file reads from the top", () => {
    const root = projects([turn("b", "2026-11-09T10:05:00Z", "claude-sonnet-5-5", TEN)]);
    const file = path.join(root, "proj", "conv.jsonl");
    const whole = fs.statSync(file).size;
    fs.appendFileSync(
      file,
      turn("c", "2026-11-09T10:06:00Z", "claude-sonnet-5-5", TEN).slice(0, 40),
    );
    const p = measureParentSpend("conv", "2026-11-09T10:00:00Z", "2026-11-09T10:30:00Z", [], root)!;
    expect(p.usd).toBeCloseTo(10, 6);
    expect(p.offset).toBe(whole);
    const stale = {
      parent_spend: { ...p, offset: whole + 100_000, to: "2026-11-09T10:00:00.000Z" },
    } as unknown as LedgerEntry;
    fs.writeFileSync(file, `${turn("z", "2026-11-09T10:07:00Z", "claude-sonnet-5-5", TEN)}\n`);
    expect(
      measureParentSpend("conv", "2026-11-09T10:00:00Z", "2026-11-09T10:30:00Z", [stale], root)!
        .usd,
    ).toBeCloseTo(10, 6);
  });
});

describe("a task's ledger line carries the parent's spend", () => {
  const dirs: string[] = [];
  let config: string | undefined;
  beforeEach(() => {
    config = process.env.CLAUDE_CONFIG_DIR;
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
    if (config === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = config;
    for (const d of dirs.splice(0)) cleanupDir(d);
  });

  it("each task line covers the conversation's time since the line before; a line with no task carries none", async () => {
    const tmp = (p: string) => {
      const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
      dirs.push(d);
      return d;
    };
    const cfg = tmp("wf-cfg-");
    process.env.CLAUDE_CONFIG_DIR = cfg;
    fs.mkdirSync(path.join(cfg, "projects", "p"), { recursive: true });
    fs.writeFileSync(
      path.join(cfg, "projects", "p", "conv-pp.jsonl"),
      [
        turn("p0", "2026-11-09T09:00:00Z", "claude-sonnet-5-5", TEN), // before the first task
        turn("p1", "2026-11-09T10:05:00Z", "claude-sonnet-5-5", TEN),
        turn("p2", "2026-11-09T10:20:00Z", "claude-sonnet-5-5", TEN),
        turn("p3", "2026-11-09T10:45:00Z", "claude-sonnet-5-5", TEN), // inside the line with no task
      ]
        .map(l => `${l}\n`)
        .join(""),
    );
    const stateDir = tmp("wf-state-");
    fs.writeFileSync(path.join(stateDir, `claude-session-${process.ppid}`), "conv-pp\n");
    const storage = new InMemoryStorage();
    const { loader, dir } = createTestLoader({ simple: SIMPLE_WORKFLOW });
    dirs.push(dir);
    const engine = new Engine(storage, loader, new Executor(undefined, tmp("wf-runs-")), {
      stateDir,
    });

    vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
    const a = await engine.start("simple", undefined, undefined, undefined, undefined, {
      slice: "T-A",
    });
    vi.setSystemTime(new Date("2026-11-09T10:10:00Z"));
    await engine.transition(a.sessionId, "next");
    vi.setSystemTime(new Date("2026-11-09T10:15:00Z"));
    const b = await engine.start("simple", undefined, undefined, undefined, undefined, {
      slice: "T-B",
    });
    vi.setSystemTime(new Date("2026-11-09T10:30:00Z"));
    await engine.transition(b.sessionId, "next");
    vi.setSystemTime(new Date("2026-11-09T10:40:00Z"));
    const free = await engine.start("simple");
    vi.setSystemTime(new Date("2026-11-09T10:50:00Z"));
    await engine.transition(free.sessionId, "next");

    const ledger = storage.ledger as LedgerEntry[];
    const byTask = (t: string) => ledger.find(l => l.task === t)!;
    expect(byTask("T-A").parent_spend).toMatchObject({
      conversation: "conv-pp",
      from: "2026-11-09T10:00:00.000Z",
      to: "2026-11-09T10:10:00.000Z",
    });
    expect(byTask("T-A").parent_spend!.usd).toBeCloseTo(10, 6);
    expect(byTask("T-B").parent_spend).toMatchObject({
      from: "2026-11-09T10:10:00.001Z",
      to: "2026-11-09T10:30:00.000Z",
    });
    expect(byTask("T-B").parent_spend!.usd).toBeCloseTo(10, 6);
    expect(ledger.find(l => l.task === undefined)!.parent_spend).toBeUndefined();
    expect(ledger.reduce((s, l) => s + (l.parent_spend?.usd ?? 0), 0)).toBeCloseTo(20, 6);
  });
  it("two task sessions ending at once do not both count the same stretch: the appends run one at a time", async () => {
    const tmp = (p: string) => {
      const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
      dirs.push(d);
      return d;
    };
    const cfg = tmp("wf-cfg-");
    process.env.CLAUDE_CONFIG_DIR = cfg;
    fs.mkdirSync(path.join(cfg, "projects", "p"), { recursive: true });
    fs.writeFileSync(
      path.join(cfg, "projects", "p", "conv-pp.jsonl"),
      `${turn("p1", "2026-11-09T10:05:00Z", "claude-sonnet-5-5", TEN)}\n`,
    );
    const stateDir = tmp("wf-state-");
    fs.writeFileSync(path.join(stateDir, `claude-session-${process.ppid}`), "conv-pp\n");
    const storage = new InMemoryStorage();
    // a real append waits for the ledger's lock: the line is on disk only after that
    const push = storage.appendLedger.bind(storage);
    storage.appendLedger = async entry => {
      await new Promise(r => setTimeout(r, 5));
      await push(entry);
    };
    const { loader, dir } = createTestLoader({ simple: SIMPLE_WORKFLOW });
    dirs.push(dir);
    const engine = new Engine(storage, loader, new Executor(undefined, tmp("wf-runs-")), {
      stateDir,
    });
    vi.setSystemTime(new Date("2026-11-09T10:00:00Z"));
    const root = await engine.start("simple");
    const a = await engine.start("simple", undefined, root.sessionId, undefined, undefined, {
      slice: "T-A",
    });
    const b = await engine.start("simple", undefined, root.sessionId, undefined, undefined, {
      slice: "T-B",
    });
    vi.setSystemTime(new Date("2026-11-09T10:10:00Z"));
    await Promise.all([
      engine.transition(a.sessionId, "next"),
      engine.transition(b.sessionId, "next"),
    ]);
    const lines = (storage.ledger as LedgerEntry[]).filter(l => l.task !== undefined);
    expect(lines).toHaveLength(2);
    expect(lines.reduce((s, l) => s + (l.parent_spend?.usd ?? 0), 0)).toBeCloseTo(10, 6);
  });
});
