#!/bin/sh
# Project language menu for workflow skill selection (run by the engine,
# master.yaml scan_project exec state). Facts only — the agent picks from
# the menu per task; nothing here forces a skill load.
#
# CONTRACT: any failure mode must yield empty output and exit 0 — the exec
# state degrades to an empty menu, never blocks routing.
#
# Usage: scan-project.sh [project-dir]
# Output: one line per extension, most files first, e.g.
#   hx: 912 files (hxq OK)
#   md: 14 files
# Tool probes are appended to the languages they serve (hx -> hxq).

cd -- "${1:-.}" 2>/dev/null || exit 0

# Tracked + untracked-unignored files; quotePath off so non-ASCII names
# arrive verbatim. Non-git dir -> shallow find, skipping dot/vendor dirs.
{ git -c core.quotePath=false ls-files --cached --others --exclude-standard 2>/dev/null ||
  find . -maxdepth 4 -type f -not -path '*/.*' -not -path '*/node_modules/*' 2>/dev/null; } |
awk -F/ '{print $NF}' |
awk -F. '!(NF==2 && $1=="") && NF>1 && $NF ~ /^[A-Za-z][A-Za-z0-9]{0,7}$/ {print tolower($NF)}' |
sort | uniq -c | sort -rn | head -n 15 |
while read -r n ext; do
    extra=""
    if [ "$ext" = "hx" ]; then
        if command -v hxq >/dev/null 2>&1 && HXQ_QUIET=1 hxq probe 'class C{}' >/dev/null 2>&1; then
            extra=" (hxq OK)"
        else
            extra=" (hxq missing)"
        fi
    fi
    echo "$ext: $n files$extra"
done
