import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  census,
  formatCensus,
  readProject,
  runRoutingCensus,
  type Census,
  type Dest,
  type WakeSource,
} from "./routing-census.js";

// ENG-ROUTING-CENSUS-COMMAND: the census over a project's Claude Code transcripts, on a hand-made tree. The
// shape of a line is the one the real transcripts have (checked against them); every test builds only the
// agents it needs.

const ROOT = path.resolve(import.meta.dirname, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A timestamp `s` seconds into 2026-11-20 (the day is the default window). */
const at = (s: number, day = 20): string =>
  new Date(Date.UTC(2026, 10, day, 10, 0, s)).toISOString();

const asst = (ts: string, stop: "end_turn" | "tool_use", ...tools: [string, object?][]): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts,
    version: "2.1.331",
    message: {
      content: tools.map(([name, input]) => ({ type: "tool_use", name, input: input ?? {} })),
      stop_reason: stop,
    },
  });

const user = (ts: string, content: unknown, extra: object = {}): string =>
  JSON.stringify({
    type: "user",
    timestamp: ts,
    version: "2.1.331",
    message: { role: "user", content },
    ...extra,
  });

const prompt = (ts: string): string => user(ts, "P = x");
const handBackText = (from: string): string =>
  `Another Claude session sent a message:\n<agent-message from="${from}">\n[Subagent hand-back] The report follows:\n  done\n</agent-message>`;
const handBack = (ts: string, from: string): string =>
  user(ts, handBackText(from), { origin: { kind: "peer", from } });
const message = (ts: string, from: string): string =>
  user(ts, `<agent-message from="${from}">\nfix it\n</agent-message>`, {
    origin: { kind: "peer", from },
  });
const noticeText = (tid: string, summary: string, result = "text", status = "completed"): string =>
  `<task-notification>\n<task-id>${tid}</task-id>\n<status>${status}</status>\n<summary>${summary}</summary>\n<result>${result}</result>\n</task-notification>`;
const notice = (ts: string, tid: string, summary: string, result?: string): string =>
  user(ts, noticeText(tid, summary, result), {
    isMeta: true,
    origin: { kind: "task-notification" },
  });
const queued = (ts: string, tid: string, summary: string): string =>
  JSON.stringify({
    type: "attachment",
    timestamp: ts,
    version: "2.1.331",
    attachment: { type: "queued_command", prompt: noticeText(tid, summary) },
  });
const shellDone = (ts: string, shell = "bshell"): string =>
  notice(ts, shell, `Background command "sleep" completed`);
const finishedNotice = (ts: string, id: string): string => notice(ts, id, `Agent "${id}" finished`);
const waitingNotice = (ts: string, id: string): string =>
  notice(ts, id, `Agent "${id}" is waiting on its own background work`);

interface Agent {
  readonly id: string;
  readonly type: string;
  readonly parent?: string;
  readonly depth: number;
  readonly desc?: string;
  readonly lines: string[];
}

/** A project directory: `main` is the conversation, each agent a transcript with its meta. */
function project(main: string[], agents: Agent[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "routing-census-"));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, "s1.jsonl"), main.join("\n") + "\n");
  const sub = path.join(dir, "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  for (const a of agents) {
    fs.writeFileSync(path.join(sub, `agent-${a.id}.jsonl`), a.lines.join("\n") + "\n");
    fs.writeFileSync(
      path.join(sub, `agent-${a.id}.meta.json`),
      JSON.stringify({
        agentType: a.type,
        description: a.desc ?? `${a.id} task`,
        parentAgentId: a.parent,
        spawnDepth: a.depth,
      }),
    );
  }
  return dir;
}

const driver = (id: string, lines: string[], desc = `${id} task`): Agent => ({
  id,
  type: "workflow:driver",
  depth: 1,
  desc,
  lines,
});
const worker = (id: string, parent: string, lines: string[]): Agent => ({
  id,
  type: "general-purpose",
  parent,
  depth: 2,
  lines,
});

