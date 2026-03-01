---
name: math
description: Math overflow boundary gotchas
---

# Math — Verified Gotchas

## Central Binomial Coefficient C(n, n/2) overflow

| Type | Last fits | First overflow |
|------|-----------|----------------|
| Int64 | C(66, 33) = 7,219,428,434,016,265,740 | C(67, 33) |

Sonnet consistently underestimates this boundary (says n=62, correct is n=66).
