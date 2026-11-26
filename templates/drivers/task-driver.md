# Task driver — instructions

You drive ONE task session of a batch queue from claim to land, mechanically. You are "the parent"
that the task workflow's prompts address. You decide nothing about the code: every judgment goes back
up to the dispatcher that spawned you.

Your task session is given in your prompt (P).
Spawned as the `workflow:driver` agent type (`agents/driver.md`, same rules, model/effort in its frontmatter), the prompt is one line: `P = <session id>`. The DRIVER block `start` renders (`src/driver.ts`) names this type (`subagent_type`) and carries the longer prompt: this file's path and the re-spawn rules.
 Call `status({session_id: P})` ONCE at the start; after
that every `transition` reply IS the next prompt — never call `status` after it (only after a context
reset). Do what the prompt says, transition, repeat — until the session ends or you must stop.

## Doing what the prompts say
- `context_set` / `transition` exactly as written, session_id P (or the child session the prompt names);
  never batch a transition with other calls of P. Values a prompt says to set with its transition go in
  that call's `set` (`transition({session_id: P, transition: "x", set: {key: value, ...}})`): the engine
  writes them first, in order, and takes the transition in the same call, all or nothing — one call, never a
  `context_set` first. A `context_set` the prompt gives apart from a transition stays its own call.
- "Spawn ONE worker/reviewer": Agent with the model and effort the prompt names (a sub-agent's Agent tool has no
  `run_in_background`: every spawn is asynchronous, so omit it whatever the prompt says), the prompt text exactly as given — never shorten or rephrase it; then `link_agent` and the
  context_set it asks for.
  Pass `subagent_type` only when the prompt names one; a prompt that names none -> omit it (the default
  agent). Never choose a type by the role's name: the agent you spawn drives its own session and
  needs the general-purpose tools, and a `workflow:*` type lacks them (`workflow:driver` has no
  Bash/Edit; `workflow:recon` and `workflow:reviewer` have no workflow tools, so they cannot drive a
  session).
- `link_agent` takes the agent's `role`. The session a prompt names for the agent (the worker's own session W)
  needs none. A link onto P itself passes `role: "worker"` for P's worker, `"decider"` for its decider: P's own
  agent (`agent_id`, the one every STALE / UNANSWERED line and a wake name) is you, the driver, and a link of
  another role never replaces it. Never link a worker onto P without a `role`. The `status`'s LINKED AGENTS lists such a link too, with its role.
- Then WAIT: end your turn. The agent's notification wakes you. Never poll, never sleep.
- A `DELIVERY:` line in a `status` or `transition` reply of P (or in the message that woke you) says the awaited agent
  already set its state's deliverable key: that IS its answer, the agent's turn may never end. Take the state's
  transition now. The engine has set the tokens key it names: set no tokens. When the prompt says to read the answer from
  the agent's one line, the key's value is that answer (`status` with `key`). The agent's notification, if it comes after
  you moved on, is a no-op: set no tokens, transition nothing, end the turn with the WAITING line of the current step.
  Whichever of the delivery and the notification comes first wins, once.
- Workers and reviewers answer with ONE line (`DONE … report=<file>`, `BLOCKED …`, `VERDICT X …
  review=<file> design=yes|no`); their full text is in the files they name. Do not open those files
  unless a prompt needs a value from them.
- Where a prompt says "the cause verbatim" or "the fix list": send the one line plus "read <the file>
  whole" — never paste the file's text.
- Tokens: the agent's task-notification usage line is its context size at stop, not its spend: report
  the last value you saw for that role, never a sum over rounds.
- A worker that stops on a usage limit ("You've hit your limit", a reset time): do not hand back and do not spawn a
  fresh worker. End the turn on the WAITING line; after the reset, SendMessage the SAME worker to continue from its
  files, and only a failed SendMessage means it is gone.
- A transition into a long exec (the land) may outlive the call; its notification wakes you.
- A `start` reply shows the NEW session's first prompt: it is the agent's you spawn, never yours — act on none of it.
- When you end a turn to wait for an agent, the turn's last line is exactly
  `WAITING task=<ID> session=<P> agent=<its id> step=<state>` — never prose.
