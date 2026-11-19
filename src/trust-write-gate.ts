// The PreToolUse guard of exec consent: an agent's write to the trust record or into the global
// workflows directory is answered `ask`, so the user confirms it. Exec consent protects against a
// workflow that ARRIVES with a project the user has not trusted; both places are read by the engine
// as the user's own say, so a write there by an agent is a question to the user (Claude Code's
// permissions rule the rest of what an agent may do). The guard only decides: it never rewrites a
// call (`updatedInput` of one PreToolUse hook breaks the others).
//
// A speed bump for a confused agent, not a sandbox. Caught: Write / Edit / MultiEdit / NotebookEdit
// with a path on either place; in a Bash command, a redirect onto it (spaced or glued to a word),
// `cp` / `install` / `ln` / `rsync` with it as the destination (or `-t`), `mv` / `rm` / `unlink` /
// `tee` / `touch` / `truncate` / `dd of=` / `sed -i` / `perl -i` with it as any operand (also behind
// `then`, `do`, `!`, `{`), an interpreter's call (`node -e`, `python -c`, `awk` …) that names it,
// even when it only reads, the body of `sh -c`, and a relative path after a `cd` / `pushd` to a
// literal directory. A heredoc body counts only when a shell or an interpreter reads it. Not
// caught: a path built at run time (a variable the hook cannot see, a glob, a substitution, a split
// string, a `cd` to such a path), a write by a program the command only starts (`make`, a script
// file's own code), a move or removal of a parent directory, and the engine's own writes (the
// server, `wf-trust`, `wf-skills`: no tool call).
import fs from "node:fs";
import path from "node:path";
import { basename, splitSegments, type Segment } from "./pool-gate.js";
import { TRUST_FILE } from "./trust.js";
import { stateDir, workflowDirs } from "./workflow-dirs.js";

export interface TrustWritePayload {
  readonly tool_name?: unknown;
  readonly tool_input?: Record<string, unknown>;
  readonly cwd?: string;
}

export interface TrustWriteDecision {
  readonly permissionDecision: "ask";
  readonly permissionDecisionReason: string;
}

interface Guarded {
  readonly trust: string;
  readonly global: string;
}

type Place = "trust" | "global";

const TOOL_PATH: Readonly<Record<string, string>> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/** Commands whose last operand (or `-t` target) is the one they write. */
const DESTINATION_WRITERS = new Set(["cp", "install", "ln", "rsync"]);
/** Commands that write, move or remove each file operand. */
const OPERAND_WRITERS = new Set(["mv", "rm", "unlink", "tee", "touch", "truncate", "ed", "patch"]);
/** Editors that write in place with `-i` / `--in-place`. */
const IN_PLACE = new Set(["sed", "perl", "ruby", "gsed"]);
/** Interpreters whose code can write anywhere: a call that names a guarded path is asked. */
const INTERPRETERS = new Set([
  "node",
  "nodejs",
  "deno",
  "bun",
  "python",
  "python3",
  "ruby",
  "perl",
  "php",
  "osascript",
  "awk",
  "gawk",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "exec",
  "nohup",
  "time",
  "nice",
  "timeout",
  "rtk",
]);

/** The path as the filesystem sees it: absolute, with the nearest existing ancestor's symlinks resolved. */
function canon(p: string): string {
  const abs = path.resolve(p);
  let head = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...rest);
    } catch {
      const up = path.dirname(head);
      if (up === head) return abs;
      rest.unshift(path.basename(head));
      head = up;
    }
  }
}

/** `~`, `$HOME`, `${NAME}` and `$NAME` of a shell word that the environment answers; the rest stays as written. */
function expand(word: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME ?? "";
  const w = home && /^~(?=\/|$)/.test(word) ? home + word.slice(1) : word;
  return w.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a: string | undefined, b: string | undefined) => {
    const v = env[a ?? b ?? ""];
    return v === undefined ? m : v;
  });
}

function placeOf(raw: string, cwd: string, env: NodeJS.ProcessEnv, g: Guarded): Place | undefined {
  if (raw === "" || raw.startsWith("-")) return undefined;
  const c = canon(path.resolve(cwd, expand(raw, env)));
  if (c === g.trust) return "trust";
  if (c === g.global || c.startsWith(g.global + path.sep)) return "global";
  return undefined;
}

