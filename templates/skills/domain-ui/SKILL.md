---
name: domain-ui
description: UI component architecture — ownership, state, events
---

# UI Components — Ownership Rules

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

## Event Re-dispatch: Don't Duplicate `target`

When a composite re-dispatches events from children, `event.target` already identifies the original source.

**DON'T:** Add a `targetSource` / `originalSender` field to carry the child reference through re-dispatch
**DO:** Only add fields for data the child genuinely doesn't know (e.g. its index in the parent's collection)

**Rule:** Every field in an event must have at least one consumer. "Might be useful later" fields are overengineering.
