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

## Serialization Doesn't Belong in Runtime State

**DON'T:** Put `serialize()`/`deserialize()` methods directly in runtime/state classes
**DO:** Keep serialization in a separate class or in the persistence layer

**Why:** Runtime state manages current values, interpolation, transitions. Serialization is I/O concern — different reason to change, different dependencies (XML, JSON, etc.). Mixing them inflates the class and hides the boundary.

**GOTCHA at review:** Inline serialization "works" and passes tests — the violation is structural, not functional. Actively check for it: if a class has both state logic AND `serialize`/`deserialize`, flag it.

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

**Example (abstracted):** an allocator tracked "taken by owner X"; the original caller excluded only MANUALLY-assigned resources from its forbidden set (auto-assigned ones were reassignable). Replacing that filter with a generic `isAvailable()` collapsed manual and auto into one check and blocked selectable resources.

**Rule:** A generic `isX()` that returns the same answer for semantically different states is a lossy abstraction. Before using it, check: does the original code care *why* the state is set, not just *that* it's set?

## Deleting a Mechanism for ONE Rejected Job — Enumerate ALL Its Jobs First

When you remove a function/call because one of its responsibilities is rejected or obsolete, list **every** side effect it has before deleting it. A mechanism named for one concern often quietly carries a second, still-needed concern — and the name masks it, so wholesale deletion silently disables the second.

**DON'T:** See "this does the rejected X" → delete the whole call/function.
**DO:** Trace every effect (what it sets, reveals, schedules, gates). Keep the still-needed effects; remove only the rejected one — often by splitting the dual-purpose function.

**Tell:** the deleted thing was a per-frame/lifecycle hook whose name describes only one job; the regression appears in an *adjacent* concern (visibility, enablement, layout), not the one you were targeting — and surfaces late (doc/visual pass), not in the correctness check.

**Example (abstracted):** a per-frame hook named for one job did TWO things through one output channel — it both *revealed* a layer (fade-in) and *hid* it near a moving object (the rejected job). Deleting the whole call removed the rejected behavior AND the reveal — the layer never appeared again. Fix: split the dual-purpose function, keep the reveal, drop only the rejected half.

## Refactoring Scope: Don't Escalate Lifecycle

When refactoring an inline operation into a two-phase approach (set intent + execute), match the original operation's lifecycle scope.

**DON'T:** Wrap the new orchestration in container-level stop/start if the original operated at element level
**DO:** Let existing element-level lifecycle (setters, listeners) handle transitions — they already work

**Example (abstracted):** an inline single-element swap was refactored to intent+reallocate and wrapped in container-level stop/start — whose start-gate imposed a minimum-count constraint the original inline swap never hit. The element-level setter already handled stop/start of the swapped pair.

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

When you add a new canonical input/output mechanism that does the same thing as existing legacy paths (a typed API replacing an untyped one, a structured event replacing a string topic, a new control replacing a shortcut), the default urge is to keep the legacy paths "for compatibility" and build a coexistence shim. Don't.

**DON'T:** Silently keep legacy paths AND add a coexistence shim (gates, target-checks, debouncers) so the new and old don't fight.
**DO:** Surface the question explicitly: "should we remove the old paths, or keep them?" — and prefer single-source by default.

**Symptom of violation:** you find yourself adding gating logic (coordinate checks, `if (ev.target === ...)` filters, `inflight` flags) just to make two input paths coexist when one is meant to subsume the other.

**Rule:** A new canonical mechanism is an opportunity to remove the old one, not to add a referee between them. If the user didn't explicitly ask to keep both, ask before keeping both.

## Accumulation/Leak Bugs: Fix the Lifecycle, Not a Sweep

When something grows unbounded (state files, DB rows, temp dirs, handles, cache entries), the artifact has a creation event but no deletion event tied to its owner's lifecycle.

**DON'T:** Add a periodic retention/TTL/prune sweep ("delete things older than N days"). It leaves the leak in place, adds a tunable nobody sets correctly, and needs a guard against its own edge cases (NaN window deleting everything).
**DO:** Tie the artifact's lifetime to its owner. Delete it at the terminal transition (session ends → its file is removed; process dies → its records go). The owner that creates it owns destroying it.

**Tell:** if your fix introduces a `RETENTION_DAYS`/`maxAge`/cleanup-cron, ask "why does this outlive its owner at all?" A retention sweep is a legitimate *policy* for audit data deliberately kept; it is the wrong tool for a missing teardown.

