---
title: Development
description: Building and testing the engine, its source layout, and how the site, replay, banner and video are made
---

# Development

## Commands

```bash
npm run build    # tsc 7 (the `typescript7` alias) → compiles src/ to build/
npm run dev      # tsc 7 --watch
npm start        # node build/index.js
npm test         # vitest run (src/test-git-env.ts, the setup file, points git at no global config so a fixture commit never signs)
npm run check    # tsc 7 --noEmit + format:check + lint + scan + vitest + check:ci (the pre-commit gate)
npm run check:ci # the suite as CI runs it (scripts/check-ci.sh): env -i, an empty HOME, no system git
                 # config, TMPDIR inside it, git user.useConfigOnly (no guessed identity), TZ America/St_Johns (CHECK_CI_TZ),
                 # LANG=C — plus CI's package.json / plugin.json version check
npm run lint     # typescript-eslint (type-checked); fails only on findings absent from eslint-baseline.json
npm run lint:baseline  # re-record eslint-baseline.json (after fixing findings, to ratchet down)
npm run format:check   # biome format check (formatter only; part of check)
                       # TypeScript: the compiler is 7 (devDependency `typescript7`, `npm:typescript@^7`, run as
                       # node_modules/typescript7/bin/tsc); `typescript` stays ^5.9 because typescript-eslint (peer <6.1),
                       # the tests that transpile dashboard sources and tsserver (editor LSP) need the JS compiler API 7 lacks
npm run scan     # ast-grep scan --error: structural rules in rules/ (sgconfig.yml), e.g. .then() without .catch(); 0 findings
```

