import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./dashboard.js";
import { Storage } from "./storage.js";
import { Loader } from "./loader.js";
import { computeStations, stationWarnings } from "./stations.js";
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "./types.js";

function fixture(name: string): WorkflowDefinition {
  const file = path.join(import.meta.dirname, "fixtures", "stations", `${name}.yaml`);
  return WorkflowDefinitionSchema.parse(YAML.parse(fs.readFileSync(file, "utf8")));
}

function wf(states: Record<string, unknown>, initial = "a"): WorkflowDefinition {
  return WorkflowDefinitionSchema.parse({ name: "t", initial, states });
}

/** `(name` for an agent step, `[name` for a script, as the band draws them. */
function shape(def: WorkflowDefinition): string {
  return computeStations(def)
    .map(s => `${s.script ? "[" : "("}${s.name}`)
    .join(" > ");
}

describe("stations of the real workflow shapes", () => {
  it("slice-pipeline: the full pipeline to done, not the early exits", () => {
    expect(shape(fixture("slice-pipeline"))).toBe(
      "(claim > (work > (plan_spawn > [worker_end > (review > [land > [mark_landed > (bookkeeping > [cleanup > (done",
    );
  });

  it("engine-task: claim to done through the project exec steps", () => {
    expect(shape(fixture("engine-task"))).toBe(
      "(claim > [project_prepare > (work > [project_gate > (review > [project_land > [mark_done > [cleanup > (done",
    );
  });

  it("slice-worker: finish, not the rescored early exit", () => {
    expect(shape(fixture("slice-worker"))).toBe(
      "(orient > (implement > [gate_baseline > [gate > (report > (finish",
    );
  });

  it("marks the terminal and the scripts", () => {
    const stations = computeStations(fixture("engine-task"));
    expect(stations.filter(s => s.terminal).map(s => s.name)).toEqual(["done"]);
    expect(stations.filter(s => s.script).map(s => s.name)).toEqual([
      "project_prepare",
      "project_gate",
      "project_land",
      "mark_done",
      "cleanup",
    ]);
  });

  it("without the station: false overrides the helpers show", () => {
    const def = fixture("slice-pipeline");
    for (const s of Object.values(def.states)) delete s.station;
    const names = computeStations(def).map(s => s.name);
    expect(names).toContain("prepare");
    expect(names).toContain("recon_route");
    expect(names).toContain("plan_route");
  });
});

describe("stations rules", () => {
  const line = {
    a: { transitions: { go: "b" } },
    b: { type: "exec", on_success: "c" },
    c: { transitions: { go: "end" } },
    end: { terminal: true, outcome: "complete" },
  };

  it("walks the shortest path in order", () => {
    expect(shape(wf(line))).toBe("(a > [b > (c > (end");
  });

  it("station: false drops a state, station: true adds one off the path in distance order", () => {
    const states = {
      ...line,
      b: { ...line.b, station: false },
      a: { transitions: { go: "b", side: "x" } },
      x: { transitions: { back: "b" }, station: true },
    };
    expect(shape(wf(states))).toBe("(a > (x > (c > (end");
  });

  it("an unreachable station: true state is ignored", () => {
    expect(shape(wf({ ...line, lost: { station: true, transitions: { go: "end" } } }))).toBe(
      "(a > [b > (c > (end",
    );
  });

  it("the happy path ignores error and exhaustion routes that would shortcut", () => {
    const states = {
      ...line,
      b: { type: "exec", on_success: "c", on_error: "end" },
      c: { transitions: { go: "end" }, on_exhausted: "end" },
    };
    expect(shape(wf(states))).toBe("(a > [b > (c > (end");
  });

  it("takes the farthest non-failing terminal; a failing terminal never", () => {
    const states = {
      ...line,
      a: { transitions: { go: "b", quit: "early", boom: "bad" } },
      early: { terminal: true, outcome: "complete" },
      bad: { terminal: true, outcome: "fail" },
    };
    expect(shape(wf(states))).toBe("(a > [b > (c > (end");
  });

  it("a terminal with station: true is the success end even when nearer", () => {
    const states = {
      ...line,
      a: { transitions: { go: "b", quit: "early" } },
      early: { terminal: true, outcome: "complete", station: true },
    };
    expect(shape(wf(states))).toBe("(a > (early");
  });

  it("a station: true terminal reached only by an error route is still the success end", () => {
    const states = {
      a: { type: "exec", on_success: "end", on_error: "win" },
      end: { terminal: true, outcome: "complete" },
      win: { terminal: true, outcome: "complete", station: true },
    };
    expect(shape(wf(states))).toBe("[a > (win");
  });

  it("falls back to every route when the happy ones never reach a terminal", () => {
    const states = {
      a: { type: "exec", on_success: "a", on_error: "end" },
      end: { terminal: true, outcome: "complete" },
    };
    expect(shape(wf(states))).toBe("[a > (end");
  });

  it("no non-failing terminal: no stations", () => {
    expect(
      computeStations(
        wf({ a: { transitions: { go: "bad" } }, bad: { terminal: true, outcome: "fail" } }),
      ),
    ).toEqual([]);
  });
});

