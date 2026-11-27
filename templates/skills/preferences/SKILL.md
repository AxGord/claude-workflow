---
name: preferences
description: User's general coding preferences
---

## User's personal coding preferences

Set by the user; they override base skills.

### The linter IS the preference

Machine-checkable preferences (immutability, member order, visibility,
`_`-prefix, magic numbers, ternary returns, swallowed exceptions, dead
weight, field init at declaration, English comments, duplication, listener
symmetry) live in `preferences-lint` and are compiled into each project's
lint config by `lint-setup`. The PROJECT's config is authoritative. No lint
config here → load `preferences-lint`; unavailable too → say so in the report.

### Judgement the linter cannot make

- Event-listener methods: `xxxHandler`, not `onXxx`.
- No braces around a single-statement body (`if`/`for`/`function`).
- Comment only the non-obvious; never paraphrase the line.
- "Should never happen" → throw, never a quiet return.
- Abstraction: no helper for a 2–3-field literal that reads fine inline; no
  interface/base/factory before a second concrete consumer exists.
- A shared constant/style with one caller → modify it in place, don't add a
  variant beside it (check usages first).
- N operations differing only in the destination → one helper taking the
  destination as a callback; pass `Point`, not `x, y`.
- Helpers: closure over method context → local `inline function`; pure →
  `private static inline` at the class bottom, shared → global utility.
- A tool, formatter or codegen bug reported through a concrete file or selection:
  apply the fix's result to THAT file too, after checking that only the intended
  hunk changes — or say plainly that it was left stale.
- Git advice, rebase vs merge: one question decides it — which commits does it
  rewrite, and are any already published? Unpublished → rebase; published → merge.

### Working with the user

- "Confirm before X" where the answer is "same as the established default" →
  state it in one line and proceed; ask only at a real fork with a visible
  trade-off.
- A narrowly scoped request gets a narrowly scoped answer — no reassurances
  about adjacent areas.
- Never allocate an identifier an external system owns (translation key, DB
  id, ticket number): wire exactly the ids handed over and list the missing
  ones — a guessed id hides behind the fallback and later collides.
- Text that leaves the machine (a PR description, a comment in another repo):
  check every claim about OUR code or forks against the repo or memory before
  publishing. A plausible line like "we ship this in our fork" was false once:
  the patch had been pulled and never committed.
