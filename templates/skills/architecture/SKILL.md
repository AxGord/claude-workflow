---
name: architecture
description: Simplicity-first architecture decisions
---

# Architecture — Behavioral Correction

Claude's #1 architecture mistake: **adding complexity before pain exists.**

## Before Suggesting ANY Pattern

Three questions (if you can't answer all three concretely, suggest the simpler option):
1. **What specific pain exists RIGHT NOW?** (not theoretical)
2. **What's the simplest thing that solves just this pain?**
3. **How will I know when this decision becomes wrong?** (exit criteria)

## The Interface Trap (Verified Gotcha)

**DON'T:** Create interfaces "for testability" or "future flexibility"
**DO:** Create interfaces when you have 2+ real implementations OR a package boundary
**GOTCHA:** Single implementation behind interface is ceremony, not architecture
**EXCEPTION:** Public library APIs only

Models often default to "interfaces for testing are fine" — this skill corrects that.

## Response Template

```
Simple approach: [simplest solution]
This works until: [specific pain point]

If you hit that pain, then consider: [next step up]
This adds: [specific cost]
But solves: [specific problem]
```

## Initialization Belongs to the Owner

When a component needs setup logic (creating initial children, dispatching init events, setting initial state), that logic belongs **inside** the component — not in its parent.

**DON'T:** Parent creates component, then manually triggers component's internal logic from outside
**DO:** Component exposes an `open()` / `init()` method or handles it in constructor — parent just calls that

**Why:** Parent shouldn't know component's internal structure. If internals change, only the component changes — parent stays untouched.

## Runtime State Belongs to the Element Owner

When a UI element's state depends on app data (enabled/disabled, tooltip, label), the **decision logic** belongs in the component that owns the element — not in a parent coordinator.

**DON'T:** Parent computes `blocked = ...`, then sets `child.button.disabled = blocked` and `tooltipManager.add(child.button, text)`
**DO:** Parent passes raw data (`updateState(hasX, count)`), the owner decides and applies

**Why:** The owner already manages the element's other state (tooltips on language change, default values). If the parent bypasses the owner, state changes from different sources (language change, limit check) overwrite each other. When the owner controls all paths, it can cache state and re-apply consistently.

**Symptom of violation:** a parent sets a custom tooltip on a child's element, then a language-change handler in the child overwrites it — because the child doesn't know about the parent's custom state.

## Serialization Doesn't Belong in Runtime State

**DON'T:** Put `serialize()`/`deserialize()` methods directly in runtime/state classes
**DO:** Keep serialization in a separate class or in the persistence layer

**Why:** Runtime state manages current values, interpolation, transitions. Serialization is I/O concern — different reason to change, different dependencies (XML, JSON, etc.). Mixing them inflates the class and hides the boundary.

**GOTCHA at review:** Inline serialization "works" and passes tests — the violation is structural, not functional. Actively check for it: if a class has both state logic AND `serialize`/`deserialize`, flag it.

## Event Re-dispatch: Don't Duplicate `target`

When a composite re-dispatches events from children, `event.target` already identifies the original source.

**DON'T:** Add a `targetSource` / `originalSender` field to carry the child reference through re-dispatch
**DO:** Only add fields for data the child genuinely doesn't know (e.g. its index in the parent's collection)

**Rule:** Every field in an event must have at least one consumer. "Might be useful later" fields are overengineering.

## Trace Full Data Flow Before Designing

Before proposing ANY storage or data mechanism, trace the COMPLETE path:
1. **Where is it written?** (file save, cache build, sync download)
2. **How is it serialized?** (binary format, XML, DB column)
3. **How is it loaded?** (deserialized, copied, transformed)
4. **How does it reach the consumer?** (direct reference, copy, event)

**DON'T:** Propose new storage mechanisms (counters, file scanning, new DB columns) before checking if the project already has infrastructure for this type of data.
**DO:** Find how analogous fields in the same system are stored and propagated. Follow the same path.

Common mistake: understanding WHERE data is stored but not HOW it flows through intermediate layers (serialization, copy-on-read, event dispatch). Missing one copy step = silent data loss.

When in doubt: **suggest the boring, proven, simple solution.**

## Guard Externalization: Clean Up the Callee

