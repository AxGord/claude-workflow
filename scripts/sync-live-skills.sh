#!/bin/sh
# Land-side skill sync: copy each bundled skill a merge changed to the live user skills
# (~/.claude/skills/ or $CLAUDE_SKILLS_DIR). Called by the engine-task land after a green build:
#     sh "$main/scripts/sync-live-skills.sh" "$before" "$merged"
# (<before> = the commit master was at, <merged> = the merge result).
#
# Per skill the merge touched: skipped when listed in .skillsyncignore, when it no longer exists
# bundled (a deletion never deletes the live copy), or when it has no live dir. Live is overwritten
# only while it still equals <before>'s bundled copy; a live copy edited since is left alone with a
# WARNING. A failure only warns: this script always exits 0, it never fails a merge.
root="$(cd "$(dirname "$0")/.." && pwd)"
live="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
before="$1"
merged="$2"
[ -n "$before" ] && [ -n "$merged" ] || { echo "WARNING: sync-live-skills: usage: <before> <merged>"; exit 0; }
[ -d "$live" ] || exit 0

tmp=$(mktemp -d "${TMPDIR:-/tmp}/sync-live-skills.XXXXXX") || { echo "WARNING: sync-live-skills: no temp dir"; exit 0; }
trap 'rm -rf "$tmp"' EXIT

# A skill sits in templates/skills (the default set) or templates/skills-stack (the pack); a merge may move one.
names=$(git -C "$root" diff --name-only "$before" "$merged" -- templates/skills templates/skills-stack | cut -d/ -f3 | sort -u)
for name in $names; do
    src=""
    for set in skills skills-stack; do
        [ -d "$root/templates/$set/$name" ] && src="$root/templates/$set/$name"
    done
    [ -n "$src" ] || continue
    [ -d "$live/$name" ] || continue
    if [ -f "$root/.skillsyncignore" ] && sed 's/[[:space:]]*$//' "$root/.skillsyncignore" | grep -qxF -e "$name"; then
        continue
    fi
    old="$tmp/$name"
    mkdir -p "$old"
    oldsrc=""
    for set in skills skills-stack; do
        git -C "$root" archive "$before" "templates/$set/$name" 2>/dev/null | tar -x -C "$old" 2>/dev/null
        [ -d "$old/templates/$set/$name" ] && oldsrc="$old/templates/$set/$name"
    done
    if ! diff -rq -x .DS_Store "$live/$name" "$oldsrc" >/dev/null 2>&1; then
        echo "WARNING: live skill $name differs from the pre-merge bundled copy: left alone. To take the bundled copy: rsync -a -c --delete --exclude .DS_Store \"$src/\" \"$live/$name/\"; to keep the live copy: add '$name' to $root/.skillsyncignore"
        continue
    fi
    if rsync -a -c --delete --exclude .DS_Store "$src/" "$live/$name/"; then
        echo "synced live skill: $name"
    else
        echo "WARNING: live skill sync of $name failed"
    fi
done
exit 0
