---
name: workflow-authoring
description: Reference for authoring workflow YAML — state types, skill gates, exec/fetch action states, terminals, routing, and engine gotchas
---

## Workflow Authoring Reference

### Deployment & reload

- Bundled templates load from `templates/` next to the server's `build/` (i.e. `${CLAUDE_PLUGIN_ROOT}/templates`) — once, at server boot. Editing them does NOT hot-reload a running server.
- Load order (later overrides earlier by workflow name): bundled `templates/` → `~/.claude/workflows/` → project `.claude/workflows/`.
- `~/.claude/workflows/` and the project dir ARE fs.watch'ed; ANY `.yaml` change there triggers a FULL reload that also re-reads bundled templates. Hot-reload trick after editing bundled templates (no server restart): `echo "# t" > ~/.claude/workflows/_trigger.yaml && sleep 1 && rm ~/.claude/workflows/_trigger.yaml`, then verify via `list` (state counts change).
- Active sessions keep their definition snapshot; only NEW `start()` sessions see reloaded workflows.

### State Types

**prompt** (default) — Agent reads the prompt and acts. Standard behavior.

**exec** — Engine runs a shell command automatically. Agent doesn't participate.
```yaml
run_tests:
  type: exec
  command: "npm test"
  cwd: "{{context.cwd}}"
  timeout: 30000
  env:
    CI: "true"
  on_success: analyze
  on_error: fix
  success_prompt: "Tests passed:\n{{stdout}}"
  error_prompt: "Tests failed (exit {{exit_code}}):\n{{stderr}}"
  context_set:
    last_test_output: "{{stdout}}"
```

- `env:` — extra environment variables (map; values are templates), merged over the server's env
- `context_set:` — after the action **succeeds**, render each value with the action result vars and store it in session context (e.g. `last_test_output` above becomes `{{context.last_test_output}}` in later prompts). Skipped entirely on failure.

**fetch** — Engine makes an HTTP request automatically.
```yaml
check_api:
  type: fetch
  url: "http://localhost:8888/ping"
  method: GET
  timeout: 5000
  headers:
    Authorization: "Bearer {{context.token}}"
  body: '{"q": "{{context.query}}"}'
  retry:
    max: 60
    interval: 500
  on_success: ready
  on_error: wait
  success_prompt: "API ready: {{body}}"
  error_prompt: "Not responding: {{error}}"
```

- `headers:`/`body:` — templated; `body` is sent for all methods except GET/HEAD
- `retry:` is **fetch-only** — it is ignored on exec states
- Retries fire only on network errors/timeouts (connection refused, abort). A non-2xx HTTP **response** does not retry — it returns immediately and routes via `on_error`/`cases`
- `context_set:` works on fetch states too (e.g. `{"api_body": "{{body}}"}`)

**skills** — Skill gate. Checks if skills are loaded; blocks if not, auto-transitions if yes.
```yaml
load_skills:
  skills:
    - coding-skill-selector
    - "?project-skill-selector"
  transitions:
    continue: work
```

- Engine tracks loaded skills per session with epoch-based freshness
- First visit: prompts agent to call `Skill("X")` for each missing skill
- After loading + transition: skills marked as loaded for current epoch
- Subsequent visits: auto-transitions silently (agent sees nothing)
- After context clear/plan resume: epoch increments, skills reload on next gate
- `?`-prefix marks a skill **optional**: the gate lists it as "load if available, skip if not found" — use for project-local skills that may not be installed
- Skill gate states have `transitions` (unlike action states) — exactly **one**, conventionally named `continue`. The engine auto-takes the *first* transition when all skills are loaded, and its blocking prompt tells the agent "transition to continue", so any other name breaks the instruction

### Routing Modes

**Simple** — binary success/error:
```yaml
  on_success: target_if_ok
  on_error: target_if_fail
```

Define **both** routes on every action state. The engine throws at runtime ("Action state has no target for result") the moment an outcome occurs that has no route — an exec that "can't fail" will eventually fail.

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

Exec env always includes `WF_PLUGIN_ROOT` — the plugin root (dir holding
`templates/` and `scripts/`), resolved from the engine's own module location.
Reference bundled scripts as `command: "sh \"$WF_PLUGIN_ROOT/scripts/foo.sh\""`
— portable across install paths, no per-machine setup. A state's own `env:`
key of the same name overrides it.

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
- `timeout` is **ignored** on background exec — the process runs until it exits or the session is aborted
- Abort kills all background PIDs

### Terminal States & Outcomes

