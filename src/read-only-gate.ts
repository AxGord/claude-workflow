// The read-only gate: a Bash call made by a read-only agent type (wf-recon, wf-reviewer) is refused
// when it would write. Read-only holds by two layers — the type's tool list has no Edit/Write, and
// this decision covers the Bash a project edits through (a CLI's write ops, git, redirects). Pure but
// for `fs` in `findReadOnlyConfig`; `hooks/read-only-gate.sh` → `build/read-only-gate-hook.js` is the entry.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { basename, commandOf, splitSegments, type Command } from "./pool-gate.js";

export const READ_ONLY_CONFIG = path.join(".claude", "read-only-commands.json");

/** The agent types that are read-only when the project's config names none (bare names; a plugin-qualified `workflow:wf-recon` matches too). */
export const DEFAULT_READ_ONLY_AGENTS: readonly string[] = ["wf-recon", "wf-reviewer"];

export interface ReadOnlyConfig {
  /** Extra write commands: leading words (`apq patch`) or `/regex/flags` on the simple command's text. */
  readonly write: readonly string[];
  /** Variables exported before the command of a read-only agent (`APQ_READ_ONLY=1`). */
  readonly env: Readonly<Record<string, string>>;
  readonly agents: readonly string[];
}

export type ReadOnlyDecision =
  | { readonly kind: "pass" }
  | { readonly kind: "deny"; readonly reason: string }
  /** Allowed: run `command` (the env exported in front of it, when the project names any). */
  | { readonly kind: "env"; readonly command: string };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate a read-only-commands.json text; throws with the offending key named. */
export function parseReadOnlyConfig(text: string): ReadOnlyConfig {
  const raw = JSON.parse(text) as unknown;
  if (!isObject(raw)) throw new Error("expected an object with `write` / `env` / `agents`");
  const { write = [], env = {}, agents } = raw;
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every(s => typeof s === "string" && s.trim() !== "");
  if (!strings(write)) throw new Error("`write` must be a list of non-empty strings");
  if (agents !== undefined && !strings(agents))
    throw new Error("`agents` must be a list of agent type names");
  if (
    !isObject(env) ||
    !Object.entries(env).every(
      ([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === "string",
    )
  )
    throw new Error("`env` must map variable names to string values");
  for (const w of write) regexOf(w, true);
  return { write, env: env as Record<string, string>, agents: agents ?? DEFAULT_READ_ONLY_AGENTS };
}

/** The nearest read-only-commands.json from `cwd` up to the git root; none outside a git repo. */
export function findReadOnlyConfig(cwd: string): ReadOnlyConfig | undefined {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const file = path.join(dir, READ_ONLY_CONFIG);
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

/** Is this payload `agent_type` one of the read-only types? A plugin prefix (`workflow:`) is ignored. */
export function isReadOnlyAgent(
  agentType: unknown,
  agents: readonly string[] = DEFAULT_READ_ONLY_AGENTS,
): boolean {
  if (typeof agentType !== "string" || agentType === "") return false;
  const bare = agentType.slice(agentType.lastIndexOf(":") + 1);
  return agents.includes(agentType) || agents.includes(bare);
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
    else if (c === ">") {
      let j = i + 1;
      if (command[j] === ">" || command[j] === "|") j++;
      if (command[j] === "&") {
        i = j;
        continue;
      }
      while (command[j] === " " || command[j] === "\t") j++;
      const m = /^[^\s;&|()<>]+/.exec(command.slice(j));
      const target = (m?.[0] ?? "").replace(/^["']|["']$/g, "");
      i = j;
      if (
        target === "" ||
        target.startsWith("/dev/") ||
        SCRATCH.some(s => target === s || target.startsWith(s + "/"))
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
  for (const seg of segments) {
    const reason = writeReason(commandOf(seg), config, depth);
    if (reason) return reason;
  }
  return undefined;
}

export interface ReadOnlyPayload {
  readonly agent_type?: unknown;
  readonly tool_name?: string;
  readonly tool_input?: { readonly command?: unknown };
}

/**
 * The decision for one PreToolUse(Bash) payload. Only a call made by a read-only agent type is
 * touched (the main session and every other subagent pass): a write is denied, else the
 * project's read-only env is exported in front of the command.
 */
export function decideReadOnly(
  payload: ReadOnlyPayload,
  config: ReadOnlyConfig | undefined,
): ReadOnlyDecision {
  const command = payload.tool_input?.command;
  if (payload.tool_name !== "Bash" || typeof command !== "string") return { kind: "pass" };
  if (!isReadOnlyAgent(payload.agent_type, config?.agents)) return { kind: "pass" };
  const reason = commandReason(command, config, 0);
  if (reason !== undefined)
    return { kind: "deny", reason: `read-only: ${reason}; this agent type does not edit` };
  const env = Object.entries(config?.env ?? {});
  if (env.length === 0) return { kind: "env", command };
  const exports = env.map(([k, v]) => `${k}='${v.replace(/'/g, `'\\''`)}'`).join(" ");
  return { kind: "env", command: `export ${exports}; ${command}` };
}