/** Whether a piece of code or text names a guarded path, spelled out (an interpreter's `-e` body, an unparsed command). */
function mentions(
  text: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  g: Guarded,
): Place | undefined {
  const expanded = expand(text, env);
  if (expanded.includes(TRUST_FILE)) return "trust";
  for (const dir of [g.global, path.resolve(cwd, g.global)])
    if (expanded.includes(dir)) return "global";
  for (const m of expanded.matchAll(/[^\s'"`;|&<>()=]+/g)) {
    const p = placeOf(m[0], cwd, env, g);
    if (p) return p;
  }
  return undefined;
}

/**
 * A segment's words without its redirects: `echo hi>f` is `echo hi` writing `f`, `tee<in f` is `tee f`.
 * A redirect glued to a word is read as one; a quote the splitter removed cannot be told apart, which
 * only matters when the text after the `>` is a guarded path.
 */
function splitRedirects(values: readonly string[]): { words: string[]; targets: string[] } {
  const words: string[] = [];
  const targets: string[] = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const at = v.search(/[<>]/);
    // A word with whitespace is a quoted argument (`sh -c 'a > b'`), not a redirect.
    if (at < 0 || /\s/.test(v)) {
      words.push(v);
      continue;
    }
    const head = v.slice(0, at);
    if (head !== "" && head !== "&" && !/^\d+$/.test(head)) words.push(head);
    const tail = v.slice(at);
    if (tail.startsWith(">")) {
      let rest = tail.replace(/^>(?:>|\|)?/, "");
      // `>&2` / `>&-` duplicate or close a descriptor; `>&file` writes the file.
      if (rest.startsWith("&")) {
        rest = rest.slice(1);
        if (/^(?:\d+-?|-)$/.test(rest)) continue;
      }
      if (rest !== "") targets.push(rest);
      else if (i + 1 < values.length) targets.push(values[++i]);
    } else if (/^<+&?$/.test(tail) && i + 1 < values.length) i++;
  }
  return { words, targets };
}

/** Words that open a command without being one: `then cp …`, `! cp …`, `{ cp …; }`. */
const KEYWORDS = new Set([
  "then",
  "do",
  "else",
  "elif",
  "if",
  "while",
  "until",
  "!",
  "{",
  "time",
  "coproc",
]);

interface SegmentVerdict {
  readonly place?: Place;
  /** The directory the following segments run in: a `cd` / `pushd` moves it. */
  readonly cwd: string;
  readonly name: string;
}

function segmentPlace(
  seg: Segment,
  cwd: string,
  env: NodeJS.ProcessEnv,
  g: Guarded,
): SegmentVerdict {
  const values = seg.words.map(w => w.value);
  const { words, targets } = splitRedirects(values);
  const stay = (name: string, place?: Place): SegmentVerdict => ({ place, cwd, name });
  // A redirect writes whatever the command is.
  for (const t of targets) {
    const p = placeOf(t, cwd, env, g);
    if (p) return stay("", p);
  }
  let k = 0;
  for (; k < words.length; k++) {
    const v = words[k];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v) || KEYWORDS.has(v)) continue;
    if (!WRAPPERS.has(basename(v))) break;
    while (k + 1 < words.length && /^(-|\d+$|[A-Za-z_]\w*=)/.test(words[k + 1])) k++;
    if (basename(v) === "rtk" && words[k + 1] === "proxy") k++;
  }
  const name = basename(words[k] ?? "");
  const args = words.slice(k + 1);
  const operands = args.filter(a => !a.startsWith("-"));
  const firstPlace = (list: readonly string[]): SegmentVerdict => {
    for (const a of list) {
      const p = placeOf(a, cwd, env, g);
      if (p) return stay(name, p);
    }
    return stay(name);
  };
  if (name === "cd" || name === "pushd") {
    const to = operands[0] ?? env.HOME;
    return {
      cwd: to === undefined || to === "-" ? cwd : path.resolve(cwd, expand(to, env)),
      name,
    };
  }
  if (DESTINATION_WRITERS.has(name)) {
    const t = args.findIndex(a => a === "-t" || a === "--target-directory");
    const target = t >= 0 ? args[t + 1] : operands[operands.length - 1];
    return target === undefined ? stay(name) : stay(name, placeOf(target, cwd, env, g));
  }
  if (OPERAND_WRITERS.has(name)) return firstPlace(operands);
  if (name === "dd") return firstPlace(args.filter(a => a.startsWith("of=")).map(a => a.slice(3)));
  if (IN_PLACE.has(name) && args.some(a => a === "--in-place" || /^-[A-Za-z]*i/.test(a)))
    return firstPlace(operands);
  if (SHELLS.has(name)) {
    const c = args.findIndex(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
    return c >= 0 && args[c + 1] !== undefined
      ? stay(name, commandPlace(args[c + 1], cwd, env, g))
      : stay(name);
  }
  if (INTERPRETERS.has(name)) {
    // The raw words: a `>` inside inline code is not a redirect of the command.
    for (const a of values) {
      const p = mentions(a, cwd, env, g);
      if (p) return stay(name, p);
    }
  }
  return stay(name);
}

