<p align="center">
  <img src="docs/banner.png" alt="Claude Workflow" width="100%">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/claude-mcp-workflow"><img src="https://img.shields.io/npm/v/claude-mcp-workflow" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-7-3178c6" alt="TypeScript"></a>
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude_Code-Plugin-ff6600" alt="Claude Code Plugin"></a>
</p>

<p align="center">
  <img src="docs/media/scene.gif" alt="The live workflow map with the Claude Code window and its plan pane over it, replayed from real sessions" width="100%">
</p>

A Claude Code plugin that drives agents through YAML-defined state machines. The engine tracks state, enforces guards, manages nested sub-workflow stacks, and visualizes everything in a web dashboard.

## Features

- **FSM-based state machines** — define workflows in YAML with states, transitions, and prompts
- **Stack-based sub-workflows** — states can push nested workflows (max depth 10), auto-pop on completion
- **Three-tier loading** — bundled templates < global (`~/.claude/workflows/`) < project (`.claude/workflows/`)
- **Snapshot isolation** — workflow definitions frozen at session start; hot-reloads don't affect running sessions
- **Runtime overlays** — modify workflows on the fly without touching YAML files
- **Action states** — `exec` runs shell commands, `fetch` makes HTTP requests, with auto-routing by exit code or HTTP status
- **Web dashboard** — real-time session monitoring with DAG graph visualization
- **21 bundled workflows** — complete agent lifecycle from routing to reflection, including long-running batch orchestration and a text-only `docs` route
- **28 bundled skills** — reusable knowledge modules auto-provisioned on first run
- **SessionStart hook** — auto-provisions missing skills and injects workflow context
- **Pool gate** — a PreToolUse(Bash) hook runs the commands a project marks heavy (`.claude/workflows/pool-gate.yaml`) under `wf-run`, so agents' own test runs and builds share the machine-wide thread pool too
- **Agent types** — the plugin ships subagent types in `agents/`: `workflow:driver` (haiku/medium; the task-driver rules, which probe a WAITING agent once on a later wake (after the hand-back, before the notification), and tell an agent that waits on its own background work to finish or kill it, while the shipped worker and reviewer prompts forbid ending a turn with live background work; of the workflow tools only `start`, `status`, `transition`, `context_set`, `link_agent`, `queue_mark` and `queue_edit`, so a driver cannot `abort`, `delete`, `create` or `modify` a session), `workflow:recon` (sonnet/medium) and `workflow:reviewer` (opus/high), both read-only: no Edit tool, a Write tool limited by a PreToolUse(Write) hook to the task report directory (absolute path in scratch space with a `<task>.log` / `<task>-logs` directory in it, outside any git work tree, no `..`; a write inside the worktree is refused), and a PreToolUse(Bash) hook (`hooks/read-only-gate.sh`) refuses a Bash call made by those types unless every pipeline segment starts with a declared reader (an ALLOW list: `ls cat head tail wc rg grep jq find git log/show/diff/status/grep/blame…` plus the config `read` list; `envAllowed` names the variables a `NAME=value cmd` prefix may set (any other assignment is refused; `GIT_*`, `PAGER`, `LD_*`, `DYLD_*`, `PATH`, `BASH_ENV`, `ENV`, `IFS` stay refused even when listed); `$( )`, backticks, brace expansion (nested `{{},-i}` included), `printf -v`, a variable in a command word, a variable or glob as a redirect target, a descriptor duplicate that is not the whole word (`>&1foo` writes the file `1foo`), `perl -i`, `python -c`, `node -e`, `tee`, `dd`, `cp`/`mv`, `find -delete` are refused) and any write (redirects into the tree, `git commit/add/rm/mv/stash/reset/checkout…`, `sed -i`, `rm/mv/cp`, plus the project's `.claude/read-only-commands.yaml`: `{ "read": ["apq"], "write": ["apq patch", "/regex/"], "env": { "APQ_READ_ONLY": "1" }, "envAllowed": ["APQ_TEST"], "agents": [...] }`) and, only when a segment starts with a project `read` CLI, exports `env` before the command (other allowed calls pass unchanged). Measured (a real `claude -p` run with a dumping PreToolUse hook, 2026-11-07): the payload of a subagent's Bash call carries `agent_id` and `agent_type`, the main session's carries neither, so it is never touched. Measured again 2026-11-08 with a real `workflow:recon` agent: a write-class Bash call was refused, so the payload carries the qualified name and the gate compares `agent_type` exactly against `agents` — default `workflow:recon`, `workflow:reviewer`; a bare `reviewer` or `other:reviewer` is never matched unless a project lists it. For a read-only agent the read-only hook owns the single rewrite: it exports `env` (only for a project `read` CLI), then applies the pool gate to the prefixed command (`pool-gate-hook` stays out), so a wrapped heavy command still carries the variables; a rewrite it emits carries `permissionDecision: "allow"` (auto mode refuses an unallowed rewritten call) only when every segment is a project `read` CLI, a default that reads no file (`cd echo printf pwd test date basename dirname true false`) or a stdin filter behind a pipe with no file operand (`head tail wc sort uniq cut nl tac tr grep rg`; for grep / rg the value of a value-taking flag is not an operand, so `grep -C 3 x` and `rg -m 5 x` qualify while `grep -C 3 x f` does not; never behind `xargs`, never with `--files0-from`): the allow skips the permission system for the whole call, so a call that needs the rewrite (a project reader's env export, a pool wrap) and carries a file-reading default (`hxq lint a.hx; cat ~/.ssh/id_rsa`, `hxq lint a.hx | xargs head`) is DENIED with `run it in its own call` — the env is neither dropped silently nor exported without an allow. **What this gate is and is not**: it guards a reviewer / recon against ACCIDENTAL writes, not an adversary — shell parsing cannot close every path. The guarantees are exactly three: no Edit tool and a Write limited to the report directory, the project's CLI read-only env, and the allow list of readers above. Out of scope, named: a reader reached by a path (`./ls`, `/tmp/x/cat` — judged by its base name), a flag injected by an inherited variable (`sort $FLAGS`; an allowed call cannot set one), an allowed reader that is itself scriptable, a file the call reads that it should not. A rewrite by a hook outside the plugin (e.g. RTK's own) is not composed — Claude Code keeps one `updatedInput` — so the refusal list is the guarantee and the env is defence in depth. A project extends a type in its own `.claude/agents`. Takes effect after a Claude restart
- **Survives a restart** — when Claude Code exits, its sessions are suspended, not abandoned; `claude --resume` continues them (`resume`), sub-agents included, and an exec that was running keeps running and is taken over

