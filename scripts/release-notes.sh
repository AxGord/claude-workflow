#!/bin/sh
# The GitHub release body of a version: the lead of its CHANGELOG.md block, up to the first `### ` sub-heading
# (the summary; the per-change entries sit under it), then a link to the full CHANGELOG.md at the tag. GitHub
# refuses a release body over 125,000 characters, so the entries never go in. A block with no lead gives
# "Release v<version>".
# Usage: scripts/release-notes.sh VERSION [CHANGELOG-FILE]   (what .github/workflows/publish.yml runs)
version=${1:?usage: release-notes.sh VERSION [CHANGELOG-FILE]}
file=${2:-CHANGELOG.md}
body=$(awk -v v="$version" '
  /^## / {
    if (found) exit
    t = $0
    sub(/^## \[?/, "", t)
    if (index(t, v) == 1 && substr(t, length(v) + 1, 1) !~ /[0-9.]/) found = 1
    next
  }
  /^### / { if (found) exit }
  found { print }
' "$file")
[ -n "$(printf '%s' "$body" | tr -d '[:space:]')" ] || body="Release v$version"
printf '%s\n\nFull changelog: https://github.com/AxGord/claude-workflow/blob/v%s/CHANGELOG.md\n' "$body" "$version"
