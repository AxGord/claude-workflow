/**
 * Signal a whole process group: every exec spawns detached (its own group),
 * so `sh -c` and everything it started die together. Falls back to the bare
 * pid for a process that is not a group leader.
 */
export function killProcessGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  // pids come from session JSON: kill(-1) would signal every process of the
  // user, kill(0) / kill(-0) the server's own group.
  if (!Number.isInteger(pid) || pid <= 1) return;
  try { process.kill(-pid, signal); return; } catch { /* not a group leader, or gone */ }
  try { process.kill(pid, signal); } catch { /* already dead */ }
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
