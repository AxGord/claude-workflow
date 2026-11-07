#!/bin/sh
# The plan pane's tests (hooks/*.test.tsx) under `claude plugin test`: the plugin's manifest, hooks and
# types are copied to a scratch folder, since the command loads every *.test.ts under the folder it is
# given and the engine's vitest suite under src/ is not a hooks test. Without `claude` on PATH (CI) the
# step says so and passes.
root=$(cd "$(dirname "$0")/.." && pwd) || exit 2
if ! command -v claude >/dev/null 2>&1; then
  echo "test:pane: no claude on PATH — the plan pane's tests are skipped" >&2
  exit 0
fi
dir=$(mktemp -d "${TMPDIR:-/tmp}/wf-pane-test.XXXXXX") || exit 2
trap 'rm -rf "$dir"' EXIT
cp -R "$root/.claude-plugin" "$root/hooks" "$root/types" "$dir/" || exit 2
claude plugin test "$dir"
