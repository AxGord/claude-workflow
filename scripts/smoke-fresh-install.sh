#!/bin/bash
# smoke:fresh — what a NEW user gets: a fresh clone of this repo at HEAD, installed and built from nothing, then
# every command the README and docs/getting-started.md tell a reader to type that does not need Claude Code,
# run in a temporary HOME against a temporary empty git project.
#
# Usage: [bash] scripts/smoke-fresh-install.sh [--source DIR] [--npm-cache DIR] [--keep]      (npm run smoke:fresh)
#   --source DIR     the repository to clone (default: the one this script is in); its HEAD, never its working tree
#   --npm-cache DIR  reuse an npm cache (default: an empty one inside the temp dir: the download a new user pays)
#   --keep           leave the temp dir (clone, HOME, project, logs) and print where it is
#
# THE PATH, in order. Each step prints one `PASS`/`FAIL` line with its reason; a FAIL does not stop the steps
# that do not depend on it, but clone, install and build failing end the run (nothing after them can run).
#   clone      `git clone` of the source: committed files only, so nothing uncommitted leaks in
#   install    `npm ci` (the registry, cold cache) and `npm run build`
#   manifest   plugin.json, marketplace.json, .mcp.json, package.json agree; hook files are executable
#   npm-pack   `npm pack --dry-run`: the package carries build/, templates/, hooks/, dashboard/, scripts/
#   git-channel  what a git-sourced install (the community catalog, this repository as a marketplace) gets: master
#              carries no build/ (it must not), `scripts/release-tree.sh --dir` assembles the release tree, which
#              is copied as a plugin cache holds it (no node_modules), `npm ci --omit=dev --ignore-scripts` runs
#              as Claude Code runs it (its time is printed against the 60 s limit), and the server of the tree's
#              .mcp.json answers an MCP handshake (`release-start`)
#   hook       the SessionStart hook as Claude Code runs it (executed directly, stdin = the event JSON,
#              cwd = the project, CLAUDE_PLUGIN_ROOT = the clone): its output, the skills it provisions
#   wf-skills  list, add a stack skill
#   path-link  the four wf-* commands the docs tell the reader to type, linked onto PATH (an install does not)
#   mcp-*      the MCP server over stdio (the SDK's client): list, start master / batch, the README and
#              getting-started workflows (hello, ship: untrusted, then trusted) run to their ends
#   dashboard  one GET against the server's dashboard (a free port, never the live 3100)
#   wf-run     the pool CLI against the temp pool: --status, a lease around a command, --usage
#   wf-queue   getting-started's demo queue: --add, --batch-size, --dry-run --explain, as the page prints them
#   uninstall  `wf-skills remove --state` (what README's "To remove it" says): nothing of the engine stays
#   claude-plugin-cli  `claude plugin marketplace add <the clone>` + `install workflow@claude-workflow` under a
#              temp CLAUDE_CONFIG_DIR, when `claude` is on PATH (SKIP otherwise); no session, no model call
#   isolation  the real ~/.claude, listed before and after, compared (below)
#
# WHAT `fresh` ISOLATES. Every child runs under `env -i` with HOME, TMPDIR, STATE_DIR, WF_POOL_DIR, the npm cache
# and DASHBOARD_PORT inside one temp dir (mktemp -d under $TMPDIR): none of the caller's WF_*, CLAUDE_*,
# STATE_DIR, WORKFLOW_DIR, no global git config reaches it, and the live pool, the live dashboard and every live
# session are never addressed. The real ~/.claude (or $CLAUDE_CONFIG_DIR) is listed (paths) before and after and
# compared. A live Claude Code session writes there all the time, so the verdict is two-tier: a change in a path
# the engine owns (skills/, workflows/, workflow-state/skills, skill-backups, trusted-workflows.json,
# workflow-pool/config.yaml) or in a file named after a session this run started, or a pool entry carrying this
# run's lease label, FAILs; every other change is only counted (it is a live session's, this run cannot tell).
# WHAT IT CANNOT: a real Claude Code process (the plugin marketplace, /plugin install, the hooks Claude Code
# itself dispatches, the plan pane, the folder-trust dialog — the trust answer is written the way Claude Code
# writes it, not obtained), and it proves nothing about files outside ~/.claude (the npm cache is the temp one).
#
# EXITS. 0 every step PASS (WARN lines do not count) · 1 at least one FAIL · 2 usage, or a prerequisite missing
# (node >= 22, git, npm, a git source) before anything was made · 130 interrupted (INT, TERM, HUP).
# CLEANUP. One EXIT trap removes the temp dir (not with --keep) after killing the process GROUP of the step that
# is running (every step is its own group: `set -m`, so npm's children and the MCP server die with it), on a
# FAIL exit, on Ctrl-C and on a signal alike. A step that cannot be killed gets KILL after a second.
#
# TEST HOOK (unit tests only, src/smoke-fresh-install*.test.ts). SMOKE_INSTALL_CMD and SMOKE_BUILD_CMD replace the
# command of the install and the build step (a shell string, run by `bash -c` in the clone, under `fresh`): the
# script's own contract (exits, the step's process group, cleanup, isolation) is then pinned without a registry or
# a real build, whose outcome under a loaded host is not the script's. A stubbed build is not required to leave
# build/index.js, and the step's PASS/FAIL line names the variable. The real run never sets them.
#
# Env: SMOKE_STEP_TIMEOUT (seconds per step, default 600); SMOKE_INSTALL_CMD, SMOKE_BUILD_CMD (the test hook above).

