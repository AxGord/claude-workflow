---
name: math
description: Math gotchas — integer overflow boundaries, cross-runtime float parity (tan/pow ULP drift), FP modulo-wrap pitfalls
---

# Math — Verified Gotchas

## Central Binomial Coefficient C(n, n/2) overflow

| Type | Last fits | First overflow |
|------|-----------|----------------|
| Int64 | C(66, 33) = 7,219,428,434,016,265,740 | C(67, 33) |
| UInt64 | C(67, 33) = 14,226,520,737,620,288,370 | C(68, 34) |

Models consistently underestimate this boundary (a common wrong answer is n=62; correct is n=66 for Int64).

**Result vs computation**: the table bounds the RESULT. Intermediate products in the usual `res = res * (n-k+i) / i` loop overflow earlier (the multiply happens before the divide) — the last few safe n need 128-bit intermediates or a divide-first formulation.

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

## Modulo-wrap round-trip is NOT identity for in-range floats — never gate "did it wrap?" on FP equality

`wrapped = lo + (((x - lo) % span) + span) % span` for `x` ALREADY in
`[lo, hi)` returns a value that differs from `x` by ~1 ULP(span) on a large
fraction of inputs. The `%` ops themselves are exact — `%` is
truncated-division remainder (C `fmod` semantics), which IEEE 754 requires
to be exact; note it is NOT the IEEE `remainder()` operation (round-nearest
quotient), a different op. The error comes from the surrounding `x-lo`,
`+span`, `lo+m` adds, each of which rounds. Measured: 41–67% of in-range
values fail `wrapped === x` depending on the window; with `lo` and `x` of
matching magnitude the subtraction is Sterbenz-exact and the identity HOLDS
(0/1e6 failures) — so the spurious rate silently depends on runtime state
(camera position), making it look fine in one regime and fire constantly in
another.

**Failure mode**: `if (wrapped !== x) onWrap()` as a "teleport happened"
detector fired the callback ~60 Hz for every entity instead of once per
recycle — and a simulation harness with the same window shape "validated"
the degenerate behavior convincingly.

**Right**: detect the wrap by RANGE, then normalize:
```js
if (x < lo || x >= hi) { x = lo + (((x - lo) % span) + span) % span; onWrap(); }
```
Also skips the modulo (and its FP noise re-write) in the common in-range case.
