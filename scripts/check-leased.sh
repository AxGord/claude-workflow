#!/bin/sh
# `npm run check` of the tree in the current directory, under pool leases sized to what each half of it uses:
# the engine's own gates and a worker's by-hand run. The static half (tsc, biome, eslint, ast-grep) is serial and
# uses about 2 cores. The test half (vitest, the pane tests, check:ci) uses about as many cores as vitest has
# workers, and vitest.config.ts makes that the grant (WF_THREADS). One lease over the whole run holds the wide
# half's threads through the narrow half (measured: 8 held, 4.6 used), and a lease held around a second wf-run
# waits on itself, so the two halves take their leases one after the other, never together.
# Run from the engine's main checkout, whose copy every slice's worktree uses: a tree on an older base has no
# `check:static` / `check:tests` scripts, and then the whole check takes one 4-6 lease (its vitest uncapped there).
# Already under a lease (WF_THREADS set: an exec's `resource:` or a wf-run around this script) the caller sized it:
# this runs the plain check. WF_RUN is the wf-run to use; default: the one beside this script.
[ -z "$WF_THREADS" ] || exec npm run check
run=${WF_RUN:-$(cd "$(dirname "$0")" && pwd)/wf-run}
if ! grep -q '"check:static"' package.json 2>/dev/null; then
  exec "$run" --threads 4-6 --label check -- npm run check
fi
"$run" --threads 2 --label check-static -- npm run check:static || exit $?
exec "$run" --threads 4-6 --label check-tests -- npm run check:tests