/** The heredoc bodies of a command, and the command without them (`cat <<EOF > f` → `cat  > f`). */
function stripHeredocs(command: string): { plain: string; bodies: string[] } {
  if (!command.includes("<<")) return { plain: command, bodies: [] };
  const lines = command.split("\n");
  const out: string[] = [];
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const terminators: string[] = [];
    out.push(
      lines[i].replace(
        /(?<!<)<<(?!<)-?\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z_]\w*))/g,
        (_m, a: string | undefined, b: string | undefined, c: string | undefined) => {
          terminators.push(a ?? b ?? c ?? "");
          return "";
        },
      ),
    );
    for (const t of terminators) {
      const body: string[] = [];
      while (i + 1 < lines.length) {
        i++;
        if (lines[i].trim() === t) break;
        body.push(lines[i]);
      }
      bodies.push(body.join("\n"));
    }
  }
  return { plain: out.join("\n"), bodies };
}

function commandPlace(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  g: Guarded,
): Place | undefined {
  const { plain, bodies } = stripHeredocs(command);
  const segments = splitSegments(plain);
  // An unterminated quote: the shape is not plain enough to read, so any mention asks.
  if (segments === undefined) return mentions(command, cwd, env, g);
  let dir = cwd;
  const fed: string[] = [];
  for (const seg of segments) {
    const v = segmentPlace(seg, dir, env, g);
    if (v.place) return v.place;
    dir = v.cwd;
    if (SHELLS.has(v.name) || INTERPRETERS.has(v.name)) fed.push(v.name);
  }
  // A heredoc is text for the command that reads it: only a shell or an interpreter acts on its body.
  for (const name of fed)
    for (const body of bodies) {
      const p = SHELLS.has(name) ? commandPlace(body, dir, env, g) : mentions(body, dir, env, g);
      if (p) return p;
    }
  return undefined;
}

/** The two places the guard covers, resolved by the engine's own resolvers (`STATE_DIR`, `WORKFLOW_DIR`). */
export function guardedPlaces(env: NodeJS.ProcessEnv, cwd: string): Guarded {
  return {
    trust: canon(path.join(stateDir(env), TRUST_FILE)),
    global: canon(workflowDirs(env, cwd).global),
  };
}

const REASON: Readonly<Record<Place, (file: string) => string>> = {
  trust: file =>
    `an agent's write to ${file}, the record exec consent rests on (\`wf-trust\` maintains it); confirm only if you asked for it, and approve a project yourself with \`wf-trust\` in a terminal`,
  global: file =>
    `an agent's write into the global workflows directory (${file}): a workflow there runs its exec states without a consent step; confirm only if you asked for it`,
};

/** `ask` for a call that writes a guarded place, undefined for every other call (a read included). */
export function decideTrustWrite(
  payload: TrustWritePayload,
  env: NodeJS.ProcessEnv = process.env,
): TrustWriteDecision | undefined {
  const tool = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const input = payload.tool_input ?? {};
  const cwd = payload.cwd ?? process.cwd();
  const g = guardedPlaces(env, cwd);
  let place: Place | undefined;
  let shown = "";
  if (tool === "Bash") {
    if (typeof input.command !== "string") return undefined;
    place = commandPlace(input.command, cwd, env, g);
  } else {
    const key = TOOL_PATH[tool];
    const target = key === undefined ? undefined : input[key];
    if (typeof target !== "string") return undefined;
    place = placeOf(target, cwd, env, g);
    shown = target;
  }
  if (!place) return undefined;
  const file = place === "trust" ? g.trust : shown !== "" ? shown : g.global;
  return {
    permissionDecision: "ask",
    permissionDecisionReason: REASON[place](file),
  };
}
