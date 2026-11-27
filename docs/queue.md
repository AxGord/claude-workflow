---
title: Task queue and dispatch
description: The queue file, the picker, the model table and the task driver
---

# Task queue and dispatch

### Task queue — `batch`, `queue_next`, `queue_add`, `wf-queue`

**Which queue**

- Every queue tool and `wf-queue` takes an optional `queue` NAME beside `file`.
- Neither = the project's default `.claude/batch/queue.yaml`; `queue: "<name>"` = `.claude/batch/<name>.yaml`; a full `file` path (a queue of another repo) still works.
- The project is the git root of the server's cwd (a linked worktree resolves to its main checkout).
- `wf-queue [<file>|--queue NAME] …` reads the same way; `--path` prints the resolved file.
- A missing file is an error naming the resolved path, except `queue_add` (`--add`), whose first task CREATES the queue (`batch_size: 1`, `tasks: []`) and says so. It does so only when the queue is addressed by name or by default, never by a full `file` path.

**The file**

A long run of tasks is a YAML queue FILE the engine admits from — one format for every project. The top-level keys are the header (any other key is free: `wf-queue --header <key>` reads it), `tasks:` the list:

```yaml
batch_size: 3                 # the window; 0 pauses
reason: three at once         # why the window is what it is (queue_header writes both)
base: [/abs/repo=<sha>]
land_test: npm test           # run after each merge (batch-task's default land)
record_file: records.md
overlap: files                # optional: only FILE entries of `touches:` conflict (default `paths`)
land_branch: integration      # optional: the branch the plan pane's Landed tree reads (default: the repo's checked-out branch, else main)
tasks:
  - id: T1
    status: pending           # pending | running | awaiting | done | failed | backlog
    difficulty: 7
    kind: feature             # optional: bug | feature | research (absent = feature)
    touches: [src/engine]
    text: |-
      <self-contained brief>
  - id: T2
    status: pending
    model: sonnet
    repo: other-repo
    after: [T1]
    touches: [src/a, docs]
    owner: typer
    parked: true              # never admitted until unparked
    text: |-
      <brief>
    notes:
      - {from: user, date: 2026-11-07, text: later thought}
```

**Task keys**

`id, status, difficulty, kind, priority, model, effort, repo, workflow, after, touches, owner, sweep, on_end_tell_parent, owed_handed,
human_gate, human_passed, human_wait, exclusive, breaking, parked, ended, restored, added, base, text_hash, text, notes`, and `split_from`, `split_into` after `touches`.

- `human_gate: <kind>` (one lower-case word, e.g. `look`): the line lands only after its task passed a human wait (§ Human waits). `human_passed` and `human_wait` are the engine's.

- `on_end_tell_parent` is a step the parent owes when the line ends (one non-empty line, set by `queue_add` / `queue_edit`, durable in the file): `on_end_tell_parent: after this lands, tell the sibling project`.
  - Dispatcher mode: when the line reaches done or failed, the engine shows `OWED-DUE: task=<ID> status=<done|failed> sha=<landed sha|none>: <text>` in the `collect` prompt and on the next `transition` / `status` reply.
  - The dispatcher hands the parent one `OWED task=… status=… sha=…: <text>` message and then sets its context key `owed_handed` to the id; the engine writes `owed_handed: <date>` on the queue line (engine-written, refused as input).
  - The record is on the line, so a later dispatcher session on the same queue does not hand it again. Send-then-record makes it at least once: a crash between the two hands it again. A line without the field yields none.
  - `GET /api/queue` carries it as `onEndTellParent`; the pick ignores it. Without a dispatcher agent, the `collect` prompt tells the main conversation to do the step.
- `sweep` is the command a line runs over a whole tree (a lint rule's `--fix` over many files): one non-empty line, e.g. `sweep: hxq lint --rule r --fix src test`.
  - It is data for the project's workflow: the engine gives it no meaning, so it implies no `exclusive` and the pick ignores it. `queue_next` prints it as `| sweep: <command>` on the admitted line; `GET /api/queue` carries it as `sweep`.
  - A value that is empty or spans lines is refused with the key named; `""` / null removes it.
  - It is part of the brief a recon reads, so an edit that changes it rewrites `base` and `text_hash` like one of `touches`.
- `split_from: <ID>` names the line this one is a slice of (one id, a task of the queue or of its archive, never itself). A batch add with `split:` writes it on every new line; a plain `queue_add` / `queue_edit` may set it. The pick ignores it.
- `split_into: [ids]` is written on the line a batch add marked split (see `queue_add_batch`), never by a caller. The line stays `failed`, so the pick, the archive and the pane read it as they read any failed line; the key is what says it was split.
  - A line with `after: [<split line>]` waits for the slices, not for the split line: it is admitted once every slice is `done`, and a slice that was split in turn counts through its own slices.
  - The archive keeps a failed line an open line waits on, and with it the slices named by its `split_into:`, at every level.
  - A retry of a split line is refused: it would run again beside its slices.
- `ended` (`YYYY-MM-DD`) is the day `queue_mark` moved the line to `done` or `failed`. It is written there, removed by a retry or any move out of those, and read-only for `queue_add` / `queue_edit`.
- `restored` (`YYYY-MM-DD`) is the day `wf-queue --restore` brought a done / failed line back from the archive. It is written there, removed with `ended` by any move out of done / failed, and read-only like `ended`. The archive counts the line's age from the later of the two.
- `added` (an ISO time) is when `queue_add` / `wf-queue --add` wrote the line. It is never rewritten by an edit or a mark, refused as input, and absent on an older line. The replay export hides the line before it.
- `base` and `text_hash` say where the line was written:
  - `base` is the commit HEAD of the line's repo (`repo:`, else the queue's project; left out when that is not a git repo);
  - `text_hash` is the first 12 hex digits of the sha256 of its text, touches, owner and sweep (a line without `sweep:` hashes as before the key existed);
  - both are written by `queue_add` / `wf-queue --add`;
  - both are rewritten (at the HEAD of that moment) by `queue_edit` / `--edit` only when the edit changes text, touches, owner or sweep or sets `repo:` to another repo, never by a mark or any other edit;
  - both are refused as input;
  - a line written before has neither: unknown, and stays valid; an older reader ignores them as unknown keys;
  - this `base` is the line's, not the header's `base:` list of repos.

Any other key, a bad status, a duplicate id or a malformed file is refused by every read. Every write edits the parsed document in place: key order and comments stay.

**Keep the file out of git**

Keep the queue file untracked and ignored (e.g. `.claude/batch/` in `.gitignore`): a tracked queue is dirtied by the first pick, and `batch-task`'s land refuses a dirty tree (exit 3).

The land takes a merge back with `git reset --keep` only while HEAD is still that merge. Otherwise (HEAD moved during `land_test`, or local edits on the merged files) it exits 4 and touches nothing.

**The pick**

A pick fills the window (`batch_size` minus the running tasks) in `priority:` order (`urgent`, `high`, `normal` = default, `low`; file order within one priority) with the pending tasks (never `backlog` ones) that:

- are not parent-run and not `parked: true`.
  - Parent-run is `model: —`, or a repo-bound line with a `touches:` entry that git ignores in its repo: no worktree copy exists.
  - `queue_next` names the path. An entry git cannot judge, e.g. one past a symlink, is judged alone and costs only itself.
  - `queue_add` / `queue_edit` warn on such an entry and on a file entry whose directory does not exist;
- have every `after:` id done (an id-like token that names no task, or prose beside the ids, is a condition for a human: never admitted);
- overlap no running and no just-admitted task:
  - `touches:` paths overlap when one is a prefix of the other on a `/` boundary. They are compared only between tasks whose `repo:` resolves to the same repository, where a task WITHOUT `touches:` overlaps every task (it runs alone in its repo);
  - `owner:` names overlap when equal or one is a `.`-prefix, across repos too;
  - `exclusive: true` overlaps every task of its own repo (a mass move, a rename, a tree reformat); another repo is unaffected;
  - the exclusive hold:
    - A pending `exclusive: true` line that would be admitted but for running lines of its own repo (its `after:` done, not parked, not backlog, not parent-run) HOLDS that repo. A line admitted earlier in the same pass counts as running for this.
    - No line of that repo that comes after it in priority and file order is admitted while it waits (`--explain` / `queue_next explain` print `held for exclusive <ID>` on them), so the running ones end and it starts instead of waiting for an empty window.
    - A pick that admits a same-repo line ahead of such a held exclusive line prints `<ID> (<prio>) admitted ahead of exclusive <X> (<prio>)` beside the admitted list (`overtakes` in the result; no admission changes).
    - Lines of other repos are not held, and a `queue_mark … running` by hand ignores the hold.
    - The header key `exclusive_hold: no` turns the hold off (`queue_header` / `wf-queue --header-set exclusive_hold=no`; `yes` or absent = on);
  - `breaking: true` (a format or protocol change running processes cannot follow) is admitted only into an empty window, and nothing is admitted while it runs: that picker rule is the engine's. Handing the land to the parent (`NEEDS-PARENT reason=breaking land ready`) is a route the project's task workflow must carry; the bundled `batch-task` has none, so a breaking line on it lands as usual;
  - the header's `overlap: files` narrows `touches:`: only an entry naming a FILE conflicts, with the same file in another task.
    - A FILE is no glob and a regular file under the task's repo (`Makefile`, `bin/hxq`), or, when the path does not exist yet, one whose last segment holds a `.` (`src/x/Foo.hx`, `.gitattributes`).
    - A directory or glob entry (`src/query`, `src/format/Doc*`) is a hint and conflicts with nothing (`queue_add` / `queue_edit` warn for each directory entry, never refuse).
    - `overlap: paths` (the default) keeps every entry a path prefix.
    - Any other value refuses the pick (exit 2) while marks, edits and `queue_header` still work;
