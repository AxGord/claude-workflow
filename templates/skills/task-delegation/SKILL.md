---
name: task-delegation
description: When and how to delegate to subagents
---

# Task Delegation

## Model Selection (mandatory)

ALWAYS pass an explicit `model` AND `effort` to the Agent tool — never let a
spawn silently inherit the session model (the session tier is the
orchestrator's; paying it per worker multiplies cost for no gain). Pick by
**cost-of-error × mechanical safety net**: the more a linter / test suite /
compiler / the parent's own check catches mistakes, the cheaper the model.

| Spawn | Model | Effort |
|---|---|---|
| Run a command and quote its output verbatim (build/test/repro runners) | haiku | low |
| Locate fan-out (returns places, not judgements); fetch/extract from pages | haiku | low |
| Mechanical checks the parent re-verifies (marks, counts, lists) | haiku | low |
| Read-only recon that returns a report (structure, commands, risks) | sonnet | medium |
| Review of a lint/test-covered batch, instruction/config files, routine code | sonnet | medium |
| Code-writing from a detailed plan with a net (tests/linter/compiler) | sonnet | high |
| Code-writing with design freedom: non-trivial logic, macros, engine, concurrency | opus | high |
| Review of macro-heavy / concurrency / engine-critical / no-net code | opus | high |
| Finding verification (one skeptic over aggregated findings) | opus | high |
| Analytical judgement (blast-radius verdicts, design decisions) | opus | high |

On overlap, the stronger row wins: a lint-covered batch that is ALSO
macro-heavy / concurrency / engine-critical goes to opus — a style/structure
linter does not mechanically guard against races or codegen bugs.

- **haiku** only where its output is quoted, located or extracted — never
  where it must decide, design or judge correctness.
- **Hard task → raise opus effort first** (`xhigh`, then `max`), not the model:
  opus at `max` still costs less than fable. **fable** (the most capable, most
  expensive tier) only when the user asks for it; never chosen on your own.
- **effort**: `low` for runners/locators, `medium` for recon and routine
  review, `high` for writing code and real judgement; `xhigh`/`max` only when
  the user asks or a `high` attempt already failed on the same task.
- A model rule is a hypothesis about quality: when a cheaper tier returns
  something the parent cannot use, rerun that task one tier up and note it.

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

## Lifecycle

- **Sync vs background is an explicit per-spawn DECISION — always pass
  `run_in_background`.** ONE spawn whose result gates your next step →
  ALWAYS `run_in_background: false`; backgrounding it buys nothing and
  costs an idle turn + a wake-up round-trip. A small batch needed
  all-at-once → sync too (all calls in one message). Background ONLY
  when completions are consumed one-by-one as they finish (rolling
  window over a queue) or you genuinely do other work meanwhile.
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
- **A worktree COMMIT is itself an interim artifact until the agent's
  terminal report.** A clean tree + a plausible commit can still be
  AMENDED — an agent's internal review pass may find real bugs and
  rewrite the tip (same message, new SHA). Merging at first sight of the
  commit ships the pre-review version. Rule: cherry-pick/merge only after
  the agent's terminal report (or confirmed session end), and re-read the
  branch tip AT merge time — never from an earlier observation; after
  merging, diff the merged SHA against the SHA the final report names.
- Use SendMessage (agent ID or name) to continue an existing agent with its
  context intact — don't respawn for a follow-up question. **But SendMessage-
  resume of a COMPLETED agent is always background** — that path has no
  `run_in_background: false`, so it cannot honour the "one gating spawn →
  sync" rule: you send, then idle-wait for a wake-up. So when the follow-up
  gates your next step, decide by SIZE, not by "an agent already has the
  context": a small, already-precisely-diagnosed fix (≤~30 lines — the same
  threshold as tiny-edits-stay-inline above) → edit it inline YOURSELF; the
  background round-trip costs more than it saves, and repeating it becomes
  spawn-one-and-wait, the exact anti-pattern the sync rule forbids. Reserve
  SendMessage-resume for a LARGE or coupled follow-up where re-establishing
  the agent's own context is worth the background wait — and then don't idle:
  it's the rolling-window case (do other work, expect the wake-up).
