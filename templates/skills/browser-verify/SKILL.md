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

**Per-sample unreliability is not the same as useless in aggregate.** In a FRONTMOST tab `drawImage` often does return live frames — just not every time, because the buffer may already have been presented. That failure is filterable rather than silent: an empty region encodes to a tiny constant-size dataURL, so `d.length > BLANK` separates real frames from dropped ones with no pixel inspection. When the question is the SHAPE of an animation over time rather than one exact moment, sampling in-page at 15-25 Hz and keeping the survivors beats both a screenshot loop (one round-trip per frame) and a screencast (§6) in setup cost:

```js
await new Promise(r => requestAnimationFrame(r));   // read while the buffer is still alive
ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);      // crop to the region under test
const d = out.toDataURL(); if (d.length > BLANK) shots.push({t, d});
await new Promise(r => setTimeout(r, 40));
```

Three things make it pay off: crop before encoding (a full-page dataURL per frame is megabytes); drive input from the SAME loop with synthetic `new KeyboardEvent('keydown', {key, code, keyCode})` dispatched on `window`, so a timed run plays itself while being sampled; and montage the decoded survivors into one grid image, so a whole sequence reads as a single tool result instead of N. A `browser_evaluate` writing its result to a file is restricted to the MCP's allowed roots (its own temp dir, the project root) — anything else is refused.

This answers "did it move, and through what shapes", NOT the questions above — it is still no proof that a GPU upload pipeline is alive, and two of its frames comparing equal means nothing.

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

### 5. `browser_evaluate` returning a long-pending Promise blocks the MCP call until its idle timeout — poll with short sync evaluates

A `browser_evaluate` whose function returns a Promise resolves only when that Promise settles. If the resolve condition never fires (app state never reaches it), the MCP tool call hangs until the server's idle timeout aborts it — observed 1800 s (30 min) lost on one call. The page keeps running fine; only your session is stuck, and you cannot cancel from your side.

- Wrong: `() => new Promise(res => { const check = () => { if (window.__done) res(...); else setTimeout(check, 300); }; check(); })` as the wait mechanism for app progress.
- Right: arm state-recording in the page (a flag/array on `window`), return immediately, then poll with SHORT synchronous evaluates (`() => ({ done: window.__done, n: window.__trace.length })`) between shell-side waits. Each poll returns in milliseconds regardless of app state.
- Compounding trap: if the condition is set by an in-page per-frame hook (rAF/ticker callback) and that hook THROWS every frame (e.g. calling a debug global that turned out to be an object, not a function), the app's render loop can freeze too — the game hangs mid-state AND the promise never resolves. Verify a debug global's type/shape with one cheap evaluate (`typeof window.__probe`, `Object.keys(...)`) BEFORE calling it inside a hook.
- Bounded promises (fixed `setTimeout` resolve, or a condition guaranteed by already-observed state) are fine — the rule is: never make an MCP evaluate's completion depend on app behavior you haven't yet confirmed.

### 6. Catching a transient load-time color flash — CDP screencast, not a screenshot loop

A sub-200ms solid-color flash during page load (e.g. an unpainted WebGL canvas compositing black, then the renderer's clear color, before the app's branded overlay mounts) is routinely MISSED by a `page.screenshot()` polling loop: each screenshot call has round-trip latency and forces a re-composite, yielding only ~2-5 captures/sec at unpredictable phases — the flash falls in the gaps.

- Wrong: poll `page.screenshot()` in a tight loop around page load and hope one capture lands on the flash frame.
- Right: open a CDP session and use the screencast — it delivers EVERY composited frame with compositor timestamps:
  ```js
  const cdp = await ctx.newCDPSession(page);
  cdp.on('Page.screencastFrame', ev => { frames.push({ts: ev.metadata.timestamp, data: ev.data}); cdp.send('Page.screencastFrameAck', {sessionId: ev.sessionId}); });
  await cdp.send('Page.startScreencast', {format: 'png', everyNthFrame: 1});
  await page.goto(url, {waitUntil: 'commit'});  // start screencast BEFORE goto
  ```
  Must ack every frame (`Page.screencastFrameAck`) or delivery stalls. Start the screencast BEFORE `goto` so the first paint is captured.
