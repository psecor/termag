#!/usr/bin/env bash
# Renaming a multi-repo project and one of its workstreams end to end
#  on its own stack: a project of two
# public stub repositories on a stand-in box with two workstreams, renamed;
# then one workstream renamed. After each, `git status` works in every
# checkout and every worktree, git lists the worktrees at their new paths,
# the generated guides name the new names, a hand-written AGENTS.md is kept,
# and the tmux sessions follow. Runs on its own ports and TMPDIR, beside a
# stack that is already up.
#
# Run: bash scripts/e2e/multi-repo-rename.test.sh
#   E2E_TEST_PORT_SHIFT=N        add N to every port
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_CACHE_DIR=${E2E_TEST_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/termag-e2e}
S=${E2E_TEST_PORT_SHIFT:-0}
export E2E_PORT=$((4050 + S)) E2E_FRONTEND_PORT=$((6066 + S)) E2E_PG_PORT=$((55539 + S)) E2E_GITHUB_PORT=$((4760 + S)) E2E_BOXES=1 \
  E2E_FAKE_GITHUB=1 E2E_FLAGS='{"multi-repo-projects-enabled":true}'
trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

fails=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"; echo "FAIL: up.sh with E2E_FAKE_GITHUB"; exit 1
fi
pass "up.sh brought the stack up with E2E_FAKE_GITHUB=1"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
API="http://127.0.0.1:$E2E_PORT/termag"
PG="postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag"
JAR="$WORK/cookies"
curl -s -o /dev/null -c "$JAR" "$API/auth/login"
sql() { psql "$PG" -Atc "$1"; }
api() { # api METHOD PATH [JSON]: the status code, the body in $WORK/body
  curl -s -o "$WORK/body" -w '%{http_code}' -b "$JAR" -X "$1" -H 'content-type: application/json' ${3:+-d "$3"} "$API/api$2"
}
wait_for() { # wait_for SECONDS COMMAND...
  local n=$(($1 * 4)); shift
  for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 0.25; done
  return 1
}
git_e2e() { git -c user.name=e2e -c user.email=e2e@example.com "$@"; }
# `git status` in each directory: "ok <branch>" when git reads it, else git's error.
statuses() {
  local d out
  for d in "$@"; do
    if out=$(git -C "$d" status --porcelain --branch 2>&1); then printf 'ok:%s ' "$(git -C "$d" branch --show-current)"
    else printf 'broken(%s) ' "$(echo "$out" | head -n1)"; fi
  done | sed 's/ $//'
}
guide_title() { sed -n 2p "$1/AGENTS.md"; }

BOX=$(jq -r '.[0].id' "$ROOT/boxes.json")
PROJECTS="$ROOT/boxes/box-1/home/termag/projects"
TMUX_BOX="$ROOT/boxes/box-1/bin/tmux"
has_session() { "$TMUX_BOX" has-session -t "=$1" 2>/dev/null; }

echo "--- a project of two repositories, with two workstreams"
code=$(api POST /projects "{\"name\":\"shop\",\"instanceId\":\"$BOX\",\"initialAgent\":{\"enabled\":true,\"provider\":\"claude\"},\"repos\":[{\"url\":\"https://github.com/e2e-octocat/shop-web.git\"},{\"url\":\"https://github.com/e2e-octocat/shop-api.git\"}]}")
check "POST /api/projects with repos answers 201" 201 "$code"
PID=$(jq -r .id "$WORK/body")
UNIX=$(sql "select u.\"unixUsername\" from projects p join users u on u.id = p.\"userId\" where p.id = '$PID'")
is_ready() { [ "$(sql "select \"setupStatus\" from projects where id = '$PID'")" = ready ]; }
wait_for 90 is_ready
check "both repositories cloned" ready "$(sql "select \"setupStatus\" from projects where id = '$PID'")"
code=$(api POST "/projects/$PID/workstreams" '{"name":"fix","branch":"e2e/fix"}')
check "branching off fix answers 201" 201 "$code"
FIX=$(jq -r .id "$WORK/body")
code=$(api POST "/projects/$PID/workstreams" '{"name":"notes","branch":"e2e/notes"}')
check "branching off notes answers 201" 201 "$code"
printf '# my notes\n' >"$PROJECTS/shop/.worktrees/notes/AGENTS.md"
# Work in flight rides along: a commit on the fix branch and an uncommitted edit.
printf 'fixed\n' >"$PROJECTS/shop/.worktrees/fix/shop-api/FIX.md"
git_e2e -C "$PROJECTS/shop/.worktrees/fix/shop-api" add FIX.md && git_e2e -C "$PROJECTS/shop/.worktrees/fix/shop-api" commit -qm 'e2e: a fix'
printf 'draft\n' >>"$PROJECTS/shop/.worktrees/fix/shop-web/README.md"
wait_for 30 has_session "$UNIX-shop-agent"
wait_for 30 has_session "$UNIX-shop-fix-agent"

