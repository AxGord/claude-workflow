// Ownership handover of a session sub-tree to another Claude Code process —
// shared by `Engine.resume` and the SessionStart hook's `session-cli.js`, which
// runs without a server (Storage only).
import type { Storage } from "./storage.js";
import type { SessionState } from "./types.js";
import { isPidAlive } from "./process.js";

export const RESUME_TOOL = "mcp__plugin_workflow_wf__resume";
export const STATUS_TOOL = "mcp__plugin_workflow_wf__status";

/** `workflow @ state` of an active session. */
export function where(s: SessionState): string {
  const f = s.stack[s.active_frame];
  return `${f.workflow} @ ${f.current_state}`;
}

/** The session and its active descendants, parents first. */
export function activeSubtree(storage: Storage, sessionId: string): string[] {
  const children = new Map<string, string[]>();
  for (const s of storage.readAll()) {
    if (!s.parent_session_id || !(s.stack?.length > 0)) continue;
    const list = children.get(s.parent_session_id) ?? [];
    list.push(s.session_id);
    children.set(s.parent_session_id, list);
  }
  const ids = [sessionId];
  for (let i = 0; i < ids.length; i++) ids.push(...(children.get(ids[i]) ?? []));
  return ids;
}

export interface NewOwner {
  /** The Claude Code process that owns the sessions from now on. */
  readonly pid: number;
  /** Its conversation id, stamped on every session whose suspension is cleared. */
  readonly claudeSessionId?: string;
}

/**
 * Hand `rootId` and its active descendants to `owner`, each under its own
 * file lock (`Storage.update`) — except a descendant another live process
 * runs unsuspended. `root`: only the root's suspension is cleared —
 * each descendant waits for its agent's `resume`. `tree`: every suspension in
 * the sub-tree is cleared, so the agents continue their sessions as they are.
 * Returns the ids written.
 */
export async function takeOver(
  storage: Storage,
  rootId: string,
  owner: NewOwner,
  at: string,
  scope: "root" | "tree",
): Promise<string[]> {
  const written: string[] = [];
  for (const id of activeSubtree(storage, rootId)) {
    const set = await storage.update(id, cur => {
      if (!cur || cur.stack.length === 0) return null;
      // a descendant another live process runs is that process's, not part of the handover
      const held = cur.context.claude_code_pid;
      if (
        id !== rootId &&
        !cur.suspended_at &&
        typeof held === "number" &&
        held !== owner.pid &&
        isPidAlive(held)
      )
        return null;
      const wake = scope === "tree" || id === rootId;
      const restamp =
        wake && !!owner.claudeSessionId && cur.claude_session_id !== owner.claudeSessionId;
      if (cur.context.claude_code_pid === owner.pid && !(wake && cur.suspended_at) && !restamp)
        return null;
      return {
        ...cur,
        context: { ...cur.context, claude_code_pid: owner.pid },
        ...(wake && owner.claudeSessionId ? { claude_session_id: owner.claudeSessionId } : {}),
        ...(wake ? { suspended_at: undefined } : {}),
        updated_at: at,
        history:
          wake && cur.suspended_at
            ? [...cur.history, { frame: cur.active_frame, event: "resume", at }]
            : cur.history,
      };
    });
    if (set) written.push(id);
  }
  return written;
}

/**
 * A resumed conversation picks up its own sessions: those stamped with its id
 * and left suspended (SessionEnd) or owned by a dead process (a crash), with
 * their whole sub-trees. A session another live process runs is left alone.
 * Returns the picked-up roots as stored afterwards.
 */
export async function pickUpConversation(
  storage: Storage,
  claudeSessionId: string,
  pid: number,
  at: string,
): Promise<SessionState[]> {
  const all = storage.readAll();
  const left = all.filter(s => {
    if (!(s.stack?.length > 0) || s.claude_session_id !== claudeSessionId) return false;
    if (s.suspended_at) return true;
    const owner = s.context.claude_code_pid;
    return typeof owner === "number" && owner !== pid && !isPidAlive(owner);
  });
  // a session with an active parent is that parent's to hand over — e.g. the
  // child an explicit resume() left suspended under a parent another process runs
  const activeIds = new Set(all.filter(s => s.stack?.length > 0).map(s => s.session_id));
  const roots = left.filter(s => !s.parent_session_id || !activeIds.has(s.parent_session_id));
  for (const root of roots)
    await takeOver(storage, root.session_id, { pid, claudeSessionId }, at, "tree");
  return roots
    .map(r => storage.read(r.session_id))
    .filter((s): s is SessionState => !!s && s.stack.length > 0);
}

/**
 * Two lines per sub-agent session — agent → session → state —
 * and the `SendMessage` that wakes its agent to call `call` on its OWN session.
 */
export function subAgentLines(
  sessions: readonly SessionState[],
  call: typeof RESUME_TOOL | typeof STATUS_TOOL,
  indent: string,
): string[] {
  const lines: string[] = [];
  const how =
    call === RESUME_TOOL
      ? "your own session, NOT start()"
      : "your own session, picked up after a restart — NOT start(), NOT resume()";
  for (const c of sessions) {
    const agent = c.agent_id ?? "(not linked — find the agent by its task; link_agent records it)";
    const exec = c.running_exec ? ` [exec in flight: ${c.running_exec.state}]` : "";
    lines.push(`${indent}${agent} → ${c.session_id} → ${where(c)}${exec}`);
    lines.push(
      `${indent}  SendMessage({ to: "${c.agent_id ?? "<agent>"}", message: "Continue: call ${call}({ session_id: '${c.session_id}' }) — ${how} — then carry on from the state it returns." })`,
    );
  }
  return lines;
}
