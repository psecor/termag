#!/usr/bin/env bash
# Adding a repository to a multi-repo project end to end
#  on its own stack: a
# project of two public stub repositories on a stand-in box with a
# workstream gets a third, which is cloned beside the running sessions and
# checked out in the workstream on its branch, with the generated guides
# rewritten; Branch off waits for its clone, and a workstream made after it
# has it too. A repository that cannot be cloned fails alone, and Branch off
# leaves it out. Runs on its own ports and TMPDIR, beside a stack that is
# already up.
#
# Run: bash scripts/e2e/multi-repo-add.test.sh
#   E2E_TEST_PORT_SHIFT=N        add N to every port
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_CACHE_DIR=${E2E_TEST_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/termag-e2e}
S=${E2E_TEST_PORT_SHIFT:-0}
export E2E_PORT=$((4060 + S)) E2E_FRONTEND_PORT=$((6076 + S)) E2E_PG_PORT=$((55549 + S)) E2E_GITHUB_PORT=$((4770 + S)) E2E_BOXES=1 \
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
# `git status` in each directory: "ok:<branch>" when git reads it, else git's error.
statuses() {
  local d out
  for d in "$@"; do
    if out=$(git -C "$d" status --porcelain --branch 2>&1); then printf 'ok:%s ' "$(git -C "$d" branch --show-current)"
    else printf 'broken(%s) ' "$(echo "$out" | head -n1)"; fi
  done | sed 's/ $//'
}
# The repositories a generated guide lists, in order.
guide_repos() { sed -n 's/^- `\([^/]*\)\/`:.*/\1/p' "$1/AGENTS.md" | tr '\n' ' ' | sed 's/ $//'; }
exists() { [ -e "$1" ] && echo there || echo gone; }

BOX=$(jq -r '.[0].id' "$ROOT/boxes.json")
PROJECTS="$ROOT/boxes/box-1/home/termag/projects"
TMUX_BOX="$ROOT/boxes/box-1/bin/tmux"
has_session() { "$TMUX_BOX" has-session -t "=$1" 2>/dev/null; }
D="$PROJECTS/shop"

echo "--- a project of two repositories, with a workstream"
code=$(api POST /projects "{\"name\":\"shop\",\"instanceId\":\"$BOX\",\"initialAgent\":{\"enabled\":true,\"provider\":\"claude\"},\"repos\":[{\"url\":\"https://github.com/e2e-octocat/shop-web.git\"},{\"url\":\"https://github.com/e2e-octocat/shop-api.git\"}]}")
check "POST /api/projects with repos answers 201" 201 "$code"
PID=$(jq -r .id "$WORK/body")
UNIX=$(sql "select u.\"unixUsername\" from projects p join users u on u.id = p.\"userId\" where p.id = '$PID'")
project_status() { sql "select \"setupStatus\" from projects where id = '$PID'"; }
is_ready() { [ "$(project_status)" = ready ]; }
wait_for 90 is_ready
check "both repositories cloned" ready "$(project_status)"
code=$(api POST "/projects/$PID/workstreams" '{"name":"fix","branch":"e2e/fix"}')
check "branching off fix answers 201" 201 "$code"
wait_for 30 has_session "$UNIX-shop-agent"
wait_for 30 has_session "$UNIX-shop-fix-agent"
AGENT_PID=$("$TMUX_BOX" display-message -p -t "=$UNIX-shop-agent" '#{pane_pid}' 2>/dev/null)

echo "--- add a third repository"
SLOW="$ROOT/github/e2e-octocat/shop-docs.git/termag-e2e-slow"
echo 10 >"$SLOW"
code=$(api POST "/projects/$PID/repos" '{"url":"https://github.com/e2e-octocat/shop-docs.git"}')
check "POST /repos answers 202, the new repository pending" "202 shop-docs pending" "$code $(jq -r '.repo.name + " " + .repo.setupStatus' "$WORK/body")"
repo_status() { sql "select \"setupStatus\" from project_repos where \"projectId\" = '$PID' and name = '$1'"; }
docs_cloning() { [ "$(repo_status shop-docs)" = cloning ]; }
docs_ready() { [ "$(repo_status shop-docs)" = ready ]; }
wait_for 20 docs_cloning
check "while it clones the project stays ready" "cloning ready" "$(repo_status shop-docs) $(project_status)"
bcode=$(api POST "/projects/$PID/workstreams" '{"name":"early","branch":"e2e/early"}')
check "branching off while it clones is refused" "409 shop-docs is not cloned yet" "$bcode $(jq -r .error "$WORK/body")"
check "and makes no workstream" "0 gone" \
  "$(sql "select count(*) from workstreams where \"projectId\" = '$PID' and name = 'early'") $(exists "$D/.worktrees/early")"
