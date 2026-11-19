import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decideReadOnly } from "./read-only-gate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const flat = (p: string) => read(p).replace(/\s+/g, " ");

// A brief a driver hands to an agent it spawns: the file, where it starts and where it ends.
type Brief = { file: string; from: string; to: string; readOnly: boolean };
const BRIEFS: Brief[] = [
  {
    file: "templates/batch-task.yaml",
    from: "You are the worker of task",
    to: "You review task",
    readOnly: false,
  },
  {
    file: "templates/batch-task.yaml",
    from: "You review task",
    to: "context_set `reviewed_sha`",
    readOnly: true,
  },
  {
    file: ".claude/workflows/engine-task.yaml",
    from: "You are the worker of engine slice",
    to: "context_set `worker_agent`",
    readOnly: false,
  },
  {
    file: ".claude/workflows/engine-task.yaml",
    from: "Reproduce engine bug",
    to: "context_set `repro_agent`",
    readOnly: false,
  },
  {
    file: ".claude/workflows/engine-task.yaml",
    from: "Review engine slice",
    to: "After spawning",
    readOnly: true,
  },
];

const DELIVERED =
  /After you have delivered (your last line|that handback), answer ONLY a harness `\[handback-send-enforce\]` prompt with the plain-text line `DELIVERED [^`]+` \(never SendMessage to main, never the report again\); a `Driver ping` that asks for your line gets the line\./;

const gate = (command: string) =>
  (kind => (kind === "deny" ? "deny" : "allow"))(
    decideReadOnly(
      {
        tool_name: "Bash",
        agent_type: "workflow:reviewer",
        tool_input: { command, timeout: 600000 },
      } as never,
      undefined,
    ).kind,
  );

describe("an agent waits in the foreground and never ends a turn with live work", () => {
  for (const { file, from, to, readOnly } of BRIEFS) {
    const text = flat(file);
    const start = text.indexOf(from);
    const brief = text.slice(start, text.indexOf(to, start));

    it(`${file}: the "${from}" brief waits in the foreground, no Monitor, never ends with live work`, () => {
      expect(start).toBeGreaterThan(-1);
      expect(brief).toMatch(
        /in the FOREGROUND with the longest Bash timeout \(600000\), never with `run_in_background`/,
      );
      expect(brief).toMatch(
        readOnly
          ? /Never start a Monitor for a command you wait for\. When the harness moves a foreground call to the background at its timeout, TaskStop it before any end of turn\./
          : /Never start a Monitor for a command you wait for\. When the harness moves a foreground call to the background at its timeout, TaskStop it, or wait on it in FOREGROUND calls/,
      );
      expect(brief).toMatch(
        /Never end your turn while anything you started is alive, mid-run as well as at your last line/,
      );
    });

    it(`${file}: the "${from}" brief gives ${readOnly ? "a read-only type only foreground calls" : "the detached start and the foreground wait chain"}`, () => {
      if (readOnly) {
        expect(brief).not.toContain("nohup");
        expect(brief).not.toContain("L.done");
        expect(brief).not.toContain("the until chain");
        expect(brief).toMatch(
          /read-only gate refuses a redirect, `\$\( \)` and `sleep`, so you cannot detach a command or loop on a marker: a command that would outlast one call .* you do not run; name it in your verdict as unverified/,
        );
      } else {
        const d = file.startsWith("templates/") ? "{{context.wt}}.log" : "{{context.wt}}-logs";
        expect(brief).toContain(
          `nohup sh -c '<cmd>; echo $? > ${d}/L.done' > ${d}/L.log 2>&1 & echo $! > ${d}/L.pid`,
        );
        expect(brief).toContain(
          `until [ -s ${d}/L.done ] || ! kill -0 "$(cat ${d}/L.pid)" 2>/dev/null || [ $i -ge 540 ]; do sleep 1;`,
        );
        expect(brief).toMatch(
          /Marker, log and pid go by ABSOLUTE path .* does not persist across calls .* chain `cd` with `&&`/,
        );
        expect(brief).toMatch(/never `sleep` alone/);
      }
    });

    it(`${file}: the "${from}" brief answers the enforce prompt with one fixed plain-text line`, () => {
      expect(brief).toMatch(DELIVERED);
    });
  }

  it("the read-only gate passes the reviewer's foreground reads and refuses the shapes its brief does not give", () => {
    expect(gate("git -C /tmp/wf-X diff HEAD...batch/X")).toBe("allow");
    expect(gate("git -C /tmp/wf-X show --stat HEAD")).toBe("allow");
    expect(gate("rtk proxy git -C /tmp/wf-X show HEAD -- src/a.ts")).toBe("allow");
    expect(gate("nohup sh -c 'x; echo $? > L.done' > L.log 2>&1 & echo $! > L.pid")).toBe("deny");
    expect(gate('until [ -s L.done ] || ! kill -0 "$(cat L.pid)"; do sleep 1; done')).toBe("deny");
    expect(gate("sleep 5")).toBe("deny");
  });

  for (const file of [
    "templates/batch-task.yaml",
    ".claude/workflows/engine-task.yaml",
    "templates/drivers/task-driver.md",
    "agents/driver.md",
  ]) {
    it(`${file}: no spawn text of a sub-agent says run_in_background: true|false`, () => {
      expect(read(file)).not.toMatch(/run_in_background: (true|false)/);
    });
  }

  for (const file of ["templates/drivers/task-driver.md", "agents/driver.md"]) {
    const text = flat(file);
    it(`${file}: the driver omits run_in_background on a spawn`, () => {
      expect(text).toMatch(
        /Agent tool has no `run_in_background`: every spawn is asynchronous, so omit it/,
      );
    });

    it(`${file}: DELIVERED is no report when the line is held, one ping for the line when it is not`, () => {
      expect(text).toMatch(
        /When you HAVE its line .* it is not a second report: set no tokens, transition nothing/,
      );
      expect(text).toMatch(
        /When you have NOT received its line .* SendMessage it ONCE "Driver ping: repeat your one line\."/,
      );
    });
  }

  it("the wait loop shape runs: it ends on the marker, on the process's death and on the timeout", () => {
    // Same loop as the briefs, bounded to 3 iterations so the test stays fast.
    const loop = (marker: string, pid: string, limit: number) =>
      `i=0; until [ -s ${marker} ] || ! kill -0 "${pid}" 2>/dev/null || [ $i -ge ${limit} ]; do sleep 0.1; i=$((i+1)); done; echo $i`;
    const dir = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TMPDIR ?? "/tmp"), "wf-wait-"),
    );
    try {
      const marker = path.join(dir, "L.done");
      fs.writeFileSync(marker, "0\n");
      const run = (cmd: string) => execFileSync("sh", ["-c", cmd], { encoding: "utf8" }).trim();
      expect(run(loop(marker, String(process.pid), 3))).toBe("0");
      fs.rmSync(marker);
      expect(run(loop(marker, "999999", 3))).toBe("0");
      expect(run(loop(marker, String(process.pid), 3))).toBe("3");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
