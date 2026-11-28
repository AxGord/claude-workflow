---
title: Development
description: Building and testing the engine, its source layout, and how the site, replay, banner and video are made
---

# Development

## House style

How the pages of `docs/` are written. A change to a page keeps to it; the measures below are what a scan can check.

1. One idea per paragraph, about 80 words; 120 is the most.
2. A section opens with one or two sentences saying what it is and when you need it. The detail follows.
3. Steps or events are a numbered list; alternatives or rules are bullets, one rule per bullet.
4. Options, fields, keys and tools are a table of name, meaning and notes. A cell holds one sentence of at most 40 words; longer text goes to a bullet or a paragraph under the table.
5. An example is a fenced code block. Inline backticks mark identifiers only.
6. A record of fields is a bullet list per group of fields, not a chain of sentences joined by colons and parentheses. A parenthesis never nests inside another.
7. Restructuring never drops or changes a fact. Words are cut only where a sentence repeats another word for word; a new lead sentence says nothing the section did not.

How the measures count:

- A block is consecutive prose lines joined. A blank line, a list item, a heading, a table row, a code fence, the front matter or an inline svg ends it. Its words are counted split on spaces: fewer than 120, with 80 the target.
- A table cell is counted the same way: at most 40 words.
- A sentence runs to a full stop followed by a capital letter or a backtick; a colon or a semicolon does not end it. A code span counts as one word. A sentence has fewer than 60 words.
- A parenthesis is nested two deep when a `(` opens inside another that is still open; code spans are skipped.

One test, `src/docs-prose-blocks.test.ts`, scans every page of `docs/` for the block and cell measures; the few blocks allowed past 80 words are listed in it with the reason.


## Commands

The npm scripts of the engine repo:

```bash
npm run build    # tsc 7 (the `typescript7` alias) → compiles src/ to build/
npm run dev      # tsc 7 --watch
npm start        # node build/index.js
npm test         # vitest run (the setup files: src/test-git-env.ts points git at no global config so a fixture commit never signs; src/test-kill-tripwire.ts refuses a signal to pid 0, 1 or -1 and logs the caller to wf-test-kill-tripwire.log under the OS temp dir)
npm run check    # tsc 7 --noEmit + format:check + lint + scan + vitest + check:ci (the pre-commit gate)
npm run check:static   # the first half of check: tsc 7 --noEmit + format:check + lint + scan (serial, ~2 cores)
npm run check:tests    # the second half: vitest + the pane tests + check:ci (vitest takes WF_THREADS workers when it is set)
npm run check:leased   # check under pool leases sized to each half (scripts/check-leased.sh): 2 threads, then 4-6; what the engine-task gates and a worker run
npm run check:ci # the suite as CI runs it (scripts/check-ci.sh): env -i, an empty HOME, no system git
                 # config, TMPDIR inside it, git user.useConfigOnly (no guessed identity), TZ America/St_Johns (CHECK_CI_TZ),
                 # LANG=C — plus CI's package.json / plugin.json version check
npm run smoke:fresh   # what a new user gets (scripts/smoke-fresh-install.sh): a fresh clone of HEAD, npm ci, build, the git channel's release tree
                      # (scripts/release-tree.sh, `npm ci --omit=dev --ignore-scripts` timed against Claude Code's 60 s, a server handshake), the SessionStart hook,
                      # the MCP server over stdio, the dashboard, wf-run, wf-queue and the docs' commands in a temp HOME; one PASS/FAIL
                      # line per step, exit 1 on a FAIL; needs the registry (~1 min cold); compares the real ~/.claude before and after;
                      # the unit tests stub its install and build steps (SMOKE_INSTALL_CMD, SMOKE_BUILD_CMD), a real run never sets them
npm run lint     # typescript-eslint (type-checked); fails only on findings absent from eslint-baseline.json
npm run lint:baseline  # re-record eslint-baseline.json; a fixed finding left in the baseline fails the suite (src/eslint-baseline-ratchet.test.ts) though `npm run lint` stays exit 0, so re-record in the same commit as the fix
npm run format:check   # biome format check (formatter only; part of check)
                       # TypeScript: the compiler is 7 (devDependency `typescript7`, `npm:typescript@^7`, run as
                       # node_modules/typescript7/bin/tsc); `typescript` stays ^5.9 because typescript-eslint (peer <6.1),
                       # the tests that transpile dashboard sources and tsserver (editor LSP) need the JS compiler API 7 lacks
npm run scan     # ast-grep scan --error: structural rules in rules/ (sgconfig.yml), e.g. .then() without .catch(); 0 findings
```

### The engine's own slice workflow

The engine's own slice workflow is a tracked file: `.claude/workflows/engine-task.yaml` (`extends: batch-task`, the project tier of this checkout). `.gitignore` un-ignores that one file and keeps the rest of `.claude/` ignored, so a slice changes the workflow through its worktree like any other source.

**The base the checks list against**

