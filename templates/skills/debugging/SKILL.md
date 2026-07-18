---
name: debugging
description: Debugging meta-patterns — what to do when fixes don't stick
---

# Debugging — Meta-Patterns

Not tooling (that's debug-bridge*) — patterns for the FIX process itself,
each distilled from a real multi-round failure.

## Repeated Same Symptom After 2+ Fixes = Wrong Subsystem Target

When the user reports the same perceived symptom after two or more rounds of plausible fixes, stop patching that surface. A symptom that survives multiple reasonable fixes is almost always at the **seam between two decoupled subsystems** — a baked/precomputed path vs. a live event; a cached value vs. its source; a predicted value vs. an independently-computed actual.

**DON'T:** Keep refining one side each iteration — shapes, easing, constants, thresholds — to match the user's latest wording.

**DO:** By the 2nd repeat, trace BOTH subsystems end-to-end and ask: "why do these two representations exist, and must they?" The fix is to make them **coincide** — re-derive one from the other at the authoritative moment — not to tune one side.

**Tell:** Every "fix" addresses the user's latest description verbatim, yet the user keeps saying "same thing / didn't help." You find yourself adjusting constants repeatedly with no lasting effect.

**GOTCHA:** The seam is invisible when you look at only one subsystem. You must trace both from their shared input to their diverging output paths to see the gap. (Real case: four rounds of tuning a precomputed trajectory failed because the actual hit was computed by a SEPARATE live simulation — the fix was re-deriving one from the other at start time, which no amount of trajectory tuning could achieve.)

## Regressing Feature? Find the Principled Algorithm the Codebase Already Has

When a feature keeps regressing across many patch cycles — tuning constants, reshaping curves, adjusting thresholds — stop inventing ad-hoc logic. Ask: **"what does correct behavior fundamentally require, and does this codebase already compute that for some other case?"**

**DON'T:** Keep hand-rolling case-specific heuristics to chase the latest symptom. Each variant is "more specific" than the last and never converges.

**DO:** Grep for the concept (clearance, retry, normalization, lift…). If a general implementation exists, find why the failing case is excluded from it — an early `return`, a zone guard, a capability flag. That exclusion is the smoking gun: someone already solved it generally, then deliberately opted out the hard case. Mirror or apply that proven algorithm to the excluded case, using its same constants for parity. Ask the "do we already do it elsewhere?" question by the **2nd** regression, not the 6th.

**Tell:** You're writing the Nth variant of the same code path and each fix is narrower than the last. A sibling module has a richer version of the same routine that the failing path doesn't call.

**GOTCHA:** The exclusion guard often looks load-bearing. Verify it with the principled algorithm before assuming it's correct — it may just be an early simplification that was never revisited.

## "Impossible in the Limit" ≠ "Cheap Lever Fails the Actual Case"

When a global constant's effect scales with a per-case input, no single value can satisfy ALL inputs — that proof is correct. But it does NOT establish that the constant fails the specific case in front of you.

**DON'T:** Write an elegant impossibility argument for the general case and propose a per-case solver/refactor without having run the simple fix once.
**DO:** Try the cheapest knob empirically first — adjust the constant, widen the relevant tolerance, measure the real target. Reserve the heavy solution for when the simple lever is *measured* to fail, not when it's only *proven* imperfect in the limit.

**Principle:** "Can't be perfect for all" ≠ "doesn't work for this." Empirical failure on the actual target is required evidence; theoretical failure on adversarial inputs is not.

**Tell:** You're composing a sound argument for why a simple fix "structurally cannot work" and proposing architecture instead — without having run the simple fix once. That's the signal to stop, try the knob, and measure.

## "How Did It Work Before?" = Revert Signal

When the user asks "how did the old way work?", "why not keep it simple / slightly different?", or "did you even try the original approach?" — that is not a request to polish the new mechanism. It is evidence the new direction is wrong.

**DON'T:** Defend the new design across multiple fix→verify cycles, trading one symptom for another, while the user keeps invoking prior behavior.
**DO:** By the 2nd such pushback, diff against the pre-change baseline. Articulate honestly what the original did and why it was adequate. Offer to revert before sinking more cycles.

**Tell:** You are on the 3rd+ iteration fixing your own new mechanism; each fix introduces a new symptom; the user's questions consistently reference what it used to do. The thrash itself is the signal — the baseline was right.

**Principle:** Repeated pushback that references prior/simpler behavior is not polish feedback — it is a direction correction. Reverting to a known-good baseline is a first-class fix, not a failure.

## A Regression YOU Introduced Is a REVERT, Never a Redesign

Special case of the above with a sharper rule. When the user's complaint is
about behavior that broke AFTER your own change (especially collateral from a
fix aimed at a DIFFERENT symptom), the spec for "fixed" is the pre-change
baseline — not your judgment of what the mechanism should be. Redesigning it
means guessing the baseline from memory; every guess that misses costs a full
user round-trip and erodes trust.

**DON'T:** Iterate replacement designs for the thing you broke (observed
cascade: synthesis → tune-to-measured-baseline → full-physics rewrite — each
"fix" more ambitious than the last while the user kept saying "it worked
before").
**DO:** Identify the exact edit of yours that first changed the behavior,
restore that code path verbatim, and prove the restoration with a mechanical
oracle (frozen fixtures re-passing WITHOUT regeneration, byte-diff of
generated outputs, golden files) — not with "looks right".

**Tell:** Your successive fixes for one complaint GROW in scope. Scope growth
while the user references the past is the strongest possible revert signal —
by the time you're proposing an architecture, the answer was `git diff` to
the baseline three rounds ago.

**Corollary:** In a long-running UNCOMMITTED working tree, "revert" may mean
hand-reconstruction. Commit checkpoints at every user-visible-good state so a
revert is one command, not an archaeology project.

## Model Emits What the Presenter Can't Deliver → Fix the Emitter, Check the Rejected-Fix Ledger First

When a bug is a contract violation between a data/model layer and a
presentation layer — the model emitted an outcome the presenter cannot
honestly produce (an unreachable target, a state the UI can't render as one
coherent motion) — the durable fix is in the EMITTER: stop emitting
undeliverable pairings, constrained against the presenter's real capability.

**DON'T:** Patch the presenter to fake the model's claimed outcome (splicing
a canned glide/animation to "reach" a value the simulation never hit) —
however small the visual gap, it reads as fake physics and gets rejected.
**DO:** Measure the presenter's honest capability empirically — drive its
real pipeline over a parameter grid, not a hand-derived geometric bound
(chaotic outcomes have no clean closed-form threshold). Constrain the
emitter to the measured-deliverable region. Before designing the fix, check
the project's record of previously rejected fix families (memory/docs/commit
lore) — a design in a rejected family costs a full user round-trip
regardless of execution quality.

**Tell:** Your fix adds presentation-side code animating toward a model
value the simulation never reached; or you're about to ship a fix pattern
the project's history already rejected under a different symptom.

## Predicted-vs-Measured Mismatch = Falsified Hypothesis; Verify the Fix Against the ORIGINAL Metric

Two disciplines for "my fix is principled but the bug persists".

**Falsifier rule:** when a candidate mechanism lets you PREDICT an observable
consequence — the time, place, or value at which something should happen —
and the prediction MISSES what you measured (even slightly), the hypothesis
is FALSIFIED, not "measurement noise / seeding uncertainty". A real but
MASKED cause (a second effect hiding behind the one you're studying) produces
exactly this trap: the fix is sound in isolation, measures zero effect, and
the mismatch was the tell all along. Don't absorb the gap — find what your
model didn't account for.

**Post-fix gate:** after applying the fix, re-run the ORIGINAL failing metric,
not a proxy. A byte-identical result means you changed the wrong thing →
return to diagnosis; never start tuning the fix's parameters to chase the
symptom (that's curve-fitting, not fixing).
