# Changelog

## 0.1.9

- engine: every exec state gets `WF_PLUGIN_ROOT` in its env (plugin root, resolved from the executor module's own location) — templates reference bundled scripts portably (`sh "$WF_PLUGIN_ROOT/scripts/foo.sh"`), no per-machine script installation; a state's own `env:` can override it
- templates: master.yaml starts with a `scan_project` exec state — engine-run project language scan (bundled `scripts/scan-project.sh`) whose per-extension menu (+ tool probes, e.g. `hx … (hxq OK)`) renders in the route prompt via `context.project_langs`; skill selectors pick from the menu instead of re-scanning (empty menu → manual fallback)
- templates: file-review.yaml gains engine-run mechanics — `probe_hxq` exec (tool availability → `context.hxq_available`, consumed by a read_context top-up instruction) and `mechanical_pass` exec (bundled `scripts/hxq-lint-file.sh` on the reviewed file → `context.lint_report`); build_checklist carries lint findings as facts, drops linter-covered rules from the manual checklist (stale-report guard via `===` file headers), keeping only judgment rules
- templates: exec states pass agent/context-derived values via `env:` (not template interpolation into `sh -c`) — a `$(cmd)`-named directory or reviewed file cannot execute
- skills: coding-skill-selector reworked to menu-driven selection — pick languages the task touches from the engine scan, tool-bound skills (hxq) load only when the menu marks the tool available (or a probe succeeds), top-up rule for mid-task language widening
- skills: anti-drift for bundled snapshots — `scripts/check-skill-sync.sh` diffs `templates/skills/*` against the live `~/.claude/skills/*` (same-named pairs; `.skillsyncignore` lists intentional divergence like the generic coding-skill-selector), wired as a local git pre-commit hook so a stale snapshot can't be committed; every silently-drifted bundled skill re-synced from live; skill-manager checklist now requires copying every live-skill edit onto the bundled twin
- skills+templates: top-tier orchestrator unloading — a top-tier main session writes plans/briefs/judgment inline but delegates code >~30 changed lines to implementer agents (coupled set → ONE agent with the whole plan, never per-file fan-out; implementer tier = plan detail × mechanical net: sonnet for detailed-plan+linter/tests, opus otherwise); the plan itself is ALWAYS built inline (dialog condensate, planner=dispatcher); wired through task-delegation + coding/bug-fix/planning states (incl. fix_coupled delegation carve-out and single-file >30-line routing)
- skills: architecture skill cleaned and split — project-specific example stories abstracted (no leaked nouns), 4 debugging meta-patterns → new `debugging` skill (loaded via debugging/bug-fix gates + selector trigger), 3 UI-component entries → new `domain-ui` skill; body 26.3KB → 15.4KB always-loaded; bug-fix logic branch gained its missing skill gate
- engine: `digest_on_repeat` state flag — a flagged prompt state delivers its full text ONCE per server process, later deliveries send a 2-line digest (status() always returns the full text; template reload clears the delivered-set; same-session Revisit abbreviation takes precedence; start() no longer forces the full prompt so master `route` digests on repeat start() calls). Flagged: route, doc_sync, suggest_commit, reflection.evaluate, testing.assess — ~4-5k tokens saved per task after the first in a session
- templates: lint-review workflow — the trivial-change path (router-gated ≤2 files/≤50 lines) drops the 10-state file-review: the linter IS the review (collect paths → engine-run lint → act on findings + one intent re-read); wired as review_single in coding/bug-fix/code-review; registered in GLOBAL_WORKFLOWS
- skills: lang-haxe progressive-disclosure diet — body 49.8KB → 20.9KB by loudness criterion (silent-bug gotchas stay; loud compile traps → references/compile-traps.md, Strict null-safety cluster → references/null-safety.md, abstract-types cluster → references/abstracts.md; verbatim script-asserted lossless split, three imperative index blocks in the body)
- skills: hxq skill progressive-disclosure diet — body 81.5KB → 27.5KB (mutation-op contracts+caveats → references/ops.md, full lint semantics → references/lint.md, query recipes+nudges → references/queries.md; verbatim line moves, heading/line-reconstruction verified); body keeps gate rules, addressing, op index with imperative read-triggers and the three silent hazards (--write print-only, Edit-gate CRUD rule, --at --kind co-starting grab) — ~13k tokens saved per .hx-touching agent
- templates: cross_file states focus on seams BETWEEN batches + set-wide patterns (within-batch seams are each batch agent's job; set-wide checks apply even with one batch)
- skills+templates: global Agent-model policy — task-delegation gains a mandatory model table (pick by cost-of-error × mechanical safety net; sonnet for lint-covered/routine/locate/runner spawns, opus for macro-heavy/engine-critical/no-linter/judgement, opus wins on overlap, never haiku, never silent session-model inheritance); every spawn site across coding/bug-fix/testing/explore/web-research/planning names its default explicitly
- templates: review routing is size-based, not count-based — trivial (≤2 files AND ≤~50 lines to review; full scope measures the FILE, diff scope the diff) → inline self-review, everything else → batched agents even for a single batch (fresh eyes on the author's code + main-context offload); dispatchers must pass an explicit Agent `model` (sonnet for linter-covered/routine batches, opus for macro-heavy/no-linter; never haiku, never silent session-model inheritance)
- templates: review dispatchers batch files logically instead of one-agent-per-file — source+test together, change-coupling (hxq importers/callees for .hx), directory grouping, cap 5 files/~500 diff lines, oversized solo — amortizing each agent's fixed skill-load cost (~35-45k tokens) and putting coupled files in front of ONE reviewer; file-review consumes one file or a batch (space-separated `file_path`, per-file report sections + cross-file section), `hxq-lint-file.sh` lints a whole batch in one call (glob-safe: `set -f` held through the unquoted list expansion); applied to all three dispatchers (code-review, coding, bug-fix)
- templates: file-review checklist dedup vs the linter — build_checklist decides report usability ONCE (stale/failed-lint guards) and records `context.lint_subtraction`; check_style/check_loops guard their hardcoded lists on that flag, subtracting at rule-description granularity by `hxq lint --list-rules` (residues named: local-var annotations, beyond-threshold complexity judgments)

- engine: deliver hard-terminal state prompts — rendered and prepended (with `---` divider) to sub-workflow pop and root-completion output, so report contracts and push instructions actually fire
- engine: resolveSessionId throws on ambiguous ppid (multiple active sessions) listing candidates — parallel subagents must pass explicit session_id
- engine: add github-init to GLOBAL_WORKFLOWS; remove dead `needs_action` outcome from schema
- templates: full review pass over all 17 workflows — fail terminals everywhere (no dead on_fail edges), soft-terminal pattern for report/push states, skill gates (testing, debugging ?debug-bridge, web-research, reflection), session_id in all spawn preambles, background-by-default Agent tool guidance, subagent-context guards on clarify states, max_visits budget hints, secrets scan before commit/push, hunk-only revert guidance
- skills: sync all 20 bundled skills with live copies (architecture +10 sections, lang-haxe +20, domain-pixi +18 gotchas) and fix factual errors across build-cmake, ci-github-actions, aws-lambda, claude-code-config, domain-{reid,yolo,gamedev}, math, mcp-setup, workflow-authoring, web-reading, lang-{as3,python}, target-openfl-native; rewrite task-delegation for typed agents + background lifecycle
- skills: bundle 4 new — skill-manager, cleanup, ide-zed, debug-bridge-scaffold
- hooks: SessionStart branches on stdin `.source`; SessionEnd matcher no longer abandons sessions on /clear; safer temp-file writes; jq guard
- docs: README install channels, recommended CLAUDE.md snippet and permissions block (abort deliberately excluded)

## 0.1.8

- Cap retained terminal sessions via shared prunePolicy() — keep N most recently updated, delete older (Storage, InMemoryStorage, SessionEnd hook)
- engine: _pruneTerminal runs once after cascade (not per child), avoids quadratic scans
- prunePolicy: stable tiebreak by session_id, throws on negative keep, skips transient placeholders

## 0.1.7

- Expand bundled skills from 9 to 20 (lang-as3, target-openfl-native, domain-{yolo,pixi,reid,gamedev}, build-cmake, ci-github-actions, aws-lambda, mcp-setup, claude-code-config)
- Sync architecture (+7 sections) and lang-haxe (+650 lines on macros, null safety, hxcpp gotchas) with project-specific examples abstracted
- Update coding-skill-selector to map all bundled skills by extension/domain/tooling category
- Add Loader.validateSkillReferences() — checks required skills resolve in plugin/user/project skill dirs; logs missing on startup
- Mark debug-bridge as optional in bug-fix.yaml (not in bundle, prompt handles missing tooling)

## 0.1.6

- Add version consistency check in CI (package.json vs plugin.json)
- Automate release process: version bump triggers tag, GitHub Release, and npm publish
- Show available transitions in state output, simplify route prompt
- Add `include_workflows` state field and `DASHBOARD_HOST` config
- Add optional skills, exec improvements, `context_set`, and workflow fixes
- Restrict requirements state to user questions only

## 0.1.5

- Add action states (exec/fetch) for running shell commands and HTTP requests from workflows
- Add skill gate states with epoch-based freshness tracking
- Add session ownership guards and idempotent start for sub-agent safety
- Add force flag for cross-process session operations and auto-reap orphaned sessions
- Add test infrastructure with Vitest and dispatch chain tests
- Fix EPERM handling in PID-alive checks
- Remove vendored dagre.min.js, serve from node_modules
- Replace Russian text with English in dashboard

## 0.1.0

- Initial release
- FSM engine with stack-based sub-workflows
- YAML workflow definitions with Zod validation
- Session persistence with atomic writes and file locking
- Web dashboard with session visualization
- MCP server with stdio transport
- Claude Code plugin packaging
