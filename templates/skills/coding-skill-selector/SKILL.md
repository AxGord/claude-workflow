---
name: coding-skill-selector
description: Select and load coding skills by file extensions and domains
---

## Coding skill selector

Load coding skills for files/context in this task.

1. Always: `Skill("preferences")` + `Skill("architecture")`

2. By file extension:
   - .py → `Skill("lang-python")`
   - .hx → `Skill("lang-haxe")`
   - .as → `Skill("lang-as3")`
   <!-- Add your own language mappings, e.g.: -->
   <!-- - .cs → `Skill("preferences-csharp")` -->
   <!-- - .cpp, .h → `Skill("preferences-cpp")` -->
   <!-- - .c → `Skill("preferences-c")` -->
   <!-- Pair language skill with personal preferences skill if you have one (e.g. `preferences-haxe`) -->

3. By domain (detect from imports, paths, or task description):
   - YOLO / object detection → `Skill("domain-yolo")`
   - Pixi.js / pixi.js imports → `Skill("domain-pixi")`
   - Person re-identification (ReID) → `Skill("domain-reid")`
   - Game dev (physics, precision, camera, sprites) → `Skill("domain-gamedev")`
   - OpenFL / hxcpp native target → `Skill("target-openfl-native")`
   - Math overflow / numeric boundaries → `Skill("math")`

4. By tooling/platform:
   - CMakeLists.txt / CMake build → `Skill("build-cmake")`
   - .github/workflows / CI / GitHub Actions → `Skill("ci-github-actions")`
   - AWS Lambda / .NET deploy → `Skill("aws-lambda")`
   - MCP server setup / .mcp.json / MCP troubleshooting → `Skill("mcp-setup")`
   - Claude Code settings.json / hooks / permissions / plugin config → `Skill("claude-code-config")`
   - Workflow YAML in templates/ or .claude/workflows/ → `Skill("workflow-authoring")`
   - Fetching web docs / external content → `Skill("web-reading")`

5. If 3+ independent files or parallel work → `Skill("task-delegation")`

Call `Skill(name)` for EVERY matched skill.

**Gap check**: If files involve a language/domain/tool with no matching skill above, ask the user: "No skill for [X] — proceed without, or create one first?"