When moving a conditional guard from inside a function to its call site (wrapping the call in `if`), immediately remove the now-redundant parameter/branch from the callee.

**DON'T:** Make the call conditional but leave the parameter that's now always the same value
**DO:** Remove the parameter entirely — the caller's `if` IS the guard now

**Why:** A parameter that's always `true` (or always `false`) is dead code. It misleads readers into thinking there's a second code path. Finish the refactor in one step.

## Refactoring Toward Shared State: Preserve Semantic Categories

When moving filtering logic from a caller into a shared state manager (allocator, registry, cache), verify the manager's API distinguishes all semantic categories the original code handled.

**DON'T:** Replace an explicit filter with a generic state query that collapses distinct categories
**DO:** List every category the original filter distinguished, confirm the API preserves each — or extend the API

**Example:** A resource allocator tracks "taken by owner X". Original code built a `forbidden` set from only *manually* assigned resources — auto-assigned ones were excluded because reallocation would reassign them. Replacing `forbidden` with `allocator.isAvailable()` collapsed manual and auto into one check, blocking resources that should have been selectable.

**Rule:** A generic `isX()` that returns the same answer for semantically different states is a lossy abstraction. Before using it, check: does the original code care *why* the state is set, not just *that* it's set?

## Deleting a Mechanism for ONE Rejected Job — Enumerate ALL Its Jobs First

When you remove a function/call because one of its responsibilities is rejected or obsolete, list **every** side effect it has before deleting it. A mechanism named for one concern often quietly carries a second, still-needed concern — and the name masks it, so wholesale deletion silently disables the second.

**DON'T:** See "this does the rejected X" → delete the whole call/function.
**DO:** Trace every effect (what it sets, reveals, schedules, gates). Keep the still-needed effects; remove only the rejected one — often by splitting the dual-purpose function.

**Tell:** the deleted thing was a per-frame/lifecycle hook whose name describes only one job (`dodge`, `sync`, `refresh`); the regression appears in an *adjacent* concern (visibility, enablement, layout), not the one you were targeting — and surfaces late (doc/visual pass), not in the correctness check.

**Concrete example (illustrative):** A per-frame `noteActorPosition` did TWO things via one alpha lane — faded decorative props IN (made the field *visible*) and faded them OUT near the moving actor (the *proximity dodge*). The user rejected the dodge (alpha-hiding the path). Deleting the whole call removed the dodge **and** the field's visibility → the entire decorative prop field went invisible (`alpha=0` forever). Fix: split — keep a one-time fade-IN (reveal) gated by a `fadeIn` flag, drop only the per-frame fade-OUT. The reveal and the dodge had been fused in one function; the name ("dodge") hid the reveal.

## Refactoring Scope: Don't Escalate Lifecycle

When refactoring an inline operation into a two-phase approach (set intent + execute), match the original operation's lifecycle scope.

**DON'T:** Wrap the new orchestration in container-level stop/start if the original operated at element level
**DO:** Let existing element-level lifecycle (setters, listeners) handle transitions — they already work

**Example:** A self-contained `selectNext()` swapped one item inline (release + take + index setter handled stop/start). Refactored to set intent + reallocate(). Added container-level stop/start around it. But start had an `isAvailable()` gate requiring a minimum active count — a constraint the original inline operation never hit. The element-level index setter already stops the old item and starts the new one.

**Rule:** Before adding lifecycle management to a refactored operation, check: did the original operation need it? If the original worked within existing infrastructure (setters, listeners), the refactored version should too.

## Signature Change → Grep All Callsites

When changing a method's return type, parameter list, or visibility, grep ALL callsites BEFORE finalizing the change.

A signature change compiles fine in the modified file but silently breaks callers that ignore the new return type. Example: `clearData(): void` → `clearData(): ITask` — callers that fired-and-forgot still compile; the returned ITask is constructed and discarded; the async work never starts. No compile error, no exception — the cleanup pipeline is a no-op.

**Symptom**: behavior silently regresses in code paths nobody runs during initial smoke test. Caught later by code reviewers, integration tests, or production bugs.

**DON'T:** Change a signature, run the obvious test, declare done.
**DO:** Change a signature, grep `<methodName>\b` across the whole project, audit each callsite. Trust "find references" only if the IDE has full project indexing.

