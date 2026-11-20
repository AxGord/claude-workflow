// The one owner of "which workflow directories does this process load": the MCP
// server (index.ts) and the SessionStart hook's CLI (session-cli.ts) both build
// their Loader here, so a project's local `.claude/workflows` is read by both.
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Loader } from "./loader.js";
import { TrustStore } from "./trust.js";
/** An env override (absolute, or relative to `cwd`) or the absolute default. */
export function resolveDir(envVar, defaultAbs, env = process.env, cwd = process.cwd()) {
    const val = env[envVar];
    if (!val)
        return defaultAbs;
    return path.isAbsolute(val) ? val : path.resolve(cwd, val);
}
/** The bundled templates, the global directory (`WORKFLOW_DIR`) and the cwd's project directory. */
export function workflowDirs(env = process.env, cwd = process.cwd()) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const global = resolveDir("WORKFLOW_DIR", path.join(os.homedir(), ".claude", "workflows"), env, cwd);
    const project = path.resolve(cwd, ".claude", "workflows");
    return {
        bundled: path.resolve(here, "..", "templates"),
        global,
        project: project !== global ? project : null,
    };
}
/** The state directory (`STATE_DIR`): the sessions, the ledger and the trust store live there. */
export function stateDir(env = process.env) {
    return resolveDir("STATE_DIR", path.join(os.homedir(), ".claude", "workflow-state"), env);
}
/** The Loader every process of the engine builds: bundled, global, project (its exec/fetch gated by the trust store). */
export function workflowLoader() {
    const dirs = workflowDirs();
    return new Loader(dirs.bundled, dirs.global, dirs.project, TrustStore.inStateDir(stateDir()));
}
