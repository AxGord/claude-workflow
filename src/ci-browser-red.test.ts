import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// CI exports CHROME_BIN for a Chrome that may not start. That alone must not run the opt-in browser
// tests; and when opted in with a Chrome that cannot start, the failure names it, not a raw ENOENT.
function run(extra: Record<string, string>): string {
  const r = spawnSync(
    "npx",
    ["vitest", "run", "src/dashboard-browser.test.ts", "-t", "takes a refresh in place"],
    {
      env: { ...process.env, CHROME_BIN: "/usr/bin/false", ...extra },
      encoding: "utf8",
      timeout: 120_000,
    },
  );
  return r.stdout + r.stderr;
}

describe("browser tests with a Chrome that cannot start", () => {
  it("are skipped when only CHROME_BIN is set", () => {
    const out = run({ WF_BROWSER_TESTS: "" });
    expect(out).not.toContain("DevToolsActivePort");
    // the word, not the substring: the checkout path may itself contain FAILED
    expect(out).not.toMatch(/\bFAIL\b/);
  }, 130_000);

  it("opted in, fail with a clear error, not ENOENT", () => {
    const out = run({ WF_BROWSER_TESTS: "1" });
    expect(out).toContain("did not start");
    expect(out).not.toContain("ENOENT");
  }, 130_000);
});
