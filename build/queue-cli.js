#!/usr/bin/env node
// wf-queue: the exec form of queue_next / queue_mark (src/queue.ts), for a workflow's exec states.
// The queue: `<queue.yaml>` (a full path), or `--queue NAME` (.claude/batch/NAME.yaml of the cwd's project),
// or nothing (.claude/batch/queue.yaml); `wf-queue [<queue.yaml>|--queue NAME] --path` prints the resolved file.
//   wf-queue <q> [--dry-run] [--explain|--explain-all]   pick: stdout one `ID\tmodel\teffort\trepo\tworkflow\tdifficulty\tkind` per admitted task
//                                                 (set running), the summary on stderr; --explain folds
//                                                 "window full" tasks into one, --explain-all lists all
//   wf-queue <q> --done|--failed|--release|--running|--promote|--shelve <ID> [--note TEXT] [--from WHO]
//   wf-queue <q> --running <ID> --retry [--note TEXT]   a failed task again: failed → running, its difficulty +1 (≤10)
//   wf-queue <q> --running <ID> --force REASON    mark a line the picker would not admit; the reason goes to its notes
//   wf-queue <q> --header <key>                   the header's value of <key> (empty when absent)
//   wf-queue <q> --add <YAML-MAPPING> [--after <ID>|--before <ID>]       queue_add (`{id: X, difficulty: 3, touches: [a], text: …}`)
//   wf-queue <q> --edit <ID> [--set key=value]… [--append-note TEXT] [--from WHO]   queue_edit (`key=` removes)
//   wf-queue <q> --lessons <ID> --records <file>… [--triage <file>] [--repo <dir>: the filed repo only when the origin line is gone] [--workflow <name>]   (triage: the flag, else the header's `lessons_triage:`, else ../backups/slice-logs/lessons-triage.txt)  the lesson records of a landed task as queue lines / triage rows (src/lessons-file.ts); prints `lessons=filed N, triage M[, already K]`, exit 0 for any record, 2 for usage / an unreadable queue
//   wf-queue <q> --lessons-take [--triage <file>]   prints the triage file, then empties it (only once the rows are out), under the lock a land's append takes
//   wf-queue <q> --batch-size <N> --reason TEXT                   queue_header (the window)
//   wf-queue <q> --header-set archive_after_days=N | exclusive_hold=yes|no [--reason TEXT]   queue_header (a header key: N ≥ 1 / yes|no, `key=` removes; any other key refused; --reason is echoed, not written)
//   wf-queue <q> --archive --older-than <days> [--include-unended] [--dry-run]   the manual archive (done/failed lines → <q>.archive.yaml); a pick does it by the header's archive_after_days
//   wf-queue <q> --restore <ID>   one archived line back into the queue (CLI only, no MCP tool)
//   wf-queue --convert <old.md|config.json> [--into <file.yaml>] [--status S] [--dry-run]
//       an old Markdown queue (or a JSON config) as YAML: printed without --into; --into a new file
//       writes it; --into an existing queue appends the old queue's open tasks with --status (default backlog;
//       --status pending refuses, exit 2 and no file written or changed, a task with no difficulty:)
// Exit: 0 admitted ≥1 · 10 nothing admitted, running tasks still run · 11 nothing admitted and nothing
// runs (done; what stays pending is blocked) · 12 nothing runs and batch_size is 0 (paused) · 2 error.
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";
import { fileLessons, formatLessons, takeTriage } from "./lessons-file.js";
import { appendMarkdown, jsonToYaml, markdownToYaml } from "./queue-convert.js";
import { QUEUE_EXIT, QueueError, addQueueLine, archiveQueue, editQueueLine, formatArchive, formatMark, formatPickSummary, formatTask, markQueue, pickQueue, readQueue, refuseArchivedIds, restoreQueue, rewriteQueue, resolveQueueFile, formatHeaderKey, setQueueHeaderKey, setQueueWindow, STATUSES, } from "./queue.js";
const USAGE = "usage: wf-queue [<queue.yaml>|--queue NAME] [--dry-run] [--explain|--explain-all] | --done|--failed|--release|--running|--promote|--shelve <ID> [--retry] [--force REASON] [--note TEXT] [--from WHO] | --header <key> | --path" +
    " | --add <YAML-MAPPING> [--after ID|--before ID] | --edit <ID> [--set key=value]… [--append-note TEXT] [--from WHO] | --lessons <ID> --records FILE… [--triage FILE] [--repo DIR] [--workflow NAME] | --lessons-take [--triage FILE] | --batch-size <N> --reason TEXT | --header-set archive_after_days=N|exclusive_hold=yes|no [--reason TEXT] | --archive --older-than <days> [--include-unended] [--dry-run] | --restore <ID>" +
    " | --convert <old.md|config.json> [--into FILE.yaml] [--status S] [--dry-run]";
