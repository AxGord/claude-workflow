import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Loader } from "./loader.js";
import { InMemoryStorage, cleanupDir } from "./test-helpers.js";
import { registerTools } from "./tools.js";

// ENG-DISPATCHER-HANDBACK-BY-MESSAGE: Claude Code accepts ONE SubagentHandback per result, so the
// dispatcher's three messages cannot each be a hand-back. They go by SendMessage to main; the turn-end
// DISPATCHING line is plain text. The test starts a real batch session under the opt-in and reads what
// the dispatcher is actually given: the DRIVER block `start` renders and the instructions file it names.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATES = path.join(ROOT, "templates");

const dirs: string[] = [];
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.WF_DISPATCHER;
  process.env.WF_DISPATCHER = "1";
});
afterEach(() => {
  if (saved === undefined) delete process.env.WF_DISPATCHER;
  else process.env.WF_DISPATCHER = saved;
  for (const d of dirs.splice(0)) cleanupDir(d);
});

async function renderedBlock(): Promise<{ block: string; instructions: string }> {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-handback-"));
  dirs.push(userDir);
  const loader = new Loader(TEMPLATES, userDir, null);
  const storage = new InMemoryStorage();
  const engine = new Engine(storage, loader, new Executor());
  const handlers = new Map<
    string,
    (args: object) => Promise<{ content: Array<{ text: string }> }>
  >();
  const server = { registerTool: (name: string, _cfg: unknown, h: never) => handlers.set(name, h) };
  registerTools(server as never, engine, {} as never, loader, storage);
  const reply = await handlers.get("start")!({ workflow: "batch", reply: "id" });
  const text = reply.content[0].text;
  const block = text.slice(text.indexOf("---\nDRIVER"));
  const file = /read your instructions whole:\s*(\S+)/u.exec(block)![1];
  return { block, instructions: fs.readFileSync(file, "utf8") };
}

describe("the dispatcher's hand-backs go by SendMessage to main", () => {
  it("the DRIVER block does not call each of the three messages 'one hand-back'", async () => {
    const { block } = await renderedBlock();
    expect(block).not.toMatch(/each as one hand-back/u);
  });

  it("the instructions: NEEDS-PARENT, LESSONS and HANDOVER are SendMessage to main, not SubagentHandback", async () => {
    const { instructions } = await renderedBlock();
    const section = instructions.slice(
      instructions.indexOf("## Hand-backs"),
      instructions.indexOf("## Turn end"),
    );
    expect(section).not.toMatch(/ONE `SubagentHandback` call/u);
    expect(section).toMatch(/SendMessage[^\n]*`?main`?/u);
    expect(section).not.toMatch(/You are NOT finished after it/u);
  });

  it("the instructions: the DISPATCHING line is plain text, never handed back or sent", async () => {
    const { instructions } = await renderedBlock();
    const turnEnd = instructions.slice(
      instructions.indexOf("## Turn end"),
      instructions.indexOf("## After a restart"),
    );
    expect(turnEnd).toMatch(/DISPATCHING[^\n]*plain text/u);
    expect(turnEnd).toMatch(/never (handed back|sent)|NEVER (handed back|sent)/u);
    // a [handback-send-enforce] prompt is answered with a plain-text line, not by a hand-back of the NEEDS-PARENT text
    expect(turnEnd).not.toMatch(/send it with `SubagentHandback`/u);
  });

  it("the DRIVER block tells main what to do with the dispatcher's end-of-turn notification", async () => {
    const { block } = await renderedBlock();
    expect(block).toMatch(/notification[^\n]*(nothing|ignore)/iu);
  });

  it("the agent type does not tell the dispatcher to end a hand-back with a SubagentHandback call", () => {
    const agent = fs.readFileSync(path.join(ROOT, "agents", "dispatcher.md"), "utf8");
    expect(agent).not.toMatch(/ONE `SubagentHandback` call/u);
    expect(agent).toMatch(/SendMessage[^\n]*never by `SubagentHandback`/u);
  });

  it("the instructions say what a blocked bundled task's decision is and who ends an orphan child session", async () => {
    const { instructions } = await renderedBlock();
    expect(instructions).toMatch(/blocked[^\n]*\n?[^\n]*`close`/u);
    expect(instructions).toMatch(/orphan[^\n]*\n?[^\n]*`abort`/u);
  });

  it("the retry of a blocked task names the engine's real move, never a mark to pending", async () => {
    const { block, instructions } = await renderedBlock();
    expect(instructions).toMatch(/`queue_mark` to `running` with `retry: true`/u);
    expect(instructions).not.toMatch(/back to pending itself/u);
    expect(block).toMatch(/`queue_mark` to running with `retry: true`/u);
    expect(block).not.toMatch(/queue_mark` to pending/u);
  });
});
