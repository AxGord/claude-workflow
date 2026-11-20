// The calibration report: the ledger (`ledger.jsonl`) folded per project × workflow × difficulty band × stage,
// the figures a `model_table` is tuned from. Pure; src/calibration-cli.ts reads the file and prints.
import path from "node:path";
/** Difficulty bands (the band of a task is its FINAL difficulty); a line without a difficulty is `-`. */
export function bandOf(difficulty) {
    if (difficulty === undefined)
        return "-";
    return difficulty <= 3 ? "1-3" : difficulty <= 6 ? "4-6" : "7-10";
}
/**
 * A task's review rounds: the entries into the state named `review` when the entry has one (a workflow whose review
 * is several states, `review_spawn`, `review_warm`, still enters `review` once per round). Only a workflow with no
 * state of that name falls back to the sum over its `review*` states, routing states `*_route` aside.
 */
export function reviewRounds(visits) {
    if (visits?.review !== undefined)
        return visits.review;
    return Object.entries(visits ?? {})
        .filter(([name]) => name.startsWith("review") && !name.endsWith("_route"))
        .reduce((sum, [, n]) => sum + n, 0);
}
function tokensOf(t) {
    if (t === undefined)
        return 0;
    return t.total ?? Object.values(t).reduce((a, b) => a + b, 0);
}
/**
 * A task's tokens split over its stage rows: a token key naming a stage goes to it; `worker` goes to the execute
 * stage, else fix, plan, or the first non-review stage (the ledger keeps no per-agent tokens: ledger.ts `tokens`);
 * anything else (and the total's remainder) to the first row.
 */
function tokensByStage(e, stages) {
    const out = new Map();
    if (e.tokens === undefined || stages.length === 0)
        return out;
    const add = (k, n) => void out.set(k, (out.get(k) ?? 0) + n);
    const roles = Object.entries(e.tokens).filter(([k, n]) => k !== "total" && n > 0);
    const worker = ["execute", "fix", "plan"].find(s => stages.includes(s)) ??
        stages.find(s => s !== "review") ??
        stages[0];
    for (const [k, n] of roles)
        add(stages.includes(k) ? k : k === "worker" ? worker : stages[0], n);
    add(stages[0], tokensOf(e.tokens) - roles.reduce((s, [, n]) => s + n, 0));
    return out;
}
/**
 * What a task's agents spent at one stage row: each `spend.by_agent` row goes to the stage it was linked at; a row
 * with no stage (a driver linked at the dispatcher's dispatch, an agent only a context key names), or one the task
 * did not run, goes to the stage `-` and never to another stage's row.
 */
