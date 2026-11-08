// The read-only gate: a Bash call made by a read-only agent type (workflow:recon, workflow:reviewer) is allowed
// only when every pipeline segment starts with a declared reader, and refused when it would write. It guards
// a reviewer / recon against ACCIDENTAL writes, not an adversary: shell parsing cannot close every path
// (out of scope, named in the README: a path-prefixed reader such as `./ls`, a flag injected by an
// inherited variable, a reader that is itself scripted). The guarantees are the type's tool list (no
// Edit/Write), the project's CLI read-only env, and this allow list. Pure but for `fs` in
// `findReadOnlyConfig`; `hooks/read-only-gate.sh` → `build/read-only-gate-hook.js` is the entry.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYaml, warnLeftoverJson } from "./yaml-config.js";
import { basename, commandOf, splitSegments, type Command } from "./pool-gate.js";

export const READ_ONLY_CONFIG = path.join(".claude", "read-only-commands.yaml");

/**
 * The agent types that are read-only when the project's config names none: plugin-qualified names, compared exactly.
 */
export const DEFAULT_READ_ONLY_AGENTS: readonly string[] = ["workflow:recon", "workflow:reviewer"];

export interface ReadOnlyConfig {
  /** Extra write commands: leading words (`apq patch`) or `/regex/flags` on the simple command's text. */
  readonly write: readonly string[];
  /** Extra readers beyond DEFAULT_READERS (same forms as `write`): the project's read-only CLIs (`hxq`, `apq`). */
  readonly read: readonly string[];
  /** Variables exported before the command of a read-only agent (`APQ_READ_ONLY=1`). */
  readonly env: Readonly<Record<string, string>>;
  readonly agents: readonly string[];
}

export type ReadOnlyDecision =
  | { readonly kind: "pass" }
  | { readonly kind: "deny"; readonly reason: string }
  /** Allowed: run `command` — the call itself unless a segment starts with a project `read` CLI, then with the project's env exported in front. */
  | { readonly kind: "env"; readonly command: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate a read-only-commands.yaml text; throws with the offending key named. */
export function parseReadOnlyConfig(text: string): ReadOnlyConfig {
  const raw = parseYaml(text);
  if (!isObject(raw))
    throw new Error("expected an object with `write` / `read` / `env` / `agents`");
  const { write = [], read = [], env = {}, agents } = raw;
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every(s => typeof s === "string" && s.trim() !== "");
  if (!strings(write)) throw new Error("`write` must be a list of non-empty strings");
  if (!strings(read)) throw new Error("`read` must be a list of non-empty strings");
  if (agents !== undefined && !strings(agents))
    throw new Error("`agents` must be a list of agent type names");
  if (
    !isObject(env) ||
    !Object.entries(env).every(
      ([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string",
    )
  )
    throw new Error("`env` must map variable names to string values");
  for (const w of [...write, ...read]) regexOf(w, true);
  return {
    write,
    read,
    env: env as Record<string, string>,
    agents: agents ?? DEFAULT_READ_ONLY_AGENTS,
  };
}

/** The nearest read-only-commands.yaml from `cwd` up to the git root; none outside a git repo. */
export function findReadOnlyConfig(cwd: string): ReadOnlyConfig | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = path.join(dir, READ_ONLY_CONFIG);
    warnLeftoverJson(file);
    if (fs.existsSync(file)) {
      try {
        return parseReadOnlyConfig(fs.readFileSync(file, "utf8"));
      } catch (err) {
        throw new Error(`${file}: ${(err as Error).message}`);
      }
    }
    if (fs.existsSync(path.join(dir, ".git")) || path.dirname(dir) === dir) return undefined;
  }
}

/** Is this payload `agent_type` exactly one of the read-only types? No prefix is dropped: `reviewer` and `other:reviewer` are not `workflow:reviewer`. */
export function isReadOnlyAgent(
  agentType: unknown,
  agents: readonly string[] = DEFAULT_READ_ONLY_AGENTS,
): boolean {
  if (typeof agentType !== "string" || agentType === "") return false;
  return agents.includes(agentType);
}

function regexOf(pattern: string, strict = false): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(pattern);
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2]);
  } catch (err) {
    if (strict) throw new Error(`invalid regex ${pattern}: ${(err as Error).message}`);
    return null;
  }
}

