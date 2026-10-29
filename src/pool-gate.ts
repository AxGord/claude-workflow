// pool-gate: the PreToolUse(Bash) decision — run a command the project marks heavy under
// `wf-run`, refuse one its config refuses, leave everything else alone. Pure apart from
// `findConfig` (reads files); the hook entry is `pool-gate-hook.ts`.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Where a project declares its heavy commands, searched from the cwd up to the git root. */
export const POOL_GATE_CONFIG = path.join(".claude", "workflows", "pool-gate.json");
const LABEL_MAX = 80;
const THREADS_VAR = "$WF_THREADS";

export interface GateRule {
  /** Leading words of the command (`npx vitest run`), or `/regex/flags` over the command text. */
  readonly match: string;
  readonly threads?: ThreadSpec;
  /** How the command learns its share: a flag template with `$WF_THREADS`, or `env:NAME`. */
  readonly pass?: string;
  readonly deny?: string;
}

export interface ThreadSpec {
  readonly min: number;
  readonly max: number;
}

export interface GateConfig {
  readonly rules: readonly GateRule[];
  /** Project scripts that take their own lease (they call wf-run): never wrapped again. */
  readonly wrappers: readonly string[];
}

export type Decision =
  | { readonly kind: "pass"; readonly note?: string }
  | { readonly kind: "deny"; readonly reason: string }
  /** `allow`: the body rewriter vouched that the user's allow rules cover every command in it. */
  | { readonly kind: "wrap"; readonly command: string; readonly allow?: true };

/**
 * A second rewrite of the wrapped body (RTK's), run because Claude Code keeps only one
 * PreToolUse `updatedInput`. `undefined` = leave the whole command untouched (the rewriter
 * saw a deny — Claude Code's own deny must see the original line).
 */
export type BodyRewriter = (body: string) => { body: string; allow: boolean } | undefined;

export interface DecideOptions {
  /** Absolute path of the plugin's `scripts/wf-run`. */
  readonly wfRun: string;
  /** The shell that runs the command under wf-run (the Bash tool's own shell when known). */
  readonly shell: string;
  readonly env: NodeJS.ProcessEnv;
  readonly rewrite?: BodyRewriter;
}

// ---- config ----

/** The nearest pool-gate.json from `cwd` up to the git root; none outside a git repo. */
export function findConfig(cwd: string): { file: string; config: GateConfig } | undefined {
  const dirs: string[] = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    dirs.push(dir);
    if (fs.existsSync(path.join(dir, ".git"))) break;
    if (path.dirname(dir) === dir) return undefined;
  }
  for (const dir of dirs) {
    const file = path.join(dir, POOL_GATE_CONFIG);
    if (!fs.existsSync(file)) continue;
    try {
      return { file, config: parseConfig(fs.readFileSync(file, "utf8")) };
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`);
    }
  }
  return undefined;
}

/** Validate a pool-gate.json text; throws with the offending entry named. */
export function parseConfig(text: string): GateConfig {
  const raw = JSON.parse(text) as unknown;
  if (!isObject(raw)) throw new Error("expected an object with `rules`");
  const { rules = [], wrappers = [] } = raw;
  if (!Array.isArray(rules)) throw new Error("`rules` must be a list");
  if (!Array.isArray(wrappers) || !wrappers.every(w => typeof w === "string" && w !== ""))
    throw new Error("`wrappers` must be a list of script names");
  return {
    rules: rules.map((r: unknown, i) => parseRule(r, `rules[${i}]`)),
    wrappers: wrappers as string[],
  };
}

function parseRule(r: unknown, at: string): GateRule {
  if (!isObject(r)) throw new Error(`${at}: expected an object`);
  const { match, threads, pass, deny } = r;
  if (typeof match !== "string" || match.trim() === "")
    throw new Error(`${at}: \`match\` must be a non-empty string`);
  if (regexOf(match) === null && match.startsWith("/"))
    throw new Error(`${at}: \`match\` "${match}" is not a valid /regex/`);
  if (deny !== undefined && (typeof deny !== "string" || deny === ""))
    throw new Error(`${at}: \`deny\` must be a reason`);
  if (pass !== undefined) {
    if (typeof pass !== "string") throw new Error(`${at}: \`pass\` must be a string`);
    if (!/^env:[A-Za-z_][A-Za-z0-9_]*$/.test(pass) && !pass.includes(THREADS_VAR))
      throw new Error(`${at}: \`pass\` is \`env:NAME\` or a flag holding ${THREADS_VAR}`);
  }
  if ((threads === undefined) === (deny === undefined))
    throw new Error(`${at}: exactly one of \`threads\` and \`deny\``);
  return {
    match,
    ...(threads === undefined ? {} : { threads: parseThreads(threads, at) }),
    ...(pass === undefined ? {} : { pass }),
    ...(deny === undefined ? {} : { deny }),
  };
}

