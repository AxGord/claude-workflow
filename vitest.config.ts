import { defineConfig } from "vitest/config";

// The per-test timeout is a hang guard, not a speed bound: tests that run real processes (git,
// sh, wf-run) take 5x longer on a host loaded the way a busy pool loads it, and a fixed 15 s
// failed them there (src/test-timeout-under-load.test.ts). A hung test still ends, a minute later.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
