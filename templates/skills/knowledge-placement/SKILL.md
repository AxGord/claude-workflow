---
name: knowledge-placement
description: Where a lesson, rule or fact goes — tool, workflow, skill, project instructions, docs, a user's call or memory; the one order every classification uses
---

## Where knowledge goes

One table, one order: the FIRST row that fits wins. A lesson may split into several rows. The last column says which repo the edit lands in.

| # | The knowledge is | It goes to | Repo |
|---|------------------|------------|------|
| 1 | A check a tool, hook, lint rule or gate can hold. A designed lint finding (BY-DESIGN) is one | A queue line against the tool's owner. A designed finding is the lint tool's own baseline or suppression in the project's lint config, never memory. A prose rule only as a stop-gap that names the queue line | The tool's repo (an engine hook or script: the engine; a project tool or lint config: the project) |
| 2 | How a flow routes, its order, or a mechanical step done by hand; or a rule needed at ONE process moment | The workflow state prompt that runs at that moment. Tier: project `.claude/workflows`, personal `~/.claude/workflows`, a bundled one is an engine queue line | The engine for a bundled template, the project for its own |
| 3 | True across projects: a gotcha, tool behaviour, a process habit, a user's correction of how to work | A skill. A bundled skill gets `learned-<name>` beside it, never an edit of the shipped copy; the user's own skill is edited in place. Abstract the incident: no project nouns | The user's skills dir |
| 4 | True of THIS project and every agent obeys it at every command (an invariant, a command, a prohibition) | The project's instructions file (`CLAUDE.md`), only within its own gate: declared, within its size budget, a rule change on the user's word | The project |
| 5 | Project knowledge read on demand | A doc, by its role (guide, reference, journal, ledger, roadmap). A refuted hypothesis is one line of the decisions log, written by the project's tool. A measured reading goes in the commit message and the journal | The project (a finding about the engine: the engine's docs) |
| 6 | A call of the user: taste, scope, a prohibition, a long-term goal | The project's decision home named in its map, with the user's quote and the date; a replaced value is marked superseded | The project |
| 7 | None of the above: not findable in the tree, an un-findable fact, or the user asked to remember it | Memory of the project: one file, one index line, a `why-memory: <row> <why no earlier row fits>` line in its frontmatter | The memory dir of the project; knowledge about developing the engine goes in the engine's dir |

**Never in memory**: the status of work (what shipped, what is left); anything a tool or a workflow already enforces; a designed lint finding (row 1); a log of an optimization or a sweep; a fact for a skill (row 3).

### The project's map

Read the project's `CLAUDE.md` for a line `Placement: <file> § <heading>`. That section is the project's own map: it names where a user's calls live (row 6), the memory dir rule and any extra place. Follow it where it is more specific than a row. No such line: the table alone.

### How to apply

1. Take each lesson alone and walk the rows from 1. Stop at the first that fits; a second part of the same lesson starts the walk again.
2. A row you cannot write yourself (a tool, a bundled template, the instructions file, a protected `preferences-*` skill) leaves your hands as a proposal: the exact text, the row, the repo. The owner places it.
3. A memory write cites its row in `why-memory:`. If you cannot say why rows 1 to 6 do not fit, it is not memory. A project may turn on the engine's `memory_write_gate` (`.claude/workflows/settings.json`): a new memory file with no `why-memory: 7|6 <reason>` frontmatter line is then refused with this table; an edit of an existing file is not.
4. A sweep of existing memory (a cleanup, a curator pass) uses the same rows: an entry that belongs to a row other than 6 or 7 moves there; one that is status or log is deleted.
