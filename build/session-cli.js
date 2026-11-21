// The SessionStart hook's access to the sessions — hooks/workflow-start.sh runs:
//   node build/session-cli.js pickup <state-dir> <conversation-id> <claude-pid>
//   node build/session-cli.js active <state-dir> <claude-pid>
// and prints what it prints. No server is involved: the hook runs before the
// new process's server answers, and writes go through Storage's file locks.
import { Storage } from "./storage.js";
import { workflowLoader } from "./workflow-dirs.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { STATUS_TOOL, dispatcherSplit, drivenByRootAgent, pickUpConversation, stepNote, subAgentLines, where, } from "./takeover.js";
function stackOf(s) {
    return s.stack.length > 1
        ? ` (stack: ${s.stack.map(f => `${f.workflow} @ ${f.current_state}`).join(" > ")})`
        : "";
}
function childrenOf(sessions) {
    const map = new Map();
    for (const s of sessions) {
        if (!s.parent_session_id)
            continue;
        const list = map.get(s.parent_session_id) ?? [];
        list.push(s);
        map.set(s.parent_session_id, list);
    }
    return map;
}
/** Below `id`, parents first. */
function descendants(id, children) {
    const out = [];
    for (const c of children.get(id) ?? [])
        out.push(c, ...descendants(c.session_id, children));
    return out;
}
/**
 * `source: resume`: take this conversation's sessions over for `pid` and say
 * so — each picked-up root, the exec it stopped in, and its sub-agent sessions
 * with the SendMessage that wakes each agent. Empty when there was nothing.
 */
export async function pickupReport(storage, claudeSessionId, pid, at = new Date().toISOString(), routeOf) {
    const roots = await pickUpConversation(storage, claudeSessionId, pid, at);
    if (roots.length === 0)
        return "";
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
            lines.push(`    ${note.text}${note.fate === "running" ? " — the first status() / transition() of the session takes it over" : ""}`);
        // a descendant another live process runs was not handed over
        const subs = descendants(root.session_id, children).filter(s => s.context.claude_code_pid === pid);
        // under a dispatcher agent only the task sessions of its `tasks` key (and what runs below them) are its to wake
        const { lines: dispatcher, mine } = dispatcherSplit(root, subs, byId, "    ");
        if (dispatcher.length > 0)
            lines.push(...dispatcher);
        if (mine.length > 0) {
            lines.push("    sessions below it continue as they are — wake each sub-agent (only you can: SendMessage is your tool); one no agent drives is yours; an earlier visit's agent of a `driver:` workflow's state is not woken:", ...subAgentLines(mine, STATUS_TOOL, "      ", s => drivenByRootAgent(s, root.session_id, byId), s => (s.parent_session_id ? byId.get(s.parent_session_id) : undefined), routeOf));
        }
    }
    lines.push(`Call ${STATUS_TOOL}({ session_id }) of each picked-up session for the full prompt of its state.`);
    return lines.join("\n");
}
/**
 * `source: compact` / `clear`: the active sessions of process `pid` as a tree —
 * the hook's output lands in the new context, so the agent knows where it is.
 * Empty when there are none.
 */
export function activeReport(storage, pid) {
    const active = storage
        .readAll()
        .filter(s => s.stack?.length > 0 && !s.suspended_at && s.context.claude_code_pid === pid);
    if (active.length === 0)
        return "";
    const ids = new Set(active.map(s => s.session_id));
    const children = childrenOf(active);
    const lines = ["ACTIVE WORKFLOW SESSIONS of this process — where you are:"];
    const walk = (s, depth) => {
        const lead = depth === 0 ? "  " : `${"  ".repeat(depth + 1)}↳ `;
        const agent = s.agent_id ? ` [agent ${s.agent_id}]` : "";
        const note = stepNote(s);
        lines.push(`${lead}${s.session_id}: ${where(s)}${stackOf(s)}${agent}${note ? ` [${note.text}]` : ""}`);
        for (const c of children.get(s.session_id) ?? [])
            walk(c, depth + 1);
    };
    for (const s of active)
        if (!s.parent_session_id || !ids.has(s.parent_session_id))
            walk(s, 0);
    lines.push(`Call ${STATUS_TOOL}({ session_id }) for the full prompt of a session's state.`);
    return lines.join("\n");
}
/** The workflows the server loads (`workflowLoader`), for the route test of each session's own workflow. */
export function cliLoader() {
    return workflowLoader();
}
/** What `pickup` / `active` print for `argv` (the hook's arguments after the script), or "". */
export async function cliReport(argv) {
    const [command, stateDir, ...rest] = argv;
    const pid = Number(rest.at(-1));
    if (!stateDir || !Number.isInteger(pid) || pid <= 1)
        throw new Error(`usage: session-cli.js pickup|active <state-dir> … <claude-pid>, got: ${argv.join(" ")}`);
    const storage = new Storage(stateDir, { eventLog: false });
    if (command === "pickup" && rest.length === 2) {
        const engine = new Engine(storage, cliLoader(), new Executor());
        return pickupReport(storage, rest[0], pid, undefined, s => engine.routeTest(s));
    }
    if (command === "active" && rest.length === 1)
        return activeReport(storage, pid);
    throw new Error(`usage: session-cli.js pickup|active <state-dir> …, got: ${argv.join(" ")}`);
}
async function main(argv) {
    const text = await cliReport(argv);
    if (text)
        process.stdout.write(text + "\n");
}
const [, script, ...args] = process.argv;
if (script?.endsWith("session-cli.js")) {
    main(args).catch(err => {
        console.error("session-cli:", err);
        process.exit(1);
    });
}