function agentsAt(e, stage, stages) {
    const out = { usd: 0, unmeasured: 0, measured: false };
    for (const a of e.spend?.by_agent ?? []) {
        const at = a.stage !== undefined && stages.includes(a.stage) ? a.stage : "-";
        if (at !== stage)
            continue;
        if (a.usd === undefined)
            out.unmeasured += 1;
        else {
            out.usd += a.usd;
            out.measured = true;
        }
    }
    return out;
}
const bump = (m, k) => {
    m[k] = (m[k] ?? 0) + 1;
};
export function calibrate(entries, opts = {}) {
    const rows = new Map();
    const since = opts.since === undefined ? undefined : Date.parse(opts.since);
    for (const e of entries) {
        if (since !== undefined && !(Date.parse(e.ended_at) >= since))
            continue;
        const project = e.project ?? "-";
        if (opts.project !== undefined && project !== path.resolve(opts.project))
            continue;
        const staged = Object.keys(e.stages ?? {});
        const picks = staged.length > 0
            ? staged.map(n => [n, e.stages[n].model, e.stages[n].effort])
            : [["-", e.model ?? "-", e.effort ?? "-"]];
        const band = bandOf(e.difficulty);
        const claimOff = e.claim_difficulty !== undefined &&
            e.difficulty !== undefined &&
            Math.abs(e.difficulty - e.claim_difficulty) >= 2;
        const roundsAt = Math.max(0, picks.findIndex(p => p[0] === "review"));
        const rowOf = (stage, model, effort) => {
            const key = JSON.stringify([project, e.workflow, band, stage, model, effort]);
            let row = rows.get(key);
            if (row === undefined) {
                row = {
                    project,
                    workflow: e.workflow ?? "-",
                    band,
                    stage,
                    model,
                    effort,
                    tasks: 0,
                    review_rounds: 0,
                    escalations: 0,
                    tokens: 0,
                    usd: 0,
                    spent_tasks: 0,
                    unmeasured: 0,
                    findings: 0,
                    claim_off: 0,
                    outcomes: {},
                    verdicts: {},
                };
                rows.set(key, row);
            }
            return row;
        };
        picks.forEach(([stage, model, effort], i) => {
            const row = rowOf(stage, model, effort);
            row.tasks += 1;
            if (claimOff)
                row.claim_off += 1;
            bump(row.outcomes, e.outcome ?? "-");
            if (e.verdict !== undefined)
                bump(row.verdicts, e.verdict);
            if (i === roundsAt)
                row.review_rounds += reviewRounds(e.visits);
            row.tokens +=
                tokensByStage(e, picks.map(p => p[0])).get(stage) ?? 0;
            const spent = agentsAt(e, stage, picks.map(p => p[0]));
            row.usd += spent.usd;
            row.unmeasured += spent.unmeasured;
            if (spent.measured)
                row.spent_tasks += 1;
            if (i === 0) {
                row.escalations += e.escalations ?? 0;
            }
            if (i === roundsAt && opts.findingsKey !== undefined)
                row.findings += e.counts?.[opts.findingsKey] ?? 0;
        });
        const names = picks.map(p => p[0]);
        if (!names.includes("-")) {
            const loose = agentsAt(e, "-", names);
            if (loose.measured || loose.unmeasured > 0) {
                const row = rowOf("-", "-", "-");
                row.tasks += 1;
                row.usd += loose.usd;
                row.unmeasured += loose.unmeasured;
                if (loose.measured)
                    row.spent_tasks += 1;
            }
        }
    }
    return [...rows.values()].sort((a, b) => JSON.stringify([a.project, a.workflow, a.band, a.stage, a.model, a.effort]).localeCompare(JSON.stringify([b.project, b.workflow, b.band, b.stage, b.model, b.effort])));
}
const fmt = (m) => Object.entries(m)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => `${k}:${n}`)
    .join(",") || "-";
/** A USD figure of a stage row: `-` when no task measured an agent there, `>=` when some agent there is unmeasured. */
function dollars(usd, unmeasured, spentTasks) {
    if (spentTasks === 0)
        return "-";
    return `${unmeasured > 0 ? ">=" : ""}${usd.toFixed(2)}`;
}
export function formatCalibration(rows, findings) {
    const head = [
        "project",
        "workflow",
        "band",
        "stage",
        "model/effort",
        "tasks",
        "rounds",
        "esc",
        "tokens",
        "claim",
        "$",
        "$/task",
        ...(findings ? ["findings"] : []),
        "outcomes",
        "verdicts",
    ];
    const body = rows.map(r => [
        r.project,
        r.workflow,
        r.band,
        r.stage,
        `${r.model}/${r.effort}`,
        String(r.tasks),
        String(r.review_rounds),
        String(r.escalations),
        String(r.tokens),
        String(r.claim_off),
        dollars(r.usd, r.unmeasured, r.spent_tasks),
        dollars(r.usd / Math.max(r.spent_tasks, 1), r.unmeasured, r.spent_tasks),
        ...(findings ? [String(r.findings)] : []),
        fmt(r.outcomes),
        fmt(r.verdicts),
    ]);
    const w = head.map((h, i) => Math.max(h.length, ...body.map(b => b[i].length)));
    return [head, ...body]
        .map(l => l
        .map((c, i) => c.padEnd(w[i]))
        .join("  ")
        .trimEnd())
        .join("\n");
}
/**
 * Keyed by model id; a key also matches any id containing it, the longest key wins, so a dated id
 * takes its model's rate and a bare family key (`opus`) is the fallback for an unknown id of that
 * family (priced as the family's newest). Source: Anthropic list prices, claude-api skill table
 * cached 2026-11-18. A 1-hour cache write costs twice the input rate. Haiku 5.5 prompts over 100K
 * tokens cost $0.50 / $2.50: not modelled, so such a turn is under-priced.
 */
