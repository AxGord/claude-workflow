---
name: workflow-authoring
description: Reference for creating workflows with exec/fetch action states
---

## Workflow Authoring Reference

### State Types

**prompt** (default) — Agent reads the prompt and acts. Standard behavior.

**exec** — Engine runs a shell command automatically. Agent doesn't participate.
```yaml
run_tests:
  type: exec
  command: "npm test"
  cwd: "{{context.cwd}}"
  timeout: 30000
  on_success: analyze
  on_error: fix
  success_prompt: "Tests passed:\n{{stdout}}"
  error_prompt: "Tests failed (exit {{exit_code}}):\n{{stderr}}"
```

**fetch** — Engine makes an HTTP request automatically.
```yaml
check_api:
  type: fetch
  url: "http://localhost:8888/ping"
  method: GET
  timeout: 5000
  retry:
    max: 60
    interval: 500
  on_success: ready
  on_error: wait
  success_prompt: "API ready: {{body}}"
  error_prompt: "Not responding: {{error}}"
```

**skills** — Skill gate. Checks if skills are loaded; blocks if not, auto-transitions if yes.
```yaml
load_skills:
  skills:
    - coding-skill-selector
    - preferences
  transitions:
    continue: work
```

- Engine tracks loaded skills per session with epoch-based freshness
- First visit: prompts agent to call `Skill("X")` for each missing skill
- After loading + transition: skills marked as loaded for current epoch
- Subsequent visits: auto-transitions silently (agent sees nothing)
- After context clear/plan resume: epoch increments, skills reload on next gate
- Skill gate states have `transitions` (unlike action states)
- Typically one transition (`ready`) pointing to the next work state

### Routing Modes

**Simple** — binary success/error:
```yaml
  on_success: target_if_ok
  on_error: target_if_fail
```

**Cases** — route by exit code (exec) or HTTP status (fetch):
```yaml
  cases:
    "0": all_passed
    "1": tests_failed
    "2": no_tests_found
  default: unknown_error   # required with cases
```

Cases overrides on_success/on_error when both are present.

### Template Variables

Available in ALL prompts (not just action states):
- `{{context.cwd}}` — working directory
- `{{context.<key>}}` — any context value set via context_set

After exec/fetch, also available:
- `{{stdout}}`, `{{stderr}}`, `{{exit_code}}` — exec results
- `{{status}}`, `{{body}}` — fetch results
- `{{error}}` — error message (both types)
- `{{pid}}` — PID for background exec

Templates are single-pass, no recursion. `undefined` → empty string.

### Background Exec

```yaml
start_build:
  type: exec
  command: "make build"
  background: true
  on_success: poll_ready
  on_error: build_failed
```

- Process runs detached, PID saved in `session.background_pids`
- stdout/stderr go to a temp log file
- `on_success` fires immediately (process started OK)
- Abort kills all background PIDs

### Common Patterns

**Test-before-commit**: `exec(npm test)` → success → `exec(git commit)` → done

**Health check polling**: `fetch(url, retry: 60x500ms)` → success → interact

**Build-and-verify**: `exec(make, bg)` → `fetch(health, retry)` → ready

**Multi-step pipeline**: chain action states — exec → exec → fetch → prompt
(max chain depth: 20, no agent involvement between action states)

### Exec Options

- `max_output` — truncation limit in bytes (default 10KB). Truncation keeps the **tail** (last N bytes), not the head. Use higher values for verbose builds (e.g. Android: `max_output: 51200`).
- `background: true` — stdout/stderr go to a temp log file (no pipe issues). `on_success` fires immediately.

### Gotchas

- stdout/stderr truncated to `max_output` bytes (default 10KB, configurable per state)
- Truncation keeps the **tail** — errors at the end of output are preserved
- Default timeout: 30s (exec), 5s (fetch)
- Action states CANNOT have `transitions` or `sub_workflow`
- Action states route via on_success/on_error or cases/default only
- `success_prompt`/`error_prompt` are templates, rendered with action result vars
- If neither prompt template is set, the next prompt state's own prompt is used
- Background processes are NOT monitored — use a subsequent fetch/exec to check
- **Duplicate YAML keys** — parser rejects the entire file with a `YAMLParseError`; the loader logs it to stderr and skips the file (workflow not loaded). Always validate YAML before deploying (no duplicate `success_prompt`, `error_prompt`, etc. on the same state)
- **Long-running commands with child processes** (e.g. `adb logcat`, `openfl test android`) — these never exit while the app runs. Always use `background: true` for such commands. Foreground exec waits for process exit, not pipe close — but if the main process itself doesn't exit, it blocks forever
- **Foreground build + background deploy** pattern: use foreground `build` (catches errors) then background `test/run` (streams logs), then poll readiness via `fetch` with retry
