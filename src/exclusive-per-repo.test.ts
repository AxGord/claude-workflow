import { describe, expect, it } from "vitest";
import { parseQueue, planPick } from "./queue.js";

const pick = (tasks: string) =>
  planPick(parseQueue(`batch_size: 5\noverlap: files\ntasks:\n${tasks}`, "/tmp/q.yaml"));
const t = (id: string, repo: string, extra = "", status = "pending") =>
  `  - {id: ${id}, status: ${status}, repo: ${repo}, touches: [${id.toLowerCase()}.ts]${extra}}\n`;

describe("exclusive: excludes only its own repo", () => {
  it("a running exclusive line of repo A admits a pending line of repo B", () => {
    const r = pick(t("R", "/tmp/repoA", ", exclusive: true", "running") + t("B", "/tmp/repoB"));
    expect(r.admitted.map(a => a.id)).toEqual(["B"]);
  });
  it("a running exclusive line of repo A still refuses a line of repo A", () => {
    const r = pick(t("R", "/tmp/repoA", ", exclusive: true", "running") + t("A", "/tmp/repoA"));
    expect(r.admitted).toEqual([]);
  });
  it("an exclusive line of repo B waits for nothing but its own repo", () => {
    const r = pick(t("R", "/tmp/repoA", "", "running") + t("B", "/tmp/repoB", ", exclusive: true"));
    expect(r.admitted.map(a => a.id)).toEqual(["B"]);
  });
});