- name a `repo:` that resolves (absolute path; a name = the `base:` repo of that basename, else the directory of that name beside the queue's project; none = the queue's project);
- name, in `workflow:` if any, one word: the task's own task workflow (default: the dispatcher's `task_workflow`). It is started with the task's repo as `cwd`, so it may live in that repo's `.claude/workflows/` — one queue can mix tasks of several repos, each run by its repo's procedure;
  - a `kind: research` line with none runs `research-task` when `.claude/workflows/research-task.yaml` (or `.yml`) exists in its repo or in the queue's project;
  - `queue_add` / `queue_edit` say `runs workflow <name>` for it, and warn when a research line names a workflow with no `research` in its name, or when neither has a `research-task`;
- carry, in `difficulty:` if any, a whole number 1..10 (`-` = none): what the task workflow's `model_table` turns into the agents' model and effort (below);
- carry, in `kind:` if any, `bug`, `feature` or `research` (`-` or absent = `feature`): the task's type. The pick reports it (`queue_next`'s admitted line, the exec form's last column) and, for `research`, chooses the workflow (above); a task workflow reads it as `kind` the way it reads `difficulty`.

Each admitted task is set `running` under the queue's lock (`<file>.lock`, an atomic mkdir), so two picks — two tools, two processes — never admit one task. `batch_size: 0` is the pause: nothing new is admitted, running tasks finish; the pick answers `window 0 — paused: <the reason>`.

**The tools**

- `queue_next({ queue?, file?, dry_run?, explain? })` — the admitted tasks (id, model, effort, repo, workflow, difficulty, kind, priority when not normal, text). `kind` is `feature` when the task has none.
  - `explain` adds why each other pending task waits (`window full` ones fold into one summary line).
  - `explain: "all"` lists every one.
- `queue_mark({ queue?, file?, id, to, note?, from?, retry?, force? })` — the target status is:
  - `done` and `failed`: they also write the line's `ended:` (today). `done` is running→done, `failed` is running→failed;
  - `running`: pending→running. It is refused, with the reason, when the picker would not admit the line: overlap, `after:`, `exclusive`, `breaking`, `parked`. `force: "<reason>"` marks it anyway and writes the reason into its `notes:`. The window, a pause and `model: —` do not count;
  - `running` with `retry: true`: failed→running. A failed task runs again, and its `difficulty: N` becomes `N+1`, at most 10 — the answer says `(difficulty 4 → 5)`;
  - `released`: running→pending;
  - `promoted`: backlog→pending (refused for a line with no `difficulty:`);
  - `shelved`: pending→backlog;
  - any other current status is refused.

  `note` is appended to the task's `notes:` as `{from, date, text}` (`from` default `mark`). A write lands only while the file still reads as the pick read it — a hand edit in between makes it plan again, never lost.
- An unknown task key this server does not know (written by newer code) is kept on write and inert for the pick. `queue_next` / `queue_mark` name it (`unknown key priority on X: ignored by this server`); `queue_add` / `queue_edit` still refuse it in their input.
- `queue_add({ queue?, file?, task, after_id? | before_id? })` — a new task (`{id, status?: pending|backlog, …}`) after / before a task, else last. It writes the line's `added`, `base` and `text_hash` (see the task keys above). It is refused unless a pick reads it as meant:
  - a new id;
  - known keys only;
  - every id in `after:` a task of the queue and no cycle (prose beside the ids stays a manual condition);
  - a one-word `workflow:`;
  - a `repo:` that resolves;
  - a `difficulty:` of 1..10, **required on a pending line** (`B: difficulty: <1-10> is required on a pending line`; `backlog`, `parked`, finished and `model: —` lines need none);
  - a `kind:` of bug|feature|research;
  - a `priority:` of urgent|high|normal|low.
