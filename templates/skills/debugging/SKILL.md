---
name: debugging
description: Debugging meta-patterns — what to do when fixes don't stick
---

# Debugging — Meta-Patterns

Not tooling (that's debug-bridge*) — patterns for the FIX process itself,
each distilled from a real multi-round failure.



## Meta-patterns — index (full text: `references/patterns.md`)

Each lesson below is a verified gotcha. Read `references/patterns.md` (or just the
section whose title matches) when the situation in its line is the one in front of you.

- **Same Defect in a THIRD Unit = Build a Roster Differential, Not a Third Point Fix** — When the same mistake turns up in a third member of a family — three checks, three handlers, three adapters — the fix that pays is a test over the **registry**, not…
- **Repeated Same Symptom After 2+ Fixes = Wrong Subsystem Target** — When the user reports the same perceived symptom after two or more rounds of plausible fixes, stop patching that surface.
- **Regressing Feature? Find the Principled Algorithm the Codebase Already Has** — When a feature keeps regressing across many patch cycles — tuning constants, reshaping curves, adjusting thresholds — stop inventing ad-hoc logic.
- **"Impossible in the Limit" ≠ "Cheap Lever Fails the Actual Case"** — When a global constant's effect scales with a per-case input, no single value can satisfy ALL inputs — that proof is correct.
- **"How Did It Work Before?" = Revert Signal** — When the user asks "how did the old way work?", "why not keep it simple / slightly different?", or "did you even try the original approach?" — that is not a request to…
- **A Regression YOU Introduced Is a REVERT, Never a Redesign** — Special case of the above with a sharper rule.
- **Model Emits What the Presenter Can't Deliver → Fix the Emitter, Check the Rejected-Fix Ledger First** — When a bug is a contract violation between a data/model layer and a presentation layer — the model emitted an outcome the presenter cannot honestly produce (an…
- **Predicted-vs-Measured Mismatch = Falsified Hypothesis; Verify the Fix Against the ORIGINAL Metric** — Two disciplines for "my fix is principled but the bug persists".
- **A Never-Reset Latch Is Stale on Occurrence 2 — Test the Second Run, Not the First** — When a value is latched once per occurrence (per request, per run, per cycle) behind a "0/null = unset" sentinel, and the code only ASSIGNS that field and never RESETS…
- **A Positional Join of Two Lists Silently Mispairs — Cross-Check Before Reporting** — Zipping two separately-produced sequences by position (not an explicit shared key) mispairs every row once their internal ordering diverges — yet the join succeeds and…
- **An Untested Explanation Is a Guess — Manipulate the Cause Before Reasoning From It** — A component fails to surface something it plausibly should have.
- **A Check Coarser Than the Symptom Can't Eliminate a Hypothesis — Re-Test the Reporter's Own Theory First, at Matching Resolution** — When the reporter names a mechanism up front (a boundary, seam, or junction in the affected content) and an early check "rules it out," distrust the check before the…
- **Verifying a SYMMETRIC Change: the Half You Can Already See Says Nothing About the Other** — A change with two mirrored halves (two edges, two directions, two endpoints) invites verifying one and inferring the other — especially when every capture happens to…
- **A Pixel/Threshold Detector Is Blind Without a Positive Control — Calibrate Against the Live Frame** — An automated visual detector built on a fixed color mask or threshold silently reports "cannot reproduce" the moment the live palette drifts from the one it was tuned on…
- **An A/B Diff Harness Proves Nothing Until It Has Been Shown to Detect a Difference** — Comparing two builds/engines/configs by diffing their outputs assumes the harness runs each arm correctly — but a malformed invocation (wrong flag order, wrong…
- **Temporary Instrumentation: Verify Its REMOVAL by Searching for the Marker** — Adding print statements to measure a real system is the right move when reading cannot answer the question.
- **Reproduced the Bug? Find the Commit That Introduced It BEFORE Designing the Fix** — A reproduction tells you WHICH invariant is violated now.
- **A Few Runs of a RANDOMIZED System Are Not a Before/After Measurement** — When the observable is an end-of-run aggregate (a score, a survival time, a count of handled items) and the run is driven by randomness, the same build produces a wide…
- **Before Demanding a BASELINE Run, Check the Baseline Can Produce the Signal** — The instinct on "did my change cause this?" is right, and the control run is the honest way to settle it.
- **A Measurement on an EXCLUSIVE Resource Is Void Unless Exclusivity Was Re-Checked Right Before It** — When the thing under measurement can be held by only one client at a time (a hardware codec, a device node, a GPU context, a single-slot license, an exclusive lock), any…
- **A Deadlock You Cannot Attach a Debugger To: Kernel State Names the Wait, Not the Waiter** — per-thread `wchan`/syscall look identical for every candidate cycle and the recorded `pc` is always libc; when no debugger can be installed, add flushed entry/exit tracing to a file instead of reasoning further.
- **A Tag-to-Tag Diff Exonerates Only the Artifacts the Repo Actually Tracks** — gitignored binaries (native extensions, plugins, vendored blobs) ship in the release but appear in no diff; `git check-ignore` the dependency before reading a clean diff as evidence, and swap that artifact…
- **A Tuning Knob Cannot Explain a Regression the Old Version Survived at the Same Value** — if the working version ran the same threshold/interval, changing it masks at best and falsifies nothing; check the setting's history before spending a run on it.
- **A Drop-In Replacement Measured BESIDE the Host Has Not Been Measured** — standalone arms all omit the shared resource (one GPU/context/event loop/input queue), so a component that is strictly cheaper alone can still break the host's UI; run the real host before calling the swap good.
- **New Failure Right After an Environment Change = Suspect the Change First** — When a failure appears right after you changed something in the test environment — a kernel module parameter, a driver setting, a fixture size, a mock's capacity — suspect that change before the product under test, even with a plausible product-side story in a different subsystem.
- **Ignoring a Side-Effecting Query's Result Makes the Caller Retry It — Filter at the Source** — When a callee both selects a best match AND mutates state as part of matching, filtering its result on the caller side doesn't just discard a bad answer — it makes the callee repeat the mutation on every later call and can hide a valid candidate behind the invalid one it preferred.
- **A Floating-Point Round-Trip Is Not Identity — Never Detect an Event by FP Equality** — `f(x) !== x` after a normalize/wrap/convert round-trip fires on in-range values that merely picked up 1 ULP, so an equality-gated callback ("did it wrap?", "did it change?") fires constantly; detect the event by the condition that causes it (range check, explicit flag), then normalize.
