import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The files a tsconfig's program holds, as root-relative paths. */
function programFiles(config: string): Set<string> {
  const path = resolve(root, config);
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => undefined,
    },
  );
  if (!parsed) throw new Error(`cannot read ${config}`);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return new Set(
    program
      .getSourceFiles()
      .map(f => f.fileName)
      .filter(f => f.startsWith(root + "/") && !f.includes("/node_modules/"))
      .map(f => f.slice(root.length + 1)),
  );
}

describe("hooks/tab-links.ts header: the stated reason it stands apart from pane-view.ts", () => {
  it("does not claim pane-view.ts is outside the engine's TypeScript program while engine tests import it", async () => {
    // Behaviour: the engine's own test program really does import and run pane-view.
    const paneView = await import("../hooks/pane-view.js");
    expect(typeof paneView.paneTree).toBe("function");

    // The tab links live in pane-view itself: no separate module is kept for a reason that does not hold.
    expect(paneView.TAB_LINKS.plan.path).toBe("/plan");
    expect(existsSync(resolve(root, "hooks/tab-links.ts"))).toBe(false);

    // The program the engine's tests and lint see holds pane-view.ts (src/replay-plan.test.ts imports it).
    const testProgram = programFiles("tsconfig.eslint.json");
    expect(testProgram.has("hooks/pane-view.ts")).toBe(true);

    // If the module still exists, its header must not state the premise those two facts refute.
    const file = resolve(root, "hooks/tab-links.ts");
    if (!existsSync(file)) return;
    const header = readFileSync(file, "utf8")
      .split("\n")
      .filter(l => l.startsWith("//"))
      .join(" ")
      .replace(/\s*\/\/\s*/g, " ");
    expect(header).not.toMatch(/not part of the engine'?s TypeScript program/i);
  });
});
