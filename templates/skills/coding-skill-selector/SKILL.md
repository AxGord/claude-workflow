---
name: coding-skill-selector
description: Select and load coding skills by file extensions and domains
---

## Coding skill selector

Load coding skills for files/context in this task.

1. Always: `Skill("preferences")` + `Skill("architecture")`
2. By extension:
   - .py → `Skill("lang-python")`
   - .hx → `Skill("lang-haxe")`
   <!-- Add your own language/domain mappings here, e.g.: -->
   <!-- - .cs → `Skill("preferences-csharp")` -->
3. By domain:
   <!-- Add domain-specific skills here, e.g.: -->
   <!-- - gamedev → `Skill("domain-gamedev")` -->
   <!-- - CMake → `Skill("build-cmake")` -->
4. If 3+ files: `Skill("task-delegation")`

Call `Skill(name)` for EVERY matched skill.

**Gap check**: If files involve a language/domain with no matching skill,
ask the user: "No skill for [X] — proceed without, or create one first?"