echo "--- rename the project"
code=$(api POST "/projects/$PID/rename" '{"name":"store"}')
check "renaming shop to store answers 200" "200 store" "$code $(jq -r .name "$WORK/body")"
D="$PROJECTS/store"
check "the folder moved" "gone there" "$( [ -e "$PROJECTS/shop" ] && echo there || echo gone) $( [ -f "$D/.termag-workspace" ] && echo there || echo gone)"
check "git status works in every checkout and every worktree" \
  "ok:main ok:main ok:e2e/fix ok:e2e/fix ok:e2e/notes ok:e2e/notes" \
  "$(statuses "$D/shop-web" "$D/shop-api" "$D/.worktrees/fix/shop-web" "$D/.worktrees/fix/shop-api" "$D/.worktrees/notes/shop-web" "$D/.worktrees/notes/shop-api")"
check "each checkout lists its worktrees at the new paths" \
  "$D/.worktrees/fix/shop-web $D/.worktrees/notes/shop-web | $D/.worktrees/fix/shop-api $D/.worktrees/notes/shop-api" \
  "$(git -C "$D/shop-web" worktree list --porcelain | sed -n 's/^worktree //p' | tail -n +2 | sort | tr '\n' ' ' | sed 's/ $//') | $(git -C "$D/shop-api" worktree list --porcelain | sed -n 's/^worktree //p' | tail -n +2 | sort | tr '\n' ' ' | sed 's/ $//')"
check "the work in flight came along" "e2e: a fix | README.md" \
  "$(git -C "$D/.worktrees/fix/shop-api" log -1 --format=%s) | $(git -C "$D/.worktrees/fix/shop-web" diff --name-only)"
check "the generated guides name the project's new name" "# store | # store / fix" "$(guide_title "$D") | $(guide_title "$D/.worktrees/fix")"
check "a hand-written guide is kept" "# my notes" "$(cat "$D/.worktrees/notes/AGENTS.md")"
check "the sessions follow the name" "yes yes no" \
  "$(has_session "$UNIX-store-agent" && echo yes || echo no) $(has_session "$UNIX-store-fix-agent" && echo yes || echo no) $(has_session "$UNIX-shop-agent" && echo yes || echo no)"

echo "--- rename a workstream"
code=$(api POST "/projects/$PID/workstreams/$FIX/rename" '{"name":"feature"}')
check "renaming fix to feature answers 200" "200 feature" "$code $(jq -r .name "$WORK/body")"
check "its folder moved" "gone there" "$( [ -e "$D/.worktrees/fix" ] && echo there || echo gone) $( [ -d "$D/.worktrees/feature" ] && echo there || echo gone)"
check "git status works in every checkout and every worktree" \
  "ok:main ok:main ok:e2e/fix ok:e2e/fix ok:e2e/notes ok:e2e/notes" \
  "$(statuses "$D/shop-web" "$D/shop-api" "$D/.worktrees/feature/shop-web" "$D/.worktrees/feature/shop-api" "$D/.worktrees/notes/shop-web" "$D/.worktrees/notes/shop-api")"
check "git lists the worktree at its new path" yes \
  "$(git -C "$D/shop-api" worktree list --porcelain | grep -qxF "worktree $D/.worktrees/feature/shop-api" && echo yes || echo no)"
check "its guide names the workstream's new name, and the branch it kept" "# store / feature yes" \
  "$(guide_title "$D/.worktrees/feature") $(grep -qF 'a worktree on branch `e2e/fix`' "$D/.worktrees/feature/AGENTS.md" && echo yes || echo no)"
check "its sessions follow the name" "yes no" \
  "$(has_session "$UNIX-store-feature-agent" && echo yes || echo no) $(has_session "$UNIX-store-fix-agent" && echo yes || echo no)"

echo "--- a taken name moves nothing"
code=$(api POST "/projects/$PID/workstreams/$FIX/rename" '{"name":"notes"}')
check "renaming feature onto notes answers 409, leaving both folders" "409 yes yes" \
  "$code $( [ -d "$D/.worktrees/feature/shop-web" ] && echo yes || echo no) $( [ -d "$D/.worktrees/notes/shop-web" ] && echo yes || echo no)"

echo
if [ "$fails" -eq 0 ]; then echo "multi-repo-rename: all checks passed"; else echo "multi-repo-rename: $fails check(s) failed"; exit 1; fi
