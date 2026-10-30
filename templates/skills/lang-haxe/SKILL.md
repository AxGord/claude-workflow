---
name: lang-haxe
description: Haxe language gotchas
---

# Haxe — Verified Gotchas



## Gotchas — index (full text: `references/gotchas.md`)

Titles only — each names the situation. Read `references/gotchas.md` (or just the
section whose title matches) when the situation in its line is the one in front of you.

- **Compile-traps — index (details: references/compile-traps.md)** — A Haxe compile error whose message does not obviously name the cause → Read references/compile-traps.md BEFORE trying fixes.
- **Properties: Never Call set_/get_ Directly**
- **Strict null-safety — index (details: references/null-safety.md)** — BEFORE writing `@:nullSafety(Strict)` code or fighting ANY narrowing error → Read references/null-safety.md.
- **`catch (e:Exception)` IS a full catch-all — Dynamic is never needed for coverage**
- **`substr` Counts a NEGATIVE Start From the END — `substring` Clamps It to 0**
- **Targets/runtime — index (full details: references/targets-runtime.md)** — BEFORE writing target-conditional code (`#if sys`/`nodejs`), stdin handling, regexes on `--interp`, exception-heavy hot paths on JS, or any tool driving the Haxe…
- **Operator Precedence Diverges from C — Bitwise, `|&^` Tier, and `%`**
- **Abstract types — index (details: references/abstracts.md)** — BEFORE designing an abstract / enum abstract with operators, conversions or catch behavior → Read references/abstracts.md.
- **Optional Parameters: Type-Based Skipping**
- **Macros — index (full details: references/macros.md)** — BEFORE writing or editing ANY macro code (build macros, `Context.*`, reification `macro {}`, `$b{}`, `$a{}`, `$v{}`, `FunctionArg`) → Read references/macros.md.
- **Switching a NULL Enum: the WILDCARD Is What Saves You — Its Absence Is the Crash**
- **A Bare Lowercase Identifier in a `case` Pattern CAPTURES — It Never Compares**
- **`return <expr>` Still Needs Its `;` — a Block-Terminated Statement Hides That**
- **An Arrow Lambda's BLOCK Body Yields Its Last Expression — a `function` Body Never Does**
- **An Anonymous Structure Type Picks Its Separator From Whether Fields Carry `var` / `final`**
- **Braces Around a Lone `if` in an `else` Can Be Load-Bearing for a Following `else`**
- **`using` + New Methods = Silent Name Hijacking**
- **Metadata String Arguments: an Unbalanced `${` Breaks the Read**
- **Adding Enum Ctor: Grep Sister Ctor Literal Across Project**
- **`override` Keyword Detection Misses Abstract-Method Implementations**
- **Instance Field Initializers Run in REVERSE Declaration Order**
- **Safe Cast `cast(v, T)` Returns `null` for a `null` Value — Only Throws on a Non-Null Mismatch**
- **A Library Handing You `Array<Dynamic>` Forces `Dynamic` at the BOUNDARY, Not Through Your Own Signatures**
