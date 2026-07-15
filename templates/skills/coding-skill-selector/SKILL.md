---
name: coding-skill-selector
description: Select and load coding skills by file extensions and domains
---

## Coding skill selector

Load coding skills for the languages/domains THIS TASK will touch.

1. Always: `Skill("preferences")` + `Skill("architecture")`

2. **Language menu** (preferred path): the session's routing prompt included a
   "Project language menu" block — an engine-run scan with per-extension file
   counts and tool probes. Pick from it ONLY the languages this task will
   actually touch: counts are a hint (1 stray file ≠ project language), the
   task text decides. Do NOT re-scan the project yourself.
   No menu in this session (spawned agent, scanner unavailable, empty block) →
   fallback: determine extensions from the task's files yourself.
   Tool-bound skills (a skill that mandates a CLI tool) load ONLY when the
   language's menu line ends in an available-probe marker — `(<tool> OK)`
   vs `(<tool> missing)` — or, when there is no menu or the language's line
   is absent from it, after one `command -v <tool>` probe succeeds. Tool
   unavailable → skip the tool skill and work with regular tools; a tool
   discipline only applies where the tool exists.

3. By file extension (menu-picked or fallback):
   - .py → `Skill("lang-python")`
   - .hx → `Skill("lang-haxe")`
   - .as → `Skill("lang-as3")`
   <!-- Add your own language mappings, e.g.: -->
   <!-- - .cs → `Skill("preferences-csharp")` -->
   <!-- - .cpp, .h → `Skill("preferences-cpp")` -->
   <!-- - .c → `Skill("preferences-c")` -->
   <!-- Pair language skill with personal preferences skill if you have one (e.g. `preferences-haxe`) -->

4. **Top-up rule**: if mid-task you touch a file of a language whose skills
   are not loaded (task turned out wider than it looked) — load that
   language's skills per rule 3, including its tool conditions, BEFORE
   editing the file.

5. By domain (detect from imports, paths, or task description):
   - YOLO / object detection → `Skill("domain-yolo")`
   - Pixi.js (imports from `pixi.js`, PIXI globals) → `Skill("domain-pixi")`
   - Person re-identification (ReID) → `Skill("domain-reid")`
   - Game dev (physics, precision, camera, sprites) → `Skill("domain-gamedev")`
   - OpenFL / hxcpp native target → `Skill("target-openfl-native")`
   - Math overflow / numeric boundaries → `Skill("math")`

6. By tooling/platform:
   - CMakeLists.txt / CMake build → `Skill("build-cmake")`
   - .github/workflows / CI / GitHub Actions → `Skill("ci-github-actions")`
   - AWS Lambda / .NET deploy → `Skill("aws-lambda")`
   - MCP server setup / .mcp.json / MCP troubleshooting → `Skill("mcp-setup")`
   - Claude Code settings.json / hooks / permissions / plugin config → `Skill("claude-code-config")`
   - Workflow YAML in templates/ or .claude/workflows/ → `Skill("workflow-authoring")`
   - Fetching web docs / external content → `Skill("web-reading")`
   - Verifying a web/canvas app via Playwright or a browser MCP (screenshots, captures, perf) → `Skill("browser-verify")`

7. If 3+ independent files or parallel work → `Skill("task-delegation")`

Call `Skill(name)` for EVERY matched skill.

**Gap check**: If files involve a language/domain/tool with no matching skill above, ask the user: "No skill for [X] — proceed without, or create one first?"