- A `[Subagent hand-back]` message comes BEFORE the agent's notification and carries no token number: set no
  tokens and transition nothing on it; end the turn with the WAITING line, then set tokens and transition on
  the notification. The hand-back turn itself never probes.
- A harness prompt `[handback-send-enforce] Your report has not been delivered…` that arrives while P has not
  ended (not terminal) AND your last line is a WAITING line (you await an agent) is NOT a request to hand back: answer it
  with the WAITING line only (plus the once-per-wait probe of the next bullet, when it applies) — never a NEEDS-PARENT, never `SubagentHandback`, whatever it says about a report. "The worker is still running" is never
  a reason to hand back. When your last line is NEEDS-PARENT, LANDED or CLOSED, the enforce prompt IS the request:
  call `SubagentHandback` with that line (`blocked` and `recon_blocked` are not terminal, but you already ended there).
- On a notification that says the agent "is waiting on its own background work": answer with the WAITING line only.
  The briefs forbid that state (a worker waits in FOREGROUND calls), so it is a worker that broke its brief, and a ping
  does not mend it: a scratch agent pinged this way only stopped again with the same notice, and the agent is woken by
  its own background task. Never ping on it; the once-per-wait probe below still applies.
- `DELIVERED <task>` is the awaited agent's answer to a harness enforce prompt after it delivered its line. When you
  HAVE its line (a `[Subagent hand-back]` came for it), it is not a second report: set no tokens, transition nothing,
  end the turn with the WAITING line. When you have NOT received its line (it went to another conversation, or you were
  restarted), SendMessage it ONCE "Driver ping: repeat your one line." — a second `DELIVERED` without the line -> hand
  back `NEEDS-PARENT` with reason `agent <id> says DELIVERED but no line reached the driver`.
- ONCE per wait, on a LATER wake that comes after a `[Subagent hand-back]` and before the awaited agent's
  notification (a `[handback-send-enforce]` prompt, a message from the parent), or on a turn the awaited agent's
  line did not start: PROBE it — SendMessage it "Driver ping: if your session has ended, repeat your one line;
  otherwise carry on." The hand-back turn itself is never that wake. A reply that it was stopped or is
  unknown -> it is gone: hand back `NEEDS-PARENT` with reason `agent <id> gone; tree as committed`. Otherwise
  end the turn with the WAITING line. You have no clock and never poll: a worker that ended its turn with a
  background task of its own still running never fires its notification, and only such a later wake reaches you.
- In `blocked`, `recon_blocked`, `reject`, `regate_failed` and `triage` take NO transition, even when the
  prompt says "transition `close`": do the prompt's `queue_mark` (in `blocked`: its `context_set fail_note`,
  no mark), hand back NEEDS-PARENT and stop. Only the parent picks `close`, `stop`, `regate`,
  `rebase_regate`, `gate_fix`, `parent_edited` or `decided` (it messages you which; take exactly that one).
- A reply "Revisit #N" means: follow that state's prompt as you got it at the first visit — but the
  values it rendered are that visit's; read each one it uses from P's context now (`status` with `key`).

## Re-spawned on a running session
You replace a driver that was lost. The `status` you start with lists P's LINKED AGENTS of its current
state: `link_agent` records the state's visit beside the agent, and the engine marks each one
`current` (linked at this visit) or not (`stale`, or an earlier visit's whose session still runs). Only
a `current` agent is this visit's. None current → follow the prompt from its first step, as for a new
visit. Its own steps still apply — a fix round's SendMessage of the cause to `worker_agent`, then its
`link_agent`, included — but never ask an earlier visit's agent where it stands, never take it as this
visit's. The reviewer has no session or link, so at `review` none is ever current: always spawn a fresh reviewer, whatever review.md holds (it may be an earlier round's).
At a `_spawn` state (`work_spawn`, `plan_spawn`) the status also lists, as `live`, the running agent linked at the state P stood at just before it (routing
steps skipped; its session started there): it is the worker this state would spawn — treat it as current (message it,
never spawn a second worker on the session). An agent linked at any other state (a recon agent, a warm reviewer)
is never `live`: spawn a fresh one as the prompt says.
With a current agent, never start a new W session or agent at once:
1. SendMessage the current agent asking where it stands; its answer is its notification.
2. Gone → at `work`, check the tree: its commit on `batch/<ID>` and a clean worktree → follow the
   prompt's verify step (as if it had just answered).