function parseThreads(v: unknown, at: string): ThreadSpec {
  const int = (s: unknown): number => {
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${at}: \`threads\` is N or "MIN-MAX"`);
    return n;
  };
  if (typeof v === "number") return { min: int(v), max: int(v) };
  const range = typeof v === "string" ? /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(v) : null;
  if (!range) return { min: int(v), max: int(v) };
  const spec = { min: int(range[1]), max: int(range[2]) };
  if (spec.min > spec.max) throw new Error(`${at}: \`threads\` min exceeds max`);
  return spec;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `/body/flags` → its RegExp; null for a word pattern or an invalid regex. */
function regexOf(match: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(match);
  if (!m) return null;
  try {
    return new RegExp(m[1], m[2]);
  } catch {
    return null;
  }
}

// ---- shell splitting ----

export interface Word {
  /** The word with quotes and escapes removed (a substitution stays as written). */
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

export interface Segment {
  readonly words: readonly Word[];
  /** The operator that ends it (`&&`, `|`, `;`, `&`, newline …), "" at the end. */
  readonly op: string;
}

const OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "(", ")", "\n"];

/**
 * Split a command line into simple commands at unquoted `&&` `||` `;` `|` `&` `(` `)` and
 * newlines. Quotes, escapes, `$(…)` and backticks stay inside their word. Undefined when the
 * text is not plain enough to edit safely: an unterminated quote or substitution, a heredoc.
 */
export function splitSegments(command: string): Segment[] | undefined {
  const segments: Segment[] = [];
  let words: Word[] = [];
  let value = "";
  let start = -1;
  const endWord = (end: number): void => {
    if (start >= 0) words.push({ value, start, end });
    value = "";
    start = -1;
  };
  const begin = (i: number): void => {
    if (start < 0) start = i;
  };
  let i = 0;
  const n = command.length;
  while (i < n) {
    const c = command[i];
    if (c === " " || c === "\t") {
      endWord(i);
      i++;
      continue;
    }
    if (c === "#" && start < 0) {
      while (i < n && command[i] !== "\n") i++;
      continue;
    }
    if (c === "\\") {
      if (command[i + 1] === "\n") {
        endWord(i);
        i += 2;
        continue;
      }
      if (i + 1 >= n) return undefined;
      begin(i);
      value += command[i + 1];
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return undefined;
      begin(i);
      value += command.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (c === '"') {
      begin(i);
      let j = i + 1;
      for (; j < n && command[j] !== '"'; j++) {
        if (command[j] === "\\" && j + 1 < n) {
          value += '"\\$`\n'.includes(command[j + 1]) ? command[j + 1] : "\\" + command[j + 1];
          j++;
        } else if (command[j] === "$" && command[j + 1] === "(") {
          const close = skipSubstitution(command, j);
          if (close < 0) return undefined;
          value += command.slice(j, close);
          j = close - 1;
        } else if (command[j] === "`") {
          const close = skipBackticks(command, j);
          if (close < 0) return undefined;
          value += command.slice(j, close);
          j = close - 1;
        } else value += command[j];
      }
      if (j >= n) return undefined;
      i = j + 1;
      continue;
    }
    if (c === "$" && command[i + 1] === "(") {
      const close = skipSubstitution(command, i);
      if (close < 0) return undefined;
      begin(i);
      value += command.slice(i, close);
      i = close;
      continue;
    }
    if (c === "`") {
      const close = skipBackticks(command, i);
      if (close < 0) return undefined;
      begin(i);
      value += command.slice(i, close);
      i = close;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") return undefined;
    // A redirection keeps its `&` / `|`: `2>&1`, `&>file`, `>|file`.
    const prev = command[i - 1];
    const redirect =
      (c === "&" && (command[i + 1] === ">" || (start >= 0 && (prev === ">" || prev === "<")))) ||
      (c === "|" && start >= 0 && prev === ">");
    const op = redirect ? undefined : OPERATORS.find(o => command.startsWith(o, i));
    if (op !== undefined) {
      endWord(i);
      segments.push({ words, op });
      words = [];
      i += op.length;
      continue;
    }
    begin(i);
    value += c;
    i++;
  }
  endWord(n);
  segments.push({ words, op: "" });
  return segments.filter(s => s.words.length > 0 || s.op === "&");
}

/** Index just past the `)` closing the `$(` at `i`; -1 when unterminated. */
function skipSubstitution(s: string, i: number): number {
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "'") {
      j = s.indexOf("'", j + 1);
      if (j < 0) return -1;
    } else if (c === '"') {
      for (j++; j < s.length && s[j] !== '"'; j++) if (s[j] === "\\") j++;
      if (j >= s.length) return -1;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return j + 1;
  }
  return -1;
}

function skipBackticks(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") j++;
    else if (s[j] === "`") return j + 1;
  }
  return -1;
}

