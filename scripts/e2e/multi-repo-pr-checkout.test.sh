#!/usr/bin/env bash
# Checking a pull request out into a multi-repo project end to end:
# a project of
# e2e-octocat/shop-web and example-org/e2e-demo, and PRs in e2e-demo (own-prs.json, their
# heads real commits on the stub's bare repository). "New workstream for #N"
# puts the PR's branch in e2e-demo's worktree and shop-web's on the same branch;
# a PR of a repository the project does not hold is refused, naming the ones it
# does; a PR already checked out is refused with nothing left behind; and a
# clash in another repository undoes the tree but keeps the PR's branch. Its own
# ports and TMPDIR, beside a stack that is already up.
#
# Run: bash scripts/e2e/multi-repo-pr-checkout.test.sh
#   E2E_TEST_PORT_SHIFT=N        add N to every port
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_CACHE_DIR=${E2E_TEST_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/termag-e2e}
S=${E2E_TEST_PORT_SHIFT:-0}
export E2E_PORT=$((4050 + S)) E2E_FRONTEND_PORT=$((6056 + S)) E2E_PG_PORT=$((55529 + S)) E2E_GITHUB_PORT=$((4750 + S)) \
  E2E_AWS_PORT=$((4760 + S)) E2E_BOXES=1 E2E_FAKE_GITHUB=1 E2E_FAKE_AWS=1 E2E_CREDENTIAL_STORE=1 \
  E2E_FLAGS='{"multi-repo-projects-enabled":true}'
trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

fails=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"; echo "FAIL: up.sh with E2E_FAKE_GITHUB, E2E_FAKE_AWS and E2E_CREDENTIAL_STORE"; exit 1
fi
pass "up.sh brought the stack up"

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
error_has() { if jq -r .error "$WORK/body" | grep -qF "$1"; then echo yes; else jq -r .error "$WORK/body"; fi; }

BOX=$(jq -r '.[0].id' "$ROOT/boxes.json")
DIR="$ROOT/boxes/box-1/home/termag/projects/shop"

echo "--- PRs #7 and #8 in e2e-demo, and a GitHub token"
DEMO_BARE="$ROOT/github/example-org/e2e-demo.git"
seed="$WORK/seed-demo"
git clone -q "$DEMO_BARE" "$seed"
pr_branch() { # pr_branch NUMBER BRANCH: a commit on BRANCH, pushed as it and as refs/pull/NUMBER/head; prints its sha
  git_e2e -C "$seed" checkout -q -b "$2" origin/main
  git_e2e -C "$seed" commit -q --allow-empty -m "the change of #$1"
  git -C "$seed" push -q origin "$2:refs/heads/$2" "$2:refs/pull/$1/head"
  git -C "$seed" rev-parse HEAD
}
HEAD7=$(pr_branch 7 e2e/checkout)
HEAD8=$(pr_branch 8 e2e/clash)
cat >"$ROOT/github/own-prs.json" <<EOF
[{"repo":"example-org/e2e-demo","number":7,"title":"The e2e-demo change","headRefName":"e2e/checkout"},
 {"repo":"example-org/e2e-demo","number":8,"title":"A branch shop-web also has","headRefName":"e2e/clash"}]
EOF
echo "{\"example-org/e2e-demo#7\":\"$HEAD7\",\"example-org/e2e-demo#8\":\"$HEAD8\"}" >"$ROOT/github/pr-heads.json"
GH_TOKEN=gho_e2eMultiRepoCheckout0123456789abcdefAB # gitleaks:allow (a fake token only the GitHub stub knows)
code=$(api PUT /credentials/github "{\"token\":\"$GH_TOKEN\"}")
check "PUT /api/credentials/github answers 200" 200 "$code"

echo "--- a project of two repositories"
code=$(api POST /projects "{\"name\":\"shop\",\"instanceId\":\"$BOX\",\"initialAgent\":{\"enabled\":true,\"provider\":\"claude\"},\"repos\":[{\"url\":\"https://github.com/e2e-octocat/shop-web.git\"},{\"url\":\"https://github.com/example-org/e2e-demo.git\"}]}")
check "POST /api/projects with repos answers 201" 201 "$code"
PID=$(jq -r .id "$WORK/body")
is_ready() { [ "$(sql "select \"setupStatus\" from projects where id = '$PID'")" = ready ]; }
wait_for 90 is_ready
check "both repositories cloned" ready "$(sql "select \"setupStatus\" from projects where id = '$PID'")"
WEB_MAIN=$(git -C "$DIR/shop-web" rev-parse HEAD)

