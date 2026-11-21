// Lesson records of a landed task -> queue lines or triage rows, by script (`wf-queue <q> --lessons <ID>`).
// The worker and the reviewer of the batch flow hand their records over as the context keys `lessons` and
// `review_lessons` (one JSON document each, `{"lessons": [{id, kind, touches, repro, text}]}`); an exec after
// the land writes them to files and calls `fileLessons`. The dispatcher reads none of it per land:
//   unverified -> a `backlog` line, priority low; arm-rot-on-base -> a `pending` line, priority high (difficulty 4);
//   every other kind and every REFUSED record -> a row of the triage file under `== <ID>`, read in a batch.
// A filed line carries the `repo:` and `workflow:` of the task it came from, and its `touches` are checked
// against that repo. Never throws for a record: a bad one is a triage row, so nothing a task learned is lost.
// A rerun is a no-op: an id already filed with the same text counts as `already`, a triage row already in the
// task's block is not added again.
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import { QueueError, addQueueLine, readQueue, repoNamed, resolveRepo, splitList, } from "./queue.js";
export const LESSON_KINDS = [
    "unverified",
    "reproduced-on-real-tree",
    "loss",
    "arm-rot-on-base",
    "process",
];
/** The kinds the script files itself, with the line each becomes; every other kind is the dispatcher's. */
const FILED = {
    unverified: { status: "backlog", priority: "low" },
    "arm-rot-on-base": { status: "pending", priority: "high", difficulty: 4 },
};
export const MAX_TOUCHES = 8;
const MIN_BRIEF = 30;
const ID_RE = /^[A-Za-z0-9._-]+$/;
const GLOB_RE = /[*?[\]{}]/;
const NEW_RE = /\s*\(new\)$/;
const ROW_TEXT_MAX = 600;
/**
 * The one line the exec prints and the driver's LANDED line carries. It names the triage file when rows
 * were added, so the line alone tells whoever reads the LANDED lines where the rows wait (`--lessons-take`).
 */
