import express from "express";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Storage } from "./storage.js";
import type { Loader } from "./loader.js";
import type { SessionState } from "./types.js";
import type { WfEvent } from "./event-log.js";
import { computeStations } from "./stations.js";
import { ledgerEntry } from "./ledger.js";
import { describeQueue, readQueue, QueueError } from "./queue.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The compiled route table the page imports as `/routes.js` (a test serves a transpiled copy instead). */
const ROUTES_MODULE = path.join(__dirname, "dashboard-routes.js");

/** The live map's pure modules, compiled beside the route table and served under these names. */
const MAP_MODULES = ["event-fold.js", "map-layout.js"] as const;

export function buildApp(
  storage: Storage,
  loader: Loader,
  routesModule: string = ROUTES_MODULE,
): express.Express {
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
        stations: computeStations(wf),
        ...(wf.map === false ? { map: false } : {}),
        ...(wf.driver ? { driver: { model: wf.driver.model, effort: wf.driver.effort } } : {}),
      };
    }
    res.json(result);
  });

  // The event log of the server process that holds the dashboard port. A reader resumes with
  // `since` = `<run>:<seq>` (or a bare seq of this run); a position of another run counts as 0.
  app.get("/api/events", (req, res) => {
    const log = storage.events;
    res.json({ run: log.run, events: log.since(log.resumeFrom(req.query.since)) });
  });

  // Server-sent events: replays after `since` (or Last-Event-ID), then streams; `id:` is the seq.
  app.get("/api/events/stream", (req, res) => {
    const log = storage.events;
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    const send = (e: WfEvent): void => {
      res.write(`id: ${e.run}:${e.seq}\nevent: wf\ndata: ${JSON.stringify(e)}\n\n`);
    };
    let last = Math.max(log.resumeFrom(req.query.since), log.resumeFrom(req.get("last-event-id")));
    // subscribe first, then replay: nothing between the two is lost, and `last` drops the overlap
    const unsub = log.subscribe(e => {
      if (e.seq > last) {
        last = e.seq;
        send(e);
      }
    });
    for (const e of log.since(last)) {
      if (e.seq > last) {
        last = e.seq;
        send(e);
      }
    }
    const beat = setInterval(() => res.write(": ping\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(beat);
      unsub();
    });
  });

  // The queue files root sessions name through context.queue_file.
  const queueFiles = (): string[] => {
    const out = new Set<string>();
    for (const s of storage.readAll()) {
      const f = s.context.queue_file;
      if (typeof f === "string" && f !== "") out.add(f);
    }
    return [...out].sort();
  };

  app.get("/api/queues", (_req, res) => {
    res.json(queueFiles());
  });

  // Only a file some session names is readable: the endpoint is not a file server.
  app.get("/api/queue", (req, res) => {
    const file = typeof req.query.file === "string" ? req.query.file : "";
    if (!queueFiles().includes(file)) {
      res.status(404).json({ error: "Queue not named by any session" });
      return;
    }
    try {
      res.json(describeQueue(readQueue(file)));
    } catch (err) {
      res.status(err instanceof QueueError ? 422 : 500).json({ error: (err as Error).message });
    }
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
      await storage
        .appendLedger(ledgerEntry(updated))
        .catch(err => console.error(`Ledger append failed for ${session.session_id}:`, err));
      res.json({ session_id: session.session_id, outcome: "abandoned" });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // Serve dagre from node_modules (works both in dev and when installed as a dependency)
  const require = createRequire(import.meta.url);
  const dagrePath = require.resolve("@dagrejs/dagre/dist/dagre.min.js");
  app.get("/dagre.min.js", (_req, res) => {
    res.sendFile(dagrePath);
  });

  // The route table the page's router imports (src/dashboard-routes.ts, compiled beside this file).
  app.get("/routes.js", (_req, res) => {
    res.sendFile(routesModule);
  });

  // The live map's fold and layout (src/event-fold.ts, src/map-layout.ts), compiled beside the route table.
  for (const name of MAP_MODULES) {
    app.get(`/${name}`, (_req, res) => {
      res.sendFile(path.join(path.dirname(routesModule), name));
    });
  }

  // An unknown /api path is a JSON 404, never the page.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Unknown API endpoint" });
  });

  // Serve dashboard HTML: every view has a real path (src/dashboard-routes.ts), so any GET that is
  // not a static file answers the page and the page's router picks the view.
  const dashboardDir = path.resolve(__dirname, "..", "dashboard");
  app.use(express.static(dashboardDir, { index: false }));

  app.get("*", (_req, res) => {
    res.sendFile(path.join(dashboardDir, "index.html"));
  });

  return app;
}

function tryListen(app: express.Express, port: number): void {
  const host = process.env.DASHBOARD_HOST || "127.0.0.1";
  const server = app.listen(port, host);
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
