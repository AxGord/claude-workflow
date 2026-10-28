---
name: claude-code-config
description: Claude Code configuration gotchas — permission rule syntax and evaluation order, settings hierarchy, plugin install scopes, hook behavior
---

# Claude Code Configuration Gotchas

## CLAUDE_CONFIG_DIR Partitions Session History — Symlink to Share It

`CLAUDE_CONFIG_DIR` is the ONLY knob for where transcripts live: the store is
hardcoded as `(CLAUDE_CONFIG_DIR ?? ~/.claude) + "/projects"`, and `/resume`
builds its list by walking that tree for `<projectKey>/<sessionId>.jsonl`.
Consequence: a wrapper script that exports a different `CLAUDE_CONFIG_DIR`
(the usual way to run several accounts side by side) gets its OWN session
history — a session started under one wrapper is invisible to `/resume` under
another. Not a bug, and no setting toggles it.

`CLAUDE_CODE_PROJECT_DIR_NAME` is NOT the escape hatch: it overrides only the
per-project SLUG inside `projects/` (validated against `^[A-Za-z0-9_-]{1,64}$`,
so it cannot hold a path), and it is read only when `CLAUDE_CONFIG_DIR` is set.

To share history across config dirs, symlink the storage directories to one
canonical `~/.claude`:

```sh
# merge first (session ids are UUIDs, so collisions are practically impossible)
rsync -a "$ALT/projects/" ~/.claude/projects/
mv "$ALT/projects" "$ALT/projects.bak" && ln -s ~/.claude/projects "$ALT/projects"
```

- `projects/` — transcripts (and `projects/<slug>/memory/`). Shareable, but
  needs the allow rules below.
- `plans/` — saved plan-mode files. Do NOT symlink it, and do not share it by
  any other means: `/resume` finds no `<slug>.md` in the local `plans/` and
  recovers the plan from the transcript (file snapshot or message history), so
  a real per-config-dir directory loses nothing. Tools that look for plans
  should use `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plans`. The `plansDirectory`
  setting cannot redirect it to a shared place: the value must resolve inside
  the project root.
- `history.jsonl` — prompt history (up-arrow). Shareable, but merge by sorting
  the union of lines on each record's `timestamp` field; blind concatenation
  leaves it out of order.
- `.claude.json` — holds `oauthAccount` and per-project trust. Per-account, do
  NOT share.

Two prerequisites, both easy to miss:
- **Kill every CLI using the directory first.** A live session holds an open fd
  on its `.jsonl`; swapping the directory for a symlink underneath it sends the
  rest of that session into the orphaned inode.
- Transcripts carry no owner field, so a session written under account A
  resumes under account B with no complaint — sharing merges the accounts'
  session lists by design.

### A symlinked subdir loses the built-in "own files" allowances

Claude Code lets its own files through without a prompt: plan files (read and
write), `projects/<slug>/<session>/tool-results/` (read — where oversized tool
outputs are persisted), `projects/<slug>/<session>/workflows/scripts/`
(write), and others. The check runs on EVERY form of the path, the original
and the symlink-resolved one, and each must pass. A resolved path is mapped
back to its root only when the ROOT itself (`$CLAUDE_CONFIG_DIR`, the cwd) is
the symlink — a symlinked SUBDIR such as `projects/ -> ~/.claude/projects`
resolves outside `$CLAUDE_CONFIG_DIR`, the allowance fails, and every such
access prompts (in `-p`, it is denied).

For a subdir that must stay shared (`projects/`), add allow rules to the
shared `settings.json` covering BOTH path forms — a rule on the resolved path
alone does not help, and `~/.claude-*` globs over several config dirs:

```json
"Read(//Users/me/.claude/**)",
"Read(//Users/me/.claude-*/projects/**)",
"Edit(//Users/me/.claude/projects/*/*/workflows/scripts/**)",
"Edit(//Users/me/.claude-*/projects/*/*/workflows/scripts/**)"
```

The two-form requirement and the glob were verified on the `Read` rule; the
`Edit` rules follow the same shape but were not exercised.

Anything else newly symlinked into a config dir needs the same audit. Test in
the alternate config dir, not the base one: in headless `-p`, have a
pre-approved command overflow its output (`seq 1 40000`), then `Read` the
persisted file, and check `permission_denials` in `--output-format json`.

