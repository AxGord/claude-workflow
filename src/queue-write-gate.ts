// The PreToolUse guard of the queue file: a hand edit of a queue file is denied and names the tools
// that write it. The queue's own writers take the queue lock, keep key order and comments, check the
// line (known keys, ids, `after:`) and stamp `added` / `base` / `text_hash` / `ended`; a hand edit
// does none of it, and the engine notices none (a dispatcher's plan goes stale). The rule used to live
// only in a memory note.
//
// A queue file is a `.yaml` / `.yml` file directly in a `.claude/batch/` directory (the queue, its
// `.archive.yaml`, a named queue), or any other `.yaml` / `.yml` file that exists and holds a
// top-level `batch_size:` and `tasks:` (a queue of another repo named by a full path). Caught: Write /
// Edit / MultiEdit with such a path and, in a Bash command, the trust gate's command walk (redirects,
// `cp` / `mv` / `rm` / `tee` / `touch` / `sed -i`, `sh -c`, heredocs fed to a shell, `cd`). A read
// (`cat`, `grep`, `wf-queue` with the file as its argument) is not a write and passes; the engine's
// own writers (the MCP tools, `wf-queue`) are no tool call of Edit / Write and `wf-queue` carries the
// file only as an argument, so they pass without a special case.
//
// A speed bump for a confused agent, not a sandbox. An interpreter's inline code is NOT examined (a
// script that reads the queue is as common as one that writes it, and a deny stops the call); a path
// built at run time and a program the command only starts are not seen either. The guard only decides:
// it never rewrites a call. A queue file the tools cannot read (malformed) is the user's to repair in
// a terminal.
import fs from "node:fs";
import path from "node:path";
import { commandPlace, placeOf, TOOL_PATH, type Guard } from "./trust-write-gate.js";

export interface QueueWritePayload {
  readonly tool_name?: unknown;
  readonly tool_input?: Record<string, unknown>;
  readonly cwd?: string;
}

export interface QueueWriteDecision {
  readonly permissionDecision: "deny";
  readonly permissionDecisionReason: string;
}

/** A queue file is never larger than this when sniffed: a bigger file is not read. */
const SNIFF_LIMIT = 8 * 1024 * 1024;

const isYaml = (name: string): boolean => /\.ya?ml$/i.test(name);

/** Whether the file at `canonical` holds a queue header and a task list at the top level. */
function holdsQueue(canonical: string): boolean {
  try {
    const st = fs.statSync(canonical);
    if (!st.isFile() || st.size > SNIFF_LIMIT) return false;
    const text = fs.readFileSync(canonical, "utf8");
    return /^batch_size:/m.test(text) && /^tasks:/m.test(text);
  } catch {
    return false;
  }
}

/** The path (canonical) of a queue file, or undefined. */
export function queueFileAt(canonical: string): string | undefined {
  const name = path.basename(canonical);
  if (!isYaml(name)) return undefined;
  const dir = path.dirname(canonical);
  if (path.basename(dir) === "batch" && path.basename(path.dirname(dir)) === ".claude")
    return canonical;
  return holdsQueue(canonical) ? canonical : undefined;
}

const queueGuard: Guard<string> = {
  at: queueFileAt,
  mentionedIn: () => undefined,
  interpreters: false,
};

function reason(file: string): string {
  return (
    `${file} is a queue file: a hand edit skips the queue lock and the checks of the queue's writers, and nothing notices it. ` +
    "Write it with the queue tools: `queue_add` (a new line), `queue_edit` (a line's keys and notes), `queue_mark` (its status), " +
    "`queue_header` (the window and the run's keys: base, land_test, record_file, land_branch, overlap), or the same through `wf-queue` (`--add`, `--edit`, `--done|--failed|--release|--running`, `--batch-size`, `--header-set`). " +
    "A read is not refused; a malformed file is repaired by the user in a terminal."
  );
}

/** `deny` for a call that writes a queue file, undefined for every other call (a read included). */
export function decideQueueWrite(
  payload: QueueWritePayload,
  env: NodeJS.ProcessEnv = process.env,
): QueueWriteDecision | undefined {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = payload.tool_input ?? {};
  const cwd = payload.cwd ?? process.cwd();
  let file: string | undefined;
  if (tool === "Bash") {
    if (typeof input.command !== "string") return undefined;
    file = commandPlace(input.command, cwd, env, queueGuard);
  } else {
    const key = tool === "NotebookEdit" ? undefined : TOOL_PATH[tool];
    const target = key === undefined ? undefined : input[key];
    if (typeof target !== "string") return undefined;
    file = placeOf(target, cwd, env, queueGuard);
  }
  if (file === undefined) return undefined;
  return { permissionDecision: "deny", permissionDecisionReason: reason(file) };
}
