---
name: lang-python
description: Python language gotchas — incl. bit-exact float parity with JS/V8 (tan/pow ULP drift)
---

# Python — Verified Gotchas

## Walrus Operator `:=` Scope Leak in Comprehensions

```python
results = [c for raw in data if (c := normalize(raw)) is not None]
# c IS accessible outside the comprehension (PEP 572 design) —
# but only if the walrus actually ran: with an empty `data`, reading c
# raises NameError. It runs even for filtered-out elements (the walrus
# sits in the condition), so c holds the last *evaluated* value, not the
# last *kept* one.
# Unlike regular loop variables, := leaks to enclosing scope
```

The common confident claim "c is NOT accessible outside" is wrong — the walrus operator in comprehensions intentionally binds in the containing scope.

## Cross-runtime trig: V8 `Math.tan` ≠ CPython `math.tan` by 1 ULP

When building bit-exact parity between TS/JS and Python implementations of
the same math, **`tan` is the single biggest offender**. V8 and CPython do
not share a single implementation (V8 ships its own fdlibm-derived routines;
CPython calls platform libm), and `tan`'s range reduction produces a
different LSB from naive `sin(x)/cos(x)` for some angles — which layer is
responsible varies by platform.

**Fix**: compute `tan(x)` as `sin(x) / cos(x)` in BOTH languages. `sin` and
`cos` round-tripped bit-identically across the tested runtimes.

| Op | V8 `Math.X` vs CPython `math.X` | Use? |
|---|---|---|
| `sin`, `cos` | bit-identical (observed) | yes |
| `sqrt` | bit-identical (IEEE-754 mandates correctly-rounded) | yes |
| `tan` | **1 ULP drift possible** | avoid — use `sin/cos` |
| `**` (pow) | 1-2 ULP drift possible | accept tolerance |
| `atan`, `atan2`, `exp`, `log` | 1-2 ULP drift possible | accept tolerance |

**Even after sin/cos swap**, `pow(x, y)` (e.g. `step_mult = floor + norm**exp`)
can still produce 1-ULP-different doubles between V8 and CPython for some
inputs. If the math identity is preserved (same algorithm, same constants,
sin/cos for tan), `math.isclose(rel_tol=1e-12, abs_tol=1e-9)` covers ~2 ULP
at typical magnitudes and is the right tolerance for "bit-exact in spirit".

**Concrete example**: a projectile-apex derivation
`apexAboveMidline = (range/4) * tan(angleRad)`. V8 emitted
`tan=0.32130439756415801744`; CPython emitted `tan=0.32130439756415796193`.
After swapping both to `sin(x)/cos(x)`, both emitted the second value.
Remaining rare failures (9/1000 seeds) came from `**1.8` in the step
multiplier — those needed the `isclose` tolerance.