**Adding a member to an interface/abstract type is also a signature change.** Every implementor must gain the member — including hand-written test doubles / fakes / in-memory stubs, not just production classes.

**Tooling gotcha:** test runners that strip types via esbuild/swc (vitest, ts-jest `isolatedModules`, bun test) do NOT typecheck. A test double missing a newly-added interface method compiles fine and fails at RUNTIME as `TypeError: x.method is not a function` — often in unrelated tests that happen to reach the missing call. `tsc --noEmit` catches it; the test run alone does not.

**DO:** after adding an interface member, grep for `implements <Interface>` and for the type used as a field/param type, and update every implementor (prod + test) in the same change; run `tsc` (not just the test suite) before declaring done.

## New Canonical Path → Ask About Legacy Parallels

When you add a new canonical input/output mechanism that does the same thing as existing legacy paths (e.g. UI buttons that replicate keyboard shortcuts, a typed API replacing an untyped one, a structured event replacing a string topic), the default urge is to keep the legacy paths "for compatibility" and build a coexistence shim. Don't.

**DON'T:** Silently keep legacy paths AND add a coexistence shim (coordinate gates, target-checks, debouncers) so the new and old don't fight.
**DO:** Surface the question explicitly: "should we remove the old paths, or keep them?" — and prefer single-source by default.

**Example:** Added UI panel buttons that already handle the full action flow. Kept the original canvas tap (= fire) AND keyboard shortcuts (= fire). Adding the buttons made every panel click double-fire (tap dispatched on both panel and canvas), so a Y-coord gate was introduced to suppress canvas handling over the panel area. After confirming "remove keys and canvas-click entirely, the buttons are the way" — the gate became dead code, deleted in the same pass.

**Symptom of violation:** you find yourself adding gating logic (coordinate checks, `if (ev.target === ...)` filters, `inflight` flags) just to make two input paths coexist when one is meant to subsume the other.

**Rule:** A new canonical mechanism is an opportunity to remove the old one, not to add a referee between them. If the user didn't explicitly ask to keep both, ask before keeping both.

## Accumulation/Leak Bugs: Fix the Lifecycle, Not a Sweep

When something grows unbounded (state files, DB rows, temp dirs, handles, cache entries), the artifact has a creation event but no deletion event tied to its owner's lifecycle.

**DON'T:** Add a periodic retention/TTL/prune sweep ("delete things older than N days"). It leaves the leak in place, adds a tunable nobody sets correctly, and needs a guard against its own edge cases (NaN window deleting everything).
**DO:** Tie the artifact's lifetime to its owner. Delete it at the terminal transition (session ends → its file is removed; process dies → its records go). The owner that creates it owns destroying it.

**Tell:** if your fix introduces a `RETENTION_DAYS`/`maxAge`/cleanup-cron, ask "why does this outlive its owner at all?" A retention sweep is a legitimate *policy* for audit data deliberately kept; it is the wrong tool for a missing teardown.

**Before designing the fix:** check sibling/related projects for an already-shipped fix of the same bug class (same author/org repos especially) and mirror its approach instead of inventing a parallel one.

## Repeated Same Symptom After 2+ Fixes = Wrong Subsystem Target

When the user reports the same perceived symptom after two or more rounds of plausible fixes, stop patching that surface. A symptom that survives multiple reasonable fixes is almost always at the **seam between two decoupled subsystems** — a baked/precomputed path vs. a live event; a cached value vs. its source; a predicted position vs. an independently-simulated actor.

**DON'T:** Keep refining one side each iteration — curve shape, easing, constants, thresholds — to match the user's latest wording.

**DO:** By the 2nd repeat, trace BOTH subsystems end-to-end and ask: "why do these two representations exist, and must they?" The fix is to make them **coincide** — re-derive one from the other at the authoritative moment — not to tune one side.

**Tell:** Every "fix" addresses the user's latest description verbatim, yet the user keeps saying "same thing / didn't help." You find yourself adjusting geometry or timing constants repeatedly with no lasting effect.

**GOTCHA:** The seam is invisible when you look at only one subsystem. You must trace both from their shared input to their diverging output paths to see the gap.

