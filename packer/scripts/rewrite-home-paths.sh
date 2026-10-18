#!/bin/bash
# termag-rewrite-home-paths OLD_HOME NEW_HOME
#
# Rewrites the baked home path in the symlink targets and text files that
# scripts/index-home-paths.sh recorded at bake time. cloud-init runs it right
# after step 2 has moved OLD_HOME (/home/termag) to NEW_HOME (/home/<owner>)
# with mv and pointed the passwd record at it with `usermod -l -d` (no -m). Only the indexed entries are touched, so this costs seconds
# on a lazily-restored EBS volume where the walk it replaces cost up to
# 15 minutes. The header of index-home-paths.sh has the history and numbers.
#
# Idempotent: an entry that no longer points into or mentions OLD_HOME is left
# alone, so re-running is safe. Exit codes:
#   0   ran (possibly rewriting nothing)
#   2   no index at INDEX_DIR; nothing rewritten (the caller decides how loud)
#   64  usage
# The caller must still guard the call: this runs before the agent is started
# and nothing here may abort the boot.
#
#   INDEX_DIR  default /var/lib/termag-bake/home-paths
set -uo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 OLD_HOME NEW_HOME" >&2
  exit 64
fi
OLD=$1
NEW=$2
INDEX_DIR=${INDEX_DIR:-/var/lib/termag-bake/home-paths}
start=$(date +%s)

if [ ! -f "$INDEX_DIR/symlinks" ] || [ ! -f "$INDEX_DIR/files" ]; then
  echo "WARNING: no home-path index at $INDEX_DIR; baked $OLD paths were not rewritten"
  exit 2
fi

# sed escaping, with `|` as the delimiter: OLD is a basic-regex pattern, NEW a
# replacement. Usernames are plain, but a home path is input all the same.
old_re=$(printf '%s' "$OLD" | sed -e 's/[][\\.*^$|]/\\&/g')
new_repl=$(printf '%s' "$NEW" | sed -e 's/[\\&|]/\\&/g')

n_links=0
while IFS= read -r -d '' rel; do
  link="$NEW/$rel"
  [ -L "$link" ] || continue
  target=$(readlink "$link") || continue
  case "$target" in
    "$OLD"|"$OLD"/*)
      if ln -sfn "$NEW${target#"$OLD"}" "$link"; then n_links=$((n_links + 1)); fi ;;
  esac
done < "$INDEX_DIR/symlinks"

n_files=0
while IFS= read -r -d '' rel; do
  f="$NEW/$rel"
  if [ ! -f "$f" ] || [ -L "$f" ]; then continue; fi
  grep -qF -- "$OLD" "$f" 2>/dev/null || continue
  if sed -i "s|$old_re|$new_repl|g" "$f"; then n_files=$((n_files + 1)); fi
done < "$INDEX_DIR/files"

meta=$(tr '\n' ' ' < "$INDEX_DIR/meta" 2>/dev/null || true)
echo "rewrote $n_links symlink target(s) and $n_files text file(s) from $OLD to $NEW in $(( $(date +%s) - start ))s (index: ${meta:-no meta})"
