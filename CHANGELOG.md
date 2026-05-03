# Changelog

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
