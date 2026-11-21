// ENG-PUBLISH-RETRY-IDEMPOTENT: the publish job must finish through transient failures and be safe to run again.
// Release run 0.2.0: `npm publish` and the `release` branch push succeeded, the tag push hit a GitHub-side storage
// error, and a plain re-run would have failed on `npm publish` of an existing version (`npm view` lags). The pieces
// that can run here: scripts/retry.sh, scripts/release-push.sh (against a local bare remote), scripts/npm-publish.sh
// (against a fake `npm`), and the shape of .github/workflows/publish.yml. Only a real run on GitHub proves the
// workflow's own YAML, GitHub's storage failures and the registry's real lag.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const script = (name: string): string => join(ROOT, "scripts", name);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "wf-publish-retry-"));
  dirs.push(d);
  return d;
}
function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

describe("scripts/retry.sh", () => {
  // A command that fails `failures` times, then succeeds; the counter file records every attempt.
  function flaky(failures: number): { dir: string; cmd: string[]; attempts: () => number } {
    const dir = tmp();
    const counter = join(dir, "count");
    writeFileSync(counter, "0");
    const body = `n=$(cat "${counter}"); n=$((n+1)); echo $n > "${counter}"; [ $n -gt ${failures} ]`;
    return { dir, cmd: ["sh", "-c", body], attempts: () => Number(readFileSync(counter, "utf8")) };
  }

  it("fails N-1 times then succeeds: exit 0 after N attempts", () => {
    const f = flaky(3);
    const r = run("sh", [script("retry.sh"), "--delays", "0 0 0", "--", ...f.cmd]);
    expect(r.code).toBe(0);
    expect(f.attempts()).toBe(4);
    expect(r.err).toContain("attempt 3 failed");
  });

  it("runs a command that succeeds at once exactly once", () => {
    const f = flaky(0);
    expect(run("sh", [script("retry.sh"), "--delays", "0 0 0", "--", ...f.cmd]).code).toBe(0);
    expect(f.attempts()).toBe(1);
  });

  it("gives up after the delays run out, with the command's own exit status", () => {
    const r = run("sh", [script("retry.sh"), "--delays", "0 0", "--", "sh", "-c", "exit 7"]);
    expect(r.code).toBe(7);
    expect(r.err).toContain("giving up");
    const f = flaky(99);
    run("sh", [script("retry.sh"), "--delays", "0 0", "--", ...f.cmd]);
    expect(f.attempts()).toBe(3);
  });

  it("takes its delays from RETRY_DELAYS and refuses a call with no command", () => {
    const f = flaky(1);
    expect(
      run("sh", [script("retry.sh"), "--", ...f.cmd], { env: { RETRY_DELAYS: "0" } }).code,
    ).toBe(0);
    expect(run("sh", [script("retry.sh"), "--"]).code).toBe(2);
  });
});

describe("scripts/release-push.sh", () => {
  const ID = {
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    RETRY_DELAYS: "0 0 0",
  };
  // A bare remote and a clone with two commits (a, b); returns their ids.
  function setup(): { remote: string; work: string; a: string; b: string } {
    const root = tmp();
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    run("git", ["init", "-q", "--bare", remote]);
    run("git", ["init", "-q", work]);
    run("git", ["remote", "add", "origin", remote], { cwd: work });
    const commit = (msg: string): string => {
      run("git", ["commit", "-q", "--allow-empty", "-m", msg], { cwd: work, env: ID });
      return run("git", ["rev-parse", "HEAD"], { cwd: work }).out;
    };
    const a = commit("a");
    const b = commit("b");
    return { remote, work, a, b };
  }
  const remoteRef = (remote: string, ref: string): string =>
    run("git", ["--git-dir", remote, "rev-parse", "-q", "--verify", ref]).out;
  const push = (w: { work: string }, sha: string) =>
    run("sh", [script("release-push.sh"), "origin", "refs/heads/release", "v1.0.0", sha], {
      cwd: w.work,
      env: ID,
    });
  // A hook that rejects the first `failures` pushes, as GitHub's storage error did.
  function failFirst(remote: string, failures: number): void {
    const counter = join(remote, "attempts");
    writeFileSync(counter, "0");
    const hook = join(remote, "hooks", "pre-receive");
    writeFileSync(
      hook,
      `#!/bin/sh\nn=$(cat "${counter}"); n=$((n+1)); echo $n > "${counter}"\n[ $n -gt ${failures} ] || { echo "unable to write file" >&2; exit 1; }\n`,
    );
    chmodSync(hook, 0o755);
  }

  it("pushes the branch and the tag together", () => {
    const w = setup();
    expect(push(w, w.b).code).toBe(0);
    expect(remoteRef(w.remote, "refs/heads/release")).toBe(w.b);
    expect(remoteRef(w.remote, "refs/tags/v1.0.0")).toBe(w.b);
  });

  it("is atomic: a tag the remote refuses leaves the branch unpushed too", () => {
    const w = setup();
    const hook = join(w.remote, "hooks", "update");
    writeFileSync(hook, `#!/bin/sh\ncase "$1" in refs/tags/*) exit 1;; esac\n`);
    chmodSync(hook, 0o755);
    expect(push(w, w.b).code).not.toBe(0);
    expect(remoteRef(w.remote, "refs/heads/release")).toBe("");
    expect(remoteRef(w.remote, "refs/tags/v1.0.0")).toBe("");
  });

  it("retries a push that fails now and then and still finishes", () => {
    const w = setup();
    failFirst(w.remote, 2);
    const r = push(w, w.b);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("attempt");
    expect(remoteRef(w.remote, "refs/tags/v1.0.0")).toBe(w.b);
    expect(Number(readFileSync(join(w.remote, "attempts"), "utf8"))).toBe(3);
  });

  it("gives up when the remote keeps failing", () => {
    const w = setup();
    failFirst(w.remote, 99);
    expect(push(w, w.b).code).not.toBe(0);
    expect(remoteRef(w.remote, "refs/heads/release")).toBe("");
  });

  it("a re-run is a no-op when the tag already names the commit, and puts the branch right", () => {
    const w = setup();
    expect(push(w, w.b).code).toBe(0);
    run("git", ["--git-dir", w.remote, "update-ref", "-d", "refs/heads/release"]);
    const again = push(w, w.b);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain("already names");
    expect(remoteRef(w.remote, "refs/tags/v1.0.0")).toBe(w.b);
    expect(remoteRef(w.remote, "refs/heads/release")).toBe(w.b);
  });

  it("fails loudly, moving nothing, when the tag names another commit", () => {
    const w = setup();
    expect(push(w, w.a).code).toBe(0);
    const r = push(w, w.b);
    expect(r.code).toBe(1);
    expect(r.err).toContain("refusing to move a released tag");
    expect(remoteRef(w.remote, "refs/tags/v1.0.0")).toBe(w.a);
    expect(remoteRef(w.remote, "refs/heads/release")).toBe(w.a);
  });
});

