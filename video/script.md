# Claude Workflow: the narration

One phrase per line after the first `##` heading, `[id] text`. This preamble, the headings and blank lines are for the reader. Each phrase becomes one WAV
(cached by its text, so editing a line re-voices only that line) and one subtitle cue. `storyboard.json` ties
every id to a card or to a stretch of the replay: add, move or remove a line there as well, and
`npm run video` re-renders (`npm run video -- --check` validates the two files without rendering).

## Title

[p01] This is Claude Workflow: a state machine for your coding agents.

## The problem

[p02] A coding agent can do a lot in a single conversation. Then the work gets bigger.
[p03] You run several tasks at once, hand parts of them to sub-agents, review the results, and lose track of who is doing what.
[p04] Prompts drift. A step is skipped. A review is forgotten, and nobody notices until the code has landed.

## How the engine solves it

[p05] Claude Workflow moves the process out of the prompt and into a finite state machine, written in plain YAML.
[p06] Each state tells the agent what to do now, and which moves are allowed next.
[p07] The engine tracks the state, enforces the guards, and runs shell commands for you, so a step cannot be skipped.
[p08] Workflows nest. One task pipeline can start a recon agent, a worker and a reviewer, each with its own small machine.

## The live scene

[p09] Here is a real recording from the open-source anyparse project. On the left, the plan pane in the terminal. On the right, the live workflow map.
[p10] A task starts. A recon agent reads the code first, and the map shows its branch leaving the pipeline.
[p11] When recon is done, a worker takes over and makes the change.
[p12] Now five tasks start together. Each one is a lane on the map, and the plan pane lists them under Running, with a bar for how hard the task is rated.
[p13] The lanes keep moving while the workers build and test, and the next lines of the queue wait in the pane.
[p14] When a worker finishes, a reviewer starts in a fresh context. The review round is part of the machine, not a favor.
[p15] A worker can also fail. The pipeline routes around it, instead of quietly losing the task.
[p16] Hours of work pass in seconds. Finished tasks move to Landed, and the next line of the queue starts by itself.

## How to start

[p17] To start, install the plugin from the marketplace, and ask Claude to start a workflow.
[p18] The bundled templates cover coding, debugging, review, research and long batch runs. Write your own in YAML.
[p19] It is open source, under the MIT license. The link is in the repository.