- **A subagent's result is its LAST message, not everything it did — a
  multi-section brief can come back truncated.** An agent that worked
  through a staged brief (e.g. several correctness sections then a final
  security pass) may report only the final stage; earlier sections it
  wrote mid-run are lost from the result even though the work happened.
  Tell: the report answers only one axis of a multi-axis brief. Fix:
  SendMessage the SAME agent to emit the missing sections — its context
  is intact and returns instantly; respawning re-does the whole analysis.
- **A review/verification agent running empirical probes (revert a hunk, rebuild, restore) MUTATES the shared tree — a build racing mid-probe compiles the probe state, and the parent sees phantom regressions** (failures in a suite that was green minutes earlier) plus mtime churn on files it never touched. Debugging chased a nonexistent regression until a COLD rebuild (delete the built artifact, rebuild) restored truth. Rule: constrain such an agent READ-ONLY when the parent keeps building/testing the same repo — no source writes, no rebuilding shared artifacts; an agent that genuinely needs mutation probes needs an isolated COPY of the repo (worktree isolation can point at the wrong repo when the target repo differs from the session root — an explicit copy is safer), or the parent pauses its own builds/tests until the agent completes.
- **A background measurement agent reads the WORKING TREE — editing while it runs fabricates its result.** A before/after measurement delegated to a background agent (a lint report diff, a benchmark, a corpus sweep) samples whatever state happens to be on disk at the moment each of its arms runs; keep editing source in the same tree meanwhile and the output stays well-formed and plausible — an "after" arm can report findings that belong to a temporary experimental edit (mutation testing, a stubbed function, a reverted gate), reading exactly like a regression the change introduced, with nothing in the report marking it as sampled mid-edit. Tell: a measurement agent is in flight AND edits — including deliberately temporary ones — are landing on files in its scope. Rule: serialize the two activities, measure or mutate but never both at once; build any needed baseline arm in a throwaway isolated copy so the agent never depends on the live tree's current state; re-run a suspicious result on a quiescent tree before believing or reporting it. (E.g. a diff reported new warnings on a helper's parameters that were genuinely unused only during a mutation applied and reverted while the agent ran — a rerun on a quiet tree came back byte-identical.)
- **Worktree-isolated agents fork from the session-start HEAD, not the current branch tip.** Commits you make mid-session are NOT in a later-spawned agent's worktree base — the agent may see stale code, wrongly conclude your work "was never merged", or produce patches that conflict. Rule: COMMIT each phase before spawning the next dependent wave; when a wave's base is already stale, merge its patches with `git apply --3way` and expect to hand-reconcile files several agents touched. Also instruct agents to report their base commit (`git log --oneline -1`) so staleness is visible. One more trap in that merge flow: `git apply --3way` STAGES everything it applies — a later `git add <subset> && git commit` silently commits the WHOLE staged index, not your subset (the tell: the first chunk commit's stat lists every merged file and later chunk commits say "nothing to commit"). Run `git reset -q` to unstage all before building chunked commits, and if rebuilding botched history, soft-reset to the true pre-merge base, never to a mid-wave commit.
- **Identical-change auto-merge is silent and WRONG for shared counters.** When every parallel branch applies the same textual bump to a shared aggregate (a hard-coded count assertion, a registry size), merging them produces ONE bump, not N — git treats identical hunks as already-applied, so no conflict fires. Loud conflicts appear only where branch texts differ (distinct list-append entries). Rule: after merging parallel branches, recompute every shared aggregate as base + Σ(per-branch deltas) and fix it explicitly; the tell is a merge that conflicts on the append-list files but is suspiciously clean on the counter files every branch touched.

- **Is a background agent alive / stalled?** (watchdog kills, transcript mtime, symlinked output paths, macOS `date -r`, whole-fleet death) → Read references/agent-liveness.md before concluding anything.

## ALWAYS Delegate to Subagent

Build, run, and test operations → subagent — BUT a build/test that streams
nothing for minutes will trip the stream-watchdog and kill the agent (see
Lifecycle): the agent must run it via its own `run_in_background` + poll, or
keep such heavy-but-silent runs inline where the orchestrator has no watchdog.
Interactive live-app debugging sessions (display-tree queries, clicks,
screenshots — e.g. via a debug bridge, driver, or browser MCP) → subagent.
Heavy output (compilation logs, long files, web content) → subagent with **precise extraction prompt** ("extract only X"), never dump raw output into main context.
Preserves main context for decision-making.

## Spawn Mode: Analytical vs Light (mandatory)

A spawned subagent runs **flat by default** — no workflow session, no
`load_skills` gate, no skills. Classify every spawn:

- **A code-writing `subagent` worker does NOT review itself** — its
  coding/bug-fix review stops at lint + its own intent re-read. YOU own
  the fresh-eyes review of its diff: review it once, after its report
  (never assume "the worker already reviewed").

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
  judges. Bash: run commands FOREGROUND with an explicit timeout sized
  to the command; background ONLY for never-exiting processes (servers,
  watchers) or runs genuinely over the 10-min foreground ceiling.`

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
- **After a session restart / compaction, "the agent is still running" is
  a claim to verify, not to inherit.** A summary or system note that says
  an agent is in flight can describe a worker that died with the old
  session — and a queue's `[>]` mark then reads as live while nothing
  advances. Tell: its output-file path no longer exists, the processes its
  current step needs (build, test runner) are absent, the last commit is
  long past. Check those before telling the user it is working or ending
  the turn to "wait for it"; dead → resume it via SendMessage at once.

Also **time-box research inside implementation agents**: an agent told to
verify facts can rabbit-hole into open-ended web verification. Say "apply
the plan text as given; quick checks only; list unverified items in the
report instead of digging."

- **A fresh queue authored from a finished campaign's plan file inherits
  its FINAL state** — completed marks and result SHAs pattern-match into
  the new file as fabricated history. Write every new queue item
  unmarked; after writing any plan/queue file, re-read just the state
  marks before using it.

## When the Window Changes

- **A new agent window invalidates the dispatch plan.** A loop written as
  strictly sequential under "one agent" keeps running one at a time after the
  user raises the window — the orchestrator then hand-runs parallel work
  around it, or idles slots. On every window change, re-derive which pending
  items are independent (disjoint files/packages and no shared owning
  component) and move the dispatch onto a rolling window with a
  deterministic admission check, instead of patching it by hand.
- **A change that rewrites the merge tool itself must be merged by its own
  new version.** The merge command runs from the main tree's built binary,
  i.e. the OLD version; a slice that removes or renames what the old merge
  step expects fails mid-merge. Land such a slice with the branch's own
  freshly built tool (or by hand), and verify the merged tree equals the
  reviewed tip.

## Orphan Cleanup

After collecting all reports: `sessions` → `abort` any orphaned child
`subagent` sessions. A child that errored or was interrupted leaves an
active session behind, which blocks the parent session's completion.

## Rules

- **In bug/gap briefs, state the SYMPTOM and its evidence — never assert your assumed root cause as fact.** A worker that trusts a wrong stated mechanism builds a duplicate of machinery that already exists (or patches the wrong layer). If you must name a suspected mechanism, label it "hypothesis — verify first"; a good worker's re-diagnosis regularly overturns the orchestrator's guess (e.g. "no wrap policy for this construct" turned out to be an off-by-one in an existing fit probe)
- **On a branch with uncommitted work, a review brief MUST name the baseline the user's report is against.** A reviewer told only "review the diff" runs `git diff HEAD`, so it compares the fix to the last COMMIT — while the symptom the user photographed is the WORKING TREE, whose uncommitted changes may already contain the regression the fix repairs. The verdict then reads as authoritative and is wrong in the most convincing way available: it calls a real fix a "semantic no-op" because the committed code and the fixed code happen to agree. Say which state the report describes, and check a "no-op" claim against that state before you act on it
- **Review subagent code against loaded skills** — subagents fix problems mechanically (compile errors, type mismatches). Their fixes compile but may violate style rules (missing types, verbose patterns, redundant code). ALWAYS read each file the subagent changed and apply loaded preference/lang skills before considering done
- **Verify lifecycle edits** — after subagent touches start/stop/dispose: (1) every `removeEventListener` in stop/dispose has a matching `addEventListener` in `start`, not just constructor (listener orphaning on restart); (2) new init code is inside the correct conditional block, not placed before a guard where it runs in wrong state
