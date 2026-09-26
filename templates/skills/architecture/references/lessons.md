# architecture — Lessons (full text)

Moved verbatim from SKILL.md; the index there names each lesson and when to open it.

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

## Extraction Carries the Code, Not the Guard Around It

When you move code out of a `try` / lock / guard / enclosing `if` — extracting a loop or a block into its own function — the statements move but the protection the enclosing structure was giving them does not travel with them by itself. The new call site inherits none of the guard unless you put one there.

**DON'T:** treat the statements as the whole unit of extraction and assume the surrounding `try`/lock/guard is either irrelevant or someone else's problem now.
**DO:** before extracting, name what the enclosing structure was protecting against, and re-establish it at the destination.

**Tell:** you are deleting a comment that warns about a hazard because the structure it refers to "isn't here anymore at this spot" — that is the guard leaving, not the hazard leaving. A warning comment attached to code being moved is evidence the hazard is real and already cost someone: it travels WITH the code and gets rewritten for the new site, never deleted as vestigial. If it genuinely no longer applies, you should be able to say why in one sentence.

**The counting shape worth naming:** a completion counter incremented immediately before a call that can throw needs a PER-ITERATION catch that accounts for the failure. One `try` wrapped around the whole loop does not do this — a throw skips the rest of the loop, the counter is left one too high, and the "all done" condition keyed on it never becomes true even after every other in-flight item finishes.

**Example (abstracted):** a submission loop's calls could throw; the loop sat inside a `try { ... } catch`, and that `try` was the only thing making the sequence safe — an "all work submitted" flag was set only after the loop, and a single completion callback fired only once every in-flight item had finished AND that flag was set. Extracting the loop into its own function moved the statements but not the `try`. A throw now escaped before the flag was set, so every in-flight completion became inert and the callback could never fire. The original site carried a multi-line comment explaining exactly this hazard; it was deleted in the same edit, for describing a structure that no longer existed at that spot.

**Why the consequence class matters:** the lost callback was the only thing that dismissed a modal, timeout-less, non-dismissable progress overlay, so "callback never fires" degraded into "application frozen until restarted". A dropped completion callback is only as bad as what was waiting on it — check that before judging severity.

## Refactoring Toward Shared State: Preserve Semantic Categories

When moving filtering logic from a caller into a shared state manager (allocator, registry, cache), verify the manager's API distinguishes all semantic categories the original code handled.

**DON'T:** Replace an explicit filter with a generic state query that collapses distinct categories
**DO:** List every category the original filter distinguished, confirm the API preserves each — or extend the API

**Example (abstracted):** an allocator tracked "taken by owner X"; the original caller excluded only MANUALLY-assigned resources from its forbidden set (auto-assigned ones were reassignable). Replacing that filter with a generic `isAvailable()` collapsed manual and auto into one check and blocked selectable resources.

**Rule:** A generic `isX()` that returns the same answer for semantically different states is a lossy abstraction. Before using it, check: does the original code care *why* the state is set, not just *that* it's set? (Sibling trap when the shared thing is a binary safety check rather than a category filter: see "A Shared Predicate Whose 'Safe' Default Differs Per Caller" below ↓.)

## A Shared Predicate Whose "Safe" Default Differs Per Caller Cannot Be Tightened In Place

A shared boolean query (`isReachable`, `mayAlias`, `canProveX`) can be imprecise in one direction — it returns an answer it cannot fully prove for some inputs. When two callers depend on it, the "unknown → this answer" default is the safe side for one and the unsafe side for the other: one caller treats a spurious `true` as "bail out, do nothing" (harmless); another treats the same spurious `true` as "proven, act on it" — and acting produces a wrong result.

**DON'T:** Tighten a shared predicate to fix one caller when its imprecision was the SAFE direction for another caller. "More precise" is not globally more correct when the safe default is caller-dependent.
**DO:** Enumerate every caller and which direction of imprecision is safe for each BEFORE editing the shared query. If two callers need opposite conservative defaults, add a NEW precise method for the caller that needs the stricter proof and leave the shared one untouched — the shared method's imprecision is load-bearing for the other caller.

**Tell:** you are about to make a shared "does X hold?" query stricter to fix a bug in one consumer, and you have not checked what a stricter answer does to its other consumers — especially any that read the result as "if true, DON'T do the risky thing."

**Example (abstracted):** a membership query resolved names loosely, returning `true` too often. One consumer used `true` as "skip the transformation" (loose-true = safe); another used `true` as "the transformation is proven safe, apply it" (loose-true = a rewrite that breaks compilation). Tightening the shared query would have made the first consumer skip real cases; the fix added a separate precise query for the second and left the shared one alone.

**Principle:** the conservative direction of a predicate is a property of the CALL SITE, not the predicate itself. A shared query can only be tightened when every caller's safe default points the same way. (Sibling case to "Refactoring Toward Shared State" above ↑ — a shared abstraction collapsing distinctions the original per-caller code cared about.)

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

## Carrying Information Across a Mutation: Reorder the Reads Before Adding State

**DON'T:** Invent a mode flag, a snapshot, or a captured-context object to carry "what things looked like before" through an operation that destroys that information (a move, a rewrite, a state switch).
**DO:** First check whether the consumers that need the old state can simply run BEFORE the mutation, reading it live. If the mutation only destroys what they read, reordering removes the need for the new state entirely.

**Tell:** your design grows a structure whose only job is to remember values the code already had a moment earlier — "capture X for each item, then mutate, then use the captured X". Or it grows a parameter/enum whose only purpose is to keep two independently-chosen callbacks consistent with each other.

**Why it happens:** the plan is written around the existing call order, which is treated as fixed, so every consumer placed after the mutation seems to need a copy of the pre-mutation state. The order is usually the cheapest thing in the design to change.

**Check before keeping the extra state:** (1) Does the mutation actually touch what the late consumer reads, or only something next to it? (2) Can the consumer run first without reading anything the mutation is supposed to produce? If (1) is no or (2) is yes, reorder instead.

**Example (abstracted):** a batch operation moved every object and then needed each object's pre-move position to transform related records; the first design captured a per-object snapshot. Transforming the related records BEFORE moving the objects read the positions live and deleted the snapshot. A separately proposed mode enum, added so a repositioning callback and a record-transform choice could not disagree, turned out unnecessary once a single shared object was handed to both.

## Signature Change → Grep All Callsites

When changing a method's return type, parameter list, or visibility, grep ALL callsites BEFORE finalizing the change.

A signature change compiles fine in the modified file but silently breaks callers that ignore the new return type. Example: `clearData(): void` → `clearData(): ITask` — callers that fired-and-forgot still compile; the returned ITask is constructed and discarded; the async work never starts. No compile error, no exception — the cleanup pipeline is a no-op.

**Symptom**: behavior silently regresses in code paths nobody runs during initial smoke test. Caught later by code reviewers, integration tests, or production bugs.

**DON'T:** Change a signature, run the obvious test, declare done.
**DO:** Change a signature, grep `<methodName>\b` across the whole project, audit each callsite. Trust "find references" only if the IDE has full project indexing.

**Adding a member to an interface/abstract type is also a signature change.** Every implementor must gain the member — including hand-written test doubles / fakes / in-memory stubs, not just production classes.

**Tooling gotcha:** test runners that strip types via esbuild/swc (vitest, ts-jest `isolatedModules`, bun test) do NOT typecheck. A test double missing a newly-added interface method compiles fine and fails at RUNTIME as `TypeError: x.method is not a function` — often in unrelated tests that happen to reach the missing call. `tsc --noEmit` catches it; the test run alone does not.

**DO:** after adding an interface member, grep for `implements <Interface>` and for the type used as a field/param type, and update every implementor (prod + test) in the same change; run `tsc` (not just the test suite) before declaring done.

## A Deleted Middle Parameter Is Invisible to a Structural Type — Grep the Type, Not Just the Call Sites

