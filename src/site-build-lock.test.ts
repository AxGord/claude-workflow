import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT, withBuildLock } from "./site-browser-helpers.js";
import { writeWhenNoBuild } from "./site-workflows-setup.js";
import { SITE_WORKFLOWS_FILE } from "./site-workflows.js";

// The build lock the docs builds of the site tests take turns by (VitePress shares one .temp directory).

const fresh = (): string =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wf-lock-test-")), "lock");
const gone = (lock: string): void =>
  fs.rmSync(path.dirname(lock), { recursive: true, force: true });
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

describe("withBuildLock", () => {
  it("runs the work, releases the lock, and returns the work's value", async () => {
    const lock = fresh();
    try {
      expect(await withBuildLock(() => 7, lock)).toBe(7);
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      gone(lock);
    }
  });

  it("waits while a live process holds the lock, and goes on once it is released", async () => {
    const lock = fresh();
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
      let ran = false;
      const done = withBuildLock(() => {
        ran = true;
      }, lock);
      await sleep(500);
      expect(ran, "the work waits for the live holder").toBe(false);
      fs.rmSync(lock, { recursive: true });
      await done;
      expect(ran).toBe(true);
    } finally {
      gone(lock);
    }
  });

  it("takes over a lock whose holder is dead", async () => {
    const lock = fresh();
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "pid"), "2147483646");
      expect(await withBuildLock(() => "ran", lock)).toBe("ran");
    } finally {
      gone(lock);
    }
  });

  it("takes over a lock directory with no pid file once it is older than a few seconds, and not before", async () => {
    const lock = fresh();
    try {
      fs.mkdirSync(lock);
      let ran = false;
      const done = withBuildLock(() => {
        ran = true;
      }, lock);
      await sleep(500);
      expect(ran, "a fresh pid-less lock may be mid-write: wait").toBe(false);
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);
      await done;
      expect(ran).toBe(true);
    } finally {
      gone(lock);
    }
  });
});

describe("the test run's export write", () => {
  it("waits for a running docs build (it holds the lock) before it writes into docs/public", async () => {
    const lock = fresh();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-site-root-"));
    try {
      fs.symlinkSync(path.join(ROOT, "templates"), path.join(root, "templates"));
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
      const file = path.join(root, SITE_WORKFLOWS_FILE);
      const done = writeWhenNoBuild(root, lock);
      await sleep(500);
      expect(fs.existsSync(file), "no write while the build holds the lock").toBe(false);
      fs.rmSync(lock, { recursive: true, force: true });
      await done;
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      gone(lock);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
