---
name: ci-github-actions
description: GitHub Actions workflow gotchas
---

# GitHub Actions — Verified Gotchas

## workflow_dispatch Runs on ANY Branch — No Trigger Changes Needed

**Wrong:** Add branch filter to `push:` trigger, prefix artifact names with `${{ github.ref_name }}`, add `if:` conditionals on release jobs.

**Right:** Nothing. `workflow_dispatch` already lets the user pick any branch in the GitHub UI. Tag the commit first (`git tag v1.2.3-suffix && git push origin v1.2.3-suffix`), then dispatch from that branch — tag-based actions pick it up automatically.

**Why:** Before proposing new triggers or conditions, enumerate what existing triggers + marketplace actions already accept.

## `WyriHaximus/github-action-get-previous-tag` Requires `fetch-depth: 0`

The action resolves the most recent tag **reachable from the current commit** via git history. With the default `fetch-depth: 1`, no tags are reachable — the action returns empty or stale results.

```yaml
- uses: actions/checkout@v7
  with:
    fetch-depth: 0  # required for tag resolution
```

Same applies to `git describe`, `git log --follow`, `gitversion`, and any changelog generator that walks commit history.

## `actions/checkout` Default Fetches Only 1 Commit (v4+)

Unless `fetch-depth: 0` (full history) or `fetch-depth: N` is set, you get a shallow clone with depth 1. Breaks: tag lookup, `git log`-based changelogs, `git blame`, branch comparison diffs.

## `github.ref` vs `github.ref_name` vs `github.head_ref`

| Expression | Value | When to use |
|---|---|---|
| `github.ref` | `refs/heads/main` or `refs/tags/v1.0` | Conditional checks (`startsWith(github.ref, 'refs/tags/')`) |
| `github.ref_name` | `main` or `v1.0` | Display, artifact names, slugs |
| `github.head_ref` | `feature/foo` | PR source branch only — empty on push/dispatch |

**Wrong:** Using `github.ref` as an artifact name prefix → gets `refs/heads/main` as the string.
**Right:** Use `github.ref_name` for human-readable values.

## `needs:` Skips Downstream Jobs When Dependency Was Skipped

If a job in `needs:` was skipped (via `if: false`), dependent jobs are also skipped — they don't run, they don't fail, they silently disappear.

```yaml
# WRONG — if build was skipped, deploy never runs (no error either)
deploy:
  needs: [build]
  steps: ...

# RIGHT — run regardless, check status explicitly
deploy:
  needs: [build]
  if: ${{ !cancelled() && needs.build.result == 'success' }}
  steps: ...
```

Prefer `!cancelled()` over `always()`: `always()` forces the job to run even when the workflow run is being cancelled; `!cancelled()` lifts the "dependency failed/skipped" gate but still respects cancellation. (The `${{ }}` is required here — a bare `if:` starting with `!` is invalid YAML.)

## `$GITHUB_ENV` Changes Are Not Visible in the Same Step

`echo "X=value" >> $GITHUB_ENV` exports `X` for all **subsequent** steps. The current step cannot read it.

```yaml
# WRONG — MY_VAR is empty in the same step
- run: |
    echo "MY_VAR=hello" >> $GITHUB_ENV
    echo $MY_VAR        # prints nothing

# RIGHT — read it in the next step
- run: echo "MY_VAR=hello" >> $GITHUB_ENV
- run: echo $MY_VAR     # prints "hello"
```

Same applies to `$GITHUB_PATH` and `$GITHUB_OUTPUT`.

## Secrets Are Not Available in `pull_request` from Forks

For PRs from external forks, `secrets.*` are empty — GitHub blocks them to prevent secret exfiltration. This silently breaks deploys, uploads, and any authenticated API calls.

**Use `pull_request_target`** if you need secrets for fork PRs — but it runs in the context of the **base branch**, not the PR branch. Never check out the PR branch code and run it in `pull_request_target` without explicit trust checks (code injection risk).

```yaml
# pull_request — safe, no secrets for forks
# pull_request_target — has secrets, but runs base-branch context
```

## `pull_request_target` Security: Never Run Untrusted Code With Secrets

`pull_request_target` has access to secrets and runs in the base branch context. If you also check out the PR branch (`ref: ${{ github.event.pull_request.head.sha }}`), you execute untrusted code with full secret access — a classic supply-chain attack vector.

**Safe pattern:** use `pull_request_target` only for label/comment actions. For build+test, use `pull_request` (no secrets) or a manual approval gate.

## Matrix `continue-on-error` Placement Matters

```yaml
# Job-level — entire job matrix continues even if one cell fails
jobs:
  test:
    continue-on-error: true   # whole matrix ignores failures

# Cell-level — only the flagged cell continues, others still gate the job
jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu, windows]
    continue-on-error: ${{ matrix.os == 'windows' }}  # only windows cell is optional
```

Note `strategy:` lives under `jobs.<job>` — it is not a top-level workflow key.

`fail-fast: false` (strategy level) keeps sibling cells running after one fails. `continue-on-error: true` (job level) prevents the job from being marked failed. They're orthogonal.

## Artifact Names Must Be Unique Within a Run (actions/upload-artifact v4+)

v4 made artifacts immutable — uploading two artifacts with the same name in one workflow run is an error (v3 silently merged files into one artifact). Since v4.4 an explicit `overwrite: true` input deletes and replaces the existing artifact; the default is still an error.

```yaml
# WRONG — both matrix cells upload "test-results", second one errors
- uses: actions/upload-artifact@v7
  with:
    name: test-results

# RIGHT — include matrix dimension in the name
- uses: actions/upload-artifact@v7
  with:
    name: test-results-${{ matrix.os }}
```

## `if:` Expressions: Single Quotes Only, Comparison Is Case-INsensitive

```yaml
# WRONG — double quotes are a validation error in expressions
if: github.event_name == "push"

# RIGHT
if: github.event_name == 'push'
```

String literals in expressions must use single quotes — double quotes fail workflow validation. String comparison with `==` ignores case (`'Push' == 'push'` is true). The operator is `==`; there is no `===`.

`if:` expressions do NOT require `${{ }}` wrapping (they're evaluated as expressions already). Adding `${{ }}` works but is redundant — except when the expression starts with `!` (reserved in YAML), e.g. `if: ${{ !cancelled() }}`.

## `env:` Does Not Propagate Into Reusable Workflow Calls (`jobs.<job>.uses`)

A reusable workflow is called at the JOB level (`jobs.<job>.uses`), not as a step. Environment variables set at workflow or job level are available to `run:` steps but are NOT passed into the called reusable workflow. Pass values explicitly via `with:` inputs or `secrets:` instead.

## Default Community Health Files (FUNDING.yml, CODEOWNERS, ISSUE_TEMPLATE) Load ONLY From a Repo Named `.github`

Account-wide defaults for community health files come **only** from a public repo named literally `.github` (e.g. `owner/.github`), in its root or a `.github`/`docs` folder. A repo's own file overrides the default.

**Wrong:** Putting `FUNDING.yml` in the username/profile repo (`owner/owner`, the one with the profile README) expecting it to apply org-wide — it does NOT. It only affects that single repo.

**Right:** Create `owner/.github` (must be public) → its `FUNDING.yml` gives every repo without its own a Sponsor button.

`FUNDING.yml` keys are platform-specific usernames, not URLs: `buy_me_a_coffee: <user>`, `patreon: <user>`. There is **no** `paypal:` key — PayPal goes under `custom: ['https://paypal.me/<user>']`.
