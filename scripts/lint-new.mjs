#!/usr/bin/env node
// Lint gate: fails only on eslint findings that are not in eslint-baseline.json.
// Findings are compared as a multiset of (file, rule, message) - line numbers are ignored,
// so unrelated edits that shift lines never raise a false alarm.
//   node scripts/lint-new.mjs                    gate: exit 1 on new findings
//   node scripts/lint-new.mjs --update-baseline  rewrite the baseline from the current tree
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "eslint-baseline.json");
const update = process.argv.includes("--update-baseline");

const run = spawnSync(
  process.execPath,
  [join(root, "node_modules/eslint/bin/eslint.js"), ".", "-f", "json"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error(`eslint failed (exit ${run.status}):\n${run.stderr || run.stdout}`);
  process.exit(2);
}

const key = (e) => JSON.stringify([e.file, e.rule, e.message]);
const current = new Map();
const where = new Map();
for (const f of report) {
  for (const m of f.messages) {
    const e = { file: relative(root, f.filePath), rule: m.ruleId ?? "(parse)", message: m.message };
    const k = key(e);
    current.set(k, (current.get(k) ?? 0) + 1);
    where.set(k, [...(where.get(k) ?? []), m.line]);
  }
}

if (update) {
  const entries = [...current].map(([k, count]) => {
    const [file, rule, message] = JSON.parse(k);
    return { file, rule, message, count };
  });
  entries.sort((a, b) => key(a).localeCompare(key(b)));
  writeFileSync(baselinePath, JSON.stringify(entries, null, 2) + "\n");
  console.log(`baseline: ${entries.length} entries, ${[...current.values()].reduce((a, b) => a + b, 0)} findings`);
  process.exit(0);
}

if (!existsSync(baselinePath)) {
  console.error("eslint-baseline.json missing; run: node scripts/lint-new.mjs --update-baseline");
  process.exit(2);
}
const baseline = new Map(
  JSON.parse(readFileSync(baselinePath, "utf8")).map((e) => [key(e), e.count]),
);

let added = 0;
let fixed = 0;
for (const [k, n] of current) {
  const extra = n - (baseline.get(k) ?? 0);
  if (extra > 0) {
    added += extra;
    const [file, rule, message] = JSON.parse(k);
    console.error(`NEW ${file} (lines ${where.get(k).join(",")}) ${rule}: ${message}`);
  }
}
for (const [k, n] of baseline) fixed += Math.max(0, n - (current.get(k) ?? 0));

if (added > 0) {
  console.error(`lint: ${added} new finding(s) over baseline`);
  process.exit(1);
}
console.log(`lint: no new findings (baseline debt left: ${[...baseline.values()].reduce((a, b) => a + b, 0) - fixed}${fixed ? `, ${fixed} fixed - run --update-baseline to ratchet` : ""})`);