# Bash, always: the per-step process group needs job control, which a dash `sh` without a tty (Ubuntu CI) lacks.
[ -n "$BASH_VERSION" ] || exec bash "$0" "$@"

here=$(cd "$(dirname "$0")" && pwd) || exit 2
SRC=$(cd "$here/.." && pwd)
KEEP=0
NPM_CACHE=
while [ $# -gt 0 ]; do
  case $1 in
    --source) [ $# -ge 2 ] || { echo "smoke:fresh: --source needs a directory" >&2; exit 2; }; SRC=$2; shift 2 ;;
    --npm-cache) [ $# -ge 2 ] || { echo "smoke:fresh: --npm-cache needs a directory" >&2; exit 2; }; NPM_CACHE=$2; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,/^# Env:/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "smoke:fresh: unknown argument $1 (see --help)" >&2; exit 2 ;;
  esac
done

for tool in node git npm find sort comm mktemp; do
  command -v "$tool" >/dev/null 2>&1 || { echo "smoke:fresh: $tool is not on PATH" >&2; exit 2; }
done
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || { echo "smoke:fresh: node >= 22 is required (package.json engines)" >&2; exit 2; }
[ -n "$HOME" ] && [ -d "$HOME" ] || { echo "smoke:fresh: HOME is not a directory" >&2; exit 2; }
git -C "$SRC" rev-parse --verify -q HEAD >/dev/null 2>&1 \
  || { echo "smoke:fresh: $SRC is not a git repository with a commit" >&2; exit 2; }

REAL_HOME=$HOME
REAL_CLAUDE=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
REAL_POOL=$HOME/.claude/workflow-pool
T=$(mktemp -d "${TMPDIR:-/tmp}/wf-smoke-fresh.XXXXXX") || exit 2
T=$(cd "$T" && pwd -P)
CLONE=$T/clone PROJ=$T/project FHOME=$T/home LOGS=$T/logs FTMP=$T/tmp
STATE=$FHOME/.claude/workflow-state POOL=$FHOME/.claude/workflow-pool
mkdir -p "$PROJ" "$FHOME" "$LOGS" "$FTMP" || exit 2
CACHE_GIVEN=$NPM_CACHE
[ -n "$NPM_CACHE" ] || NPM_CACHE=$T/npm-cache
TAG=smoke-fresh-$$
PASSED=0 FAILED=0 WARNED=0 CHILD= SNAPPED=0 DONE=0
START=$(date +%s)

# killgroup SIGNAL PID: the process group PID leads (every step runs under `set -m`), else the process alone
killgroup() { kill -s "$1" -- "-$2" 2>/dev/null || kill -s "$1" "$2" 2>/dev/null; }

cleanup() {
  if [ -n "$CHILD" ]; then
    killgroup TERM "$CHILD"
    sleep 1
    killgroup KILL "$CHILD"
    CHILD=
  fi
  if [ "$KEEP" = 1 ]; then
    echo "smoke:fresh: kept $T"
  else
    [ -n "$T" ] && [ -d "$T" ] && rm -rf "$T"
  fi
}
trap cleanup EXIT
trap 'echo "smoke:fresh: interrupted; the isolation check was not run" >&2; exit 130' INT TERM HUP
# Every step is its own process group: prove job control works here, or end (exit 2) before any step runs.
set -m || { echo "smoke:fresh: job control (set -m) is not available in this shell" >&2; exit 2; }
sleep 30 &
_probe=$!
_pg=$(ps -o pgid= -p "$_probe" 2>/dev/null | tr -d ' ')
kill "$_probe" 2>/dev/null
wait "$_probe" 2>/dev/null
[ "$_pg" = "$_probe" ] || { echo "smoke:fresh: a background step does not lead its own process group (job control is off): cannot kill a step's children" >&2; exit 2; }

pass() { PASSED=$((PASSED + 1)); printf 'PASS  %s: %s\n' "$1" "$2"; }
skip() { printf 'SKIP  %s: %s\n' "$1" "$2"; }
warn() { WARNED=$((WARNED + 1)); printf 'WARN  %s: %s\n' "$1" "$2"; }
fail() {
  FAILED=$((FAILED + 1))
  printf 'FAIL  %s: %s\n' "$1" "$2"
  [ -z "$3" ] || [ ! -s "$3" ] || tail -n 12 "$3" | sed 's/^/        | /'
}

# The environment of everything the new user would run: nothing of the caller's, but PATH.
fresh() {
  env -i PATH="$PATH" HOME="$FHOME" TMPDIR="$FTMP" STATE_DIR="$STATE" WF_POOL_DIR="$POOL" \
    DASHBOARD_PORT="$PORT" npm_config_cache="$NPM_CACHE" npm_config_update_notifier=false \
    npm_config_audit=false npm_config_fund=false "$@"
}

# runlog LOG CMD…: CMD in its own process group, output to LOG, stdin RUN_IN; sets RC. A group that outlives
# SMOKE_STEP_TIMEOUT is killed (RC 124); a signal to this shell runs the EXIT trap, which kills the group.
RUN_IN=/dev/null
runlog() {
  _log=$1
  shift
  "$@" <"$RUN_IN" >"$_log" 2>&1 &
  CHILD=$!
  ( _n=0; while kill -0 "$CHILD" 2>/dev/null; do
      _n=$((_n + 1)); [ "$_n" -ge "${SMOKE_STEP_TIMEOUT:-600}" ] && { killgroup TERM "$CHILD"; sleep 1; killgroup KILL "$CHILD"; exit 0; }
      sleep 1
    done ) &
  _wd=$!
  wait "$CHILD"
  RC=$?
  kill "$_wd" 2>/dev/null
  wait "$_wd" 2>/dev/null
  CHILD=
  [ "$RC" -lt 137 ] || [ "$RC" -gt 143 ] || RC=124
}

# in_dir DIR CMD…: CMD in the fresh environment, in DIR
in_dir() { _d=$1; shift; cd "$_d" && fresh "$@"; }

# snapshot OUT: every path under the real ~/.claude, sorted.
snapshot() { find "$REAL_CLAUDE" -xdev \( -type f -o -type d \) -print 2>/dev/null | sort >"$1"; }

# esc PATH: PATH as an extended-regex literal
esc() { printf '%s' "$1" | sed 's/[][\.*^$(){}?+|]/\\&/g'; }

isolation() {
  [ "$SNAPPED" = 1 ] || return 0
  snapshot "$T/after.txt"
  comm -13 "$T/before.txt" "$T/after.txt" >"$T/added.txt"
  comm -23 "$T/before.txt" "$T/after.txt" >"$T/removed.txt"
  find "$REAL_CLAUDE" -xdev -type f -newer "$T/marker" -print 2>/dev/null | sort >"$T/modified.txt"
  cat "$T/added.txt" "$T/removed.txt" "$T/modified.txt" | sort -u >"$T/changed.txt"
  # Anchored at the config dir's root: a live session's write to a nested skills/ (plugins/cache/**/skills) is not ours.
  root="($(esc "$REAL_CLAUDE")|$(esc "$REAL_HOME/.claude"))"
  owned="^$root/(skills|workflows|workflow-state/skills|workflow-state/skill-backups)(/|\$)|^$root/workflow-state/trusted-workflows\\.json\$|^$root/workflow-pool/config\\.yaml\$"
  grep -E "$owned" "$T/changed.txt" >"$T/leak.txt"
  if [ -s "$T/sids.txt" ]; then
    # shellcheck disable=SC2046
    grep -F $(sed 's/^/-e /' "$T/sids.txt") "$T/changed.txt" >>"$T/leak.txt"
  fi
  [ ! -d "$REAL_POOL" ] || grep -rlF -- "$TAG" "$REAL_POOL" 2>/dev/null >>"$T/leak.txt"
  others=$(grep -vxFf "$T/leak.txt" "$T/changed.txt" | wc -l | tr -d ' ')
  if [ -s "$T/leak.txt" ]; then
    fail isolation "the run wrote into the real $REAL_CLAUDE ($(wc -l <"$T/leak.txt" | tr -d ' ') paths)" "$T/leak.txt"
  else
    pass isolation "no engine-owned path, session file or pool entry of this run in $REAL_CLAUDE ($(wc -l <"$T/before.txt" | tr -d ' ') paths before, $others changed elsewhere: a live session's)"
  fi
}

finish() {
  isolation
  DONE=1
  _s=$(($(date +%s) - START))
  printf 'smoke:fresh: %s passed, %s failed, %s warnings in %ss (source %s @ %s)\n' \
    "$PASSED" "$FAILED" "$WARNED" "$_s" "$SRC" "$(git -C "$SRC" rev-parse --short HEAD)"
  [ "$FAILED" -eq 0 ] && exit 0
  exit 1
}

# end the run at once: a step nothing after can run without
stop() { fail "$1" "$2" "$3"; finish; }

PORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})') \
  || { echo "smoke:fresh: no free port" >&2; exit 2; }
