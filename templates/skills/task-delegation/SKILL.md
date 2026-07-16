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

## Model Selection (mandatory)

ALWAYS pass an explicit `model` to the Agent tool — never let a spawn
silently inherit the session model (the session tier is the orchestrator's;
paying it per worker doubles cost for no gain). Never haiku. Pick by
**cost-of-error × mechanical safety net**: where a linter/test-suite/compiler
catches mistakes, sonnet suffices; where nothing mechanical guards the
output, opus.

| Spawn | Model |
|---|---|
| Review batches with a lint report (.hx+hxq), instruction/config files, routine code | sonnet |
| Review of macro-heavy / concurrency / engine-critical / no-linter code | opus |
| Finding verification (one skeptic over aggregated findings) | opus |
| Code-writing agents: non-trivial logic | opus |
| Code-writing agents: mechanical edits from a detailed plan | sonnet |
| Explore / locate fan-out (returns locations, not judgements) | sonnet |
| Build/test/repro runners (verbatim-quote reporting) | sonnet |
| Web-research fetch/extract fan-out (synthesis stays in the parent) | sonnet |
| Analytical judgement subagents (blast-radius verdicts, design recon) | opus |

On overlap, opus wins: a lint-covered batch that is ALSO macro-heavy /
concurrency / engine-critical goes to opus — a style/structure linter does
not mechanically guard against races or codegen-correctness bugs.

## Top-Tier Orchestrator Unloading

When THIS session runs on the top model tier — the STRONGEST model the
harness offers (you know your own model from your system prompt; an
opus/sonnet session is NOT top-tier and skips this section) — your output
is JUDGMENT, not code: the session context is re-read every turn at
top-tier rates, so file bodies must not flow through it:

- **The PLAN is built HERE, inline** — it is the condensate of the user
  dialog (intent, rejected options, constraints) that no brief can carry;
  and the planner must be the dispatcher (contracts drift when split).
  Recon FOR the plan delegates (Explore/Plan agents); the plan does not.
  A top-tier plan sub-agent is an escalation tool for WEAKER main
  sessions, never for a top-tier one (it would pay for the same
  understanding twice).
- **CODE above ~30 changed lines → implementer agent(s)**: a COUPLED
  change goes to ONE implementer carrying the whole plan + contracts
  (never fan out a coupled set per-file); independent files fan out in
  parallel as usual.
- **Implementer tier = f(plan detail × mechanical net)**: a detailed plan
  (exact edits, contracts, order) + a net (linter/tests/compiler) →
  `sonnet` — implementation became mechanics; the plan deliberately
  leaves in-implementation freedom (algorithms, macros, concurrency,
  engine-critical) or there is no net → `opus`. The economics of the
  scheme: top-tier judgment buys a plan so precise that a cheap model
  can write from it.
- **Stays inline**: tiny edits (≤~30 lines — a yaml line, a config
  tweak, memory notes) where agent round-trip costs more than it saves;
  and PLAN-CLASS text generally (prompts, skill instructions, briefs,
  plans, memory) — that text IS the orchestrator's own product.

## Agents

Pick the agent type by task shape:

- **Explore** — read-only search fan-out: sweeping many files/dirs for a
  conclusion, locating code, blast-radius reconnaissance. No file edits.
- **general-purpose** — implementation work and everything else; the
  fallback/default. Inherits all tools including MCP from the parent context.

## Lifecycle

- The Agent tool runs subagents **in the background by default** — you are
  notified on completion. Pass `run_in_background: false` when the result
  gates your next step.
- **A background agent's first "final report" can be PREMATURE.** The
  completion notification fires whenever the agent stops; it may then
  resume and keep writing, delivering a refined report later. Artifact-
  checking the tree at first-notification can falsely read as
  "agent fabricated its report" and trigger a duplicate re-spawn (two
  agents then race the same fix on one tree). Rules: for WRITE tasks,
  prefer `run_in_background: false`; when a background write-agent's
  report doesn't match the tree, check whether its workflow session is
  still active before concluding fabrication; treat the LAST report as
  authoritative. Re-verify with a REBUILT tool — a verification probe
  through a stale cached binary refutes a fix that actually landed.
- **The complement: don't BLOCK on a late narrative either.** A background
  agent can stop mid-wait (e.g. yielding for its own children's
  notifications) and deliver only an interim note. If its deliverable
  already verifies on-tree — commit present, tree clean, gates recorded in
  the commit/report trail — proceed on the artifacts: verify them
  directly, abort the agent's orphaned workflow session, move to the next
  wave. The narrative report is context; the artifacts are the
  deliverable. Symmetric rule: artifacts outrank the report in BOTH
  directions (don't trust an early report the tree contradicts; don't
  wait for a final report the tree already proves).
- Use SendMessage (agent ID or name) to continue an existing agent with its
  context intact — don't respawn for a follow-up question.
