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

## Lessons — index (full text: `references/lessons.md`)

Each lesson below is a verified gotcha. Read `references/lessons.md` (or just the
section whose title matches) when the situation in its line is the one in front of you.

- **Serialization Doesn't Belong in Runtime State** — **DON'T:** Put `serialize()`/`deserialize()` methods directly in runtime/state classes **DO:** Keep serialization in a separate class or in the persistence layer…
- **Trace Full Data Flow Before Designing** — Before proposing ANY storage or data mechanism, trace the COMPLETE path: 1.
- **Guard Externalization: Clean Up the Callee** — When moving a conditional guard from inside a function to its call site (wrapping the call in `if`), immediately remove the now-redundant parameter/branch from the…
- **Extraction Carries the Code, Not the Guard Around It** — When you move code out of a `try` / lock / guard / enclosing `if` — extracting a loop or a block into its own function — the statements move but the protection the enclosing structure was giving them does not travel with…
- **Refactoring Toward Shared State: Preserve Semantic Categories** — When moving filtering logic from a caller into a shared state manager (allocator, registry, cache), verify the manager's API distinguishes all semantic categories the…
- **A Shared Predicate Whose "Safe" Default Differs Per Caller Cannot Be Tightened In Place** — A shared boolean query (`isReachable`, `mayAlias`, `canProveX`) can be imprecise in one direction — it returns an answer it cannot fully prove for some inputs.
- **Deleting a Mechanism for ONE Rejected Job — Enumerate ALL Its Jobs First** — When you remove a function/call because one of its responsibilities is rejected or obsolete, list **every** side effect it has before deleting it.
- **Refactoring Scope: Don't Escalate Lifecycle** — When refactoring an inline operation into a two-phase approach (set intent + execute), match the original operation's lifecycle scope.
- **Carrying Information Across a Mutation: Reorder the Reads Before Adding State** — **DON'T:** Invent a mode flag, a snapshot, or a captured-context object to carry "what things looked like before" through an operation that destroys that information…
- **Signature Change → Grep All Callsites** — When changing a method's return type, parameter list, or visibility, grep ALL callsites BEFORE finalizing the change.
- **A Deleted Middle Parameter Is Invisible to a Structural Type — Grep the Type, Not Just the Call Sites** — A function passed by value into a module that declares its own structural type for it can lose a middle parameter silently: fewer-params and `() => boolean → () => void` assignability keep the type member green while a later argument slides into the wrong slot.
- **New Canonical Path → Ask About Legacy Parallels** — When you add a new canonical input/output mechanism that does the same thing as existing legacy paths (a typed API replacing an untyped one, a structured event replacing…
- **A Parameter With One Correct Value Per Call Site Is Not Flexibility — and a First Attempt That Failed Tends to Get Written Up as a Design** — Two failures that arrive together.
- **Accumulation/Leak Bugs: Fix the Lifecycle, Not a Sweep** — When something grows unbounded (state files, DB rows, temp dirs, handles, cache entries), the artifact has a creation event but no deletion event tied to its owner's…
- **Changing a Value Invalidates State Sized From Its OLD Value — Not Just Live Readers** — When you change a parameter X, the instinct is to update code that **reads** X.
- **A Concern Raised AS A Question Needs the Same Evidence as a Flat Claim** — Sibling of the three claim-shaped entries below ↓, in the disguise a claim wears when it looks like restraint.
- **A BLAST-RADIUS Estimate Used to Defer Work Is a Claim, Not a Measurement** — Sibling of the claimed-negative tradeoff below ↓, in the dimension that decides whether the work happens at all.
- **A Claimed-Negative Tradeoff Needs the Same Evidence as a Claimed-Impossible Fix** — Do not tell the user a change makes things WORSE without deriving the actual result.
- **A Claimed-MISSING Capability Justifies Nothing Until You Read the Layer That Would Own It** — The capability-side twin of the tradeoff claim above ↑.
- **A GATED Mechanism Is Not a Missing One — Fix the Gate, Never Add a Second Path** — Sharper than the entry above ↑, and easier to walk into because you *did* read the owning layer.
- **Documenting a Hole in Your OWN Fix Is Not Closing It** — Close sibling of the gated-mechanism entries above ↑, aimed at the fix you just wrote.
- **A Transform That "Can't Handle Shape X" — Ask Whether the MODEL Lost X, Not Whether X Is Unsafe** — Third sibling to the two entries above ↑.
- **A Durable Knowledge-Write Needs a Higher Evidence Bar Than a Claimed-MISSING Capability** — Recording a "gotcha" into a project instructions file, a persistent memory, or a skill is a claimed-MISSING-capability write (see above ↑) with the blast radius…
- **A Candidate Filter Built as a Negative List Leaks by Category — Invert It to a Positive Criterion** — When a rule/validator/fixer selects candidates by shape ("anything single-X, minus loops, minus switches, minus big bodies…"), every exclusion you add is a patch for one…
- **A Test Behind a Later Gate Does Not Test the Gate You Wrote It For** — Reverting a gate and watching tests go red is the right discipline, but read the result per-test, not in aggregate.
- **A Transformation Test Whose Assertions the UNCHANGED Input Already Satisfies** — Sibling of the gate-chain trap above ↑, but the fixture fails for a different reason: it is satisfied VACUOUSLY.
- **A New Test That Fails May Be UNREACHABLE, Not Wrong — Check the Fixture Before the Code** — Third sibling to the two traps above ↑.
- **A Regression Test Is Not Written Until You Have Seen It RED on the Unfixed Code** — Fourth sibling to the three traps above ↑, and the discipline that would have caught each of them before it shipped.
- **Promoting a Helper's Output From INERT to ACTIONABLE Re-Opens Every Imprecision It Had** — A helper returns a set that one consumer treats as inert bookkeeping — occurrences to ignore, items to skip, candidates to exclude.
- **Before Routing Callers to an Existing Mechanism, RUN That Mechanism on the Failing Input** — The common repair for "feature X doesn't handle case Y" is to route Y into a mechanism that already handles the neighbouring case.
- **A Fix in an UNREACHABLE Layer Is Indistinguishable From a Wrong One — Measure the OUTCOME** — You add the missing branch to the function that decides the answer, and the behaviour does not change.
- **An Oracle That Builds ONE Configuration Cannot See Cross-Configuration Breakage** — Code guarded by build flags (`#if`, `#ifdef`, feature toggles, per-platform files) exists in several versions, and only one of them is compiled by the check you are…
- **Short-Circuiting a Function Measures Everything It Also Skipped** — The natural way to price a suspect function is to stub it out and compare wall clock.
- **A T(2n)/T(n) Ratio Is Not Evidence of Superlinearity — Test ADDITIVITY, and Rule Out a Single Dominant Input First** — Doubling the input and seeing time grow 2.8× reads as proof of a superlinear term, and the hunt for it can burn a whole session.
- **A Premise ENCODED IN EXISTING CODE Is Still a Claim — and a Two-Variable Probe Cannot Decide It** — Sibling of the claimed-MISSING capability above ↑, one level more insidious: the claim is not something you are about to assert, it is something the codebase already…
- **Size/Savings Numbers: Measure the Full Closure Through the Real Pipeline** — A quantitative claim ("switching source X→Y makes the artifact 3× smaller") given to the user becomes a decision input — if it's wrong in either direction, the user…
- **The User's Named Beat IS the Acceptance Criterion** — When the requirement names a concrete observable event — a specific transition, a bounce, a distinct step in a sequence — that beat is not a flourish.
- **A Diagnostic Belongs to the Boundary That Knows the Caller, Not to the Pure Function It Gates On** — Printing/logging to the user is a boundary concern (the CLI layer, or the "found a real thing" discovery layer) — never inside a pure parse/convert function.
- **A Fix That Crosses a Repo Boundary Is a Scope Escalation — Ask First** — When the "architecturally honest" fix for a task lives in a DIFFERENT repository than the one the task was scoped to (a shared library, a team-owned fork, a sibling…
- **A "Belt-and-Braces" Text Scan Over an Exact Model Is a New Bug Class, Not Extra Safety** — When a precise representation (an AST, a typed IR, a parsed config object) already answers a question, a duplicate check that re-derives the answer from raw text "just…
- **An "AUTO / UNSET" Member Is a Default the PRODUCER Should Have Resolved** — A setting has to cross a boundary (FFI, IPC, serialized config, RPC).
- **A New Versioned Step Is Only Warranted if the Previous One Already SHIPPED** — Ordered, once-per-install steps guarded by a stored watermark (schema migrations, data migrations, upgrade hooks, seed versions) are append-only *for released versions*.
- **A Strict Gate Verified Only Against Your Own Mock Has Not Been Verified** — Sibling of the claimed-negative and claimed-missing entries above ↑, on the evidence side of a NEW check.
- **A Fix for Stale State Closes the Half You Can See — Enumerate Every Reader of That State** — A reset/guard fix written against the one reader that showed you the bug leaves a sibling reader (or a throwing call past the `try`'s closing brace) uncovered; enumerate every reader/throw before calling it done, and prefer an existing full-reset/full-wrap primitive over a hand-rolled subset.
- **A Field Nothing Ever Writes May Be an Unfinished Mechanism, Not Dead Code** - Before deleting a member nothing assigns, check for a shadow channel already carrying its value under another name; if one exists, finish the read/write path and delete the shadow instead.