/** Git subcommands that change the tree, the index, refs or the history. */
const GIT_WRITES = new Set([
  "add",
  "am",
  "apply",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "fetch",
  "gc",
  "merge",
  "mv",
  "notes",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "update-ref",
  "worktree",
]);
/** Subcommands that only read when every argument is one of these listing flags (config also reads one key operand). */
const GIT_LISTING: Readonly<Record<string, RegExp>> = {
  branch:
    /^(-l|--list|-a|--all|-r|--remotes|-v|-vv|--verbose|--show-current|--merged|--no-merged|--contains|--no-contains|--sort=.*|--format=.*)$/,
  tag: /^(-l|--list|-n\d*|--sort=.*|--format=.*|--contains|--no-contains|--merged|--no-merged)$/,
  config:
    /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--local|--global|--system|--null|-z|--name-only)$/,
};

/** Commands that write whatever their arguments. */
const FILE_WRITERS = new Set([
  "rm",
  "mv",
  "cp",
  "mkdir",
  "rmdir",
  "touch",
  "tee",
  "truncate",
  "ln",
  "install",
  "chmod",
  "dd",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SCRATCH = [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

/** The git subcommand, past the global options that take a value. */
function gitSub(cmd: Command): string | undefined {
  const w = cmd.words.map(x => x.value);
  if (basename(w[0] ?? "") !== "git") return undefined;
  for (let k = 1; k < w.length; k++) {
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(w[k])) k++;
    else if (!w[k].startsWith("-")) return w[k];
  }
  return undefined;
}

function matchesWrite(rule: string, cmd: Command): boolean {
  if (cmd.words.length === 0) return false;
  const re = regexOf(rule);
  if (re) return re.test(cmd.words.map(w => w.value).join(" "));
  const want = rule.trim().split(/\s+/);
  if (want.length > cmd.words.length) return false;
  return want.every(
    (p, k) =>
      cmd.words[k].value === p ||
      (k === 0 && !p.includes("/") && basename(cmd.words[0].value) === p),
  );
}

/** Commands that run their arguments as a command: the writer behind them is judged, not the wrapper. */
const WRAPPERS = new Set([
  "rtk",
  "env",
  "xargs",
  "command",
  "nice",
  "nohup",
  "time",
  "sudo",
  "exec",
  "timeout",
]);

/** The command a wrapper runs: `rtk proxy git commit` → `git commit`; wrapper options (`-n 5`) are skipped. */
function unwrap(cmd: Command): Command | undefined {
  const w = cmd.words;
  let k = 0;
  while (k < w.length && WRAPPERS.has(basename(w[k].value))) {
    k++;
    if (basename(w[k - 1].value) === "rtk" && w[k]?.value === "proxy") k++;
    // Options of the wrapper (and the value of nice -n / xargs -n) before the real command.
    while (
      k < w.length &&
      (w[k].value.startsWith("-") ||
        /^\d+$/.test(w[k].value) ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[k].value))
    )
      k++;
  }
  return k > 0 && k < w.length ? { words: w.slice(k), env: cmd.env } : undefined;
}

/** Why this simple command writes, or undefined. */
function writeReason(
  cmd: Command,
  config: ReadOnlyConfig | undefined,
  depth: number,
): string | undefined {
  const inner = depth < 5 ? unwrap(cmd) : undefined;
  if (inner) {
    const r = writeReason(inner, config, depth + 1);
    if (r) return r;
  }
  const name = cmd.words[0] ? basename(cmd.words[0].value) : "";
  const sub = gitSub(cmd);
  if (sub !== undefined && GIT_WRITES.has(sub)) return `git ${sub} writes`;
  if (sub !== undefined && sub in GIT_LISTING) {
    const rest = cmd.words.map(w => w.value).slice(cmd.words.findIndex(w => w.value === sub) + 1);
    // `git config --get a.b` reads its key operand; branch/tag read only without any operand.
    const operands = rest.filter(a => !GIT_LISTING[sub].test(a));
    const readsKey =
      sub === "config" && rest.some(a => /^(--get|--get-all|--get-regexp|--list|-l)$/.test(a));
    if (operands.length > 0 && !(readsKey && !operands.some(a => a.startsWith("-"))))
      return `git ${sub} with arguments writes`;
    if (sub === "config" && !readsKey) return "git config without --get/--list writes";
  }
  if (FILE_WRITERS.has(name)) return `${name} writes files`;
  if (
    name === "sed" &&
    cmd.words.some(w => /^-[A-Za-z]*i/.test(w.value) || w.value.startsWith("--in-place"))
  )
    return "sed -i edits in place";
  for (const rule of config?.write ?? [])
    if (matchesWrite(rule, cmd)) return `${rule.trim()} writes`;
  if (SHELLS.has(name) && depth < 3) {
    const c = cmd.words.findIndex(w => /^-[A-Za-z]*c$/.test(w.value));
    const inner = c >= 0 ? cmd.words[c + 1]?.value : undefined;
    if (inner !== undefined) return commandReason(inner, config, depth + 1);
  }
  return undefined;
}

/** Commands a read-only agent may start a pipeline segment with; `git` is judged by subcommand, `find` by flags. */
export const DEFAULT_READERS: readonly string[] = [
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "jq",
  "cd",
  "pwd",
  "echo",
  "printf",
  "stat",
  "file",
  "sort",
  "uniq",
  "cut",
  "tr",
  "basename",
  "dirname",
  "diff",
  "cmp",
  "which",
  "realpath",
  "readlink",
  "du",
  "date",
  "nl",
  "tac",
  "column",
  "test",
  "[",
  "true",
  "false",
  "find",
  "git",
  "sed",
];
const GIT_READERS = new Set([
  "log",
  "show",
  "diff",
  "status",
  "grep",
  "blame",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "rev-list",
  "cat-file",
  "describe",
  "shortlog",
  "show-ref",
  "merge-base",
  "name-rev",
  "for-each-ref",
  "branch",
  "tag",
  "config",
]);
const FLAG_JUDGED = new Set(["find", "git", "sort", "rg", "uniq", "sed"]);
/** `sed -n` with a print-only script: addresses or ranges and `p`, nothing that writes or runs. */
function sedReadsOnly(args: readonly string[]): boolean {
  if (args[0] !== "-n") return false;
  const script = args[1];
  if (script === undefined || !/^(\d+|\$)(,(\d+|\$))?p$|^\/[^/]*\/p$/.test(script)) return false;
  return args.slice(2).every(a => !a.startsWith("-") || a === "-");
}
const FIND_WRITES = /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/;

/** Does a segment of `command` start with a project `read` CLI — the only readers that read the exported env? */
function startsWithProjectReader(command: string, config: ReadOnlyConfig | undefined): boolean {
  const rules = config?.read ?? [];
  if (rules.length === 0) return false;
  for (const seg of splitSegments(command) ?? []) {
    let c = commandOf(seg);
    for (let d = 0; d < 5; d++) {
      const inner = unwrap(c);
      if (!inner) break;
      c = inner;
    }
    if (rules.some(rule => matchesWrite(rule, c))) return true;
  }
  return false;
}

/** Why this segment's command is not a declared reader, or undefined. */
function readerReason(cmd: Command, config: ReadOnlyConfig | undefined): string | undefined {
  let c = cmd;
  let viaXargs = false;
  if (c.env.size > 0) return "a NAME=value assignment can redirect a reader (GIT_*, PAGER, LD_*)";
  for (let d = 0; d < 5; d++) {
    const inner = unwrap(c);
    if (!inner) break;
    const skipped = c.words.slice(0, c.words.length - inner.words.length).map(w => w.value);
    if (skipped.some(v => /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)))
      return "a NAME=value assignment can redirect a reader (GIT_*, PAGER, LD_*)";
    if (skipped.some(v => basename(v) === "xargs")) viaXargs = true;
    c = inner;
  }
  if (c.words.length === 0) return undefined;
  if (c.words[0].value.includes("$"))
    return "a variable in the command word cannot be verified (`$D/ls` runs whatever D names)";
  const name = basename(c.words[0].value);
  const args = c.words.slice(1).map(w => w.value);
  if ((config?.read ?? []).some(rule => matchesWrite(rule, c))) return undefined;
  if (!DEFAULT_READERS.includes(name))
    return `${name} is not a declared reader (the project's .claude/read-only-commands.yaml \`read\` adds one)`;
  if (viaXargs && FLAG_JUDGED.has(name))
    return `xargs ${name}: its arguments come from stdin and cannot be judged`;
  if (name === "git") {
    const sub = gitSub(c);
    if (sub === undefined || !GIT_READERS.has(sub))
      return `git ${sub ?? ""} is not a reader`.replace("  ", " ");
    if (
      args.some(
        a =>
          a === "-c" ||
          a.startsWith("--config-env") ||
          a.startsWith("--output") ||
          /^-[A-Za-z]*O/.test(a) ||
          a.startsWith("--open-files-in-pager"),
      )
    )
      return "git option that runs a command or writes a file";
  }
  if (name === "find" && args.some(a => FIND_WRITES.test(a)))
    return "find with an action writes or runs a command";
  if (
    name === "sort" &&
    args.some(
      a => /^-[A-Za-z]*o/.test(a) || a.startsWith("--output") || a.startsWith("--compress-program"),
    )
  )
    return "sort -o / --compress-program writes or runs a command";
  if (name === "uniq") {
    const dd = args.indexOf("--");
    const operands = args.filter(
      (a, k) => (dd >= 0 && k > dd) || (k !== dd && (a === "-" || !a.startsWith("-"))),
    );
    if (operands.length > 1) return "uniq with an output operand writes";
  }
  if (name === "file" && args.some(a => /^-[A-Za-z]*C/.test(a) || a.startsWith("--compile")))
    return "file -C writes a magic file";
  if (name === "sed" && !sedReadsOnly(args))
    return "sed is allowed only as `sed -n '<addresses>p' [file]`";
  if (name === "rg" && args.some(a => a.startsWith("--pre"))) return "rg --pre runs a command";
  if (name === "printf" && args[0]?.startsWith("-v"))
    return "printf -v assigns a variable (a later redirect or command word could read it)";
  return undefined;
}

