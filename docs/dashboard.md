---
title: Dashboard and plan pane
description: The plan pane, the web dashboard with the live map, and the status line
---

# Dashboard and plan pane

## Plan pane

`/wf-plan` toggles a pane beside the chat. It refreshes every 15 s from the engine's own state: no model call, no tokens.

- The pane is a Claude Code hooks module, `hooks/plan-pane.tsx`. It needs a Claude Code that loads plugin `modules`; older ones simply have no pane.
- What it draws is `hooks/pane-view.ts`, a pure function of the engine's snapshot that the documentation site's landing draws too.

The pane's parts:

- **Plan** — for a session whose root workflow has a work queue (`context.queue_file`). Its sections, top to bottom:
  - `▶ Running n/window`: each line's pipeline state and time in it.
  - `⏭ Next`: lines whose `after:` are done, in the picker's order: priority, then file order.
    - While no line is admittable but lines run, it lists what the running ones unblock instead: the pending lines kept out only by them, in the order the picker admits them once they end.
      - GET `/api/queue` gives each such line `unblockOrder`, from the picker's own pass with the running lines done.
      - A parked, backlog, parent-run or `after:`-a-pending line is not listed, nor is anything under a pause.
    - A row of that list ends in a dim tail, what keeps it from starting: `waits: <id> (overlap)` (also `(exclusive)`, `(breaking)`), `after: <id> (running)`, `breaking`. It is cut from the picker's own refusal (`waitTail`; `/api/queue` gives it as `wait`), and cut with `…` before the id is. A line next to admit has none.
    - It has the same cap and `+N more` fold; nothing to list = `nothing ready`.
    - The priority is a coloured one-cell glyph after the id, one space after the id, never padded to a column: `⇈` urgent red, `↑` high orange, `↓` low grey, normal none and a blank cell.
    - The dashboard's plan rows use the same glyphs, and its `next:` strip lists the same unblocked rows.
  - `✓ Landed · 14d (n) · $landed · parent $P (S%) · branch`: the queue repo's `git log --first-parent` lines carrying a `Slice:` trailer, the Cost tab's 14 days. The heading's parts:
    - The log is of the branch the queue's lands target: the header's `land_branch:` when set, else the repo's checked-out branch (`git branch --show-current`), else `main`. The heading names the branch when it is not `main`.
    - A land made before the repo wrote the trailer, which git does not show, is read from the ledger's task runs that went through a `land` state in the window, of whatever workflow.
    - Such a land is read only for a line of this queue or its archive (the ledger holds every project's runs). Each slice counts once.
    - Its sha column is the commit the line's own `landed <sha>` note names (any case, the latest such note; `/api/queue` carries it as `landedSha`).
    - A line with `repo:` set lands in that repo, whose commits carry no `Slice:` trailer, so only its note names the commit.
    - A land whose notes name no sha draws `—`.
    - `$landed` is the sum of the ledger's real `spend.usd` over those lines, each line once. A line with no spend row, or only a partial one (`usd_partial`), adds nothing, and `$landed` is absent when no line is measured.
    - `parent $P` is the top-level Claude Code session's own spend recorded in the same 14 days, of the queue repo's own conversations only (ledger `parent_spend`, below). Its `project` is matched to the repo by Claude Code's project directory name.
    - `S%` is the parent's share of `$landed`, absent without a landed sum.
    - A title longer than the pane is cut with `…`.
  - A slice whose queue line is still `running` has no Landed row, whatever git or the ledger show: the land's merge commit exists before the ledger entry and the queue mark, and a row drawn then would read `? —` while the task left the running group early. The row appears when the line is marked done.
  - The Landed section is a tree:
    - One foldable `▦ DD.MM (n) <day spend>` row per day. Today is open, the older days are folded until a click; a day the person folded or opened stays so past midnight.
    - Under it, one `▰▰▱▱▱ ◆ $cost start-end sha id` row per land.
    - The difficulty bar is first on every row that has one (`?????` when unknown), then the line's kind glyph (a blank cell for a land that is not in the queue).
    - The start is the ledger's `started_at` of the line's task session, matched by its `task`, which the ledger records from the session context. It reads `?` for a land with no ledger row, and carries a `DD.MM` prefix when the run began the day before.
    - Lands of other repos do not appear: the list is the queue repo's log.
    - Each section and day folds on a click.
    - A day's spend counts a failed or closed line only when its latest run ended on that very date (not the same `DD.MM` of another year).
    - The status band's `✓ n` still counts the last 24 hours.
  - **Cost.** Each Landed and Failed row carries `$cost` right after the kind glyph (the difficulty bar stays first).
    - It is the ledger's real `spend.usd` summed over every task run of the line (`slice-pipeline` / `engine-task` rows with a `task`). When a run's sum left an agent out (`usd_partial`) and every run has a figure, the row draws the sum as a lower bound, `≥$17.40`; it is not added to a day, the Landed heading or the Failed header.
    - A line any of whose runs recorded no spend, or that has no ledger row, shows `—`, never `$0.00`.
    - A failed row reads the same source as the Failed header: the whole ledger through `/api/ledger-rows`, not the 30-day `ledger-recent.jsonl`. So a line whose runs are older than 30 days shows its cost, and the counted rows add up to the header's total.
    - A line with a run of no recorded spend, in any window, shows `—`.
    - A land found in git whose task ran in a workflow other than those two (a sibling project's own task workflow) draws its difficulty, start and cost from the ledger row of its landed run. So a Landed row is never blank beside a ledger that knows it.
    - A figure is `$1.23` under $100, whole dollars above, right-aligned to the section's widest, and never cut: in the two-line form it is on the first line and the id is cut before it.
  - **Day sums.** A day row carries the day's sum: its landed lines plus the failed and closed lines whose latest run ended that day.
    - A line is counted once; `closed` = completed without a `land` state, as the Cost tab reads it.
    - The row says what it includes: `▦ 07.11 (3 landed) $14.75 incl. 2 failed, 1 closed`. The count is of the rows under the day, and `landed` is added when the sum covers lines that are not rows.
    - A day with no measured line reads `—`.
    - A line's whole cost (all its runs) sits on one day of the sums: the day it landed, or for a failed or closed line the day its latest run ended. A run on an earlier day adds nothing to that day.
  - `✗ Failed (n)` follows, folded until a click.
    - It lists the `failed` lines that ended in the last 2 days (queue_mark's `ended:`; `n` and the header's `failed` count are of these), newest first.
    - Then comes one dim row `▸ +N older` that opens the rest; a line with no `ended:` counts as older.
    - A row reads `bar kind $cost id DD.MM reason`. The reason is the first line of the line's last note (`no note` without one), cut to the pane body width. The date is that note's (`date unknown` for a line with no dated note, listed last).
  - The Failed heading is followed by `· $41.20 (parent $6.10)`:
    - the ledger's `spend.usd` of every run of the `n` lines, plus the `parent_spend.usd` of those rows;
    - a row nested under a row of the same line, by `parent_session_id`, adds only its parent spend: the parent row's `spend` already covers it;
    - `· k not in the ledger` for the lines with no row anywhere in the ledger, which add 0;
    - `· k unmeasured` for the lines with a run that recorded no spend or only a partial sum. A line is measured whole or not at all: they are left out of the sums, and their rows show `—` (`≥$x` for a line whose runs all recorded a sum and some is partial);
    - `· no ledger rows` when none has one; nothing while there is no ledger file.
    - The rows are read from the whole `ledger.jsonl` through the engine's `/api/ledger-rows`, not only the 30-day `ledger-recent.jsonl`, so a line whose runs are older than that window still counts.
  - **Fold rows.** Every `+N more` row of a capped list is a fold row too: Next's `+N more can start (dependencies done), in the picker's order`, the Waiting tab's `+N more`, the Sessions tab's `+N more`.
    - The row follows the first lines and stays at that place: opening it lists the rest below it.
    - It is closed (`▸`) by default. A click opens it (`▾`) and the list shows every line it had folded, in the same order and row form as the shown ones (bar, kind, id, priority glyph); a second click caps it again.
    - One mechanism serves all of them (the pane's `folded` atom, keys `next-more`, `waiting-more`, `sessions-more`), so the state survives a refresh and a closed and reopened pane.
  - **Layout.** A section lays out as one, by the pane's width (`bodyColumns` of each refresh, so a resized pane re-lays out, wide glyphs counted as two cells).
    - While every row of the section fits on one line, each is one line as above. As soon as ANY row does not, EVERY row of that section takes two lines, the second indented one tab.
    - An id or text still too long for its line (either line) is cut with `…`, never wrapped.
    - The height caps count lines, so a two-line section shows half as many rows.
    - The two-line form of each section is first line / second line:
      - Running: bar, kind, id / the state, the next step, the age.
      - Next: bar, kind, id, priority glyph / the id and its glyph.
      - Landed: bar, kind, cost, times, sha / the id.
      - Failed: bar, kind, cost, id, date / the reason.
    - Landed is measured over the rows of the open days only: a row of a folded day neither flips the section to the two-line form nor widens its cost column.
    - Failed: the full reason is measured, so a long one makes the section two-line.
- **Sessions** (a session with a work queue) — the workflow sessions of THIS Claude Code session as a tree (`◆` a root with children, bright `⚙` a working leaf). A click opens a session's card:
  - where it came from (its last moves);
  - where it is (visit, working or waiting);
  - where it can go (the state's transitions and exec cases, read from the dashboard's `/api/workflows`);
  - a link to its graph in the dashboard (`/session/<id>`).
- **No work queue: the single-task view.** A session with no `context.queue_file` has no tabs: the pane is one screen of sections top to bottom, each left out when it has nothing to show and folded when the pane is short.
  1. The current session: `workflow[task] @ state`, the time in the state and the visit (from the second), the states passed (`done a → b → state`, from the session's last moves) and the transitions the state offers (`next`, from `/api/workflows`; the same text as the Sessions card).
  2. `▶ Running under it (n)`:
     - the session's linked agent (role, model, id, age since `link_agent`); the role is `driver` only for the agent of a session whose workflow declares a `driver:` block, else the stage the parent's step spawned it on (`plan`, `execute`, `review`, ...), else the workflow's name (`reviewer`, `worker` and `recon` by name), never `driver` by default;
     - the child sessions as a tree, another root session's too (workflow, task, state, time in it, and their agent);
     - an exec in flight under the session that runs it: `❯ <command> <elapsed>/<timeout>`, the command's first line from the workflow's definition;
     - the last exec's exit (`last exec <state> exit N in <time> <age> ago`, green at 0, red otherwise) while no exec runs.

     The timeout is in red once the exec runs past its deadline: the timeout stretched by the pool wait the engine has counted, read from the run's `.wait` file beside its exit-code file and shown as `+<time> pool wait`, up to four timeouts, as the engine's own deadline. It is the engine's 30 s default when the state names none.

     The model is the one the workflow's `driver:` block declares (`/api/workflows`); a workflow without one shows none.
  3. `▤ pool held <held>/<budget> · load <load> · waiting <n>` (`STARVED` when the pool says so), then:
     - this session's own leases (`▸`, matched by the session id's first 8 characters) and waiters (`◷`);
     - the other holders by label (`· <label> <request> · <age>`, four, then `+N more`).

     The pool is read by the full `GET /api/pool` once per refresh (every 15 s, about 0.6 s, the last step of the refresh) while the pane is open, never per render and never while it is closed.

     When the dashboard did not answer the queue read (the red `queue: …` line) it is not called, and an answer that failed shows one dim `▤ pool: …` line.
  4. `↳ Last transitions`: the last three moves, newest first, with their age.

  Spend is not drawn: the engine measures a session's cost from its agents' transcripts when the session ends (the ledger row), so a running session has no figure to show. The pane's rows are one line each, cut with `…` to its width.

  When the pane is shorter than the sections, they fold least important first:
  1. the last transitions (three rows, then one, then none);
  2. the other holders;
  3. the pool (the strip with this session's leases, then the strip alone, then none);
  4. what runs under it (every row with its last-exec line, then the live rows and the running exec, then none);
  5. the current session keeps its head line last of all (`SINGLE_FOLD_ORDER` of `hooks/pane-view.ts`).

  A queue session keeps the tabs below.
- **Waiting** — pending tasks (not parked) with the picker's own reason, from the dashboard's `/api/queue`.
  - They come in the order the picker admits them (priority urgent, high, normal, low, then file order: `/api/queue` gives each pending line that place as `admitOrder`), so the top row is the line that goes next once its wait clears.
  - The id is followed by the line's priority glyph (`⇈` urgent, `↑` high, `↓` low; a normal line none), as in Next.
  - The same rule applies: `bar kind id reason` on one line while every row fits, else two lines each (`bar kind id` / the reason indented, cut with `…`).
  - The Sessions tab follows it too: a tree row too long for the pane is two lines (workflow and task / the state and age indented), every row of the tree.
  - The Pool tab already cuts each of its lines to the width.
- **Pool** (`4`; its label reads `Pool <held>/<budget>`, like `Plan <running>/<window>`) — the machine-wide thread pool, as the dashboard's Pool tab shows it, fitted to the narrow pane. It reads the dashboard's `GET /api/pool` and nothing else reads the pool.
  - The header: budget, threads held, load, external load and threshold, held locks, the pool-wide `STARVED` note.
  - Each lease: what it holds, priority, time held, an `OVERRUN ~N` flag when its processes run well above its threads, an `UNDERUSE ~N` flag (yellow) when they have run well below them for 30 s, `N` the busy cpus it runs. Under it come project, session, step and label, cut to the pane width with `…`.
  - Each waiter in admission order: what it wants, priority, wait time, a `STARVED` flag.
  - The label's `held`/`budget` come from `GET /api/pool?counts=1` (one plain pool pass, no measuring window, `{budget, held}`). Every refresh reads it while the pane is open on a tab other than Pool; the Pool tab's full read gives them itself. A dashboard that does not answer it leaves the bare `Pool`.
  - The full read costs nothing while the tab is closed: `/api/pool` is called only by a refresh (every 15 s) whose open tab is Pool, and once when the tab is pressed or the pane is opened on it, never on the other tabs and never while the pane is closed.
  - One call takes about 0.6 s on the engine (the pool's measuring window; it runs `ps -A` in the engine process for its two passes, about 25 ms each) and returns about 5 KB.
  - The pool read is the last step of a refresh, so the other tabs' data is stored before it. A pane opened on the Pool tab comes up about 0.6 s later, because opening waits for its first read.
  - Every line is cut to the pane width. The header is two lines. On a lease or waiter the flags (`OVERRUN`, `UNDERUSE`, `STARVED`) keep their cells and the request, priority and age are cut with `…`.
  - When only the pool answer fails (an older engine without the route, an answer that is not the pool), the tab shows one dim `Pool: …` line.
  - When the whole dashboard is down the queue read fails too: the pane has no queue, so it shows the single-task view without the tab row and with the red `queue: …` line, and the pool is not called.
  - The tab shows with a work queue, like the other tabs.

**The header.** The pane's header has two rows:

- the tab row alone (the links never take its width);
- under it the dashboard links: the open tab's own view, then `map ↗` (the dashboard's `/map`).

The tab's link:

| Tab | Link | Path |
|-----|------|------|
| Plan | `plan ↗` | `/plan` |
| Sessions | `sessions ↗` | `/sessions` |
| Pool | `pool ↗` | `/pool` |
| Waiting | `plan ↗` | `/plan`, because the waiting lines are the Plan view's pending section and the dashboard has no view of its own for them |

With no work queue the pane is the single-task view and links `sessions ↗`. `/wf-map` prints the map's URL.

**Agent calls.** An Agent call of a workflow pipeline (the plugin's `workflow:*` subagent types, or any agent linked to a session by `link_agent`) draws as ONE line in the style of the engine-call group's line, in the place of the harness's row (`⏺ workflow:driver(drive ENG-X) Haiku 5.5`):

```
⚙ [ENG-X] driver · haiku 5.5 · batch-task @ review › reviewer @ read 3m lane ↗
```

- The line shows the role, the queue line's id, the model, the workflow and the state (and the deepest one under it), the age in the state, and the link to the lane (`/map/<session id>`).
- Before the session is linked it reads off the call's own input (`workflow:*` subagent type, description `drive <ID>`, model alias), as `⚙ [ENG-X] driver · haiku`.
- Once the pipeline ended, the agent is remembered: `ended at <state>` or `✓ landed <sha>`.
- These keep the harness's row, so an error stays readable: a call of no workflow, an expanded row (ctrl+o), and a failed or interrupted spawn.
- The call's input is never rewritten: the hook only draws.
- The harness folds only reads, searches and listings into a tool group, so a spawn cannot join the group's line (`⚙ [slice] transition→state …`); it is the next line, drawn alike.
- The agent's id is read from the call's stored result (`agentId`, an object) and, failing that, from the `agentId:` line of a text reply.
- A move row (`a→b`) names the state of the reply's `← ACTIVE` frame when the reply prints a stack (a sub-workflow), else the flat `<workflow> @ <state>` line; a reply naming none shows `?`.

**Difficulty and kind.**

- Difficulty shows as a five-cell track `▰▰▰▱▱` (one cell per two points), coloured by the model tier.
- The pane names every colour by a Claude Code theme key, `TONE` of `hooks/pane-view.ts`: `success`, `error`, `warning`, `suggestion`, `claude`, `inactive`, `remember`, `autoAccept`. So a light terminal theme draws the pane in its own palette, never an ANSI name or a hex that reads on one ground only.
- Right after the track every queue row shows the line's `kind` as one text glyph (none an emoji): bug `※`, research `⚑`, feature `◆`.
- A line with no `kind`, or a kind that is not one of the three own keys (`constructor` too), reads as feature.
- The glyph is `mark` in the `/api/queue` answer, from `kindMark` in `src/map-layout.ts`.
- A session with no workflow shows "No active workflow"; nothing opens by itself.

## Dashboard

The web dashboard runs on `localhost:3100` and provides real-time monitoring.

Its tab is titled `Claude Workflow · Dashboard` and carries the site's icon, so a logo or name change reaches both:

- the icon is `/favicon.svg`, drawn by `faviconSvg` of `scripts/brand.mjs`, the function that writes the site's `docs/public/favicon.svg`;
- the name is `NAME` of the same file, which the site config reads too.

The views:

- **Sessions panel** — active sessions plus the most recent finished ones (terminal history is capped)
- **Plan tab** — each queue named by a session's `context.queue_file`. It lists:
  - running lines (with the pipeline state and time in it, linked to the session);
  - ready lines in the picker's order (priority, then file order; the priority beside the id);
  - waiting lines with the picker's reason (window ignored);
  - failed lines;
  - done today: a done line counts when its text holds today's date, `LANDED <sha> YYYY-MM-DD`; marks carry no date.

  Click a line (or a node of the graph) to open a sticky card beside the list (below it on a narrow window) with its full text and a small dependency graph (dagre, left to right).
  - The graph shows the lines its `after:` names and the lines that name it, each node coloured by state (done / running / ready / waiting / failed).
  - A node click selects that line; `close` or a second click on the row closes the card.
  - The graph is `queueGraph` in `src/map-layout.ts`; the ids come from `/api/queue` lines' `afterIds`, resolved by the picker's own tokenizer (text in parentheses is prose).
  - A link inside a row follows its link and selects nothing.
- **Timeline tab** — one bar per TASK PIPELINE of a day.
  - A task pipeline is a session carrying a task id (`slice`, else `task`, in its context or its ledger line: slice-pipeline, engine-task, research-task), named by that id, whether or not a dispatcher started it and however deep it sits.
  - The session that started pipelines (the dispatcher) is one `parent · <workflow>` row, last.
  - A session no task hangs under keeps the older rule: a child of a root with children, or a root without children, is a bar. Its pruned ledger line = the `segs` it recorded, one undivided bar for an older line.
  - A bar is folded: one row, the task's own states as segments coloured by stage group.
    - The groups are `recon`, `plan`, `work`, `gate`, `review`, `land`, `wait`; a name match with `work` as the default.
    - `$STATE_DIR/timeline-groups.conf` overrides a state: JSON, `{"<state>": "<group>"}`; not `.json`, which the session store would read as a session.
    - A click on its `▸` unfolds the sessions beneath it that carry no task of their own, named by role, model and round: `recon · sonnet`, `worker r2 · opus`, `review`.
    - The role is the workflow name without the pipeline's prefix, the model the family from the ledger line or the session's `model`, the round the ordinal among the bar's rows of that role, shown when the role ran twice or more.
    - The fold, the zoom and the project filter stay across the 2 s refresh.
    - A row with no segment in the shown window is not drawn.
    - A pool-lease wait of an exec (`wait_ms`) is hatched inside its segment; hover = state, group, start, duration.
  - At the bar's right: duration, review rounds, `$`, and how it ended.
    - Review rounds are `rN`: its entries into the state `review` (the ledger line's `visits.review`, else its review states, routing states aside, as `wf-calibration` counts), or the review sessions it started, the larger.
    - `$` is the task line's ledger `spend` plus its `parent_spend` plus the `parent_spend` of its member sessions' lines of the same task, whose `spend` the head's already covers. It is `—` until the line exists or when nothing was measured.
    - How it ended:
      - `landed` = completed through a state named `land` or `<x>_land` (the Cost tab's rule: `land_failed` is not one);
      - `closed` = ended without it;
      - `failed`;
      - `running`.
  - The time axis spans the day's activity: today by default, `/timeline/<YYYY-MM-DD>` any day, arrows for the neighbours.
  - Buttons:
    - `fit` (default: the window fits the width);
    - `1 h` / `6 h` (that much time per screen width, the rest scrolls, the labels and the right column stay in place);
    - `day` (the whole day fits).
  - A red now-line on today.
  - Chips of the bars' projects (the main checkout's directory name of the session's cwd) filter the bars, none selected = all.
  - `GET /api/timeline?day=YYYY-MM-DD&root=<id>` answers it from the session files. Each bar: `kind` `task` / `parent`, `label`, `result`, `project`, `duration_ms`, `rounds`, `usd`, `rows` with `role` / `model` / `round` / `name`.
  - Pure builder: `src/timeline.ts`
- **Pool tab** — the machine-wide thread pool, live (refreshed every 2 s).
  - The header: budget, threads held, load and external load, held locks, the pool-wide `STARVED` line.
  - Each lease: pid, threads/locks, priority and level, time held, project, session linked to `/session/<id>`, step, label, an `OVERRUN ~N` plaque when its processes run well above its threads, an `UNDERUSE ~N` plaque when they have run well below them for 30 s.
  - Each waiter in admission order with its wait time and a `STARVED` plaque.
  - `GET /api/pool` answers the same data `wf-run --status` / `pool_status` print, read through the pool module (`poolSnapshot` in `src/pool.ts`; one measured admission pass per request, as `pool_status` runs).
- **Cost tab** — what the finished task pipelines cost, for a day range (today by default; `from` / `to` date inputs, drawn in the page's theme, with their calendar popup, by its `color-scheme`).
  - Per task:
    - its outcome: `landed` = completed through a `land` state (`land_failed` is not one), `closed` = completed without landing, `failed`, `unknown` = completed on a line that recorded no visits;
    - review rounds (entries into the state `review`, as `wf-calibration` counts; the `review*` states summed, routing aside, only for a workflow with no `review` state), tokens, USD, and the stages as run (model, tokens, USD).
  - The range's totals and USD per landed (landed tasks that recorded tokens).
  - A bar trend of USD per landed over the last 14 days.
  - A task's tokens and USD are its ledger `spend` when it has one (one `spend` row, the transcripts' real figure; a `spend` with unmeasured agents, marked `usd_partial`, makes the task unmeasured), else the old estimate from `tokens*` at the blended price.
  - The tab states its price table and the date it was updated: `PRICES_USD_PER_MTOK` / `PRICES_UPDATED` in `src/calibration.ts`.
  - The table is blended USD per million tokens by model family: opus, sonnet, haiku, fable. It is derived as 75% input + 25% output of the bare family keys of `TURN_RATES_USD_PER_MTOK`, so a rate edit moves both; edit the rates and `PRICES_UPDATED` together.
  - A stage's estimate blends by its model's full id, through the same longest-key match as the per-turn price: a stage on `claude-opus-4-1` is priced at that id's blend, the family blend being the fallback for an unknown id. The note prints each blend rounded to four decimals.
  - `GET /api/cost?from=YYYY-MM-DD&to=YYYY-MM-DD` answers it (`buildCost`).
- **Workflow list** — all loaded workflows with state counts
- **Session detail** — state history, stack depth, context data
- **Workflow graphs** — interactive DAG visualization rendered with dagre
- **Map** — the live workflow map: every session at once, as a live history of the workflows (below)

Every view has a real path, driven by the History API (links are plain anchors; back and forward work, a path can be opened or shared directly):

| Path | View |
|------|------|
| `/`, `/sessions` | Sessions list |
| `/session/<id>` | One session's detail |
| `/workflows` | Workflow list |
| `/workflow/<name>` | One workflow's graph and states |
| `/plan` | Plan tab |
| `/timeline`, `/timeline/<YYYY-MM-DD>` | Timeline tab (today, or that day) |
| `/pool` | Pool tab |
| `/cost` | Cost tab |
| `/map` | The live workflow map |
| `/map/<session id>` | The map, scrolled to that session's lane and highlighting it |

The server answers every `GET` that is not an `/api` call or a static file with the page; an unknown `/api/...` path is a JSON 404. The route table is `src/dashboard-routes.ts`, served to the page as `/routes.js`.

### Live workflow map

`/map` draws every workflow session in one space, like a live git history of the workflows. It runs top-down by project, then queue, then workflow.

**Bands.** A **band** per project, queue and workflow kind, headed `project › queue · workflow` (the queue as `<owner>/<file>`).

- The queue is `context.queue_file`, recorded at the start and on every change as a `queue` event; a child takes its ancestor's. A project's sessions with no queue come last.
- The band's **stations** are its columns (`/api/workflows` `stations`). Each column is as wide as its own content needs, 64 to 230 px:
  - its station name and the next station's, since a name is centred on its station and the gap to the next one holds half of each;
  - the branches hung from it (chips, the first four steps with their labels);
  - its share of a loop label crossing it.
- When the page is short of room the columns shrink together, none below 120 px or its own width when narrower. The plaque stands 56 px past the last station.

**Lanes.** A **lane** per task session, from top to bottom:

- landed lanes on top, oldest first;
- the parent rail and the running lanes below;
- the queue's ready lines at the bottom: one `next: <owner>/<file> … +N` row per queue, named the way the band headings name it, sorted like them; up to six lines each, then `+N`.

Landed lanes and bands fold away:

- A landed lane that ended over an hour ago folds into `landed earlier: … +N`, as many chips as the band's width holds. A line that ran twice shows once, by its latest run.
- A band with no running lane whose newest lane ended over two hours ago is not drawn (`MapOptions.hideBandAfterMs`). A running or recent lane brings it back; `/map/<id>` of a lane in a hidden band draws that band.

A lane's drawing:

- It starts at a dot on the first station and ends IN its plaque: difficulty bar `▰▰▰▱▱`, the kind glyph, id, state, age.
  - The plaque is 340 px at most, the id cut with `…`.
  - The bar leads the plaque in the difficulty colour whatever the plaque's border says, and a lane with no known difficulty keeps its width blank.
  - The glyph is the `kind` of the queue line the lane's `task` names (`※` bug, `⚑` research, `◆` feature), a blank of the same width when no queue line carries that id.
- Its line is coloured by the difficulty (a rescore recolours it).
- A running lane reaches the plaque through a faint dotted tail over the stations still ahead.

**Branches.** Under a station hangs whoever ran it.

- A child session is a **branch**: its states as steps (done = ring, live = glowing dot with its time, ahead = faint), its chip `model ▮▮▮▯ effort · role` in the model's colour. A finished branch joins back up.
- A replaced or stopped agent is a red step and the branch goes on.
- An exec station carries its verdict (`gate ✓ 14m`, red on a failing exit).
- The driver chip under a running plaque reads `driver · <model> <effort> · waits on <who>`.
  - The model is the one the workflow's `driver:` declares.
  - The `agent_link` event of a session of such a workflow records that model and effort, never the task's execute model.
  - The site replay reads the workflow's `driver:` for an older event.

**Loops and folds.** A backward move (a review verdict back to work) **loops** the line: down, dashed back to the target station, down again, the next pass below.

- Consecutive rounds of one shape **fold** into one drawn round: the same stations with the same exec verdicts (a duration does not count), the same branches (workflow, outcome, states) and the same back-edge name.
- The loop of a fold reads `↺ <name> ×64 · 1m–3m` (the count and the shortest–longest round).
- A click on the loop or its label opens the group (every round drawn, the first loop marked `▾`) and folds it again.
- The open groups are kept in `sessionStorage` (`wf-map-open`), so a live update and F5 keep them (`MapOptions.open`, the key `<session>:g<first round>`).
- A round that differs stays in place and splits the run: a red exec such as `gate ✗ exit 10`, another path, another branch.
- Never folded: a round with a question to the parent, a round with a branch still running, and the lane's last round (the running one).

**Which sessions are lanes.** A root that is not a dispatcher, or a child of a dispatcher.

- So each queue line is its own lane; a root with its own task is one lane and its children are branches.
- A dispatcher is a taskless root with children, or a taskless session whose children have tasks, e.g. a dispatcher started under a conversation. It draws as the **parent rail** above the running lanes.
- A question to the parent (a state tagged `ask: parent`, or a driver's `ask_parent` from any state, § Question states) is a yellow dashed link up to the rail (`? <state>`, glowing while open, the question as its tooltip). Its answer is a green one back down (`→ <next state> · <wait>`).
- A question the dispatcher itself asks is a glowing mark on the rail (`⏸ … asked the user · open 3h`).
- With four or more running lanes the landed ones drop their step labels.

**Which sessions are bands.**

- A workflow-level `map: false` keeps a root session of that workflow with no children (a conversation, not a task) off the map. The bundled `master` and `file-review` carry it.
- A dispatcher's child lane of such a workflow (`file-review` under `coding`) is left off too.
- A dispatcher itself (a taskless `map: false` root with children) stays, while a tasked one is no longer a dispatcher and leaves the map with its children.
- A workflow with no declared stations gets the states its lanes visited as columns, and one column `start` when no lane has moved.
- Every band is one project, queue and workflow, headed `project › queue · workflow`. A project is the directory name of the session's cwd, and a linked git worktree is named for its main checkout, so every worktree of a repo is one project (the server resolves it in `/api/sessions` and the event log, `projectNameOf` in `src/pool.ts`).

**No overlapping text.** No text is drawn over another.

- Every text of a band is measured with the layout's glyph widths (`G.chipW` at 10 px, `G.charW` at 12 px). `src/map-layout.test.ts` asserts that no two text rectangles of a band intersect, at the normal and narrow widths, with step labels on and off.
- Station names too: a name is centred on its station and cut to half of the gap on each side, so two neighbours never touch; the whole name as a tooltip.
- A branch chip sits on its own text row above its steps (a second branch under one station takes the next row) and is cut to its branch's width.
- A branch shows as many steps as keep every name and detail clear of its neighbours (`…` stands for the hidden ones); a name still too long is cut.
- The parent rail's own label, the questions, the answers and the user question each take the first free text row above the rail.
- Whatever is cut keeps its full text as the SVG tooltip (a `<title>`).

**How the picture is built.** The picture is a pure function `layout(fold(events))`: `src/event-fold.ts` and `src/map-layout.ts`, served as `/event-fold.js` and `/map-layout.js`. `dashboard/map.js` draws it with the keyed reconciler of `dashboard/scene-dom.js`.

- The page folds the session files (`/api/sessions`, re-read every 30 s) first and the event log over them, so a map opened after a server restart still shows each session's recorded story.
- It follows `/api/events/stream` (SSE) and falls back to polling `/api/events` every 2 s.
- Every change animates from the previous layout to the next over ~300 ms, keyed by session ids: a new lane opens space and fades in, a new segment draws itself, a landed lane slides up and dims.
- Between events only the live step's glow moves and the ages (re-laid once a minute).

**The view.** The view holds still: nothing moves it between events.

- `/map/<session id>` glides to the lane (re-aimed when a scene lands in its first second; your first input ends it) and never follows a new lane. Its pill counts events and returns to the plain map.
- Follow mode scrolls only when a NEW lane appears and you were at the bottom, and then to the bottom. Scroll away to read history and a pill `↓ N new events` brings you back.
- When lanes above the one at the top of your view grow, shrink or land, the view moves with that lane. Its place on the screen is kept; the lanes jump instead of sliding for that one scene.

**The landing page replay.** The documentation site's landing page replays this map without a server.

- **The export.** `scripts/export-replay.mjs` cuts a window of whole pipelines from the recorded event log into `docs/public/replay/anyparse.json`:

  ```
  npm run build && npm run docs:replay -- --project-dir <checkout> --workflows <the engine's .claude/workflows>
  ```

  - The window is a few hours: a land, a split, review rounds, several lanes at once; under 300 KB.
  - It takes the open-source projects: `--project anyparse` and `--also mcp-workflow-engine`, the engine's own tasks the same dispatcher drives.
  - `--workflows DIR,DIR` loads the stations of a workflow that lives in another project's directory, the engine's `engine-task`, so its lane has the stations it is drawn on.
  - A session of any other project, its path and its id are never read into the file, an ask's text is left out and the queue path is written without a home directory (`src/replay.ts`).
- **The pool.** The same export reads the machine's thread pool for that window from the pool's log (`pool.log`; a window the log does not cover is not chosen).
  - A lease or waiter keeps its label only when it names a slice or session of the replay.
  - Every other one is a thread count in one row of "leases the log does not name (this project or another)".
  - A sample lists no holders: a name appears only on the sample after an `overrun:`, `underuse:` or `backfill:` line.
  - The export checks its own output: a foreign label, an absolute path, a pid or a spend of a task that is not the replay's refuses the write.
- **The ledger.** The export also reads the ledger (`ledger.jsonl`, `--ledger FILE|none`) for the real `spend.usd` of the replay's tasks, summed over every run of a line as the plan pane reads it.
  - It works under the same allowlist: a row of any other task is never read into the file.
  - A task with no measured spend carries none and the pane draws `—`.
- **The queue.** The same export reads the queue file (`--queue FILE|none`, default `<project-dir>/.claude/batch/queue.yaml`) through the engine's own pick (`planPick` and `describeQueue`, the code `wf-queue` and `queue_next` run). It writes the result as `queue` (`captureReplayQueue`, `src/replay-queue.ts`).
  - The pick runs over the file rolled back to the window's start: every line that ran at or after the window's start, the window's own and those that ran and landed after it, is set back to pending.
  - A line claimed before the window's start and not ended at it is `running` at the start, so a line `after:` it waits `after: X (running)`.
  - For each pending line of the allowlisted projects it writes only its id, difficulty, priority, kind and one of a fixed set of reasons (`after: X (running)`, `overlaps X`, `parked`, `parent-run`), never a line's text or notes. The self-check refuses anything else.
  - The plan pane's Next and Waiting replay it: a line waits for the lines it names and moves Waiting, then Next, then Running as they end.
  - A line added to the queue after the window cannot be rebuilt (the section's `note` says so).
  - A line archived since the window has no wait to show (it is Next from the window's start, as before).
- **The player.** The page's `MapReplay.vue` feeds those events, on a clock (play / pause, 1x to 60x, scrub), to the same `fold` and `layout` and the same `dashboard/scene-dom.js` renderer, with the dashboard's tokens and component rules scoped to the block. Lanes advance, branches open, landed lanes fold, a hover shows the tooltip and a click opens a folded group, as on `/map`.

**The workflow graphs.** The workflow graphs are one module too: `dashboard/graph.js` (pure, served as `/graph.js`). It:

- lays a definition out with dagre and draws it as SVG (`renderGraph`);
- builds the Workflows tab's view, the graph and a row per state (`workflowViewHtml`);
- answers its clicks (`workflowClick`): a node or a row opens that state's prompt, or an action's command, and its transitions; a node of a sub-workflow state opens that workflow.

The dashboard's page and the documentation site's landing page show the same graph and the same panel. The landing page draws every bundled workflow from `docs/public/workflows.json` with the same module and no server; the file is git-ignored, written from `templates/` by `scripts/export-workflows.mjs` through `npm run docs:prepare`, and by every test run.

### Look

One style for every view (sessions, session detail, workflow graphs, plan).

**Tokens and themes**

- `dashboard/tokens.css` holds the design tokens (surfaces, text, state colours, model colours, the difficulty scale 1 -> 10, fonts) and is the only file with a colour literal. It holds two colour sets under the same names, light and dark.
- The page follows the system's `prefers-color-scheme`. The switch at the right end of the tab row (System / Light / Dark) pins a set with `data-theme` on `<html>` and remembers the choice in `localStorage` (`wf-theme`; a blocked storage only means the choice is not kept). A script in the head applies it before the first paint.
- Each set declares its own `color-scheme`, and the page's head carries `<meta name="color-scheme" content="light dark">`. So every native control follows the theme: the date inputs of the Cost tab and their calendar popup, selects and scrollbars. The Timeline tab's day navigation is links, not native controls.
- Colours reach the page's script only as `var(--…)` tokens, none is computed in JS.
- The light set keeps 4.5:1 contrast for text and for every state, model, stage, difficulty and actor colour on the panel (pinned in `src/dashboard-style.test.ts`).
- The docs site scopes the same file to `.dash` for its live map and workflow graphs. It follows VitePress's own theme switch (`html.dark`) instead of the system preference, so a white site shows light demos and the switch flips them live.

**Components**

- `dashboard/components.css` holds each component once and reads colours only through `var(--…)`. The components: plaque, difficulty bar `▰▰▰▱▱`, agent chip `model ▮▮▮▯ effort · role`, step dot, script square, section label, band panel, the `next:` / `landed earlier:` rows.
- The difficulty bar has five cells, `?????` when unknown. It is first in every row or card that shows a difficulty: Plan tab, map lane plaques and `next:` / `landed earlier:` rows. There is one `difficultyBar` in `src/map-layout.ts`.
- The kind glyph `※` bug / `⚑` research / `◆` feature (absent `kind` = feature) follows it in the same places, one `kindMark` beside it, a blank cell when there is no queue line.
- A state reads the same everywhere:
  - running = the model's colour with a glow;
  - waiting on the pool = pink;
  - waiting on a parent (the active step is a state tagged `ask: parent`) = yellow, in the session list, the detail and the plan;
  - stopped or failed = red;
  - landed = green and dimmed.
- The dagre graphs use the same palette: state nodes are plaques, exec states squares, the current state glows, backward edges dashed.
- Inter is used when installed, else the system font; nothing is downloaded, so the page works offline.

**Refresh and reload**

- A refresh on a timer takes its markup into the live nodes in place (`dashboard/stable.js` `patchHtml`: rows matched by their link, id or `data-key`, the rest by place; only differing attributes and text are written). So scroll, focus, the text you selected and running animations survive the 2 s refresh of the lists, a session's detail and the plan.
- A reload (F5) returns to the same scroll position, on every view including the map and `/map/<id>`. `pagehide` saves it per path in `sessionStorage`; the page builds its content after load, where the browser's own restoration finds nothing.
- The map saves the lane at the top of the view and its offset (`noteScroll` in `dashboard/stable.js`) and puts the lane back, not the pixel offset. The first scene is drawn from the session files and grows when the event log arrives (landed lanes of pruned sessions come on top), so a pixel offset is clamped by the shorter page and lands on another lane.
- The position is held until the full scene stands, or until you wheel, touch, press a key or click.
- The page's script builds its markup from the `ui` helpers in `index.html`; `src/dashboard-style.test.ts` renders every view and fails on a colour literal outside the tokens file.

### REST API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/sessions` | List all sessions |
| `GET` | `/api/events?since=<run>:<seq>` | Event log of the dashboard-holding server process's run after that position: `{run, events: [{seq, run, ts, kind, session, data}]}` (kinds below) |
| `GET` | `/api/events/stream` | Server-sent events of the same log; resumes from `?since=N` or `Last-Event-ID`, then streams live |
| `GET` | `/api/session/:id` | Get session detail |
| `POST` | `/api/session/:id/abandon` | Abandon a session |
| `GET` | `/api/workflows` | List all workflow definitions, each with its `stations` (the live map's columns), `map: false` where set and, for a task workflow, its `driver` model and effort |
| `GET` | `/api/queues` | Queue files named by sessions' `context.queue_file` |
| `GET` | `/api/queue?file=<path>` | Every line of that queue with the picker's reason per pending line, its `kind`, the kind's glyph `mark` and the workflow a pick starts for it (`workflow`, absent = the dispatcher's default) |
| `GET` | `/api/ledger-rows?tasks=<id,id>` | The whole ledger's cost rows (JSON lines: `task`, `session_id`, `parent_session_id`, `spend.usd` with its `usd_partial` mark, `parent_spend.usd`) of those queue lines; the plan pane's Failed header sums them, since the plugin API cannot read a ledger over 4 MiB |

Notes on the event log:

- In `/api/events?since=<run>:<seq>`, a bare seq = this run; another run's = from 0.
- The kinds: session_start, transition, exec_start, exec_end, agent_link, agent_respawn, agent_stop, rescore, queue, ask, answer, session_end.

## Status Line

With the plan pane closed, the Claude Code mod draws a band above the prompt (`hooks/plan-pane.tsx`; it hides while the pane is open and comes back when it closes):

<StatusLine />

The picture is the band drawn from a recorded session by the code the mod uses, `statusBandTree` of `hooks/pane-view.ts`; drag the slider to another moment.

- The root session of this Claude Code instance, as `workflow:state`: `◆` in bold once it has children, else `⚙` (bright while an agent or an engine step works in it, plain while it waits), and the other sessions' count in parentheses: `◆ slice-dispatch:collect (5)`.
- The queue, when there is one: `▶` running / window, `⏭` ready, `✓` landed in the last 24 hours.
- `[plan]` (key `p`) opens the pane.
- With an agent's transcript in view, the band shows that agent's workflow session and the deepest state under it instead.

The band needs the mod. The old `scripts/statusline-workflows.sh` is removed; a Claude Code setup without mods pins the plugin to the commit before the removal, `838504b` (no tagged release does).

The landing page shows the replay on one 16:9 stage:

- The map fills the stage (scaled to the frame, never scrolling; when the lanes are taller than the frame a camera follows the running ones).
- The Claude Code window is drawn over it, translucent: a dark terminal in the site's dark theme and a white one in its light theme. The window's chrome and the pane's colours switch together with `html.dark`; the pane's `--tc-<theme key>` palette is in `PaneView.vue`.
- The window shows the parent conversation's lines (each pipeline started, its driver spawned, a question and its answer, a land) and the plan pane.
- The pane is not an imitation: `hooks/pane-view.ts` is what the pane draws, a pure function of a Snapshot. The mod draws it with Claude Code's elements and the site draws it in the browser.
- `snapshotAt` (`src/replay.ts`) builds that Snapshot from the replay's events and its spend, so a Landed row shows `$x.xx` and the day row its sum.
- A thin strip at the stage's foot draws the machine's thread pool over the replay's hours (threads held against the budget, the waiters along the top) with a cursor at the clock.
- The window's Pool tab shows the pool at that moment through the mod's own `poolBody` (the log carries no priority or age, so its rows show none).
- A lane whose exec waits for a pool lease carries the map's "waiting for the pool" mark.
- One transport bar under the stage (play / pause, speed, scrub) drives the map and the window. Its Terminal button and the `T` key hide or show the window.
- The window's own buttons work:
  - red (close) and yellow (minimise) hide it into the Terminal button;
  - green and a double-click on its title bar fill the stage with it and back (`Esc` leaves that);
  - hiding it ends the zoom.
- `npm run docs:record` re-records the scene into `docs/media/scene.gif` (`-- --mp4` also a clip in the git-ignored `video/out/`).
- `npm run video` renders a voiced intro over it (`video/out/intro.mp4`, narration in `video/script.md`, one command, see `video/README.md`).

How the site, its replay, the scene GIF, the banner and the voiced video are produced and re-recorded: [Development](/development#the-site).
