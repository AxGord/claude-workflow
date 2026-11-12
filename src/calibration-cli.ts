#!/usr/bin/env node
// wf-calibration: the calibration report over the ledger (src/calibration.ts).
//   wf-calibration [--ledger FILE] [--since DATE] [--project PATH] [--findings-key KEY] [--json]
// The ledger defaults to $WF_STATE_DIR, else ~/.claude/workflow-state, `/ledger.jsonl`.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { calibrate, formatCalibration } from "./calibration.js";
import { parseLedger } from "./ledger.js";

export function runCalibration(argv: readonly string[], defaultLedger: string): string {
  const flags = new Map<string, string>();
  let json = false;
  if (argv.includes("--help") || argv.includes("-h"))
    return "usage: wf-calibration [--ledger FILE] [--since DATE] [--project PATH] [--findings-key KEY] [--json]\n  rounds = review visits (on the review row), tokens split per stage row, findings on the review row, $ = task spend on the first row (- when unmeasured), esc/verdicts per task";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (["--ledger", "--since", "--project", "--findings-key"].includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      flags.set(a, v);
    } else throw new Error(`unknown argument ${a}`);
  }
  const since = flags.get("--since");
  if (since !== undefined && Number.isNaN(Date.parse(since)))
    throw new Error(`bad --since ${since}`);
  const entries = parseLedger(readFileSync(flags.get("--ledger") ?? defaultLedger, "utf8"));
  const findingsKey = flags.get("--findings-key");
  const rows = calibrate(entries, { since, project: flags.get("--project"), findingsKey });
  return json ? JSON.stringify(rows, null, 2) : formatCalibration(rows, findingsKey !== undefined);
}

if (
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const dir = process.env.WF_STATE_DIR ?? path.join(os.homedir(), ".claude", "workflow-state");
    console.log(runCalibration(process.argv.slice(2), path.join(dir, "ledger.jsonl")));
  } catch (err) {
    console.error(`wf-calibration: ${(err as Error).message}`);
    process.exit(2);
  }
}
