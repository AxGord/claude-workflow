import express from "express";
import path from "node:path";
import { createRequire } from "node:module";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describeWorkflows } from "./workflow-describe.js";
import { Pool, poolSnapshot, projectNameOf, resolvePoolDir } from "./pool.js";
import { ledgerEntry } from "./ledger.js";
import { measureSpend, subtreeOf } from "./spend.js";
import { buildCost } from "./calibration.js";
import { buildTimeline, localDay } from "./timeline.js";
import { describeQueue, readQueue, QueueError } from "./queue.js";
/** An operator file in the state directory: state name -> stage group, over the timeline's defaults. */
const TIMELINE_GROUPS_FILE = "timeline-groups.conf";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** The compiled route table the page imports as `/routes.js` (a test serves a transpiled copy instead). */
const ROUTES_MODULE = path.join(__dirname, "dashboard-routes.js");
/** The live map's pure modules, compiled beside the route table and served under these names. */
const MAP_MODULES = ["event-fold.js", "map-layout.js"];
let brandModule;
function loadBrand() {
    brandModule ??= import(pathToFileURL(path.resolve(__dirname, "..", "scripts", "brand.mjs")).href);
    return brandModule;
}
export function buildApp(storage, loader, routesModule = ROUTES_MODULE, pool = new Pool(resolvePoolDir())) {
    const app = express();
    app.use(express.json());
    // API endpoints
    app.get("/api/sessions", (_req, res) => {
        const sessions = storage
            .readAll()
            .map(s => ({ ...s, project: s.context?.project ?? projectNameOf(s.context?.cwd) }));
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
        res.json(describeWorkflows(loader.getAll()));
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
        const send = (e) => {
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
    const queueFiles = () => {
        const out = new Set();
        for (const s of storage.readAll()) {
            const f = s.context.queue_file;
            if (typeof f === "string" && f !== "")
                out.add(f);
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
        }
        catch (err) {
            res.status(err instanceof QueueError ? 422 : 500).json({ error: err.message });
        }
    });
    // The cost rows of the named queue lines from the whole ledger (the plan pane cannot read the ledger itself: the plugin API refuses a file over 4 MiB). JSON lines, one per ledger row; ids are comma-separated.
    app.get("/api/ledger-rows", (req, res) => {
        const tasks = typeof req.query.tasks === "string" ? req.query.tasks.split(",").filter(t => t !== "") : [];
        res.type("text/plain").send(storage.readLedgerTaskRows(tasks).join("\n"));
    });
    // The Timeline tab: the day's task pipelines cut into segments by state, from the session files and the ledger.
    app.get("/api/timeline", (req, res) => {
        const now = Date.now();
        const day = typeof req.query.day === "string" ? req.query.day : localDay(now);
        const raw = storage.readStateJson(TIMELINE_GROUPS_FILE);
        const groups = {};
        if (raw !== null && typeof raw === "object")
            for (const [k, v] of Object.entries(raw))
                if (typeof v === "string")
                    groups[k] = v;
        const root = typeof req.query.root === "string" && req.query.root !== "" ? req.query.root : undefined;
        const timeline = buildTimeline({
            sessions: storage.readAll(),
            ledger: storage.readLedger(),
            day,
            ...(root !== undefined ? { root } : {}),
            now,
            groups,
        });
        if (timeline === null) {
            res.status(400).json({ error: "day must be YYYY-MM-DD" });
            return;
        }
        res.json(timeline);
    });
    // The Pool tab: the machine-wide pool through the pool module, as `pool_status` reads it (one measured pass).
    // `?counts=1` is the cheap read for a label (`budget`, `held` of one plain pass, no measuring window).
    app.get("/api/pool", async (req, res) => {
        try {
            if (req.query.counts === "1") {
                const { budget, held } = poolSnapshot(await pool.status());
                res.json({ budget, held });
                return;
            }
            res.json(poolSnapshot(await pool.measuredStatus()));
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // The Cost tab: tokens and USD per finished task pipeline in a day range, from the ledger and the calibration price table.
    app.get("/api/cost", (req, res) => {
        const day = /^\d{4}-\d{2}-\d{2}$/;
        const today = localDay(Date.now());
        const q = (k) => {
            const v = req.query[k];
            return typeof v === "string" ? v : "";
        };
        const from = q("from") || today;
        const to = q("to") || from;
        if (!day.test(from) || !day.test(to) || from > to) {
            res.status(400).json({ error: "from and to must be YYYY-MM-DD, from <= to" });
            return;
        }
        res.json(buildCost(storage.readLedger(), from, to));
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
            const updated = {
                ...session,
                stack: [],
                active_frame: -1,
                updated_at: now,
                history: [...session.history, { frame: session.active_frame, event: "abandon", at: now }],
                outcome: "abandoned",
            };
            await storage.write(session.session_id, updated);
            await storage
                .appendLedger(ledgerEntry(updated, measureSpend(subtreeOf(updated, storage.readAll()), updated.started_at, now)))
                .catch(err => console.error(`Ledger append failed for ${session.session_id}:`, err));
            res.json({ session_id: session.session_id, outcome: "abandoned" });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
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
    // The tab icon is the site's favicon, drawn by the same function that writes docs/public/favicon.svg.
    app.get("/favicon.svg", async (_req, res) => {
        try {
            res.type("image/svg+xml").send((await loadBrand()).faviconSvg());
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // Serve dashboard HTML: every view has a real path (src/dashboard-routes.ts), so any GET that is
    // not a static file answers the page and the page's router picks the view.
    const dashboardDir = path.resolve(__dirname, "..", "dashboard");
    // The page carries the brand's name as `{{BRAND}}` (title and heading), filled from scripts/brand.mjs.
    const sendPage = async (_req, res) => {
        try {
            const html = fs.readFileSync(path.join(dashboardDir, "index.html"), "utf8");
            res.type("html").send(html.replaceAll("{{BRAND}}", (await loadBrand()).NAME));
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    };
    app.get("/index.html", sendPage);
    app.use(express.static(dashboardDir, { index: false }));
    app.get("*", sendPage);
    return app;
}
function tryListen(app, port) {
    const host = process.env.DASHBOARD_HOST || "127.0.0.1";
    const server = app.listen(port, host);
    server.on("listening", () => {
        console.error(`Dashboard running at http://localhost:${port}`);
    });
    server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
            console.error(`Dashboard port ${port} in use — retrying in 20s`);
            setTimeout(() => tryListen(app, port), 20_000);
        }
        else {
            console.error(`Dashboard error: ${err.message}`);
        }
    });
}
export function createDashboard(storage, loader, port) {
    const app = buildApp(storage, loader);
    tryListen(app, port);
}
