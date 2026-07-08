---
name: browser-verify
description: Browser-automation verification gotchas — stale captures, caches, headless limits
---

## Browser-Automation Verification Gotchas

Traps when verifying web/canvas apps through Playwright or a browser MCP.
Common theme: **the automated browser is not the user's browser** — its
pixels, caches, and performance all lie in specific, repeatable ways.

### 1. Headless screenshot / `canvas.drawImage()` can return stale frames for a WebGL canvas

Animated content driven by per-frame GPU updates (custom shader uniforms, skeletal animations, shader-displaced vertices) may show **zero pixel diff** between headless screenshots taken 100s of ms apart, even when JS-side instrumentation confirms the state is updating each frame (RAF firing, uniform buffers advancing, ticker handlers incrementing). Sampling the canvas through `tmp.getContext('2d').drawImage(canvas, ...)` returns the same byte-for-byte image across samples — the whole canvas is affected, not just one animation.

Likely cause: with `preserveDrawingBuffer: false` (the default in most WebGL frameworks, incl. Pixi), the headless compositor reads from a cached present frame rather than the live WebGL back buffer.

- Don't rely on headless pixel-diff to verify GPU-driven animation works.
- Verify in a real browser tab (the user's running Chrome, not an automated instance).
- For automated verification, prefer JS-side state assertions: a uniform buffer value advancing across samples is sufficient proof the upload pipeline is alive; visual verification needs human eyes or a non-headless captured video.

### 2. Headed screenshots can ALSO be stale — a tab that was never frontmost composites its last presented frame

The same failure occurs HEADED whenever the target tab/window is occluded or was created behind another tab: `page.screenshot()` returns the last frame the browser's compositor ever presented for that tab. Observed: the screenshot showed a boot preloader frozen at "96%" while JS-side numeric sampling in the SAME page proved the app was live (object positions advancing every 100 ms, game logs firing). DOM inspection confirmed the preloader element was long gone — the "96%" pixels existed only in the stale compositor frame.

A second page created with `ctx.newPage()` and driven while another tab holds focus reproduces this; a page brought to front BEFORE its WebGL content started presenting captures real frames fine.

- Wrong: `ctx.newPage()` for a background capture tab, drive it, screenshot it while another tab stays focused — canvas pixels freeze at whatever was on screen when it lost focus (or never had it).
- Right:
  - Reuse the context's initial tab (`ctx.pages()[0]`) rather than stacking `newPage()`s for capture work.
  - Call `page.bringToFront()` immediately after `goto`, BEFORE the canvas first presents — not right before the screenshot.
  - Treat JS-side numeric sampling (positions, probe state) as ground truth — it stays correct even when pixels are stale.
  - For A/B visual comparisons, run each variant in its own sequential frontmost tab, never two tabs alternating.

### 3. Playwright MCP browser reuses a PERSISTENT cache across sessions — it can serve STALE js modules / outdated app logic

The Playwright MCP browser keeps a persistent profile + HTTP cache between conversations (`~/Library/Caches/ms-playwright-mcp/...` on macOS). A plain `browser_navigate` does NOT clear it, so when verifying app behavior against a dev server (e.g. Vite), the MCP browser can run **stale js modules** (a previous session's app-logic module) while the server already serves current code. The same seed/input then produces a DIFFERENT outcome in the MCP browser vs the user's real browser — and you'll confidently report the wrong result.

- Symptom: same dev server, same input, **different console result logs** in your browser vs the user's; your "verified" outcome contradicts what the user sees on screen.
- Red herring: a differing console source-LINE for the same log (e.g. playwright reports `logic.ts:103`, user's DevTools shows `:297`) is NOT a version mismatch — playwright reports the *transformed-module* line, DevTools the *sourcemapped source* line. Same code.
- Ground truth = the LIVE console log of the actual run in a FRESH browser, AND the user's real browser. NEVER a scanner-only prediction: a scanner's dynamic `import()` can be cached independently of the static import the live app uses, so the two disagree.
- Fix when your result conflicts with the user's: suspect YOUR cache first. `browser_close` then re-navigate relaunches a fresh browser instance — clears in-memory state and stale module instances, often enough against a dev server — but the default persistent mode reuses the same on-disk profile, so the HTTP disk cache/cookies survive. Guaranteed clean: run the MCP server with `--isolated`, point `--user-data-dir` at a throwaway dir, or delete the profile dir (`~/Library/Caches/ms-playwright-mcp/mcp-<channel>-<hash>` on macOS).
- `tsc`/`vitest` run via node against DISK code, so they stay valid for code correctness; only the BROWSER render/logic can be cache-stale. Re-verify any live finding in a freshly-cleared browser before claiming it.
- Cost when ignored: ~6 user round-trips insisting an input produced X while the user kept seeing Y — the user was right; the automated browser was stale.

### 4. Headless WebKit/Chromium on a desktop machine is NOT GPU-bound — useless for measuring MOBILE GPU perf deltas

When optimizing a WebGL scene for mobile/Safari GPU cost (resolution cap, MSAA, blend-mode overdraw, fill-rate), driving it with Playwright headless WebKit (or Chromium) on a desktop gives a **flat ~60 fps regardless of the renderer settings** — the desktop GPU absorbs pixel counts a phone can't. Observed: identical frame-time distribution (mean ~16.7 ms, p50 17, p99 18, 0 frames >33 ms) across BOTH `resolution=2` + MSAA on AND `resolution=1.5` + MSAA off, in the same scene. A headless FPS A/B between renderer configs shows **~0 delta by construction** and tells you nothing about the on-device win.

- Don't conclude "the optimization didn't help" from a headless FPS A/B — the bottleneck isn't reproduced.
- Measure the mobile GPU win **analytically** instead: device-pixel math (`resolution` 2.0→1.5 ⇒ `(1.5/2)² = 0.5625` ⇒ ~44% fewer fragment-shader invocations/frame), plus draw-call / additive-blend (overdraw) counting.
- Verify **correctness** directly: confirm the mobile code path APPLIED — e.g. read effective resolution as `canvas.width / parseFloat(canvas.style.width)` and expect the cap (1.5), not the raw `devicePixelRatio` (3) — and assert gating/visibility logic toggles via state, not via a screenshot pixel-diff.
- Trigger a mobile context so device-detection fires: `browser.newContext({ ...devices['iPhone 13'] })` gives iPhone UA + touch + DPR 3 + isMobile — but the ENGINE stays whatever you launched (the descriptor's `defaultBrowserType: 'webkit'` is honored only by the Playwright Test runner); launch `webkit` yourself to actually test WebKit.
- Ground truth for absolute on-device FPS is a physical phone, which Playwright cannot drive.

### Framework-specific siblings

Rendering-framework-specific verification recipes (freezing a scene's tickers for a deterministic screenshot, sampling motion on the render ticker instead of your own rAF) live in the domain skills — e.g. `domain-pixi` for Pixi.js.
