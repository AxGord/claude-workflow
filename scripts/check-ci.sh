#!/bin/sh
# The suite as CI runs it, on this machine: a test that is green only thanks to this machine's
# environment (a global git identity, a home full of config, the local time zone or language) goes
# red here instead of on CI. Also the version check CI runs before the tests.
#
# The environment is emptied (`env -i`) and rebuilt from the bare minimum: PATH = node's directory
# plus the system dirs, a fresh empty HOME, no system git config, `user.useConfigOnly` (git refuses
# to commit without an identity the test configured itself instead of guessing one from the host),
# and a time zone and language that are neither this machine's nor CI's UTC.
#
# Usage: scripts/check-ci.sh [vitest args…]   (npm run check:ci)
root=$(cd "$(dirname "$0")/.." && pwd) || exit 2
cd "$root" || exit 2

pkg=$(node -p "require('./package.json').version") || exit 2
plugin=$(node -p "require('./.claude-plugin/plugin.json').version") || exit 2
if [ "$pkg" != "$plugin" ]; then
  echo "check:ci: version mismatch: package.json=$pkg, plugin.json=$plugin" >&2
  exit 1
fi

node_bin=$(command -v node) || { echo "check:ci: no node on PATH" >&2; exit 2; }
node_dir=$(dirname "$node_bin")
home=$(mktemp -d "${TMPDIR:-/tmp}/wf-check-ci.XXXXXX") || exit 2
trap 'rm -rf "$home"' EXIT
trap 'exit 130' INT TERM

env -i \
  PATH="$node_dir:/usr/bin:/bin:/usr/sbin:/sbin" \
  HOME="$home" \
  TMPDIR="$home" \
  TZ="${CHECK_CI_TZ:-America/St_Johns}" \
  LANG=C LC_ALL=C \
  CI=true \
  GIT_CONFIG_NOSYSTEM=1 \
  GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.useConfigOnly GIT_CONFIG_VALUE_0=true \
  "$root/node_modules/.bin/vitest" run "$@"
