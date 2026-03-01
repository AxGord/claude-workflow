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

## Serialization Doesn't Belong in Runtime State

**DON'T:** Put `serialize()`/`deserialize()` methods directly in runtime/state classes
**DO:** Keep serialization in a separate class or in the persistence layer

**Why:** Runtime state manages current values, interpolation, transitions. Serialization is I/O concern — different reason to change, different dependencies (XML, JSON, etc.). Mixing them inflates the class and hides the boundary.

**GOTCHA at review:** Inline serialization "works" and passes tests — the violation is structural, not functional. Actively check for it: if a class has both state logic AND `serialize`/`deserialize`, flag it.

When in doubt: **suggest the boring, proven, simple solution.**
