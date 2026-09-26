---
name: lang-haxe
description: Haxe language gotchas
---

# Haxe — Verified Gotchas



## Gotchas — index (full text: `references/gotchas.md`)

Each lesson below is a verified gotcha. Read `references/gotchas.md` (or just the
section whose title matches) when the situation in its line is the one in front of you.

- **String Interpolation: Single Quotes Only** — Inverted from most languages.
- **Compile-traps — index (details: references/compile-traps.md)** — A Haxe compile error whose message does not obviously name the cause → Read references/compile-traps.md BEFORE trying fixes.
- **Properties: Never Call set_/get_ Directly** — Haxe properties with `(default, set)` or `(get, default)` **always** route through the getter/setter — even for self-assignment inside the owning class.
- **Strict null-safety — index (details: references/null-safety.md)** — BEFORE writing `@:nullSafety(Strict)` code or fighting ANY narrowing error → Read references/null-safety.md.
- **Map Key-Value Iteration** — Use `for (key => value in map)` — cleaner than iterating keys and looking up values separately.
- **`catch (e:Exception)` IS a full catch-all — Dynamic is never needed for coverage** — Since Haxe 4.1 (unified exceptions), ANY thrown value — raw string, Int, anonymous object — is wrapped into `haxe.ValueException extends Exception`, so `catch…
- **`substr` Counts a NEGATIVE Start From the END — `substring` Clamps It to 0** — The two differ exactly where a computed index can go negative, and `substr` fails SILENTLY: it returns a window from the far end of the string instead of erroring or…
- **Null Coalescing Operator `??`** — `a ??
- **Targets/runtime — index (full details: references/targets-runtime.md)** — BEFORE writing target-conditional code (`#if sys`/`nodejs`), stdin handling, regexes on `--interp`, exception-heavy hot paths on JS, or any tool driving the Haxe…
- **Enum Abstract for Simple Enums** — For marker enums without associated data, use `enum abstract(Int)` — zero-cost at runtime, compiles to a primitive.
- **Operator Precedence Diverges from C — Bitwise, `|&^` Tier, and `%`** — Three places where Haxe binary-operator precedence contradicts the C-family instinct.
- **Abstract types — index (details: references/abstracts.md)** — BEFORE designing an abstract / enum abstract with operators, conversions or catch behavior → Read references/abstracts.md.
- **Optional Parameters: Type-Based Skipping** — Parameters with default values (`param:Type = default`) can be **skipped** at call site.
- **Macros — index (full details: references/macros.md)** — BEFORE writing or editing ANY macro code (build macros, `Context.*`, reification `macro {}`, `$b{}`, `$a{}`, `$v{}`, `FunctionArg`) → Read references/macros.md.
- **Deep Pattern Matching in Switch** — Haxe switch supports nested destructuring — match struct fields, array elements, and enum constructors in a single `case`.
- **Switching a NULL Enum: the WILDCARD Is What Saves You — Its Absence Is the Crash** — The widely-repeated "`case _` does not match null" is backwards for the shape that actually faults.
- **A Bare Lowercase Identifier in a `case` Pattern CAPTURES — It Never Compares** — `case name:` where `name` is an ordinary field, parameter or local declares a NEW binding that shadows it, so the arm matches EVERY value.
- **`return <expr>` Still Needs Its `;` — a Block-Terminated Statement Hides That** — `return switch x { … }` and `if (c) { … }` compile with no trailing `;` because the closing brace ends the statement.
- **An Arrow Lambda's BLOCK Body Yields Its Last Expression — a `function` Body Never Does** — `->` always takes an EXPRESSION, and a `{ … }` block IS an expression whose value is its last expression.
- **Switch Without Parentheses** — In Haxe, `switch` does not require parentheses around the expression (unlike `if`/`while` where they are mandatory).
- **An Anonymous Structure Type Picks Its Separator From Whether Fields Carry `var` / `final`** — Two spellings, and they do NOT mix.
- **Type Checking: `is` Operator and `Std.downcast`** — `is` is syntactic sugar for `Std.isOfType` — cleaner syntax for type checks: // WRONG — verbose Std.isOfType(obj, DisplayObjectContainer) // RIGHT — idiomatic obj is…
- **Range Iteration Over Manual Counter** — Use `for (i in start...end)` instead of `while` with manual `i++`.
- **If-Expression for Conditional Assignment** — `if/else` in Haxe is an expression — use it to assign `final` instead of `var` with mutation.
- **Braces Around a Lone `if` in an `else` Can Be Load-Bearing for a Following `else`** — `else { if (b) q(); }` and `else if (b) q();` are equivalent ONLY when no `else` can follow the enclosing `if` statement.
- **`using` + New Methods = Silent Name Hijacking** — When a class is imported via `using` globally (e.g., `using ASCompat` in `rootImports.hx` / `import.hx`), adding a new static method to that class makes it available as…
- **Metadata String Arguments Are Subject to String Interpolation** — `@:meta('value')` arguments are parsed as normal Haxe expressions.
- **Adding Enum Ctor: Grep Sister Ctor Literal Across Project** — Haxe's exhaustive switch detection fires `Unmatched patterns: <NewCtor>` at every switch missing an arm — but ONLY when that switch is reached during compile.
- **`override` Keyword Detection Misses Abstract-Method Implementations** — Implementing an `abstract` method needs NO `override` keyword — adding one is a **compile error** (`Field hook is declared 'override' but parent field hook is 'abstract'…
- **Instance Field Initializers Run in REVERSE Declaration Order** — Haxe emits declaration-site field initializers into the constructor prologue **bottom-up**, not top-to-bottom.
- **Safe Cast `cast(v, T)` Returns `null` for a `null` Value — Only Throws on a Non-Null Mismatch** — The runtime-checked cast `cast(value, Type)` does NOT unconditionally throw when the value isn't a `Type`.
- **A Library Handing You `Array<Dynamic>` Forces `Dynamic` at the BOUNDARY, Not Through Your Own Signatures** — `DynamicAccess<Null<Any>>` replaces the whole `Reflect` set with `[]`/`exists`/`keys`; `Any` blocks the typo `Dynamic` accepts, strict null-safety then catches the null-copy `Reflect.setField` hid, and conversion is per element because `Array` is invariant.
