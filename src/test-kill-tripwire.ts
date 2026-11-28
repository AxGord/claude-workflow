// Vitest setup file (vitest.config.ts `setupFiles`): a test process cannot signal pid 0, 1, -0 or -1.
// `process.kill(0, sig)` signals the caller's whole process group and `-1` every process the user
// owns; a test that read an empty pid file (Number("") === 0) killed its own gate with exit 137
// (ENG-TEST-KILL-ZERO-GUARD). The wrapper throws instead and appends the caller's stack and the
// time to a file under the OS temp dir, so a recurrence names its killer. Signal 0 is a liveness
// probe and passes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Kill = typeof process.kill;

export const TRIPWIRE_FILE = path.join(os.tmpdir(), "wf-test-kill-tripwire.log");

const isGroupWide = (pid: number): boolean => pid === 0 || pid === 1 || pid === -1;

export function guardKill(underlying: Kill, tripwireFile: string, now: () => Date): Kill {
  return (pid: number, signal?: string | number) => {
    if (signal !== 0 && isGroupWide(Number(pid))) {
      const entry = `${now().toISOString()} process.kill(${String(pid)}, ${String(signal)}) refused\n${new Error("caller").stack ?? ""}\n\n`;
      try {
        fs.appendFileSync(tripwireFile, entry);
      } catch {
        /* the throw below still names the call */
      }
      throw new Error(
        `process.kill(${String(pid)}, ${String(signal)}) refused in a test: it signals a process group or every process of the user (entry in ${tripwireFile})`,
      );
    }
    return underlying(pid, signal);
  };
}

const realKill: Kill = process.kill.bind(process);
process.kill = guardKill(realKill, TRIPWIRE_FILE, () => new Date());
