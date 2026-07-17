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

### Linter-owned defaults

The machine-checkable preferences (immutability, member order, explicit
visibility, `_`-prefix naming, magic numbers, ternary returns, no swallowed
exceptions, dead-weight removal) live as compilable lists in the user's
`preferences-lint` skill and are compiled into each project's lint config
by `lint-setup`. The PROJECT's lint config is authoritative — write to
satisfy it; the linter is the correction net. In a project with no lint
config (and where `lint-setup` is not installed), load `preferences-lint`
deliberately if the machine-checkable details are needed; if
`preferences-lint` is ALSO unavailable on this machine, these categories
have no substitute text — say so in the report instead of silently
proceeding without them.

### Field initialization

- Initialize fields at the declaration site when the value does NOT depend on constructor parameters
- Only assign in the constructor when the value requires constructor args or complex logic
- This applies to all languages: `final _bg:Sprite = new Sprite()`, `readonly List<int> _items = new()`, etc.

### Naming

- Event listener methods: use `Handler` suffix, not `on` prefix — e.g. `frameSelectHandler`, not `onFrameSelect`

### Comments and documentation

- All code comments and documentation must be in English only — no other languages in source code
- Empty line before a doc comment (`/** */`) on a field — visually separates documented members
- Comment only when behavior is non-obvious from the code. Don't paraphrase the line above; don't restate what the type/name already says

### Formatting

- No curly braces `{}` for single-line bodies (if, for, function, etc.) — reduces visual noise
- Combine `for` + `if` into `for (...) if (...) {` — preferred over `if (!cond) continue;` inside loop body. Guard reads naturally, `continue` inverts the condition and wastes a line

### Error handling

- Guard clauses for "should never happen" conditions: throw, don't return quietly — silent returns mask bugs and make debugging hard

### Abstraction threshold

- Don't wrap trivial struct/object construction in a helper — if the literal is 2-3 fields and readable inline, keep it inline even if used multiple times
- Before creating ANY helper: "is the inline version just as readable?" If yes — don't extract
- YAGNI: no abstractions for hypothetical future needs. Don't introduce an interface, base class, factory, or strategy pattern until a second concrete consumer actually exists. The existing `Error handling` rules apply — guard clauses that throw on impossible states are NOT defensive bloat, they surface bugs

### Modify vs create

- When a shared constant/style/config has only one caller — modify it in-place instead of creating a new variant alongside
- Check usage count (grep) before deciding to add vs modify — creating a new variant when the old one is unused is unnecessary duplication

### Config placement — JIT over global

- Global CLAUDE.md is not a rule dump. A rule needed at a specific process
  moment (agent spawning, commit, review) belongs in that moment's JIT
  carrier — the workflow state prompt or skill that is in context right
  then. CLAUDE.md keeps only: process bootstrap, every-reply rules
  (language, style), and user-specific facts with no JIT carrier (e.g.
  git identity)
- Discipline ≠ preference: universal correct tool usage (sync vs
  background, timeouts) goes into the distributed carriers (bundled
  skills, workflow templates), never into preferences-* — those hold
  only personal taste set by the user

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
