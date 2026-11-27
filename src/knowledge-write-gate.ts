// The PreToolUse guard of knowledge placement: the CREATION of a new memory file under
// `<~/.claude>/projects/*/memory/` is denied (or asked) unless its frontmatter carries a
// `why-memory: 7 <why no row 1-6 fits>` or `why-memory: 6 <the map line naming memory as the
// owner-call home>` line; the reason is the placement table's seven lines. Memory is the last row of
// that table, so a file there has to say why no earlier row held it.
//
// Scope, on purpose: only a NEW `.md` file with a lower-case letter in its name is gated. An edit of an
// existing file passes, an index line of `MEMORY.md` / `PARENT.md` / `ARCHIVE.md` included (a name with
// no lower-case letter is an index), and so does a file that is not `.md`. A skills write is not
// guarded by this hook. The gate is opt-in per project: `memory_write_gate: "deny" | "ask"` in the
// project's `.claude/workflows/settings.json`; with the key absent no call is touched. The guard only
// decides: it never rewrites a call.
//
// A speed bump for a confused agent, not a sandbox. Write / Edit / MultiEdit read the frontmatter of the
// content the call creates. A Bash command is read by the trust gate's command walk (redirects, `cp` /
// `mv` / `install` / `tee` / `touch`, interpreters, `sh -c`, heredocs, `cd`) and passes only when its
// text carries the `why-memory:` line (a heredoc body does). A `cp` / `mv` into memory of a file that
// already holds the line is a false refusal, not a miss: the command text lacks the line, so the copy
// and a rename inside memory are refused too. Not caught: a path built at run time, a write by a
// program the command only starts, and a memory directory elsewhere than
// `<CLAUDE_CONFIG_DIR or ~/.claude>/projects`. Whether Claude Code's
// own background memory extraction reaches this hook is not known: the model's own Write to the
// directory does (the live proof is in CHANGELOG); the curator's memory sweep is the only backstop for
// a write that bypasses it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectMemoryWriteGate, type MemoryWriteGateMode } from "./project-settings.js";
import { canon, commandPlace, placeOf, type Guard } from "./trust-write-gate.js";

export interface KnowledgeWritePayload {
  readonly tool_name?: unknown;
  readonly tool_input?: Record<string, unknown>;
  readonly cwd?: string;
}

export interface KnowledgeWriteDecision {
  readonly permissionDecision: MemoryWriteGateMode;
  readonly permissionDecisionReason: string;
}

/** The placement table in one line a row, in the order the first fit wins. */
export const PLACEMENT_ROWS: readonly string[] = [
  "1 a check a tool, hook, lint rule or gate can hold -> a queue line against the tool's owner (a designed lint finding: the lint config's baseline)",
  "2 how a flow routes, or a rule for ONE process moment -> the workflow state prompt that runs then",
  "3 true across projects (a gotcha, tool behaviour, a habit, a correction of how to work) -> a skill",
  "4 true of THIS project and every agent obeys it at every command -> the project's instructions file, within its own gate",
  "5 project knowledge read on demand -> a doc by its role; a refuted hypothesis -> one line of the decisions log; a measured reading -> the commit message and the journal",
  "6 a call of the user (taste, scope, prohibition, goal) -> the project's decision home named in its map, with the quote and the date",
  "7 none of the above (not findable in the tree, or the user asked to remember it) -> memory: one file, one index line, a why-memory line",
];

/** A frontmatter line that names the row and a reason: `why-memory: 7 <reason>`. */
const WHY_TEXT = "why-memory:[ \\t]*[67][ \\t]+\\S";
const WHY_LINE = new RegExp(`^${WHY_TEXT}`, "m");
/** The same in the text of a Bash command, where the line is not the start of a line (`printf 'a\nwhy-memory: 7 x'`). */
const WHY_IN_COMMAND = new RegExp(WHY_TEXT);

const TOOL_PATH: Readonly<Record<string, string>> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
};

/** The `.md` file a gate guards: no lower-case letter in the name means an index (`MEMORY.md`). */
function isTopicFile(name: string): boolean {
  return name.endsWith(".md") && /[a-z]/.test(name.slice(0, -3));
}