echo "--- New workstream for e2e-demo#7"
code=$(api POST /prs/example-org/e2e-demo/7/workstream "{\"projectId\":\"$PID\",\"name\":\"demo-pr7\"}")
check "POST /api/prs/example-org/e2e-demo/7/workstream answers 201 on the PR's branch" "201 demo-pr7 e2e/checkout" \
  "$code $(jq -r .name "$WORK/body") $(jq -r .branch "$WORK/body")"
WS="$DIR/.worktrees/demo-pr7"
check "e2e-demo's worktree is the PR's branch at its head" "e2e/checkout $HEAD7" \
  "$(git -C "$WS/e2e-demo" branch --show-current) $(git -C "$WS/e2e-demo" rev-parse HEAD)"
check "it tracks origin's branch and is marked a PR checkout" "origin/e2e/checkout pr" \
  "$(git -C "$WS/e2e-demo" rev-parse --abbrev-ref '@{u}' 2>&1) $(git -C "$WS/e2e-demo" config --get branch.e2e/checkout.termagCheckout)"
check "shop-web's worktree is on the same branch, off its main checkout" "e2e/checkout $WEB_MAIN" \
  "$(git -C "$WS/shop-web" branch --show-current) $(git -C "$WS/shop-web" rev-parse HEAD)"
check "nothing went under e2e-demo's own checkout" "no" "$( [ -e "$DIR/e2e-demo/.worktrees/demo-pr7" ] && echo yes || echo no)"
check "the workstream root has its guide, naming the branch" "yes" \
  "$(grep -qF 'e2e/checkout' "$WS/AGENTS.md" 2>/dev/null && echo yes || echo no)"
check "the row is on the PR's branch" "e2e/checkout" \
  "$(sql "select branch from workstreams where \"projectId\" = '$PID' and name = 'demo-pr7'")"
code=$(api GET /prs)
check "GET /api/prs links e2e-demo#7 to the workstream" '200 ["demo-pr7"]' \
  "$code $(jq -c '[.lanes[].rows[] | select(.repo == "example-org/e2e-demo" and .number == 7) | .workstream.workstream]' "$WORK/body")"

echo "--- refusals"
code=$(api POST /prs/example-org/termag/4244/workstream "{\"projectId\":\"$PID\",\"name\":\"termag-pr\"}")
check "a PR of a repository the project does not hold is refused, naming the ones it does" "409 yes" \
  "$code $(error_has 'shop holds e2e-octocat/shop-web, example-org/e2e-demo, not example-org/termag')"
code=$(api POST /prs/example-org/e2e-demo/7/workstream "{\"projectId\":\"$PID\",\"name\":\"again\"}")
check "the same PR again is refused: its branch is in demo-pr7" "500 yes" "$code $(error_has "e2e/checkout is already checked out at $WS/e2e-demo")"
check "and leaves no workstream folder or row behind" "no 0" \
  "$( [ -e "$DIR/.worktrees/again" ] && echo yes || echo no) $(sql "select count(*) from workstreams where \"projectId\" = '$PID' and name = 'again'")"

echo "--- a clash in the other repository"
git_e2e -C "$DIR/shop-web" branch e2e/clash
code=$(api POST /prs/example-org/e2e-demo/8/workstream "{\"projectId\":\"$PID\",\"name\":\"demo-pr8\"}")
check "shop-web already has the PR's branch name: refused, naming shop-web" "500 yes" "$code $(error_has "shop-web: ")"
check "the tree is undone, e2e-demo's worktree included" "no no" \
  "$( [ -e "$DIR/.worktrees/demo-pr8" ] && echo yes || echo no) $(git -C "$DIR/e2e-demo" worktree list | grep -q demo-pr8 && echo yes || echo no)"
check "but the PR's branch stays in e2e-demo, at the PR's head" "$HEAD8" "$(git -C "$DIR/e2e-demo" rev-parse --verify -q refs/heads/e2e/clash)"
check "and shop-web's own branch of that name is untouched" "$WEB_MAIN" "$(git -C "$DIR/shop-web" rev-parse --verify -q refs/heads/e2e/clash)"

echo
if [ "$fails" -eq 0 ]; then echo "multi-repo-pr-checkout: all checks passed"; else echo "multi-repo-pr-checkout: $fails check(s) failed"; exit 1; fi