- Analysis trick: downscale each frame to ~8×8 and take the mean RGB; print only frames where the mean jumps (delta > ~6 per channel). A solid flash shows up as an exact color match (e.g. mean exactly (135,206,235) = the CSS `skyblue` clear color), which immediately identifies WHICH constant in code painted it.
- Companion diagnosis gotcha: a load-time flash usually has MULTIPLE independent layers, each with its own color source — body CSS background, the app container's own background (e.g. letterbox `#000`), and the canvas itself (composites BLACK between DOM insertion and its first render, then the renderer's clear color until the branded overlay mounts). Fixing one layer just exposes the next: enumerate every compositing layer top-down and re-capture after each fix — a single re-run "looks better" is not proof the flash chain is gone.

### 7. "Element jumps/jerks" in a camera- or layout-driven canvas app — reproduce across a VIEWPORT MATRIX, not one window size

A single test viewport can make the reported bug geometrically impossible. Observed: a camera "pull-back" re-anchor required `cameraX < 0`, which only happens on WIDE windows — at 1440×900 the camera clamped at its left world bound, the ball lost its screen anchor, and it jumped −209 px in ONE frame plus multi-frame drift; at the 500×700 repro viewport the camera had 21 px of slack, so the clamp never engaged and the bug could not occur. Four wrong fixes shipped before anyone resized the window.

- Any behavior gated on camera clamps at world bounds, aspect breakpoints, letterbox math, or scroll limits is viewport-dependent — test at minimum one narrow (~500 px) AND one wide (≥1440 px) window via browser resize; add DPR variants when transforms scale by resolution.
- Corollary: when the user insists a motion bug is real and your metrics are clean, suspect your repro CONDITIONS (viewport, dpr, frame rate) before suspecting the user.

### 8. `browser_run_code_unsafe` runs in the Playwright SERVER sandbox — no `setTimeout`, and a mid-script throw still leaves earlier side effects applied

The snippet passed to `browser_run_code_unsafe` executes in the Playwright server process, not the page — timer globals aren't defined there, so `await new Promise(r => setTimeout(r, ms))` throws `ReferenceError: setTimeout is not defined`. Use `await page.waitForTimeout(ms)` for delays; `setTimeout` inside `page.evaluate(...)` is fine since that runs in-page.

- Corollary: when such a script throws partway through, every `await` BEFORE the crash already ran — dispatched events, clicks, and state changes persist in the page. A conditional early `break`/branch can let execution reach further than "the first timer call" before crashing. If the page later shows "impossible" state, reconstruct exactly which statements executed before the throw instead of assuming the whole script was a no-op.

### 9. Long-lived Vite dev server serves a STALE optimizeDeps prebundle of workspace packages — silent wrong behavior, ZERO console errors

Vite pre-bundles linked workspace deps (`@scope/*` monorepo packages) into
`node_modules/.vite`. A dev server left running across a large edit session
can keep serving the OLD prebundle of an edited workspace package while the
app's own files are fresh — a mixed module graph. The symptom is NOT a crash:
the app runs, state machines advance, but behavior computed by the stale
package is silently wrong (observed: animations completing instantly — an
object teleporting to its end state for one frame — with a clean console,
which perfectly mimics an application bug in the new code).

- Tell: freshly-implemented behavior "breaks" in the browser while the full
  unit/typecheck suite for the same code is green, and the console shows no
  errors. Suspect the serving layer BEFORE the code.
- Fix: kill the dev server, `rm -rf node_modules/.vite`, restart with
  `--force`, hard-navigate a fresh tab — THEN re-test; only debug the code if
  the symptom survives a provably fresh serve.
- A fresh `browser_close` + navigate does NOT help — the staleness is
  server-side, not browser-cache-side (compare gotcha 3, which this can
  compound with).

### 10. A bare `import()` inside `page.evaluate` can resolve to a SECOND module instance — import the URL the page actually loaded

Dev servers that append a cache-busting query on HMR (`/src/foo.ts?t=1712…`) serve the app's module under that exact URL. A probe that imports the BARE specifier (`import('/src/foo.ts')`) gets a fresh, separate instance of the same file: its module-level state was never initialised, so any accessor built on that state throws ("not initialised", "call setup() first") or silently returns defaults — while the app beside it works fine. Waiting longer never helps; it is not a boot-timing problem.