**Concrete example:** A game ball flew a fixed pre-baked bézier to a predicted endpoint; the actual hit fired from a per-frame overlap test against a separately-simulated moving sprite. Four curve-shape fixes (overshoot, speed, bulge, straight-line) all failed because the real defect was the timing seam between the two decoupled systems. Resolution: re-derive the sprite's velocity at the true flight start so ball and sprite converge at one shared point. Cost: 5 user round-trips before the architecture was traced.

## Regressing Feature? Find the Principled Algorithm the Codebase Already Has

When a feature keeps regressing across many patch cycles — tuning constants, reshaping curves, adjusting thresholds — stop inventing ad-hoc logic. Ask: **"what does correct behavior fundamentally require, and does this codebase already compute that for some other case?"**

**DON'T:** Keep hand-rolling case-specific geometry or heuristics to chase the latest symptom. Each variant is "more specific" than the last and never converges.

**DO:** Grep for the concept (clearance, retry, normalization, lift…). If a general implementation exists, find why the failing case is excluded from it — an early `return`, a zone guard, a capability flag. That exclusion is the smoking gun: someone already solved it generally, then deliberately opted out the hard case. Mirror or apply that proven algorithm to the excluded case, using its same constants and sampling strategy for parity. Ask the "do we already do it elsewhere?" question by the **2nd** regression, not the 6th.

**Tell:** You're writing the Nth variant of the same code path and each fix is narrower than the last. A sibling module has a richer version of the same routine that the failing path doesn't call.

**GOTCHA:** The exclusion guard often looks load-bearing (e.g., "air shots have no terrain"). Verify it with the principled algorithm before assuming it's correct — it may just be an early simplification that was never revisited.

**Concrete example (illustrative):** An air-launched projectile kept clipping terrain through ~6 patch iterations (overshoot tweaks, speed adjustments, straight-line approximations). The math package already had a `raiseArcOverTerrain` routine — raises a bézier peak until it clears terrain minus a margin — but it explicitly `return`ed early for `zone === 'air'`. Fix: mirror that exact algorithm renderer-side for the excluded zone. No amount of curve reshaping could have matched it because the principled clearance math was simply never reached.

## Changing a Value Invalidates State Sized From Its OLD Value — Not Just Live Readers

When you change a parameter X, the instinct is to update code that **reads** X. But state that was **computed/staged earlier** from X's old value (a precomputed position, a cached offset, a buffer size, a timeout deadline) doesn't "read" anything — it silently encodes the stale quantity. Those frozen values contradict the new X, often by the full ratio of old/new.

**DON'T:** Change X, fix the obvious live consumers, ship. The stale-derived state then fires with pre-change geometry/timing intact.

**DO:** When changing X, enumerate not just "who reads X now" but "what was sized/positioned/scheduled FROM X (possibly long before X changed)." Re-derive those from the new X, or trigger their recompute at the moment X takes effect.

**Tell:** a downstream actor moves/scales ~the ratio of old:new too far/fast (e.g. ~10×); a thing that used to line up now overshoots by a suspiciously clean multiple; bug magnitude ≈ `oldValue / newValue`.

**GOTCHA:** The stale computation may happen at a different time (launch, init, precompute pass) than the code you just changed (tick, render, callback). Grep for every site that captures a derived value from X into a local variable, struct field, or closure — those are the freeze points.

**Concrete example:** A projectile's flight duration was shortened ~6×. The flight-playback code was updated. But an interceptor's ENTRY POSITION had been staged at launch as `start + speed · OLD_duration` (far away, sized for the long flight); the resync only re-solved its velocity over that stale far position → it streaked in ~10× too fast. Fix: re-STAGE the entry from the new duration (`position + velocity · newDuration`), not just re-solve velocity. The corrected duration must drive every derived value — including positions frozen before the change — from a single source.

## "Impossible in the Limit" ≠ "Cheap Lever Fails the Actual Case"

When a global constant's effect scales with a per-case input, no single value can satisfy ALL inputs — that proof is correct. But it does NOT establish that the constant fails the specific case in front of you.

**DON'T:** Write an elegant impossibility argument for the general case and propose a per-case solver/refactor without having run the simple fix once.
**DO:** Try the cheapest knob empirically first — adjust the constant, widen the relevant tolerance, measure the real target. Reserve the heavy solution for when the simple lever is *measured* to fail, not when it's only *proven* imperfect in the limit.