/** `$( )`, backticks and process substitution outside single quotes: a command the gate cannot judge. */
function hasSubstitution(command: string): boolean {
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = "";
    } else if (c === "\\") i++;
    else if (c === "`" || ((c === "$" || c === "<" || c === ">") && command[i + 1] === "("))
      return true;
    else if (quote === '"') {
      if (c === '"') quote = "";
    } else if (c === "'" || c === '"') quote = c;
  }
  return false;
}

/** An unquoted `{a,b}` / `{1..3}`: brace expansion builds words the flag checks never saw (`sed -n 1p {-i,f}`). */
function hasBraceExpansion(command: string): boolean {
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"') i++;
    } else if (c === "\\") i++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === "{" && command[i - 1] !== "$") {
      const close = command.indexOf("}", i + 1);
      if (close > 0 && /,|\.\./.test(command.slice(i + 1, close))) return true;
    }
  }
  return false;
}

/** Is `target` inside a git work tree (a `.git` entry in an ancestor below the scratch root)? */
function insideWorkTree(target: string): boolean {
  for (let dir = path.dirname(target); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (SCRATCH.includes(dir)) return false;
    if (fs.existsSync(path.join(dir, ".git"))) return true;
  }
  return false;
}

/** A redirect of the text into a file outside scratch space; quotes and `>&N` / `/dev/*` targets are not one. */
export function redirectsToFile(command: string): string | undefined {
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"') i++;
      continue;
    }
    if (c === "\\") i++;
    else if (c === "'" || c === '"') quote = c;
    else if (c === "<" && command[i + 1] === ">") return "redirect <> opens a file for writing";
    else if (c === ">") {
      let j = i + 1;
      if (command[j] === ">" || command[j] === "|") j++;
      // `>&2` / `>&-` duplicate or close a descriptor; `>&file` writes the file.
      if (command[j] === "&") {
        j++;
        if (/[0-9-]/.test(command[j] ?? "")) {
          i = j;
          continue;
        }
      }
      while (command[j] === " " || command[j] === "\t") j++;
      const m = /^[^\s;&|()<>]+/.exec(command.slice(j));
      const raw = (m?.[0] ?? "").replace(/^["']|["']$/g, "");
      if (/[$*?[{~`]/.test(raw)) return `redirect > ${raw} has a variable or glob target`;
      const target = raw.startsWith("/") ? path.posix.normalize(raw) : raw;
      i = j;
      if (
        target === "" ||
        target.startsWith("/dev/") ||
        (!raw.split("/").includes("..") &&
          SCRATCH.some(s => target === s || target.startsWith(s + "/")) &&
          !insideWorkTree(target))
      )
        continue;
      return `redirect > ${target} writes`;
    }
  }
  return undefined;
}

function commandReason(
  command: string,
  config: ReadOnlyConfig | undefined,
  depth: number,
): string | undefined {
  const segments = splitSegments(command);
  if (!segments)
    return "cannot verify this command is read-only (heredoc or unbalanced quote) — keep it simple";
  const redirect = redirectsToFile(command);
  if (redirect) return redirect;
  if (hasSubstitution(command))
    return "command substitution ($( ), backticks) cannot be verified read-only";
  if (hasBraceExpansion(command))
    return "brace expansion ({a,b}, {1..3}) builds words that cannot be verified read-only";
  for (const seg of segments) {
    const cmd = commandOf(seg);
    const reason = writeReason(cmd, config, depth) ?? readerReason(cmd, config);
    if (reason) return reason;
  }
  return undefined;
}

/** Defaults that read no file at all, whatever their arguments. */
const NO_FILE_READERS = new Set([
  "cd",
  "pwd",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  "date",
  "basename",
  "dirname",
]);
/** Pipe filters that read only stdin when no file operand is given (grep's one operand is its pattern). */
const STDIN_FILTERS = new Map<string, number>([
  ["head", 0],
  ["tail", 0],
  ["wc", 0],
  ["sort", 0],
  ["uniq", 0],
  ["cut", 0],
  ["rg", 1],
  ["nl", 0],
  ["tac", 0],
  ["tr", Infinity],
  ["grep", 1],
  ["egrep", 1],
  ["fgrep", 1],
]);

function isHarmlessDefault(cmd: Command, afterPipe: boolean): boolean {
  const name = basename(cmd.words[0]?.value ?? "");
  if (NO_FILE_READERS.has(name)) return true;
  const operands = STDIN_FILTERS.get(name);
  if (!afterPipe || operands === undefined) return false;
  const args = cmd.words.slice(1).map(w => w.value);
  if (args.some(a => a.startsWith("--files0-from"))) return false;
  const searcher = name.endsWith("grep") || name === "rg";
  if (searcher && args.some(a => /^-[A-Za-z]*[rRf]|^--(file|recursive|dereference|pre)/.test(a)))
    return false;
  // A numeric word is an option value (`head -n 5`) for a filter, but may be a grep pattern.
  const isOperand = (a: string): boolean =>
    !a.startsWith("-") && (searcher || !/^[+-]?\d+$/.test(a));
  return args.filter(isOperand).length <= operands;
}

/**
 * The first segment of this ALLOWED call that is not a project `read` CLI, a default that reads no
 * file, or a stdin filter behind a pipe without a file operand (xargs looked through = unjudged);
 * undefined when every segment is one. The rewrite of a call (env export, pool wrap) is only emitted
 * with `permissionDecision: "allow"`, which skips the permission system for the WHOLE call, so a
 * file-reading default riding on a project reader (`hxq lint a.hx; cat ~/.ssh/key`) is not one.
 */
export function unharmlessSegment(
  command: string,
  config: ReadOnlyConfig | undefined,
): string | undefined {
  const segments = splitSegments(command);
  if (!segments) return command;
  for (const [k, seg] of segments.entries()) {
    let c = commandOf(seg);
    let viaXargs = false;
    for (let d = 0; d < 5; d++) {
      const inner = unwrap(c);
      if (!inner) break;
      if (
        c.words
          .slice(0, c.words.length - inner.words.length)
          .some(w => basename(w.value) === "xargs")
      )
        viaXargs = true;
      c = inner;
    }
    if (c.words.length === 0) continue;
    const text = c.words
      .slice(0, 3)
      .map(w => w.value)
      .join(" ");
    if (viaXargs) return `xargs ${text}`;
    if ((config?.read ?? []).some(rule => matchesWrite(rule, c))) continue;
    const afterPipe = k > 0 && (segments[k - 1].op === "|" || segments[k - 1].op === "|&");
    if (!isHarmlessDefault(c, afterPipe)) return text;
  }
  return undefined;
}

/** May the rewrite of this allowed call carry `permissionDecision: "allow"`? See `unharmlessSegment`. */
export function rewriteIsHarmless(command: string, config: ReadOnlyConfig | undefined): boolean {
  return unharmlessSegment(command, config) === undefined;
}

export interface ReadOnlyPayload {
  readonly agent_type?: unknown;
  readonly tool_name?: string;
  readonly tool_input?: { readonly command?: unknown; readonly file_path?: unknown };
}

/**
 * Why a Write by a read-only agent is refused, undefined when allowed. The one write a read-only
 * agent keeps is its report: an absolute path in scratch space, outside any git work tree, with a
 * `<name>.log` or `<name>-logs` directory in it (the task's report directory), and no `..`.
 */
export function writeToolReason(filePath: unknown): string | undefined {
  if (typeof filePath !== "string" || !filePath.startsWith("/"))
    return "Write needs an absolute file_path";
  const target = path.posix.normalize(filePath);
  const dirs = target.split("/").slice(0, -1);
  if (filePath.split("/").includes("..")) return `Write ${filePath} has a .. segment`;
  if (!SCRATCH.some(s => target.startsWith(s + "/")) || insideWorkTree(target))
    return `Write ${target} is outside the report directories (scratch space, not in a git work tree)`;
  if (!dirs.some(d => d.endsWith(".log") || d.endsWith("-logs")))
    return `Write ${target} is not in a <task>.log or <task>-logs directory`;
  return undefined;
}

/**
 * The decision for one PreToolUse(Bash) payload. Only a call made by a read-only agent type is
 * touched (the main session and every other subagent pass): a write is denied, else the call is
 * allowed UNCHANGED, except that the env is exported in front of a command that starts a segment
 * with a project reader; the hook allows that rewrite only for a call `unharmlessSegment` clears,
 * and denies the rest (auto mode refuses a rewritten call that is not allowed).
 */
export function decideReadOnly(
  payload: ReadOnlyPayload,
  config: ReadOnlyConfig | undefined,
): ReadOnlyDecision {
  if (payload.tool_name === "Write" && isReadOnlyAgent(payload.agent_type, config?.agents)) {
    const why = writeToolReason(payload.tool_input?.file_path);
    return why === undefined
      ? { kind: "pass" }
      : { kind: "deny", reason: `read-only: ${why}; this agent type writes only its report` };
  }
  const command = payload.tool_input?.command;
  if (payload.tool_name !== "Bash" || typeof command !== "string") return { kind: "pass" };
  if (!isReadOnlyAgent(payload.agent_type, config?.agents)) return { kind: "pass" };
  const reason = commandReason(command, config, 0);
  if (reason !== undefined)
    return {
      kind: "deny",
      reason: `read-only: ${reason}; this agent type does not edit`,
    };
  const env = Object.entries(config?.env ?? {});
  if (env.length === 0 || !startsWithProjectReader(command, config))
    return { kind: "env", command };
  const exports = env.map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`).join(" ");
  return { kind: "env", command: `export ${exports}; ${command}` };
}
