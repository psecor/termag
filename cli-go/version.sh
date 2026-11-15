#!/bin/sh
# Prints the version the Go CLI is stamped with (go build -ldflags "-X …/cli.Version=<it>").
#
# The Node CLI's scheme (cli/buildVersion.mjs), counted over cli/ AND cli-go/:
#
#   <major>.<minor>.<commits touching cli/ or cli-go/>+<the latest one's sha8>[.dirty]
#
# major.minor are cli/package.json's. Counting both directories keeps the patch number growing
# (the orchestrator's version comparison, and the forward's cli_outdated, read a higher one as
# newer): it is never lower than the Node CLI's count for the same commit, and a commit that
# touches only cli-go/ still gets a new number. Without the history (a shallow clone, a copy) it
# is <package.json version>+unknown, as the Node CLI's is.
#
# Usage: cli-go/version.sh   (from anywhere)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
base=$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$repo/cli/package.json" | head -1)
# A git variable from the caller (a hook, a worktree script) would point git elsewhere.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY 2>/dev/null || true
g() { git -C "$repo" "$@" 2>/dev/null; }
if [ "$(g rev-parse --is-shallow-repository || echo error)" != false ]; then echo "$base+unknown"; exit 0; fi
sha=$(g log -1 --format=%h --abbrev=8 -- cli cli-go || true)
if [ -z "$sha" ]; then echo "$base+unknown"; exit 0; fi
count=$(g rev-list --count HEAD -- cli cli-go)
dirty=
if [ -n "$(g status --porcelain -- cli cli-go)" ]; then dirty=.dirty; fi
major=${base%%.*}
rest=${base#*.}
minor=${rest%%.*}
echo "$major.$minor.$count+$sha$dirty"
