#!/bin/sh
# Drift check: bundled templates/skills/* vs the live user skills
# (~/.claude/skills/ or $CLAUDE_SKILLS_DIR). The live copy is the actively
# enriched source of truth; the bundled copy is the shipped snapshot — a
# same-named pair that differs means the snapshot went stale (or an edit
# landed only bundled-side). Names listed in .skillsyncignore (one per
# line, # comments, trailing whitespace ignored) are intentionally
# divergent: skipped, except that an ignored pair which became IDENTICAL
# is reported (a blanket sync overwrote the generic bundled template).
#
# Finder metadata (.DS_Store) is not skill content and never counts as drift.
#
# Exit 0 = in sync; exit 1 = drift reported (used by the pre-commit hook).
# Skills existing on only one side are not drift (user-local skills are
# not all bundled; a machine without live copies checks nothing).

root="$(cd "$(dirname "$0")/.." && pwd)"
live="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
ignore="$root/.skillsyncignore"

# Fail CLOSED on a broken checkout — a missing bundled dir is not "in sync".
[ -d "$root/templates/skills" ] || { echo "skill-sync: no bundled skills dir ($root/templates/skills)"; exit 1; }
[ -d "$live" ] || { echo "skill-sync: no live skills dir ($live) — nothing to check"; exit 0; }

fail=0
for dir in "$root/templates/skills"/*/; do
    name=$(basename "$dir")
    [ -d "$live/$name" ] || continue
    if [ -f "$ignore" ] && sed 's/[[:space:]]*$//' "$ignore" | grep -qxF -e "$name"; then
        # An ignored pair that became IDENTICAL means a blanket sync overwrote
        # the bundled template with the personal live copy — the listed
        # divergence silently vanished.
        if diff -rq -x .DS_Store "$live/$name" "$dir" >/dev/null 2>&1; then
            echo "DRIFT: $name — listed in .skillsyncignore but IDENTICAL to live"
            echo "    the bundled copy must stay the generic template; restore it (git show HEAD:templates/skills/$name/...)"
            fail=1
        fi
        continue
    fi
    drift=$(diff -rq -x .DS_Store "$live/$name" "$dir" 2>&1) || {
        echo "DRIFT: $name"
        echo "$drift" | sed 's/^/    /'
        fail=1
    }
done

if [ $fail -ne 0 ]; then
    echo ""
    echo "Bundled skill snapshots drifted from the live copies. The LIVE copy is"
    echo "the source of truth (it is what agents load at runtime); sync with:"
    echo "    rsync -a --delete --exclude .DS_Store \"$live/<name>/\" \"$root/templates/skills/<name>/\""
    echo "WARNING: that overwrites the bundled side — if the edit was made on the"
    echo "BUNDLED copy, merge it into the live copy FIRST, then rsync."
    echo "Intentional divergence instead: add <name> to .skillsyncignore."
    exit 1
fi
echo "skill-sync: OK"
exit 0