rm -f "$SLOW"
wait_for 60 docs_ready
check "its clone and worktrees are done" ready "$(repo_status shop-docs)"
check "the project stayed ready the whole time" ready "$(project_status)"
check "it is checked out in main and in fix on fix's branch" "ok:main ok:e2e/fix" \
  "$(statuses "$D/shop-docs" "$D/.worktrees/fix/shop-docs")"
check "the worktree is the new checkout's" yes \
  "$(git -C "$D/shop-docs" worktree list --porcelain | grep -qxF "worktree $D/.worktrees/fix/shop-docs" && echo yes || echo no)"
check "both generated guides list it" "shop-web shop-api shop-docs | shop-web shop-api shop-docs" \
  "$(guide_repos "$D") | $(guide_repos "$D/.worktrees/fix")"
check "the agent session kept running" "$AGENT_PID" "$("$TMUX_BOX" display-message -p -t "=$UNIX-shop-agent" '#{pane_pid}' 2>/dev/null)"
code=$(api GET "/projects/$PID/repos")
check "GET /repos lists the three" "200 shop-web shop-api shop-docs" "$code $(jq -r '[.repos[].name] | join(" ")' "$WORK/body")"
code=$(api POST "/projects/$PID/repos" '{"url":"git@github.com:e2e-octocat/shop-docs.git"}')
check "adding it again is refused" "400 yes" "$code $(jq -r .error "$WORK/body" | grep -q 'already in this project' && echo yes || echo no)"
code=$(api POST "/projects/$PID/repos" '{"url":"e2e-octocat/shop-docs"}')
check "owner/name is not a URL the backend takes" 400 "$code"

echo "--- a workstream made after the add has it"
code=$(api POST "/projects/$PID/workstreams" '{"name":"late","branch":"e2e/late"}')
check "branching off late answers 201" 201 "$code"
late_ready() { [ -e "$D/.worktrees/late/shop-docs/.git" ]; }
wait_for 30 late_ready
check "late has all three, on its branch" "ok:e2e/late ok:e2e/late ok:e2e/late" \
  "$(statuses "$D/.worktrees/late/shop-web" "$D/.worktrees/late/shop-api" "$D/.worktrees/late/shop-docs")"

echo "--- a repository that cannot be cloned fails alone"
code=$(api POST "/projects/$PID/repos" '{"url":"https://github.com/e2e-octocat/no-such-repo.git"}')
check "POST /repos answers 202" 202 "$code"
gone_failed() { [ "$(repo_status no-such-repo)" = failed ]; }
wait_for 60 gone_failed
check "it is failed, the project still ready, its sessions up" "failed ready yes yes" \
  "$(repo_status no-such-repo) $(project_status) $(has_session "$UNIX-shop-agent" && echo yes || echo no) $(has_session "$UNIX-shop-fix-agent" && echo yes || echo no)"
check "the guides do not list it" "shop-web shop-api shop-docs" "$(guide_repos "$D")"
code=$(api POST "/projects/$PID/workstreams" '{"name":"after","branch":"e2e/after"}')
check "branching off still works, leaving it out" "201 ok:e2e/after ok:e2e/after ok:e2e/after gone" \
  "$code $(statuses "$D/.worktrees/after/shop-web" "$D/.worktrees/after/shop-api" "$D/.worktrees/after/shop-docs") $(exists "$D/.worktrees/after/no-such-repo")"
check "and the new workstream's guide does not list it" "shop-web shop-api shop-docs" "$(guide_repos "$D/.worktrees/after")"

echo
if [ "$fails" -eq 0 ]; then echo "multi-repo-add: all checks passed"; else echo "multi-repo-add: $fails check(s) failed"; exit 1; fi