**Before designing the fix:** check sibling/related projects for an already-shipped fix of the same bug class (same author/org repos especially) and mirror its approach instead of inventing a parallel one.

## Changing a Value Invalidates State Sized From Its OLD Value — Not Just Live Readers

When you change a parameter X, the instinct is to update code that **reads** X. But state that was **computed/staged earlier** from X's old value (a precomputed position, a cached offset, a buffer size, a timeout deadline) doesn't "read" anything — it silently encodes the stale quantity. Those frozen values contradict the new X, often by the full ratio of old/new.

**DON'T:** Change X, fix the obvious live consumers, ship. The stale-derived state then fires with pre-change values intact.

**DO:** When changing X, enumerate not just "who reads X now" but "what was sized/positioned/scheduled FROM X (possibly long before X changed)." Re-derive those from the new X, or trigger their recompute at the moment X takes effect.

**Tell:** a downstream effect is off by a suspiciously clean multiple; bug magnitude ≈ `oldValue / newValue`.

**GOTCHA:** The stale computation may happen at a different time (init, precompute pass) than the code you just changed (tick, callback). Grep for every site that captures a derived value from X into a local variable, struct field, or closure — those are the freeze points.

## A Claimed-Negative Tradeoff Needs the Same Evidence as a Claimed-Impossible Fix

Do not tell the user a change makes things WORSE without deriving the actual result. A negative framing extrapolated from a stale note, a prior decision, or an intuitive "it'll scatter / fragment / break" mental model is not evidence.

**DON'T:** Warn "this will be markedly worse" / "destroys the existing structure" from memory or intuition, then ask the user whether to proceed.
**DO:** Run the concrete analysis that confirms or refutes the claim FIRST — then present the measured result, and only flag a downside that survives the measurement.

**Tell:** You're about to present a tradeoff as a downside, and your reason is a remembered decision ("we left this alone before") or a shape you pictured ("members will scatter"), not something you computed on the actual artifact.

**Example (abstracted):** asked to apply an automated reorder to a large file, the agent warned it would be "markedly worse", citing a stale note — the user pushed back; a one-command permutation check proved the change was content-neutral and mild. The unmeasured negative cost a round-trip and trust.

**Principle:** "I think this is worse" is a hypothesis, not a finding. The cost of measuring is usually one command; the cost of a wrong negative is a wasted round-trip and a user who now distrusts your tradeoff calls.

## Size/Savings Numbers: Measure the Full Closure Through the Real Pipeline

A quantitative claim ("switching source X→Y makes the artifact 3× smaller") given to the user becomes a decision input — if it's wrong in either direction, the user picks the wrong option. Two failure modes:

1. **Hidden ambient resolution understates the honest size.** A bundle "worked" in a test at a fraction of its honest size because its libs silently resolved a huge dependency from the SYSTEM. Check the transitive dependency closure (`objdump -p | grep NEEDED`, recursively) against what the bundle itself ships before quoting its size.
2. **The packaging path itself distorts the number.** An archive measured with different flags than production (e.g. `zip` without `-y` storing a large lib once per symlink) reported ~2× the honest size. Measure through the EXACT pipeline that ships, not a hand-rolled equivalent.

**Tell:** you're comparing options by size and one number came from a test that "just worked" on a machine with the dependency's ecosystem already installed, or from a different archiver/flags than production uses.

**DON'T:** Present partial-closure or wrong-pipeline numbers as the decision matrix.
**DO:** Verify both sides' numbers with the full dependency closure and the production packaging command before the user chooses.

## The User's Named Beat IS the Acceptance Criterion

When the requirement names a concrete observable event — a specific transition, a bounce, a distinct step in a sequence — that beat is not a flourish. It is the spec. Reproducing the surrounding behavior while omitting the named beat is a wrong implementation, not a simpler one.

**Tell:** You're choosing an implementation because it's easier or "reads cleaner," and the specific event the user named is no longer distinctly observable in the result. Or: the user says the new thing "looks the same as the old/plain one."

**DON'T:** Trade away a named beat for implementation simplicity or "plausibility" concerns without surfacing the trade-off.
**DO:**
1. Enumerate every named beat from the request.
2. For each, define how it will be **distinctly observable** (numerically or visually) and assert it before claiming done.
3. If you're about to drop a beat because it's hard or feels unphysical, surface that trade-off explicitly — don't silently omit it.