### A `.claude` path segment makes every edit a sensitive-file prompt

Any write whose path, in ANY spelling (original or symlink-resolved), contains
a segment named exactly `.claude` (case-insensitive) fails a safety check:
`Claude requested permissions to edit <path> which is a sensitive file.` The
exemption for `.claude/skills|agents|commands` applies only in remote mode.
The check runs AFTER normal rule matching and is not bypassed by:
- allow rules in any settings file, including an exact `Edit(...)` rule;
- `--allowedTools`;
- a `PreToolUse` hook returning `permissionDecision: "allow"`.

What does get past it:
- a **session-scoped** rule, i.e. answering the prompt with "allow edits to
  skill X for this session". The CLI offers that only for
  `~/.claude/skills/<name>/` and `./.claude/skills/<name>/` spellings, so
  editing through an alternate config dir (`~/.claude-acc/skills/...`) gets
  one-shot prompts every time;
- a `PermissionRequest` hook returning
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
  — it answers the dialog, works in `default` and `auto` mode, and fires in
  `-p` too;
- keeping the file's real location out of any `.claude` segment. A segment
  like `.claude-acc` is not `.claude`, so for skills shared across config dirs
  put the store elsewhere (e.g. `~/dev/claude/skills`), symlink each config
  dir's `skills/` to it directly, and add `Edit`/`Read` allow rules for both
  the store and `~/.claude-*/skills/**`. The base `~/.claude/skills/...`
  spelling still contains `.claude`, so the base account keeps prompting.

## Permission Path Syntax (Critical)

**Single vs Double Slash**:
- `/path/to/file` = relative to settings file location
- `//path/to/file` = absolute filesystem path
- `~/path` = home directory (works in both)

**Common mistake**: Writing `Read(/tmp/**)` when you mean absolute path. Correct: `Read(//tmp/**)`.

**File-write rules use `Edit(...)`, never `Write(...)`**: file permission
checks match only `Edit(path)` rules — `Edit` covers all file-editing tools
(Write, Edit, NotebookEdit). A `Write(//tmp/**)` allow rule is dead and
Claude Code warns about it at startup. Correct: `Edit(//tmp/**)`.

**Pattern format must match tool signature**:
- Correct: `Read(//tmp/**)`, `Bash(npm run:*)`
- Wrong: `Read(file_path://tmp/**)` — tool name only, no parameter labels

**Bash rules use `:*` for prefix matching**: `Bash(npm run:*)` matches any command starting with `npm run `. `Bash(npm run *)` (space-star) is NOT the prefix syntax and matches unreliably.

## Wildcard Matching

**Recursive vs Single Level**:
- `*` = matches single path segment (e.g., `*.txt` in current dir only)
- `**` = matches recursively (e.g., `**/*.txt` in all subdirs)

**Edge case**: `Bash(ls *)` may not match `ls -la ~/.claude/` due to tilde expansion timing and wildcard evaluation order.

## Rule Evaluation Order

**Deny always wins**:
1. Deny rules checked first (block regardless of anything else)
2. Ask rules checked second (prompt user if matched)
3. Allow rules checked last (permit if matched)

**First match wins** within each category.

**Common mistake**: Adding allow rule but deny rule exists elsewhere (user settings, enterprise managed-settings.json, or higher in hierarchy). Deny always overrides allow, even if allow is more specific.

## Settings File Hierarchy (Highest to Lowest Priority)

1. Enterprise `managed-settings.json` (cannot be overridden)
2. Command-line flags (`--dangerously-skip-permissions`)
3. Project `.claude/settings.local.json` (gitignored, per-developer)
4. Project `.claude/settings.json` (versioned, shared with team)
5. User `~/.claude/settings.json` (global for your machine)

**Gotcha**: Local settings override shared settings. If permission works for you but not teammate, check if you have conflicting `.local` file.

## Known Bugs (as of 2026)

**Allow rules ignored**: Issue #18160 reports global allow permissions being ignored, requiring manual approval despite being in allowlist.

## Domain-Specific Rules

