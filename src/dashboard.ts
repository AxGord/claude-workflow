import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Storage } from "./storage.js";
import type { Loader } from "./loader.js";
import type { SessionState } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function buildApp(storage: Storage, loader: Loader): express.Express {
  const app = express();
  app.use(express.json());

  // API endpoints
  app.get("/api/sessions", (_req, res) => {
    const sessions = storage.readAll();
    res.json(sessions);
  });

  app.get("/api/session/:id", (req, res) => {
    const session = storage.read(req.params.id);
    if (!session) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(session);
  });

  app.get("/api/workflows", (_req, res) => {
    const workflows = loader.getAll();
    const result: Record<string, unknown> = {};
    for (const [name, wf] of workflows) {
      result[name] = {
        name: wf.name,
        description: wf.description,
        initial: wf.initial,
        max_transitions: wf.max_transitions,
        states: wf.states,
      };
    }
    res.json(result);
  });

  // Abandon a session via REST (used by SessionEnd hook)
  app.post("/api/session/:id/abandon", async (req, res) => {
    try {
      const session = storage.read(req.params.id);
      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      // Idempotent: already inactive — return current outcome
      if (session.stack.length === 0) {
        res.json({ session_id: session.session_id, outcome: session.outcome ?? "completed" });
        return;
      }

      const now = new Date().toISOString();
      const updated: SessionState = {
        ...session,
        stack: [],
        active_frame: -1,
        updated_at: now,
        history: [...session.history, { frame: session.active_frame, event: "abandon", at: now }],
        outcome: "abandoned",
      };

      await storage.write(session.session_id, updated);
      res.json({ session_id: session.session_id, outcome: "abandoned" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Serve dashboard HTML
  const dashboardDir = path.resolve(__dirname, "..", "dashboard");
  app.use(express.static(dashboardDir));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(dashboardDir, "index.html"));
  });

  return app;
}

function tryListen(app: express.Express, port: number): void {
  const server = app.listen(port);
  server.on("listening", () => {
    console.error(`Dashboard running at http://localhost:${port}`);
  });
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Dashboard port ${port} in use — retrying in 20s`);
      setTimeout(() => tryListen(app, port), 20_000);
    } else {
      console.error(`Dashboard error: ${err.message}`);
    }
  });
}

export function createDashboard(storage: Storage, loader: Loader, port: number): void {
  const app = buildApp(storage, loader);
  tryListen(app, port);
}
