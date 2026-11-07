// The pool gate as the hook entries run it: config search from the cwd, the decision, and the
// PreToolUse output object. Shared by `pool-gate-hook` and `read-only-gate-hook`, which must emit ONE
// rewrite between them (Claude Code keeps a single `updatedInput`).
import fs from "node:fs";
import path from "node:path";
import { decide, findConfig, rtkRewriter, toolShell } from "./pool-gate.js";

export interface HookOutput {
  readonly permissionDecision?: string;
  readonly permissionDecisionReason?: string;
  readonly updatedInput?: Record<string, unknown>;
}

/** The pool gate's answer for `command` (undefined = pass). `note` is a stderr line for a pass. */
export function poolGateOutput(
  command: string,
  input: Record<string, unknown>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  stderr: (line: string) => void,
): HookOutput | undefined {
  let found;
  try {
    found = findConfig(cwd);
  } catch (err) {
    stderr(`pool-gate: config ignored — ${(err as Error).message}`);
    return undefined;
  }
  // build/pool-gate-hook.js → the plugin root.
  const root = path.resolve(path.dirname(fs.realpathSync(process.argv[1])), "..");
  const decision = decide(command, found?.config, {
    wfRun: path.join(root, "scripts", "wf-run"),
    shell: toolShell(env),
    env,
    // Claude Code keeps one PreToolUse rewrite of a command — this one — so RTK's goes inside.
    rewrite: rtkRewriter(cwd, env),
  });
  if (decision.kind === "pass") {
    if (decision.note) stderr(decision.note);
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