// ---- the decision ----

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words in front of the command that do not name it. */
const TRANSPARENT = new Set([
  "time",
  "!",
  "exec",
  "command",
  "builtin",
  "nohup",
  "env",
  "{",
  "if",
  "then",
  "elif",
  "else",
  "while",
  "until",
  "do",
]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

const basename = (w: string): string => w.slice(w.lastIndexOf("/") + 1);

/** The words naming the command and its arguments: leading assignments and keywords dropped. */
function commandWords(seg: Segment): readonly Word[] {
  let k = 0;
  while (
    k < seg.words.length &&
    (ASSIGNMENT.test(seg.words[k].value) || TRANSPARENT.has(seg.words[k].value))
  )
    k++;
  const words = seg.words.slice(k);
  return words.length > 0 && words[words.length - 1].value === "}" ? words.slice(0, -1) : words;
}

/** The leading `NAME=value` assignments of a segment. */
function assignments(seg: Segment): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of seg.words) {
    if (!ASSIGNMENT.test(w.value)) break;
    const eq = w.value.indexOf("=");
    out.set(w.value.slice(0, eq), w.value.slice(eq + 1));
  }
  return out;
}

interface Hit {
  readonly rule: GateRule;
  readonly words: readonly Word[];
  /** Offset after which a `pass` flag goes. */
  readonly flagAt: number;
}

function matchRule(rule: GateRule, words: readonly Word[], command: string): Hit | undefined {
  if (words.length === 0) return undefined;
  const re = regexOf(rule.match);
  if (re) {
    const end = words[words.length - 1].end;
    if (!re.test(command.slice(words[0].start, end))) return undefined;
    // A flag goes before `--`: after it, it would be an operand.
    const dashes = words.findIndex((w, k) => k > 0 && w.value === "--");
    return { rule, words, flagAt: dashes < 0 ? end : words[dashes - 1].end };
  }
  const want = rule.match.trim().split(/\s+/);
  if (want.length > words.length) return undefined;
  const same = (p: string, k: number): boolean =>
    words[k].value === p || (k === 0 && !p.includes("/") && basename(words[0].value) === p);
  return want.every(same) ? { rule, words, flagAt: words[want.length - 1].end } : undefined;
}

const isWfRun = (w: readonly Word[]): boolean =>
  w.length > 0 &&
  (basename(w[0].value) === "wf-run" ||
    (w.length > 1 &&
      ["node", "npx"].includes(basename(w[0].value)) &&
      ["wf-run", "wf-run.js"].includes(basename(w[1].value))));

function isWrapper(w: readonly Word[], wrappers: readonly string[]): boolean {
  if (w.length === 0) return false;
  const name = SHELLS.has(basename(w[0].value)) && w.length > 1 ? w[1].value : w[0].value;
  return wrappers.includes(basename(name));
}

/** Single-quote for sh unless the text is plainly safe. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The `pass` edit of one hit: the text and where it goes; none when the flag is already there. */
function passEdit(hit: Hit): { at: number; text: string } | undefined {
  const pass = hit.rule.pass;
  if (pass === undefined) return undefined;
  if (pass.startsWith("env:")) {
    const name = pass.slice(4);
    // `env` keeps it valid after `time` / `!` / `then`, where a bare assignment is not.
    return { at: hit.words[0].start, text: `env ${name}="${THREADS_VAR}" ` };
  }
  // `--maxWorkers=$WF_THREADS` → `--maxWorkers`, `-j $WF_THREADS` → `-j`.
  const key = pass.slice(0, pass.indexOf(THREADS_VAR)).replace(/[=\s]+$/, "");
  const given = (w: Word): boolean =>
    w.value === key ||
    w.value.startsWith(key + "=") ||
    // a short flag glued to its value: `-j8`
    (/^-[A-Za-z]$/.test(key) && w.value.length > 2 && w.value.startsWith(key));
  if (key !== "" && hit.words.some(given)) return undefined;
  return { at: hit.flagAt, text: " " + pass };
}

