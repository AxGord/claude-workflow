// The pool gate as the hook entries run it: config search from the cwd, the decision, and the
// PreToolUse output object. Shared by `pool-gate-hook` and `read-only-gate-hook`, which must emit ONE
// rewrite between them (Claude Code keeps a single `updatedInput`).
import fs from "node:fs";
import path from "node:path";
import { commandDir, decide, findConfig, rtkRewriter, toolShell } from "./pool-gate.js";
/** The pool gate's answer for `command` (undefined = pass). `note` is a stderr line for a pass. */
export function poolGateOutput(command, input, cwd, env, stderr) {
    // The config of the directory the command runs in (a leading `cd`) routes the heavy commands; a
    // directory with none (outside a git repo, or a repo without one) keeps the caller's rules. The
    // session's own project (the payload cwd) keeps its denies even when the target has a config.
    // Each lookup fails alone: a malformed file is ignored with one stderr line and the other still applies.
    const lookup = (dir) => {
        try {
            return findConfig(dir);
        }
        catch (err) {
            stderr(`pool-gate: config ignored — ${err.message}`);
            return undefined;
        }
    };
    let dir = path.resolve(cwd);
    try {
        dir = commandDir(command, cwd);
    }
    catch (err) {
        stderr(`pool-gate: command directory ignored — ${err.message}`);
    }
    const caller = lookup(cwd);
    const found = dir === path.resolve(cwd) ? caller : (lookup(dir) ?? caller);
    // build/pool-gate-hook.js → the plugin root.
    const root = path.resolve(path.dirname(fs.realpathSync(process.argv[1])), "..");
    const wfRun = path.join(root, "scripts", "wf-run");
    const shell = toolShell(env);
    if (caller && caller.file !== found?.file) {
        const denied = decide(command, caller.config, { wfRun, shell, env });
        if (denied.kind === "deny")
            return { permissionDecision: "deny", permissionDecisionReason: denied.reason };
    }
    const decision = decide(command, found?.config, {
        wfRun,
        shell,
        env,
        // Claude Code keeps one PreToolUse rewrite of a command — this one — so RTK's goes inside.
        rewrite: rtkRewriter(cwd, env),
    });
    if (decision.kind === "pass") {
        if (decision.note)
            stderr(decision.note);
        return undefined;
    }
    if (decision.kind === "deny")
        return { permissionDecision: "deny", permissionDecisionReason: decision.reason };
    return {
        ...(decision.allow ? { permissionDecision: "allow" } : {}),
        permissionDecisionReason: decision.allow
            ? "pool-gate: heavy command runs under wf-run; rtk: allow rules cover every command"
            : "pool-gate: heavy command runs under wf-run",
        updatedInput: { ...input, command: decision.command },
    };
}