export function formatLessons(r) {
    const file = r.triage > 0 && r.triageFile !== undefined ? ` triage_file=${r.triageFile}` : "";
    return `lessons=filed ${r.filed}, triage ${r.triage}${r.already > 0 ? `, already ${r.already}` : ""}${file}`;
}
const flat = (v, max = ROW_TEXT_MAX) => {
    const s = (typeof v === "string" ? v : JSON.stringify(v ?? "")).replace(/\s+/g, " ").trim();
    return s.length > max ? `${s.slice(0, max)} ...` : s;
};
/** `id [kind] reason :: text :: repro :: touches`, one line. */
export function triageRow(r) {
    return `${flat(r.id) || "?"} [${flat(r.kind) || "?"}] ${flat(r.reason)} :: ${flat(r.text)} :: ${flat(r.repro)} :: ${flat(r.touches)}`;
}
const norm = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
const names = (s) => new Set([...s.matchAll(/`([^`\n]{3,})`/g)].map(m => (m[1] ?? "").trim()));
const fileSet = (list) => [...new Set(list.map(t => t.replace(NEW_RE, "").replace(/^\.\//, "").trim()))].sort().join("\n");
/** A parsed record file's entries, or the reason the file is no records document. */
function parseRecords(src) {
    let doc;
    try {
        doc = JSON.parse(src);
    }
    catch (err) {
        return { error: `not JSON (${err.message})` };
    }
    const list = doc?.lessons;
    if (!Array.isArray(list))
        return { error: 'no "lessons" array' };
    return { records: list };
}
function asRecord(raw) {
    const o = (typeof raw === "object" && raw !== null ? raw : {});
    const str = (k) => (typeof o[k] === "string" ? o[k].trim() : "");
    const touches = Array.isArray(o.touches)
        ? o.touches.filter((t) => typeof t === "string").map(t => t.trim())
        : [];
    const rec = {
        id: str("id"),
        kind: str("kind"),
        touches,
        repro: str("repro"),
        text: str("text"),
    };
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return { row: toRow(rec, "record is not an object", raw) };
    return { rec };
}
function toRow(r, reason, raw) {
    return {
        id: r.id,
        kind: r.kind,
        reason,
        text: flat(r.text || (raw === undefined ? "" : raw)),
        repro: flat(r.repro),
        touches: flat(r.touches.join(", ")),
    };
}
/** The first reason a record cannot be filed as a line (kinds already known to be filed), or null. */
function refusal(rec, repo, queue, task) {
    if (!ID_RE.test(rec.id))
        return "id is not [A-Za-z0-9._-]+";
    if (rec.text === "")
        return "text is empty";
    if (rec.repro === "")
        return "repro is empty";
    if (rec.touches.length === 0)
        return "touches is empty";
    if (rec.touches.length > MAX_TOUCHES)
        return `touches has more than ${MAX_TOUCHES} entries`;
    for (const entry of rec.touches) {
        const t = entry.replace(NEW_RE, "").trim();
        if (t === "")
            return "a touches entry is empty";
        if (GLOB_RE.test(t))
            return `touches ${t} is a glob`;
        if (path.isAbsolute(t) || t.split(/[\\/]/).includes(".."))
            return `touches ${t} is outside the repo`;
        const abs = path.join(repo, t);
        let st = null;
        try {
            st = fs.statSync(abs);
        }
        catch {
            st = null;
        }
        if (st !== null && !st.isFile())
            return `touches ${t} is a directory`;
        if (st === null && !NEW_RE.test(entry))
            return `touches ${t} is not in ${repo} (and not marked (new))`;
    }
    const taken = queue.lines.find(l => l.id === rec.id);
    if (taken !== undefined)
        return `id taken by another line (${taken.status})`;
    if (queue.archived.has(rec.id))
        return "id taken by an archived line";
    const open = queue.lines.filter(l => l.id !== task && (l.status === "pending" || l.status === "backlog" || l.status === "running"));
    const brief = norm(rec.text);
    const mine = fileSet(rec.touches);
    const myNames = names(rec.text);
    for (const l of open) {
        if (brief.length >= MIN_BRIEF && norm(l.text).includes(brief))
            return `duplicate of ${l.id}`;
        if (myNames.size > 0 &&
            l.meta.touches !== undefined &&
            fileSet(splitList(l.meta.touches)) === mine &&
            [...names(l.text)].some(n => myNames.has(n)))
            return `duplicate of ${l.id} (same files, same named identifier)`;
    }
    return null;
}
function lineText(task, rec) {
    return `Lesson of ${task} (${rec.kind}; filed by script from the task's records).\n${rec.text}\nRepro: ${rec.repro}`;
}
/** The same record already filed by an earlier run: the same id and the same text, whatever the line's status now. */
function filedBefore(queue, task, rec) {
    return queue.lines.find(l => l.id === rec.id && norm(l.text) === norm(lineText(task, rec)));
}
/**
 * Adds `rows` under the `== <task>` block of the triage file (created when absent; the block made when
 * absent), skipping a row the block already holds verbatim. Returns how many were added and how many were
 * already there. Under a lock beside the file, so two lands never interleave.
 */
export async function appendTriage(file, task, rows) {
    if (rows.length === 0)
        return { added: 0, already: 0 };
    const abs = path.resolve(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    try {
        fs.writeFileSync(abs, "", { flag: "wx" });
    }
    catch (err) {
        if (err.code !== "EEXIST")
            throw err;
    }
    const release = await lockfile.lock(abs, {
        stale: 10_000,
        retries: { retries: 300, minTimeout: 10, maxTimeout: 100, randomize: true },
        realpath: false,
    });
    try {
        const lines = fs.readFileSync(abs, "utf8").split("\n");
        if (lines[lines.length - 1] === "")
            lines.pop();
        const head = `== ${task}`;
        const start = lines.indexOf(head);
        let end = lines.length;
        if (start >= 0) {
            end = start + 1;
            while (end < lines.length && !(lines[end] ?? "").startsWith("== "))
                end++;
        }
        const have = new Set(start >= 0 ? lines.slice(start + 1, end) : []);
        const uniq = [...new Set(rows)];
        const fresh = uniq.filter(r => !have.has(r));
        const already = uniq.length - fresh.length;
        if (fresh.length > 0) {
            if (start < 0)
                lines.push(head, ...fresh);
            else
                lines.splice(end, 0, ...fresh);
            const tmp = `${abs}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, `${lines.join("\n")}\n`);
            fs.renameSync(tmp, abs);
        }
        return { added: fresh.length, already };
    }
    finally {
        await release();
    }
}
/** Files what the task's record files hold. See the head of this file for the rules. */
export async function fileLessons(opts) {
    const rows = [];
    const queue0 = readQueue(opts.queue);
    const origin = queue0.lines.find(l => l.id === opts.task);
    const repo = origin !== undefined ? resolveRepo(queue0, origin) : repoNamed(queue0, opts.repo);
    // One repo for the check and for the filed line: the origin line's own, `--repo` only when it is gone.
    const repoValue = origin !== undefined ? origin.meta.repo : opts.repo;
    const wfRaw = (opts.workflow ?? origin?.meta.workflow ?? "").trim();
    const workflow = wfRaw !== "" && wfRaw !== "-" && wfRaw !== "—" ? wfRaw : undefined;
    let filed = 0;
    let already = 0;
    for (const file of opts.records) {
        let src;
        try {
            src = fs.readFileSync(file, "utf8");
        }
        catch (err) {
            if (err.code === "ENOENT")
                continue;
            throw err;
        }
        if (src.trim() === "")
            continue;
        const parsed = parseRecords(src);
        if ("error" in parsed) {
            rows.push(triageRow({
                id: "?",
                kind: "?",
                reason: `unparseable ${path.basename(file)}: ${parsed.error}`,
                text: flat(src),
                repro: "",
                touches: "",
            }));
            continue;
        }
        for (const raw of parsed.records) {
            const got = asRecord(raw);
            if ("row" in got) {
                rows.push(triageRow(got.row));
                continue;
            }
            const rec = got.rec;
            const queue = readQueue(opts.queue);
            const rule = FILED[rec.kind];
            if (!LESSON_KINDS.includes(rec.kind)) {
                rows.push(triageRow(toRow(rec, `kind ${rec.kind || "(none)"} is not one of ${LESSON_KINDS.join(", ")}`)));
                continue;
            }
            if (rule === undefined) {
                rows.push(triageRow(toRow(rec, "the dispatcher's kind: not filed by script")));
                continue;
            }
            if (filedBefore(queue, opts.task, rec) !== undefined) {
                already++;
                continue;
            }
            const why = repo === null
                ? `origin repo ${repoValue ?? ""} resolves to no directory`
                : refusal(rec, repo, queue, opts.task);
            if (why !== null) {
                rows.push(triageRow(toRow(rec, why)));
                continue;
            }
            try {
                await addQueueLine(opts.queue, {
                    id: rec.id,
                    status: rule.status,
                    ...(rule.difficulty !== undefined ? { difficulty: rule.difficulty } : {}),
                    priority: rule.priority,
                    ...(repoValue !== undefined && repoValue.trim() !== "" ? { repo: repoValue.trim() } : {}),
                    ...(workflow !== undefined ? { workflow } : {}),
                    touches: [...rec.touches],
                    text: lineText(opts.task, rec),
                });
                filed++;
            }
            catch (err) {
                if (!(err instanceof QueueError))
                    throw err;
                rows.push(triageRow(toRow(rec, `queue refused: ${flat(err.message, 200)}`)));
            }
        }
    }
    const t = await appendTriage(opts.triage, opts.task, rows);
    return {
        filed,
        triage: t.added,
        already: already + t.already,
        triageFile: path.resolve(opts.triage),
    };
}
/**
 * Hands the triage file's text to `emit`, then empties the file, all under the lock `appendTriage` takes: a
 * row a land appends meanwhile lands either in what is returned or in the emptied file, never in between. The
 * file is emptied only after `emit` resolved, so a failed or killed output loses no row. A missing file is "".
 */
export async function takeTriage(file, emit = () => undefined) {
    const abs = path.resolve(file);
    if (!fs.existsSync(abs))
        return "";
    const release = await lockfile.lock(abs, {
        stale: 10_000,
        retries: { retries: 300, minTimeout: 10, maxTimeout: 100, randomize: true },
        realpath: false,
    });
    try {
        const text = fs.readFileSync(abs, "utf8");
        if (text !== "") {
            await emit(text);
            fs.writeFileSync(abs, "");
        }
        return text;
    }
    finally {
        await release();
    }
}
