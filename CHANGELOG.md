# Changelog

## 0.1.9

- engine: every exec state gets `WF_PLUGIN_ROOT` in its env (plugin root, resolved from the executor module's own location) — templates reference bundled scripts portably (`sh "$WF_PLUGIN_ROOT/scripts/foo.sh"`), no per-machine script installation; a state's own `env:` can override it
- templates: master.yaml starts with a `scan_project` exec state — engine-run project language scan (bundled `scripts/scan-project.sh`) whose per-extension menu (+ tool probes, e.g. `hx … (hxq OK)`) renders in the route prompt via `context.project_langs`; skill selectors pick from the menu instead of re-scanning (empty menu → manual fallback)
- templates: file-review.yaml gains engine-run mechanics — `probe_hxq` exec (tool availability → `context.hxq_available`, consumed by a read_context top-up instruction) and `mechanical_pass` exec (bundled `scripts/hxq-lint-file.sh` on the reviewed file → `context.lint_report`); build_checklist carries lint findings as facts, drops linter-covered rules from the manual checklist (stale-report guard via `===` file headers), keeping only judgment rules
- templates: exec states pass agent/context-derived values via `env:` (not template interpolation into `sh -c`) — a `$(cmd)`-named directory or reviewed file cannot execute
- skills: coding-skill-selector reworked to menu-driven selection — pick languages the task touches from the engine scan, tool-bound skills (hxq) load only when the menu marks the tool available (or a probe succeeds), top-up rule for mid-task language widening
- skills: anti-drift for bundled snapshots — `scripts/check-skill-sync.sh` diffs `templates/skills/*` against the live `~/.claude/skills/*` (same-named pairs; `.skillsyncignore` lists intentional divergence like the generic coding-skill-selector), wired as a local git pre-commit hook so a stale snapshot can't be committed; every silently-drifted bundled skill re-synced from live; skill-manager checklist now requires copying every live-skill edit onto the bundled twin
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