- Wrong: `const m = await import('/src/world/terrain.ts'); m.sampleAt(x)` → throws, and the obvious reading ("the app hasn't finished booting") sends you down a dead end.
- Right: take the URL from the resource timeline, which records what was really fetched:
  ```js
  const url = performance.getEntriesByType('resource').map((e) => e.name)
    .find((n) => n.includes('/src/world/terrain.ts'));
  const m = await import(/* @vite-ignore */ url);
  ```
- The `/@fs/<abs path>/…` form has the same second-instance property. That is fine for a STATELESS module (read exported constants, run pure functions) and wrong for anything holding initialised state.
- Prefer a debug global the app itself installs (`window.__world`, a `getState()` hook) over any import when one exists — it is the app's instance by construction.

### 11. When YOUR measurement contradicts the user, the stale side can be THEIRS — check the environment before re-diagnosing

Gotcha 3 says suspect your own cache first, and that stays the default. The mirror case is real too: after editing a linked WORKSPACE PACKAGE, a tab the user already had open can keep running the pre-change module with a completely CLEAN console — no error, just the old behaviour. Nothing in their view says "stale", so an accurate report of theirs describes code that no longer exists.

- Tell: your instrumented run and their eyes disagree about the SAME input, your tests and typecheck are green, and the last edit was in a package the app imports rather than in its own source.
- Do, before claiming either side is wrong: re-measure the exact scenario yourself at DEFAULT settings (a numeric per-frame trace beats a screenshot), across every variant the app picks at random; then enumerate the serving layer — multiple dev servers routinely linger on adjacent ports, so list the listening processes and confirm which working directory each serves, and re-run against each one.
- Then hand over the numbers plus one concrete action ("hard reload"), not a verdict about who is wrong. Cheap, and it ends the loop in one round-trip.
- Also confirm you are comparing the same event: a URL parameter that pins a scenario often pins only the FIRST one, so a user's "I watched it again" can be a different, randomly drawn case.

### 12. `keyboard.press()` sends down and up in ONE tick — it cannot reproduce (or refute) a hold-split bug

A physical keypress lasts ~80-150 ms, i.e. several frames, and an app can hand control from one
screen to another between the two halves. `page.keyboard.press(key)` collapses that window to
zero, so a bug where the key-up lands in a screen that only armed itself after the key-down is
**invisible to `press()` by construction** — the automated check passes, the human's press fails
every time, and the report reads as "cannot reproduce".

- Verify any keyboard-driven transition with `keyboard.down(key)` → `waitForTimeout(150)` →
  `keyboard.up(key)`. Keep `press()` for input you only need delivered, not for handover paths.
- Same shape for the pointer: `mouse.click()` vs `mouse.down()` / wait / `mouse.up()`.
- The duration is the independent variable, so it is also the confirmation: if short passes and
  held fails with nothing else changed, the split IS the mechanism — no code reading needed.

### 13. A fixed wait for a randomized end-of-run state verifies the wrong frame

When the state you need (a crash screen, a level end, a timeout banner) arrives at a
content-dependent time, a `waitForTimeout(6000)` lands mid-run about as often as it lands on the
target — and the follow-up input then goes to the RUNNING app, whose screenshot looks like the
old bug still reproducing. Two verification runs of "the same" scenario silently test two
different things.

Poll for the state instead of timing it. For a frozen/paused screen, the cheap detector is a
clipped screenshot of a region that MOVES during normal operation, sampled twice ~250 ms apart:
`(await shot()).equals(await shot())` is true only once motion stopped.

```js
const clip = { x: 390, y: 175, width: 500, height: 330 };
for (let i = 0; i < 60; i++) {
  const a = await page.screenshot({ clip });
  await page.waitForTimeout(250);
  if (a.equals(await page.screenshot({ clip }))) break;
}
```

Keep the clip off any element that deliberately keeps animating on the target screen (a blinking
sprite, a spinner), or the loop never converges. Two ways this detector lies, both of which read
as a clean "reproduced / not reproduced" verdict:

