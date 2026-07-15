---
name: preferences
description: User's general coding preferences
---

## User's personal coding preferences

These rules are set by the user through direct feedback.
They ALWAYS take priority over base skills.

### Model usage

- Use Opus or Sonnet for subagents
- Never use Haiku — quality too low for real work

### Immutability

- Prefer immutable by default — use `final`/`const`/`readonly`/`val` when value is not reassigned
- Note: semantics differ per language (shallow vs deep), defer to lang-* skills for specifics

### Field initialization

- Initialize fields at the declaration site when the value does NOT depend on constructor parameters
- Only assign in the constructor when the value requires constructor args or complex logic
- This applies to all languages: `final _bg:Sprite = new Sprite()`, `readonly List<int> _items = new()`, etc.

### Class member ordering

1. Constants — public first, then private
2. Public variables — `final` before `var`
3. Private variables — `final` before `var`
4. Constructor
5. Instance methods
6. Static methods — public first, then private

### Access modifiers

- ALWAYS specify `private` or `public` on every field, method, and property — never rely on language-specific implicit defaults
- Modifier order: `override` → visibility (`public`/`private`) → `static` → `inline` → `final`
- Example: `override public static inline function`, NOT `public override static inline function`

### Naming

- Event listener methods: use `Handler` suffix, not `on` prefix — e.g. `frameSelectHandler`, not `onFrameSelect`
- Private fields (variables) must start with `_` prefix: `_count`, `_items`
- This applies to instance variables (`var`/`final`/field), NOT to methods or constants
- Public fields do NOT use underscore prefix

### Comments and documentation

- All code comments and documentation must be in English only — no other languages in source code
- Empty line before a doc comment (`/** */`) on a field — visually separates documented members
- Comment only when behavior is non-obvious from the code. Don't paraphrase the line above; don't restate what the type/name already says

### Formatting

- Prefer ternary `return cond ? a : b` over `if (cond) return a; return b;` — one expression instead of two statements
- No redundant parentheses around ternary conditions — `&&`/`||` bind tighter than `?:`, so `a && b ? x : y` is clear without wrapping `(a && b)`
- No curly braces `{}` for single-line bodies (if, for, function, etc.) — reduces visual noise
- Combine `for` + `if` into `for (...) if (...) {` — preferred over `if (!cond) continue;` inside loop body. Guard reads naturally, `continue` inverts the condition and wastes a line

### Magic numbers

- No magic number literals in logic — extract into a named constant. A value repeated consistently across files is still magic if it has no name
- During review: when checking cross-file consistency of a literal, always ask "should this be a named constant?" — consistency does not justify a magic number

### Error handling

- Never silently swallow invalid state — throw exceptions instead of returning quietly. Silent returns mask bugs and make debugging hard
- Guard clauses for "should never happen" conditions: throw, don't return

### Abstraction threshold

- Don't wrap trivial struct/object construction in a helper — if the literal is 2-3 fields and readable inline, keep it inline even if used multiple times
- Before creating ANY helper: "is the inline version just as readable?" If yes — don't extract
- YAGNI: no abstractions for hypothetical future needs. Don't introduce an interface, base class, factory, or strategy pattern until a second concrete consumer actually exists. The existing `Error handling` rules apply — guard clauses that throw on impossible states are NOT defensive bloat, they surface bugs

### Modify vs create

- When a shared constant/style/config has only one caller — modify it in-place instead of creating a new variant alongside
- Check usage count (grep) before deciding to add vs modify — creating a new variant when the old one is unused is unnecessary duplication

### Asking vs proceeding

- A task/plan instruction to "confirm with user before X" is NOT an absolute mandate to use AskUserQuestion. If the recommended option is just "consistent with the existing established system / default behavior", state it in one line and proceed — don't ask
- Only raise a real question when there's a genuine fork with a user-visible trade-off the user hasn't already implicitly answered. "Same as what we already do" is not a fork
- Surfacing the chosen option + its consequence in the reply ≠ asking permission; prefer the former for time-conscious users

### Respect the user's scope

- When the user scopes a request narrowly ("only about X", "I told you just X"), answer strictly within X. Don't pad with reassurances about adjacent areas they didn't ask about (e.g. "the other rules stay untouched") — that reads as noise/scope-creep and wastes their time
- If an adjacent concern is genuinely load-bearing for the answer, mention it in ≤1 short clause, not a recurring caveat

### Patterns

- When N repetitive operations differ only in "where to write the result" — extract the shared logic into a helper and pass the destination as a callback. Compose helpers by layering: base helper does the common work, typed helpers add parsing/conversion on top
- Don't decompose structured types into separate scalars — pass `Point`, not `x, y`. Keeps signatures clean and call sites readable
- Extract repeated expressions into helpers. Two kinds:
  - **Local helpers** (inside a method) — when they capture method context (closures). Use `inline function` inside the method body
  - **Class-level utilities** — when the function is pure (no method context needed). Place as `private static inline` at the bottom of the class. If reused across classes — move to global utilities
- Never rationalize code duplication as "overengineering to extract". If the same block (3+ lines) appears in multiple places with identical logic, ALWAYS extract into a helper. Duplication is a bug, not a design choice
- Event listener subscribe/unsubscribe: always extract as a symmetrical pair (`addXxxListeners` / `removeXxxListeners`) placed next to each other. Makes it obvious what's subscribed and ensures add/remove stay in sync