- `queue_add_batch({ queue?, file?, lines, after_id? | before_id?, split? })` — many tasks (`lines`, each as `queue_add`'s `task`) in ONE write under the lock, or none.
  - The whole list is judged as `queue_add` judges one line, and as one list: new, unique ids; `after:` naming a task of the queue or of the list; no cycle across both; `difficulty:` on every pending line.
  - A refusal names every failing line (`line 2 (S2): …`) and the file is not touched. The queue must exist.
  - The lines go in order after `after_id`, before `before_id`, else last.
  - `split: <ID>` is the split mark. That line must be `running`. In the same write it ends `failed` with `ended`, a note `split into …` and `split_into:` the new ids, and every new line gets `split_from: <ID>`.
  - Why `failed` and not a new status: every reader of a line's end (the pick's `after:` wait, the archive's kept-when-named rule, the owed step, the pane) already treats `failed` as ended and not landed. A `split` status would be a new case in each of them; `split_into:` says what happened without one.
- `queue_edit({ queue?, file?, id, set?: { field: value }, append_note?, from? })` — fields of one task, and/or a note appended to `notes:`.
  - `""`/null removes a field; a set field keeps its place, a new one goes in key order; `after`/`touches` take a list or a comma-separated string; `text` is written as a block scalar.
  - The fields are checked as `queue_add` checks them, so an edit that leaves a pending line (not parked, not `model: —`) with no `difficulty:` is refused, while a line written before the rule stays editable. The status stays `queue_mark`'s.
  - Setting or widening `after:` on a running line answers with a warning: `after:` gates only admission, so the line keeps running and its driver is not told. The warning names the dependencies not done; the edit is still recorded for a rerun. All dependencies done, or a pending line: no warning.
  - An edit of `text`, `touches`, `owner` or `sweep` that changes the brief, or of `repo` to another value, rewrites `base` (at the HEAD of the line's repo then) and `text_hash`; any other edit leaves them.
- `queue_header({ queue?, file?, batch_size?, reason?, until?, archive_after_days?, exclusive_hold? })` — header keys, under the lock:
  - the window: `batch_size: N` with `reason:` (`0` pauses; the two go together);
  - with `until: "<TASK-ID> done"` the window is temporary:
    - the header keeps the window and reason it replaced as `window_until:`;
    - the mark of that line that leaves `running` (`done`, `failed` or `released`, by `queue_mark`, `wf-queue` or the engine's own terminal mark) puts them back and says so in its answer (`batch_size 4 → 3  # …`);
    - a line already `done` or `failed`, or an unknown one, is refused (the window would never end), and so is a second temporary window while one is pending;
    - a plain window set meanwhile drops the pending revert, and the answer names it;
  - and/or `archive_after_days: N` (a whole number ≥ 1; `null` removes the key);
  - and/or `exclusive_hold: yes|no` (`no` turns off the hold of a waiting exclusive line, see the pick rules; `null` removes the key = on).
  - A window that GROWS (`wf-queue --batch-size` too) admits nothing by itself: a dispatcher at `collect` moves only on a land's `slot_free` or main's `refill`, one at `paused` only on `retry`.
    - When a live dispatcher session holds the queue (a root, not suspended session whose context names that `queue_file` and a `task_workflow`), the answer adds one line per such session: its id, its state and the exact call.
    - A dispatcher agent holds the session: `SendMessage({ to: "<agent id>", message: "lines added" })` at `collect` (only when a pick would admit lines now), `message: "retry"` at `paused` (always).
    - The main conversation driving the session itself: `transition` `refill` / `retry`.
    - At `dispatch` or `pick` the line says to send it once the session stands at `collect`; at another state, or for a shrunk window, nothing is added.
    - No hook does it: a PostToolUse hook cannot `SendMessage` an agent, and a `transition` it made would hand the next prompt to the hook instead of the agent that drives the session. The caller of `queue_header` sends.
    - A hand edit of the queue file is noticed by nothing: send the dispatcher the same message yourself.
  - One call sets the window, a key or several; a set of one leaves the other keys as they are. No other key is settable here (the rest of the header is written when the queue is made).
- Archive (no MCP tool): keeps the queue file small.
  - The header key `archive_after_days: N` (set with `queue_header` / `wf-queue --header-set`; absent = no archiving) makes every pick (`queue_next`, `wf-queue`), under its lock and before admitting, move the `done` and `failed` lines whose `ended:` is more than N days ago to `<queue>.archive.yaml` beside the queue (`queue.yaml` → `queue.archive.yaml`), appending, under the queue's lock. The line is moved whole, its text and notes unchanged.
  - A line with no `ended:` stays; a failed line an open (pending / running / backlog) line's `after:` names stays.
  - An `after:` naming an archived id is resolved through the archive (done passes, failed waits), `queue_add` refuses an archived id as taken, and `queue_mark` on one says it is archived.
  - Archive first, queue second: a crash between leaves a line in both and the next run only removes it from the queue.
  - A second run moves nothing; a dry-run pick writes nothing; the pick's summary says how many moved; a non-numeric value refuses the pick.
  - The manual form is `wf-queue <q> --archive --older-than <days> [--include-unended] [--dry-run]`. A line with no `ended:` stays unless `--include-unended`; the answer gives the count and the queue's bytes before and after.
  - A line held in both files (a crash) is archived from the queue's copy: the fresher one replaces the archive's.
  - `wf-queue <q> --restore <ID>` (CLI only, no MCP tool) moves one archived line back into the queue under the lock, whole, with its status and `ended:` and a `restored:` day (today). The next auto-archive counts the line's age from that day, so a restored old line stays N days. The order is queue first, archive second; a line already in both files loses only the archive's copy.
  - `wf-queue --convert … --into <queue>` refuses an id the archive holds, as `queue_add` does.
- All of them write under the same lock and re-plan on a changed file, so an edit never drops a status an exec set at the same moment — add and change tasks through them, not by editing the file with a script while a run is live.

**From an exec**

- `"$WF_PLUGIN_ROOT/scripts/wf-queue" [<file>|--queue NAME] [--dry-run] [--explain|--explain-all]` (also the `wf-queue` bin) prints `ID<TAB>model<TAB>effort<TAB>repo<TAB>workflow<TAB>difficulty<TAB>kind` per admitted task, and the summary on stderr. `-` = no workflow (the dispatcher's `task_workflow`) / no `difficulty:`; `workflow` is the line's own, or `research-task` for a research line of a repo that has it; `kind` is `feature` when the line has none.
- Exit codes:
  - 0: admitted;
  - 10: none, but running tasks run;
  - 11: none and nothing runs (done);
  - 12: none, nothing runs and `batch_size: 0`;
  - 2: error.
- Further forms:
  - `--done|--failed|--release|--running|--promote|--shelve <ID> [--note T] [--from W]`; `--failed|--release <ID> --if-running`: a line that is not `running` is left as it is (no refusal), which is how a pipeline's last step marks a line it may already have marked; `--running <ID> --retry`: failed→running, `difficulty:` +1; `--running <ID> --force REASON`: mark a line the picker would not admit;
  - `--header <key>`;
  - `--add '<YAML mapping>' [--after ID|--before ID]`;
  - `--add-batch <FILE|-> [--after ID|--before ID] [--split ID]` (`queue_add_batch`: a YAML list of tasks, or a mapping with `tasks:`; `-` reads stdin; exit 2 and the file untouched when any line fails);
  - `--edit <ID> [--set key=value]… [--append-note T] [--from W]` (`key=` removes);
  - `--batch-size <N> --reason T [--until "<ID> done"]` (the temporary window above);
  - `--header-set archive_after_days=N|exclusive_hold=yes|no [--reason T]` (`archive_after_days=` / `exclusive_hold=` removes the key; another key is refused; the reason is echoed, not written);
  - `--archive --older-than <days> [--include-unended] [--dry-run]`;
  - `--restore <ID>` (an archived line back into the queue);
  - `--lessons <ID> --records FILE… [--triage FILE] [--repo DIR] [--workflow NAME]` (a landed task's lesson records as queue lines and triage rows; see "Lesson records");
  - `--lessons-take [--triage FILE]` (prints the triage file and empties it under the lock, after the rows are written out: a failed write leaves them in the file).

#### Human waits

A task that needs its owner's look (a preview to compare, a decision only the user can make) waits at a state with `human:` ([Workflow YAML](workflow-yaml.md#human-wait-human)) and gives its window slot back meanwhile.

**The line's statuses**

- Entering the wait moves the line `running` → `awaiting` and writes `human_wait: {since, session, state, question, show}` on it. The window counts running lines only, so the next pick admits another line.
- The awaiting line keeps its `touches:`, `owner:` and `exclusive:` claim: a line that overlaps it still waits. `after:` it waits too: it is not done.
- Nothing else takes it: the pick admits pending lines only, and `queue_mark` refuses a mark from `awaiting`.
- With lines awaiting and none running the pick exits 10 (wait), not 11, and a dispatcher's `stalled` is refused.

**The answer and the resume**

- `answer({session_id, route, text?})` (or the dashboard's form) records the owner's answer on the session and `answered:` / `route:` on the line's `human_wait:`. Its reply names the call that wakes the dispatcher (`answered` to its agent, else `refill`).
- The next pick admits answered lines first, before any pending line, by priority, then the longest wait. Each is a row with an eighth column `resume=<session>` (`queue_next`: `resume: <session>`): the line goes `running` and its `human_wait:` goes.
- The dispatcher starts nothing for that row (`queue_next` prints it `RESUMED (running)`): it spawns the session's driver from `driver_call`. The driver stands at the wait, sees `HUMAN-ANSWER route=<r>`, and takes `<r>`.

**The gate**

- `queue_mark … done` of a line with `human_gate:` is refused until `human_passed:` is written. The engine writes it when an answer the state `passes` is taken; a new wait drops it.
- `wf-queue <q> --gate <ID>` exits 10 (and prints the kind) while the gate is due, 0 otherwise.
- Bundled `batch-task`: a reviewed MERGE goes to `look_route` (that check), then to `owner_look` (`go` → the land, `fix` → the worker with the owner's words in `owner_words`, `close` → blocked) or straight to the land.
- A line whose text asks for an owner's look (`HOLD BEFORE LAND`, `owner's approval`, `look: true`, …) without `human_gate:` gets a warning from `queue_add`, `queue_edit` and the pick. It is never refused.

**What a waiting task holds**

- The session keeps its worktree, context and stack. Its driver ends with `AWAITING task=<ID> session=<P> question=…`, which the dispatcher hands to main.
- The wait's `stop:` command (a preview server) is the session's: the pool does not count it. It runs when the session ends.
- An abort at the wait, or the suspended session's expiry, fails the awaiting line with a note.

**Migrating a project's own hold state**

- A hold that asks the parent (`ask: parent`) after a green review keeps the window slot: give it `human:` with the same routes, and put `human_gate: <kind>` on the lines instead of a flag in their text.
- Separate visit counters for the owner's rounds (an `extra_fix` beside `work`, a `review_look` beside `review`) are no longer needed: each answer starts a new round of the caps.
- A hold's preview server: start it in the exec before the wait, and give the wait its `stop:`.
- The `human_gate:` refusal comes at the `done` mark, after the merge. A land flow that does not extend `batch-task` must run `wf-queue <q> --gate <ID>` before it merges and route exit 10 to its `human:` state (as `batch-task`'s `look_route` does).
- A task's NEEDS-PARENT that only the user can answer (a permission, a taste call) and that need not keep the slot: route it to a `human:` state.

**Converting the old Markdown queue**

Converting the old Markdown queue (`- [m] ID | key: value | … |` lines under `## Tasks`) is done once:

- `wf-queue --convert <old.md> [--status S]` prints the YAML.
- `--into <new.yaml>` writes it. `--status pending` is refused, exit 2 and no file written, when a line has no `difficulty:`, as for an append.
- `--into <existing.yaml> [--status backlog]` APPENDS the old file's open (not done) lines with that status. `--status pending` is refused, exit 2 and the file unchanged, when an appended line has no `difficulty:`, as `queue_add` refuses it.
- The task keys the converter reads from a row are `model`, `effort`, `after`, `touches`, `owner`, `repo`, `workflow`, `exclusive`, `difficulty`, `kind`, `priority` and `sweep`; `sweep:` lands in the task's `sweep` key, not in its text.
- Marks map to statuses (`[-]`/`[~]` → done with a note), `⏸` → `parked`, fields before the first metadata field and later `(<who> <date>…)` fields → `notes`, the rest → `text`; a twice-used id gets a `-2` suffix.
- `wf-queue --convert <config.json> [--into <config.yaml>]` turns a JSON config (pool `config.json`, `pool-gate.json`, `read-only-commands.json`) into the YAML the engine now reads.
- A task row the converter cannot read refuses the conversion with its line numbers (a done row without an id is skipped and named on stderr).
- An append under `--into` takes the queue's lock and says how many tasks it added — none is an error.

**Migrating (do it before running the new engine):** the engine reads YAML only and ignores a JSON config, naming the command on stderr (`workflow: <x.json> is ignored …: wf-queue --convert <x.json> --into <x.yaml>`), the pool gate's shell fast path included. Convert each, then point the dispatcher's `context.queue_file` at the new queue:

```sh
wf-queue --convert ~/.claude/workflow-pool/config.json --into ~/.claude/workflow-pool/config.yaml
wf-queue --convert <proj>/.claude/workflows/pool-gate.json --into <proj>/.claude/workflows/pool-gate.yaml
wf-queue --convert <proj>/.claude/read-only-commands.json --into <proj>/.claude/read-only-commands.yaml
wf-queue --convert <proj>/.claude/batch/<name>.md --into <proj>/.claude/batch/<name>.yaml
wf-queue --convert <second>.md --into <proj>/.claude/batch/<name>.yaml --status backlog   # optional append
```

**The bundled `batch`**

The bundled `batch` drives a queue:

1. `plan_queue` (write or resume it; context `queue_file`, `task_workflow`);
2. `pick` (exec, routes on the exit code: `dispatch` / `collect` / `cross_check` / `paused`);
3. `dispatch` starts one child session per admitted line in its repo;
4. `collect` advances them on agent notifications and re-picks on every freed slot;
5. one `cross_check` of the combined diff.

The child is `batch-task`:

1. `claim`;
2. `project_prepare` (worktree);
3. `work` (one worker agent, its session linked);
4. `work_check` (exec: one clean commit on the branch; the shell-less `workflow:driver` runs no git itself);
5. `review_scope` (exec: the diff's class);
6. `review` (one `workflow:reviewer` agent, read-only, no session of its own; FIXES → `work`);
7. `project_land` (merge + `land_test` under the repo's land lock). Its exit 4 prints the repo state, and a timeout goes to `land_timeout`; `stop` goes through `stop_state`, an exec that records `repo_state`;
8. `mark_done`;
9. `cleanup`.

**From a plan.** A plan has two levels:

- A TASK can be tested, reviewed and landed on its own and leaves main green.
- A STEP cannot, or is too small to pay for its own gate, and shares its task's check, review and land.

`planning` writes a `## Tasks` table (`id`, `after`, `touches`, `difficulty`) with the steps under each task, and the plan's `## Workflow` section ends with a `Tasks: <N>` line (after the byte-exact Resume line the start hook reads).

After approval master's `route_execution` reads it:

- one task → the plan's execution workflow as before (`coding` fans independent files out itself);
- two or more → `enqueue_plan` checks every `touches` path and `after`, `queue_add`s one self-contained line per task into the project's queue (`plan-<slug>` with its window set, or the queue of a project's `batch` heir), and runs `batch` or the heir. The bundled `plan_queue` resumes the handed-over queue; the pick then decides parallel or sequential by `after` / `touches` / `owner`.

A task one of whose `touches` paths cannot be checked gets no `touches` at all (it runs alone).

`touches` is a claim the land does not verify: `project_land` is `git merge --no-ff` plus `land_test`, so a wrong claim is caught only as a textual conflict or a red test, and `batch`'s `cross_check` reads the seams.

Nothing is queued before the plan is approved. A heir of `batch` (`extends: batch` in the project's workflow files) gets the lines in its own queue with its header untouched, and a pass that fails halfway parks its lines (`parked: true`) before the plan is revised.

**A project's own procedure.** A project with its own procedure is a heir: `extends: batch` with `plan_queue` as an exec that sets `queue_file` and `task_workflow` (`context_set:`), and a task workflow of its own or `extends: batch-task` overriding `project_prepare` / `project_land`.

#### Difficulty → model and effort (`model_table:`)

Interactive workflows use it too: bundled `coding` and `bug-fix` declare an `execute` + `review` stage table (no `escalate`).

A `difficulty` set at `start` or by the plan state (`think` / `diagnose`, from the rubric below) makes their implementer and reviewer spawns use `model_execute` / `model_review` and the `effort_*` keys. Without a difficulty those keys stay empty and each prompt's prose rule applies.

Rubric, by the work:

| Difficulty | Work |
| --- | --- |
| 2 | one function |
| 3 | one owner |
| 4 | a few files at one owner |
| 5 | a new rule or command on existing parts |
| 6 | a new shared component or config key |
| 7 | cross-file typing or an unknown cause |
| 8 | a contract moving across packages |
| 9-10 | a whole-tree redesign that must be split |

+1 when the premise is a stale measurement or a hypothesis.

A task workflow may declare which agent does a task of a given difficulty, at every stage of the task (planning, doing, reviewing, verifying a fix round, fixing):

```yaml
model_table:
  stages:                                # each stage has its own rows; ascending `upto`, the last row's is 10
    plan:
      - { upto: 3, model: sonnet, effort: high }
      - { upto: 10, model: opus, effort: high }
    execute:                             # the model / effort every workflow already reads
      - { upto: 2, model: haiku, effort: low }
      - { upto: 6, model: sonnet, effort: high }
      - { upto: 10, model: opus, effort: high }
    review:
      - { upto: 10, model: opus, effort: high }
    review_verify:                       # review round 2 and later
      - { upto: 10, model: sonnet, effort: high }
    fix:
      - { upto: 6, model: sonnet, effort: high }
      - { upto: 10, model: opus, effort: high }
  escalate:                              # execute and fix move one row up per entry whose state's visits reach N
    work: 3                              # the 3rd work = the second fix round
  review:                                # overrides the review stage by the diff's class (`review_class`)
    light: { model: sonnet, effort: medium }
```

**Stages**

- `stages` is optional. A table with only `rows: [{ upto, model, effort }]` (the execute rows) behaves as before and writes no stage key; `rows` and `stages.execute` are the same thing, given once.
- The stage name is any `^[a-z][a-z_]*$` except `model`, `effort`, `step`, `reached` (they collide with the table's own keys).
- `plan`, `execute`, `review`, `review_verify` and `fix` are the five the bundled workflows give a meaning.
- A workflow adds its own for any step it spawns an agent for — e.g. a `recon` stage (`recon: [{ upto: 10, model: haiku, effort: low }]`) writes `model_recon` / `effort_recon`, which a state reads as `{{context.model_recon}}`.
- A state that reads `{{context.model_<x>}}` / `{{context.effort_<x>}}` for a stage the table does not declare fails the load.
- The ledger's `stages` records the as-run row of each stage a state spawned on (`stages_first`; a context without it: every `model_<x>` / `effort_<x>` pair).
- The bundled `batch-task` starts from values calibrated on one project (154 round-1 review findings over 39 tasks) — replace the table whole in an heir to tune it for yours.

**What the engine does with the table**

- `context_set` of `difficulty` (the claim sets the queue line's) makes the engine write these into the session's context:
  - `model`, `effort` (= the execute row), `model_step` (its row, 1-based) and `escalations`;
  - under `stages`, `model_<stage>` / `effort_<stage>` for every declared stage (and `model_reached`, the `escalate` entries reached).

  The `context_set` answer names them (`model_table: difficulty 5 → sonnet/high (row 2 of 3) [plan opus/high, execute sonnet/high, …]`), and a `model` line goes into the history. Under a table a `difficulty` outside 1..10 is refused.
- On every move into a state (a transition, an action's route, a skill gate, a pop) the rows are recomputed:
  - the difficulty's own row plus one per `escalate` entry whose state has been visited at least N times in that frame, capped by the last row;
  - for the `execute` and `fix` stages only; the other stages keep the difficulty's row;
  - a move rewrites the stage keys only when an escalation moved, so a value an agent set itself stays until then.
- `review_class` set writes `review_model` / `review_effort`: the class's `review` entry, else the `review` stage's row, else (no stages) the task's own model and effort. Under `stages` they always equal `model_review` / `effort_review`.
  - An exec's `context_set` sets it, e.g. `scripts/review-class.sh <base> <tip>`.
  - `light` when every changed path is a test or a doc: `docs/` / `specs/` at the repo root, `tests/` / `__tests__/` anywhere, `*.md` / `.rst` / `.adoc`, `*.test.*` / `*Test.*`, CHANGELOG / LICENSE / README.
  - A nested `docs/` package, a `.txt` build file, `docs/**/.vitepress/` and any script (`.ts`/`.js`/`.vue`…) under `docs/` / `specs/` are code.
  - Else `code`; doubt is `code`.
  - `REVIEW_LIGHT_PATHS` overrides the light regex, `REVIEW_CODE_PATHS` the code one, checked first.
- Escalation is per session: fix rounds, and a blocked re-entry within one session.
  - A workflow whose `blocked` state routes back to work declares `escalate: { blocked: 1 }` (its first entry already moves the row up for the work that follows).
  - No hidden state crosses sessions. In the bundled `batch-task`, `blocked` ends the session (failed), and the retry that re-runs the line (`queue_mark` `retry: true`, `wf-queue --running <ID> --retry`) raises its `difficulty:` by one in the line itself (at most 10), so the new session starts a row up — the blocked re-entry's step, visible in the queue.
  - A line without `difficulty:` is retried unchanged.
- The table is the nearest one down the session's stack, so a sub-workflow without one runs under its caller's; a heir inherits its base's table unless it sets its own whole.
- These fail the load: rows out of order, a last row short of 10 (in `rows` or any stage), a malformed or reserved stage name, an `escalate` state that does not exist, an unknown effort (`low`, `medium`, `high`, `xhigh`, `max`).

**The bundled `batch-task` table**

The bundled `batch-task` declares a stage-aware table (values calibrated on one project; see its file):

- the first worker takes the `execute` row, a fix round's worker the `fix` row (`model_fix` / `effort_fix`);
- the round-1 review takes the `review` row and a review from round 2 on the `review_verify` row;
- it escalates `execute` and `fix` on the third `work` (the second fix round: the driver then spawns a fresh worker on the new model instead of messaging the old one);
- a `light` diff's review takes sonnet/medium, overriding the review stage; there is no `code` entry, so any other class keeps the stage's row;
- a line without `difficulty:` keeps its `model:` / `effort:` columns.

The driver writes the agents' tokens to `tokens_worker` / `tokens_review`; the ledger keeps them with the difficulty, model, effort and per-stage rows, so the table is tuned from data.

#### Resume or respawn (`resume:`)

A step that wakes an agent it already ran (a fix round's worker) can let the engine choose between `SendMessage` to that agent and a fresh spawn with a handoff brief. The agent's idle time and context decide, not the driver.

```yaml
resume:                     # workflow level
  agent: worker_agent       # context key holding the agent's id
  tokens: tokens_worker     # optional: context key read when the transcript has no readable turn
  idle_minutes: 60          # optional, default 60: the prompt cache's life
  context_tokens: 50000     # optional, default 50000
  model: "{{context.model_fix}}"     # optional templates for the spawn
  effort: "{{context.effort_fix}}"
  after_respawn: "link_agent it to {{context.worker_session}}."   # optional
states:
  fix:
    resume:                 # state level
      message: "the cause: {{context.review_text}}"   # sent when resumed
      brief: "a fix round of a previous worker's branch: …"   # prompt of a fresh agent
      # never_respawn: true   # instead of a brief: always resume this step
    prompt: "{{resume}}"
    revisit_prompt: "{{resume}}"
```

- The engine decides when a state with `resume:` is entered, and renders `{{resume}}` as ONE instruction: `RESUME (...): SendMessage <agent> with: <message>` or `RESPAWN (...): do NOT SendMessage ...`, never both.
- A revisit shows `revisit_prompt`, not the prompt: a `resume:` state needs `{{resume}}` in both (or `full_on_revisit: true`), else the load fails.
- Resume when the agent's transcript changed less than `idle_minutes` ago (warm), however large its context.
- A cold agent is resumed when its context is at most `context_tokens`, and respawned above it.
- A `never_respawn` step always resumes. An unreadable transcript counts as unknown idle or context: resume.
- Context is the transcript's last turn, else the `tokens` key. `status` lists `RESUME CHOICE` with the agent, the idle minutes, the context and the reason.
- The choice is recorded on entering the state, including a sub-workflow's initial state and a workflow's first state.
- A workflow with `resume:` and no step, a step without a workflow `resume:`, and a step with neither `brief` nor `never_respawn` fail the load. A heir inherits `resume:` unless it sets its own whole.

#### The task's driver (`driver:`)

A task workflow may name the cheap agent that runs its session for the dispatcher, so the dispatcher's own (long, expensive) context spends a few calls per task instead of every transition:

```yaml
driver:
  model: haiku
  effort: medium
  prompt_ref: task-driver      # a bare name = shipped templates/drivers/<name>.md; else a path
                               # (absolute, ~/…, or relative to the session's cwd)
  agent_type: workflow:driver  # optional: the Agent call's subagent_type (this is the default)
```

**`start` of a driver workflow**

- `start` of a session of such a workflow ends its answer with a DRIVER block:
  - the exact Agent call: model, effort, `run_in_background: true`, `subagent_type` = `driver.agent_type` (default `workflow:driver`: the plugin's `agents/driver.md`, with the workflow tools `start` / `status` / `transition` / `context_set` / `link_agent` / `queue_mark` / `queue_edit` plus Agent / SendMessage / Read only, so a dispatcher that copies the block gets a driver that cannot edit code);
  - the prompt filled with the session id, `context.task`, `context.queue_file` — the session's own, else its parent's — and the instructions' path;
  - then the `link_agent` to make.
- A missing instructions file is named there as a WARNING; a bare name that is no shipped driver fails the load. A heir inherits `driver:` unless it sets its own whole.
- `start({ …, context: { task, queue_file, difficulty } })` starts the session with those context keys (`difficulty` goes through the `model_table`, outside 1..10 refused; `cwd` / `claude_code_pid` / `project` / `project_root` are the engine's: refused), so the dispatcher spends no calls on the claim's bookkeeping.
- `start({ …, reply: "id" })` answers `SESSION: <id> @ <state>` and nothing else (a `driver:` workflow's DRIVER block still follows).
  - The state's prompt and the workflow rules are left out, for a parent that starts a child only to hand its id on; the child's own agent reads the prompt with `status`.
  - Without `reply` the answer is the full prompt as before. Only the value `id` exists.

**The shipped prompts and the driver's rules**

- The shipped worker, recon and reviewer prompts (`batch-task`, and `engine-task` here) make an agent WAIT in the foreground and never end a turn with live work.
  - A sub-agent's Agent tool has no `run_in_background` and every spawn is asynchronous, so the spawn texts no longer say it.
  - A command the agent waits for runs in a foreground Bash call with the longest timeout (600000).
  - One that may outlast a call (the check behind a pool lease) is started detached with a done-marker, `nohup sh -c '<cmd>; echo $? > <logs dir>/L.done' > <logs dir>/L.log 2>&1 & echo $! > <logs dir>/L.pid`, where `<logs dir>` is the task's logs directory as an absolute path.
    - The three files go by absolute path because the shell's cwd does not persist across calls: Claude Code resets it to the project root after a call that `cd`s outside the working directories, so a relative `L.*` would land in the user's project. A `cd` is chained with `&&`.
    - It is then awaited in a chain of foreground calls of `until [ -s <logs dir>/L.done ] || ! kill -0 "$(cat <logs dir>/L.pid)" 2>/dev/null || [ $i -ge 540 ]; do sleep 1; i=$((i+1)); done` (it ends on the marker, the process's death or a timeout, never on `sleep` alone), re-issued until `<logs dir>/L.done` exists.
  - The agent never starts a Monitor for a command it waits for. When the harness moves a foreground call to the background at its timeout, it TaskStops it, or waits on it in foreground calls, before any end of turn.
  - The agent never ends a turn while something it started is alive, mid-run as well as at its last line (the harness notifies its parent for each such stop, and the stop makes a notification-only wake of the main conversation).
  - A read-only type (`workflow:reviewer`, `workflow:recon`) cannot detach or loop: the read-only gate refuses a redirect, `$( )` and `sleep`. Its brief gives only foreground calls with timeout 600000; a command that would outlast one call is not run and is named in the verdict as unverified.
  - After it has delivered its last line, the agent answers ONLY a harness `[handback-send-enforce]` prompt with the plain-text line `DELIVERED <task>` (never SendMessage to main, never the report again); a `Driver ping` that asks for its line gets the line.
- The `task-driver` (and `agents/driver.md`) omits `run_in_background` on a spawn. `DELIVERED <task>` from an agent whose line it holds is no report; from one whose line it has not received, it gets ONE "repeat your one line". A notice that the agent waits on its own background work (a broken brief, not a normal state) gets the WAITING line only, never a ping: a scratch agent pinged on it stopped again with the same notice.
- It probes a WAITING agent once on a later wake (an enforce prompt, a parent message) that comes after the agent's hand-back and before its notification, never on the hand-back turn itself; the driver has no clock.
- The shipped `task-driver` instructions (a message after its last line means P still holds the step: `status` on P once and continue):
  - one `status` at the start; after that every transition reply is the next prompt;
  - spawn the prompts' agents exactly as written and wait for their notification;
  - hand back with one line `NEEDS-PARENT task=… session=… reason=… see=<file>` on:
    - a REJECT;
    - a FIXES with `design=yes` whose decider answered `ESCALATE`: the driver first spawns a fresh opus decider that reads review/handoff/report, the task line and the memory index named by context key `memory_index` (optional: the dispatcher `context_set`s it and passes it into each task start beside `queue_file`), appends `decisions.md` in `<wt>.log` and answers `DECIDED file=…`;
    - the third FIXES (or the Nth by context key `max_fixes`) with or without a decider;
    - a BLOCKED worker;
    - a failed land;
    - any open choice;
  - finish with `LANDED <sha> task=… tokens worker=… review=… rounds=… lessons=filed N, triage M` (the `lessons_file` step's line, verbatim; `lessons=not run` when it has none) or `CLOSED … lessons=<phrase (file)>; …|none` (up to two follow-ups COPIED, not judged, from the agents' files); a decided choice appends ` decided=<file>` for the dispatcher to audit;
  - copy a worker's or reviewer's lesson records verbatim into the `set` of the transition that follows its answer (see "Lesson records").

**Agents' output files**

- Agents' outputs are files. In bundled `batch-task` the worker writes `report.md` (and `handoff.md` when it stops unfinished) in the task's log dir `<worktree>.log` (beside the worktree, kept after cleanup).
- The reviewer is spawned as `workflow:reviewer`. Its Write tool is limited to a `<task>.log` / `<task>-logs` directory in scratch space, which the log dir beside the repo is not, so its `review.md` is `/tmp/wf-batch-logs/<ID>/review.md`, and it ends with a `SubagentHandback` call instead of following a session.
- Each answers with ONE line naming its file (`DONE <sha> report=…`, `BLOCKED …`, `VERDICT MERGE|FIXES|REJECT … review=… design=yes|no`). A fix round sends that line plus "read `<file>` whole", never the text.
- The spawn prompts also say once that a transition reply IS the next prompt — never `status` after it.
- The files hold named sections the driver copies as `lessons`:
  - `report.md` / `handoff.md`: `## Follow-up not done`, `## Tool defect found`, `## Open`;
  - `review.md`: `## Notes (non-blocking)`;
  - a fix round or a later review carries the previous file's items forward.
- Bundled `batch` `collect` turns each prose lesson of a `CLOSED` line into a queue line, a placement by the `knowledge-placement` skill or nothing; a `LANDED` line's records are filed by the script (see "Lesson records").
- Records (`lessons=<JSON>` on an answer line) are the other lesson channel, below; the sections above are the prose a `CLOSED` line still copies.
- The rendered call is also kept in P's context as `driver_call`: after a restart or compaction `status({session_id: P, key: "driver_call"})` re-spawns the driver (bundled `batch` `collect` says so).

**Lesson records**

A landed task's lessons are filed by a script, not read by the dispatcher on every land.

- The worker and the reviewer of `batch-task` (and of the engine's own `engine-task`) may end their answer with records. In `batch-task` the one-line answer gains ` lessons=<one-line JSON>`. In `engine-task` the final message gains a line `LESSONS: <JSON>` (the reviewer's goes just before the verdict line). The shape is `{"lessons":[{"id","kind","touches","repro","text"}]}`.
- The driver copies each JSON verbatim into the `set` of the transition that follows the answer: `lessons` on the worker's `check`, `review_lessons` on the review's verdict transition. A round that sends records replaces the key; one that sends none leaves it.
- After the land, the `lessons_file` exec (between `mark_done` and `cleanup`, `station: false`) writes the two keys to `<queue dir>/../backups/slice-logs/<ID>/lessons.json` and `review-lessons.json`, then runs `wf-queue <queue> --lessons <ID> --records <both>`. The context keys are the truth: the files are rewritten from them each run.
- What each `kind` becomes:
  - `unverified`: a `backlog` line, priority `low`;
  - `arm-rot-on-base`: a `pending` line, priority `high`, difficulty 4;
  - `reproduced-on-real-tree`, `loss`, `process`: a row of the triage file.
- A filed line carries the `repo:` and `workflow:` of the task it came from. The `touches` are checked against that same repo: the origin line's `repo:`, and `--repo` only when the origin line is gone from the queue (with an origin line `--repo` changes neither the check nor the filed `repo:`). Its text is the record's text and a `Repro:` line.
- A record the script cannot file is never an error: it becomes a triage row that names the reason. The reasons:
  - a `kind` that is none of the five; an `id` outside `[A-Za-z0-9._-]+`; an empty `text` or `repro`;
  - `touches` empty, over 8 entries, a glob, a `..` or absolute path, a directory, or a file the task's repo lacks and that is not marked `path (new)` (the check runs against that repo);
  - an id a queue line or the archive already holds;
  - a duplicate of an open line: the same brief of 30+ characters, or the same files and a shared backticked name;
  - a refusal of the queue itself, such as a workflow name it rejects.
- The triage file is the flag `--triage`, else the header key `lessons_triage:` (relative = beside the queue), else `<queue dir>/../backups/slice-logs/lessons-triage.txt`. It holds a block `== <ID>` per task, one row per record: `id [kind] reason :: text :: repro :: touches`.
  - The dispatcher reads it in a batch, every `lessons_every` lands and before a curator run, with `wf-queue <queue> --lessons-take [--triage FILE]`: it prints the file and empties it under the lock a land's append takes, so a row appended meanwhile is neither lost nor read twice. The file is emptied only after the rows are written out, so a closed pipe or a killed call loses none. Never empty it by hand.
- The command prints `lessons=filed N, triage M` (plus `, already K` on a rerun, plus ` triage_file=<path>` when M > 0, so the `LANDED` line that reaches the main conversation names the file) and exits 0 whatever the records hold; 2 is a usage error or an unreadable queue. A missing or empty record file is no records. An unparseable one is one triage row with its text.
- A rerun files nothing twice: a record whose id is already a line with the same text counts as `already`, and a triage row the task's block already holds is not added again.
- The step never fails a land. Any failure (the command, an unwritable directory, a timeout) prints `lessons=not run` and `cleanup` runs. A task that does not land (`CLOSED`) files nothing: its follow-ups stay prose in the driver's line.
- What stays with a project: a list of private names to scrub from a record before it is filed, and any check against its own tree beyond `touches:`. It runs `wf-queue --lessons` from its own `lessons_file` override, or checks the filed lines afterwards.

**`link_agent` under a driver parent**

- Under a parent of a `driver:` workflow (its states run one agent per visit) `link_agent` records the parent's step beside the agent (`agent_step`: its workflow, state and that state's visit).
  - Any other parent — a dispatcher whose `dispatch` adds an agent per visit — records none: its agents are never marked stale nor skipped.
  - The ledger's per-agent spend is independent of this: every `link_agent` call is also recorded with its time, the parent's state and that state's stage in `agent_links`, under any parent.
- `status` of the parent lists `LINKED AGENTS at <state> (visit N)`: each child agent linked at the current state — `linked at visit N → current`, or `linked at visit 1, now visit 2 → stale` (the agent's session ended; an earlier visit's agent whose session still runs is named so).
  - The non-driver agents linked onto the parent itself at this state (`role: "worker"` / `"decider"`) are listed too, so a workflow whose worker has no session of its own shows one.
- At a `_spawn` state (`work_spawn`, `plan_spawn`) the running agent linked at the state the parent stood at just before it is also listed. Routing steps such as an exec `plan_route` are skipped: the agent's session started at the state before them. The line reads `→ live (its session still runs): SendMessage it, spawn no second agent`.
  - A worker linked while the parent stood at `work` is still the one the spawn state would start.
  - A recon agent or a warm reviewer linked elsewhere is never listed.
- A driver answers a harness `[handback-send-enforce]` prompt that arrives while its session has not ended with the WAITING line only while its last line is a WAITING line, never a hand-back. When its last line is NEEDS-PARENT, LANDED or CLOSED the prompt is the request and it calls SubagentHandback with that line.
- A re-spawned driver takes only a `current` agent as this visit's, so no prompt renders a visit key: a fix round that SendMessages the same worker calls `link_agent` again, which re-records the step.
- After a restart, `resume`'s and the SessionStart pickup's sub-agent lines name an earlier visit's agent with no wake `SendMessage`:
  - `… — linked at its parent's review visit 1, the parent is now at visit 2: an earlier visit's agent — not woken; abort(…) once it is not needed`;
  - the same holds for one linked at another step of the parent than its current one: `… the parent is now at fix: an earlier step's agent — not woken …`.
- `driver:` on a workflow whose initial state is not a prompt state fails the load.

**Bookkeeping and the bundled `batch`**

- Bookkeeping is an exec: `mark_done` sets the task done with the landed sha as a note. When the queue header names `record_file:` (relative = beside the queue; the value is taken whole — no `# comment`), it also appends one line from the context: `- <date> <ID> landed <sha> | difficulty: … | model: …/… | review: …/… | rounds: N | tokens: worker=… review=… | report: <log dir>/report.md`.
- Bundled `batch`: `dispatch` starts each task with its context and spawns the DRIVER block as given. `collect` routes on the drivers' one-line answers (a worker or reviewer under a driver is the driver's; after a restart an orphaned line is relayed to that P's driver). A task workflow without `driver:` is still driven by the dispatcher itself.

#### The dispatcher agent (`dispatcher:`, opt-in)

The dispatcher agent is experimental: it is off unless `WF_DISPATCHER` is set, its instructions may change between releases, and it has been tried on one campaign so far.

By default the main conversation runs the dispatching session itself: every `start`, driver spawn, `link_agent`, `tasks` update and `slot_free`, in its own long context. With the opt-in a cheap agent does that, and the main conversation gets only what needs a decision.

```yaml
# bundled batch.yaml; a heir (`extends: batch`) inherits it
dispatcher:
  model: haiku
  effort: medium
  prompt_ref: dispatch-driver       # shipped templates/drivers/dispatch-driver.md; else a path, as in driver:
  env: WF_DISPATCHER                # the opt-in variable; no `env` = always on
  after: plan_queue                 # the main conversation still drives the states up to this one
  # agent_type: workflow:dispatcher # the default
```

**Turning it on**

- Set `WF_DISPATCHER=1` in the environment Claude Code starts in, e.g. the `env` block of `~/.claude/settings.json` or of the project's `.claude/settings.json`. Empty, `0`, `false`, `off` and `no` are off.
- It is an environment variable and not a queue header key for two reasons: `start` answers before any queue file is known, and the nesting depth below is set in the same place.
- Depth: main → dispatcher → task driver → worker → the worker's helper is four levels below the main conversation. Claude Code allows one less by default, so set `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=4` beside it. The DRIVER block says what the engine process sees in that variable.
- Off, nothing changes: the workflow is as if it had no `dispatcher:`, and `start` answers byte for byte as before.

**What the engine does when it is on**

- `start` of the workflow ends its answer with a DRIVER block for the dispatcher: the Agent call, the `link_agent`, the three things the agent hands back, the depth line.
- The `transition` reply that leaves the `after` state repeats the block, also through an exec chain. The main conversation builds the queue, then spawns the agent instead of acting on the `dispatch` prompt.
- The block is kept in the session's context as `dispatcher_call`; a fresh dispatcher is spawned from `status({session_id, key: "dispatcher_call"})`.
- A task session started under it carries the dispatcher's agent id as `dispatcher_agent` (refreshed when a respawned dispatcher is linked); the task driver checks a relayed `MAIN DECISION` sender against `status({session_id, key: "dispatcher_agent"})`.
- The `after` state is kept beside it as `dispatcher_after` (absent when `dispatcher:` declares no `after`): until an agent is linked to the session or the session has left that state, the main conversation still drives it and the pickup applies no dispatcher rule.
- A second `start` of a `context.task` that already runs under that session is refused and names the running session, so a dispatcher that repeats a `dispatch` after a restart starts nothing twice. When that session's workflow has a `driver:` the refusal also names its `driver_call` key; when it has none (its task is driven by the main conversation) it says so instead of naming a key the session never had.
- After a Claude restart the SessionStart pickup names the dispatcher's `SendMessage` instead of the task sessions of its `tasks` key and what runs below them.
  - A sub-session `tasks` does not name is still listed for the main conversation.
  - The exception is a task session the dispatcher started and died before it wrote `tasks` (a direct child with a `task` and a `driver_call`; a task the main conversation drives itself stays listed to it): it is the dispatcher's, and its repeated `dispatch` finds it through the refusal above.
  - Before the session has left `after` with no agent linked, the pickup is unchanged.
- The `resume` reply of that session says the same (one owner, `dispatcherSplit`): the dispatcher's `SendMessage`, then only the sub-sessions its `tasks` key does not name.
- `dispatch` delivers its full prompt on every visit (`full_on_revisit`). `status` always answers with the full prompt; the one-line `Revisit #N` is the reply of the `transition` that re-enters a state already visited.
  - A dispatcher agent that acts on the reply of the transition that brings it back to `dispatch` would otherwise have no recipe in front of it and guess the task workflow of an admitted line.
  - A project heir that overrides `dispatch` keeps the flag, or its own `revisit_prompt` carries the recipe.
- The block also carries main's duties in this mode, once (the engine tells them at the moment they apply, so main need not remember them):
  - answer a task driver by recording `parent_answer` on its task session (`context_set`), a route only from the line's `routes=`; the engine holds it until the dispatcher has relayed it to the driver, then the driver reports to the dispatcher, not to main;
  - `lines added` for the refill, `retry` at `paused` (both named by the answer of a `queue_header` that raises the window);
  - what a `CLOSED` line means: the slot is free; the engine already failed or released the queue line when the task workflow's terminal declares `queue_mark:` (bundled `batch-task` and its heirs), otherwise the line is still the main conversation's to mark;
  - a window change as `queue_header` with `until`, and what a repeated `reason=unanswered` question is.
- `status({ session_id, key: "routes" })` answers the session's transitions at its current state, `a|b|c` (`(none)` at a state with none; a context key named `routes` wins). The dispatcher reads it to put `routes=` on a `NEEDS-PARENT` line.
- A `transition` or `status` reply carries `UNANSWERED: task=<ID> session=<P> driver=<id> asked=<time> (<n> ago): <question>` for each driver question (`ask_parent`) in the session's sub-tree that no move has answered for over 10 minutes: the dispatcher's next pass shows an answer that never reached its driver, with no polling.
- A parent's answer to a `NEEDS-PARENT` is `context_set({session_id: <session=>, key: "parent_answer", value: "<route or decision>"})` on the task session; the reply names the dispatcher to wake (`SendMessage`, `answer`).
  - `collect` renders each held answer as `PARENT-ANSWER: task=<ID> session=<P> driver=<id>: <text>` (`{{parent_answers}}`) and refuses `slot_free` and `stalled` (`unrelayed`) while one stands.
  - The question is no longer repeated as `UNANSWERED`.
  - A `transition` or `status` reply of the dispatching session carries each held `PARENT-ANSWER:` line its body does not already show (a revisit's short reply).
  - The dispatcher sends the driver `MAIN DECISION (quoted, the main conversation's own word): task=<ID>: <text>` and clears the key.
  - The driver then reports to the dispatcher, which frees the slot: no driver notification reaches the main conversation.
- Unlike `driver:` it records no `agent_step` and changes no wake rule of the session's children. A workflow declares `driver:` or `dispatcher:`, not both; an unknown `after` state fails the load.

**What the agent does** (`templates/drivers/dispatch-driver.md`)

- `dispatch`: one `start` per admitted line, the task driver's DRIVER block spawned verbatim, `link_agent`, then `dispatched` with the `tasks` key in the transition's `set`. A `tasks` entry (here or in `context_set`) whose `driver=` is not the agent linked with role `driver` to that task session is refused, and the error names that id; `driver=-` and a session with no linked driver are not checked.
- `collect`: on a driver's `LANDED` or `CLOSED` line it takes `slot_free` with `tasks` and `lessons_pending` in the `set`; a `CLOSED` line for a `stopped` task also sends `LESSONS` at once.
- `paused`, on main's message `retry` (`queue_header` names it when it raises the window) it takes `retry` with no `set`; every other message at a state it does not drive stays main's `continue`.
- `collect`, on main's message `lines added` (sent when `queue_add` / `queue_edit` / `queue_mark` answer `note: a pick would admit N line(s) now…`, or `queue_header` raises the window) it takes `refill` with no `set`: the pick runs again without a land.
  - A project heir with its own `collect` must add `refill: pick` to its transitions (the state is replaced whole); without it the transition is refused and the dispatcher hands back `NEEDS-PARENT`.
  - `collect` absorbs `WAITING` lines and notifications, and relays a stray worker or reviewer line to that task's driver.
- A driver that ended with no last line (a notification that it finished, or "ended without delivering a report") is not gone: a driver waiting on its worker ends this way. The dispatcher waits while `status` shows a STALE line or a linked worker, wakes only the driver, and spawns a fresh one from `driver_call` only after a `SendMessage` to the driver fails with an error.
- A task session that ended `stopped` or `closed` has failed its own queue line (a terminal state's `queue_mark:`), so nothing stays `running` with no pipeline: its driver's last line is `CLOSED … reason=stopped: … see=state stopped`, the dispatcher frees the slot like any `CLOSED` line and sends `LESSONS` at once so the main conversation sees the stop. `stop` (which ends the whole batch session) is taken only on the main conversation's word.
- A `NEEDS-PARENT` is handed to the main conversation with ` driver=<agent id> routes=<a|b|c>` appended (the task's driver from `tasks`, the routes from `status` key `routes`). The main conversation answers THAT driver by `SendMessage`, `task=<ID>: <route or decision>`; the old form to the dispatcher is still relayed.
- Its only calls on a task session are `start`, `link_agent` and `status` with `driver_call` or `routes`.
- It decides nothing and has no `abort`, `delete`, `queue_mark`, `queue_edit` or `queue_add`.

**What reaches the main conversation**, each as one `SendMessage` to `main` while the agent keeps running (Claude Code accepts a single `SubagentHandback` per result and refuses the second, so the dispatcher never uses it for these):

| Message | When | The main conversation's answer |
|---|---|---|
| a driver's `NEEDS-PARENT … driver=<id> routes=<a\|b\|c>` line | a task needs a decision (the dispatcher repeats it once, with `reason=unanswered <n>`, when no answer moved the task for over 10 minutes) | `context_set` of `parent_answer` on the task session (a route only from `routes=`); the reply names the dispatcher to wake. The engine holds it until relayed (see above) |
| `NEEDS-PARENT task=<ID> session=<P> reason=stale …` | a task session stale for `stale_task_after` minutes (queue header, whole number of 1 or more, default 60); `collect` lists it after the `STALE:` line, handed back once per session | `status` of P, answer its driver, or tell the user |
| `LESSONS lands=<n> session=<D>` + the drivers' last lines | every `lessons_every` lands (a queue header key, a whole number of 1 or more, default 5; `queue_next` refuses another value) | judge each line as the `collect` prompt says for a landed task |
| `HANDOVER session=<D> state=<s> …` | a state it does not drive: `paused`, `pick_failed`, `cross_check`, `report` | drive that state; back at `dispatch` or `collect`, send `continue` |
| `REFRESH session=<D> old=<agent id> reason=…` | the engine found the dispatcher's context past its bound (see "Refresh") | spawn a fresh dispatcher from `dispatcher_call`, `link_agent` it (role `driver`), `SendMessage` the old one `RETIRE new=<its id>`; nothing to answer |

- A decision that still reaches the dispatcher, `task=<ID>: <decision>`, is relayed to the driver as `MAIN DECISION (quoted, the main conversation's own word): task=<ID>: <decision>`. The driver takes a decision in that form as the parent's own answer to its NEEDS-PARENT (a bare relay was once read as the dispatcher asking, and answered with a second NEEDS-PARENT).
- The lessons are copied, never judged or turned into queue lines by the agent. The last block handed is also in the context key `lessons_handed`.
- A `LANDED` line that ends `lessons=filed N, triage M` needs no reading: its records are already filed. Only the triage file's rows are judged, in a batch; the line names the file (`triage_file=<path>`) when M > 0.
- A worker's, reviewer's or driver's line that reaches the main conversation is sent verbatim to the dispatcher.
- The turn-end line `DISPATCHING session=<D> running=<n>` is plain text, never sent. A `[handback-send-enforce]` prompt is answered with that line only.
- Every end of the dispatcher's turn reaches the main conversation as a task-notification, which it ignores. No way to end a background agent's turn silently was found: it is a measured cost of the design, one wake of the main context per turn.

- A blocked bundled task has no route back to `work` (`blocked` offers `close` and `stop`): the main conversation's decision is `close`, and the line stays failed.
  - The engine's only retry of it is `queue_mark` to `running` with `retry: true` (failed to running, difficulty +1), which starts no session: the pick admits pending lines only, so no route that starts a retried line under a dispatcher is defined.
- A `close` refused by an orphan child session of the worker (its agent gone) is cleared by the main conversation with `abort` on that child; the dispatcher and the drivers have no `abort` and hand back a NEEDS-PARENT naming it.
- Rotation: the `LESSONS` line ends `rotate=due` when the lands have reached or passed a multiple of 4×N since the previous `LESSONS` message.
  - The lands are counted in the context key `lands_done`, which the agent updates in each `slot_free` `set`, not from its memory; `lessons_lands` holds the count at the previous message, so a message sent off the exact multiple still rotates.
  - The main conversation may then spawn a fresh dispatcher from `dispatcher_call` and send the old one `RETIRE new=<agent id>`; the old one only relays its drivers' late lines.
- Refresh: the engine, not the agent, decides when a long-lived dispatcher is replaced. Each wake after the prompt cache's life (60 minutes) re-writes the whole context into the cache, which cost more in one campaign than every driver resume.
  - The bound is the `refresh:` key of the workflow's `dispatcher:` block: `{ idle_minutes: 60, context_tokens: 200000 }` (both default as shown, the same two thresholds as a task workflow's `resume:`); `refresh: false` turns it off.
  - On each entry to `collect` the engine reads the dispatcher agent's last turn from its transcript.
    - Context above `context_tokens` and a wake after `idle_minutes` of silence on the session = due, whatever the agent holds. Writes under 3 minutes apart are one wake; the idle is the silence before its first write.
    - Context above it while warm = due only at a safe point (no parent answer to relay, no owed step).
    - A reading it cannot make (no transcript) is never due.
  - Due is recorded on the session (`dispatcher_refresh`) and rendered as `{{refresh}}` in bundled `collect`, and appended to the `transition` / `status` reply of a heir's own `collect`: a `REFRESH-DUE:` line and a `MESSAGE:` line the agent copies to main verbatim, then records `refresh_handed`. It keeps working until main acts.
  - Main spawns the fresh dispatcher itself (a replacement the old one spawned would be the old one's child, and report to it), links it with role `driver` and messages the old one `RETIRE new=<id>`: the old one drives nothing from then on.
  - Hand-backs go to whoever last spawned or resumed an agent, so the fresh dispatcher is shown a `REBIND:` list (`tasks` entries with an agent driver), keyed on `refresh_handed`.
    - It `SendMessage`s each driver once `DISPATCHER CHANGED: your dispatcher is now <id>; nothing to do.`.
    - The driver answers with one `REBOUND task=<ID> session=<P> dispatcher=<id>` line, never its earlier last line, so a NEEDS-PARENT already handed up is not handed again.
    - The dispatcher then records `dispatcher_rebound`, which ends the list. The task sessions already carry the new `dispatcher_agent`.
  - Everything a fresh dispatcher needs is in the session's context keys and the queue: `tasks`, `lessons_pending`, `lessons_handed`, `lessons_lands`, `lands_done`, `asks_reminded`, `stale_reminded` (`P=<idle minutes>` of each stale session handed back), `drivers_respawned` (task ids whose driver was re-spawned once); held parent answers and owed steps are the engine's. A stray wake of the old agent can start nothing twice: `start` of a running task is refused.

**Switching it on mid-campaign**

- Task drivers that the main conversation spawned before the switch keep reporting to the main conversation for their whole life (their `LANDED` and `NEEDS-PARENT` lines are relayed to it, a measured share of its cost in a 10-land trial). The engine has no way to hand a running driver to a dispatcher: switch on an empty window (no task running), or let the old ones finish first.
- A second root session on a scratch queue makes the user's plan pane show that queue: a probe should use the project's own queue or end the scratch session before looking at the pane.

Not verified by a live run yet: a `SendMessage` between two dispatchers. A live probe verified where a task driver's report goes while the dispatcher has handed back (a second task's LANDED reached the dispatcher while a NEEDS-PARENT was open) and a spawn at the fourth level.

#### Agent types

The plugin ships four subagent types in `agents/`:

- `workflow:driver` (haiku/medium).
  - It follows the task-driver rules: probe a WAITING agent once on a later wake (after the hand-back, before the notification), and answer a notice that an agent waits on its own background work with the WAITING line only, while the shipped worker, recon and reviewer prompts make an agent wait in foreground calls and never end a turn with live background work.
  - Of the workflow tools it has only `start`, `status`, `transition`, `context_set`, `link_agent`, `queue_mark` and `queue_edit`, so a driver cannot `abort`, `delete`, `create` or `modify` a session.
- `workflow:dispatcher` (experimental, haiku/medium), spawned only under the opt-in above.
  - Of the workflow tools it has only `start`, `status`, `transition`, `context_set` and `link_agent`, so it cannot `abort` or `delete` a session, nor mark, edit or add a queue line.
  - Its rules are one file, `templates/drivers/dispatch-driver.md`, which its spawn prompt names.
- `workflow:recon` (sonnet/medium) and `workflow:reviewer` (opus/high), both read-only: no Edit tool, a Write tool limited by a PreToolUse(Write) hook to the task report directory. That is an absolute path in scratch space with a `<task>.log` / `<task>-logs` directory in it, outside any git work tree, no `..`; a write inside the worktree is refused.

#### The read-only Bash gate

A PreToolUse(Bash) hook (`hooks/read-only-gate.sh`) refuses a Bash call made by those two types unless every pipeline segment starts with a declared reader, and refuses any write.

**Readers allowed**

- An ALLOW list: `ls cat head tail wc rg grep jq find git log/show/diff/status/grep/blame…` plus the config `read` list.
- `envAllowed` names the variables a `NAME=value cmd` prefix may set. Any other assignment is refused; `GIT_*`, `PAGER`, `LD_*`, `DYLD_*`, `PATH`, `BASH_ENV`, `ENV`, `IFS` stay refused even when listed.
- Also refused: `$( )`, backticks, brace expansion (nested `{{},-i}` included), `printf -v`, a variable in a command word, a variable or glob as a redirect target, a descriptor duplicate that is not the whole word (`>&1foo` writes the file `1foo`), `perl -i`, `python -c`, `node -e`, `tee`, `dd`, `cp`/`mv`, `find -delete`.

**Writes refused**

- Redirects into the tree; `git commit/add/rm/mv/stash/reset/checkout…`; `sed -i`; `rm/mv/cp`.
- Plus the project's `.claude/read-only-commands.yaml`: `{ "read": ["apq"], "write": ["apq patch", "/regex/"], "env": { "APQ_READ_ONLY": "1" }, "envAllowed": ["APQ_TEST"], "agents": [...] }`.
- Only when a segment starts with a project `read` CLI, the gate exports `env` before the command (other allowed calls pass unchanged).

**Which calls it sees**

- Measured (a real `claude -p` run with a dumping PreToolUse hook, 2026-11-07): the payload of a subagent's Bash call carries `agent_id` and `agent_type`, the main session's carries neither, so it is never touched.
- Measured again 2026-11-08 with a real `workflow:recon` agent: a write-class Bash call was refused, so the payload carries the qualified name and the gate compares `agent_type` exactly against `agents` — default `workflow:recon`, `workflow:reviewer`. A bare `reviewer` or `other:reviewer` is never matched unless a project lists it.

**The rewrite**

- For a read-only agent the read-only hook owns the single rewrite: it exports `env` (only for a project `read` CLI), then applies the pool gate to the prefixed command (`pool-gate-hook` stays out), so a wrapped heavy command still carries the variables.
- A rewrite it emits carries `permissionDecision: "allow"` (auto mode refuses an unallowed rewritten call) only when every segment is one of:
  - a project `read` CLI;
  - a default that reads no file (`cd echo printf pwd test date basename dirname true false`);
  - a stdin filter behind a pipe with no file operand (`head tail wc sort uniq cut nl tac tr grep rg`). For grep / rg the value of a value-taking flag is not an operand, so `grep -C 3 x` and `rg -m 5 x` qualify while `grep -C 3 x f` does not; never behind `xargs`, never with `--files0-from`.
- The allow skips the permission system for the whole call. So a call that needs the rewrite (a project reader's env export, a pool wrap) and carries a file-reading default (`hxq lint a.hx; cat ~/.ssh/id_rsa`, `hxq lint a.hx | xargs head`) is DENIED with `run it in its own call` — the env is neither dropped silently nor exported without an allow.

**What this gate is and is not**: it guards a reviewer / recon against ACCIDENTAL writes, not an adversary — shell parsing cannot close every path.

- The guarantees are exactly three: no Edit tool and a Write limited to the report directory, the project's CLI read-only env, and the allow list of readers above.
- Out of scope, named:
  - a reader reached by a path (`./ls`, `/tmp/x/cat` — judged by its base name);
  - a flag injected by an inherited variable (`sort $FLAGS`; an allowed call cannot set one);
  - an allowed reader that is itself scriptable;
  - a file the call reads that it should not.
- A rewrite by a hook outside the plugin (e.g. RTK's own) is not composed — Claude Code keeps one `updatedInput` — so the refusal list is the guarantee and the env is defence in depth.
- A project extends a type in its own `.claude/agents`.
- Takes effect after a Claude restart.

## Calibration report

`wf-calibration [--since DATE] [--project PATH] [--findings-key KEY] [--json]` folds `ledger.jsonl` per project × workflow × difficulty band of the FINAL difficulty (1-3, 4-6, 7-10, `-`) × stage × model/effort: tasks, review rounds (entries into the state `review`; the `review*` states summed, routing aside, only for a workflow with no `review` state), escalations, tokens, outcomes, verdicts. Lines without stage data count under stage `-`.

- Task-level figures count once per task, on its first stage row.
- `claim` counts tasks whose final difficulty is >=2 off the claim.
- `$` is the USD the line's agents spent at that stage:
  - it comes from `spend.by_agent`: each agent's spend goes to the stage its `link_agent` call was at;
  - a row with no stage — a driver linked at the dispatcher's `dispatch`, an agent only a context key names — or one the task did not run goes to a row of stage `-`, never another stage's.
- `$/task` is that over the tasks with a measured agent there.
- `-` when none is on record (a line from before the record), `>=` when an agent there could not be read or priced.
- The ledger line carries `project`, `task` (the queue line id), `visits`, `verdict`, `plan_handoff`, `agent_ids` (`agent_id_<stage>`) and `counts` (length of each context list; `--findings-key` sums one).

## Curator

The curator tidies what a project's runs leave behind: memory, the model table, the queue, unfiled lessons, skills. It is a bundled workflow, `curator`, and the ENGINE decides when it runs. A project turns it on with `.claude/curator.yaml`, or with the queue header's `curator: <path>` (relative = beside the queue; `curator: off` turns it off). No config, no curator.

```yaml
# .claude/curator.yaml
edits: propose          # default: the run applies nothing; `direct` applies what the rules below allow
high_yield: 5           # findings of one run that halve a job's interval
difficulty: 5           # the admitted line's difficulty (the workflow's model_table maps it)
priority: high          # the admitted line's priority: urgent|high|normal|low (default high)
jobs:                   # a job runs only when it is listed; `enabled: false` turns one off
  hygiene: { every: 10, require: [workflow, touches], rules: [{ match: { id: "^ENG-" }, require: { workflow: "^engine-task$" } }], forbid_words: [] }
  memory: { every: 20, dirs: [~/.claude/projects/<project>/memory], index: MEMORY.md, index_budget_bytes: 4096, new_files: 5 }
  calibration: { every: 5, workflows: [.claude/workflows] }
  lessons: { every: 10 }
  skills: { every: 20, dirs: [~/.claude/skills], transcripts: ~/.claude/projects/<project>, min_transcripts: 3 }
  docs-sweep: { every: 15, command: "ls docs", prompt: "name the pages the code no longer matches" }
```

A job's options other than these are its own: a `notes:` text is guidance the judge reads.

### When a job is due

| Job | Due when |
|-----|----------|
| `hygiene`, `lessons`, `skills`, a project job | its lands since its last run reach its interval |
| `memory` | the same, or its index is over `index_budget_bytes` (once it grew since the last run), or `new_files` memory files are new |
| `calibration` | one model row (`workflow stage model/effort`) has interval-many new lands |

- A land is a task session of the queue's lines that ended with outcome `completed`, one per task id; curator runs are not counted. With no queue, the project's own lines count.
- Each run records `found` and `changed` per job. Nothing found doubles the job's interval, up to 40. `high_yield` or more halves it, down to 5. A run recorded again (a retry) tunes nothing twice.
- The record is `<STATE_DIR>/curator/<project>/state.json`.
- `wf-curator due [--queue F | --project D] [--json]` is the dry run: each job's interval, count, last run and why it is due; exit 0 when one is.

### How a run starts

- Under a dispatcher, a pick with a free slot and a due job adds `CURATOR-<date>-<n>` (workflow `curator`, priority `high` unless the config's `priority:` says otherwise, `touches: []`). It is admitted like any line, behind a user's `urgent` line; the pick summary says `curator: added …`.
- `priority:` is one of the queue's `urgent|high|normal|low`; any other value is a config error, so the pick reports `curator: not admitted, …` and adds nothing.
- While a curator line is pending or running, no second one is added. One that failed today holds the next until tomorrow (`curator: held, …`). A config the engine cannot read keeps the run out and never fails the pick.
- Only the id shape `CURATOR-YYYY-MM-DD-N` is the engine's: a user's own `CURATOR-…` line is an ordinary line.
- With no dispatcher above it, the `transition` that ends a task session shows `CURATOR-DUE: <jobs> — start it: start({workflow: "curator", …})`, its context carrying the session's `queue_file`.

### What a run does

`claim` → `plan` and `counts` (execs, no model) → `judge` (one agent) → `judge_check` → `verify` (one independent agent, only for text edits) → `apply` → `record` → `present`.

- **Counts** are scripts: memory orphans, dangling links and the index budget; the hygiene findings; calibration rows and each `model_table` row change's like-for-like evidence (below); triage rows and owed steps; tool-error shapes seen in `min_transcripts` transcripts, and skill usage.
- **Calibration evidence.** A tuning change is a commit whose diff changes a `model_table` row (the file parsed at the commit and at its parent; a comment or other edit is none; `escalate` and `review` rows are not read).
  - Per changed stage and difficulty band, the counts hold that band's lands on each side, split into process-shape cells: the stages that spent, and no, one or several review rounds.
  - A cell gives n, the median and mean of THAT stage's `spend.by_agent` USD, review rounds, escalations and verdicts (findings with the job's `findings_key`). The whole task's spend is never compared.
  - A land that recorded the row its stage ran on goes to the side whose row for its difficulty it ran on (else `off_row_lands`); a land at a difficulty whose row did not change is in neither side.
  - A cell under 5 lands on either side is `thin`; a change of thin cells only is "not enough lands yet".
- **Judge** writes one plan: each job's `found`, edit ops (`move-index`, `move-file`, `replace`, `revert`), proposals, the user's decisions.
- **Verify** checks every `replace` before it may be applied. Moves skip it.
- **Present** hands back `NEEDS-PARENT … reason=curator report ready … see=<present.md>`: done, proposed, decisions.

### Consent and history

- `edits: propose` applies nothing: every op is a proposal.
- `edits: direct` applies moves, and a verified `replace` of a tool skill. A memory edit that changes a rule's meaning and a `preferences-*` skill stay proposals.
- Each applied op is one commit of a shadow git directory, `<STATE_DIR>/curator-history/<target>.git`, used with `--work-tree=<target>`. The target never gets a `.git`.
- `wf-curator history log|diff|revert --target <dir> [--rev <sha>]` reads it or undoes one edit; a revert whose lines changed since is refused.
- A skills edit names the error shape it should reduce; the next run measures that shape and proposes a revert when it did not go down.

The judge's and verifier's models come from the workflow's `model_table` (stages `judge`, `verify`; sonnet/high). A project tunes them in its own heir, `.claude/workflows/curator.yaml` with `extends: curator`.
