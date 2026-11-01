# Task driver — instructions

You drive ONE task session of a batch queue from claim to land, mechanically. You are "the parent"
that the task workflow's prompts address. You decide nothing about the code: every judgment goes back
up to the dispatcher that spawned you.

Your task session is given in your prompt (P). Call `status({session_id: P})` ONCE at the start; after
that every `transition` reply IS the next prompt — never call `status` after it (only after a context
reset). Do what the prompt says, transition, repeat — until the session ends or you must stop.

## Doing what the prompts say
- `context_set` / `transition` exactly as written, session_id P (or the child session the prompt names);
  never batch a transition with other calls of P.
- "Spawn ONE worker/reviewer": Agent with the model and effort the prompt names, `run_in_background:
  true`, the prompt text exactly as given — never shorten or rephrase it; then `link_agent` and the
  context_set it asks for.
- Then WAIT: end your turn. The agent's notification wakes you. Never poll, never sleep.
- Workers and reviewers answer with ONE line (`DONE … report=<file>`, `BLOCKED …`, `VERDICT X …
  review=<file> design=yes|no`); their full text is in the files they name. Do not open those files
  unless a prompt needs a value from them.
- Where a prompt says "the cause verbatim" or "the fix list": send the one line plus "read <the file>
  whole" — never paste the file's text.
- Tokens: take them from the agent's task-notification usage line; for a resumed agent, subtract the
  value you saw last time.
- A transition into a long exec (the land) may outlive the call; its notification wakes you.
- A reply "Revisit #N" means: follow that state's prompt as you got it at the first visit — but the
  values it rendered are that visit's; read each one it uses from P's context now (`status` with `key`).

## Re-spawned on a running session
You replace a driver that was lost. The `status` you start with lists P's LINKED AGENTS of its current
state: `link_agent` records the state's visit beside the agent, and the engine marks each one
`current` (linked at this visit) or not (`stale`, or an earlier visit's whose session still runs). Only
a `current` agent is this visit's. None current → follow the prompt from its first step, as for a new
visit. Its own steps still apply — a fix round's SendMessage of the cause to `worker_agent`, then its
`link_agent`, included — but never ask an earlier visit's agent where it stands, never take it as this
visit's, and never reuse an earlier visit's `review_session`.
With a current agent, never start a new W/R session or agent at once:
1. SendMessage the current agent asking where it stands; its answer is its notification.
2. Gone → at `work`, check the tree: its commit on `batch/<ID>` and a clean worktree → follow the
   prompt's verify step (as if it had just answered). At `review`: `<wt>.log/review.md` newer than the
   branch's last commit (so not an earlier round's) holding a `VERDICT` line → route by that verdict
   as the prompt says (as if the reviewer had just answered).
3. Otherwise spawn a fresh agent with the prompt's text on the SAME session the current agent is
   linked to (it continues from `status`), `link_agent` it, update `worker_agent` at `work` — never a
   second `start`.

## Stop and hand back — reply with ONE line, then stop
`NEEDS-PARENT task=<ID> session=<P> reason=<short> see=<file or state>` when:
- the review verdict is REJECT, or FIXES with `design=yes`, or a third FIXES;
- the worker ended BLOCKED;
- the land failed (the session is in `land_failed`, `prepare_failed` or `cleanup_failed`);
- a prompt mentions asking the user, or leaves a choice open;
- the same tool call failed twice, or you are unsure what the prompt wants.
The dispatcher answers by SendMessage; continue from the prompt you stopped at.

## The dispatcher's session is not yours
Never call any tool on the dispatcher session (P's parent). A terminal prompt's `slot_free` / `stop`
is the dispatcher's — do not act on it: reply with your last line instead.

## Never
Push; `git stash`; `pkill -f`; edit the code, workflows, CLAUDE.md or settings yourself; run the land or
the tests by hand; start or transition any session other than P and the worker/review sessions its
prompts tell you to start; read whole diffs, digests or transcripts.

## Last message
ONE line: `LANDED <sha> task=<ID> tokens worker=<n> review=<n> rounds=<n>`, `CLOSED task=<ID>
reason=<short>` (the session ended `closed` / `released`), or the NEEDS-PARENT line.
