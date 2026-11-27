---
title: "Use case: anyparse"
description: How the open-source anyparse project is run on this engine, step by step, a queue line's whole way from its difficulty to main, with the project's own numbers
aside: false
pageClass: use-case
---

# Use case: anyparse

[anyparse](https://github.com/AxGord/anyparse) is an open-source platform for building parsers, writers and formatters: a grammar is described as Haxe types, and a macro generates the parser and the writer. Its development runs on this engine. Work is cut into small tasks, each a line in a queue; a dispatcher admits the lines that can run together, and every admitted line goes through the same pipeline of agents, on a model chosen by how hard the line is.

This page follows one line from the queue to main. Every diagram is drawn from the project's own workflow files and every number is its ledger: a dated snapshot, written by a script in this repository, of what the pipeline's finished runs did and cost.

## A line enters the queue

The queue is one YAML file. A line is a task small enough to be tested, reviewed and landed on its own, and its brief is written for an agent that knows nothing else: what to change, where, and why. The other fields are for the machinery. Tap one to see who reads it, and move along the ruler to see what a difficulty stands for.

<UseCaseLine />

## The pick admits what can run together

The dispatcher keeps a window of lines running at once. Whenever a slot is free the engine's pick walks the queue by priority, then in file order, and admits a line only when everything it waits for is done and it shares no file with a line that runs. Nobody decides by hand what may run in parallel: the lines' own fields do.

Each admitted line gets its own worktree, its own pipeline session, and a cheap driver agent that moves that session from step to step.

<UseCasePick />

## Difficulty picks the path

A line's difficulty is a guess, made by whoever wrote the line, without the code in front of them. It still decides a lot. Every stage of the pipeline takes its model and effort from one table by that number. And from a threshold up, a read-only recon reads the code before any worker starts.

The recon is the cheap first reader. It checks the premises the line stands on and scores the work by the project's anchors, and its score replaces the line's: the engine rewrites every stage's row, so the expensive agents run on what the work is, not on what the line said.

A score at the top of the scale is not run at all: the recon proposes the smaller lines to cut it into. A premise that does not hold closes the line before a worker has spent anything.

Pick a scenario, or set the two numbers yourself.

<UseCaseFlow />

Three things to notice. Below the recon's threshold there is no scout: the plan stage is the first reader and scores the work itself. A high recon score is the plan, so no plan stage runs and an executor on the execute row starts from the recon's findings. And the two ways out on the right are the cheapest outcomes on the page: a line that should not run stops at its first reader.

## Worker, gate, review rounds, land

The worker owns its change up to a green gate. The gate is a script, so a red row costs the worker another try and nobody else's attention.

Every line is then reviewed by a fresh agent that only reads. A FIXES verdict sends its list back to the worker that wrote the change, and the same reviewer then checks the fix alone. The land is one at a time: the branch is merged into a candidate tree, judged by the full battery, and main moves only when that is green.

Choose how the review goes, and tap a step to read what happens in it.

<UseCaseRounds />

## Lessons become new queue lines

A landed line leaves more than a commit. The worker reports what it saw and did not touch; the reviewer adds notes that did not block the merge. After every land the dispatcher goes through those rows, and one rule decides where each goes, so a lesson is neither lost nor allowed to jump the queue. What a tool or a gate can hold becomes a queue line against that tool, not a note.

<UseCaseLessons />

## The curator checks the rules

The model table and the anchors are guesses too, so they are checked against the ledger. Between two runs of a curator agent a fixed number of lines land. A run does three things, in this order, and proposes at most one change to the model table.

<UseCaseCurator />

## The numbers

Everything above in one panel. Tap a figure to read how it is counted.

<UseCaseNumbers />

<style>
/* the prose keeps a reading width; the scenes take the whole column */
.use-case .vp-doc > div > :where(p, h1, h2, h3, ul, ol) {
  max-width: 720px;
}
</style>