```yaml
report:
  prompt: "Write the final report per the contract above."
  task: "Final report"
  transitions:
    done: finish
finish:
  terminal: true
  outcome: complete   # or "fail"
```

- **Hard terminal** = `terminal: true` with no transitions. Entering it auto-pops the stack frame (sub-workflow returns to parent; root frame completes the session)
- A hard terminal's `prompt` **is delivered**: the engine renders it and prepends it to the pop/completion status, separated by a `---` divider — use it for final instructions (report contracts, push steps)
- `task:` on a hard terminal is **ignored** (the state is popped before a task op could be emitted). When you need a task op at the end, use the soft-terminal pattern above: a prompt state carrying the `prompt`/`task` with a `done` transition into a bare `finish` terminal
- **Soft terminal** = `terminal: true` WITH transitions: the session is marked finishable but stays in the state; the agent may re-enter/continue via its transitions
- **Outcome collapse on pop**: `outcome: fail` routes the parent to its `on_fail`; anything else (including omitted `outcome`) routes to `on_complete`. If the parent state lacks the needed route, the pop parks as pending (a `modify` adding the route resumes it)

### Common Patterns

**Decide once, flag in context**: when several states share one decision
(is the file user-authored? is the lint report usable?), have ONE state
evaluate it and `context_set` a verdict flag; downstream prompts guard on
`{{context.flag}}`. Re-stating the decision criteria in each consumer
drifts (guards diverge, agents re-evaluate inconsistently) — exactly the
bug class a single flag eliminates.

**Test-before-commit**: `exec(npm test)` → success → `exec(git commit)` → done

**Health check polling**: `fetch(url, retry: 60x500ms)` → success → interact

**Build-and-verify**: `exec(make, bg)` → `fetch(health, retry)` → ready

**Multi-step pipeline**: chain action states — exec → exec → fetch → prompt
(max chain depth: 20, no agent involvement between action states)

### Gotchas

- stdout/stderr truncated to `max_output` bytes (default 10KB, configurable per state). Truncation keeps the **tail** (last N bytes), not the head — errors at the end of output are preserved. Use higher values for verbose builds (e.g. `max_output: 51200`)
- Default timeout: 30s (exec), 5s (fetch)
- Exec timeout → SIGTERM to the process group (SIGKILL after 5s grace) and **exit code 124** — route `"124"` in `cases` to detect timeouts; `{{error}}` is "Process timed out"
- Action states CANNOT have `transitions` or `sub_workflow`
- Action states route via on_success/on_error or cases/default only
- `success_prompt`/`error_prompt` are templates, rendered with action result vars
- If neither prompt template is set, the next prompt state's own prompt is used
- Background processes are NOT monitored — use a subsequent fetch/exec to check
- **Template injection**: `{{...}}` values are substituted **unescaped** into `command:` and run via `sh -c`. A context value containing quotes, `$`, `;`, or backticks breaks the command — or executes as shell. Never interpolate untrusted/free-form context into commands; keep interpolated values to known-safe tokens (paths you set, enum-like flags). **Safe channel for everything else — `env:`**: env values are set on the process, never parsed by the shell, so `env: { REVIEW_FILE: "{{context.file_path}}" }` + `command: "script.sh \"$REVIEW_FILE\""` is injection-proof. Any AGENT-set context value (a `context_set` an agent made — e.g. a file path from a reviewed repo, where a hostile `$(cmd).hx` filename would otherwise execute) and even engine-set paths (`{{context.cwd}}` — a `$(payload)`-named directory) must go via `env:`, not into `command:`
- **Guards throw, they don't reroute**: exceeding a state's `max_visits` throws an error (the transition is refused); hitting `max_transitions` likewise throws
- `max_transitions` accounting is **per stack frame** — each sub-workflow push starts a fresh counter checked against that workflow's own `max_transitions` (default 50)
- **Duplicate YAML keys** — parser rejects the entire file with a `YAMLParseError`; the loader logs it to stderr and skips the file (workflow not loaded). Always validate YAML before deploying (no duplicate `success_prompt`, `error_prompt`, etc. on the same state)
- **Long-running commands** (dev servers, log tailers, watchers — anything that doesn't exit) — always use `background: true`. Foreground exec resolves on the child's `close` event, which fires only after the process exits **and** its stdio pipes close: a command that never exits blocks forever, and so does one that exits after handing its stdout to a still-running grandchild
- **Foreground build + background deploy** pattern: use foreground `build` (catches errors) then background `test/run` (streams logs), then poll readiness via `fetch` with retry