/** `--flag value` pairs after an op; a flag outside `allowed`, a missing value, or a repeat of a non-list flag is a usage error. */
function options(rest, allowed, lists = [], bare = []) {
    const out = new Map();
    for (let i = 0; i < rest.length; i++) {
        const flag = rest[i];
        if (!allowed.includes(flag) && !bare.includes(flag))
            throw new QueueError(USAGE);
        const value = bare.includes(flag) ? "" : rest[++i];
        if (value === undefined)
            throw new QueueError(`${flag} needs a value`);
        const prev = out.get(flag);
        if (prev && !lists.includes(flag))
            throw new QueueError(`${flag} given twice`);
        out.set(flag, [...(prev ?? []), value]);
    }
    return out;
}
const MARKS = {
    "--done": "done",
    "--failed": "failed",
    "--release": "released",
    "--running": "running",
    "--promote": "promoted",
    "--shelve": "shelved",
};
/** `--convert`: prints, writes or appends (under the queue's lock); returns what it printed. */
async function convert(args) {
    const src = args[0];
    if (!src || src.startsWith("--"))
        throw new QueueError("--convert needs a file");
    const o = options(args.slice(1), ["--into", "--status"], [], ["--dry-run"]);
    const text = fs.readFileSync(src, "utf8");
    const status = o.get("--status")?.[0];
    if (status !== undefined && !STATUSES.includes(status))
        throw new QueueError(`--status is one of ${STATUSES.join(", ")}`);
    const into = o.get("--into")?.[0];
    const isJson = /\.json$/i.test(src);
    if (isJson && status !== undefined)
        throw new QueueError("--status is for a queue");
    const appending = into !== undefined && fs.existsSync(into);
    if (isJson && appending)
        throw new QueueError(`${into} exists: a config is converted once`);
    // the append may run more than once (a changed queue is re-read): each warning prints once
    const warned = new Set();
    const warnOnce = (line) => {
        if (!warned.has(line))
            process.stderr.write(`wf-queue: ${line}\n`);
        warned.add(line);
    };
    if (appending) {
        const append = (cur) => appendMarkdown(cur, text, status ?? "backlog", src, warnOnce);
        if (o.has("--dry-run")) {
            const q = readQueue(into);
            const r = append(q.source);
            refuseArchivedIds(q, r.text);
            return r.text;
        }
        const added = await rewriteQueue(into, cur => {
            const r = append(cur);
            return { text: r.text, answer: r.added };
        });
        return `appended ${added} task(s) to ${path.resolve(into)}\n`;
    }
    const out = isJson ? jsonToYaml(text) : markdownToYaml(text, src, status, warnOnce);
    if (into === undefined || o.has("--dry-run"))
        return out;
    fs.mkdirSync(path.dirname(path.resolve(into)), { recursive: true });
    fs.writeFileSync(into, out, { flag: "wx" });
    return `wrote ${path.resolve(into)}\n`;
}
/** Writes to stdout and resolves when the stream took it; rejects when it fails (a closed pipe). */
async function out(text) {
    const write = process.stdout.write.bind(process.stdout);
    await promisify(write)(text);
}
/** The triage file: `--triage`, else the header's `lessons_triage:` (relative = beside the queue), else `../backups/slice-logs/lessons-triage.txt` of the queue's directory. */
function triageFile(queue, flag) {
    const dir = path.dirname(queue);
    if (flag !== undefined)
        return path.resolve(flag);
    const head = readQueue(queue).header.lessons_triage?.trim();
    if (head)
        return path.resolve(dir, head);
    return path.resolve(dir, "..", "backups", "slice-logs", "lessons-triage.txt");
}
async function main(args) {
    if (args[0] === "--convert") {
        process.stdout.write(await convert(args.slice(1)));
        return 0;
    }
    let sel;
    if (args[0] === "--queue") {
        const name = args[1];
        if (!name || name.startsWith("--"))
            throw new QueueError(USAGE);
        sel = { queue: name };
        args.splice(0, 2);
    }
    else if (args[0] === undefined || args[0].startsWith("--")) {
        sel = {};
    }
    else {
        sel = { file: args.shift() };
    }
    const file = resolveQueueFile(sel);
    const op = args[0];
    if (op !== undefined && op in MARKS) {
        const id = args[1];
        if (!id)
            throw new QueueError(`${op} needs a task id`);
        const o = options(args.slice(2), ["--note", "--from", ...(op === "--running" ? ["--force"] : [])], [], op === "--running" ? ["--retry"] : []);
        const from = o.get("--from")?.[0];
        const r = await markQueue(file, id, MARKS[op], o.get("--note")?.[0], {
            retry: o.has("--retry"),
            ...(o.get("--force")?.[0] !== undefined ? { force: o.get("--force")?.[0] } : {}),
            ...(from !== undefined ? { from } : {}),
        });
        process.stdout.write(`${formatMark(r)}\n`);
        return 0;
    }
    if (op === "--path") {
        if (args.length !== 1)
            throw new QueueError(USAGE);
        process.stdout.write(file);
        return 0;
    }
    if (op === "--header") {
        if (!args[1] || args.length !== 2)
            throw new QueueError(USAGE);
        process.stdout.write(readQueue(file).header[args[1]] ?? "");
        return 0;
    }
    if (op === "--add") {
        if (!args[1])
            throw new QueueError("--add needs a task (a YAML mapping)");
        const o = options(args.slice(2), ["--after", "--before"]);
        let task;
        try {
            task = YAML.parse(args[1]);
        }
        catch (err) {
            throw new QueueError(`--add: not YAML: ${err.message}`);
        }
        if (typeof task !== "object" || task === null || Array.isArray(task))
            throw new QueueError("--add takes a YAML mapping: {id: X, difficulty: 3, touches: [a], text: …}");
        const r = await addQueueLine(file, task, {
            after: o.get("--after")?.[0],
            before: o.get("--before")?.[0],
        }, { create: sel.file === undefined });
        process.stdout.write(`${r.id}: added at line ${r.lineNo}${r.created ? `; the queue did not exist — created ${file}` : ""}\n`);
        for (const w of r.warnings ?? [])
            process.stderr.write(`warning: ${w}\n`);
        return 0;
    }
    if (op === "--edit") {
        if (!args[1])
            throw new QueueError("--edit needs a task id");
        const o = options(args.slice(2), ["--set", "--append-note", "--from"], ["--set"]);
        const set = {};
        for (const kv of o.get("--set") ?? []) {
            const eq = kv.indexOf("=");
            if (eq <= 0)
                throw new QueueError(`--set takes key=value, not "${kv}"`);
            set[kv.slice(0, eq)] = kv.slice(eq + 1);
        }
        const r = await editQueueLine(file, args[1], set, o.get("--append-note")?.[0], o.get("--from")?.[0]);
        process.stdout.write(`${r.task}\n`);
        for (const w of r.warnings ?? [])
            process.stderr.write(`warning: ${w}\n`);
        return 0;
    }
    if (op === "--archive") {
        const o = options(args.slice(1), ["--older-than"], [], ["--include-unended", "--dry-run"]);
        const days = o.get("--older-than")?.[0];
        if (days === undefined || !/^\d+$/.test(days))
            throw new QueueError("--archive needs --older-than <days> (a whole number)");
        const r = await archiveQueue(file, {
            olderThanDays: Number(days),
            includeUnended: o.has("--include-unended"),
            dryRun: o.has("--dry-run"),
        });
        process.stdout.write(`${formatArchive(r)}\n`);
        return 0;
    }
    if (op === "--restore") {
        if (!args[1] || args.length !== 2)
            throw new QueueError("--restore needs one task id");
        const r = await restoreQueue(file, args[1]);
        process.stdout.write(r.inQueue
            ? `${r.id}: already in ${file}; removed the copy in ${r.archive}\n`
            : `restored ${r.id} (${r.status}) ← ${r.archive}\n`);
        return 0;
    }
    if (op === "--lessons-take") {
        const o = options(args.slice(1), ["--triage"]);
        await takeTriage(triageFile(file, o.get("--triage")?.[0]), text => out(text));
        return 0;
    }
    if (op === "--lessons") {
        if (!args[1] || args[1].startsWith("--"))
            throw new QueueError("--lessons needs the task id");
        const o = options(args.slice(2), ["--records", "--triage", "--repo", "--workflow"], ["--records"]);
        const records = o.get("--records") ?? [];
        if (records.length === 0)
            throw new QueueError("--lessons needs --records FILE");
        const repo = o.get("--repo")?.[0];
        const workflow = o.get("--workflow")?.[0];
        const r = await fileLessons({
            queue: file,
            task: args[1],
            records,
            triage: triageFile(file, o.get("--triage")?.[0]),
            ...(repo !== undefined ? { repo } : {}),
            ...(workflow !== undefined ? { workflow } : {}),
        });
        process.stdout.write(`${formatLessons(r)}\n`);
        return 0;
    }
    if (op === "--batch-size") {
        const o = options(args.slice(2), ["--reason"]);
        const n = args[1] !== undefined && /^\d+$/.test(args[1]) ? Number(args[1]) : Number.NaN;
        if (Number.isNaN(n))
            throw new QueueError("--batch-size needs a whole number");
        const reason = o.get("--reason")?.[0];
        if (reason === undefined)
            throw new QueueError("--batch-size needs --reason TEXT");
        const r = await setQueueWindow(file, n, reason);
        process.stdout.write(`batch_size ${r.from} → ${r.to}  # ${r.reason}\n`);
        return 0;
    }
    if (op === "--header-set") {
        const o = options(args.slice(2), ["--reason"]);
        const kv = args[1] ?? "";
        const eq = kv.indexOf("=");
        if (eq < 1)
            throw new QueueError("--header-set needs key=value (`key=` removes the key)");
        const key = kv.slice(0, eq);
        const raw = kv.slice(eq + 1);
        const numeric = key !== "exclusive_hold";
        if (raw !== "" && numeric && !/^\d+$/.test(raw))
            throw new QueueError(`--header-set ${key}: a whole number ≥ 1, or empty to remove`);
        const r = await setQueueHeaderKey(file, key, raw === "" ? null : numeric ? Number(raw) : raw);
        const why = o.get("--reason")?.[0];
        process.stdout.write(`${formatHeaderKey(r)}${why === undefined ? "" : `  # ${why}`}\n`);
        return 0;
    }
    const unknown = args.find(a => a !== "--dry-run" && a !== "--explain" && a !== "--explain-all");
    if (unknown !== undefined)
        throw new QueueError(`unknown argument ${unknown}\n${USAGE}`);
    const r = await pickQueue(file, { dryRun: args.includes("--dry-run") });
    for (const a of r.admitted)
        process.stdout.write(`${formatTask(a)}\n`);
    process.stderr.write(`${formatPickSummary(r, args.includes("--explain-all") ? "all" : args.includes("--explain"))}\n`);
    return r.code;
}
main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
}, (err) => {
    process.stderr.write(`wf-queue: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = QUEUE_EXIT.ERROR;
});
