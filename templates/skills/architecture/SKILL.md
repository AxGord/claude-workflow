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

## Lessons — index (full text: `references/lessons.md`)

Titles only — each names the situation. Read `references/lessons.md` (or just the
section whose title matches) when the situation in its line is the one in front of you.

- **Serialization Doesn't Belong in Runtime State**
- **Trace Full Data Flow Before Designing**
- **Guard Externalization: Clean Up the Callee**
- **Extraction Carries the Code, Not the Guard Around It**
- **Refactoring Toward Shared State: Preserve Semantic Categories**
- **A Shared Predicate Whose "Safe" Default Differs Per Caller Cannot Be Tightened In Place**
- **Deleting a Mechanism for ONE Rejected Job — Enumerate ALL Its Jobs First**
- **Refactoring Scope: Don't Escalate Lifecycle**
- **Carrying Information Across a Mutation: Reorder the Reads Before Adding State**
- **Signature Change → Grep All Callsites**
- **A Deleted Middle Parameter Is Invisible to a Structural Type — Grep the Type, Not Just the Call Sites**
- **New Canonical Path → Ask About Legacy Parallels**
- **A Parameter With One Correct Value Per Call Site Is Not Flexibility — and a First Attempt That Failed Tends to Get Written Up as a Design**
- **Accumulation/Leak Bugs: Fix the Lifecycle, Not a Sweep**
- **Changing a Value Invalidates State Sized From Its OLD Value — Not Just Live Readers**
- **A Concern Raised AS A Question Needs the Same Evidence as a Flat Claim**
- **A BLAST-RADIUS Estimate Used to Defer Work Is a Claim, Not a Measurement**
- **A Claimed-Negative Tradeoff Needs the Same Evidence as a Claimed-Impossible Fix**
- **A Claimed-MISSING Capability Justifies Nothing Until You Read the Layer That Would Own It**
- **A GATED Mechanism Is Not a Missing One — Fix the Gate, Never Add a Second Path**
- **Documenting a Hole in Your OWN Fix Is Not Closing It**
- **A Transform That "Can't Handle Shape X" — Ask Whether the MODEL Lost X, Not Whether X Is Unsafe**
- **A Durable Knowledge-Write Needs a Higher Evidence Bar Than a Claimed-MISSING Capability**
- **A Candidate Filter Built as a Negative List Leaks by Category — Invert It to a Positive Criterion**
- **A Test Behind a Later Gate Does Not Test the Gate You Wrote It For**
- **A Transformation Test Whose Assertions the UNCHANGED Input Already Satisfies**
- **A New Test That Fails May Be UNREACHABLE, Not Wrong — Check the Fixture Before the Code**
- **A Regression Test Is Not Written Until You Have Seen It RED on the Unfixed Code**
- **Promoting a Helper's Output From INERT to ACTIONABLE Re-Opens Every Imprecision It Had**
- **Before Routing Callers to an Existing Mechanism, RUN That Mechanism on the Failing Input**
- **A Fix in an UNREACHABLE Layer Is Indistinguishable From a Wrong One — Measure the OUTCOME**
- **An Oracle That Builds ONE Configuration Cannot See Cross-Configuration Breakage**
- **Short-Circuiting a Function Measures Everything It Also Skipped**
- **A T(2n)/T(n) Ratio Is Not Evidence of Superlinearity — Test ADDITIVITY, and Rule Out a Single Dominant Input First**
- **A Premise ENCODED IN EXISTING CODE Is Still a Claim — and a Two-Variable Probe Cannot Decide It**
- **Size/Savings Numbers: Measure the Full Closure Through the Real Pipeline**
- **The User's Named Beat IS the Acceptance Criterion**
- **A Diagnostic Belongs to the Boundary That Knows the Caller, Not to the Pure Function It Gates On**
- **A Fix That Crosses a Repo Boundary Is a Scope Escalation — Ask First**
- **A "Belt-and-Braces" Text Scan Over an Exact Model Is a New Bug Class, Not Extra Safety**
- **An "AUTO / UNSET" Member Is a Default the PRODUCER Should Have Resolved**
- **A New Versioned Step Is Only Warranted if the Previous One Already SHIPPED**
- **A Strict Gate Verified Only Against Your Own Mock Has Not Been Verified**
- **A Fix for Stale State Closes the Half You Can See — Enumerate Every Reader of That State**
- **A Field Nothing Ever Writes May Be an Unfinished Mechanism, Not Dead Code**