- **No wait between the two samples.** Back-to-back captures can land inside one rendered frame, so
  the pair matches on the first iteration and the loop exits while the app is still running. A
  `found: 0` from a poll that was supposed to wait seconds is the tell.
- **A reference pixel sampled from the state you are NOT detecting.** Grabbing "background here"
  and waiting for a change fires on anything that drifts through — a passing cloud, a tooltip, a
  cursor. Sample the reference from the TARGET state instead (reach it once by hand, capture the
  pixel, then poll for an exact match); an exact-match detector cannot be tripped by a third state.

### 14. A sub-second animation is shorter than one MCP round trip — SLOW IT DOWN and time it from LOGS, not from screenshots

"Trigger it, then screenshot immediately" cannot catch a 300-500 ms transition: each tool call
carries seconds of its own latency, so the first capture already shows the settled state. That
reads exactly like "the animation never ran", and the natural next move — hunting for the reason
it does not play — is a hunt for a bug that is not there.

Two moves, in this order:

- **Widen the target.** Multiply the duration by 20-50 in whatever declares it (config, a
  constant) and rebuild. Now the transition outlasts the round trip and a single ordinary
  screenshot lands inside it. Put the value back when done — and treat the restore as part of the
  change, not as cleanup you will remember.
- **Time it from timestamped LOGS.** Trace at the start and at the completion callback and read
  the delta out of the console log. Do NOT infer duration by eyeballing how far along two
  screenshots look: their wall-clock spacing is the harness's latency, not the app's, so the same
  pair "proves" any speed you already suspect. An eyeballed pair produced a confident "this runs
  ~7x faster than configured" against a logged measurement of 14.94 s for a configured 15 s.

The same asymmetry decides where evidence must come from generally: screenshots answer WHAT it
looks like, logs answer WHEN and HOW LONG. Never let a screenshot pair answer a timing question.

### 15. Emulated mobile does not emulate the mobile INPUT STACK — a null result there is not evidence

`isMobile` / `hasTouch` / `Input.dispatchTouchEvent` give a desktop engine a touch API, not a
phone's gesture recognisers, its compatibility-mouse synthesis, or its rules about which node
has to carry a listener for touches to keep flowing. A touch bug that lives in any of those
reproduces perfectly on the device and never once in emulation — so the run comes back green
and the report reads "cannot reproduce", which is the same output as "fixed".

- Treat emulation as able to CONFIRM a touch path works, never to refute a reported one. The
  moment a user's touch symptom fails to appear, move to a real device before forming any
  hypothesis about it.
- Getting there is cheap: serve the build on the LAN and open it from the phone. What the
  device needs is an ON-SCREEN log — a fixed, `pointer-events: none` overlay printing each
  event with a timestamp — because there is no console to read. Print the DURATION between a
  press and its release in the line itself; that one number is usually the whole diagnosis.
- Reproduce the wrapper too. A page loaded directly and the same page in an iframe are
  different environments to a mobile browser, and a bug can live entirely in the second.

### 16. Instrumentation that ATTACHES a listener can be the CURE — a bug that vanishes under the probe is a finding

Adding a probe is assumed to be passive, and for a log line it is. But `addEventListener` is a
side effect: browsers decide what to deliver, and to whom, partly from where listeners are
attached. Widen a probe from one node to several and the symptom can disappear — at which
point the natural reading, "could not reproduce this time", throws away the answer. The probe
just named the root cause: the node it added a listener to is the node the code was missing one
on.

- **Tell:** the symptom is stable across several runs, you broaden the instrumentation, and the
  run goes green with no other change. Suspect the probe before crediting flakiness.
- Bisect the probe like any other change — one attachment point at a time — and the surviving
  one is the fix.
- Then put the log back to the exact shape that reproduced the bug before verifying the real
  fix. A verification run carrying the curative probe tests the diagnostic, not the change.

### 17. `window.focus()` + `document.hasFocus()` in the SAME evaluate can read STALE — trust the next EVENT, not the flag