## Install

```bash
/plugin marketplace add https://github.com/anthropics/claude-plugins-community
/plugin install workflow
```

Other install channels (this repository, npm, a local checkout, manual) and the first workflow: [Getting started](https://axgord.github.io/claude-workflow/getting-started).

## Documentation

The full documentation is the site **https://axgord.github.io/claude-workflow/** (sources in `docs/`, built with VitePress: `npm run docs:dev`, `npm run docs:build`). Its landing page replays the live map: a recorded window of real sessions of the open-source anyparse project (`docs/public/replay/anyparse.json`, written from the event log by `npm run build && npm run docs:replay -- --project-dir <the anyparse checkout>`, that project's sessions only) played through the dashboard's own `layout` and renderer, no server, on one 16:9 stage (1920x1080 scaled to the page) that the map fills, never scrolling (scaled to the frame, a camera on the running lanes when they are taller). Over it the Claude Code window, translucent (a toggle and `T` hide it), shows the parent conversation's lines and the plan pane, both drawn by the mod's own code: `hooks/pane-view.ts` turns a Snapshot into the pane's tree, the mod draws it with Claude Code's elements and the site in the DOM (`PaneView.vue`), from the Snapshot `snapshotAt` of `src/replay.ts` builds out of the events. One transport bar under the stage (play / pause, 1x to 60x, scrub) drives both. Under the scene the landing draws the workflow graphs live, in the browser and as SVG (sharp at any size): `dashboard/graph.js`, the module the dashboard's Workflows tab draws with, lays out and draws every bundled workflow from `docs/public/workflows.json` (written from `templates/` by `npm run build && npm run docs:workflows`, current or `src/site-live-graphs.test.ts` fails), and a click on a state shows what the dashboard shows (its prompt and transitions; a sub-workflow state opens that workflow); the graph has no scroll box of its own: its SVG takes the section's width and the height its viewBox gives at that width, so the page scrolls through it and the mouse wheel is never captured (`src/site-graph-no-inner-scroll.test.ts`). The scene also shows the machine's thread pool over the same hours: `scripts/export-replay.mjs` reads the pool's own log (`pool.log`, and `pool.log.1`) for the replay's window, only a window the log covers is chosen, a lease or waiter keeps its label only when it names a slice or session of the replay (an allowlist: the pool is shared by every project on the machine; every other lease is a thread count in one row of leases the log does not name, this project's or another's, since a sample lists no holders and only an `overrun:` or `backfill:` line names one, and the export checks its own output and refuses to write a foreign label, an absolute path or a pid), a thin strip under the map (`PoolStrip.vue`) draws threads held against the budget, the Pool tab of the plan pane shows the pool at the clock through the mod's own `poolBody`, and a lane whose exec waits for a lease (`wait_ms` of the exec's end event) carries the map's "waiting for the pool" mark. The page [Thread pool](https://axgord.github.io/claude-workflow/pool) (`docs/pool.md`) explains it in plain language with a diagram and the same data live (`PoolDemo.vue`). The status line below it is the mod's own band (`statusBandTree` of `hooks/pane-view.ts`) drawn from the replay at a moment the reader picks. `npm run docs:record` re-records that stage into `docs/media/scene.mp4` (1920x1080) and `docs/media/scene.gif` (960 px, under 4 MB, the banner above); it needs the `playwright` devDependency with its Chromium (`npx playwright install chromium`) and ffmpeg. `npm run docs:banner` re-renders the two images the repository shows about itself, `docs/banner.png` (1200x400, the top of this page) and `docs/social-preview.png` (1280x640, the size GitHub asks of a repository's social preview: upload it under Settings > Social preview): `scripts/render-banner.mjs` reads the site's name and tagline from the hero of `docs/index.md`, counts the bundled workflows from `templates/` for its chip, and places a real frame of the scene (map, plan pane and thread-pool strip, captured as `docs:record` captures it; `-- --at <replay s>` picks the moment) beside them, so no number or picture in them is typed or drawn by hand (same prerequisites as `docs:record`, without ffmpeg). `npm run video` renders a voiced 2-3 minute intro (`video/out/intro.mp4` and `intro.srt`) over the same scene: the narration is `video/script.md`, `video/storyboard.json` ties each phrase to a card or a stretch of the replay, a local free voice (Kokoro by default, Chatterbox cloning a sample of yours) voices one WAV per phrase cached by text, so an edit or a UI change re-renders one command (`video/README.md`). `.github/workflows/pages.yml` builds the site and deploys it to GitHub Pages on a push to `master` (once: Settings > Pages > Source: GitHub Actions).

| Page | Covers |
|------|--------|
| [Getting started](https://axgord.github.io/claude-workflow/getting-started) | Install channels, the CLAUDE.md snippet, permissions, configuration |
| [Concepts](https://axgord.github.io/claude-workflow/concepts) | How it works, bundled workflows, bundled skills, MCP tools |
| [Workflow YAML](https://axgord.github.io/claude-workflow/workflow-yaml) | The file format, three-tier loading, `extends:`, project workflows |
| [Action states](https://axgord.github.io/claude-workflow/action-states) | `exec`, `fetch`, the thread pool, routing, fan-out, template variables, guards, stall detection |
| [Thread pool](https://axgord.github.io/claude-workflow/pool) | Why parallel agents queue instead of choking the machine: leases, budget, priority, locks, backfill, overrun, `wf-run`, `config.yaml`, with a live recorded window |
| [Task queue and dispatch](https://axgord.github.io/claude-workflow/queue) | `batch`, `queue_next`, `wf-queue`, the model table, the task driver, the calibration report |
| [Dashboard and plan pane](https://axgord.github.io/claude-workflow/dashboard) | The plan pane, the web dashboard and live map, the status line |
| [FAQ](https://axgord.github.io/claude-workflow/faq) | Troubleshooting |

## Development

```bash
npm run build    # tsc 7 (the `typescript7` alias) → compiles src/ to build/
npm run dev      # tsc 7 --watch
npm start        # node build/index.js
npm test         # vitest run
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

### Architecture

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
| `src/wf-run.ts` | The `wf-run` CLI over the pool |
| `src/queue.ts` | Task queue files: parse, admission (`after:` / `touches:` / `owner:` / pause), `[.]` marks under the queue's lock |
| `src/queue-cli.ts` | The `wf-queue` CLI over `queue.ts` (exec form of `queue_next` / `queue_mark`) |
| `src/process.ts` | Process-group kill and pid liveness |
| `src/stale.ts` | Stall detection: a state's `stale_after` (type defaults) and whether a session is STALE |
| `src/template.ts` | Mustache-style `{{var}}` template rendering for action parameters |
| `src/dashboard.ts` | Express REST API + static file serving |
| `src/dashboard-routes.ts` | The dashboard's route table (path <-> view), shared by the page and the tests |
| `src/event-fold.ts` | The event log's `fold` and `seedEvents` (a session file's events), pure; served as `/event-fold.js` |
| `src/map-layout.ts` | The live map's `layout` (bands, lanes, branches, loops, stops, questions) and keyed `scene`, pure; served as `/map-layout.js` |
| `src/replay.ts` | The landing page's replay, pure: `buildReplay` (one project's sessions from the event log, a window of whole pipelines under a size limit, nothing of another project), `expandReplay` (its rows back to events), the player's clock (`SPEEDS`, `advance`, `rowsUntil`), the map's fit (`fitView`, `cameraTop`), the plan pane's Snapshot at a moment (`snapshotAt`) and the parent conversation's lines (`conversationAt`, with `conversationTail` its last lines keyed by their index in the whole conversation); the pool of the window (`buildPool` cuts `pool.log` to an allowlist of labels, `assertReplayClean` is the export's self-check, `poolStateAt` / `poolCountsAt` the Pool tab's read, `poolWaiting` the lanes that wait for a lease, `poolStrip` the strip's paths); `scripts/export-replay.mjs` writes `docs/public/replay/anyparse.json` with it |
| `src/workflow-describe.ts` | `describeWorkflows` (a workflow as `/api/workflows` carries it, shared by the endpoint and the site's export) and `renderWorkflows` (the site's byte-stable file); `scripts/export-workflows.mjs` (`npm run docs:workflows`) writes `docs/public/workflows.json` from the bundled templates |
| `scripts/record-scene.mjs` | `npm run docs:record`: builds the site, plays the landing's stage (the live map, the Claude Code window with the plan pane over it) frame by frame in headless Chromium through the page's `?record` seek hook, and encodes `docs/media/scene.mp4` and `scene.gif` with ffmpeg |
| `scripts/scene-capture.mjs` | The scene as a headless page for the recorders: builds and serves the site, opens `/?record`, pins the landing's own 16:9 stage to the 1920x1080 frame at scale 1; shared by `record-scene.mjs` and `video/render.mjs` |
| `video/` | `npm run video`: the voiced intro. `script.md` (narration), `storyboard.json` (card or replay range per phrase), `tts.py` (Kokoro / Chatterbox, one cached WAV per phrase), `render.mjs` (plan, frames, audio, SRT, ffmpeg), `README.md` (setup, voices) |
| `.github/workflows/pages.yml` | Builds the VitePress site and deploys it to GitHub Pages on a push to `master` |
| `dashboard/` | The page: `index.html` (views, `ui` component helpers), `map.js` (the live map: events, follow mode, view anchoring), `scene-dom.js` (the keyed SVG reconciliation, shared with the docs site's replay), `graph.js` (the workflow graph and its state panel: `renderGraph`, `workflowViewHtml`, `workflowClick`; pure, shared with the docs site's live graphs), `stable.js` (in-place refresh, scroll memory), `tokens.css` (the only colour literals), `components.css` |
| `src/types.ts` | Zod schemas, TypeScript types, constants |

## License

MIT
