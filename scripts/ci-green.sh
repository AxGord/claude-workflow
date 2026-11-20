#!/bin/sh
# The publish gate: succeeds only when the CI workflow (.github/workflows/ci.yml) is green for ONE commit.
# publish.yml runs it instead of re-running the suite, so the suite runs once per commit, on the whole node
# matrix, and a release can only be cut from a commit that passed it.
#
# Usage: scripts/ci-green.sh SHA [REPO]   (REPO defaults to $GITHUB_REPOSITORY; `gh` needs GH_TOKEN and actions: read)
#
# Reads the `push` runs of ci.yml for SHA (a pull_request run is for the PR's head, not for the commit master
# holds) through `gh api`. A run counts as one verdict of the whole workflow: every matrix cell and the smoke job.
#   any run completed with conclusion success  -> exit 0
#   a run still queued / in progress           -> wait (CI started by the same push as the release)
#   runs, all finished, none success           -> exit 1
#   no run at all                              -> wait CI_GREEN_START_GRACE seconds for it to appear, then exit 1
# A success wins over an earlier failed run: a re-run of the failed jobs replaces the verdict, and the commit is
# the same.
# Exits: 0 green, 1 not green (or no run, or the wait ran out), 2 usage or `gh` failed.
# Env: CI_GREEN_POLL (seconds between reads, default 20), CI_GREEN_TIMEOUT (seconds to wait for a running CI,
# default 2400), CI_GREEN_START_GRACE (seconds to wait for a first run to appear, default 180).
sha=$1
repo=${2:-$GITHUB_REPOSITORY}
[ -n "$sha" ] && [ -n "$repo" ] || { echo "ci-green: usage: ci-green.sh SHA [REPO]" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || { echo "ci-green: gh is not on PATH" >&2; exit 2; }
poll=${CI_GREEN_POLL:-20}
timeout=${CI_GREEN_TIMEOUT:-2400}
grace=${CI_GREEN_START_GRACE:-180}

start=$(date +%s)
while :; do
  runs=$(gh api "repos/$repo/actions/workflows/ci.yml/runs?head_sha=$sha&event=push&per_page=100" \
    --jq '.workflow_runs[] | "\(.id) \(.status) \(.conclusion)"') \
    || { echo "ci-green: gh api failed for $repo@$sha" >&2; exit 2; }
  elapsed=$(( $(date +%s) - start ))
  if [ -z "$runs" ]; then
    if [ "$elapsed" -ge "$grace" ]; then
      echo "ci-green: no CI run (push event) for $sha: nothing vouches for this commit" >&2
      exit 1
    fi
    echo "ci-green: no CI run for $sha yet (${elapsed}s)"
  else
    if printf '%s\n' "$runs" | grep -q ' completed success$'; then
      echo "ci-green: CI is green for $sha"
      exit 0
    fi
    if printf '%s\n' "$runs" | grep -q -v ' completed '; then
      echo "ci-green: CI still running for $sha (${elapsed}s)"
    else
      echo "ci-green: CI is not green for $sha:" >&2
      printf '%s\n' "$runs" >&2
      exit 1
    fi
  fi
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "ci-green: CI did not finish for $sha within ${timeout}s" >&2
    exit 1
  fi
  sleep "$poll"
done
