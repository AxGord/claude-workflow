---
name: preferences
description: User's general coding preferences
---

## User's personal coding preferences

These rules are set by the user through direct feedback.
They ALWAYS take priority over base skills.

<!-- Add your preferences here. The sections below are examples — -->
<!-- customize them to match your coding style. -->

### Model usage

<!-- - Use Opus or Sonnet for subagents -->
<!-- - Never use Haiku — quality too low for real work -->

### Immutability

- Prefer immutable by default — use `final`/`const`/`readonly`/`val` when value is not reassigned
<!-- - Note: semantics differ per language (shallow vs deep), defer to lang-* skills for specifics -->

### Field initialization

<!-- - Initialize fields at the declaration site when the value does NOT depend on constructor parameters -->
<!-- - Only assign in the constructor when the value requires constructor args or complex logic -->

### Class member ordering

<!-- 1. Constants — public first, then private -->
<!-- 2. Public variables — `final` before `var` -->
<!-- 3. Private variables — `final` before `var` -->
<!-- 4. Constructor -->
<!-- 5. Instance methods -->
<!-- 6. Static methods — public first, then private -->

### Naming

- Private fields (variables) must start with `_` prefix: `_count`, `_items`
<!-- - Event listener methods: use `Handler` suffix, not `on` prefix -->
<!-- - This applies to instance variables, NOT to methods or constants -->
<!-- - Public fields do NOT use underscore prefix -->

### Comments and documentation

<!-- - All code comments and documentation must be in English only -->
<!-- - Empty line before a doc comment on a field — visually separates documented members -->

### Formatting

<!-- - Prefer ternary over if/else for simple returns -->
<!-- - No curly braces for single-line bodies -->
<!-- - Combine `for` + `if` into `for (...) if (...) {` — preferred over `if (!cond) continue;` -->

### Error handling

- Never silently swallow invalid state — throw exceptions instead of returning quietly

### Magic numbers

<!-- - No magic number literals in logic — extract into a named constant -->
