---
name: lang-python
description: Python language gotchas
---

# Python — Verified Gotchas

## Walrus Operator `:=` Scope Leak in Comprehensions

```python
results = [c for raw in data if (c := normalize(raw)) is not None]
# c IS accessible outside the comprehension! (PEP 572 design)
# Unlike regular loop variables, := leaks to enclosing scope
```

Sonnet confidently says "c is NOT accessible" — this is wrong. The walrus operator in comprehensions intentionally binds in the containing scope.
