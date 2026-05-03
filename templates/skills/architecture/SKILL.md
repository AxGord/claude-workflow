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

Sonnet defaults to "interfaces for testing are fine" — this skill corrects that.

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

## Refactoring Scope: Don't Escalate Lifecycle

When refactoring an inline operation into a two-phase approach (set intent + execute), match the original operation's lifecycle scope.

**DON'T:** Wrap the new orchestration in container-level stop/start if the original operated at element level
**DO:** Let existing element-level lifecycle (setters, listeners) handle transitions — they already work

**Example:** A self-contained `selectNext()` swapped one item inline (release + take + index setter handled stop/start). Refactored to set intent + reallocate(). Added container-level stop/start around it. But start had an `isAvailable()` gate requiring a minimum active count — a constraint the original inline operation never hit. The element-level index setter already stops the old item and starts the new one.

**Rule:** Before adding lifecycle management to a refactored operation, check: did the original operation need it? If the original worked within existing infrastructure (setters, listeners), the refactored version should too.

## New Canonical Path → Ask About Legacy Parallels

When you add a new canonical input/output mechanism that does the same thing as existing legacy paths (e.g. UI buttons that replicate keyboard shortcuts, a typed API replacing an untyped one, a structured event replacing a string topic), the default urge is to keep the legacy paths "for compatibility" and build a coexistence shim. Don't.

**DON'T:** Silently keep legacy paths AND add a coexistence shim (coordinate gates, target-checks, debouncers) so the new and old don't fight.
**DO:** Surface the question explicitly: "should we remove the old paths, or keep them?" — and prefer single-source by default.

**Example:** Added UI panel buttons that already handle the full action flow. Kept the original canvas tap (= fire) AND keyboard shortcuts (= fire). Adding the buttons made every panel click double-fire (tap dispatched on both panel and canvas), so a Y-coord gate was introduced to suppress canvas handling over the panel area. After confirming "remove keys and canvas-click entirely, the buttons are the way" — the gate became dead code, deleted in the same pass.

**Symptom of violation:** you find yourself adding gating logic (coordinate checks, `if (ev.target === ...)` filters, `inflight` flags) just to make two input paths coexist when one is meant to subsume the other.

**Rule:** A new canonical mechanism is an opportunity to remove the old one, not to add a referee between them. If the user didn't explicitly ask to keep both, ask before keeping both.
