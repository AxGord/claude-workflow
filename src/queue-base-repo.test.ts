import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { addQueueLine, editQueueLine } from "./queue.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  ).trim();

function repoWithCommit(dir: string, msg: string): string {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "commit", "--allow-empty", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

describe("queue_edit that changes only repo:", () => {
  it("re-stamps base from the new repo's HEAD", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-queue-base-repo-"));
    dirs.push(root);
    const proj = path.join(root, "proj");
    const other = path.join(root, "other");
    const projHead = repoWithCommit(proj, "p");
    const otherHead = repoWithCommit(other, "o");
    expect(otherHead).not.toBe(projHead);
    fs.mkdirSync(path.join(proj, ".claude", "batch"), { recursive: true });
    const file = path.join(proj, ".claude", "batch", "q.yaml");
    fs.writeFileSync(file, "batch_size: 2\ntasks: []\n");

    await addQueueLine(file, { id: "A", touches: "a", text: "Do A." });
    const baseOf = (): unknown =>
      (
        YAML.parse(fs.readFileSync(file, "utf8")) as { tasks: { id: string; base?: string }[] }
      ).tasks.find(t => t.id === "A")?.base;
    expect(baseOf()).toBe(projHead);

    await editQueueLine(file, "A", { repo: other });
    expect(baseOf()).toBe(otherHead);
  });

  it("keeps base when the repo is re-spelled as the same directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-queue-base-repo-"));
    dirs.push(root);
    const proj = path.join(root, "proj");
    const other = path.join(root, "other");
    repoWithCommit(proj, "p");
    const otherHead = repoWithCommit(other, "o");
    fs.mkdirSync(path.join(proj, ".claude", "batch"), { recursive: true });
    const file = path.join(proj, ".claude", "batch", "q.yaml");
    fs.writeFileSync(file, "batch_size: 2\ntasks: []\n");
    const baseOf = (): unknown =>
      (
        YAML.parse(fs.readFileSync(file, "utf8")) as { tasks: { id: string; base?: string }[] }
      ).tasks.find(t => t.id === "A")?.base;

    await addQueueLine(file, { id: "A", touches: "a", text: "Do A.", repo: "other" });
    expect(baseOf()).toBe(otherHead);
    git(other, "commit", "--allow-empty", "-m", "o2");
    await editQueueLine(file, "A", { repo: other });
    expect(baseOf()).toBe(otherHead);
  });
});