- Launch ALL independent agents in **one message**, not sequentially.
- **Worktree-isolated agents fork from the session-start HEAD, not the current branch tip.** Commits you make mid-session are NOT in a later-spawned agent's worktree base — the agent may see stale code, wrongly conclude your work "was never merged", or produce patches that conflict. Rule: COMMIT each phase before spawning the next dependent wave; when a wave's base is already stale, merge its patches with `git apply --3way` and expect to hand-reconcile files several agents touched. Also instruct agents to report their base commit (`git log --oneline -1`) so staleness is visible. One more trap in that merge flow: `git apply --3way` STAGES everything it applies — a later `git add <subset> && git commit` silently commits the WHOLE staged index, not your subset (the tell: the first chunk commit's stat lists every merged file and later chunk commits say "nothing to commit"). Run `git reset -q` to unstage all before building chunked commits, and if rebuilding botched history, soft-reset to the true pre-merge base, never to a mid-wave commit.

## ALWAYS Delegate to Subagent

Build, run, and test operations → subagent.
Interactive live-app debugging sessions (display-tree queries, clicks,
screenshots — e.g. via a debug bridge, driver, or browser MCP) → subagent.
Heavy output (compilation logs, long files, web content) → subagent with **precise extraction prompt** ("extract only X"), never dump raw output into main context.
Preserves main context for decision-making.

## Spawn Mode: Analytical vs Light (mandatory)

A spawned subagent runs **flat by default** — no workflow session, no
`load_skills` gate, no skills. Classify every spawn:

- **Analytical** — correctness depends on project skills, or it returns a
  judgement/recommendation (blast-radius, verify-writer-path, recon, deep
  code investigation). NEVER spawn flat. Prepend VERBATIM to its prompt,
  substituting `<SESSION_ID>` with the current workflow session ID
  **before sending**:
  `IMPORTANT: Override the default CLAUDE.md rule about start(). Do NOT
  call start() without arguments. Your FIRST action must be
  mcp__plugin_workflow_wf__start({ workflow: "subagent",
  parent_session_id: "<SESSION_ID>" }); then follow the subagent workflow
  until completion. start() returns SESSION: <id> — pass that session_id
  explicitly in every subsequent workflow tool call; parallel siblings
  share the same ppid.` (its `route` self-classifies → skill-loaded
  sub-workflow).
- **Light** — run a command and report (build/test/repro/extract), zero
  judgement. Flat is fine, but prepend VERBATIM: `Environment rules: a
  bash hook blocks grep/sed/cat/head/tail on parseable .hx — use the Read
  tool or hxq, never shell text-extraction. hxq is multi-file: ONE
  hxq <sub> <Type> <dir-or-glob> call, never a per-file loop. Strip
  noise, but quote every error, failing assertion, and number VERBATIM —
  don't paraphrase the signal or replace it with a verdict; the parent
  judges.`

This is the parent-side safety net: workflow states that instruct
spawning carry their own preamble text, but those prompts can be stale
(e.g. a template edit not yet propagated to a live cache). The parent
injects the correct preamble into every spawn regardless.

## Resumable Waves

Long multi-agent waves get killed mid-run (API session limits, user
interrupts). Two rules make that cheap instead of catastrophic:

- **Write every spawn prompt verify-then-complete**: "diff the current
  on-disk state first; for each work item check if already applied;
  reconcile — don't double-apply." An interrupted agent's partial edits
  then survive a re-run instead of poisoning it.
- **Resume a dead agent via SendMessage** (context intact — it keeps its
  research) instead of re-spawning fresh. If its workflow session was
  abandoned with the parent, tell it the NEW parent_session_id to start a
  fresh child session. Re-spawn fresh only when resume is unavailable.

Also **time-box research inside implementation agents**: an agent told to
verify facts can rabbit-hole into open-ended web verification. Say "apply
the plan text as given; quick checks only; list unverified items in the
report instead of digging."

## Orphan Cleanup

After collecting all reports: `sessions` → `abort` any orphaned child
`subagent` sessions. A child that errored or was interrupted leaves an
active session behind, which blocks the parent session's completion.

## Do It Yourself When

- Small task (< 3 files), high coupling, unclear scope, refactoring

## Split By

- **Language**: different languages → different agents
- **Layer**: Backend / Frontend / Database
- **Domain**: separate independent domains

## Rules

- **Maximize parallelism** — if 3 components have clear interfaces → 3 agents at once
- Split by **logical component**, not per file
- Stabilize interfaces **before** parallelizing
- Give agents **specific prompts** with file paths and signatures
- After agents complete: verify integration, link components, test
- **Review subagent code against loaded skills** — subagents fix problems mechanically (compile errors, type mismatches). Their fixes compile but may violate style rules (missing types, verbose patterns, redundant code). ALWAYS read each file the subagent changed and apply loaded preference/lang skills before considering done
- **Verify lifecycle edits** — after subagent touches start/stop/dispose: (1) every `removeEventListener` in stop/dispose has a matching `addEventListener` in `start`, not just constructor (listener orphaning on restart); (2) new init code is inside the correct conditional block, not placed before a guard where it runs in wrong state