describe("station: true on a terminal that cannot be the end", () => {
  const line = { a: { transitions: { go: "end" } } };
  it("a failure terminal: warns and does not become the end", () => {
    const def = wf({
      ...line,
      end: { terminal: true, outcome: "complete" },
      bad: { terminal: true, outcome: "fail", station: true },
    });
    expect(stationWarnings(def)).toEqual([expect.stringContaining("failure terminal (bad)")]);
    expect(shape(def)).toBe("(a > (end");
  });
  it("several terminals: warns and the marks are ignored", () => {
    const def = wf({
      a: { transitions: { x: "near", y: "m" } },
      near: { terminal: true, outcome: "complete", station: true },
      m: { transitions: { go: "far" } },
      far: { terminal: true, outcome: "complete", station: true },
    });
    expect(stationWarnings(def)).toEqual([
      expect.stringContaining("several terminals (near, far)"),
    ]);
    expect(shape(def)).toBe("(a > (m > (far");
  });
  it("a failure mark beside a good one: one line naming the failure, no column for it", () => {
    const def = wf({
      a: { transitions: { go: "end", no: "bad" } },
      end: { terminal: true, outcome: "complete", station: true },
      bad: { terminal: true, outcome: "fail", station: true },
    });
    expect(stationWarnings(def)).toEqual([expect.stringContaining("failure terminal (bad)")]);
    expect(shape(def)).toBe("(a > (end");
  });
  it("one good mark: no warning", () => {
    expect(
      stationWarnings(wf({ ...line, end: { terminal: true, outcome: "complete", station: true } })),
    ).toEqual([]);
  });
  it("the loader writes the warning to stderr", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stw-"));
    fs.writeFileSync(
      path.join(dir, "w.yaml"),
      YAML.stringify({
        name: "w",
        initial: "a",
        states: {
          a: { type: "prompt", prompt: "x", transitions: { go: "bad" } },
          bad: { terminal: true, outcome: "fail", station: true },
        },
      }),
    );
    const seen: string[] = [];
    const orig = console.error;
    console.error = (m: string) => void seen.push(String(m));
    try {
      new Loader(null, dir, null);
    } finally {
      console.error = orig;
    }
    expect(seen.join("\n")).toContain("station: true on a failure terminal");
  });
});

describe("/api/workflows", () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("carries each workflow's stations", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-stations-"));
    dirs.push(dir);
    const loader = {
      getAll: () => new Map([["engine-task", fixture("engine-task")]]),
    } as unknown as Loader;
    const server = buildApp(new Storage(path.join(dir, "state")), loader).listen(0, "127.0.0.1");
    servers.push(server);
    await new Promise(r => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const body = (await (await fetch(`${base}/api/workflows`)).json()) as Record<
      string,
      { stations: { name: string; script: boolean; terminal: boolean }[] }
    >;
    expect(body["engine-task"].stations[0]).toEqual({
      name: "claim",
      script: false,
      terminal: false,
    });
    expect(body["engine-task"].stations.at(-1)).toEqual({
      name: "done",
      script: false,
      terminal: true,
    });
    expect(body["engine-task"].stations[1].script).toBe(true);
  });
});
