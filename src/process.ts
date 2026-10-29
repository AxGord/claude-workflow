import { execFileSync } from "node:child_process";
import os from "node:os";

// Boot times read from uptime drift by clock adjustments: within this, two readings are one boot.
const SAME_BOOT_TOLERANCE_MS = 60_000;

/** This machine's boot time; a pgid recorded under another boot names some other process. */
export function bootTimeMs(): number {
  return Math.round(Date.now() - os.uptime() * 1000);
}

/** `bootMs` (a `bootTimeMs()` reading) is this boot of the machine. */
export function sameBoot(bootMs: number): boolean {
  return Math.abs(bootTimeMs() - bootMs) < SAME_BOOT_TOLERANCE_MS;
}

/** When the process started, as `ps -o lstart` prints it; undefined when it is gone or `ps` fails. */
export function processStart(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      env: { ...process.env, LC_ALL: "C" },
    }).trim();
    return out === "" ? undefined : out;
  } catch {
    return undefined;
  }
}

/**
 * Signal a whole process group: every exec spawns detached (its own group),
 * so `sh -c` and everything it started die together. Falls back to the bare
 * pid for a process that is not a group leader.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  // pids come from session JSON: kill(-1) would signal every process of the
  // user, kill(0) / kill(-0) the server's own group.
  if (!Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* not a group leader, or gone */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already dead */
  }
}

/** A process exists (EPERM: it exists but belongs to another user). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Some process of the group is alive. */
export function isGroupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
