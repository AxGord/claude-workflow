---
name: task-delegation
description: When and how to delegate to subagents
---

# Task Delegation

## Quick Check

1. **Independent parts?** → if < 2, do it yourself
2. **Interfaces known?** → if no, do it yourself
3. **Different skills needed?** → if same, maybe don't split
4. **Plan ready?** → if no, plan first

**3+ yes → delegate**

## Available Agents

| Agent | Use for |
|-------|---------|
| **researcher** | Information gathering, docs, APIs |
| **coder-python** | Python code |
| **debugger** | Build, run, test |
| **general-purpose** | Complex tasks needing MCP tools |

<!-- Add your own agent mappings here, e.g.: -->
<!-- | **coder-haxe** | Haxe code | -->
<!-- | **coder-csharp** | C# code | -->

## ALWAYS Delegate to Subagent

Build, run, and test operations → **always** use `debugger` subagent.
Heavy output (compilation logs, long files, web content) → through subagent with **precise extraction prompt** ("extract only X"), never dump raw output into main context.
Preserves main context for decision-making.

## Do It Yourself When

- Small task (< 3 files), high coupling, unclear scope, refactoring

## Split By

- **Language**: different languages → different agents
- **Layer**: Backend / Frontend / Database
- **Domain**: separate independent domains

## Rules

- **Maximize parallelism** — launch ALL independent agents in **one message**, not sequentially
- Split by **logical component**, not per file
- Stabilize interfaces **before** parallelizing
- Give agents **specific prompts** with file paths and signatures
- After agents complete: verify integration, link components, test
- **Review subagent code against loaded skills** — subagent fixes compile but may violate style rules. ALWAYS read changed files and apply loaded preference/lang skills before considering done