The engine's own slice workflow is a tracked file: `.claude/workflows/engine-task.yaml` (`extends: batch-task`, the project tier of this checkout). `.gitignore` un-ignores that one file and keeps the rest of `.claude/` ignored, so a slice changes the workflow through its worktree like any other source. Its `repro_check` and `repro_route` (a bug line's reproduce step) and its `work_check` (the CHANGELOG entry, on every engine-task branch whatever its kind) list the branch's changes against the branch's own base (`git merge-base master HEAD`), not the moving `master`.

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
| `src/process.ts` | Process-group kill and pid liveness |
| `src/stale.ts` | Stall detection: a state's `stale_after` (type defaults) and whether a session is STALE |
| `src/template.ts` | Mustache-style `{{var}}` template rendering for action parameters |
| `src/dashboard.ts` | Express REST API + static file serving |
| `src/dashboard-routes.ts` | The dashboard's route table (path <-> view), shared by the page and the tests |
| `src/event-fold.ts` | The event log's `fold` and `seedEvents` (a session file's events), pure; served as `/event-fold.js` |
| `src/map-layout.ts` | The live map's `layout` (bands, lanes, branches, loops, stops, questions) and keyed `scene`, pure; served as `/map-layout.js` |
| `src/replay.ts` | The landing page's replay, pure: `buildReplay` (the sessions of the open-source projects, anyparse and the engine's own, from the event log, a window of whole pipelines under a size limit, nothing of another project; the real spend of their tasks from the ledger by `ledgerSpend`, an allowlist of the replay's tasks), `expandReplay` (its rows back to events), the player's clock (`SPEEDS`, `advance`, `rowsUntil`), the map's fit (`fitView`, `cameraTop`), the plan pane's Snapshot at a moment (`snapshotAt`, its Next and Waiting read from `ReplayFile.queue`) and the parent conversation's lines (`conversationAt`, with `conversationTail` its last lines keyed by their index in the whole conversation); the pool of the window (`buildPool` cuts `pool.log` to an allowlist of labels, `assertReplayClean` is the export's self-check, `poolStateAt` / `poolCountsAt` the Pool tab's read, `poolWaiting` the lanes that wait for a lease, `poolStrip` the strip's paths); `scripts/export-replay.mjs` writes `docs/public/replay/anyparse.json` with it |
| `src/replay-queue.ts` | The replay's queue, the export's half that reads the queue module: `captureReplayQueue` runs the engine's own pick (`planPick`, `describeQueue`) over the queue file rolled back to the window's start (the lines that ran in it pending again, the lines claimed before it and not ended at it running, so a line after one waits on it) and cuts it to the pending lines of the allowlisted projects as ids, difficulty, priority, kind and one of a fixed set of reasons (never a line's text or notes); `snapshotAt` (`src/replay.ts`) plays it back |
| `src/workflow-describe.ts` | `describeWorkflows` (a workflow as `/api/workflows` carries it, shared by the endpoint and the site's export) and `renderWorkflows` (the site's byte-stable file); `src/site-workflows.ts` (`writeSiteWorkflows`) writes `docs/public/workflows.json` from the bundled templates, through `scripts/export-workflows.mjs` (`npm run docs:workflows`) and the test run |
| `scripts/record-scene.mjs` | `npm run docs:record`: builds the site, plays the landing's stage (the live map, the Claude Code window with the plan pane over it) frame by frame in headless Chromium through the page's `?record` seek hook, and encodes `docs/media/scene.gif` (with `--mp4` also `video/out/scene.mp4`) with ffmpeg |
| `scripts/scene-capture.mjs` | The scene as a headless page for the recorders: builds and serves the site, opens `/?record`, pins the landing's own 16:9 stage to the 1920x1080 frame at scale 1; shared by `record-scene.mjs` and `video/render.mjs` |
| `video/` | `npm run video`: the voiced intro. `script.md` (narration), `storyboard.json` (card or replay range per phrase), `tts.py` (Kokoro / Chatterbox, one cached WAV per phrase), `render.mjs` (plan, frames, audio, SRT, ffmpeg), `README.md` (setup, voices) |
| `.github/workflows/pages.yml` | Builds the VitePress site and deploys it to GitHub Pages on a push to `master` |
| `dashboard/` | The page: `index.html` (views, `ui` component helpers), `map.js` (the live map: events, follow mode, view anchoring), `scene-dom.js` (the keyed SVG reconciliation, shared with the docs site's replay), `graph.js` (the workflow graph and its state panel: `renderGraph`, `workflowViewHtml`, `workflowClick`; pure, shared with the docs site's live graphs), `stable.js` (in-place refresh, scroll memory), `tokens.css` (the only colour literals), `components.css` |
| `src/types.ts` | Zod schemas, TypeScript types, constants |

## The site

The documentation is the site **https://axgord.github.io/claude-workflow/** (sources in `docs/`, built with VitePress: `npm run docs:dev`, `npm run docs:build`, `npm run docs:preview`). `docs:dev` and `docs:build` first write the site's generated workflow export (`docs:prepare`). `docs:preview` serves `docs/.vitepress/dist`, which is git-ignored and survives between runs, so it builds first: a preview always shows the current sources.

### The replay

The site's landing page replays the live map: a recorded window of real sessions of the open-source projects, anyparse and this engine's own work (`docs/public/replay/anyparse.json`, written from the event log and the ledger by `npm run build && npm run docs:replay -- --project-dir <the anyparse checkout> --workflows <the engine's .claude/workflows>`, the sessions of `--project anyparse` and `--also mcp-workflow-engine` only (`--workflows` gives the engine's own `engine-task` its stations on the map); everything else stays out of the file), with the real cost of each of their tasks: the export reads `spend.usd` from `ledger.jsonl` for the tasks of the replay only (an allowlist like the events', a row of any other task is never read into the file; `--ledger FILE|none`), the plan pane's Landed rows show `$x.xx` and the day row its sum as the live pane does, and a task with no measured spend stays `—`; the plan pane's Next and Waiting fill like the live pane's: the export also reads the queue file (`--queue FILE|none`, default the project's own) through the engine's own pick (`planPick` and `describeQueue`, the code `wf-queue` and `queue_next` run) over the file rolled back to the window's start (every line that ran at or after the window's start, the window's own and those that ran and landed after it, set back to pending; a line claimed before the window's start and not ended at it is `running` at the start, so a line `after:` it waits `after: X (running)`), and writes `ReplayFile.queue` (`src/replay-queue.ts`): per pending line of `--project` and `--also` only its id, difficulty, priority, kind and one of a fixed set of reasons (`after: X (running)`, `overlaps X`, `parked`, `parent-run`), never a line's text or notes, and the self-check refuses anything else; `snapshotAt` replays it, so a line moves Waiting, then Next, then Running as the lines it waits for end (a line added to the queue after the window cannot be rebuilt: the section's `note` says so).

### The stage

The window is played through the dashboard's own `layout` and renderer, no server, on one 16:9 stage (1920x1080 scaled to the page) that the map fills, never scrolling (scaled to the frame, a camera on the running lanes when they are taller). Over it the Claude Code window, translucent (a toggle and `T` hide it), shows the parent conversation's lines and the plan pane, both drawn by the mod's own code: `hooks/pane-view.ts` turns a Snapshot into the pane's tree, the mod draws it with Claude Code's elements and the site in the DOM (`PaneView.vue`), from the Snapshot `snapshotAt` of `src/replay.ts` builds out of the events. One transport bar under the stage (play / pause, 1x to 60x, scrub) drives both.

### The workflow graphs

Under the scene the landing draws the workflow graphs live, in the browser and as SVG (sharp at any size): `dashboard/graph.js`, the module the dashboard's Workflows tab draws with, lays out and draws every bundled workflow from `docs/public/workflows.json` (a build product, git-ignored and never committed: `npm run docs:dev`, `docs:build` and `docs:preview` write it from `templates/` first through `npm run docs:prepare`, which builds and runs `npm run docs:workflows`, and so does every test run, so a template edit cannot leave a stale copy), and a click on a state shows what the dashboard shows (its prompt and transitions; a sub-workflow state opens that workflow); the graph has no scroll box of its own: its SVG takes the section's width and the height its viewBox gives at that width, so the page scrolls through it and the mouse wheel is never captured (`src/site-graph-no-inner-scroll.test.ts`).

### The thread pool in the scene

The scene also shows the machine's thread pool over the same hours: `scripts/export-replay.mjs` reads the pool's own log (`pool.log`, and `pool.log.1`) for the replay's window, only a window the log covers is chosen, a lease or waiter keeps its label only when it names a slice or session of the replay (an allowlist: the pool is shared by every project on the machine; every other lease is a thread count in one row of leases the log does not name, this project's or another's, since a sample lists no holders and only an `overrun:` or `backfill:` line names one, and the export checks its own output and refuses to write a foreign label, an absolute path or a pid), a thin strip under the map (`PoolStrip.vue`) draws threads held against the budget, the Pool tab of the plan pane shows the pool at the clock through the mod's own `poolBody`, and a lane whose exec waits for a lease (`wait_ms` of the exec's end event) carries the map's "waiting for the pool" mark. The page [Thread pool](https://axgord.github.io/claude-workflow/pool) (`docs/pool.md`) explains it in plain language with a diagram and the same data live (`PoolDemo.vue`). The status line below it is the mod's own band (`statusBandTree` of `hooks/pane-view.ts`) drawn from the replay at a moment the reader picks.

### Recording the scene

`npm run docs:record` re-records that stage into `docs/media/scene.gif` (960 px, under 4 MB, the animation at the top of the README; `-- --mp4` also writes a 1920x1080 clip to the git-ignored `video/out/scene.mp4`, nothing in the repository reads it); it needs the `playwright` devDependency with its Chromium (`npx playwright install chromium`) and ffmpeg.

### The brand: logo, banner and social preview

`npm run docs:banner` re-renders the brand: logo 2 (the live map, a dispatcher fanning out into three lanes) as the site's nav logo (`docs/public/logo.svg` for the dark theme, `logo-light.svg` for the light one, `themeConfig.logo`) and its favicon (`docs/public/favicon.svg`, both colour schemes in one file), and the two images the repository shows about itself, `docs/banner.png` (1200x400, the top of the README) and `docs/social-preview.png` (1280x640, the size GitHub asks of a repository's social preview: upload it under Settings > Social preview): `scripts/render-banner.mjs` holds the SVG templates (logo, and a schematic of a task's life: queue, think, code, review, land, the gates between them, the dashed fix arrow, the thread pool with the agents waiting for it), reads the site's name and tagline from the hero of `docs/index.md`, counts the bundled workflows from `templates/` for its line of chips, and puts the drawing over a blurred, dimmed crop of a real frame of the scene (captured as `docs:record` captures it, never a stored picture; `-- --at <replay s>` picks the moment, by default the first second at which the plan pane shows three Landed rows with a price, read from the replay itself (`defaultAt`), so a re-export moves it; the README's size has the weaker background so the schematic reads first), so no number or picture in them is typed or drawn by hand (same prerequisites as `docs:record`, without ffmpeg).

### The voiced video

`npm run video` renders a voiced 2-3 minute intro (`video/out/intro.mp4` and `intro.srt`) over the same scene: the narration is `video/script.md`, `video/storyboard.json` ties each phrase to a card or a stretch of the replay, a local free voice (Kokoro by default, Chatterbox cloning a sample of yours) voices one WAV per phrase cached by text, so an edit or a UI change re-renders one command (`video/README.md`).

### Deploy

`.github/workflows/pages.yml` builds the site and deploys it to GitHub Pages on a push to `master` (once: Settings > Pages > Source: GitHub Actions).
