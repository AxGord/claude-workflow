import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Storage } from "./storage.js";
import { Loader } from "./loader.js";
import { Engine } from "./engine.js";
import { Modifier } from "./modifier.js";
import { registerTools } from "./tools.js";
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

// Initialize components
const storage = new Storage(STATE_DIR);
const loader = new Loader(BUNDLED_DIR, GLOBAL_WORKFLOW_DIR, PROJECT_WORKFLOW_DIR);

// Validate cross-references
const refErrors = loader.validateReferences();
if (refErrors.length > 0) {
  console.error("Workflow reference warnings:", refErrors.join("; "));
}

// Start hot-reload
loader.startWatching();

const engine = new Engine(storage, loader);
const modifier = new Modifier(storage, loader);
modifier.setEngine(engine);

// Create MCP server
const server = new McpServer({
  name: "workflow-engine",
  version: "1.0.0",
});

// Register all tools
registerTools(server, engine, modifier, loader, storage);

// Start dashboard
createDashboard(storage, loader, DASHBOARD_PORT);

// Reap orphaned sessions from previous processes on startup
engine.reapOrphanedSessions().then(reaped => {
  if (reaped.length > 0) console.error(`Reaped orphaned sessions: ${reaped.join(", ")}`);
}).catch(() => {});

// Connect via stdio
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP Workflow Engine running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
