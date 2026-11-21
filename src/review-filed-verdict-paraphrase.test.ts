import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

// ENG-REVIEW-FILED-VERDICT-PARAPHRASE: a driver filed review_text as its own paraphrase of a MERGE review
// ("... Verdict: MERGE. Brief items 1-4 done ..."); review_filed read no verdict line and routed it to a fix round
// (exit 10 -> work) with no fix list. The REAL review_filed command of the REAL engine-task.yaml runs on the text.
const root = resolve(__dirname, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function reviewFiled(text: string) {
  const def = parse(readFileSync(join(root, ".claude/workflows/engine-task.yaml"), "utf8")) as {
    states: Record<string, { command: string }>;
  };
  const base = realpathSync(mkdtempSync(join(tmpdir(), "rf-paraphrase-")));
  dirs.push(base);
  mkdirSync(join(base, "batch"));
  const queue = join(base, "batch", "queue.yaml");
  writeFileSync(queue, "  - id: T-PARA\n    kind: bug\n");
  const r = spawnSync("sh", ["-c", def.states.review_filed.command], {
    encoding: "utf8",
    env: { ...process.env, TEXT: text, QUEUE: queue, TASK: "T-PARA" },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const PARAPHRASE =
  "Review of ENG-PUBLISH-RETRY-IDEMPOTENT (HEAD 740b1a3). Verdict: MERGE. Brief items 1-4 done and tested; " +
  "the publish job finishes through the retry path, no findings left open.\nLESSONS: []";

function states() {
  return parse(readFileSync(join(root, ".claude/workflows/engine-task.yaml"), "utf8")) as {
    states: Record<
      string,
      { cases?: Record<string, string>; transitions?: Record<string, string> }
    >;
  };
}

describe("review_filed on a paraphrased review", () => {
  it("routes the reviewer's own verdict line to land (control)", () => {
    expect(reviewFiled("Looks fine.\nVERDICT MERGE\n").status).toBe(0);
  });

  it("does not send a text with no verdict line to a fix round that has no fix list", () => {
    // exit 10 = the `work` fix round; a text that carries no verdict line must be refused, not defaulted there.
    expect(reviewFiled(PARAPHRASE).status).not.toBe(10);
  });

  it("refuses a text with no verdict line (exit 11), naming why, and an empty text too", () => {
    const r = reviewFiled(PARAPHRASE);
    expect(r.status).toBe(11);
    expect(r.out).toContain("no verdict line");
    expect(reviewFiled("").status).toBe(11);
  });

  it("still sends a FIXES verdict to the fix round and reads a trailing MERGE", () => {
    expect(reviewFiled("1. x\nFIXES:\n1. rename x\n").status).toBe(10);
    expect(reviewFiled("Reviewed, all fine. MERGE\n").status).toBe(0);
  });

  it("routes the refusal to a state that asks the reviewer again and files through review_filed", () => {
    const s = states().states;
    expect(s.review_filed.cases?.["11"]).toBe("review_refile");
    expect(s.review_refile.transitions?.filed).toBe("review_filed");
  });
});
