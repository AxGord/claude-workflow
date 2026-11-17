import { defineConfig } from "vitest/config";

// The per-test timeout is a hang guard, not a speed bound: tests that run real processes (git,
// sh, wf-run) take 5x longer on a host loaded the way a busy pool loads it, and a fixed 15 s
// failed them there (src/test-timeout-under-load.test.ts). A hung test still ends, a minute later.
// The setup file keeps the user's global git config (which signs commits) out of every test.
//
// The worker count is the pool grant: a leased run (the gate's exec, `wf-run`) hands its threads over as
// WF_THREADS, and without a cap vitest takes about cpus-1 workers whatever it was granted. Unset or not a
// positive integer (a run by hand, outside a lease) leaves vitest's own default.
const grant = Number.parseInt(process.env.WF_THREADS ?? "", 10);

export default defineConfig({
  test: {
    ...(grant > 0 ? { maxWorkers: grant } : {}),
    globalSetup: ["src/site-workflows-setup.ts"],
    include: ["src/**/*.test.ts"],
    setupFiles: ["src/test-git-env.ts"],
    testTimeout: 60_000,
  },
});