/** The frontmatter block of a text, undefined when it does not open with one. */
function frontmatter(text: string): string | undefined {
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  return m?.[1];
}

function hasWhyMemory(content: string): boolean {
  const fm = frontmatter(content);
  return fm !== undefined && WHY_LINE.test(fm);
}

function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** `<CLAUDE_CONFIG_DIR or ~/.claude>/projects`, as the filesystem sees it. */
function projectsDir(env: NodeJS.ProcessEnv): string {
  const cfg = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude");
  return canon(path.join(cfg, "projects"));
}

/** The guard of new memory files: a place is the path itself. */
function memoryGuard(env: NodeJS.ProcessEnv): Guard<string> {
  const root = projectsDir(env);
  return {
    at(c) {
      if (!c.startsWith(root + path.sep)) return undefined;
      // <project>/memory/<file...>
      const [project, dir, ...rest] = c.slice(root.length + 1).split(path.sep);
      if (!project || dir !== "memory" || rest.length === 0) return undefined;
      if (!isTopicFile(rest[rest.length - 1]) || exists(c)) return undefined;
      return c;
    },
    mentionedIn: () => undefined,
    // Removing a file creates nothing.
    skip: new Set(["rm", "unlink"]),
  };
}

/** The text a call that creates `file` leaves in it, undefined when the call creates nothing. */
function createdContent(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === "Write") return typeof input.content === "string" ? input.content : "";
  // An edit of a file that does not exist creates it only from an empty `old_string`.
  const edits =
    tool === "MultiEdit" && Array.isArray(input.edits)
      ? (input.edits as Record<string, unknown>[])
      : [input];
  let text: string | undefined;
  for (const e of edits) {
    const from = typeof e.old_string === "string" ? e.old_string : undefined;
    const to = typeof e.new_string === "string" ? e.new_string : "";
    if (text === undefined) {
      if (from !== "") return undefined;
      text = to;
    } else if (from) text = text.replace(from, () => to);
  }
  return text;
}

function reason(file: string, how: string): string {
  return [
    `a new memory file (${file}) has no placement reason. Memory is the last row of one table; the first row that fits wins:`,
    ...PLACEMENT_ROWS,
    `${how}. Never in memory: the status of work, anything a tool or workflow already enforces, a designed lint finding. An edit of an existing file is not gated.`,
  ].join("\n");
}

/**
 * `deny` / `ask` (the project's `memory_write_gate`) for a call that creates a memory file with no
 * `why-memory:` line; undefined for every other call and for a project that has not opted in.
 * Throws on a settings file that is not valid; the hook entry lets the call pass then.
 */
export function decideKnowledgeWrite(
  payload: KnowledgeWritePayload,
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeWriteDecision | undefined {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = payload.tool_input ?? {};
  const cwd = payload.cwd ?? process.cwd();
  const guard = memoryGuard(env);
  let file: string | undefined;
  let how: string;
  if (tool === "Bash") {
    if (typeof input.command !== "string") return undefined;
    file = commandPlace(input.command, cwd, env, guard);
    if (file === undefined || WHY_IN_COMMAND.test(input.command)) return undefined;
    how =
      "Write the file with the Write tool and a frontmatter line `why-memory: 7 <why no row 1-6 fits>` (or `why-memory: 6 <the map line naming memory as the owner-call home>`); a command carries the same line in its own text";
  } else {
    const key = TOOL_PATH[tool];
    const target = key === undefined ? undefined : input[key];
    if (typeof target !== "string") return undefined;
    file = placeOf(target, cwd, env, guard);
    if (file === undefined) return undefined;
    const content = createdContent(tool, input);
    if (content === undefined || hasWhyMemory(content)) return undefined;
    how =
      "Write it again with `why-memory: 7 <why no row 1-6 fits>` (or `why-memory: 6 <the map line naming memory as the owner-call home>`) in its frontmatter";
  }
  const mode = projectMemoryWriteGate(cwd);
  if (mode === undefined) return undefined;
  return { permissionDecision: mode, permissionDecisionReason: reason(file, how) };
}
