---
name: lang-python
description: Python language gotchas
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
