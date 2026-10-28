import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Storage } from "./storage.js";
import { Loader } from "./loader.js";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Modifier } from "./modifier.js";
import { registerTools, setContextEpochFile } from "./tools.js";
import { createDashboard } from "./dashboard.js";

// Resolve dir: env override → absolute default under ~/.claude/
function resolveDir(envVar: string, defaultAbs: string): string {
  const val = process.env[envVar];
  if (!val) return defaultAbs;
  return path.isAbsolute(val) ? val : path.resolve(process.cwd(), val);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = path.resolve(__dirname, "..", "templates");

const home = os.homedir();
const GLOBAL_WORKFLOW_DIR = resolveDir("WORKFLOW_DIR", path.join(home, ".claude", "workflows"));
const STATE_DIR = resolveDir("STATE_DIR", path.join(home, ".claude", "workflow-state"));
const DASHBOARD_PORT = parseInt(process.env["DASHBOARD_PORT"] ?? "3100", 10);

// Project-level workflows: .claude/workflows/ relative to CWD (if different from global)
const projectDir = path.resolve(process.cwd(), ".claude", "workflows");
const PROJECT_WORKFLOW_DIR = projectDir !== GLOBAL_WORKFLOW_DIR ? projectDir : null;

// Last-resort net: one stray rejection or throw in a callback must not take the
// MCP server (and every session it holds) down. Staying alive after an
// uncaughtException is acceptable here: the server keeps no in-memory state a
// half-run callback could corrupt — sessions live in files written under locks —
// and a request that hit it fails on its own; exiting would only drop the others.
process.on("unhandledRejection", reason => {
  console.error(
    "[workflow-engine] unhandledRejection:",
    reason instanceof Error ? (reason.stack ?? reason.message) : reason,
  );
});
process.on("uncaughtException", err => {
  console.error("[workflow-engine] uncaughtException:", err.stack ?? err.message);
});

// Initialize components
const storage = new Storage(STATE_DIR);
const loader = new Loader(BUNDLED_DIR, GLOBAL_WORKFLOW_DIR, PROJECT_WORKFLOW_DIR);

// Validate cross-references
const refErrors = loader.validateReferences();
if (refErrors.length > 0) {
  console.error("Workflow reference warnings:", refErrors.join("; "));
}

const skillErrors = loader.validateSkillReferences();
if (skillErrors.length > 0) {
  console.error("Skill reference warnings:", skillErrors.join("; "));
}

// Start hot-reload
loader.startWatching();

const executor = new Executor(undefined, path.join(STATE_DIR, "exec"));
const ttlDays = Number(process.env["WF_SUSPENDED_TTL_DAYS"]);
const engine = new Engine(storage, loader, executor, {
  stateDir: STATE_DIR,
  ...(Number.isFinite(ttlDays) && ttlDays > 0 ? { suspendedTtlDays: ttlDays } : {}),
});
const modifier = new Modifier(storage, loader);
modifier.setEngine(engine);

// Create MCP server
const server = new McpServer({
  name: "workflow-engine",
  version: "1.0.0",
});

// Register all tools
registerTools(server, engine, modifier, loader, storage, executor.pool);
// Written by hooks/workflow-start.sh on /clear and /compact (keyed by the
// Claude Code pid, which is this server's parent).
setContextEpochFile(path.join(STATE_DIR, `context-epoch-${process.ppid}`));

// Start dashboard
createDashboard(storage, loader, DASHBOARD_PORT);

// On startup: suspend sessions of dead processes, abandon long-suspended ones
engine
  .reapOrphanedSessions()
  .then(({ suspended, expired }) => {
    if (suspended.length > 0) console.error(`Suspended orphaned sessions: ${suspended.join(", ")}`);
    if (expired.length > 0)
      console.error(`Abandoned expired suspended sessions: ${expired.join(", ")}`);
  })
  .catch(err => console.error("Reap failed:", err));

// Connect via stdio
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Workflow Engine running on stdio");
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
