// The SessionStart hook's access to the sessions — hooks/workflow-start.sh runs:
//   node build/session-cli.js pickup <state-dir> <conversation-id> <claude-pid>
//   node build/session-cli.js active <state-dir> <claude-pid>
// and prints what it prints. No server is involved: the hook runs before the
// new process's server answers, and writes go through Storage's file locks.
import { Storage } from "./storage.js";
import type { SessionState } from "./types.js";
import {
  STATUS_TOOL,
  drivenByRootAgent,
  pickUpConversation,
  stepNote,
  subAgentLines,
  where,
} from "./takeover.js";

function stackOf(s: SessionState): string {
  return s.stack.length > 1
    ? ` (stack: ${s.stack.map(f => `${f.workflow} @ ${f.current_state}`).join(" > ")})`
    : "";
}

function childrenOf(sessions: readonly SessionState[]): Map<string, SessionState[]> {
  const map = new Map<string, SessionState[]>();
  for (const s of sessions) {
    if (!s.parent_session_id) continue;
    const list = map.get(s.parent_session_id) ?? [];
    list.push(s);
    map.set(s.parent_session_id, list);
  }
  return map;
}

/** Below `id`, parents first. */
function descendants(id: string, children: Map<string, SessionState[]>): SessionState[] {
  const out: SessionState[] = [];
  for (const c of children.get(id) ?? []) out.push(c, ...descendants(c.session_id, children));
  return out;
}

/**
 * `source: resume`: take this conversation's sessions over for `pid` and say
 * so — each picked-up root, the exec it stopped in, and its sub-agent sessions
 * with the SendMessage that wakes each agent. Empty when there was nothing.
 */
export async function pickupReport(
  storage: Storage,
  claudeSessionId: string,
  pid: number,
  at: string = new Date().toISOString(),
): Promise<string> {
  const roots = await pickUpConversation(storage, claudeSessionId, pid, at);
  if (roots.length === 0) return "";
  const active = storage.readAll().filter(s => s.stack?.length > 0);
  const children = childrenOf(active);
  const byId = new Map(active.map(s => [s.session_id, s]));
  const lines = [
    "WORKFLOW SESSIONS PICKED UP — this conversation's previous process left them; this process owns them now. Do NOT call start() or resume():",
  ];
  for (const root of roots) {
    lines.push(`  picked up: ${root.session_id} @ ${where(root)}${stackOf(root)}`);
    const note = stepNote(root);
    if (note)
      lines.push(
        `    ${note.text}${note.fate === "running" ? " — the first status() / transition() of the session takes it over" : ""}`,
      );
    // a descendant another live process runs was not handed over
    const subs = descendants(root.session_id, children).filter(
      s => s.context.claude_code_pid === pid,
    );
    if (subs.length > 0) {
      lines.push(
        "    sessions below it continue as they are — wake each sub-agent (only you can: SendMessage is your tool); one no agent drives is yours:",
        ...subAgentLines(subs, STATUS_TOOL, "      ", s =>
          drivenByRootAgent(s, root.session_id, byId),
        ),
      );
    }
  }
  lines.push(
    `Call ${STATUS_TOOL}({ session_id }) of each picked-up session for the full prompt of its state.`,
  );
  return lines.join("\n");
}

/**
 * `source: compact` / `clear`: the active sessions of process `pid` as a tree —
 * the hook's output lands in the new context, so the agent knows where it is.
 * Empty when there are none.
 */
export function activeReport(storage: Storage, pid: number): string {
  const active = storage
    .readAll()
    .filter(s => s.stack?.length > 0 && !s.suspended_at && s.context.claude_code_pid === pid);
  if (active.length === 0) return "";
  const ids = new Set(active.map(s => s.session_id));
  const children = childrenOf(active);
  const lines = ["ACTIVE WORKFLOW SESSIONS of this process — where you are:"];
  const walk = (s: SessionState, depth: number): void => {
    const lead = depth === 0 ? "  " : `${"  ".repeat(depth + 1)}↳ `;
    const agent = s.agent_id ? ` [agent ${s.agent_id}]` : "";
    const note = stepNote(s);
    lines.push(
      `${lead}${s.session_id}: ${where(s)}${stackOf(s)}${agent}${note ? ` [${note.text}]` : ""}`,
    );
    for (const c of children.get(s.session_id) ?? []) walk(c, depth + 1);
  };
  for (const s of active) if (!s.parent_session_id || !ids.has(s.parent_session_id)) walk(s, 0);
  lines.push(`Call ${STATUS_TOOL}({ session_id }) for the full prompt of a session's state.`);
  return lines.join("\n");
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, stateDir, ...rest] = argv;
  const pid = Number(rest.at(-1));
  if (!stateDir || !Number.isInteger(pid) || pid <= 1)
    throw new Error(
      `usage: session-cli.js pickup|active <state-dir> … <claude-pid>, got: ${argv.join(" ")}`,
    );
  const storage = new Storage(stateDir);
  let text: string;
  if (command === "pickup" && rest.length === 2) text = await pickupReport(storage, rest[0], pid);
  else if (command === "active" && rest.length === 1) text = activeReport(storage, pid);
  else throw new Error(`usage: session-cli.js pickup|active <state-dir> …, got: ${argv.join(" ")}`);
  if (text) process.stdout.write(text + "\n");
}

const [, script, ...args] = process.argv;
if (script?.endsWith("session-cli.js")) {
  main(args).catch(err => {
    console.error("session-cli:", err);
    process.exit(1);
  });
}