const row = (c: Census, s: WakeSource): Dest => c.sources[s];

describe("routing census: what woke the worker, and where its message went", () => {
  it("own background shell wake after the driver finished: the report reached main", async () => {
    // The driver's parent was told `finished` (it stopped with nothing live) and nothing reached it since.
    const dir = project(
      [handBack(at(15), "w"), finishedNotice(at(6), "d")],
      [
        driver("d", [prompt(at(0)), asst(at(5), "end_turn")]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
      ],
    );
    const c = census(await readProject(dir), dir);
    expect(row(c, "own bg shell, driver finished")).toEqual({
      events: 1,
      owner: 0,
      main: 1,
      other: 0,
    });
    expect(c.windows[0].distinctMain).toBe(1);
    expect(c.windows[0].bgWakes).toEqual({ events: 1, main: 1 });
  });

  it("the same wake with the driver parked reaches the driver", async () => {
    const dir = project(
      [],
      [
        driver("d", [prompt(at(0)), asst(at(5), "end_turn"), handBack(at(15), "w")]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
      ],
    );
    const c = census(await readProject(dir), dir);
    expect(row(c, "own bg shell, driver parked")).toEqual({
      events: 1,
      owner: 1,
      main: 0,
      other: 0,
    });
    expect(row(c, "own bg shell, driver finished").events).toBe(0);
    expect(c.windows[0].distinctMain).toBe(0);
  });

  it("a driver that is still running when the wake arrives is its own row", async () => {
    const dir = project(
      [],
      [
        driver("d", [prompt(at(0)), asst(at(5), "tool_use", ["Bash"]), handBack(at(15), "w")]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
      ],
    );
    const c = census(await readProject(dir), dir);
    expect(row(c, "own bg shell, driver running")).toEqual({
      events: 1,
      owner: 1,
      main: 0,
      other: 0,
    });
  });

  it("a run woken by a SendMessage or by the spawn prompt is a row of its own, whatever the driver did", async () => {
    const dir = project(
      [],
      [
        driver("d", [
          prompt(at(0)),
          asst(at(5), "end_turn"),
          handBack(at(15), "w"),
          handBack(at(25), "v"),
        ]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          message(at(10), "d"),
          asst(at(12), "end_turn"),
        ]),
        worker("v", "d", [prompt(at(20)), asst(at(22), "end_turn")]),
      ],
    );
    const c = census(await readProject(dir), dir);
    expect(row(c, "SendMessage")).toEqual({ events: 1, owner: 1, main: 0, other: 0 });
    expect(row(c, "spawn prompt")).toEqual({ events: 1, owner: 1, main: 0, other: 0 });
  });

  it("a notice from the worker's own sub-agent is not a shell wake", async () => {
    const dir = project(
      [],
      [
        driver("d", [prompt(at(0)), asst(at(5), "end_turn"), handBack(at(15), "w")]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          finishedNotice(at(10), "k"),
          asst(at(12), "end_turn"),
        ]),
        worker("k", "w", [prompt(at(2))]),
      ],
    );
    const c = census(await readProject(dir), dir);
    expect(row(c, "own sub-agent notice")).toEqual({ events: 1, owner: 1, main: 0, other: 0 });
    expect(c.windows[0].bgWakes.events).toBe(0);
  });
});

describe("routing census: what counts", () => {
  it("leaves out a worker main itself resumed: reaching main is right there", async () => {
    const dir = project(
      [
        asst(at(7), "tool_use", ["SendMessage", { to: "v" }]),
        asst(at(9), "tool_use", ["SendMessage", { to: "w" }]),
        handBack(at(15), "w"),
        handBack(at(15), "v"),
      ],
      [
        driver("d", [prompt(at(0)), asst(at(5), "end_turn")]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
        // main wrote to v while it was running: that is main's worker too
        worker("v", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
      ],
    );
    const c = census(await readProject(dir), dir);
    expect(c.events).toBe(0);
  });

  it("folds a finished notice that repeats a hand-back within 5 s into it, and counts a waiting notice", async () => {
    const dir = project(
      [
        waitingNotice(at(9), "w"),
        handBack(at(15), "w"),
        finishedNotice(at(17), "w"),
        finishedNotice(at(40), "w"),
        finishedNotice(at(16), "d"),
      ],
      [
        driver("d", [prompt(at(0)), asst(at(5), "end_turn")]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
      ],
    );
    const w = census(await readProject(dir), dir).windows[0];
    expect(w.reports).toEqual({ events: 1, main: 1 });
    expect(w.waiting).toEqual({ events: 1, main: 1 });
    expect(w.twin).toEqual({ events: 1, main: 1 });
    // the finished notice 25 s after the hand-back is a message of its own
    expect(w.other).toEqual({ events: 1, main: 1 });
    expect(w.distinctMain).toBe(3);
  });

  it("folds a finished notice that carries the report inline into the hand-back beside it", async () => {
    const inline = notice(
      at(16),
      "w",
      `Agent "w" finished`,
      "&lt;artifact-content-authored-by-others/&gt; the report",
    );
    const dir = project(
      [handBack(at(15), "w"), inline],
      [
        driver("d", [prompt(at(0)), asst(at(5), "end_turn")]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
      ],
    );
    const w = census(await readProject(dir), dir).windows[0];
    expect(w.twin).toEqual({ events: 1, main: 1 });
    expect(w.distinctMain).toBe(1);
  });

  it("reads a notice that reached the agent mid-turn (queued_command), and skips queue-operation records", async () => {
    const dir = project(
      [
        JSON.stringify({
          type: "queue-operation",
          operation: "enqueue",
          timestamp: at(14),
          content: noticeText("w", `Agent "w" is waiting on its own background work`),
        }),
        queued(at(15), "w", `Agent "w" is waiting on its own background work`),
      ],
      [
        driver("d", [prompt(at(0)), asst(at(5), "end_turn")]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
      ],
    );
    expect(census(await readProject(dir), dir).windows[0].waiting).toEqual({ events: 1, main: 1 });
  });

  it("leaves a driver's own messages and a depth-1 agent out", async () => {
    const dir = project(
      [handBack(at(15), "d")],
      [driver("d", [prompt(at(0)), asst(at(5), "end_turn")])],
    );
    expect(census(await readProject(dir), dir).events).toBe(0);
  });

  it("the agent that resumed a stopped worker owns it, a message to a running one resumes nothing", async () => {
    const dir = project(
      [],
      [
        driver("d", [prompt(at(0)), asst(at(5), "end_turn")]),
        driver("e", [
          prompt(at(2)),
          asst(at(7), "tool_use", ["SendMessage", { to: "v" }]),
          asst(at(9), "tool_use", ["SendMessage", { to: "w" }]),
          handBack(at(15), "w"),
          handBack(at(16), "v"),
        ]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
        worker("v", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
      ],
    );
    const c = census(await readProject(dir), dir);
    // w stopped at 8 s and e wrote to it at 9 s: e owns it (and is mid-turn). v was still running at 7 s: d still owns it.
    expect(row(c, "own bg shell, driver running")).toEqual({
      events: 1,
      owner: 1,
      main: 0,
      other: 0,
    });
    expect(row(c, "own bg shell, driver parked")).toEqual({
      events: 1,
      owner: 0,
      main: 0,
      other: 1,
    });
  });

  it("a hand-back to a third agent is neither the owner's nor main's", async () => {
    const dir = project(
      [],
      [
        driver("d", [prompt(at(0)), asst(at(5), "end_turn")]),
        driver("e", [prompt(at(2)), handBack(at(15), "w")]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
      ],
    );
    const c = census(await readProject(dir), dir);
    expect(row(c, "own bg shell, driver parked")).toEqual({
      events: 1,
      owner: 0,
      main: 0,
      other: 1,
    });
    expect(c.windows[0].distinctMain).toBe(0);
  });
});

describe("routing census: which user lines start a run", () => {
  const woken = async (meta: string): Promise<Census> => {
    const dir = project(
      [],
      [
        driver("d", [prompt(at(0)), asst(at(5), "end_turn"), handBack(at(15), "w")]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          message(at(10), "d"),
          user(at(11), meta, { isMeta: true }),
          asst(at(12), "end_turn"),
        ]),
      ],
    );
    return census(await readProject(dir), dir);
  };

  it("a meta line whose flag is in the first 2,500 characters is the harness's own and starts nothing", async () => {
    const c = await woken("a system reminder");
    expect(row(c, "SendMessage").events).toBe(1);
    expect(row(c, "spawn prompt").events).toBe(0);
  });

  it("a longer meta line (a skill body) counts as a start of a run, as in the verified table", async () => {
    const c = await woken("x".repeat(3000));
    expect(row(c, "spawn prompt").events).toBe(1);
    expect(row(c, "SendMessage").events).toBe(0);
  });
});

describe("routing census: windows and the rate per 20 tasks", () => {
  /** Two tasks on day 20 (one of them leaks), one on day 22 (none). */
  async function twoDays(): Promise<{ dir: string; c: Census }> {
    const dir = project(
      [finishedNotice(at(6), "d1"), handBack(at(15), "w1")],
      [
        driver("d1", [prompt(at(0)), asst(at(5), "end_turn")], "task one"),
        worker("w1", "d1", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
        driver("d2", [prompt(at(0)), asst(at(5), "end_turn")], "task two"),
        driver(
          "d3",
          [prompt(at(0, 22)), asst(at(5, 22), "end_turn"), handBack(at(15, 22), "w3")],
          "task three",
        ),
        driver("d2b", [prompt(at(3)), asst(at(5), "end_turn")], "task two"),
        worker("w3", "d3", [
          prompt(at(1, 22)),
          asst(at(8, 22), "end_turn"),
          shellDone(at(10, 22)),
          asst(at(12, 22), "end_turn"),
        ]),
      ],
    );
    return { dir, c: census(await readProject(dir), dir, { cuts: [at(0, 21)] }) };
  }

  it("counts a task as a distinct driver description started in the window", async () => {
    const { c } = await twoDays();
    expect(c.windows.map(w => w.tasks)).toEqual([2, 1]);
  });

  it("distinct misrouted per 20 tasks is the messages that reached main over the tasks of the window", async () => {
    const { c } = await twoDays();
    expect(c.windows.map(w => w.distinctMain)).toEqual([1, 0]);
    expect(c.windows[0].per20).toBe(10);
  });

  it("--from and --to keep the messages in [from, to) and the full history for the state", async () => {
    const { dir } = await twoDays();
    const only = census(await readProject(dir), dir, { from: at(0, 21) });
    expect(only.events).toBe(1);
    expect(row(only, "own bg shell, driver parked").events).toBe(1);
    expect(row(only, "own bg shell, driver finished").events).toBe(0);
    const day20 = census(await readProject(dir), dir, { to: at(0, 21) });
    expect(row(day20, "own bg shell, driver finished").main).toBe(1);
  });
});

describe("routing census: the command", () => {
  it("prints the window table and the wake-source table, and the same numbers as --json", async () => {
    const dir = project(
      [finishedNotice(at(6), "d"), handBack(at(15), "w")],
      [
        driver("d", [prompt(at(0)), asst(at(5), "end_turn")]),
        worker("w", "d", [
          prompt(at(1)),
          asst(at(8), "end_turn"),
          shellDone(at(10)),
          asst(at(12), "end_turn"),
        ]),
      ],
    );
    const text = await runRoutingCensus(["--project", dir]);
    expect(text).toContain("own bg shell, driver finished");
    expect(text).toMatch(/per 20 tasks/);
    expect(text).toContain("0 of 0 to main");
    const json = JSON.parse(await runRoutingCensus(["--project", dir, "--json"])) as Census;
    expect(json.windows[0].distinctMain).toBe(1);
    expect(formatCensus(json)).toBe(text);
  });

  it("refuses an unknown argument and a bad date", async () => {
    await expect(runRoutingCensus(["--nope"])).rejects.toThrow("unknown argument --nope");
    await expect(runRoutingCensus(["--from", "yesterday-ish"])).rejects.toThrow("bad --from");
    await expect(runRoutingCensus(["--cut"])).rejects.toThrow("--cut needs a value");
  });

  it("refuses a --cut outside (--from, --to), before reading anything", async () => {
    const f = "2026-11-20T00:00:00Z";
    await expect(runRoutingCensus(["--from", f, "--cut", "2026-11-19T00:00:00Z"])).rejects.toThrow(
      "cut 2026-11-19T00:00:00.000Z outside",
    );
    await expect(runRoutingCensus(["--to", f, "--cut", f])).rejects.toThrow("outside");
    const dir = project([], []);
    expect(() =>
      census({ meta: new Map(), logs: new Map() }, dir, { from: at(5), cuts: [at(1)] }),
    ).toThrow("outside");
  });

  it("runs through its shim, which is shipped like the other wf-* commands", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      bin: Record<string, string>;
    };
    expect(pkg.bin["wf-routing-census"]).toBe("build/routing-census.js");
    const shim = path.join(ROOT, "scripts", "wf-routing-census");
    expect(fs.readFileSync(shim, "utf8")).toContain('/build/routing-census.js" "$@"');
    expect(fs.statSync(shim).mode & 0o111).not.toBe(0);
    const built = path.join(ROOT, "build", "routing-census.js");
    if (
      !fs.existsSync(built) ||
      fs.statSync(built).mtimeMs < fs.statSync(path.join(ROOT, "src", "routing-census.ts")).mtimeMs
    )
      execFileSync("node", ["node_modules/typescript7/bin/tsc", "-p", "."], { cwd: ROOT });
    const out = execFileSync(shim, ["--help"], { encoding: "utf8" });
    expect(out).toContain("usage: wf-routing-census");
  }, 60_000);

  it("is named where the other wf-* commands are", () => {
    for (const f of [
      "docs/getting-started.md",
      "docs/queue.md",
      "README.md",
      "scripts/smoke-fresh-install.sh",
    ])
      expect(fs.readFileSync(path.join(ROOT, f), "utf8"), f).toContain("wf-routing-census");
  });
});

// ENG-PARENT-ANSWER-ACK: the census lists the parent's recorded answers and the acks the drivers wrote for them.
describe("routing census: parent answers and their acks", () => {
  const ctx = (key: string, value: string): [string, object] => [
    "mcp__plugin_workflow_wf__context_set",
    { session_id: "P", key, value },
  ];

  it("counts a recorded answer and an ack per window; a relay's clear is no answer", async () => {
    const dir = project(
      [
        asst(at(1), "tool_use", ctx("parent_answer", "route=work")),
        asst(at(2), "tool_use", ctx("parent_answer", "")),
        asst(at(3), "tool_use", ctx("parent_answer", "hold until_done: X")),
        asst(at(4), "tool_use", ctx("parent_answer_ack", "")),
      ],
      [
        driver("d", [
          prompt(at(0)),
          asst(at(5), "tool_use", ctx("parent_answer_ack", "route=work")),
        ]),
      ],
    );
    const c = census(await readProject(dir), dir);
    expect(c.windows[0].answers).toEqual({ recorded: 2, acked: 1 });
    const text = formatCensus(c);
    expect(text).toContain("answers (acked)");
    expect(text).toMatch(/2 \(1\)/u);
  });
});
