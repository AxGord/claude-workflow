---
name: debugging
description: Debugging meta-patterns — what to do when fixes don't stick
---

# Debugging — Meta-Patterns

Not tooling (that's debug-bridge*) — patterns for the FIX process itself,
each distilled from a real multi-round failure.



## Meta-patterns — index (full text: `references/patterns.md`)

Titles only — each names the situation. Read `references/patterns.md` (or just the
section whose title matches) when the situation in its line is the one in front of you.

- **Same Defect in a THIRD Unit = Build a Roster Differential, Not a Third Point Fix**
- **Repeated Same Symptom After 2+ Fixes = Wrong Subsystem Target**
- **Regressing Feature? Find the Principled Algorithm the Codebase Already Has**
- **"Impossible in the Limit" ≠ "Cheap Lever Fails the Actual Case"**
- **"How Did It Work Before?" = Revert Signal**
- **A Regression YOU Introduced Is a REVERT, Never a Redesign**
- **Model Emits What the Presenter Can't Deliver → Fix the Emitter, Check the Rejected-Fix Ledger First**
- **Predicted-vs-Measured Mismatch = Falsified Hypothesis; Verify the Fix Against the ORIGINAL Metric**
- **A Never-Reset Latch Is Stale on Occurrence 2 — Test the Second Run, Not the First**
- **A Positional Join of Two Lists Silently Mispairs — Cross-Check Before Reporting**
- **An Untested Explanation Is a Guess — Manipulate the Cause Before Reasoning From It**
- **A Check Coarser Than the Symptom Can't Eliminate a Hypothesis — Re-Test the Reporter's Own Theory First, at Matching Resolution**
- **Verifying a SYMMETRIC Change: the Half You Can Already See Says Nothing About the Other**
- **A Pixel/Threshold Detector Is Blind Without a Positive Control — Calibrate Against the Live Frame**
- **An A/B Diff Harness Proves Nothing Until It Has Been Shown to Detect a Difference**
- **Temporary Instrumentation: Verify Its REMOVAL by Searching for the Marker**
- **Reproduced the Bug? Find the Commit That Introduced It BEFORE Designing the Fix**
- **A Few Runs of a RANDOMIZED System Are Not a Before/After Measurement**
- **Before Demanding a BASELINE Run, Check the Baseline Can Produce the Signal**
- **A Measurement on an EXCLUSIVE Resource Is Void Unless Exclusivity Was Re-Checked Right Before It**
- **A Deadlock You Cannot Attach a Debugger To: Kernel State Names the Wait, Not the Waiter**
- **A Tag-to-Tag Diff Exonerates Only the Artifacts the Repo Actually Tracks**
- **A Tuning Knob Cannot Explain a Regression the Old Version Survived at the Same Value**
- **A Drop-In Replacement Measured BESIDE the Host Has Not Been Measured**
- **New Failure Right After an Environment Change = Suspect the Change First**
- **Ignoring a Side-Effecting Query's Result Makes the Caller Retry It — Filter at the Source**
- **A Floating-Point Round-Trip Is Not Identity — Never Detect an Event by FP Equality**
- **`pkill -f` Inside a Remote Command String Kills Its Own Shell**
- **A Screen-Capture Session on the Device Voids Every Display Measurement**
- **Examples in a Comment Must Be Recomputed From the Code's Formula**