Inside a cross-origin iframe, calling `focus()` then immediately reading `document.hasFocus()` in one evaluate can return `false` even though focus already moved — the parent's `document.activeElement` already points at the iframe, and the very next synthesised keypress is delivered to a listener inside that frame, which is only possible if the frame does hold focus. The lag is INTERMITTENT: the same code on a simpler page in the same session returns `true` immediately, which is what makes it dangerous — it reads as "the focus call failed here" and invites debugging a fix that already landed.

- Don't judge a focus change by the flag it sets. Confirm with an EVENT: dispatch a real key and assert a `keydown` listener in the target frame received it (and/or check the parent's `document.activeElement`).
- Example: `frame.focus(); frame.contentDocument.hasFocus()` → `false`, yet dispatching a `keydown` right after is caught by the frame's own listener — the delivered event is the evidence, the flag was stale.

### 18. An https-hosted build cannot reach a LOOPBACK server in Chrome by default — and the block is a grantable PERMISSION, not a wall

Pointing a deployed (https) page at a local server (`http://127.0.0.1:<port>`) fails with `Access to fetch … blocked by CORS policy: Permission was denied for this request to access the 'loopback' address space`. Two traps, and the second is the expensive one:

- The message says CORS, and it is **not** CORS — the server's headers are irrelevant, the preflight never reaches it. It is also **not** mixed content: loopback is a potentially-trustworthy origin, so the usual "serve it over https" reasoning does not explain this denial and does not fix it.
- "Denied" reads as a policy wall, so the natural conclusion is "this configuration is impossible, require https end to end". That conclusion is wrong and, written into a doc or handed to a user, it removes an option that works. The word **Permission** in the message is the tell: a permission can be granted.

Both routes past it work, in Chromium and in real Chrome: grant the site local-network access (Playwright: `context.grantPermissions(['local-network-access'], { origin })` — the name being accepted is itself proof the permission exists), or launch the browser with the check off (`--disable-features=LocalNetworkAccessChecks`), in a throwaway `--user-data-dir` so the flag applies to a fresh process. Serving the page from the same address space (a local dev server) needs neither.

**Method, not just the fact:** when a browser refuses a cross-origin/permission-shaped request, settle it with a ONE-VARIABLE matrix before documenting any constraint — arms for default, permission-granted, flag-disabled, × the automation build and the real browser channel, asserting one observable (the status of the first request). Six cheap arms replace a guess, and they separate "the app's transport is wrong" from "the browser refused" — a distinction that inverts the fix.

### 19. A per-frame motion trace timestamped with `performance.now()` lies under machine load when the animation runs on gsap

gsap's `lagSmoothing` (default: 500 ms threshold, 33 ms adjusted lag) credits a stalled frame with only ~33 ms of animation time. When a loaded machine drops a headless page to ~1 fps, the traced object advances a tiny game-time step per callback while the wall clock between callbacks is a full second — every wall-clock speed derived from the trace collapses roughly 30x, and detectors built on speed or shape (speed-collapse, "moves without traveling forward", teleport-by-speed) convict clean motion.

- **Tell:** a finding that reproduces only when several harness shards (or another heavy job) run in parallel, and vanishes on a solo rerun; a trace whose frame gaps run 1-2 seconds instead of ~16 ms.
- Fix: stamp samples with `gsap.ticker.time * 1000` (the lag-smoothed clock the timeline actually runs on — multiply by the active `timeScale` if one is set), not `performance.now()`.
- Corollary: a harness that stops recording by polling for an end state from the automation side (`waitForFunction`) is itself subject to the same lag, and records whatever happened AFTER the end state fired (a reset, a teleport home) — its capture is a fresh source of the same lie.
- Always solo-rerun a finding before trusting it; a parallel-only reproduction is machine load, not a bug.
- Related trap: a probe reading a scene object by CHILD INDEX of a container (`layer.children[2]`) silently reads the wrong node once anything else is mounted earlier in that container — every detector then reads a flat line and "passes". Read the traced object by reference via an app-installed debug getter, and fail the run (don't silently pass) if the object it traces never moves.

### Framework-specific siblings

Rendering-framework-specific verification recipes (freezing a scene's tickers for a deterministic screenshot, sampling motion on the render ticker instead of your own rAF) live in the domain skills — e.g. `domain-pixi` for Pixi.js.