**WebFetch requires domain syntax**:
- Correct: `WebFetch(domain:example.com)`
- Wrong: `WebFetch(https://example.com/*)` — use domain prefix, not URL patterns

## Common Pitfalls

**Overly broad wildcards**: Starting with `Bash(*)` or `Read(**)` creates security holes. Be specific.

**Environment variables in Bash**: Don't persist between commands. Use the `env` map in settings.json or hooks instead.

**Testing permissions**: Use Shift+Tab to switch permission modes mid-session without editing files.

## Path Examples

```json
{
  "permissions": {
    "allow": [
      "Read(./config.json)",       // relative: config.json in settings file dir
      "Read(//tmp/**)",            // absolute: all files in /tmp
      "Read(~/.config/**)",        // home: all files in ~/.config
      "Read(**/config.json)",      // recursive: config.json anywhere in subtree
      "Bash(npm run:*)",           // command prefix matching (:* suffix)
      "WebFetch(domain:docs.anthropic.com)"  // domain-specific
    ],
    "deny": [
      "Read(**/secrets/**)",       // block entire directory tree
      "Bash(rm:*)"                 // block dangerous commands
    ]
  }
}
```

## Debugging Permission Issues

1. Check hierarchy: local > project > user > enterprise
2. Check rule order: deny → ask → allow (deny always wins)
3. Test pattern manually: Does it match the exact tool signature shown in prompt?
4. Check for known bugs (allow rules may be ignored — #18160)
5. Use `claude mcp list` to verify MCP server status if permission involves MCP tool

## Plugin Install Scope

`claude plugin install <pkg>@<marketplace>` (singular `plugin`, not `plugins`) takes `-s, --scope <user|project|local>` (default: `user`).

- `user` — global, ~/.claude/plugins/installed_plugins.json with `"scope": "user"`
- `project` — must run from within the target project dir; registry entry gets `"scope": "project"` + `"projectPath": "<cwd>"`. Plugin activates only when Claude Code runs inside that dir
- `local` — per-clone/session scope (rarely needed)

Swap scope = uninstall + reinstall (no in-place conversion):
```bash
claude plugin uninstall <pkg>@<mkt> --scope user
cd /path/to/project && claude plugin install <pkg>@<mkt> --scope project
```

All scopes share the same `~/.claude/plugins/cache/` payload — only the registry entry differs.

## Stop Hook Fires Per Turn, Not on Process Exit

**Wrong assumption**: `Stop` hook = "CLI process is shutting down / session ending".
**Correct**: `Stop` fires **each time the main agent finishes responding** (end of every turn). One CLI process lifetime can trigger it dozens of times. Docs: *"when Claude finishes responding"* — [docs.claude.com/en/docs/claude-code/hooks](https://docs.claude.com/en/docs/claude-code/hooks).

`SubagentStop` fires when a subagent (Task tool) finishes — separate from the main agent's Stop.

**Practical implication**: Any state registered on `UserPromptSubmit` and released on `Stop` churns every turn. For per-process state (e.g. a background daemon, a lock file, an IPC socket) key by **CLI PID** — `session_id` is wrong because it also changes on `/clear`, `/compact`, or resume within the same process.

```
UserPromptSubmit → fires before each user turn
Stop             → fires after each assistant response (not at exit)
SubagentStop     → fires when a Task-tool subagent completes
PostToolUse      → fires after each individual tool call within a turn
```

The full current hook event list is much longer than the four above — it also
includes `StopFailure`, `PostToolUseFailure`, `PostToolBatch`, `SubagentStart`,
`PostCompact`, `PermissionRequest`, `PermissionDenied`, `Setup`, `TeammateIdle`,
`TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`,
`ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`,
`CwdChanged`, `FileChanged`, `DirectoryAdded`, `MessageDisplay`,
`PreModelSwitch`, `PostModelSwitch`, `UserPromptExpansion`.

## Capturing a Real Hook Payload

To see the exact JSON a hook receives, run headless claude with a dump hook — faster and more reliable than docs or grepping the compiled CLI binary:

```bash
# settings.json: {"hooks":{"Stop":[{"hooks":[{"type":"command","command":"cat > /tmp/stop-payload.json"}]}]}}
printf 'start a background sleep 180 via Bash run_in_background, reply done' \
  | claude -p --settings settings.json --allowedTools "Bash(sleep:*)"
```

Gotchas:
- Pass the prompt via **stdin** — the argument form can fail with `Error: Input must be provided either through stdin or as a prompt argument` when a PreToolUse rewriter hook mangles quoting.
- A nested `claude -p --dangerously-skip-permissions` gets denied by the auto-mode classifier; a narrow `--allowedTools "Bash(<cmd>:*)"` passes.

## PostToolUse for Bash: the command's output lands in `stdout`, never `stderr`

A hook that reacts to what a command PRINTED must read `.tool_response.stdout`.
The Bash tool hands the hook ONE merged capture and files it under `stdout`, so
a command that wrote **only** to stderr still arrives with
`.tool_response.stderr` as an empty string. Reading stderr alone makes every such
command look silent and the hook fails quiet — no error, no output, just a hook
that never fires. Read both and concatenate.

Full key set for a Bash `PostToolUse` payload: `cwd`, `duration_ms`,
`hook_event_name`, `permission_mode`, `prompt_id`, `session_id`, `tool_input`,
`tool_name`, `tool_response`, `tool_use_id`, `transcript_path`; `tool_response`
= `{stdout, stderr, interrupted, isImage, noOutputExpected}`. `cwd` is the tool
call's working directory — resolve against it any relative path the command
printed, since the hook's own cwd is not guaranteed to match.

Two more things that bite a `matcher: "Bash"` PostToolUse hook:

- **It fires after EVERY bash command**, including the ones your own hook's work
  would trigger. Anything expensive needs an early exit that is pure shell
  string matching on the raw stdin, reached BEFORE the first `jq` — otherwise
  the cost lands on every command in the session. A
  `case "$input" in *marker*) ;; *) exit 0 ;; esac` costs ~5 ms including the
  process spawn; one `jq` invocation is an order of magnitude more.
  (A command the hook runs itself is a plain subprocess, not a Bash tool call,
  so it does NOT re-enter the hook — the recursion worry is misplaced, the
  per-command cost is the real one.)
- **`tool_response.stdout` may be TRUNCATED** by anything that post-processes
  tool output (an output-compressing wrapper hook, for instance), which
  substitutes a pointer to a full-output log. Never make a hook's only signal a
  line that could be scrolled out of the capture; cross-check it against
  `tool_input.command`.

- **`tool_response` is the tool's structured DATA, not the model-facing tool_result text.** A `run_in_background` Bash gives `{"stdout":"","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":false,"backgroundTaskId":"<id>"}`; the "Output is being written to: <path>" sentence exists ONLY in the tool_result the model sees, never in the hook payload. Monitor gives `{"taskId":"<id>","timeoutMs":300000,"persistent":false}`. Async Agent's model-facing text ("Async agent launched…") is likewise not the hook's shape. Never parse model-facing text from a hook payload; dump a real payload first (see "Capturing a Real Hook Payload").

**Hook edits take effect immediately.** A new entry added to a settings file
mid-session fires on the very next tool call — no restart, no `/hooks` visit.

## Stop Hook `background_tasks` (v2.1.145+)

Entry shape: `{"id","type","status","description"}` + type-specific fields (`command` for shell, `agent_type` for subagent, `server`/`tool` for MCP). `type` ∈ shell | subagent | monitor | workflow | teammate | cloud session | MCP task.

- `id` is stable across Stop firings; there are **NO timestamps** or turn counters. Distinguishing "started this turn" from "long-lived since an earlier turn" (dev server, watcher) requires persisting seen ids between Stop firings yourself (state file keyed by `session_id`).
- Non-empty `background_tasks` ≠ new work in progress: a persistent dev server stays listed at EVERY Stop — a hook that suppresses on non-empty silences itself for the whole session.
- Suppression heuristics must be TYPE-aware: `subagent`/`workflow` tasks always complete and re-invoke the main agent (their Stop is not the real finish), but `shell` tasks may NEVER complete (`npm run dev`) — a Stop with a freshly started shell task IS a real completion. "Started this turn ⇒ still working" is false for shell.
- Only live tasks are listed (completed ones are removed). `session_crons` entries are `{id,schedule,recurring,prompt}` (no `type`), so a `{"id":…,"type":` pattern cannot match them.
- Payload is compact JSON; keys come in schema order `id,type,status,description`, then the type-specific key (`command` shell, `agent_type` subagent, `server`/`tool` MCP, `name` workflow). Example: `{"id":"b4z5bg6o2","type":"shell","status":"running","description":"…","command":"python3 -m http.server 8765"}`.
- The built-in **Monitor tool's tasks are listed as `type:"shell"`** (internally a local shell task of kind monitor); `type:"monitor"` is only MCP/websocket monitors. To tell a Monitor apart, record its id at PostToolUse (see the PostToolUse section).
- A shell task's output file `<tmp>/claude-<uid>/<project-slug>/<session-id>/tasks/<id>.output` is held open by the TASK's own processes (its shell plus every child that inherited stdout, e.g. a server), NOT by the claude CLI. So `lsof -t <file>` yields the task's process tree (empty = finished), and `lsof -a -p <those pids> -iTCP -sTCP:LISTEN` spots a server. For async subagents the tasks dir holds `<agentId>.output` as a symlink to `<project>/<session-id>/subagents/agent-<agentId>.jsonl` (the subagent transcript).
- Subagent done-detection from that transcript: a finished subagent's last user/assistant line is its final assistant text, with `stop_reason:"end_turn"` often but frequently `null` (a streaming snapshot). "Done" = last assistant line has a text block and no tool_use block, and either `stop_reason` is a string other than `"tool_use"` or the file has been quiet ~1-2 min. Mid-message null text lines are followed by their tool_use line within milliseconds.
- `prompt_id` (v2.1.196+) identifies the current prompt; `last_assistant_message` (v2.1.145+) holds the final text.
- JSON string values escape quotes as `\"`, so a naive grep for `"key":"` cannot false-match text inside `command`/`description` values.

## Notification `idle_prompt` Ignores Background Work

The 60 s "Claude is waiting for your input" Notification (`notification_type: idle_prompt`) fires after a turn ends even while background tasks (subagents, bg shells) are still running. Its gate checks only isLoading, an open dialog, a pending /loop wakeup and an armed quota auto-resume. A hook treating any Notification as "session idle" will mis-release during background work; check `notification_type` and/or the last Stop's `background_tasks`.

## npx Argument Re-parsing Under PreToolUse Hooks

PreToolUse Bash hooks that rewrite commands can mis-parse `npx -y <pkg>@latest <subcmd>`, with `<pkg>@latest` landing as an **npm** subcommand, producing `Unknown command: "<pkg>@latest"`.

Workaround: invoke through a wrapper that bypasses the rewriter (e.g. an explicit `proxy` subcommand of the hook tool, or call the binary directly without `npx -y`). The same `npx` call may succeed via workflow-engine exec while failing via Bash tool — the difference is whether the hook intercepts.

## Multiple Hook Entries for the Same Event Run in Parallel

**Wrong assumption**: Two `PreToolUse` entries in `hooks.json` run in declaration order — first entry first, second entry second.
**Correct**: All entries for the same event fire **simultaneously**. Declaration order is not execution order.

**Race-condition trap**: If entry A writes a marker file and entry B deletes it, the outcome depends on timing, not position. A fast B (~0 ms) completes before a slow A (~30–50 ms), so A's delete wins even when B is declared last. Symptom: your write appears to have no effect.

**Fix**: One hook entry per event. Inspect stdin JSON inside that single script/command and branch on `tool_name` or other fields to dispatch logic. This guarantees deterministic ordering because it's a single process.

## Usage-Limit Stops: StopFailure, autoContinueAtUsageLimit, and the Session Messaging Socket

**Wrong assumption**: A turn that ends because the API itself returned an error (usage limit / 429, overloaded, auth, billing…) fires `Stop` or `Notification` like a normal turn end.
**Correct**: It fires **neither**. The only hook for it is `StopFailure` (v2.1.78+) — "runs instead of Stop when the turn ends due to an API error."

Payload = common fields (`session_id`, `transcript_path`, `cwd`, `hook_event_name`) plus:
- `error` ∈ `rate_limit | overloaded | authentication_failed | oauth_org_not_allowed | account_on_hold | billing_error | invalid_request | model_not_found | server_error | max_output_tokens | unknown`
- optional `error_details`
- optional `last_assistant_message` — the rendered error text shown to the user, e.g. `You've hit your session limit · resets 4:30pm (Europe/London)` (weekly form: `resets Sep 9 at 3pm (…)`)

The hook `matcher` filters on the `error` value — `"matcher": "rate_limit"` fires only for limit stops, no payload parsing needed in the script.

The CLI **ignores the hook's output and exit code** — `StopFailure` is notification-only, it cannot block, continue the turn, or inject a prompt. (`decision: "block"` to keep a turn going only works for `Stop`/`SubagentStop`.) No hook can start a new turn by itself.

**StopFailure fires per SUBAGENT too.** Every subagent rejected on the limit fires its own `StopFailure` (`matcher: "rate_limit"` matches it), and its payload carries `agent_id` + `agent_type`; the main agent's payload has neither. A notify-on-limit hook that ignores this alerts once per running subagent. Filter on `"agent_id":"` in the payload (string values escape quotes as `\"`, so a quoted key inside a message cannot false-match).

**Wrap-up allowance** (v2.1.277+): when the 5-hour limit is hit mid-response, the CLI may let the turn finish. It appends a meta user line to the transcript — `"isMeta":true,"turnCompanion":true,"usageLimitNote":"wrap_up"` with the turn's `"promptId":"…"` — and the wrapped-up turn ends with a normal **`Stop`, not `StopFailure`**. Other `usageLimitNote` values: `near_limit` (approaching the limit, not a stop) and `release` (limit lifted after a `wrap_up`). To recognise a wrap-up stop in a Stop hook: payload `prompt_id` equals the transcript's `promptId`; take the LAST `usageLimitNote` among that prompt's lines and check it is `wrap_up`. Subagents keep running through the wrap-up and are rejected individually later.

File-level marker for the same event (useful when no hook was configured, or when scanning history after the fact): the transcript line is a synthetic assistant message with top-level `"isApiErrorMessage": true`.

**`autoContinueAtUsageLimit`** (v2.1.234+, standard settings.json hierarchy; key **absent ⇒ enabled** for claude.ai logins): on hitting the 5-hour limit the CLI shows `Usage limit reached · continuing automatically at HH:MM · esc to cancel`, waits, and re-prompts itself once the limit resets. Toggle via `/config` ("Continue automatically at usage limit"), or arm/disarm a single instance via `/rate-limit-options`.
- Re-arms at most twice in a row.
- Not available for `-p`, background sessions, or API-key auth.
- Covers the 5-hour limit only — not the weekly limit.
- Only fires if the machine is awake at the reset time.
- Arming has open bug reports (a limit hit while inside a background-agent/task-notification turn may not arm) — confirm with the on-screen "continuing automatically" line rather than assuming it armed.

**Session messaging socket**: every child process of a session — hook scripts and Bash tool commands included — inherits `CLAUDE_CODE_MESSAGING_SOCKET=/tmp/cc-socks/<cli-pid>.sock`, `CLAUDE_CODE_MESSAGING_TOKEN=<32 hex>`, and `CLAUDE_CODE_SESSION_ID`. This is the internal Unix-socket channel behind cross-session `SendMessage` / Remote Control (internally "uds-messaging", peer protocol 1 — undocumented, may change without notice). Two newline-terminated JSON lines inject a prompt into that session:

```sh
{ echo '{"type":"auth","token":"'"$CLAUDE_CODE_MESSAGING_TOKEN"'"}';
  echo '{"type":"user","message":{"role":"user","content":"hello"}}'; } \
  | nc -U -w 2 "$CLAUDE_CODE_MESSAGING_SOCKET"
```

An idle session starts a turn on it; the message is enqueued in the transcript immediately, labelled as a message from another Claude session (peer) — never as the user's own typing. Peer tokens for *other* sessions live at `~/.claude/sessions/<pid>.<sha256>.key` (mode 600, readable only by the same OS user).

Gotchas:
- The auto-mode permission classifier **blocks** any Bash command that writes to a real `/tmp/cc-socks/*.sock` path even after the user approves it in chat — test against a fake `AF_UNIX` listener on a scratch path instead, or have the user run the command themselves via the `!` prefix (the env vars are present in that shell too).
- Keep the socket path under 104 bytes (`sockaddr_un` limit).
- Escape `\` and `"` when interpolating the token or message content into the JSON frames.

**Built-in sleep prevention**: on macOS the CLI itself spawns `caffeinate -i -t 300` as a child of `claude`, re-spawned roughly every 4 minutes while a turn is running and killed when the turn ends. It shows up in `pmset -g assertions` / `pmset -g log` as short-lived caffeinate assertions — not a plugin or hook leak. It does **not** cover an `autoContinueAtUsageLimit` wait: the Mac can still sleep before the scheduled reset.

**Limit options dialog** ("What do you want to do? 1. Stop and wait for limit to reset…"): auto-opened when the main agent's rate-limit error message renders, at most once per limit reset, and NOT when auto-continue is armed (5-hour limit with `autoContinueAtUsageLimit` on shows the "continuing automatically" notice instead). The main agent's `StopFailure` fires in the same millisecond as the dialog appears — no hook is gated on the user's choice.

**Reproducing a limit stop without hitting a real limit**: run the interactive CLI in a PTY (Python `pty.fork`) with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` pointing at a stub that answers `POST /v1/messages*` with HTTP 429, body `{"type":"error","error":{"type":"rate_limit_error",…}}`, and headers `anthropic-ratelimit-unified-status: rejected`, `anthropic-ratelimit-unified-reset: <epoch>`, `anthropic-ratelimit-unified-representative-claim: five_hour|seven_day`, `x-should-retry: false`. The OAuth login stays in effect, so the claude.ai limit UI (dialog / auto-continue notice) renders and `StopFailure` fires with a real payload. Pass hooks via `--settings <file>` that log hook timestamps; put a logging stub of the sound player first in `PATH` to see when it starts. Set `"autoContinueAtUsageLimit": false` or use `seven_day` to get the dialog. A wrap-up allowance cannot be mocked this way (it is driven by grace headers on successful responses).

**Method**: none of the above is documented; all of it is in the shipped binary. `strings ~/.local/share/claude/versions/<version> > /tmp/cc.txt`, then `LC_ALL=C /usr/bin/grep -F` or a Python `re.finditer` with ±300-char context turns up hook event lists, zod-like payload schemas (`hook_event_name:x("StopFailure"),error:…`), settings keys with their defaults, and internal protocol strings — the binary is consistently ahead of the docs. Never `cat` the dump (tens of MB). To date a feature, pull the changelog and search it: `gh api repos/anthropics/claude-code/contents/CHANGELOG.md -H "Accept: application/vnd.github.raw" | grep -n <term>`, then take the nearest `## <version>` header above the hit.

## statusLine Payload: Undocumented Optional Keys

Beyond the documented `model`/`workspace`/`context_window`/`cost`/`output_style`, the
stdin JSON carries optional keys that are simply ABSENT when not applicable —
always read them with `// empty` and branch on non-empty:

- `effort.level` — `"low" | "medium" | "high" | "max"` (`xhigh` on models that support it); present only for effort-capable models
- `thinking.enabled`, `fast_mode`, `exceeds_200k_tokens`
- `rate_limits.{five_hour,seven_day,spend_limit}.{used_percentage,resets_at}` — `resets_at` is a unix epoch
- `vim.mode`, `agent.name`, `session_name`, `remote.session_id`, `pr.{number,url,review_state,kind}`, `worktree.{name,path,...}`

Quick test without a live session: pipe a hand-written JSON into the script
and check both the with-key and without-key renders.

**Subscription tier is NOT in the payload** — read it from the local account
cache instead: `${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json` →
`.oauthAccount.organizationRateLimitTier` (`default_claude_max_5x` /
`default_claude_max_20x`; Team orgs carry an opaque name like `default_raven`
— fall back to `.oauthAccount.organizationType` ∈ `claude_max | claude_team |
claude_pro`). The statusline command is a child of the CLI, so it inherits
`CLAUDE_CONFIG_DIR` and resolves the right account automatically.
