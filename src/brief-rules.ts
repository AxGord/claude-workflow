// The engine's protocol rules of a worker / reviewer brief (waits, the hand-back line), written ONCE.
// A bundled prompt names a block as `{{rules.NAME}}`; the loader expands the marker at load time, so
// the loaded prompt carries the text and only its `{{context.*}}` placeholders are left to the render.
// A heir that replaces a state whose base prompt names a block gets the block carried over: an
// explicit marker in the heir's own prompt places it, `{{rules.none}}` drops it.

const RULES_NONE = "none";
const MARKER_RE = /\{\{rules\.([a-z_]+)\}\}/g;

const BLOCKS: Readonly<Record<string, string>> = {
  worker_waits:
    "Waits: a command you wait for runs in the FOREGROUND with the longest Bash timeout (600000), never with `run_in_background`. One that may outlast a call (the check behind a pool lease) you start detached with a done-marker, `nohup sh -c '<cmd>; echo $? > {{context.wt}}.log/L.done' > {{context.wt}}.log/L.log 2>&1 & echo $! > {{context.wt}}.log/L.pid`, then wait in FOREGROUND calls of `i=0; until [ -s {{context.wt}}.log/L.done ] || ! kill -0 \"$(cat {{context.wt}}.log/L.pid)\" 2>/dev/null || [ $i -ge 540 ]; do sleep 1; i=$((i+1)); done; cat {{context.wt}}.log/L.done` (it ends on the marker, on the process's death or on a timeout, never `sleep` alone), re-issued until {{context.wt}}.log/L.done exists (a dead pid without it is a failure: read {{context.wt}}.log/L.log). Marker, log and pid go by ABSOLUTE path (`mkdir -p` the directory first): the shell's cwd does not persist across calls (Claude Code resets it to the project root after a call that `cd`s outside the working directories), so a relative `L.*` lands in the user's project; chain `cd` with `&&`. Never start a Monitor for a command you wait for. When the harness moves a foreground call to the background at its timeout, TaskStop it, or wait on it in FOREGROUND calls (the until chain on its log), before any end of turn. Never end your turn while anything you started is alive, mid-run as well as at your last line: kill it first or wait for it. After you have delivered your last line, answer ONLY a harness `[handback-send-enforce]` prompt with the plain-text line `DELIVERED {{context.task}}` (never SendMessage to main, never the report again); a `Driver ping` that asks for your line gets the line.",
  reviewer_waits:
    "Waits: every command you run is in the FOREGROUND with the longest Bash timeout (600000), never with `run_in_background`. The read-only gate refuses a redirect, `$( )` and `sleep`, so you cannot detach a command or loop on a marker: a command that would outlast one call (a full suite, a lease wait) you do not run; name it in your verdict as unverified, with the command. Never start a Monitor for a command you wait for. When the harness moves a foreground call to the background at its timeout, TaskStop it before any end of turn. Never end your turn while anything you started is alive, mid-run as well as at your last line: TaskStop it first. After you have delivered your last line, answer ONLY a harness `[handback-send-enforce]` prompt with the plain-text line `DELIVERED {{context.task}}` (never SendMessage to main, never the report again); a `Driver ping` that asks for your line gets the line.",
};

/** Which agent a block addresses: the carried-over text names it to the driver that relays it. */
const ROLES: Readonly<Record<string, string>> = {
  worker_waits: "worker",
  reviewer_waits: "reviewer",
};

const markers = (prompt: string): string[] => [...prompt.matchAll(MARKER_RE)].map(m => m[1]);

/** The prompt with every `{{rules.NAME}}` marker replaced by its block; an unknown name throws. */
export function expandRules(prompt: string): string {
  return prompt.replace(MARKER_RE, (_marker, name: string) => {
    if (name === RULES_NONE) return "";
    const block = BLOCKS[name];
    if (block === undefined)
      throw new Error(
        `unknown rules block "${name}" (known: ${[...Object.keys(BLOCKS), RULES_NONE].join(", ")})`,
      );
    return block;
  });
}

/**
 * `own` replaces the state `base` declares: the blocks `base` names that `own` neither names nor opts
 * out of (`{{rules.none}}`) are appended to `own`, each under a line saying whom the rules are for.
 */
export function carryRules(base: string | undefined, own: string | undefined): string | undefined {
  if (base === undefined || own === undefined) return own;
  const have = markers(own);
  if (have.includes(RULES_NONE)) return own;
  const missing = [...new Set(markers(base))].filter(n => n in BLOCKS && !have.includes(n));
  return missing.reduce(
    (text, n) =>
      `${text}\n\nThe engine's rules for the ${ROLES[n]} brief (the base workflow's prompt for this state carries them, this one replaced it): put them verbatim into the brief you hand the ${ROLES[n]}.\n{{rules.${n}}}`,
    own,
  );
}
