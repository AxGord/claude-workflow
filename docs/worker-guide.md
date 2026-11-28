---
title: Engine worker guide
description: What an agent working on this repository's code needs on its first turn
---

# Engine worker guide

For a worker, reviewer or investigator of an engine slice. The engine repo is TypeScript and public. A session started in another project (a Haxe project, say) loads that project's rules: its language, linter, `hxq` and `.hx` gates do not apply to this code. `CLAUDE.md` in this repo holds the full map and is not loaded for you, so read its section on the area you touch.

## First

1. Read this file, then the engine's memory index, `MEMORY.md` under `~/.claude/projects/<main checkout path, every / and . written as ->/memory/`. It lists short rule files; open the ones your line touches. The index may be absent on another machine.
2. Read your brief once. Check the tree before you edit: work already applied is reconciled, not done twice.

## Build and check

- `npm run build` compiles `src/` to `build/` with tsc 7. `npm test` runs vitest.
- The gate is `npm run check`: tsc, biome format check, eslint against `eslint-baseline.json` (only new findings fail), ast-grep `scan`, vitest, the pane tests and `check:ci`.
- Run it as `<main checkout>/scripts/check-leased.sh` from your worktree, never bare: it leases cores from the pool.
- `check:ci` runs the suite in a clean environment (empty HOME, no git config, foreign time zone). A test that passes only with your own HOME fails it.
- A fixed eslint finding left in the baseline fails the suite: re-record with `npm run lint:baseline` in the same commit.
- A new behaviour gets a vitest pin that fails with its code removed. Name the pins in the CHANGELOG entry.

## The commit

- One commit on your branch, the author from the git global config. Never push, tag or publish: those are the user's.
- The same commit carries a `CHANGELOG.md` entry under `## Unreleased`, and README, the bundled skills and any key list, comment or tool description that enumerates the feature.
- Edit `CLAUDE.md` only when your line names the row. Otherwise put the row and its exact new text in your report.
- No `git stash`, no `pkill -f`. A clean worktree at the end.
- The pre-commit hook refuses a commit on the main checkout that carries anything but a `docs/decisions.md` line (`scripts/check-commit-scope.sh`); your worktree commit is never refused by it. Never set `WF_ENGINE_USER_COMMIT`: it is the user's. A drift of a live skill blocks only a commit that touches `templates/skills*/`; see `docs/development.md` § The pre-commit hook.

## What is public

The repo is open source. Never commit a personal or temporary setting: models, effort, budget, a `/Users/...` path, a private project name, a personal toolchain. A model or budget change goes to the consuming project's own workflow files.

Public surface, where a change needs docs, a skill line and a pin:

- the MCP tools and their replies (`src/tools.ts`)
- workflow YAML keys and state types (`src/types.ts`, `docs/workflow-yaml.md`, `docs/action-states.md`)
- the bundled `templates/`, `agents/`, `scripts/wf-*`, `hooks/` and the environment variables
- the queue file format and the CLIs (`docs/queue.md`)

A new state type touches, in order: `types.ts`, `engine.ts`, `tools.ts`, the dashboard (graph, detail, history, state list), `templates/`, the `wf-yaml-authoring` skill. A missing layer is an incomplete change.

## Skills and agent types

- `templates/skills/` is the bundled copy of the live `~/.claude/skills/`. The live copy is the truth and you cannot write it. Edit the bundled file and name the live sync in your report; `scripts/check-skill-sync.sh` refuses drift in a commit that touches a skill.
- Every edit of `templates/skills/` or `templates/skills-stack/` needs `npm run skills:history`.
- A bundled skill's `.md` file never carries one heading line twice (a paste that doubled a section): `src/skills.test.ts` names the file and both lines.
- Renaming an agent type keeps the old `agents/<name>.md` until drivers spawned under it have ended.
- A mod `tool.call` hook never changes the call's input: auto mode refuses the call. The engine's own PreToolUse hooks are a separate mechanism.

## Live or restart

An exec'd script (`scripts/wf-queue`, which runs `build/queue-cli.js`) is live after `npm run build`. The MCP tools, the ledger writer and `hooks.json` need a restart; an agent-type change needs a Claude restart. Say which in your report.

## Where text goes

| What | Where |
|------|-------|
| A check a tool, hook, test or gate can hold | a vitest pin or a script check, never a prose rule or a memory file |
| A user-visible change | `CHANGELOG.md`, under `## Unreleased` |
| Reference for a feature | the page of `docs/` that owns it (`docs/.vitepress/config.mts` lists them) |
| Build, workflow slice and site internals | `docs/development.md` |
| A refuted hypothesis | one line appended to `docs/decisions.md` |
| A rule a worker needs | this file |
| The map of the code | `CLAUDE.md` |
| A call of the user | his quote and the date in the slice's queue line |
| Knowledge about developing the engine that no row above holds | the engine's memory index, one file with a `why-memory:` line citing the row of the `knowledge-placement` table |

This is the engine's map of the bundled `knowledge-placement` table. Status of work (what shipped, what is left) goes to the commit message, never to memory.

Docs pages follow the house style in `docs/development.md`: blocks under 80 words, a table cell under 40.

## Decisions

`docs/decisions.md` is append only: one line per refuted hypothesis, `what → why not → slice id`, at most 300 characters. Add a line with `printf '%s\n' "<line>" >> docs/decisions.md`; search it with `grep -n`, never rewrite it.

## Release

A release is the user's. Its version lives in `package.json`, `.claude-plugin/plugin.json` and `package-lock.json`. The publish workflow builds the `release` branch; master carries no built files. Do not bump a version.