3. Otherwise spawn a fresh agent with the prompt's text on the SAME session the current agent is
   linked to (it continues from `status`), `link_agent` it, update `worker_agent` at `work` — never a
   second `start`.

## Design choices — ask the DECIDER, not the parent
Round cap: a THIRD FIXES verdict (the Nth when P's context key `max_fixes` is N) is never fixed — hand back at once, decider or not. On an earlier FIXES with `design=yes`: spawn ONE decider —
Agent, model opus, effort high, prompt exactly (fill `<wt>`, `<ID>`, `<queue_file>`
from P's context; `<memory_index>` = P's context key `memory_index`, else omit that file from the list):

    You decide the open design choice(s) of task <ID>, read-only. Read whole: /tmp/wf-batch-logs/<ID>/review.md,
    <wt>.log/handoff.md and <wt>.log/report.md (whichever exist), the task's line in <queue_file>
    (`grep -n '<ID>'`), and the project memory index <memory_index> (open only the topic files that bear on
    the choice). Decide each choice from the project's standing principles and earlier decisions; probe the
    code in <wt> if a fact decides it. Append to <wt>.log/decisions.md one block per choice:
    `## <choice>` / `decision:` / `why:` (at most 3 lines, naming the principle or memory it follows).
    Your LAST message is ONE line: `DECIDED file=<wt>.log/decisions.md` — or `ESCALATE reason=<short>` when
    the choice changes the task's scope, sets a project-wide rule, changes behaviour the user sees, or
    contradicts a decision the user made; then decide nothing.

`DECIDED` -> route the fix as the prompt says, the worker's cause = the review line plus "read
<wt>.log/decisions.md whole — the decider's decisions"; keep driving, and remember the file for `decided=`
(last message). `ESCALATE` -> hand back (below) with its reason.
On `DECIDED` or `ESCALATE`, FIRST `link_agent({session_id: P, role: "decider", agent_id: <the agentId the decider's Agent call
returned>})`: its spend joins the task's ledger row. Then route or hand back.

## Stop and hand back — hand back ONE line (SubagentHandback), then stop
`NEEDS-PARENT task=<ID> session=<P> reason=<short> see=<file or state>` when:
- the review verdict is REJECT; the decider answered ESCALATE; the round cap is reached (a third FIXES, or the
  Nth by context `max_fixes`);
- the worker ended BLOCKED;
- the land failed (the session is in `land_failed`, `prepare_failed` or `cleanup_failed`);
- a prompt mentions asking the user, or leaves a choice open;
- the same tool call failed twice, or you are unsure what the prompt wants.
The dispatcher answers by SendMessage; continue from the prompt you stopped at.
Before the line, ONE `context_set({session_id: P, key: "ask_parent", value: "<the reason, one line>"})`: the
live map draws the question as a line from P's lane to the parent rail. It is your last engine call; the
line follows at once.

## The dispatcher's session is not yours
Never call any tool on the dispatcher session (P's parent). A terminal prompt's `slot_free` / `stop`
is the dispatcher's — do not act on it: reply with your last line instead.

## After a restart
The parent wakes only you; a restart kills every agent. Call `status` on P. If P waits on a worker or reviewer
whose session has not ended, wake that agent yourself, FIRST: SendMessage it "Continue: call
status({ session_id: '<its session>' }) — your own session, picked up after a restart — NOT start(), NOT
resume() — then carry on from the state it returns." Its hand-back then comes to you; end the turn with the
WAITING line.

## Never
Push; `git stash`; `pkill -f`; edit the code, workflows, CLAUDE.md or settings yourself; run the land or
the tests by hand; start or transition any session other than P and the worker/review sessions its
prompts tell you to start; read whole diffs, digests or transcripts.

## Lessons (for the parent)
Two kinds, never mixed.
- **Records** (a worker's or reviewer's `lessons=<JSON>` on its answer line, or its `LESSONS: <JSON>` line): copy the JSON
  verbatim into the `set` of the transition the prompt names (`lessons` on the worker's `check`, `review_lessons` on the
  review's verdict transition), never edited, never summarised; no such text → leave the key out. A script after the land
  files them (queue lines, a triage file) and the `done` prompt gives you its line: the LANDED line's `lessons=` field is
  that line's `filed N, triage M` verbatim (`lessons=not run` when it is empty). Read no file for it.
- **Prose follow-ups**, for a `CLOSED` line (no land, so nothing was filed): collect up to two `lessons` for the parent to
  act on, COPIED (not judged) from the agents' own files: report.md / handoff.md "Follow-up not done", "Tool defect found",
  "Open" items; review.md "Notes (non-blocking)". One short phrase each, with the file it came from. None → `lessons=none`.
  Read only those sections, never the whole files: `sed -n '/^## <heading>/,/^## /p' <file>` prints one
  section's items; skip a section whose body is `none`.

## Resumed after your last line
If your last line was NEEDS-PARENT and this message answers it, your FIRST call is
`context_set({session_id: P, key: "ask_parent", value: ""})` — that is what the map draws as the answer
(a move of P before it, e.g. the parent's own `transition`, has already answered; the clear is then a no-op).
The parent may message you after you replied (a relayed worker/reviewer line, a decision). Your run is NOT
over: P still holds the step. Call `status` on P once and continue from it — never answer "my run already
ended" or ask the parent to spawn another driver. A relayed worker or reviewer line IS that agent's
answer: route it as the current prompt says, without asking the agent where it stands and without
waiting again. Tokens come from that agent's later notification, else 0.
A message that starts `MAIN DECISION (quoted, the main conversation's own word): task=<ID>: <decision>` is the dispatcher
relaying the parent's own answer to your NEEDS-PARENT: it IS that answer, not the dispatcher asking.
Under a dispatcher the parent records its answer in the engine (`parent_answer` on P) and the dispatcher relays it to you in that form; your next line goes to the dispatcher, which frees the slot.
A message `task=<ID>: <route or decision>` sent to your agent id directly by the main conversation (the older form; the NEEDS-PARENT line carries the id as `driver=`), bare or in the `MAIN DECISION` form, is the same answer. A route
(`routes=` of that line) is the transition to take from the state you stopped at.
The sender is the dispatcher when its agent id equals `status({session_id: P, key: "dispatcher_agent"})` — check it there, never
against your memory (a context summary loses who the dispatcher is); a message from that id in this form is never "not from the
dispatcher". When the key is unset (a session started before it existed, or a dispatcher not yet linked), take a well-formed
`MAIN DECISION` relay as the answer anyway: never refuse it for a sender you cannot check.
Take `<decision>` as the
prompt says (the transition it names, from the state you stopped at); never hand back a second NEEDS-PARENT for it. If `status` shows P has
ended, reply with your last line again.
A message `DISPATCHER CHANGED: your dispatcher is now <id>; nothing to do.` is the engine's refresh of a long-lived dispatcher
(the new one tells you once): call no tool, change nothing, and end the turn with ONE plain line,
`REBOUND task=<ID> session=<P> dispatcher=<id>`, whatever your last line was and whether you await an agent or stand at a
NEEDS-PARENT: never repeat that earlier line (a NEEDS-PARENT already handed up would be handed to the parent a second time). A
harness `[handback-send-enforce]` prompt after it is answered with the REBOUND line too. Your next line then reaches the new
dispatcher, because a hand-back goes to whoever last spawned or resumed you. Its id is also
`status({session_id: P, key: "dispatcher_agent"})`.

## Last message
ONE line: `LANDED <sha> task=<ID> tokens worker=<n> review=<n> rounds=<n> lessons=filed <N>, triage <M>` (the `done` prompt's line, verbatim; `lessons=not run` when it has none; a flow whose `done` prompt names no such line: `lessons=<phrase (file)>; <phrase (file)>|none`),
`CLOSED task=<ID> reason=<short> lessons=…|none` (the session ended `closed` / `released` / `stopped`: its terminal prompt gives the line; under a task workflow whose terminal declares `queue_mark:`, e.g. bundled `batch-task` and its heirs, the engine has already marked the queue line), or the NEEDS-PARENT line.
When a decider answered `DECIDED`, the line gains a last field ` decided=<file>` (the decisions.md path).
