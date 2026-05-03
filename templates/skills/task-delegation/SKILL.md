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

## Agent

All delegation uses `general-purpose` subagent. It inherits all tools including MCP from the parent context.

## ALWAYS Delegate to Subagent

Build, run, and test operations → subagent.
Interactive debug bridge sessions (display tree, clicks, screenshots) → subagent.
Heavy output (compilation logs, long files, web content) → subagent with **precise extraction prompt** ("extract only X"), never dump raw output into main context.
Preserves main context for decision-making.

## Do It Yourself When

- Small task (< 3 files), high coupling, unclear scope, refactoring

## Split By

- **Language**: different languages → different agents
- **Layer**: Backend / Frontend / Database
- **Domain**: separate independent domains

## Rules

- **Maximize parallelism** — launch ALL independent agents in **one message**, not sequentially. If 3 components have clear interfaces → 3 agents at once
- Split by **logical component**, not per file
- Stabilize interfaces **before** parallelizing
- Give agents **specific prompts** with file paths and signatures
- After agents complete: verify integration, link components, test
- **Review subagent code against loaded skills** — subagents fix problems mechanically (compile errors, type mismatches). Their fixes compile but may violate style rules (missing types, verbose patterns, redundant code). ALWAYS read each file the subagent changed and apply loaded preference/lang skills before considering done
- **Verify lifecycle edits** — after subagent touches start/stop/dispose: (1) every `removeEventListener` in stop/dispose has a matching `addEventListener` in `start`, not just constructor (listener orphaning on restart); (2) new init code is inside the correct conditional block, not placed before a guard where it runs in wrong state