**Principle:** "Can't be perfect for all" ≠ "doesn't work for this." Empirical failure on the actual target is required evidence; theoretical failure on adversarial inputs is not.

**Tell:** You're composing a sound argument for why a simple fix "structurally cannot work" and proposing architecture instead — without having run the simple fix once. That's the signal to stop, try the knob, and measure.

## A Claimed-Negative Tradeoff Needs the Same Evidence as a Claimed-Impossible Fix

The mirror of "Impossible in the Limit ≠ Cheap Lever Fails": just as you must not call a simple fix impossible without running it, do not tell the user a change makes things WORSE without deriving the actual result. A negative framing extrapolated from a stale note, a prior decision, or an intuitive "it'll scatter / fragment / break" mental model is not evidence.

**DON'T:** Warn "this will be markedly worse" / "destroys the existing structure" from memory or intuition, then ask the user whether to proceed.
**DO:** Run the concrete analysis that confirms or refutes the claim FIRST — then present the measured result, and only flag a downside that survives the measurement.

**Tell:** You're about to present a tradeoff as a downside, and your reason is a remembered decision ("we left this alone before") or a shape you pictured ("members will scatter"), not something you computed on the actual artifact.

**Concrete example:** Asked to apply an automated member-reorder to a 12k-line god-file, the agent told the user it would be "markedly worse" — destroying intentional locality, exploding one guard block into scattered fragments — citing a stale "leave this file alone" note. The user pushed back: "why worse? I expect better." The analysis the agent should have done first: a sorted line-multiset diff (proved the reorder was a pure permutation — zero content changed) and an index-contiguity + identical-condition-dedup check (proved the guarded cluster stayed one contiguous block). The real change was mild and arguably cleaner. The unmeasured negative cost a user round-trip.

**Principle:** "I think this is worse" is a hypothesis, not a finding. Before it reaches the user as a reason to hesitate, derive it on the real input — the cost of measuring is usually one command; the cost of a wrong negative is a wasted round-trip and a user who now distrusts your tradeoff calls.

## "How Did It Work Before?" = Revert Signal

When the user asks "how did the old way work?", "why not keep it simple / slightly different?", or "did you even try the original approach?" — that is not a request to polish the new mechanism. It is evidence the new direction is wrong.

**DON'T:** Defend the new design across multiple fix→verify cycles, trading one symptom for another, while the user keeps invoking prior behavior.
**DO:** By the 2nd such pushback, diff against the pre-change baseline. Articulate honestly what the original did and why it was adequate. Offer to revert before sinking more cycles.

**Tell:** You are on the 3rd+ iteration fixing your own new mechanism; each fix introduces a new symptom; the user's questions consistently reference what it used to do. The thrash itself is the signal — the baseline was right.

**Principle:** Repeated pushback that references prior/simpler behavior is not polish feedback — it is a direction correction. Reverting to a known-good baseline is a first-class fix, not a failure.

## The User's Named Beat IS the Acceptance Criterion

When the requirement names a concrete observable event — a strike, a bounce, a wobble, a specific sequence — that beat is not a flourish. It is the spec. Reproducing the surrounding motion while omitting the named beat is a wrong implementation, not a simpler one.

**Observed failure:** User asks for "X hits a corner and visibly bounces, then branches." Agent repeatedly delivers a fast ease-to-stop or a smooth pass-through — dropping the bounce — and declares it done. Each simplification felt cleaner or more physically plausible. User rejected it each time: "there is no bounce, this is identical to the plain case." Required explicit re-statement of the task before the beat was built.

**Tell:** You're choosing a motion because it's easier to implement or "reads cleaner," and the specific event the user named is no longer distinctly visible in the result. Or: the user says the new thing "looks the same as the old/plain one."

**DON'T:** Trade away a named beat for implementation simplicity or "physical plausibility" concerns without surfacing the trade-off.
**DO:**
1. Enumerate every named beat from the request.
2. For each, define how it will be **distinctly observable** (numerically or visually) and assert it before claiming done.
3. If you're about to drop a beat because it's hard or feels unphysical, surface that trade-off explicitly — don't silently omit it.