Sharper sibling of "Signature Change → Grep All Callsites" above ↑. When a function is declared once and passed as a VALUE into a module that declares its own structural type for it (a callback field, a `deps` interface member, a stored handler), grepping only the call sites in the defining file misses the second declaration of the signature — the type member — and TypeScript's own assignability rules hide the damage instead of catching it.

**DON'T:** delete a now-dead MIDDLE parameter, verify the defining file's callers, and call it a local change because "nothing exported changes."
**DO:** grep the function's NAME (not just its call sites) for every place its SIGNATURE is independently declared — a type member, an interface field, a stored callback type — and reconcile signature, type member, and call sites in one edit.

**Why the compiler doesn't catch it — and only in this direction:** a function with FEWER parameters is assignable to a type expecting MORE (TS drops the extra arguments by design), and `() => boolean` is assignable to `() => void` (the return value is discarded). So a 4-param type member happily keeps accepting the trimmed 3-param function, and whatever the caller still passes in the now-shifted slot — even a value of an unrelated but assignable type — slides into the next parameter's name instead of erroring. The OPPOSITE half-edit (type member changed, call site not) IS caught: TS errors on excess arguments in a direct call. The compiler protects the direction you'd notice and not the one "just delete the dead parameter" naturally produces — which is exactly why a green `tsc --noEmit` feels like proof and isn't.

**Tell:** you're removing a parameter from a plain function (not a class method, no `implements`), your grep is for call sites only, and somewhere else in the codebase a `type`/`interface` spells out that function's shape independently rather than importing `typeof theFunction`.

**Example (abstracted):** `type Handlers = { onX: (a: A, b: B, live: () => boolean, done: () => void) => void }` in one module; the concrete function trimmed to `(a, b, done)` in another, because its middle parameter looked dead. The type member still matched (fewer params, compatible return), so the caller's third argument — still a liveness predicate — landed in the `done` slot. The real completion callback in the old fourth slot was silently dropped; nothing ever called it.

## New Canonical Path → Ask About Legacy Parallels

When you add a new canonical input/output mechanism that does the same thing as existing legacy paths (a typed API replacing an untyped one, a structured event replacing a string topic, a new control replacing a shortcut), the default urge is to keep the legacy paths "for compatibility" and build a coexistence shim. Don't.

**DON'T:** Silently keep legacy paths AND add a coexistence shim (gates, target-checks, debouncers) so the new and old don't fight.
**DO:** Surface the question explicitly: "should we remove the old paths, or keep them?" — and prefer single-source by default.

**Symptom of violation:** you find yourself adding gating logic (coordinate checks, `if (ev.target === ...)` filters, `inflight` flags) just to make two input paths coexist when one is meant to subsume the other.

**A COMPILE-TIME conditional is the same referee, and it hides better.** `#if <platform>` / `#ifdef` / a build-flag branch reads as "platform-specific code", which sounds like an architectural fact rather than the coexistence shim it is — so it escapes the tell above. It is the shim whenever the new mechanism ALREADY has a branch for the excluded configuration: then the conditional is not choosing between two behaviours, it is choosing between "through the abstraction" and "around the abstraction to the very thing the abstraction would have called".

**Tell:** you added the new path under `#if A` and left the old call under `#else`, and your reason was "don't touch what works on B" — while the new mechanism's own B-branch performs the same underlying call the old code did. Read the library's other branches before writing the conditional: what looks like new platform coverage may already be inside.

**Rule:** A new canonical mechanism is an opportunity to remove the old one, not to add a referee between them. If the user didn't explicitly ask to keep both, ask before keeping both.

**Example (abstracted):** a native dialog was added for one OS and the previous framework call was left under `#else` for the others, out of caution. But the new wrapper's own branch for those OSes issued exactly the same framework call — so the conditional was picking between the wrapper and a bypass of it. Deleting it removed both branches at every call site, shrank one file by half, and moved the platform decision into the single place that already owned it.

## A Parameter With One Correct Value Per Call Site Is Not Flexibility — and a First Attempt That Failed Tends to Get Written Up as a Design

