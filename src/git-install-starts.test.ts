import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ENG-RELEASE-GIT-INSTALL-NO-BUILD: a plugin installed from git gets the committed tree only (no build, no
// install scripts), so the commit the marketplace names must carry build/. master does not: scripts/release-tree.sh
// assembles that commit after `npm publish`, and the repo's own marketplace entry names the branch it is pushed to.
const SCRIPT = join(import.meta.dirname, "..", "scripts", "release-tree.sh");
const root = join(import.meta.dirname, "..");
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

describe("the release tree a git install gets", () => {
  it("starts its MCP server from .mcp.json and answers initialize", async () => {
    const dir = mkdtempSync(join(tmpdir(), "git-install-"));
    try {
      execFileSync("sh", [SCRIPT, "--dir", dir], { stdio: ["ignore", "ignore", "pipe"] });
      // what Claude Code adds after the copy: the dependencies (npm ci --omit=dev --ignore-scripts)
      symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
      const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")) as {
        mcpServers: { wf: { command: string; args: string[] } };
      };
      const wf = mcp.mcpServers.wf;
      const args = wf.args.map(a => a.replace("${CLAUDE_PLUGIN_ROOT}", dir));
      const child = spawn(wf.command, args, { cwd: dir, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", d => (out += d));
      child.stderr.on("data", d => (err += d));
      const exited = new Promise<void>(r => child.on("exit", () => r()));
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        })}\n`,
      );
      const answered = await Promise.race([
        new Promise<boolean>(r => {
          const t = setInterval(() => out.includes('"id":1') && (clearInterval(t), r(true)), 50);
        }),
        exited.then(() => false),
        new Promise<boolean>(r => setTimeout(() => r(false), 15000)),
      ]);
      child.kill();
      expect(answered, `server did not answer initialize; stderr: ${err.slice(0, 300)}`).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);

  it("--commit adds the runtime build to the base commit's tree and nothing else, and moves no ref", () => {
    const head = git("rev-parse", "HEAD");
    const sha = execFileSync("sh", [SCRIPT, "--commit", "--message", "t"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // CI has no git identity (useConfigOnly): a commit object needs one
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    }).trim();
    expect(git("rev-parse", `${sha}^`)).toBe(head);
    expect(git("rev-parse", "HEAD")).toBe(head);
    const files = git("ls-tree", "-r", "--name-only", sha).split("\n");
    expect(files).toContain("build/index.js");
    expect(files.filter(f => f.startsWith("build/") && !f.endsWith(".js"))).toEqual([]);
    const base = git("ls-tree", "-r", "--name-only", head).split("\n");
    expect(files.filter(f => !f.startsWith("build/"))).toEqual(
      base.filter(f => !f.startsWith("build/")),
    );
  }, 60000);

  it("master itself carries no built file, and the repo's marketplace entry names the release branch", () => {
    expect(git("ls-files", "build")).toBe("");
    const market = JSON.parse(read(".claude-plugin/marketplace.json")) as {
      plugins: { source: unknown }[];
    };
    expect(market.plugins[0].source).toEqual({
      source: "github",
      repo: "AxGord/claude-workflow",
      ref: "release",
    });
  });

  it("publish.yml makes the release commit after npm publish and tags that commit", () => {
    const wf = read(".github/workflows/publish.yml");
    expect(wf).toContain("scripts/release-tree.sh --commit");
    expect(wf).toContain("refs/heads/release");
    expect(wf).toContain("steps.npm.outputs.published != 'true'");
    expect(wf).toContain("npm view");
    expect(wf.indexOf("npm publish")).toBeLessThan(wf.indexOf("release-tree.sh"));
    expect(wf.indexOf("release-tree.sh")).toBeLessThan(wf.indexOf("action-gh-release"));
  });
});