export const TURN_RATES_USD_PER_MTOK = {
    "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
    "claude-opus-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-8": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-7": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-6": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
    "claude-opus-4-1": { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
    "claude-opus-4-2": { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
    "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
    "claude-sonnet-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
    "claude-sonnet-4": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
    "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
    "claude-fable-5-2": { input: 8, output: 40, cache_read: 0.2, cache_write: 10 },
    "claude-fable-5-1": { input: 10, output: 50, cache_read: 0.25, cache_write: 12.5 },
    "claude-fable-5": { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
    opus: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
    sonnet: { input: 2, output: 10, cache_read: 0.1, cache_write: 2.5 },
    haiku: { input: 0.1, output: 0.5, cache_read: 0.01, cache_write: 0.125 },
    fable: { input: 8, output: 40, cache_read: 0.2, cache_write: 10 },
};
/**
 * The price table: blended USD per million tokens by model family (the ledger holds a token count per task or role,
 * not an input/output split, so a price is one estimate over the usual mix: 75% input, 25% output). It is derived
 * from the bare family keys of `TURN_RATES_USD_PER_MTOK`, the one owner of a rate, so the two cannot drift
 * (Opus 5.5 at $4/$20 blends to $8, Fable 5.2 at $8/$40 to $16). The Cost tab lists it; a stage's estimate goes by
 * `priceOf` (the row's full model id), this table being the family blends. Edit a rate and
 * `PRICES_UPDATED` together.
 */
export const PRICES_USD_PER_MTOK = Object.fromEntries(["opus", "sonnet", "haiku", "fable"].map(f => [
    f,
    0.75 * TURN_RATES_USD_PER_MTOK[f].input + 0.25 * TURN_RATES_USD_PER_MTOK[f].output,
]));
export const PRICES_UPDATED = "2026-11-18";
/** The rates of a model id: the longest key of `TURN_RATES_USD_PER_MTOK` the id contains; undefined when none. */
function ratesOf(model) {
    const m = model.toLowerCase();
    const key = Object.keys(TURN_RATES_USD_PER_MTOK)
        .filter(k => m.includes(k))
        .sort((x, y) => y.length - x.length)[0];
    return key === undefined ? undefined : TURN_RATES_USD_PER_MTOK[key];
}
/** The USD of one transcript turn priced by its own model; undefined when the model has no rate. */
export function turnUsd(model, u) {
    const r = ratesOf(model);
    if (r === undefined)
        return undefined;
    return ((u.input * r.input +
        u.output * r.output +
        u.cache_read * r.cache_read +
        u.cache_write_5m * r.cache_write +
        u.cache_write_1h * r.input * 2) /
        1e6);
}
/**
 * The blended price of a model id (75% input, 25% output) by the same longest-key match `turnUsd` uses: an older id
 * of a family (`claude-opus-4-1`) takes its own rate, a bare family name (`sonnet`) or an unknown id of a family
 * takes the family's; undefined when no key matches.
 */
export function priceOf(model) {
    const r = ratesOf(model);
    return r === undefined ? undefined : 0.75 * r.input + 0.25 * r.output;
}
/**
 * Landed = completed through a `land` state (`project_land`; `land_failed` is not one); failed = any other ending than
 * completed; closed = completed without landing; unknown = completed on a line that recorded no visits.
 */
export function costOutcome(e) {
    if (e.outcome !== "completed")
        return "failed";
    if (e.visits === undefined)
        return "unknown";
    const landed = Object.entries(e.visits).some(([n, v]) => v > 0 && /(^|_)land$/.test(n));
    return landed ? "landed" : "closed";
}
/**
 * A task's tokens as run, one row per token key: `tokens_<stage>` is that stage at its model; `tokens_worker` is one
 * unsplit `worker` row at the task's model (else the execute stage's); any other role at the task's model; whatever
 * the total holds beyond the roles is a `-` row at the task's model. No tokens, no rows.
 */
export function costStages(e) {
    const t = e.tokens ?? {};
    const roles = Object.entries(t).filter(([k, n]) => k !== "total" && n > 0);
    const total = tokensOf(e.tokens);
    const rest = total - roles.reduce((sum, [, n]) => sum + n, 0);
    const rows = [...roles];
    if (rest > 0)
        rows.push(["-", rest]);
    return rows.map(([stage, tokens]) => {
        const own = e.stages?.[stage];
        const model = own?.model ?? e.model ?? e.stages?.execute?.model ?? "-";
        const effort = own?.effort ?? e.effort ?? e.stages?.execute?.effort ?? "-";
        const price = priceOf(model);
        return {
            stage,
            model,
            effort,
            tokens,
            usd: price === undefined ? undefined : (tokens * price) / 1e6,
        };
    });
}
function localDayOf(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const perLanded = (usd, landed) => landed === 0 ? null : usd / landed;
/** The cost report over a day range (`from`..`to` inclusive, YYYY-MM-DD, local days) plus the 14-day $/landed trend ending at `to`. */
export function buildCost(entries, from, to) {
    const tasks = [];
    for (const e of entries) {
        if (e.task === undefined)
            continue;
        if (e.spend === undefined &&
            Object.keys(e.tokens ?? {}).length === 0 &&
            Object.keys(e.stages ?? {}).length === 0)
            continue;
        const ended = Date.parse(e.ended_at);
        if (Number.isNaN(ended))
            continue;
        const stages = costStages(e);
        const spend = e.spend?.usd !== undefined ? e.spend : undefined;
        const spendTokens = spend
            ? spend.input + spend.output + spend.cache_read + spend.cache_write
            : 0;
        tasks.push({
            session_id: e.session_id,
            task: e.task,
            workflow: e.workflow ?? "-",
            day: localDayOf(ended),
            ended_at: e.ended_at,
            outcome: costOutcome(e),
            rounds: reviewRounds(e.visits),
            measured: spend ? true : e.spend ? false : stages.length > 0,
            tokens: spend ? spendTokens : e.spend ? 0 : stages.reduce((s, x) => s + x.tokens, 0),
            usd: spend ? (spend.usd ?? 0) : e.spend ? 0 : stages.reduce((s, x) => s + (x.usd ?? 0), 0),
            stages: spend
                ? [
                    {
                        stage: "spend",
                        model: "transcripts",
                        effort: "-",
                        tokens: spendTokens,
                        usd: spend.usd,
                    },
                ]
                : e.spend
                    ? []
                    : stages,
        });
    }
    tasks.sort((a, b) => a.ended_at.localeCompare(b.ended_at));
    const inRange = tasks.filter(t => t.day >= from && t.day <= to);
    const sum = (ts) => ({
        tasks: ts.length,
        landed: ts.filter(t => t.outcome === "landed").length,
        measured_landed: ts.filter(t => t.outcome === "landed" && t.measured).length,
        tokens: ts.reduce((s, t) => s + t.tokens, 0),
        usd: ts.reduce((s, t) => s + t.usd, 0),
    });
    const totals = sum(inRange);
    const [y, m, d] = to.split("-").map(Number);
    const trend = [];
    for (let i = 13; i >= 0; i--) {
        const day = localDayOf(new Date(y, m - 1, d - i).getTime());
        const s = sum(tasks.filter(t => t.day === day));
        trend.push({ day, ...s, usd_per_landed: perLanded(s.usd, s.measured_landed) });
    }
    return {
        from,
        to,
        prices: {
            usd_per_mtok: PRICES_USD_PER_MTOK,
            updated: PRICES_UPDATED,
            source: "src/calibration.ts PRICES_USD_PER_MTOK: blended USD per million tokens by model family, 75% input / 25% output of TURN_RATES_USD_PER_MTOK",
        },
        tasks: inRange,
        totals: { ...totals, usd_per_landed: perLanded(totals.usd, totals.measured_landed) },
        trend,
    };
}
