---
name: preferences
description: User's general coding preferences
---

## User's personal coding preferences

These rules are set by the user through direct feedback.
They ALWAYS take priority over base skills.

<!-- Add your preferences here. Examples: -->

### Immutability

- Prefer immutable by default — use `final`/`const`/`readonly`/`val` when value is not reassigned

### Naming

- Private fields (variables) must start with `_` prefix: `_count`, `_items`

### Error handling

- Never silently swallow invalid state — throw exceptions instead of returning quietly

<!-- See https://github.com/anthropics/claude-code/wiki/Skills for more examples -->