describe("scripts/npm-publish.sh", () => {
  // A fake `npm`: `publish` behaves as FAKE_PUBLISH says (ok | dup | fail), `view` answers FAKE_VERSION from the
  // FAKE_VIEW_AFTER+1 th call on (404-like, empty and exit 1, before that).
  function fakeNpm(): { env: Record<string, string>; count: (name: string) => number } {
    const dir = tmp();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const npm = join(bin, "npm");
    writeFileSync(
      npm,
      `#!/bin/sh
d="${dir}"
case "$1" in
  publish)
    echo x >> "$d/publish.count"
    case "$FAKE_PUBLISH" in
      ok) echo "npm notice Your package is being processed and may take a few minutes to become available"; exit 0 ;;
      dup) echo "npm error code E403" >&2; echo "npm error You cannot publish over the previously published versions: 1.0.0." >&2; exit 1 ;;
      *) echo "npm error code E500" >&2; exit 1 ;;
    esac ;;
  view)
    echo x >> "$d/view.count"
    n=$(wc -l < "$d/view.count")
    [ "$n" -gt "\${FAKE_VIEW_AFTER:-0}" ] && { echo "$FAKE_VERSION"; exit 0; }
    echo "npm error code E404" >&2; exit 1 ;;
esac
`,
    );
    chmodSync(npm, 0o755);
    const count = (name: string): number => {
      try {
        return readFileSync(join(dir, `${name}.count`), "utf8")
          .split("\n")
          .filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    return {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        FAKE_VERSION: "1.0.0",
        NPM_PUBLISH_POLL: "0",
        NPM_PUBLISH_WAIT: "30",
      },
      count,
    };
  }
  const publish = (env: Record<string, string>) =>
    run("sh", [script("npm-publish.sh"), "pkg", "1.0.0", "--", "npm", "publish"], { env });

  it("waits after the publish until npm view answers the version", () => {
    const f = fakeNpm();
    const r = publish({ ...f.env, FAKE_PUBLISH: "ok", FAKE_VIEW_AFTER: "3" });
    expect(r.code, r.err).toBe(0);
    expect(f.count("publish")).toBe(1);
    expect(f.count("view")).toBe(4);
  });

  it("counts a publish refused because the version already exists as published", () => {
    const f = fakeNpm();
    const r = publish({ ...f.env, FAKE_PUBLISH: "dup", FAKE_VIEW_AFTER: "1" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("already published");
    expect(f.count("view")).toBe(2);
  });

  it("fails on any other publish failure, without waiting", () => {
    const f = fakeNpm();
    const r = publish({ ...f.env, FAKE_PUBLISH: "fail" });
    expect(r.code).toBe(1);
    expect(f.count("view")).toBe(0);
  });

  it("fails when the registry never shows the version within the wait", () => {
    const f = fakeNpm();
    const r = publish({
      ...f.env,
      FAKE_PUBLISH: "ok",
      FAKE_VIEW_AFTER: "999999",
      NPM_PUBLISH_WAIT: "1",
      NPM_PUBLISH_POLL: "1",
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("not visible");
  });
});

describe("publish.yml wiring", () => {
  const wf = (): string => read(".github/workflows/publish.yml");

  it("pushes only through release-push.sh: no bare git push, no git identity", () => {
    expect(wf()).toContain("sh scripts/release-push.sh origin refs/heads/release");
    expect(wf()).not.toMatch(/git push/);
    expect(wf()).not.toMatch(/git config user/);
  });

  it("publishes through npm-publish.sh, which waits for the registry", () => {
    expect(wf()).toContain("sh scripts/npm-publish.sh claude-mcp-workflow");
    expect(wf()).toContain("-- npm publish --provenance --access public");
  });

  it("treats a tag without its GitHub release as unfinished, and keeps the release step an update-or-create", () => {
    expect(wf()).toContain('gh release view "v$VERSION"');
    expect(wf()).toContain("softprops/action-gh-release");
  });

  it("the scripts are executable", () => {
    for (const s of ["retry.sh", "release-push.sh", "npm-publish.sh"]) {
      const r = run("test", ["-x", script(s)]);
      expect(r.code, s).toBe(0);
    }
  });
});