Two failures that arrive together. The first attempt at wiring a helper hits a hard wall — a
framework refuses the construction shape, a builder rewrites the constructor — and the fix is a
detour: pass the VALUE at every call instead of the dependency once. That works, so it ships. The
second failure is what makes it durable: the doc comment then explains the detour as if it were
chosen, in language that sounds like a principle ("handed in rather than reached for, because only
the caller knows"). Nothing in the codebase now records that the shape came from an obstacle, and
the rationalisation reads as design intent to every later reader — including you.

**The test is mechanical:** look at what the argument actually IS at every call site. If they all
pass the same expression, the parameter is not offering a choice — it is offering a way to get it
wrong, and someone will (usually the author, immediately).

**DO:** when a construction shape is refused, enumerate the alternatives before picking one —
"inject via the framework" failing does not leave "pass the value per call" as the only option;
"pass the dependency in the constructor" sits between them and is usually what was wanted. And
write doc comments that record the REASON, not a justification: if the reason is "the framework
would not let me", either say that or fix it.

**Tell:** you are writing a sentence explaining why a parameter exists, and the sentence is about
the caller's knowledge rather than about a value that actually differs between callers.

**Example (abstracted):** a helper needed one rectangle from a service. Injecting the service
through the DI container failed (the container prepends its own constructor argument), so the
rectangle became a parameter of the helper's main method. Both call sites passed the same
expression; the parameter's only exercise of its "freedom" was the author passing the WRONG
rectangle once, which was the bug. Constructor-injecting the service removed the parameter, the
failure mode, and the paragraph defending it.

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

## A Concern Raised AS A Question Needs the Same Evidence as a Flat Claim

Sibling of the three claim-shaped entries below ↓, in the disguise a claim wears when it looks
like restraint. A "concern worth deciding," a risk raised for the user to weigh, and a
recommendation are all claims, and each rests on a premise the user has no reason to doubt.
Framing one as a question feels like deferring the decision — and, with it, the responsibility
for being right — which is exactly what makes it tempting. It defers neither: stating an unchecked
premise still spends a round trip of the user's time, and some of the trust the rest of the report
is riding on.

**Tell:** you are about to end a report with a concern/risk/recommendation phrased as a question
for the user to decide, and you have not named — let alone checked — the one fact it depends on.

**DO:** before writing the item, name the fact it rests on and check it, exactly as you would for
a flat claim. For a dependency or version claim specifically, the fact is the INSTALLED set and
the resolution/link state, never a version string read out of a manifest — a manifest can name a
version nothing actually resolves to. When the check is genuinely too expensive, say what is
unverified inside the item itself, rather than stating the consequence as though it were settled.

**Example (abstracted):** a report ended with a concern that a shared dependency's behavior had
changed without a version bump, so any build resolving that version from a registry instead of a
local development link would silently miss the fix. The reply was one question: do the two
actually differ? They did not — the pinned version existed only as the local link, no registry
build claimed that number, and removing the link would fail to resolve rather than silently
downgrade. One directory listing of installed versions, taken before writing the concern, would
have killed it outright; the premise had been a version string read out of a manifest, and the
fact was the installed set plus the link state.

**Principle:** a concern phrased as a question for the user to weigh is a recommendation wearing a
question mark. It needs the same evidence as the flat claims below ↓ — the question mark is not a
discount.

## A BLAST-RADIUS Estimate Used to Defer Work Is a Claim, Not a Measurement

Sibling of the claimed-negative tradeoff below ↓, in the dimension that decides whether the work
happens at all. "This touches N references across M files, so it's a separate task" reads like
data, but the N usually comes from counting mentions of an EXISTING name — not from reading the
code that would actually change. When the real mechanism turns out to take a different seam, the
honest number is a fraction of the quoted one, and the estimate has cost the user a deferral they
never needed.

**Tell:** your scope number came from a reference count (`grep`/`mentions` on a symbol), and you
have not read the consumer that would receive the change to see whether it even goes through that
symbol. Also: you are recommending "its own task" and the number is the whole argument.

**DO:** find how the CLOSEST analogous feature was added to the same consumer. If a sibling
concept already exists there, it shows the actual seam — and the seam is usually narrower than the
shared vocabulary you were about to widen. Only then quote a number.

**Companion measurement, when the change alters a shared analysis:** run the whole rule/check set
over a large real tree BEFORE and AFTER, at REPORT level only, and diff. That is a cheap upper
bound on the blast radius and it beats any amount of reasoning about which consumers might care —
including yours. A disappearing finding is the suspicious direction; an appearing one is usually
the fix.

**Example (abstracted):** a scope-model fix was deferred as "102 references across 14 files"
because the estimate assumed a shared vocabulary had to be extended. The resolver already learned
an analogous branch scope through a SEPARATE condition of its own — the real change was two lines
there plus one optional field, and a full before/after report diff over ~800 files moved exactly
zero of 8736 findings. In the same estimate a second claim ("these bindings will migrate between
frames") was also wrong: the bindings were never declarations in that model at all.

## A Claimed-Negative Tradeoff Needs the Same Evidence as a Claimed-Impossible Fix

Do not tell the user a change makes things WORSE without deriving the actual result. A negative framing extrapolated from a stale note, a prior decision, or an intuitive "it'll scatter / fragment / break" mental model is not evidence.

**DON'T:** Warn "this will be markedly worse" / "destroys the existing structure" from memory or intuition, then ask the user whether to proceed.
**DO:** Run the concrete analysis that confirms or refutes the claim FIRST — then present the measured result, and only flag a downside that survives the measurement.

**Tell:** You're about to present a tradeoff as a downside, and your reason is a remembered decision ("we left this alone before") or a shape you pictured ("members will scatter"), not something you computed on the actual artifact.

**Example (abstracted):** asked to apply an automated reorder to a large file, the agent warned it would be "markedly worse", citing a stale note — the user pushed back; a one-command permutation check proved the change was content-neutral and mild. The unmeasured negative cost a round-trip and trust.

**Principle:** "I think this is worse" is a hypothesis, not a finding. The cost of measuring is usually one command; the cost of a wrong negative is a wasted round-trip and a user who now distrusts your tradeoff calls. (Capability-side twin below ↓: a claimed-MISSING capability needs the same evidence.)

## A Claimed-MISSING Capability Justifies Nothing Until You Read the Layer That Would Own It

The capability-side twin of the tradeoff claim above ↑. A transformation produces output its owning layer would never produce (wrong layout, wrong shape, wrong casing — whatever that layer decides). The instinct is to fix it inline. That requires believing the owning layer can't do it — a belief that gets ASSERTED, not checked, because it's invisible: the workaround works, its tests pass, nothing ever contradicts it. Even when it "works" the fix is wrong: it only repairs this one producer's output, every other path producing the same shape stays broken, and the layer's own gap stays hidden.

**DON'T:** Correct a layer-owned property inside your transformation because you believe that layer cannot do it.
**DO:** Locate the module that owns the property and read it. Assume the capability EXISTS until its source says otherwise. If it genuinely is missing, the change belongs there — and then the transformation needs nothing.

**Tell:** you are about to write "the X layer can only do A, never B" as justification for code — and you have not opened X. Also: your fix sits in a transformer, but the thing being fixed is a property some other component decides everywhere else.

**Example (abstracted):** a transformation emitted a shape that violated an owning layer's own symmetry rule; the author asserted that layer "can only remove, never add" and reimplemented the add side inline. The layer already had an add direction — the real defect was a one-sided gate there. Fixed at the source, the whole tree self-healed, including sites nothing could previously repair.

**Principle:** a missing-capability claim is load-bearing for a design decision; it needs the same evidence as a claimed-impossible fix (see above ↑). Locating the owning module is usually one search, reading it usually one file.

## A GATED Mechanism Is Not a Missing One — Fix the Gate, Never Add a Second Path

Sharper than the entry above ↑, and easier to walk into because you *did* read the owning layer. The mechanism is there, you found it, it even runs — but only under a condition that doesn't hold in your case. The trap is reading "switched off here" as "doesn't cover this", and building a parallel implementation beside it. You now own two things that answer the same question, they will drift, and every future consumer has to know which one to ask.

**Tell:** you are about to add a lookup/probe/resolver for something the codebase already resolves, and your justification is that the existing one "isn't active" / "isn't populated" / "doesn't reach" your case — a statement about a CONDITION, not about a capability. Also: your fix would be consumed by exactly one caller, while the existing mechanism has many.

**DO:** find what turns the mechanism on and ask why it is off. If the condition is wrong, that one predicate is the whole fix, and every existing consumer is fixed with you for free. If the condition is right but costly, the problem is the cost — attack that (share it, cache it, defer it), still through the one mechanism.

**Example (abstracted):** a resolver could not see the standard library, so a check fell back to a hand-maintained list of ~15 type names and refused to act on anything else. The proposal was a small side-probe that read one stdlib file on demand. But the resolver already pulled the stdlib in — behind a condition that only held when the project happened to declare an unrelated dependency. Deleting that clause from the condition fixed every consumer at once; the remaining problem was purely the cost of the now-always-on work, solved by sharing it across runs.

**Principle:** "not reaching my case" is a property of the switch, not of the machine. Two mechanisms answering one question is a defect you are choosing to create.

### The Gate Can Be a TIME WINDOW or a Too-Narrow TYPE

Two disguises the entry above ↑ does not cover, and both read convincingly as "the field
does not carry what I need":

- **The value is written only during part of its own validity.** A field holds the right
  answer while some activity runs, and is reset to a neutral value outside it. Ask when
  the fact it records actually becomes true and false — usually a strictly WIDER window
  (assignment, ownership, registration) than the one the write is scoped to. Move the
  write to the real boundaries; the narrow window was the gate.
- **The type cannot express "absent", so the neutral value collides with a real one.**
  An unsigned/non-nullable field resets to `0`, and `0` is also a legitimate answer. That
  is one missing BIT, not a missing mechanism. Add the bit (a companion boolean) or widen
  the type — do not add a second field that re-states the value the first one already holds.

**Tell:** your new field would be assignment-compatible with an existing one and equal to it
whenever both are meaningful. If you cannot name an input where the two legitimately DISAGREE,
you are duplicating, not adding.

**Example (abstracted):** a container stamped its index onto the item it held at start and
cleared it at stop, and the field was unsigned so "held by nobody" and "held by container 0"
were both `0`. Rather than one more field carrying the index again, the fix was to move the
stamp to the bind/unbind boundary and add a single boolean for the presence bit — after which
the two reporting call sites that had been guessing from "is it running" read the real answer.

## Documenting a Hole in Your OWN Fix Is Not Closing It

Close sibling of the gated-mechanism entries above ↑, aimed at the fix you just wrote. Mid-change
you notice a case your new guard cannot see, and the response that feels responsible is a paragraph:
"what this does NOT answer is …", "the limit is worth knowing". The paragraph reads as diligence, so
nobody argues with it — and the hole ships, behaving exactly like the bug you were fixing.

**Tell:** you are writing a caveat about your own change, in the same breath that introduces it, and
the reason you gave for not closing it is a cost you never measured (an eager scan, an extra probe)
or a home you never went looking for. Sharper still: the caveat describes the SAME damage the fix
exists to prevent, only reached by a different route.

**DO:** ask which layer actually learns the missing fact. It is rarely the one you are editing —
usually something downstream already computes it lazily (the loader that expands the paths, the
resolver that binds the names, the reader that opens the files) and can say so at no extra cost. One
line where the truth already exists beats a paragraph where it cannot. If the honest answer really
is "nobody learns it", say THAT, and say what it would take.

**Example (abstracted):** a diagnostic fired when a configuration key was absent. A key that was
PRESENT but pointed at a directory that did not exist produced byte-identical damage and stayed
silent; that was written up as a documented limit ("this answers a configuration question, not a
filesystem one"). A reviewer reproduced the damage in one command. The real fix was a few lines in
the loader that already expanded each declared path on demand — it simply named the one that matched
nothing, and only when something asked for it.

**Principle:** a caveat is a decision to leave a defect in, wearing the clothes of thoroughness.
Price the close before you write the paragraph.

## A Transform That "Can't Handle Shape X" — Ask Whether the MODEL Lost X, Not Whether X Is Unsafe

Third sibling to the two entries above ↑. A transformation refuses a whole class of input and the codebase explains why in terms of risk ("we cannot safely split this", "the projection flattens these"). Read that as a statement about the transform and you accept the limit forever. But often the transform is refusing because its INPUT MODEL no longer carries the distinction — the tree, the index, the projection dropped it — and the refusal is a stand-in for information that was thrown away one layer up.

**Tell:** the bail's justification says the representation "flattens" / "cannot distinguish" / "does not carry" something, rather than naming an operation that would be wrong. Also: the refused class is common in real code, and the guard is a blunt whole-container veto rather than a targeted one.

**DO:** dump the actual representation for a refused input and check whether the distinction is present. If it is absent, the fix is to recover it — often cheaply and locally, from the same source text the model was built from — after which the transform needs no special case at all. If recovery has limits, refuse only the shapes you truly cannot model, each with its own test, instead of the whole class.

**Example (abstracted):** a reordering fixer bailed on every container holding a two-branch conditional, "because the projection cannot split a then-body from its else-body". Dumping the tree showed the parser emitted ONE node with every branch's members as flat siblings — no branch boundary existed to split. Recovering the boundaries from the construct's own directive lines (a read the same file already did for the condition text) made the branch part of each member's sort key; the transform then worked with no special case, and only four genuinely unmodellable shapes stayed refused.

**Principle:** "the transform can't do X" and "our model of the input has no X" produce the same bail and demand opposite fixes. Check which one you have before designing around it.

## A Durable Knowledge-Write Needs a Higher Evidence Bar Than a Claimed-MISSING Capability

Recording a "gotcha" into a project instructions file, a persistent memory, or a skill is a claimed-MISSING-capability write (see above ↑) with the blast radius multiplied: a wrong code decision harms one task, but a wrong enshrined gotcha misleads every future reader until someone disproves it.

**DON'T:** Write "X is broken / X can't do Y / the tool is missing Z" into a durable store because of a symptom you observed (stale artifact, empty result, missing output).
**DO:** Verify the claim against the layer or convention that would own X — a sibling script, an existing helper, the established pattern — exactly as you would before writing the code. Then record it. If the "deficiency" turns out to be your own bypass of an existing mechanism, the durable note is about using that mechanism, not about a defect — prefer recording the convention over recording a defect.

**Tell:** you're about to add a "gotcha"/"always"/"never" entry, especially during a reflection/wrap-up pass, and its basis is a symptom (stale artifact, empty result, missing output) rather than having read the thing you're indicting. The urge to capture a lesson before the session ends outruns the verification.

**Example (abstracted):** a stale binary was blamed on "the shared build script doesn't rebuild it," and that conclusion was written into project docs, a persistent memory, and a skill — before checking that a dedicated run script already rebuilt it correctly. The real cause was invoking the binary directly, bypassing that script. Three durable stores now had to be corrected.

**Naming a SEAM is the same kind of write, and a matching filename is not evidence.** When you
record "the mechanism for X already exists at Y" — in a doc comment, a memory, a handoff note —
you are telling the next reader where to start. Picking Y because its NAME matches the concept
skips the only step that makes the claim worth anything: finding who already solves the problem
and reading what they call. Search for the existing CONSUMER, not for a plausible provider.

**Example (abstracted):** a gap was documented as "the capable collector lives in the
higher-level module `<ConceptName>`, so reusing it means moving that module down a layer" —
sized as a refactor, filed as a separate task, and shipped in a commit. The real primitive sat
in the SAME layer, was public, and was already used by the very index the code consults; one
search for how that index gathers its data would have found it. The fix was one call, and the
recorded "layer boundary" was pure invention from a filename.

**Principle:** the write target changes the evidence bar. A wrong belief used once is a bug; the same wrong belief enshrined is a standing liability.

**The READ side, and it is the expensive one: a durable note that names WORK TO DO.** A belief
that is merely wrong costs one decision. A stale "next: do X" costs a whole task — you open it,
plan it, and announce it, and every summary written along the way copies the claim forward, so the
error compounds instead of decaying. The tell is that these notes are written by the person who is
about to be gone: a handoff, a resume prompt, an end-of-session summary. Nothing updates them when
the work later lands somewhere else, and the completion record almost always lives in a DIFFERENT
artifact — the tracker, the queue, the commit log — which is the one that gets updated.

**DO:** before starting a task quoted from a summary, check the authoritative completion record for
that item, and then check the CODE for the thing it says is missing. Both are one command. If the
item is done, fix the summary in the same breath — otherwise the next reader pays the same cost.

**Tell:** you are about to begin work whose entire justification is a sentence in a handoff
document, and you have not opened the record that would say it shipped.

**Example (abstracted):** a defect was carried as "first by priority" through a handoff file, a
memory index and two status reports. Opening the tracker to start it showed it had shipped six
slices earlier, and one query confirmed the replacement module in the code. The task had been
announced to the user twice before anyone read the record that closed it. (Same failure class as the claimed-MISSING capability entry above ↑, applied to knowledge stores instead of code.)

**The bar applies to REPORTING a defect, not only to storing one.** Telling the user "tool X is broken" hands them a false to-do and spends their attention; it is a durable write into their head. Before reporting, re-run the symptom under the conditions the tool is actually designed for — especially SCOPE. A whole-project analysis invoked on a single file, a cross-file check run on one directory, a cache measured on one process: each will look broken while behaving exactly as documented.

**Example (abstracted):** a base class linted ALONE reported twelve of its members as unused, because the subclass that uses them was outside the requested scope; the rule's documented contract is report-scope ∪ resolution-scope. Linting the tree gave one warning, and that one was a real dead member. The "rule bug" had been stated to the user before the wider run.

**Correcting ONE sentence in an existing doc puts you on the hook for the sentences that DEPENDED
on it.** A doc paragraph is an argument: a premise, then a "so …" conclusion built on it. Fixing
the premise — the thing you actually verified — silently invalidates the conclusion, and the
conclusion is now a dangling non-sequitur that reads with all its old authority. The trap is what
you do next: having just verified one fact, you feel qualified to re-narrate the dependent
sentence too, and you write a second claim from inference instead of measurement. That is a fresh
durable write at the LOWEST evidence bar in the whole edit, disguised as tidying up.

**DO:** after correcting a premise, either measure the dependent claim as well and state the
measured result, or restore the original wording untouched and leave the seam alone. Never
paraphrase a conclusion you have not checked.

**Tell:** you are editing a doc you did not write, your verified fix lands in a bullet, and the
sentence after it starts with "So …".

**Example (abstracted):** one bullet said a control reported its BORDER width; the code and a live
measurement both showed it reports its BOX. Fixing the bullet stranded the next sentence, which was
rewritten on the spot with an invented pair of numbers "from a live measurement" — two values that
had in fact been read off two DIFFERENT containers. Measuring the real pair showed the two edges
land on the same column, i.e. the opposite of what had just been written into the doc.

## A Candidate Filter Built as a Negative List Leaks by Category — Invert It to a Positive Criterion

When a rule/validator/fixer selects candidates by shape ("anything single-X, minus loops, minus switches, minus big bodies…"), every exclusion you add is a patch for one discovered leak, and the NEXT heavy shape (allocation, closure, reification, `super`-call) sails through until someone trips over it. The negative list can never be complete because it enumerates what the action must NOT touch instead of asking what the action BUYS.

**DON'T:** Keep appending "except shape N+1" gates to a candidate predicate after the second exception lands.
**DO:** Invert to a whitelist derived from the action's benefit model: enumerate the classes of input where the action provably pays off, accept ONLY those (bounded by a budget if a class is open-ended). Everything else fails by construction — including shapes nobody has thought of yet.

**Tell:** you are adding the second or third "and not …" clause to the same gate, and each clause traces back to a separate user-reported miss of the same flavor.

**Example (abstracted):** an auto-fixer marking methods for an optimization accepted "any single-expression body" and grew three negative gates (loops, dispatch tables, oversized bodies) across three user-found holes; a fourth class (allocating builders) was still leaking. Rewriting the gate as "accept only the three body classes the optimization actually helps" deleted all three negative gates as code AND closed the unfound holes — a review then showed the whitelist also had to exclude constructs the OPTIMIZATION itself rejects (a `super` call the compiler refuses to transform), so the positive criterion still needs an adversarial pass over its accepted classes.

**Principle:** a filter's completeness comes from the side you enumerate. Enumerate the benefit, not the harm — the benefit side is finite.

When a guard's position in a sequence is chosen on purpose (this check must run before that early-return; this hook must fire after that reset), a comment explaining why is not protection. Moving it leaves the suite green while changing real output, so the next person deletes or relocates it with confidence.

**Tell:** you wrote a comment containing "deliberately", "must run before/after", or "on purpose" about where something sits, and no test fails if you move it.

**DO:** construct the one input where the two orderings differ, and assert on it.

## A Test Behind a Later Gate Does Not Test the Gate You Wrote It For

Reverting a gate and watching tests go red is the right discipline, but read the result per-test, not in aggregate. When a check is a CHAIN of gates, a fixture aimed at gate 1 may also trip gate 4, so it stays green with gate 1 removed — it proved nothing, and its doc comment now asserts a mechanism it never exercised. "I reverted the gate and tests failed" is only evidence for the tests that actually flipped.

**Tell:** you reverted one gate, N tests failed, and N is smaller than the number of tests you wrote for it — and you reported the check as passed anyway.

**DO:** name the tests that flipped and compare that list against the ones you intended. For each survivor, either change the fixture so only the target gate can reject it, or drop the claim from its doc comment.

**Example (abstracted):** a rule bailed on "does a subtype write this member". Two fixtures put the write in the subtype — but the write index resolved that shape back to the declaring type, so the rule's own terminal write-gate rejected them first. Both passed with the subtype gate ripped out. One character of fixture change (a qualified receiver instead of a bare name) made them discriminate.

**Companion, when the check guards a rewrite:** unit fixtures encode the shapes you already thought of. Run the fix over a large REAL codebase and compile the result — that is what surfaces the shape you didn't. A gate that passed a green suite produced compiler-rejected output on the first real tree it met, because the veto it replaced had been covering a second, unnoticed job.

## A Transformation Test Whose Assertions the UNCHANGED Input Already Satisfies

Sibling of the gate-chain trap above ↑, but the fixture fails for a different reason: it is
satisfied VACUOUSLY. When you assert on a transformation's output as "X is present, Y is absent"
and the untransformed input already has X and lacks Y, the test passes when the transformation
does nothing at all. Reverting the code proves nothing, because there was nothing to break.

**Tell:** your assertions describe what the transformation must NOT do (a span it must leave
alone, a form it must not produce), and the input already looks like that. Also: reverting the
feature flips your other fixtures but not this one.

**DO:** make every assertion mention something only the transformation can produce. One
assertion spanning both halves is stronger than two one-sided ones — assert the changed thing
and the preserved thing TOGETHER, in one string, so neither can be satisfied alone.

**Example (abstracted):** a rename had to rewrite the owner's own reads and leave a same-named
member access on a foreign receiver alone. The fixture asserted `foreign.member` present and
`foreign._member` absent — both true of the input, so it passed with the whole feature disabled.
Asserting the single expression `own_read + foreign.member` — the renamed read next to the
untouched access — made it discriminate.

## A New Test That Fails May Be UNREACHABLE, Not Wrong — Check the Fixture Before the Code

Third sibling to the two traps above ↑. You add a fixture for a capability you just built, it goes
red, and the reflex is to debug the new code. But a fixture reaches your code only after every
pre-existing gate on the path lets it through, and a gate can reject it for reasons that have
nothing to do with the change — a name that collides with something in the ambient scope, or an
unrelated precondition the fixture's shape happens to violate. Debugging the new code then hunts a
bug that isn't there.

**Tell:** the new test fails while an equivalent probe against the real system SUCCEEDS. That
contradiction is the signal — trust the real system and suspect the fixture.

**DO:** instrument the path once and find out how far the fixture gets. If it never reaches your
code, the fixture is the defect: rename the colliding identifier, or route the test through the
entry point where that shape is actually reachable.

**Example (abstracted):** two fixtures for a new same-type-receiver rewrite went red. One used a
single-letter type name that the ambient library scope also declares, so the resolver bailed on the
ambiguity before reaching anything new. The other described a shape a much older precondition makes
unreachable through that entry point — it exists only via a different, wider API. Neither said
anything about the change; a live probe on the real tree had already confirmed it worked.

**Principle:** a fixture is code under the same gates as production input. "My new test fails" is
not yet evidence about your new code.

## A Regression Test Is Not Written Until You Have Seen It RED on the Unfixed Code

Fourth sibling to the three traps above ↑, and the discipline that would have caught each of them
before it shipped. A green regression test is equally consistent with two explanations: the fix
works, or the test never reaches the defect. Only a run against the REVERTED fix tells the two
apart. The mandatory order is: write the test, revert the fix, watch it go RED, restore the fix,
watch it go GREEN. Back up the file before reverting and diff it after restoring, so the restore is
provably exact rather than assumed identical.

**Tell:** you wrote the test after the fix was already in place, ran it once, saw green, and called
the regression covered — no run exists where the code was broken and the test was watched to fail.

**DO:** run the four-step sequence above every time, and keep the restore's diff as proof it is
exact.

**Example (abstracted):** a test asserted that a function releases a lock when an operation inside
it throws. It passed. It ALSO passed with the fix reverted — the trigger chosen to make that
operation throw instead made a different, already-correct statement throw. "Something threw" was
true and meaningless; the test never touched the code it was written to check.

**Before writing the test, verify the trigger on its own:** a one-off command at the level the code
will actually hit it, confirming the underlying call really fails for the input chosen. A trigger
assumed to fail, never checked in isolation, is exactly how a test ends up exercising the
already-correct path.

**Add a guard that names the path, not just the failure:** "a failure happened" is satisfied by any
failure anywhere in the function. When the intended failure site runs strictly before some other
observable effect, assert that the OTHER effect did NOT happen — that pins the failure to the site
meant, not some other one. Without a guard like this, a wrong trigger restores to green exactly as
easily as a right one, and nothing distinguishes them.

**Principle:** a test reproducible only by forcing a thread interleaving is not a regression test.
It is non-deterministic, it passes on the broken code most of the time it runs, and forcing the
interleaving means instrumenting production code to win a race the fix has nothing to do with.
Delete it rather than keep it for appearances — say plainly that the fix rests on reading the code,
not on a test that pretends to cover it.

## Promoting a Helper's Output From INERT to ACTIONABLE Re-Opens Every Imprecision It Had

A helper returns a set that one consumer treats as inert bookkeeping — occurrences to ignore, items
to skip, candidates to exclude. Being over-broad there is harmless or even safe, so nobody ever
tightened it. Then a new consumer needs the same set as a list of THINGS TO DO. The moment it
becomes actions, every element the helper included on weak evidence turns into a wrong action, and
the existing tests say nothing because they only ever exercised the inert reading.

**DON'T:** reuse the set as-is because "it's already computed and it's the same set".
**DO:** ask what evidence each element carries. If the helper builds it from two different
attributions — one proven, one approximate — split the return so the actionable consumer takes only
the proven half, and let the inert consumer keep both. Keep the split visible in the type, not in a
comment.

**Tell:** you are about to feed an "ignore these" / "skip these" collection into something that
mutates, and the helper's own doc explains why being generous there is safe.

**Example (abstracted):** an attribution helper returned occurrences belonging to a given owner.
Half were attributed by a precise per-site type resolution; half merely by "appears somewhere inside
that owner's body" — fine while the whole set only suppressed false alarms. Consumed as edits, the
loose half rewrote references belonging to unrelated same-named bindings. Splitting the return into
the precise and the loose half fixed it; a suite that had never seen the set used as actions caught
the regression only because one older fixture happened to contain a same-named parameter.

**The same trap fires when you WIDEN a scan rather than reuse a set.** Fixing a discovery gap — the
lookup could not see input class X, now it can — silently promotes every downstream action to
operate on X. Where the blindness produced a harmless refusal ("no such member"), sight produces an
edit, and that edit may be invalid for exactly the reason X was special. Treat "can it FIND it" and
"may it ACT on it" as two questions, and answer the second before shipping the first.

**Tell:** your change is one line in a resolver/collector, and its effect is that a previously
refusing command now succeeds. Go look at the artifact it writes — not just its exit code.

**Example (abstracted):** a scan was taught to see declarations nested inside conditional regions,
which fixed the ops that only READ them. One op MOVED what it found: it cut the declaration out of
its region and pasted it into a new location unguarded, leaving a dangling modifier keyword behind
and dropping the visibility keyword from the copy. Nothing failed — it printed success and wrote two
files. The correct outcome there was a REFUSAL naming the region, which is what the widened scan
finally made expressible.

## Before Routing Callers to an Existing Mechanism, RUN That Mechanism on the Failing Input

The common repair for "feature X doesn't handle case Y" is to route Y into a mechanism that
already handles the neighbouring case. The plan then describes one dispatch line — and hides
the assumption that the mechanism actually WORKS on Y, which nobody has tested, because until
now nothing sent Y there. You can settle it before writing a single line: invoke the existing
mechanism directly on the failing input (its own entry point, its own flags, a scope of one),
and diff against the outcome you want.

**Tell:** your change is "call the thing that already does this", and your evidence that it does
is that it handles a SIMILAR input through a different entry point.

**DO:** drive the target mechanism by hand over the full failing set first. Every case it still
gets wrong is a defect INSIDE it, which the dispatch would have shipped as your bug.

**Example (abstracted):** a per-file operation mishandled one declaration class; the cross-file
variant already modelled it, so the fix was one dispatch branch. Running the cross-file variant
with a one-file scope BEFORE editing turned 10 broken cases into 6 correct + 3 explicit refusals
— and left 2 still broken, both defects of the mechanism itself (an input shape its candidate
filter never collected, and a relationship it only modelled in one direction). Both would have
shipped inside "the fix".

## A Fix in an UNREACHABLE Layer Is Indistinguishable From a Wrong One — Measure the OUTCOME

You add the missing branch to the function that decides the answer, and the behaviour does not
change. The reflex is to suspect your logic. Often the logic is right and never runs: something
upstream — a candidate collector, a filter, an early bail — drops the input before it ever
reaches the function you edited. The edit reads as correct in review, passes any test written
against the function directly, and does nothing.

**Tell:** the end-to-end outcome is byte-identical before and after a change you believe is
substantive. Treat "no change" as evidence about REACHABILITY first, not about correctness.

**DO:** keep an end-to-end oracle (real input → real observable result) and re-run it after each
edit; when it does not move, trace the input backwards from your function to its producer and
find who filtered it. Then mutate the mechanism (disable it and confirm the oracle flips) —
a fix nothing can flip is dead code, however correct it looks.

**Example (abstracted):** a resolver was taught a new receiver form, and the end-to-end result
stayed broken. The receiver never arrived: a collector one level up admitted only one node kind.
Two edits were needed — widen the collector, keep the resolver arm — and each independently
flips exactly one oracle case, which is what proved neither was ornamental.

## An Oracle That Builds ONE Configuration Cannot See Cross-Configuration Breakage

Code guarded by build flags (`#if`, `#ifdef`, feature toggles, per-platform files) exists in
several versions, and only one of them is compiled by the check you are running. A
transformation that edits one branch and not its siblings leaves that build green — the damage
is in a version your oracle never builds. The result is worse than no signal: the case is
reported as PASSING, and the report is what you act on.

**Tell:** the artifact contains conditional regions and your verification compiles/runs one
configuration. Also: some cases in a per-item sweep come back clean while their obvious
neighbours fail, and the clean ones happen to be the branches your configuration excludes.

**DO:** build every configuration the edited region spans and require ALL of them to match
their own baseline. Design the fixture so each configuration produces a distinct observable
result, so a swap between them cannot pass. If the matrix is large, at minimum build the
configuration that the edited branch belongs to plus the one the cursor did NOT touch.

**Example (abstracted):** a rename over a type whose member was declared once per branch was
verified by compiling and running the default configuration. Two of five cases reported
IDENTICAL. Adding a second arm with the other flag defined showed both were broken — the edit
had renamed one branch's declaration and every access, leaving the other branch's declaration
on the old name. The same run also revealed the reverse direction: a case that "passed"
because it had edited only a dead branch, changing nothing observable while silently making
the two branches disagree.

## Short-Circuiting a Function Measures Everything It Also Skipped

The natural way to price a suspect function is to stub it out and compare wall clock. The number that falls out is the cost of the function PLUS the cost of every downstream path the stub no longer reaches — and if the stub changes which branch the caller takes, that can be work of a completely different order.

**Tell:** you attributed a large delta to a specific function from a stub-and-time A/B, and you never profiled, never repeated each arm, and never checked what else the stubbed return value gates.

**DO:** repeat each arm (a single pair can be pure environment noise); profile before attributing — an inclusive-time profile names the real consumer in one shot; and change ONE thing — prefer adding the optimization and timing before/after over removing the code and timing with/without.

**Example (abstracted):** a lookup was stubbed to a constant and the run got 2.4x faster, so 37 of 62 seconds were reported as "the lookup". Adding the actual memo later changed nothing, and a CPU profile put the lookup at 0.06s of 75s. The stub had flipped a gate so that an expensive lazily-built cache was never demanded; the whole delta was that cache. The reported figure went to the user before any of this was checked.

**Principle:** an A/B tells you the difference between two programs, not the cost of the thing you edited. Those coincide only when the edit changes nothing else — which is exactly what a short-circuit does not guarantee.

**Repeating each arm doesn't catch a confound BETWEEN arms.** A before/after pair timed minutes apart on a machine other work shares can drift by a large fraction on the identical binary — enough to swamp or fabricate the very effect being reported. Repetition within one arm says nothing about this, because the noise source sits between the arms, not inside either one.

**DO:** INTERLEAVE the two arms in a single loop (before, after, before, after, …) so both see the same ambient load, and report the per-arm MEDIAN. This needs both builds to exist at once — get the baseline arm by checking out the pre-change revision into a throwaway worktree and building it there, then alternate invocations of the two arms over the same input. Quote the interleaved numbers, not numbers from separately-timed runs.

**Example (abstracted):** a before/after pair for the same binary, timed twenty minutes apart on a loaded machine, drifted by roughly 45% — large enough to swamp the reported effect. Interleaving the two arms and taking the median removed the drift.

## A T(2n)/T(n) Ratio Is Not Evidence of Superlinearity — Test ADDITIVITY, and Rule Out a Single Dominant Input First

Doubling the input and seeing time grow 2.8× reads as proof of a superlinear term, and the hunt
for it can burn a whole session. But that ratio moves for three unrelated reasons, and only one
of them is the algorithm: the larger run also has a DIFFERENT COMPOSITION (the added half may
simply be more expensive per unit), the cost may be dominated by a handful of pathological
inputs that landed on one side of the split, and the measurement harness itself may be doing
work you did not mean to measure.

**DO, in this order, before profiling for an algorithmic term:**

1. **Additivity.** Split the large input into halves A and B and compare `T(A) + T(B)` against
   `T(A ∪ B)`. Superlinear work makes the union COSTLIER than the sum; a union that comes out
   cheaper (shared setup amortised) proves the size axis is fine no matter what the ratio said.
   This is one extra run and it settles the question the ratio only gestures at.
2. **Heavy tail.** Chunk one half and time each chunk. A cost concentrated in one chunk — then
   one item inside it — means you are looking at input pathology, not complexity: the ratio
   changed because the expensive item moved across the split.
3. **Harness.** Re-run with the output/verbosity/format flags the real consumer uses. A
   reporting or annotation path can dwarf the work under study, and then the profile you are
   reading is mostly the harness.

**Tell:** you are about to name a suspect function from a profile of the LARGER run alone, and
you have not compared per-function growth against the growth of the WHOLE. When every function
grows by roughly the same factor as the total, nothing is superlinear — the run just did more
work. A genuine quadratic term shows up as one function growing ~4× while its neighbours grow 2×.

**Example (abstracted):** a "62s → 176s on 2× the files" note sent an investigation looking for
an unidentified superlinear term. Additivity showed the union 14% CHEAPER than the sum of its
halves; chunking found one 413KB file costing 58s of a 156s run; and switching the output format
— the only variable — showed 86% of that file's time was the report's per-finding address
annotation (a full tree walk per finding), not the analysis. The size axis had never been the
problem, and the original ratio had varied composition and size together.

## A Premise ENCODED IN EXISTING CODE Is Still a Claim — and a Two-Variable Probe Cannot Decide It

Sibling of the claimed-MISSING capability above ↑, one level more insidious: the claim is not
something you are about to assert, it is something the codebase already asserts — in a check's
trigger, a guard's condition, a validator's rule, a comment explaining why some shape is
dangerous. Because it ships and its tests pass, it reads as established fact, and the natural
move when its output looks wrong is to change everything AROUND it. That can invert the whole
job: the surrounding code may be correct and the enshrined premise backwards, in which case
every fix you build on top makes the artifact worse while looking like progress.

**Tell:** you are about to teach a producer to satisfy a consumer's rule, and you have not run
the scenario the rule claims to protect against. Also: the rule's justification is a runtime
behavior ("this shape crashes / silently no-matches / leaks") that nobody in the conversation
has actually executed.

**DO:** execute the claimed-dangerous shape AND its supposedly-safe neighbour, on the targets
that matter, before touching either side. If the premise is inverted, the fix is the rule, and
the producer needs nothing.

**Then decide it with a ONE-VARIABLE matrix.** The cheap way to get this wrong is a pair of
probes that differ in two ways at once — a "works here, fails there" split whose two members
vary both the thing you suspect and something incidental. The conclusion will name whichever
difference you noticed first, and it will be wrong in a way that survives review, because the
two observations are both real. Enumerate the axes, hold all but one fixed, and only then name
the discriminator. This applies to the probe you run to CONFIRM a fix as much as the one that
found the bug.

**Example (abstracted):** a rule flagged construct A as a latent crash and explicitly exempted
construct B. Running both showed the reverse — A was safe on every target, B faulted hard — so
the fix was the rule's trigger, not the code generating A. Along the way a second claim ("this
narrowing works outside a loop, fails inside") came from two probes that differed in loop
nesting AND in expected type; a five-case matrix varying one axis at a time showed the loop was
irrelevant and the expected type was everything. That wrong split had already been written into
a shared knowledge store before the matrix ran.

### The Premise Can Also Be a Doc Comment That Is TRUE But Partial

The sharpest version does not require anyone to be wrong. A wrapper's documentation names what it
eventually delegates to ("this routes through the raw terminator / the plain writer / the unbuffered
call") and is simply silent about what it DISPATCHES first. Quoting that endpoint then feels like
tracing the call, and the obvious "hardening" — bypass the wrapper and reach the endpoint directly —
deletes the very teardown, ordering, or notification the wrapper existed to run. Nothing in the
sentence you quoted was false; it just stopped one layer short.

**Tell:** your justification names where a call ENDS UP, and you have not opened the wrapper to see
what it does BEFORE that. Especially strong for terminate / close / flush / dispose wrappers, whose
docs are written about the destination.

**DO:** read the wrapper's body, then search for handlers registered on whatever it dispatches. One
run also settles it: a lifecycle handler that fires leaves a line in the log, and its absence after
your proposed change is the whole verdict.

**Example (abstracted):** a shutdown helper's doc said the framework's exit "routes through the libc
terminator", which is true — but the framework dispatches an application exit signal first, and the
app's own handler on that signal performed the cooperative teardown and then called the helper. So
the helper was already in the path; calling it directly would have skipped the teardown. A single
run showed the handler's trace line, which no amount of reading the helper's own doc would have.

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

## A Diagnostic Belongs to the Boundary That Knows the Caller, Not to the Pure Function It Gates On

Printing/logging to the user is a boundary concern (the CLI layer, or the "found a real thing" discovery layer) — never inside a pure parse/convert function. The trap is gating the print on a DATA SHAPE (e.g. "this optional param is non-null") and treating that as a proxy for "this is a real, direct caller." It isn't: any caller that happens to satisfy the shape trips it, tests included.

**DON'T:** Put a user-facing print inside a pure function, gated on an input's shape, and document it as "direct callers stay silent" — the shape gate cannot enforce who calls.
**DO:** Have the pure function expose failure AS DATA (nullable return / result). Let the boundary that knows the user and the source own printing, and de-duplicate there (e.g. once per source file per process).

**Tell:** the gate protecting your diagnostic checks a VALUE (is this param set?), not an IDENTITY (is this a real top-level invocation?).

**Example (abstracted):** a print sat inside a library function, gated on an optional param being non-null. Two live failure modes: a memoized/cached caller re-invoked the function once per call site, repeating the line N times per run; and test fixtures passing that same optional param leaked the diagnostic into test output — contradicting the function's own doc, which claimed "direct callers stay silent," a contract the shape gate could never enforce.

## A Fix That Crosses a Repo Boundary Is a Scope Escalation — Ask First

When the "architecturally honest" fix for a task lives in a DIFFERENT repository than the one the task was scoped to (a shared library, a team-owned fork, a sibling service), do not just make it because it's cleaner. A shared artifact carries costs invisible from the call site: rebuild/deploy of dependents, upstream merge burden, other projects' compatibility, team review conventions.

**DON'T:** Silently extend the change into the second repo because the type/API there is "the root cause" and the team owns it.
**DO:** Implement the in-scope workaround locally, and surface the cross-repo fix as an OPTION ("the honest fix is changing X in <lib> — want that instead?"). Let the user pick.
**Tell:** you're about to run the first `git status`/edit in a repo the user's request never mentioned. That's the moment to stop and ask — ownership of the fork is not consent to change it.

## A "Belt-and-Braces" Text Scan Over an Exact Model Is a New Bug Class, Not Extra Safety

When a precise representation (an AST, a typed IR, a parsed config object) already answers a
question, a duplicate check that re-derives the answer from raw text "just to be safe" does not
add a guarantee — it adds its own false positives. And they fail SILENTLY toward refusal: the
tool declines correct work, reports nothing wrong, and the gap is invisible until someone
notices the transformation never fires on a whole shape of input.

**Tell:** the guard's own comment concedes the model covers it — "X DOES project a node … the
scan stays as the belt-and-braces guard." That sentence is the defect, written down. Also: the
same text helper exists as several private copies across sibling modules, and they have DRIFTED
— some taught about a delimiter, some not — which is what a shared question re-answered locally
always decays into.

**DON'T:** keep a text-level scan as a second opinion on something the tree states outright.
**DO:** delete the scan and ask the model. If the model genuinely lacks the distinction, that
absence is the bug to fix (see "A Transform That Can't Handle Shape X" above ↑) — not a reason
to hand-parse.

**Example (abstracted):** a rewrite gate asked "is this declaration a multi-variable list?" by
scanning its source text for a top-level comma. The depth counter tracked `()`, `[]`, `{}` — but
not the generic-argument brackets — so a comma inside a two-parameter generic annotation read as
a declaration separator, and the fixer silently refused every such site. The tree already carried
an explicit continuation node for real multi-var lists; asking for it closed the class in one
line. Four of seven copies of the same text helper had by then been taught about angle brackets
locally, three had not — including the shared one.

**Principle:** re-parsing by hand what the parser already parsed is not defense in depth; it is a
second, worse parser, and it wins the disagreement.

## An "AUTO / UNSET" Member Is a Default the PRODUCER Should Have Resolved

A setting has to cross a boundary (FFI, IPC, serialized config, RPC). It has two real values, but
one code path has no producer at all — a standalone/CLI/test entry point that only reads the
config file. The reflex is to widen the wire type with a third "no opinion" member and teach the
CONSUMER to derive the default from neighbouring fields. That drags policy across the boundary,
forces a string parser plus its typo/case handling, and makes every future consumer learn the
derivation rule — all to serve the one path that never sends anything.

**DON'T:** add `AUTO`/`DEFAULT`/`UNSET` to the wire type so the receiver can infer the value.
**DO:** resolve the default where the producer-less path loads its config, then send only a
resolved value. The boundary type collapses to a bool (or a two-member enum), and the parser,
its error handling, and its tests disappear with it.

**Tell:** you are adding an enum member whose whole job is "nobody told me", and its only reader
is a path where the producer does not exist. Also: you are writing a string->enum parser with
empty-string and unknown-value branches for a setting that has exactly two states.

**Example (abstracted):** a two-way resource choice was sent as a string with three states plus a
case-insensitive parser, because the standalone loader had no caller to send one. Deriving the
choice once inside that loader — from the same field it had always been derived from — reduced the
boundary to one bool, deleted the enum, the parser and its test case, and left the consumer with a
single branch.

**Principle:** "no opinion" is a fact about a call site, not a value of the setting. Resolve it at
the site; let the type carry only real states.

## A New Versioned Step Is Only Warranted if the Previous One Already SHIPPED

Ordered, once-per-install steps guarded by a stored watermark (schema migrations, data
migrations, upgrade hooks, seed versions) are append-only *for released versions*. The reflex
when the newest step turns out to be incomplete is to append another one — because rewriting a
step that installs have already passed does nothing for them. That reasoning is correct only if
the step actually reached those installs. A step added on an unmerged branch has passed on
exactly zero of them, and appending beside it ships a permanent extra number that encodes a
history that never happened.

**Tell:** you are adding step N+1 whose body belongs, by topic, inside step N — and your reason
is "someone might already be at N". You have not checked where step N came from.

**DO:** find the commit that introduced the latest step and ask whether it is released
(`git branch --contains`, tag membership, deploy manifest). Unreleased → extend that step in
place and reuse its number; the only casualties are developer machines, cheap to reset by
clearing the watermark. Released → then, and only then, append.

**Example (abstracted):** a migration that copied legacy single-item settings deliberately did
nothing in a multi-item configuration, leaving those installs broken. A new numbered step was
added to fix them. The step it was avoiding had itself landed days earlier on the same unreleased
branch — so the fix belonged in the `else` of that step's own guard, and the extra number would
have shipped forever to describe a state no install was ever in.

**Principle:** the append-only rule protects installs that have run the step, not the step's
source code. No such installs, no constraint.

## A Strict Gate Verified Only Against Your Own Mock Has Not Been Verified

Sibling of the claimed-negative and claimed-missing entries above ↑, on the evidence side of a
NEW check. You add a strict equality gate on data that crosses a boundary — an exact compare on
a served number, a byte-equal compare on a served payload — and it goes green in unit tests, in
e2e, and over hundreds of live rounds. Every one of those rounds went through a mock written by
the same hand as the consumer. The mock shares the consumer's REPRESENTATION (the same source for
the number, the same serialiser and therefore the same key order), so the gate has never met the
value the real counterpart produces. It fails on the first foreign integration, after the money
moved, and reads as the partner's bug.

**Tell:** you added `!==` / byte-equality on wire or file data, every piece of evidence for it
came through a server you also wrote, and no test constructs the counterpart's representation.

**Two shapes it takes:**
- **Same quantity, different column.** The certified artifact carries the value on a coarser
  grid than the model computes it (an integer in ×1e6 units vs a float on a 1e-9 grid). A real
  server reads the certified column; an exact compare against the fine value rejects every row
  that is not on the coarse grid — measured, roughly one in six.
- **Same values, different bytes.** A server that parses and re-marshals a payload reorders
  keys (map-based encoders, `sort_keys`, a jsonb column). Byte equality rejects content-identical
  data.

**DO:** name what the real counterpart will emit — which column, at what precision, who
re-serialises — and test the gate against THAT: generate the column's value, permute the keys.
Compare on the grid or form that IS the contract (the coarse integer, a canonical key-sorted
serialisation), write that form into the contract in the partner's own terms, and make the mock
serve the contract form rather than the convenient one.

**Principle:** a mock proves the transport. A gate is proven only by the representation it will
actually meet.

## A Fix for Stale State Closes the Half You Can See — Enumerate Every Reader of That State

A fix for "stale state" or a new guard against an escaping failure gets written against the
manifestation you were shown — the reader that reported the bug — not against the state (or the
code region) as a whole. Two failures from one session, both caught by a later reviewer rather than
the author, share the same shape.

**DON'T:** reset only the fields you can currently see are wrong, or wrap only the lines you were
looking at in a `try`. Both read as complete because the symptom you were chasing disappears.
**DO:** before calling a stale-state fix or a guard done, list every READER of that state (every
place downstream that later dereferences it) or every THROWING CALL in the protected region, and
check each one against the fix — not just the one that reported the bug. If the type already owns
a full-reset (or full-wrap) primitive, use it instead of hand-rolling the subset currently in your
head: a partial reset is indistinguishable from a complete one at the call site, and only diverges
at a reader nobody was thinking about.

**Tell:** you wrote a hand-rolled reset that clears two or three fields of one logical state instead
of calling an existing reset-everything method on the same object; or you wrote a `try` whose
closing brace lands before the line that does most of the work (and the documented throw) in the
region it was meant to protect.

**Example (abstracted):** a list widget rebuilt its rows on a second data assignment. The fix
cleared the visible leftovers — old display children, the hover index — and left a third field,
the committed selection index, untouched. Nothing looked wrong; the bug surfaced later on a cancel
path that read the stale index back and dereferenced it into the new, shorter list — out of range
crashed, in range silently selected the wrong row. The class already owned a complete unselect-all
primitive that reset all three fields together.

**Second example (abstracted):** a `try/catch` was added around an operation because an escaping
exception left a modal, timeout-less mask permanently frozen. The `try` wrapped the lines building
the operation's payload — the ones the author was looking at — and stopped one line short of the
call that dispatches it, which is where most of the work, and the documented throw, actually
happens. The guard existed, looked right at a glance, and did not cover the failure it was written
for.

**Principle:** a fix that touches only the fields/lines you currently have in view is closing the
half of the state (or the region) you can see. The other half is closed by enumeration, not by
memory of what you were looking at.

## A Field Nothing Ever Writes May Be an Unfinished Mechanism, Not Dead Code

When a member (a field, a config key, a parameter) is never assigned anywhere, every reader sees only its type default. The reflex is to call it dead weight and propose deleting it.

**DON'T:** Delete an unwritten member on the strength of "nothing assigns it" alone.
**DO:** Look first for a SHADOW CHANNEL - the same value usually already reaches the consumers under a different name (a private mode/state field on the owner, a setter chain, an out-of-band assignment after construction). If one exists, the member is not dead: it is half of a refactor whose read/write path was never finished.

**Tell it was designed in, not abandoned:** the member appears in the type's equality, clone, copy and serialization plumbing; a requested-vs-actual pair exists for its neighbors; and the neighboring members of the same object are fed from the same source the shadow channel reads.

**Rule:** finish the intended path instead of deleting the member - make the owner read it where it builds or starts the thing, so it becomes the single carrier, then delete the shadow. Deletion only freezes the accidental design. Present both options to the user with a recommendation; deleting an unfinished mechanism and completing it are different decisions, and only the user knows whether the intended design is still wanted.

**Follow-on trap once the member becomes the carrier:** enumerate every place the value gets COPIED (clone at construction, copy-on-start, per-instance duplicates of the same config). A stale copy written after the consumer already acted re-creates the original problem in the opposite direction, so the writer must reach every copy, and any actual-value mirror of the member must be filled from what really happened, not from the request.
