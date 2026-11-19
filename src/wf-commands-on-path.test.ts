import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { trustHint, untrustedReason, TrustStore } from "./trust.js";

// ENG-PLUGIN-WF-COMMANDS-ON-PATH: a plugin install puts no `wf-*` script on the user's PATH, so the command the
// engine prints for the user to copy (the exec-consent hint) must resolve in a shell whose PATH holds nothing of
// the plugin. The hint is executed through `command -v`, not read as text.

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BARE_PATH = "/usr/bin:/bin";

/** The words of the first backtick-quoted `wf-trust ...` / `<path>/wf-trust ...` command of a printed message, split the way a shell splits the line the user copies. */
function printedWords(message: string): string[] {
  const printed = /`([^`]*wf-trust[^`]*)`/.exec(message)?.[1];
  if (printed === undefined) throw new Error(`no wf-trust command printed in: ${message}`);
  const r = spawnSync("sh", ["-c", 'eval "set -- $1"; printf "%s\\0" "$@"', "_", printed], {
    encoding: "utf8",
  });
  return r.stdout.split("\0").slice(0, -1);
}

/** What a bare shell makes of the command word: found or not, and where. */
function resolvesOnBarePath(command: string): { ok: boolean; out: string } {
  const r = spawnSync("sh", ["-c", 'command -v "$1"', "_", command], {
    env: { PATH: BARE_PATH, HOME: "/nonexistent" },
    cwd: "/",
    encoding: "utf8",
  });
  return { ok: r.status === 0, out: `${r.stdout}${r.stderr}`.trim() };
}

describe("ENG-PLUGIN-WF-COMMANDS-ON-PATH", () => {
  it("the consent hint's command runs from a shell with only a plugin install (no wf-trust on PATH)", () => {
    const cmd = printedWords(trustHint("/some/project"))[0] ?? "";
    const r = resolvesOnBarePath(cmd);
    expect(r.ok, `printed command word "${cmd}" does not resolve with PATH=${BARE_PATH}`).toBe(
      true,
    );
    expect(r.out).toBe(path.join(PLUGIN_DIR, "scripts", "wf-trust"));
  });

  it("the untrusted-project reason prints the same copyable full path", () => {
    const store = new TrustStore(null);
    const cmd = printedWords(untrustedReason("/some/project", store))[0] ?? "";
    expect(resolvesOnBarePath(cmd).ok, `printed command word "${cmd}"`).toBe(true);
  });

  it("a project directory with a space and a quote reaches the shell as one argument", () => {
    const project = "/tmp/my project/it's here";
    const words = printedWords(trustHint(project));
    expect(words.slice(1)).toEqual([project]);
  });
});
