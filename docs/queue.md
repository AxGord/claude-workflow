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
    status: pending           # pending | running | done | failed | backlog
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

`id, status, difficulty, kind, priority, model, effort, repo, workflow, after, touches, owner, sweep, exclusive,
breaking, parked, ended, restored, added, base, text_hash, text, notes`.

- `sweep` is the command a line runs over a whole tree (a lint rule's `--fix` over many files): one non-empty line, e.g. `sweep: hxq lint --rule r --fix src test`.
  - It is data for the project's workflow: the engine gives it no meaning, so it implies no `exclusive` and the pick ignores it. `queue_next` prints it as `| sweep: <command>` on the admitted line; `GET /api/queue` carries it as `sweep`.
  - A value that is empty or spans lines is refused with the key named; `""` / null removes it.
  - It is part of the brief a recon reads, so an edit that changes it rewrites `base` and `text_hash` like one of `touches`.
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
- carry, in `difficulty:` if any, a whole number 1..10 (`-` = none): what the task workflow's `model_table` turns into the agents' model and effort (below);
- carry, in `kind:` if any, `bug`, `feature` or `research` (`-` or absent = `feature`): the task's type. The pick only reports it (`queue_next`'s admitted line, the exec form's last column); a task workflow reads it as `kind` the way it reads `difficulty`.

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
- `queue_edit({ queue?, file?, id, set?: { field: value }, append_note?, from? })` — fields of one task, and/or a note appended to `notes:`.
  - `""`/null removes a field; a set field keeps its place, a new one goes in key order; `after`/`touches` take a list or a comma-separated string; `text` is written as a block scalar.
  - The fields are checked as `queue_add` checks them, so an edit that leaves a pending line (not parked, not `model: —`) with no `difficulty:` is refused, while a line written before the rule stays editable. The status stays `queue_mark`'s.
  - An edit of `text`, `touches`, `owner` or `sweep` that changes the brief, or of `repo` to another value, rewrites `base` (at the HEAD of the line's repo then) and `text_hash`; any other edit leaves them.
- `queue_header({ queue?, file?, batch_size?, reason?, archive_after_days?, exclusive_hold? })` — header keys, under the lock:
  - the window: `batch_size: N` with `reason:` (`0` pauses; the two go together);
  - and/or `archive_after_days: N` (a whole number ≥ 1; `null` removes the key);
  - and/or `exclusive_hold: yes|no` (`no` turns off the hold of a waiting exclusive line, see the pick rules; `null` removes the key = on).
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

- `"$WF_PLUGIN_ROOT/scripts/wf-queue" [<file>|--queue NAME] [--dry-run] [--explain|--explain-all]` (also the `wf-queue` bin) prints `ID<TAB>model<TAB>effort<TAB>repo<TAB>workflow<TAB>difficulty<TAB>kind` per admitted task, and the summary on stderr. `-` = no `workflow:` / `difficulty:`; `kind` is `feature` when the line has none.
- Exit codes:
  - 0: admitted;
  - 10: none, but running tasks run;
  - 11: none and nothing runs (done);
  - 12: none, nothing runs and `batch_size: 0`;
  - 2: error.
- Further forms:
  - `--done|--failed|--release|--running|--promote|--shelve <ID> [--note T] [--from W]`; `--running <ID> --retry`: failed→running, `difficulty:` +1; `--running <ID> --force REASON`: mark a line the picker would not admit;
  - `--header <key>`;
  - `--add '<YAML mapping>' [--after ID|--before ID]`;
  - `--edit <ID> [--set key=value]… [--append-note T] [--from W]` (`key=` removes);
  - `--batch-size <N> --reason T`;
  - `--header-set archive_after_days=N|exclusive_hold=yes|no [--reason T]` (`archive_after_days=` / `exclusive_hold=` removes the key; another key is refused; the reason is echoed, not written);
  - `--archive --older-than <days> [--include-unended] [--dry-run]`;
  - `--restore <ID>` (an archived line back into the queue);
  - `--lessons <ID> --records FILE… [--triage FILE] [--repo DIR] [--workflow NAME]` (a landed task's lesson records as queue lines and triage rows; see "Lesson records");
  - `--lessons-take [--triage FILE]` (prints the triage file and empties it under the lock).

**Converting the old Markdown queue**

Converting the old Markdown queue (`- [m] ID | key: value | … |` lines under `## Tasks`) is done once:

- `wf-queue --convert <old.md> [--status S]` prints the YAML.
- `--into <new.yaml>` writes it. `--status pending` is refused, exit 2 and no file written, when a line has no `difficulty:`, as for an append.
- `--into <existing.yaml> [--status backlog]` APPENDS the old file's open (not done) lines with that status. `--status pending` is refused, exit 2 and the file unchanged, when an appended line has no `difficulty:`, as `queue_add` refuses it.
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
  - One that may outlast a call (the check behind a pool lease) is started detached with a done-marker, `nohup sh -c '<cmd>; echo $? > L.done' > L.log 2>&1 & echo $! > L.pid`.
    - It is then awaited in a chain of foreground calls of `until [ -s L.done ] || ! kill -0 "$(cat L.pid)" 2>/dev/null || [ $i -ge 540 ]; do sleep 1; i=$((i+1)); done` (it ends on the marker, the process's death or a timeout, never on `sleep` alone), re-issued until the marker exists.
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
- Bundled `batch` `collect` turns each prose lesson of a `CLOSED` line into a queue line, a memory note or nothing; a `LANDED` line's records are filed by the script (see "Lesson records").
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
- A filed line carries the `repo:` and `workflow:` of the task it came from. Its text is the record's text and a `Repro:` line.
- A record the script cannot file is never an error: it becomes a triage row that names the reason. The reasons:
  - a `kind` that is none of the five; an `id` outside `[A-Za-z0-9._-]+`; an empty `text` or `repro`;
  - `touches` empty, over 8 entries, a glob, a `..` or absolute path, a directory, or a file the task's repo lacks and that is not marked `path (new)` (the check runs against that repo);
  - an id a queue line or the archive already holds;
  - a duplicate of an open line: the same brief of 30+ characters, or the same files and a shared backticked name;
  - a refusal of the queue itself, such as a workflow name it rejects.
- The triage file is the flag `--triage`, else the header key `lessons_triage:` (relative = beside the queue), else `<queue dir>/../backups/slice-logs/lessons-triage.txt`. It holds a block `== <ID>` per task, one row per record: `id [kind] reason :: text :: repro :: touches`.
  - The dispatcher reads it in a batch, every `lessons_every` lands and before a curator run, with `wf-queue <queue> --lessons-take [--triage FILE]`: it prints the file and empties it under the lock a land's append takes, so a row appended meanwhile is neither lost nor read twice. Never empty it by hand.
- The command prints `lessons=filed N, triage M` (plus `, already K` on a rerun, plus ` triage_file=<path>` when M > 0, so the `LANDED` line that reaches the main conversation names the file) and exits 0 whatever the records hold; 2 is a usage error or an unreadable queue. A missing or empty record file is no records. An unparseable one is one triage row with its text.
- A rerun files nothing twice: a record whose id is already a line with the same text counts as `already`, and a triage row the task's block already holds is not added again.
- The step never fails a land. Any failure (the command, an unwritable directory, a timeout) prints `lessons=not run` and `cleanup` runs. A task that does not land (`CLOSED`) files nothing: its follow-ups stay prose in the driver's line.
- What stays with a project: a list of private names to scrub from a record before it is filed, and any check against its own tree beyond `touches:`. It runs `wf-queue --lessons` from its own `lessons_file` override, or checks the filed lines afterwards.

**`link_agent` under a driver parent**

- Under a parent of a `driver:` workflow (its states run one agent per visit) `link_agent` records the parent's step beside the agent (`agent_step`: its workflow, state and that state's visit).
  - Any other parent — a dispatcher whose `dispatch` adds an agent per visit — records none: its agents are never marked stale nor skipped.
  - The ledger's per-agent spend is independent of this: every `link_agent` call is also recorded with its time, the parent's state and that state's stage in `agent_links`, under any parent.
- `status` of the parent lists `LINKED AGENTS at <state> (visit N)`: each child agent linked at the current state — `linked at visit N → current`, or `linked at visit 1, now visit 2 → stale` (its session ended; an earlier visit's whose session still runs is named so).
- At a `_spawn` state (`work_spawn`, `plan_spawn`) the running agent linked at the state the parent stood at just before it is also listed. Routing steps such as an exec `plan_route` are skipped; its session started there. The line reads `→ live (its session still runs): SendMessage it, spawn no second agent`.
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
- A second `start` of a `context.task` that already runs under that session is refused and names the running session, so a dispatcher that repeats a `dispatch` after a restart starts nothing twice.
- After a Claude restart the SessionStart pickup names the dispatcher's `SendMessage` instead of the task sessions of its `tasks` key and what runs below them. A sub-session `tasks` does not name is still listed for the main conversation. Before the session has left `after` with no agent linked, the pickup is unchanged.
- Unlike `driver:` it records no `agent_step` and changes no wake rule of the session's children. A workflow declares `driver:` or `dispatcher:`, not both; an unknown `after` state fails the load.

**What the agent does** (`templates/drivers/dispatch-driver.md`)

- `dispatch`: one `start` per admitted line, the task driver's DRIVER block spawned verbatim, `link_agent`, then `dispatched` with the `tasks` key in the transition's `set`.
- `collect`: on a driver's `LANDED` or `CLOSED` line it takes `slot_free` with `tasks` and `lessons_pending` in the `set`. It absorbs `WAITING` lines and notifications, and relays a stray worker or reviewer line to that task's driver.
- A driver that ended with no last line is pinged once, then re-spawned from the task session's `driver_call`.
- It decides nothing and has no `abort`, `delete`, `queue_mark`, `queue_edit` or `queue_add`.

**What reaches the main conversation**, each as one `SendMessage` to `main` while the agent keeps running (Claude Code accepts a single `SubagentHandback` per result and refuses the second, so the dispatcher never uses it for these):

| Message | When | The main conversation's answer |
|---|---|---|
| a driver's `NEEDS-PARENT …` line, verbatim | a task needs a decision | `SendMessage` to the dispatcher, starting `task=<ID>:`; it relays to that driver |
| `LESSONS lands=<n> session=<D>` + the drivers' last lines | every `lessons_every` lands (a queue header key, default 5) | judge each line as the `collect` prompt says for a landed task |
| `HANDOVER session=<D> state=<s> …` | a state it does not drive: `paused`, `pick_failed`, `cross_check`, `report` | drive that state; back at `dispatch` or `collect`, send `continue` |

- The lessons are copied, never judged or turned into queue lines by the agent. The last block handed is also in the context key `lessons_handed`.
- A `LANDED` line that ends `lessons=filed N, triage M` needs no reading: its records are already filed. Only the triage file's rows are judged, in a batch; the line names the file (`triage_file=<path>`) when M > 0.
- A worker's, reviewer's or driver's line that reaches the main conversation is sent verbatim to the dispatcher.
- The turn-end line `DISPATCHING session=<D> running=<n>` is plain text, never sent. A `[handback-send-enforce]` prompt is answered with that line only.
- Every end of the dispatcher's turn reaches the main conversation as a task-notification, which it ignores. No way to end a background agent's turn silently was found: it is a measured cost of the design, one wake of the main context per turn.
- A blocked bundled task has no route back to `work` (`blocked` offers `close` and `stop`): the main conversation's decision is `close`, and the line stays failed.
  - The engine's only retry of it is `queue_mark` to `running` with `retry: true` (failed to running, difficulty +1), which starts no session: the pick admits pending lines only, so no route that starts a retried line under a dispatcher is defined.
- A `close` refused by an orphan child session of the worker (its agent gone) is cleared by the main conversation with `abort` on that child; the dispatcher and the drivers have no `abort` and hand back a NEEDS-PARENT naming it.
- Rotation: from its 4×N-th land on, the `LESSONS` line ends `rotate=due`. The main conversation may then spawn a fresh dispatcher from `dispatcher_call` and send the old one `RETIRE new=<agent id>`; the old one only relays its drivers' late lines.

Not verified by a live run yet: a `SendMessage` between two dispatchers. A live probe verified where a task driver's report goes while the dispatcher has handed back (a second task's LANDED reached the dispatcher while a NEEDS-PARENT was open) and a spawn at the fourth level.

#### Agent types

The plugin ships four subagent types in `agents/`:

- `workflow:driver` (haiku/medium).
  - It follows the task-driver rules: probe a WAITING agent once on a later wake (after the hand-back, before the notification), and answer a notice that an agent waits on its own background work with the WAITING line only, while the shipped worker, recon and reviewer prompts make an agent wait in foreground calls and never end a turn with live background work.
  - Of the workflow tools it has only `start`, `status`, `transition`, `context_set`, `link_agent`, `queue_mark` and `queue_edit`, so a driver cannot `abort`, `delete`, `create` or `modify` a session.
- `workflow:dispatcher` (haiku/medium), spawned only under the opt-in above.
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
