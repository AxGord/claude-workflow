import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, cleanupDir, createFixtureDir } from "./test-helpers.js";
import { registerTools } from "./tools.js";

// ENG-REVISIT-PROMPT-VAR-NOTICE: the bundled `collect` renders the last pick's `{{stderr}}` (the admission
// summary: a held window, a gate). On visit 2 the transition reply is the one-line `Revisit #N`, so a
// non-empty summary never reaches the agent; a visit with an empty one has nothing to show.

const TEMPLATES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates");
const dirs: string[] = [];
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.WF_DISPATCHER;
  delete process.env.WF_DISPATCHER;
});
afterEach(() => {
  if (saved !== undefined) process.env.WF_DISPATCHER = saved;
  for (const d of dirs.splice(0)) cleanupDir(d);
});

const SIGNAL = "WINDOW HELD: T2 waits, a gate of T1 is unmet";

/**
 * Visit 1 and visit 2 of the state a `pick` exec routes to (its stderr is `pickErr`, its exit code `route.code`; the
 * bundled `collect` by default, with `collectOverride` laid over it): `route.move` is the transition that re-enters it.
 */
async function twoVisits(
  pickErr: string,
  collectOverride?: Record<string, unknown>,
  route: { code: number; move: string } = { code: 10, move: "slot_free" },
): Promise<{ first: string; second: string }> {
  const dir = createFixtureDir({
    w: {
      extends: "batch",
      initial: "pick",
      states: {
        pick: {
          type: "exec",
          command: `printf '%s' '${pickErr}' >&2; exit ${route.code}`,
          cases: { "10": "collect", "12": "paused" },
          default: "pick_failed",
        },
        // an heir's state replaces the bundled one whole
        ...(collectOverride === undefined
          ? {}
          : {
              collect: {
                prompt: "Last pick:\n{{stderr}}",
                transitions: { slot_free: "pick" },
                ...collectOverride,
              },
            }),
      },
    },
  });
  dirs.push(dir);
  const loader = new Loader(TEMPLATES, dir, null);
  const storage = new InMemoryStorage();
  const handlers = new Map<string, (a: object) => Promise<{ content: Array<{ text: string }> }>>();
  const server = { registerTool: (n: string, _c: unknown, h: never) => handlers.set(n, h) };
  registerTools(
    server as never,
    new Engine(storage, loader, new Executor()),
    {} as never,
    loader,
    storage,
  );
  const call = async (n: string, a: object) => (await handlers.get(n)!(a)).content[0].text;
  const first = await call("start", { workflow: "w" });
  const id = /SESSION: (\w+)/.exec(first)?.[1] ?? expect.fail(first);
  // `start` ran the pick exec: the session stands at the routed state, visit 1
  const second = await call("transition", { session_id: id, transition: route.move });
  return { first, second };
}

describe("a revisit's reply carries a non-empty prompt signal var", () => {
  it("visit 2 of collect names the pick's non-empty stderr", async () => {
    const { first, second } = await twoVisits(SIGNAL);
    expect(first).toContain(SIGNAL);
    expect(second).toContain("Revisit #2");
    expect(second).toContain(SIGNAL);
  });

  it("an empty stderr adds nothing on visit 2", async () => {
    const { second } = await twoVisits("");
    expect(second).toContain("Revisit #2");
    expect(second).not.toMatch(/WINDOW HELD|signal/iu);
  });

  it("the notice is one line: a multi-line value is joined, a long one cut", async () => {
    const { second } = await twoVisits(`${SIGNAL}\nsecond line\n${"x".repeat(400)}`);
    const line = second.split("\n").find(l => l.startsWith("SIGNAL stderr: "))!;
    expect(line).toContain(`${SIGNAL} | second line | `);
    expect(line.length).toBeLessThan(360);
    expect(line.endsWith("… (cut; status() shows it whole)")).toBe(true);
  });

  it("a value that fits is quoted whole, with no pointer", async () => {
    const { second } = await twoVisits(SIGNAL);
    expect(second).toContain(`SIGNAL stderr: ${SIGNAL}\n`);
    expect(second).not.toContain("(cut;");
  });

  it("a revisit_prompt that renders a 2-line value shows it once", async () => {
    const { second } = await twoVisits(`${SIGNAL}\nnothing admitted`, {
      revisit_prompt: "Pick said: {{stderr}}",
    });
    expect(second).toContain(`Pick said: ${SIGNAL}\nnothing admitted`);
    expect(second).not.toContain("SIGNAL stderr");
    expect(second.split("nothing admitted").length).toBe(2);
  });

  it("visit 2 of pick_failed names the new failure", async () => {
    const { first, second } = await twoVisits("malformed queue: no batch_size", undefined, {
      code: 2,
      move: "retry",
    });
    expect(first).toContain("The pick failed");
    expect(second).toContain("Revisit #2");
    expect(second).toContain("SIGNAL stderr: malformed queue: no batch_size");
  });

  it("visit 2 of paused names the pause reason", async () => {
    const { second } = await twoVisits("window 0 - paused: user is away", undefined, {
      code: 12,
      move: "retry",
    });
    expect(second).toContain("Revisit #2");
    expect(second).toContain("SIGNAL stderr: window 0 - paused: user is away");
  });

  it("a state without `signal_vars` shows nothing for a non-empty var", async () => {
    const { second } = await twoVisits(SIGNAL, { signal_vars: [] });
    expect(second).toContain("Revisit #2");
    expect(second).not.toContain(SIGNAL);
  });

  it("a revisit_prompt that already shows the value adds no second line", async () => {
    const { second } = await twoVisits(SIGNAL, { revisit_prompt: "Pick said: {{stderr}}" });
    expect(second).toContain(`Pick said: ${SIGNAL}`);
    expect(second.split(SIGNAL).length).toBe(2);
  });

  it("the `none` a lazy list var renders for nothing is not a signal", async () => {
    const { second } = await twoVisits("none");
    expect(second).not.toContain("SIGNAL");
  });
});