function combine(specs: readonly ThreadSpec[]): string {
  const max = Math.max(...specs.map(s => s.max));
  const min = Math.min(max, Math.max(...specs.map(s => s.min)));
  return min === max ? String(max) : `${min}-${max}`;
}

/**
 * What the hook does with `command`. Order: no config → pass; `WF_POOL_BYPASS=1` up front →
 * pass with a note; not plain enough to edit → pass; a `deny` rule hit → deny; no heavy hit,
 * a lease already held (`WF_THREADS`), a `wf-run` or a wrapper inside, a background `&` →
 * pass; else the whole command under one wf-run with the largest share any hit asks, its
 * body through `opts.rewrite` when given.
 */
export function decide(
  command: string,
  config: GateConfig | undefined,
  opts: DecideOptions,
): Decision {
  if (!config) return { kind: "pass" };
  const segments = splitSegments(command);
  if (!segments) return { kind: "pass" };
  const lead = segments[0] ? assignments(segments[0]) : new Map<string, string>();
  if (lead.get("WF_POOL_BYPASS") === "1") {
    const reason = lead.get("WF_POOL_BYPASS_REASON");
    return {
      kind: "pass",
      note: `pool-gate: WF_POOL_BYPASS=1 — runs outside the pool (${reason ? `reason: ${reason}` : "no WF_POOL_BYPASS_REASON given"})`,
    };
  }
  const hits: Hit[] = [];
  let leased = false;
  for (const seg of segments) {
    const words = commandWords(seg);
    if (isWfRun(words) || isWrapper(words, config.wrappers)) leased = true;
    let hit: Hit | undefined;
    for (const rule of config.rules) if ((hit = matchRule(rule, words, command))) break;
    if (hit?.rule.deny !== undefined)
      return { kind: "deny", reason: `pool-gate: ${hit.rule.deny}` };
    if (hit) hits.push(hit);
  }
  if (hits.length === 0 || leased || segments.some(s => s.op === "&")) return { kind: "pass" };
  if (opts.env.WF_THREADS !== undefined && opts.env.WF_THREADS !== "") return { kind: "pass" };

  let body = command;
  const edits = hits
    .map(passEdit)
    .filter((e): e is { at: number; text: string } => e !== undefined)
    .sort((a, b) => b.at - a.at);
  for (const e of edits) body = body.slice(0, e.at) + e.text + body.slice(e.at);
  let allow = false;
  if (opts.rewrite) {
    const r = opts.rewrite(body);
    if (!r) return { kind: "pass" };
    ({ body, allow } = r);
  }
  const threads = combine(hits.map(h => h.rule.threads!));
  const label = command.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
  return {
    kind: "wrap",
    command:
      `${shellQuote(opts.wfRun)} --fail-open --threads ${threads} --label ${shellQuote(label)} -- ` +
      `${shellQuote(opts.shell)} -c ${shellQuote(body)}`,
    ...(allow ? { allow: true as const } : {}),
  };
}

/** The shell the Bash tool runs commands in: `$SHELL` when it is a known shell, else sh. */
export function toolShell(env: NodeJS.ProcessEnv): string {
  const sh = env.SHELL;
  return sh && path.isAbsolute(sh) && SHELLS.has(basename(sh)) ? sh : "sh";
}

/**
 * The body through `rtk rewrite` (when `rtk` is on PATH), from the command's cwd: exit 0 →
 * its rewrite, allowed (RTK checked the user's allow rules cover every command in it); 3 → its
 * rewrite, no decision; 2 → a deny matched, leave the command alone; anything else → as is.
 */
export function rtkRewriter(cwd: string, env: NodeJS.ProcessEnv): BodyRewriter {
  // RTK_REWRITE_HOST turns 3 into 0 for hosts that gate commands themselves: not this one.
  const rest = { ...env };
  delete rest.RTK_REWRITE_HOST;
  return body => {
    const r = spawnSync("rtk", ["rewrite", body], {
      cwd,
      env: rest,
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (r.error) return { body, allow: false };
    if (r.status === 2) return undefined;
    const out = r.stdout.replace(/\n$/, "");
    if ((r.status === 0 || r.status === 3) && out.trim() !== "")
      return { body: out, allow: r.status === 0 };
    return { body, allow: false };
  };
}