- Its `repro_check` and `repro_route` (a bug line's reproduce step) and its `work_check` (the CHANGELOG entry, on every engine-task branch whatever its kind) list the branch's changes against the branch's own base (`git merge-base master HEAD`), not the moving `master`.

**`work_check` and a tree still at the reviewed commit**

- `work_check` also refuses a tree still at `reviewed_sha` when a review text exists and its verdict (read as `review_filed` reads it) is not MERGE, a non-canonical verdict line included: the driver took `check` without sending the list to the worker (exit 3; the stdout carries the review text itself, which `work_unready` forwards to the worker).
- The refusal prints the last 8000 bytes of the review (`tail -c`: the verdict and its list close the text).
- The bundled `templates/batch-task.yaml` `work_check` carries the same guard on `batch/<task>` against `reviewed_sha` and `review_text`, which its `review` prompt has the driver set.
- `src/work-check-unamended-fixes.test.ts` and `src/work-check-unamended-fixes-followups.test.ts` pin it.
- `review_filed` refuses a `review_text` with no verdict line (a driver's paraphrase, or empty) with exit 11 to `review_refile`, where the driver asks the reviewer for its final message verbatim and files it again; it never defaults to a fix round with no fix list. `src/review-filed-verdict-paraphrase.test.ts` pins it.

**Whether the tree needs another review**

- After a green gate, `review_route` decides whether the tree still needs a `review` visit: it compares the reviewed commit's patch and HEAD's patch over their own parents with the prose paths (CHANGELOG.md, README.md, `docs/**/*.md`) left out and only the +/- lines read (a rebase's moved hunk headers, index lines and context do not count).
- The site's own code under docs/ (`.vitepress/`, `.vue`, scripts) stays code, as in `scripts/review-class.sh`.
- Equal code patches after a MERGE go to `project_land` (a `breaking: true` line to `breaking_ready`).
- Equal code patches after FIXES go to `review_verify`, one verify-only question to the same reviewer that spends no `review` visit (`max_visits: 2`).
- A `rebase_fix` after MERGE whose resolution changed code (HEAD's parent is no longer the reviewed commit's) goes to `review_verify` too, naming the range-diff of the two patches; any other code change enters `review` as before.
- `src/review-visits-verify-only-fix.test.ts` pins it.

**A blocked task whose gate went red outside its diff**

- `blocked` of `engine-task` offers `regate` besides `close`, `stop` and `parent_edited`: the parent names a red test outside the task's diff, and the gate runs again on the unchanged branch (`regate_gate`, the command of `project_gate`).
- Green goes where any green gate goes (`review_route`: a review visit or the land). Red goes through `regate_red`, which shows the output, back to `blocked`.
- `regate_gate` has `max_visits: 2` with `on_exhausted: blocked`: a third `regate` runs nothing, and `parent_edited`, `close` or `stop` is the way on.
- `src/task-blocked-regate-route.test.ts` pins it, with the relay form of the dispatcher (`dispatch-driver.md`, `task-driver.md`, `agents/driver.md`).

**A gate killed by SIGKILL**

- `project_gate`, `project_gate_rebased` and `regate_gate` exit 137 when `npm run check` was killed (SIGKILL), not 1: a kill is no red test.
- Exit 137 of `project_gate` and `project_gate_rebased` goes to its own `station: false` retry state (`max_visits: 1`, `on_exhausted: gate_failed`) and back to the same gate: one re-run, no parent round. A second kill in the session reaches `gate_failed`, whose prompt names the 137 route.
- `regate_gate` is not retried: the parent started it and holds its two visits. Its output and `regate_red` name the kill.
- `src/gate-137-retry.test.ts` pins it.

**The worker guide and the memory index**

A slice started from another project's session loads that project's `CLAUDE.md` and memory, never this repository's. The guide for it is `docs/worker-guide.md`, a file of its own and under 6 KB: this page is too long to read first.

- The `repro`, `work` and `review` prompts of `engine-task` (and the fresh worker of `rebase_fix`) tell the agent to read `{{context.wt}}/docs/worker-guide.md` and the engine's memory index first, and that the rules of the session's own project (its language, linter, `hxq`, `.hx` gates) do not apply to engine code.
- The memory index is `~/.claude/projects/<main checkout path with every / and . as ->/memory/MEMORY.md`; the prompt builds the path from `{{context.cwd}}`, so no machine path is committed.
- The guide's "Where text goes" table is the engine's own placement map: the rows of the bundled `knowledge-placement` table, aimed at this repository. Memory takes only what no earlier row holds, with a `why-memory:` line, and never the status of work.
- `docs/decisions.md` is the append-only record of refuted hypotheses, one line each. The guide and the record are excluded from the site (`srcExclude`).
- `src/engine-worker-guide.test.ts` pins these.

**A browser in a worker's tree**

The worker prompt forbids a bare `playwright install` (it replaces browsers in the machine-wide `~/Library/Caches/ms-playwright`, which every parallel slice's gate launches from) and prescribes this command, with the tests run under the same variable:

```sh
PLAYWRIGHT_BROWSERS_PATH=<worktree>-browsers npx playwright install <browser>
```

- A browser a worker's own script launches runs under a lease through the engine checkout's `scripts/wf-run --threads 1` (the prompt's `{{context.cwd}}/scripts/wf-run`, not a bare name off PATH) and is closed in a `finally`.
- `work_check` refuses (exit 3, the pids listed, nothing killed) while a process reparented to init (ppid 1) has the worktree as its cwd.
- `cleanup` removes `<worktree>-browsers` under its exact-path guard.
- `src/worker-browser-install-isolated.test.ts` pins these.

**A land that conflicts**

- A land whose rebase onto a moved master conflicts (`project_rebase` exit 1) goes through `rebase_conflict` (an exec state, `max_visits: 2`) straight to `rebase_fix`, with no parent and no driver choice.
- The third conflict of a task follows its `on_exhausted` to `land_failed`, which is also where every other land failure goes.
- `rebase_fix`'s verify does not ask whether master is an ancestor (a lag without a conflict is rebased by the land itself).
- `src/land-rebase-conflict-auto-fix.test.ts` pins it.

**The worktree and a reboot**

- The worktree lives where a reboot keeps it: `<repo>/../.wt/<repo-name>/<TASK>` (beside the engine checkout, never under `/tmp`, which a Mac reboot wipes), with its `-logs` and `-browsers` directories next to it.
- `project_prepare` re-attaches the branch (`git worktree prune`, then `worktree add <wt> <branch>`; a branch still checked out in a live worktree is refused) when the directory is gone but `eng/<id>` survives, instead of failing on `-b`.
- `project_rebase` has no `cwd` and tells a missing worktree (exit 6) from a conflict (exit 1): exit 6 goes to `rebase_reattach` (the same command as `project_prepare`, `max_visits: 2`, then `project_rebase` again), never to `rebase_conflict`.
- On exhaustion or error of `rebase_reattach` the route is `land_failed`, where the prompt names it by what is shown: stdout "worktree ... is missing", or exit 1/2 with git's `worktree add` refusal in stderr, never a `fix` round.
- When the branch is gone too, `project_rebase` leaves with exit 7 (default route, `land_failed`): a missing branch is never made anew on the land route.
- `cleanup` admits the new path and a legacy `/tmp/wf-<TASK>` of a session started before the move.
- The bundled `batch-task` already placed its worktree beside the repo; only its reviewer's `review.md` (`/tmp/wf-batch-logs/<ID>/`, the one write a read-only reviewer is allowed) is in `/tmp`, and it is a transient file.
- `src/worktree-survives-reboot.test.ts` pins it.

### The pre-commit hook

The hook is local, not tracked: `.git/hooks/pre-commit`, shared by the main checkout and every task worktree. Install it once per clone:

```sh
printf '#!/bin/sh\nroot="$(git rev-parse --show-toplevel)"\n[ -f "$root/scripts/pre-commit.sh" ] && exec sh "$root/scripts/pre-commit.sh"\nexec sh "$root/scripts/check-skill-sync.sh"\n' > .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

It runs `scripts/pre-commit.sh`, which has two checks.

**Commit scope** (`scripts/check-commit-scope.sh`)

- A commit made straight on the main checkout may carry one `docs/decisions.md` line and nothing else. Anything more is refused, naming the files and the queue tools (`queue_add`, `queue_edit`): engine code and shipped text change through an engine-task worktree and its review.
- Passes: a commit in a linked worktree (a task worktree), the commit of a merge in progress, an empty or decisions-only index, and a commit made with `WF_ENGINE_USER_COMMIT` set (the user's own release or hand fix; an agent never sets it).
- The land is never refused: it is `git merge --ff-only`, which makes no commit and runs no hook.
- It is a local backstop, as `git commit --no-verify` skips it. Pinned by `src/commit-scope.test.ts`, which commits through the real hook.

**Skill sync** (`scripts/check-skill-sync.sh`)

- It blocks only a commit that touches `templates/skills/`, `templates/skills-stack/` or `.skillsyncignore`.
- For any other commit a drift is a warning that asks for an engine-task line, so a live-skill edit no longer stops every land until someone syncs it.

### The pool gate of the engine repo

The engine repo has its own pool gate, `.claude/workflows/pool-gate.yaml` (tracked beside `engine-task.yaml`; `.gitignore` un-ignores it, so every engine-task worktree has it).

**Where the hook looks**

- The hook finds a `pool-gate.yaml` from the directory the command runs in up to the git root.
- That directory is the call's cwd moved by its leading `cd <dir> &&` segments: a worker's call is `cd <worktree> && npx vitest run …` while the session's cwd is another project, whose own config would otherwise decide.
- A target with no config keeps the call cwd's rules.
- A target with one is judged by it for heavy routing, but the call cwd's project `deny` rules still refuse, so a worker's `cd <worktree> && git stash` meets the session project's deny.
- Without one, a worker's or reviewer's own `npx vitest run src/<file>.test.ts`, `vitest run --maxWorkers=1` or `npm run check` ran with no lease (load beside an idle pool).

**What the rules lease**

The rules lease every vitest form (`npx`, `npm exec`, `node_modules/.bin`, bare), `npm test`, `npm run check`, `npm run check:ci` and `scripts/check-ci.sh`, sized by what the run uses:

| The run | Threads |
|---------|---------|
| An explicit `--maxWorkers=N` (N = 1, 2, 4, 8) | N |
| One named test file | 1 |
| Two named test files | 2 |
| Anything else (the suite, a directory, `-t`) | `4-14` |

- Each hands its share to vitest as `VITEST_MAX_WORKERS=$WF_THREADS` (vitest's own default is one worker per cpu minus one, so without it a 2-thread lease would run 15 workers), and `scripts/check-ci.sh` carries that one variable through its emptied environment.
- A command already under `wf-run` (the workflow's exec states) or run with `WF_THREADS` set is never leased twice.
- `tsc`, `lint`, `scan` and `build` run for about a second and take no lease.
- `src/pool-gate-engine-repo.test.ts` pins it, the `cd` case included (a payload cwd in another git repo with its own `pool-gate.yaml` without vitest rules).

## Architecture

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Entry point — wires components, starts stdio transport |
| `src/workflow-dirs.ts` | The one owner of the workflow directories (`WORKFLOW_DIR`, the cwd's `.claude/workflows/`, bundled `templates/`): `workflowDirs` / `workflowLoader`, built by the server and by `session-cli.js` alike |
| `src/engine.ts` | FSM core — start, transition, abort, context, stack push/pop |
| `src/session-scope.ts` | Who may end or step a session: `scopeVerdict` (abort / transition outside the caller's own subtree refused without `force` + `reason`), `secondRootRefusal` (a parentless `start` beside an active root) |
| `src/loader.ts` | YAML loading + Zod validation + fs.watch hot-reload |
| `src/storage.ts` | JSON persistence with atomic writes and lockfile mutex |
| `src/modifier.ts` | Runtime overlays + create (YAML writer) |
| `src/tools.ts` | MCP tool registrations + response formatting |
| `src/executor.ts` | Action state execution — shell commands (`exec`, a `resource:` exec under a pool lease) and HTTP requests (`fetch`) |
| `src/pool.ts` | Machine-wide thread pool: config, admission pass, lease acquire/release under a file lock |
| `src/wf-run.ts` | The `wf-run` CLI over the pool (`--status`, `--usage`) |
| `src/pool-usage.ts` | What each lease held against what its tree ran: the meter, `usage.jsonl`, `wf-run --usage`'s per-label table |
| `src/queue.ts` | Task queue files: parse, admission (`after:` / `touches:` / `owner:` / pause), `[.]` marks under the queue's lock |
| `src/queue-cli.ts` | The `wf-queue` CLI over `queue.ts` (exec form of `queue_next` / `queue_mark`) |
| `src/lessons-file.ts` | `wf-queue --lessons`: a landed task's lesson records as queue lines (unverified → backlog, arm-rot-on-base → pending) or triage-file rows, rerun-safe; an optional `dest` word is validated and written into the triage row |
| `src/process.ts` | Process-group kill and pid liveness |
| `src/stale.ts` | Stall detection: a state's `stale_after` (type defaults) and whether a session is STALE |
| `src/delivery.ts` | A state's `delivers:` key: the delivery record, the tokens read from the agent's transcript, the `DELIVERY:` line and the live-pool-entry warning |
| `src/template.ts` | Mustache-style `{{var}}` template rendering for action parameters |
| `src/dashboard.ts` | Express REST API + static file serving |
| `src/dashboard-routes.ts` | The dashboard's route table (path <-> view), shared by the page and the tests |
| `src/event-fold.ts` | The event log's `fold` and `seedEvents` (a session file's events), pure; served as `/event-fold.js` |
| `src/map-layout.ts` | The live map's `layout` (bands, lanes, branches, loops, stops, questions) and keyed `scene`, pure; served as `/map-layout.js` |
| `src/replay.ts` | The landing page's replay, pure: `buildReplay`, `expandReplay`, the player's clock, the map's fit, the plan pane's Snapshot at a moment, the parent conversation's lines and the pool of the window; `scripts/export-replay.mjs` writes `docs/public/replay/anyparse.json` with it |
| `src/use-case.ts` | The use-case page's data, pure: `foldUseCase`, `workflowFacts`, `assertUseCaseClean`; `scripts/export-use-case.mjs` writes `docs/use-case-anyparse.json` from them, and with `--engine` `docs/use-case-engine.json` |
| `src/use-case-path.ts` | The path one queue line takes through anyparse's slice pipeline over those facts (`slicePath`, `stageRow`, the page's scenarios): free of imports, run by the page in the browser |
| `src/use-case-scenes.ts` | What the page's other scenes draw, free of imports: a queue line's fields and the difficulty anchors, the small queue and its pick, the lane of review rounds, where a lesson goes |
| `src/replay-queue.ts` | The replay's queue, the export's half that reads the queue module: `captureReplayQueue` runs the engine's own pick over the queue file rolled back to the window's start; `snapshotAt` (`src/replay.ts`) plays it back |
| `src/workflow-describe.ts` | `describeWorkflows` (a workflow as `/api/workflows` carries it, shared by the endpoint and the site's export) and `renderWorkflows` (the site's byte-stable file); `src/site-workflows.ts` (`writeSiteWorkflows`) writes `docs/public/workflows.json` from the bundled templates, through `scripts/export-workflows.mjs` (`npm run docs:workflows`) and the test run |
| `scripts/record-scene.mjs` | `npm run docs:record`: builds the site, plays the landing's stage frame by frame in headless Chromium through the page's `?record` seek hook, and encodes `docs/media/scene.gif` with ffmpeg |
| `scripts/scene-capture.mjs` | The scene as a headless page for the recorders: builds and serves the site, opens `/?record`, pins the landing's own 16:9 stage to the 1920x1080 frame at scale 1; shared by `record-scene.mjs` and `video/render.mjs` |
| `video/` | `npm run video`: the voiced intro. `script.md` (narration), `storyboard.json` (card or replay range per phrase), `tts.py` (Kokoro / Chatterbox, one cached WAV per phrase), `render.mjs` (plan, frames, audio, SRT, ffmpeg), `README.md` (setup, voices) |
| `.github/workflows/pages.yml` | Builds the VitePress site and deploys it to GitHub Pages on a push to `master` that changed a site input; the deploy is tried twice |
| `dashboard/` | The page: `index.html`, `map.js`, `scene-dom.js`, `graph.js`, `stable.js`, `tokens.css`, `components.css` |
| `src/types.ts` | Zod schemas, TypeScript types, constants |

**More on the longer rows**

- `src/replay.ts`:
  - `buildReplay` takes the sessions of the open-source projects, anyparse and the engine's own, from the event log, a window of whole pipelines under a size limit, nothing of another project; the real spend of their tasks comes from the ledger by `ledgerSpend`, an allowlist of the replay's tasks.
  - `expandReplay` turns its rows back to events.
  - The player's clock is `SPEEDS`, `advance`, `rowsUntil`; the map's fit is `fitView`, `cameraTop`.
  - The plan pane's Snapshot at a moment is `snapshotAt`, its Next and Waiting read from `ReplayFile.queue`.
  - The parent conversation's lines are `conversationAt`, with `conversationTail` its last lines keyed by their index in the whole conversation.
  - The pool of the window: `buildPool` cuts `pool.log` to an allowlist of labels, `assertReplayClean` is the export's self-check, `poolStateAt` / `poolCountsAt` the Pool tab's read, `poolWaiting` the lanes that wait for a lease, `poolStrip` the strip's paths.
- `src/use-case.ts`:
  - `foldUseCase` folds one project's finished pipeline runs from the ledger, as counts and sums that name no task or session: lands, cost by review rounds, difficulty, band and stage, the recon's outcomes, the windows between curator runs, hours by open pipelines.
  - Its `landVisit` option names the state whose visit marks a land when a workflow's lands do not pass `mark_landed` or `bookkeeping` (`engine-task`: `mark_done`).
  - `workflowFacts` reads the model table, the driver and the thresholds from the project's workflow files, refusing a file that no longer says one.
- `src/use-case-scenes.ts`: the small queue's pick is `toyPick`, held equal to `planPick` by a test; the lane of review rounds is `roundsLane`.
- `src/replay-queue.ts`:
  - The pick is `planPick` with `describeQueue`, run over the queue file rolled back to the window's start (the lines that ran in it pending again, the lines claimed before it and not ended at it running, so a line after one waits on it).
  - `captureReplayQueue` cuts it to the pending lines of the allowlisted projects as ids, difficulty, priority, kind and one of a fixed set of reasons (never a line's text or notes).
- `scripts/record-scene.mjs`: the landing's stage is the live map and the Claude Code window with the plan pane over it; with `--mp4` it also encodes `video/out/scene.mp4`.
- `dashboard/`:
  - `index.html`: views, `ui` component helpers.
  - `map.js`: the live map, with events, follow mode, view anchoring.
  - `scene-dom.js`: the keyed SVG reconciliation, shared with the docs site's replay.
  - `graph.js`: the workflow graph and its state panel (`renderGraph`, `workflowViewHtml`, `workflowClick`); pure, shared with the docs site's live graphs.
  - `stable.js`: in-place refresh, scroll memory.
  - `tokens.css`: the only colour literals, a light and a dark set, `data-theme` on `<html>` or the system picks.
  - `components.css`.

## The site

The documentation is the site **https://axgord.github.io/claude-workflow/** (sources in `docs/`, built with VitePress: `npm run docs:dev`, `npm run docs:build`, `npm run docs:preview`). `docs:dev` and `docs:build` first write the site's generated workflow export (`docs:prepare`). `docs:preview` serves `docs/.vitepress/dist`, which is git-ignored and survives between runs, so it builds first: a preview always shows the current sources.

### The hero and the header

The landing opens with the GitHub banner as live HTML and SVG (`docs/.vitepress/theme/Hero.vue`, mounted in the home layout's `home-hero-before` slot by `theme/index.ts`), merged with the nav. The page opts in with `pageClass: has-hero` in `docs/index.md`; every other page keeps VitePress's own bar.

#### What the hero shows

- The words are the `hero:` of `docs/index.md` (the default text hero stays in the markup, hidden, and still feeds `scripts/render-banner.mjs`).
- The chips are the banner's, and the workflow count is the number of `templates/*.yaml` counted by `config.mts` at build time (`__BUNDLED_WORKFLOWS__`), never typed.
- The diagram is the banner's schematic of a task's life (queue, think, code, review, land, the gates, the fix loop, the thread pool with the waiting agents) drawn from the same words at two widths, so its labels stay legible on a phone.
- The diagram is hand-drawn in the template beside `schematicSvg` of `scripts/render-banner.mjs` because that one is a string builder in a node script the browser bundle cannot import, and `Scene`, `PoolStrip` and `WorkflowGraphs` draw the replay and the bundled definitions, not a fixed schematic.
- GitHub appears once, as the icon beside the theme switch, and "Get started" once, as the hero's button.

#### One name and the bar

There is one name: the nav's own title (`siteTitle` in `config.mts`, its first word in the banner's gradient).

- On the desktop layout only (from 960 px, where the hero is two columns) it is enlarged while the page is at its top and condenses into the bar's left as the page scrolls.
- Below 960 px the hero stacks and the bar is VitePress's own, opaque and pinned at the top, hiding on a scroll down and showing on a scroll up, with its plain title.
- That bar is fixed at every width with the theme's `--vp-nav-bg-color` as its background, which VitePress does not paint for a `home` layout below 960 px; the content is padded by `--vp-nav-height` under it.

#### One content width

The hero and the bar share one content width, `--hero-content-w` (VitePress's home container, the feature grid's 1152 px, inside `--vp-layout-max-width`). On a wide screen the hero is one centred block, and the logo, the hero's text, the diagram, the bar's right cluster and the feature cards share their edges, not spread to the layout's 1376 px (`src/site-hero-content-width.test.ts` measures it at 1280, 1440, 1920 and 2560 px).

- The replay's stage (`Scene.vue`) and the install block (`Install.vue`) under the hero take the same width: their `max-width` is `--hero-content-w` plus the hero's gutters.
- The hero's own gutter is 24 px below 768 px and 32 px from there, plus 64 px of `max-width` from 768 px; the old 16 px phone override is gone.
- So at 375, 640, 768, 960, 1215, 1280, 1440 and 1920 px their edges and the feature grid's are the hero's, each asserted within 1 px (`src/site-scene-install-align.test.ts`).
- VitePress's feature grid takes the same width and gutters: `Hero.vue` overrides its container under `.Layout.has-hero` (padding 24 px, 32 px from 768 px, `max-width: var(--hero-content-w)`) in place of its own 24/48/64 px steps, so its cards' edges are the hero's at every width (`src/site-feature-grid-align.test.ts`, 375 to 1920 px).

#### One layout over the scroll

The hero and the bar are ONE layout over the whole scroll range, from 960 px a grid of two columns shared by both (CSS variables of `.Layout.has-hero`: `--hero-text-min`, the left column's least width, and `--hero-dg-max`, the diagram's greatest). The left column is the text (in the bar, the title), the right column is the diagram (in the bar, where the search starts, on the diagram's left edge).

The diagram is drawn at 70% of the size it first had (594 px of the 848 it filled). Three sizes, 60, 70 and 80%, were compared beside the text column at 1440 px:

- at 60% the labels got small;
- at 80% the diagram was nearly as tall as the text block and competed with it;
- at 70% the text block leads and the diagram is 208 px against the text's 260.

#### The scroll

The scroll has phases:

1. The title first scales down below the bar while the search condenses. The search, which also gives way to the cluster where the row is short, narrows from 300 px to 150 px and slides next to the right cluster. The row is the search between two free spaces that share the width by `flex-grow`, 0 and 1 at the top, 1 and 0 condensed.
2. Then the title rises into the bar.

The bar's surface (VitePress's own opaque colour of the current theme) is complete before the title reaches it and its divider comes last.

- What the hero holds (tagline, buttons, chips, the diagram) does not fade at any width: it scrolls under the opaque bar as plain content, cut by the bar's line and never dissolved (no soft edge).
- `src/site-hero-no-fade.test.ts` samples the scroll every 16 px at 375, 414, 768, 960 and 1440 px and asserts opacity 1 for every element with any part in the viewport.
- Every size is a CSS number (`--hero-brand-y`, `--hero-brand-s`, `--hero-search-w0`, `--hero-search-w1`), nothing is measured; the bar is fixed at every width, over a hero that pads under it from 960 px and under a content padding below it, so nothing jumps.
- The scroll linkage is CSS scroll-driven animation (`animation-timeline: scroll(root block)`) where the browser has it and motion is allowed; elsewhere a sentinel's `IntersectionObserver` toggles `hero-condensed` on the root and the same states change with a transition, or at once under `prefers-reduced-motion`.

#### The desktop merge and the phone bar

- The merge of the nav and the hero (the enlarged title, the condensing search, the transparent bar that is fixed over the hero) is for the desktop layout, from 960 px.
- Below it the bar is VitePress's own (opaque and fixed at the top like the desktop one, hiding on a scroll down and showing again on a scroll up, see below; no enlarged title) over a stacked hero.
- `src/site-mobile-nav-pinned.test.ts` pins in a real browser at 390 and 800 px that after a scroll down and a scroll up of more than 10 px (the bar shown again, its transition over) the nav's top is 0 and its bottom is `--vp-nav-height`, and that the page's content starts below it.
- It also pins that the bar's computed background equals `--vp-nav-bg-color` (alpha 1) after a scroll, light and dark.

#### The Docs menu

The nav is one entry, Docs, a link to `/getting-started` (a click goes there; it is active on every docs page) with a list of every page of the sidebar beside it. The landing has no sidebar, so this is where its reader finds the pages; a single text link stood alone beside the icons.

VitePress's own dropdown is a button that only opens its menu and it has no link-plus-menu item, so this is a custom nav item, `theme/DocsNav.vue` (`component: "DocsNav"` in `config.mts`, registered in `theme/index.ts`):

- the title is a link;
- the list opens on hover, on keyboard focus and on a click, Enter or tap of the caret beside it (the caret only opens, so it cannot hide a list that hover or focus already opened; Esc, a tap outside, or the pointer or focus leaving closes it);
- in the hamburger screen (below 768 px) it is always expanded, with no toggle: a `Docs` link to `/getting-started` and every page's link under it, as VitePress's own screen-menu link components (`screen-menu` is the prop VitePress passes a custom nav component for it; its stock group would be collapsed).

`src/site-docs-nav-clickable.test.ts` pins the click, the list, the caret and, at 390 px, the open menu with every page visible and no click on Docs, in a browser.

#### The theme switch

The theme switch cross-fades. `theme/Layout.vue` wraps VitePress's layout (the slots `index.ts` fills pass through) and provides its `toggle-appearance`, which flips `isDark` inside `document.startViewTransition` (after a `nextTick`, the recipe VitePress documents, without its circular reveal).

- The old page therefore fades into the new one over 300 ms (`TRANSITION_MS`, the group's `animation-duration`), the travel time of the switch's own knob (VitePress's `VPSwitch` moves it in 0.25 s).
- Every demo (the map, the terminal window, the status line, the pool strip) follows `html.dark` in CSS, so they change in the same transition, with no second change after it.
- A browser without `startViewTransition` and a reader under `prefers-reduced-motion` get the plain flip; input is ignored while the 300 ms runs.
- `src/site-theme-switch-transition.test.ts` pins the source and, in Chromium, pauses the transition's animations and captures the page at 0, 100, 200 and 300 ms (set `WF_THEME_FRAMES=<dir>` to keep the PNGs), the demos' end state against a page loaded dark, the reduced-motion and no-API flips.
- It runs Firefox and WebKit when playwright's own builds of them are installed.

#### The hero's own tests

- `src/site-hero.test.ts` pins its source.
- The built landing (the count, the page class, the title) is checked in the one build of `src/site-map-replay.test.ts`.
- `src/site-hero-layout.test.ts` (opt-in, `WF_BROWSER_TESTS=1`, builds the site and drives it in headless Chromium) scrolls the page in 8 px steps at 1440, 1024, 960, 768, 375 and 320 px, with and without reduced motion. It asserts:
  - every box of the bar lies inside the viewport with a gutter;
  - no two boxes of the bar (logo, title, search, links, theme switch, GitHub, the extra menu or hamburger) overlap;
  - plus the search's grid line, no horizontal overflow and wrapping chips and buttons across sixteen widths.
- `src/site-hero-320.test.ts` pins that the bar's title and the page fit a 320 px phone (the name's and the title's right edges and the page's scroll width at 320 px, scroll top, with and without reduced motion).
- It runs whenever a browser is installed, with no opt-in.

#### The bar below 960 px

Below 960 px the bar is fixed on every page and auto-hides:

- `Layout.vue` owns the one passive, frame-throttled scroll listener, which flips `nav-autohide-hidden` on `<html>` on a scroll down (past 10 px, never at the page top, never with the nav screen or the sidebar open) and clears it on any scroll up.
- The bar and a doc page's local nav (`VPLocalNav`) then move up by `transform: translateY`, with no transition under `prefers-reduced-motion`.
- Keyboard focus (`:focus-visible`, via `:root.nav-autohide-hidden:has(.VPNav :focus-visible, .VPLocalNav :focus-visible)`) in either bar cancels the hidden transform of both bars together, so a Tab into a hidden bar shows it and the focused element is never off-screen, and a tapped control (no focus ring) holds nothing open.
- From 960 px nothing moves.
- `src/site-mobile-nav-autohide.test.ts` pins it in a real browser at 390 and 1280 px.
- `src/site-mobile-nav-autohide-focus.test.ts` pins the focus reveal (the rule's source and, at 390 px on `/` and `/getting-started`, a focused nav link and the local nav's button after a scroll down).
- `src/site-mobile-nav-autohide-focus-visible.test.ts` pins that only keyboard focus reveals (at 390 px, a tapped hamburger and a tapped theme switch leave the bar hiding on a scroll down; a Tab into the local nav shows both bars with no gap).

#### The install block

The install block's two commands sit in the markup VitePress renders for a markdown code block (`div.language-text` with `button.copy`, `span.lang`, `pre`), inside a `.vp-doc` wrapper. The docs pages' copy button (its look, hover and focus behaviour, the "Copied" feedback, VitePress's own click handler) is therefore the block's; nothing in `Install.vue` styles or scripts the button (`src/site-install-copy.test.ts` clicks it by keyboard in both themes at 1280 and 390 px and reads the clipboard).

### The replay

The site's landing page replays the live map: a recorded window of real sessions of the open-source projects, anyparse and this engine's own work, with the real cost of each of their tasks.

`docs/public/replay/anyparse.json` is written from the event log and the ledger by:

```sh
npm run build && npm run docs:replay -- --project-dir <the anyparse checkout> --workflows <the engine's .claude/workflows>
```

It holds the sessions of `--project anyparse` and `--also mcp-workflow-engine` only (`--workflows` gives the engine's own `engine-task` its stations on the map); everything else stays out of the file.

**The cost of each task**

- The export reads `spend.usd` from `ledger.jsonl` for the tasks of the replay only (an allowlist like the events', a row of any other task is never read into the file; `--ledger FILE|none`).
- The plan pane's Done rows show `$x.xx` and the day row its sum as the live pane does, and a task with no measured spend stays `—`.

**The plan pane's Next and Waiting**

They fill like the live pane's:

- The export also reads the queue file (`--queue FILE|none`, default the project's own) through the engine's own pick (`planPick` and `describeQueue`, the code `wf-queue` and `queue_next` run).
- The pick runs over the file rolled back to the window's start: every line that ran at or after the window's start, the window's own and those that ran and landed after it, is set back to pending. A line claimed before the window's start and not ended at it is `running` at the start, so a line `after:` it waits `after: X (running)`.
- The export writes `ReplayFile.queue` (`src/replay-queue.ts`): per pending line of `--project` and `--also` only its id, difficulty, priority, kind and one of a fixed set of reasons (`after: X (running)`, `overlaps X`, `parked`, `parent-run`), never a line's text or notes. The self-check refuses anything else.
- `snapshotAt` replays it, so a line moves Waiting, then Next, then Running as the lines it waits for end. A line added to the queue after the window cannot be rebuilt: the section's `note` says so.

### The stage

The window is played through the dashboard's own `layout` and renderer, no server, on one 16:9 stage (1920x1080 scaled to the page) that the map fills, never scrolling (scaled to the frame, a camera on the running lanes when they are taller).

Over it sits the Claude Code window:

- It is translucent and dark or white with the site's theme (`terminal-palette.css`'s `--cc-*`, shared with the status-line and Pool page demos, and `PaneView.vue`'s `--tc-*`, one value per theme key of `TONE`).
- A toggle and `T` hide it, as do its close and minimise buttons. Its green button and a title-bar double-click zoom it over the stage, `Esc` leaves.
- It shows the parent conversation's lines and the plan pane, both drawn by the mod's own code: `hooks/pane-view.ts` turns a Snapshot into the pane's tree, the mod draws it with Claude Code's elements and the site in the DOM (`PaneView.vue`), from the Snapshot `snapshotAt` of `src/replay.ts` builds out of the events.

One transport bar under the stage (play / pause, 1x to 60x, scrub) drives both.

### The workflow graphs

Under the scene the landing draws the workflow graphs live, in the browser and as SVG (sharp at any size): `dashboard/graph.js`, the module the dashboard's Workflows tab draws with, lays out and draws every bundled workflow from `docs/public/workflows.json`.

- `docs/public/workflows.json` is a build product, git-ignored and never committed: `npm run docs:dev`, `docs:build` and `docs:preview` write it from `templates/` first through `npm run docs:prepare`, which builds and runs `npm run docs:workflows`, and so does every test run, so a template edit cannot leave a stale copy.
- A click on a state shows what the dashboard shows (its prompt and transitions; a sub-workflow state opens that workflow).
- The graph has no scroll box of its own: its SVG takes the section's width and the height its viewBox gives at that width, so the page scrolls through it and the mouse wheel is never captured (`src/site-graph-no-inner-scroll.test.ts`).

### The thread pool in the scene

The scene also shows the machine's thread pool over the same hours.

**What the export keeps**

- `scripts/export-replay.mjs` reads the pool's own log (`pool.log`, and `pool.log.1`) for the replay's window, only a window the log covers is chosen.
- A lease or waiter keeps its label only when it names a slice or session of the replay (an allowlist: the pool is shared by every project on the machine).
- Every other lease is a thread count in one row of leases the log does not name, this project's or another's, since a sample lists no holders and only an `overrun:`, `underuse:` or `backfill:` line names one.
- The export checks its own output and refuses to write a foreign label, an absolute path or a pid.

**What it draws**

- A thin strip under the map (`PoolStrip.vue`) draws threads held against the budget.
- The Pool tab of the plan pane shows the pool at the clock through the mod's own `poolBody`.
- A lane whose exec waits for a lease (`wait_ms` of the exec's end event) carries the map's "waiting for the pool" mark.

The page [Thread pool](https://axgord.github.io/claude-workflow/pool) (`docs/pool.md`) explains it in plain language with a diagram and the same data live (`PoolDemo.vue`). The status line below it is the mod's own band (`statusBandTree` of `hooks/pane-view.ts`) drawn from the replay at a moment the reader picks.

### The use-case page

`docs/use-case-anyparse.md` shows how the open-source anyparse project is run on the engine, in seven scenes (`theme/UseCase*.vue`: the queue line, the pick, the path by difficulty, the review rounds, the lessons, the curator, the numbers; `theme/use-case.css` is what they share).

The components only draw. What they draw is pure code the page runs in the browser (`src/use-case-path.ts`, `src/use-case-scenes.ts`) over the snapshot `docs/use-case-anyparse.json`, which the page's text never copies a number from. To rewrite the snapshot:

```sh
npm run build && npm run docs:use-case -- --project-dir <the anyparse checkout> [--model-table <a dated copy of its slice-pipeline.yaml>] [--to <ISO time>]
```

`scripts/export-use-case.mjs` reads the thresholds, the driver and the model table from the project's `.claude/workflows` files, and folds `ledger.jsonl` for that one project's task pipeline (`foldUseCase`).

- `workflowFacts` of `src/use-case.ts` refuses a file that no longer says one of them.
- `--model-table` takes the table from a dated copy, the one in force while the ledger's runs were made.
- `--to` ends the window where that table stopped being in force.

The file names no task, session, agent or path (`assertUseCaseClean` refuses the write otherwise), and the same inputs give the same bytes.

`docs/use-case-engine.md` is the second page, about the engine's own lines. Its only scene is `<UseCaseNumbers of="engine" />`, which draws `docs/use-case-engine.json`: the figures of the engine's `engine-task` runs, with no workflow facts. A panel the snapshot has no figures for (the recon, the cost by stage) is not drawn. To rewrite it:

```sh
npm run build && npm run docs:use-case -- --engine [--to <ISO time>]
```

`--engine` reads the engine's runs from the ledger (project `mcp-workflow-engine`, workflow `engine-task`, a land is a visit of `mark_done`) and needs no project checkout.

The anyparse snapshot's rules still hold for it: no path, session or task, and no number typed into the page's text. The scenes are rendered into the page's HTML at build time; their colours are the dashboard's tokens, which `config.mts` writes into every page's head on `.dash-tokens` (`theme/dash-tokens.ts`).

### Recording the scene

`npm run docs:record` re-records that stage into `docs/media/scene.gif` (960 px, under 4 MB, the animation at the top of the README; `-- --mp4` also writes a 1920x1080 clip to the git-ignored `video/out/scene.mp4`, nothing in the repository reads it); it needs the `playwright` devDependency with its Chromium (`npx playwright install chromium`) and ffmpeg.

### The brand: logo, banner and social preview

`npm run docs:banner` re-renders the brand: logo 2 (the live map, a dispatcher fanning out into three lanes) as the site's nav logo and its favicon, and the two images the repository shows about itself.

- The nav logo is `docs/public/logo.svg` for the dark theme and `logo-light.svg` for the light one (`themeConfig.logo`).
- The favicon is `docs/public/favicon.svg`, both colour schemes in one file.
- `docs/banner.png` is 1200x400, the top of the README.
- `docs/social-preview.png` is 1280x640, the size GitHub asks of a repository's social preview: upload it under Settings > Social preview. The same render is also written to `docs/public/og.png`, the card image the site's own head names, see below.

Two scripts do it:

- `scripts/brand.mjs` holds the brand itself, with no dependency: the name `NAME`, the two palettes, the logo and `faviconSvg`. The site config, the dashboard (its `<title>`, heading and `/favicon.svg`) and the render script all read it.
- `scripts/render-banner.mjs` holds the banner's SVG templates (a schematic of a task's life: queue, think, code, review, land, the gates between them, the dashed fix arrow, the thread pool with the agents waiting for it).
  - It reads the site's name and tagline from the hero of `docs/index.md`, and counts the bundled workflows from `templates/` for its line of chips.
  - It puts the drawing over a blurred, dimmed crop of a real frame of the scene, captured as `docs:record` captures it, never a stored picture.
  - `-- --at <replay s>` picks the moment, by default the first second at which the plan pane shows three Done rows with a price, read from the replay itself (`defaultAt`), so a re-export moves it.
  - The README's size has the weaker background so the schematic reads first.

So no number or picture in them is typed or drawn by hand (same prerequisites as `docs:record`, without ffmpeg).

The site's head carries what a link to it shows in a post (`docs/.vitepress/config.mts`):

- Open Graph (`og:type`, `og:site_name`, `og:image` with its width, height and alt) and the Twitter card (`summary_large_image`, `twitter:image`) for the whole site.
- Each page's own `og:title`, `og:description` (its frontmatter `description`; the landing's is its hero) and `og:url`, with `twitter:title` and `twitter:description`, from `transformHead`.

Every url in a tag is absolute (`https://axgord.github.io/claude-workflow/...`): a crawler does not resolve the base. A preview does not update until the page is deployed and the network re-fetches it; to check after a deploy, paste the address into https://www.opengraph.xyz/ or the LinkedIn Post Inspector (https://www.linkedin.com/post-inspector/), which show the card and drop their cached copy.

### The voiced video

`npm run video` renders a voiced 2-3 minute intro (`video/out/intro.mp4` and `intro.srt`) over the same scene:

- the narration is `video/script.md`;
- `video/storyboard.json` ties each phrase to a card or a stretch of the replay;
- a local free voice (Kokoro by default, Chatterbox cloning a sample of yours) voices one WAV per phrase cached by text, so an edit or a UI change re-renders one command (`video/README.md`).

### The release

The suite runs once per commit, in `.github/workflows/ci.yml`, on a node matrix (22 and 24):

- `package.json` `engines.node` is the lowest version of that matrix (`>=22.0.0`); 20 and 18 are past end of life and untested, so not claimed;
- a new node version goes into the matrix first, and a raised `engines` follows the matrix, never the other way round.

A push to `master` that changes `package.json` runs `.github/workflows/publish.yml`: the `ci-green` gate, version check, build (no tests), `npm publish`, then the git channel.

The gate is `scripts/ci-green.sh <sha>`, so a release cannot be cut from a commit the matrix did not pass:

- it reads the `push` runs of `ci.yml` for the commit being published (`gh api`, `actions: read`);
- it waits while one is still running (a push starts both workflows at once) and fails the job unless one is green;
- a `workflow_dispatch` is gated the same way, on the commit of the ref it was dispatched from;
- a commit with no CI run is refused after three minutes;
- after a failed CI cell, re-run the failed jobs of that CI run (the success replaces the verdict), then re-run the publish workflow.

Claude Code never builds a plugin at install (it copies the files and installs the dependencies from `package-lock.json` with scripts off), so the commit a git source names must already hold `build/`. `master` stays without built files. After a successful publish the workflow:

- runs `scripts/release-tree.sh --commit`: a commit whose parent is the `master` release commit and whose tree is that commit's tree plus `build/*.js` (compiled from the committed sources; no `.d.ts`, no maps: only what runs);
- pushes it as branch `release` (forced) and the tag `v<version>` in ONE `git push --atomic`, through `scripts/release-push.sh` (every remote call retried 4 times, 10/30/60 s apart, by `scripts/retry.sh`), and creates the GitHub release from `scripts/release-notes.sh <version>` (the lead of that version's CHANGELOG block, up to its first `### ` heading, and a link to CHANGELOG.md at the tag);
- leaves no branch and no tag when the publish failed.

Every step of the job is safe to run again, so a transient failure (a GitHub storage error on the push, the registry's lag) is finished by re-running the workflow:

- the publish goes through `scripts/npm-publish.sh`: a publish refused because the version already exists counts as published, and it then waits (up to 10 minutes) until `npm view claude-mcp-workflow@<version> version` answers, since the registry answers 404 for minutes after a publish. The step is still skipped when `npm view` already answers the version;
- the release commit is deterministic: author, committer and dates are those of the `master` commit (`scripts/release-tree.sh --commit`), so a re-run makes the same sha. When the tag already names that sha it is left alone; when it names another commit the job fails, it never moves a released tag;
- the version check counts a release as done only when the tag AND its GitHub release exist, so a tag without a release is finished by the re-run (`softprops/action-gh-release` updates the release of an existing tag, it does not make a second one).

Only a real run on GitHub proves the workflow YAML, a GitHub-side push failure and the registry's real lag; `src/publish-retry-idempotent.test.ts` runs the three scripts against a local bare remote and a fake `npm`.

GitHub refuses a release body over 125,000 characters, so a version's CHANGELOG block keeps its summary above a `### ` heading and its entries below it.

The marketplace entry in `.claude-plugin/marketplace.json` is a `github` source with `ref: release`. The community catalog pins a `sha`; what moves that pin is the catalog's own automation (not read from here).

After the push check: the Actions run is green; branch `release` exists; the tag's commit holds `build/index.js`; the catalog's pinned `sha` moves to it. `scripts/release-tree.sh --dir DIR` writes the same tree to a directory; `npm run smoke:fresh` walks it, and `src/git-install-starts.test.ts` starts its server.

### Deploy

`.github/workflows/pages.yml` builds the site and deploys it to GitHub Pages on a push to `master` (once: Settings > Pages > Source: GitHub Actions).

The push trigger has a `paths:` filter: `docs/`, `src/`, `dashboard/`, `hooks/`, `types/`, the workflow files at the top of `templates/` (`*.yaml`, `*.yml`; not its skills or `skills-history.txt`), `scripts/brand.mjs`, `scripts/export-workflows.mjs`, `tsconfig.json`, `package.json`, `package-lock.json` and the workflow itself.

A commit that touches none of them (a skills-only or CLAUDE.md-only one) deploys nothing; `workflow_dispatch` still deploys by hand. A new file the config, the theme or the exporter reads from outside `docs/` needs its path in that list (`src/pages-deploy-resilient.test.ts` reads the imports and fails when one is not covered).

The deploy job tries `actions/deploy-pages` twice: the first step has `continue-on-error`, a 60 s wait and the second step run only when it failed, and the job fails only when both did. A GitHub-side 500 (`Failed to create deployment`) thus no longer needs a re-run by hand. The three Pages actions are on the Node 24 majors (`configure-pages@v6`, `upload-pages-artifact@v5`, `deploy-pages@v5`).