snapshot "$T/before.txt"
: >"$T/marker"
: >"$T/sids.txt"
SNAPPED=1
echo "smoke:fresh: $T (HOME $FHOME, dashboard port $PORT)"

# --- clone ------------------------------------------------------------------------------------------------
dirty=$(git -C "$SRC" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
runlog "$LOGS/clone.log" fresh git clone --quiet "$SRC" "$CLONE"
[ "$RC" -eq 0 ] || stop clone "git clone of $SRC exited $RC" "$LOGS/clone.log"
head=$(git -C "$CLONE" rev-parse HEAD)
[ "$head" = "$(git -C "$SRC" rev-parse HEAD)" ] || stop clone "the clone is at $head, not the source's HEAD" ""
pass clone "HEAD $(echo "$head" | cut -c1-9) of $SRC"
[ "$dirty" -eq 0 ] || warn clone "$dirty uncommitted paths in the source: commit them to have them smoked"

# --- install, build ---------------------------------------------------------------------------------------
t0=$(date +%s)
if [ -n "$SMOKE_INSTALL_CMD" ]; then
  runlog "$LOGS/install.log" in_dir "$CLONE" bash -c "$SMOKE_INSTALL_CMD"
  [ "$RC" -eq 0 ] || stop install "SMOKE_INSTALL_CMD exited $RC" "$LOGS/install.log"
  pass install "SMOKE_INSTALL_CMD (a test hook) in $(($(date +%s) - t0))s"
else
  runlog "$LOGS/install.log" in_dir "$CLONE" npm ci
  [ "$RC" -eq 0 ] || stop install "npm ci exited $RC" "$LOGS/install.log"
  pass install "npm ci in $(($(date +%s) - t0))s, $(find "$CLONE/node_modules" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ') top-level packages"
fi
t0=$(date +%s)
if [ -n "$SMOKE_BUILD_CMD" ]; then
  runlog "$LOGS/build.log" in_dir "$CLONE" bash -c "$SMOKE_BUILD_CMD"
  [ "$RC" -eq 0 ] || stop build "SMOKE_BUILD_CMD exited $RC" "$LOGS/build.log"
  pass build "SMOKE_BUILD_CMD (a test hook) in $(($(date +%s) - t0))s"
else
  runlog "$LOGS/build.log" in_dir "$CLONE" npm run build
  [ "$RC" -eq 0 ] || stop build "npm run build exited $RC" "$LOGS/build.log"
  [ -f "$CLONE/build/index.js" ] || stop build "no build/index.js after npm run build" "$LOGS/build.log"
  pass build "npm run build in $(($(date +%s) - t0))s"
fi

driver=$here/smoke-fresh-mcp.mjs
# steps of the node driver: `STEP name PASS|FAIL reason` lines become ours
relay() {
  if [ ! -s "$1" ] || ! grep -q '^STEP ' "$1"; then fail "$2" "the driver printed no step (exit $RC)" "$1"; return; fi
  while IFS= read -r line; do
    case $line in
      "STEP "*)
        rest=${line#STEP }; name=${rest%% *}; rest=${rest#* }; verdict=${rest%% *}; reason=${rest#* }
        if [ "$verdict" = PASS ]; then pass "$name" "$reason"; else fail "$name" "$reason" ""; fi ;;
    esac
  done <"$1"
  [ "$RC" -eq 0 ] || fail "$2" "the driver exited $RC" "$1"
}

# --- manifest, pack ---------------------------------------------------------------------------------------
runlog "$LOGS/manifest.log" fresh node "$driver" manifest "$CLONE"
relay "$LOGS/manifest.log" manifest
runlog "$LOGS/pack.json" in_dir "$CLONE" npm pack --dry-run --json --ignore-scripts
RUN_IN=$LOGS/pack.json
runlog "$LOGS/pack.log" fresh node "$driver" pack "$CLONE"
RUN_IN=/dev/null
relay "$LOGS/pack.log" npm-pack
# The git channels (the community catalog's `url` source, this repository's marketplace entry) install the TREE of
# the commit they name, never building: Claude Code copies the files and installs the dependencies from
# package-lock.json with install scripts off. master has no build/; the commit the release workflow pushes as branch
# `release` is master's release commit plus build/ (scripts/release-tree.sh). The step walks that path.
if git -C "$CLONE" ls-files --error-unmatch build/index.js >/dev/null 2>&1; then
  fail git-channel "build/index.js is committed on master: the release tree adds it, master stays without built files" ""
else
  rm -rf "$T/release" "$T/plugin-cache"
  runlog "$LOGS/release-tree.log" in_dir "$CLONE" sh scripts/release-tree.sh --dir "$T/release"
  if [ "$RC" -ne 0 ] || [ ! -f "$T/release/build/index.js" ]; then
    fail git-channel "scripts/release-tree.sh --dir exited $RC, or left no build/index.js" "$LOGS/release-tree.log"
  else
    cp -R "$T/release" "$T/plugin-cache"
    t0=$(date +%s)
    # An empty npm cache of its own (unless --npm-cache was given): the cold install a new user pays, so the 60 s check can fire
    rcache=$NPM_CACHE
    [ -n "$CACHE_GIVEN" ] || rcache=$T/npm-cache-release
    runlog "$LOGS/release-deps.log" in_dir "$T/plugin-cache" env npm_config_cache="$rcache" npm ci --omit=dev --ignore-scripts
    secs=$(($(date +%s) - t0))
    if [ "$RC" -ne 0 ]; then fail git-channel "npm ci --omit=dev --ignore-scripts in the release tree exited $RC" "$LOGS/release-deps.log"
    elif [ "$secs" -gt 60 ]; then fail git-channel "the dependency install took ${secs}s: Claude Code gives it 60s" ""
    else
      [ -n "$CACHE_GIVEN" ] && cnote="a reused npm cache (--npm-cache)" || cnote="a cold npm cache"
      pass git-channel "release tree = master + $(find "$T/release/build" -type f | wc -l | tr -d ' ') built files; npm ci --omit=dev --ignore-scripts in ${secs}s of Claude Code's 60s, $cnote"
      fresh git -C "$PROJ" init -q 2>/dev/null
      runlog "$LOGS/release-start.log" fresh node "$driver" plugin-start "$T/plugin-cache" "$PROJ" "$FHOME" "$PORT"
      relay "$LOGS/release-start.log" release-start
    fi
  fi
fi

# --- the SessionStart hook, as Claude Code runs it --------------------------------------------------------
printf '{"session_id":"smoke-conv-%s","source":"startup","cwd":"%s","transcript_path":""}\n' "$$" "$PROJ" >"$T/hook-in.json"
fresh git -C "$PROJ" init -q 2>/dev/null
RUN_IN=$T/hook-in.json
runlog "$LOGS/hook.log" in_dir "$PROJ" CLAUDE_PLUGIN_ROOT="$CLONE" "$CLONE/hooks/workflow-start.sh"
RUN_IN=/dev/null
want=$(ls -d "$CLONE"/templates/skills/*/ | wc -l | tr -d ' ')
got=$(ls -d "$FHOME"/.claude/skills/*/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$RC" -ne 0 ]; then fail hook "exited $RC" "$LOGS/hook.log"
elif ! grep -q 'Call mcp__plugin_workflow_wf__start' "$LOGS/hook.log"; then fail hook "no 'Call mcp__plugin_workflow_wf__start' in its output" "$LOGS/hook.log"
elif [ "$got" != "$want" ]; then fail hook "provisioned $got skill directories in ~/.claude/skills, the plugin ships $want" "$LOGS/hook.log"
elif [ ! -s "$STATE/skills/manifest.json" ]; then fail hook "no skills manifest in the state directory" ""
elif ! ls "$STATE"/context-epoch-* >/dev/null 2>&1; then fail hook "no context-epoch marker written" ""
else pass hook "fresh-start prompt printed, $got default skills copied to the temp ~/.claude/skills, manifest and markers in the temp state dir"; fi
command -v jq >/dev/null 2>&1 \
  || warn hook "jq is not on PATH: the hook prints the fresh-start line and stops (no plan resume, no resume pickup, no conversation stamp); README and getting-started do not list jq as a requirement"

# --- wf-skills --------------------------------------------------------------------------------------------
runlog "$LOGS/skills.log" fresh "$CLONE/scripts/wf-skills" list
if [ "$RC" -eq 0 ] && grep -q "$want current," "$LOGS/skills.log"; then
  pass wf-skills "list: $(grep -c ' installed  current' "$LOGS/skills.log") installed and current, $(grep -c 'stack skill, not installed' "$LOGS/skills.log") stack skills on offer"
else fail wf-skills "list exited $RC without the default set current" "$LOGS/skills.log"; fi
runlog "$LOGS/skills-add.log" fresh "$CLONE/scripts/wf-skills" add lang-python
if [ "$RC" -eq 0 ] && [ -f "$FHOME/.claude/skills/lang-python/SKILL.md" ]; then pass wf-skills-add "add lang-python copied its SKILL.md"
else fail wf-skills-add "add lang-python exited $RC" "$LOGS/skills-add.log"; fi

# --- the commands the docs tell the reader to type: not on a fresh PATH; a link makes them so -------------------
mkdir -p "$T/bin"
for c in wf-skills wf-queue wf-curator wf-routing-census wf-run wf-trust wf-validate wf-orphans; do ln -s "$CLONE/scripts/$c" "$T/bin/$c"; done
runlog "$LOGS/link.log" in_dir "$PROJ" PATH="$T/bin:$PATH" wf-trust --list
LINK_RC=$RC
runlog "$LOGS/link-validate.log" in_dir "$PROJ" PATH="$T/bin:$PATH" wf-validate
if [ "$LINK_RC" -eq 0 ] && [ "$RC" -eq 0 ] && [ "$(PATH="$T/bin:$PATH" command -v wf-queue)" = "$T/bin/wf-queue" ]; then
  pass path-link "wf-trust and wf-validate run through a symlink on PATH and wf-queue resolves there (each finds build/ beside the real file)"
else fail path-link "through a symlink: wf-trust --list exited $LINK_RC, wf-validate exited $RC" "$LOGS/link.log"; fi

# --- the MCP server, the docs' workflows, the dashboard ---------------------------------------------------
SMOKE_CLONE=$CLONE
export SMOKE_CLONE
mkdir -p "$PROJ/.claude"
runlog "$LOGS/mcp.log" fresh SMOKE_CLONE="$CLONE" node "$driver" mcp "$CLONE" "$PROJ" "$FHOME" "$PORT" "$T/sids.txt"
relay "$LOGS/mcp.log" mcp

# --- the pool CLI -----------------------------------------------------------------------------------------
runlog "$LOGS/pool.log" fresh "$CLONE/scripts/wf-run" --status
if [ "$RC" -eq 0 ] && grep -q '^pool .*budget' "$LOGS/pool.log"; then pass wf-run-status "$(head -n 1 "$LOGS/pool.log" | sed "s#$FHOME#~#")"
else fail wf-run-status "--status exited $RC" "$LOGS/pool.log"; fi
runlog "$LOGS/lease.log" fresh "$CLONE/scripts/wf-run" --threads 1 --label "$TAG" -- echo smoke-lease-ok
if [ "$RC" -eq 0 ] && grep -q '^smoke-lease-ok$' "$LOGS/lease.log"; then pass wf-run-lease "a 1-thread lease ran a command and released it"
else fail wf-run-lease "exited $RC" "$LOGS/lease.log"; fi
runlog "$LOGS/usage.log" fresh "$CLONE/scripts/wf-run" --usage
if [ "$RC" -eq 0 ]; then pass wf-run-usage "--usage answered"; else fail wf-run-usage "exited $RC" "$LOGS/usage.log"; fi

# --- the queue: getting-started's demo ---------------------------------------------------------------------
q() { in_dir "$PROJ" "$CLONE/scripts/wf-queue" --queue demo "$@"; }
SMOKE_CLONE=$CLONE node "$driver" tasks "$CLONE/docs/getting-started.md" "batch_size: 2" >"$T/tasks.jsonl" 2>"$LOGS/tasks.log"
n=$(wc -l <"$T/tasks.jsonl" | tr -d ' ')
ok=1
if [ "$n" -eq 0 ]; then ok=0; fail wf-queue "getting-started's demo queue has no task to add" "$LOGS/tasks.log"; fi
while IFS= read -r task && [ "$ok" = 1 ]; do
  runlog "$LOGS/queue-add.log" q --add "$task"
  [ "$RC" -eq 0 ] || { ok=0; fail wf-queue "--add exited $RC: $task" "$LOGS/queue-add.log"; }
done <"$T/tasks.jsonl"
if [ "$ok" = 1 ]; then
  runlog "$LOGS/queue-size.log" q --batch-size 2 --reason "two at once"
  runlog "$LOGS/queue.log" q --dry-run --explain
  if [ "$RC" -eq 0 ] && grep -q 'T3: window full' "$LOGS/queue.log" \
    && grep -q 'batch_size 2, running 0, pending 3, admitted 2 (dry run)' "$LOGS/queue.log" \
    && [ -f "$PROJ/.claude/batch/demo.yaml" ]; then
    pass wf-queue "$n adds created .claude/batch/demo.yaml; --dry-run --explain printed what the page says (T3: window full, admitted 2)"
  else fail wf-queue "--dry-run --explain differs from getting-started (exit $RC)" "$LOGS/queue.log"; fi
fi

# --- uninstall (README: wf-skills remove, then /plugin uninstall) ------------------------------------------
runlog "$LOGS/remove.log" fresh "$CLONE/scripts/wf-skills" remove --state
left=$(ls -d "$FHOME"/.claude/skills/*/ 2>/dev/null | wc -l | tr -d ' ')
if [ "$RC" -eq 0 ] && [ "$left" -eq 0 ] && [ ! -d "$STATE" ] && [ ! -d "$POOL" ]; then pass uninstall "wf-skills remove --state left no skill, no state, no pool in the temp HOME"
else fail uninstall "remove --state exited $RC, $left skill directories left, state dir $([ -d "$STATE" ] && echo present || echo gone)" "$LOGS/remove.log"; fi

# --- the plugin install commands, as far as a CLI goes (the release tree as a marketplace) ----------
if command -v claude >/dev/null 2>&1; then
  # The clone's marketplace entry names the GitHub `release` branch (a network source that does not exist before
  # a release), so the CLI walk uses a marketplace of the same name whose entry is the release tree beside it.
  MKT=$T/marketplace
  if [ -d "$T/release" ] && mkdir -p "$MKT/.claude-plugin" && cp -R "$T/release" "$MKT/plugin" \
    && fresh node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));m.plugins[0].source="./plugin";fs.writeFileSync(process.argv[2],JSON.stringify(m))' \
      "$CLONE/.claude-plugin/marketplace.json" "$MKT/.claude-plugin/marketplace.json"; then
    cc() { in_dir "$PROJ" CLAUDE_CONFIG_DIR="$FHOME/.claude" claude plugin "$@"; }
    runlog "$LOGS/cc-add.log" cc marketplace add "$MKT"
    [ "$RC" -ne 0 ] || runlog "$LOGS/cc-install.log" cc install workflow@claude-workflow
    [ "$RC" -ne 0 ] || runlog "$LOGS/cc-list.log" cc list
    if [ "$RC" -eq 0 ] && grep -q 'workflow@claude-workflow' "$LOGS/cc-list.log" && grep -q "Read from: $MKT/plugin" "$LOGS/cc-list.log"; then
      pass claude-plugin-cli "claude plugin marketplace add <the release tree as a marketplace> and install workflow@claude-workflow: enabled, read from it (temp CLAUDE_CONFIG_DIR)"
    else fail claude-plugin-cli "marketplace add / install / list exited $RC" "$LOGS/cc-list.log"; fi
  else
    skip claude-plugin-cli "no release tree to offer as a marketplace (the git-channel step did not assemble one)"
  fi
else
  skip claude-plugin-cli "claude is not on PATH: /plugin marketplace add, /plugin install, the hooks and the plan pane need a real Claude Code"
fi

finish
