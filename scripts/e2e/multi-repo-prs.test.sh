#!/usr/bin/env bash
# The git readers of a multi-repo workstream end to end:
# a project of example-org/termag (seeded here,
# so the GitHub stub's own PR #4244 is in one of its repositories) and
# e2e-octocat/shop-web, with a workstream on #4244's branch. The PR pipeline
# links #4244 and shop-web#12 (own-prs.json) to it, and lists a second
# workstream's branch with no PR; the Review pane opens in the PR's repository,
# with that repository's prompt template, and refuses a bare number; a spawn's
# retire reads every repository, keeps the workstream for unpushed work and
# removes it once there is none. Its own ports and TMPDIR, beside a stack that
# is already up.
#
# Run: bash scripts/e2e/multi-repo-prs.test.sh
#   E2E_TEST_PORT_SHIFT=N        add N to every port
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_CACHE_DIR=${E2E_TEST_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/termag-e2e}
S=${E2E_TEST_PORT_SHIFT:-0}
export E2E_PORT=$((4030 + S)) E2E_FRONTEND_PORT=$((6046 + S)) E2E_PG_PORT=$((55519 + S)) E2E_GITHUB_PORT=$((4740 + S)) \
  E2E_AWS_PORT=$((4730 + S)) E2E_BOXES=1 E2E_FAKE_GITHUB=1 E2E_FAKE_AWS=1 E2E_CREDENTIAL_STORE=1 \
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

BOX=$(jq -r '.[0].id' "$ROOT/boxes.json")
DIR="$ROOT/boxes/box-1/home/termag/projects/duo"
TMUX_BOX="$ROOT/boxes/box-1/bin/tmux"

echo "--- seed example-org/termag in the stub, and store a GitHub token"
seed="$WORK/seed-termag"
git_e2e init -q -b main "$seed" && echo '# termag' >"$seed/README.md" && git_e2e -C "$seed" add -A && git_e2e -C "$seed" commit -q -m 'initial commit'
mkdir -p "$ROOT/github/example-org"
git clone -q --bare "$seed" "$ROOT/github/example-org/termag.git"
git -C "$ROOT/github/example-org/termag.git" config http.receivepack true
touch "$ROOT/github/example-org/termag.git/termag-e2e-public"
echo '[{"repo":"e2e-octocat/shop-web","number":12,"title":"The shop-web half of #4244","headRefName":"e2e/own-4244"}]' >"$ROOT/github/own-prs.json"
GH_TOKEN=gho_e2eMultiRepoPrs0123456789abcdefABCD # gitleaks:allow (a fake token only the GitHub stub knows)
code=$(api PUT /credentials/github "{\"token\":\"$GH_TOKEN\"}")
check "PUT /api/credentials/github answers 200" 200 "$code"

echo "--- a project of two repositories, and a workstream on #4244's branch"
code=$(api POST /projects "{\"name\":\"duo\",\"instanceId\":\"$BOX\",\"initialAgent\":{\"enabled\":true,\"provider\":\"claude\"},\"repos\":[{\"url\":\"https://github.com/example-org/termag.git\"},{\"url\":\"https://github.com/e2e-octocat/shop-web.git\"}]}")
check "POST /api/projects with repos answers 201" 201 "$code"
PID=$(jq -r .id "$WORK/body")
is_ready() { [ "$(sql "select \"setupStatus\" from projects where id = '$PID'")" = ready ]; }
wait_for 90 is_ready
check "both repositories cloned" ready "$(sql "select \"setupStatus\" from projects where id = '$PID'")"
code=$(api POST "/projects/$PID/workstreams" '{"name":"own","branch":"e2e/own-4244"}')
check "POST workstreams answers 201" 201 "$code"
WSDIR="$DIR/.worktrees/own"
git_e2e -C "$WSDIR/shop-web" commit -q --allow-empty -m 'wip in shop-web'
check "shop-web's worktree has a commit of its own" 1 "$(git -C "$WSDIR/shop-web" rev-list --count origin/main..HEAD)"
code=$(api POST "/projects/$PID/workstreams" '{"name":"solo","branch":"e2e/solo"}')
check "POST a second workstream answers 201" 201 "$code"
git_e2e -C "$DIR/.worktrees/solo/shop-web" commit -q --allow-empty -m 'wip in solo'

echo "--- PR lanes"
code=$(api GET /prs)
check "GET /api/prs answers 200, connected" "200 true" "$code $(jq -r .connected "$WORK/body")"
rows() { jq -c "[.lanes[].rows[] | $1]" "$WORK/body"; }
check "#4244 (example-org/termag) links to the workstream through termag's worktree" '["own"]' \
  "$(rows 'select(.number == 4244) | .workstream.workstream')"
check "shop-web#12, on the same branch, links to it through shop-web's worktree" '["own"]' \
  "$(rows 'select(.repo == "e2e-octocat/shop-web" and .number == 12) | .workstream.workstream')"
check "and neither of its branches, which the two PRs cover, is a row" '[]' "$(rows 'select(.kind == "branch" and .workstream.workstream == "own")')"
check "a branch with no PR is a row of its workstream and repository" '[{"ws":"solo","repo":"e2e-octocat/shop-web","branch":"e2e/solo"}]' \
  "$(rows 'select(.kind == "branch") | {ws: .workstream.workstream, repo, branch: .headRefName}')"
check "the box half read every repository (no note of an unread workstream)" "[]" \
  "$(jq -c '[.notes[]? | select(test("workstream"))]' "$WORK/body")"

echo "--- the Review pane"
mkdir -p "$WSDIR/shop-web/.termag"
echo 'Review {{url}} by the shop-web rules.' >"$WSDIR/shop-web/.termag/review-prompt.md"
code=$(api GET "/projects/$PID/review/guess?workstream=own")
check "the guess names both repositories, and no single one" '200 ["example-org/termag","e2e-octocat/shop-web"] null true' \
  "$code $(jq -c .repos "$WORK/body") $(jq -r .repo "$WORK/body") $(jq -r .repoKnown "$WORK/body")"
check "and each repository's prompt template, shop-web's from its worktree" '[["example-org/termag","builtin"],["e2e-octocat/shop-web","repo"]] builtin' \
  "$(jq -c '[.promptTemplates[] | [.repo, .source]]' "$WORK/body") $(jq -r .promptSource "$WORK/body")"
code=$(api POST "/projects/$PID/review" '{"workstream":"own","pr":4244}')
check "a bare number is refused, naming the repositories" "400 yes" \
  "$code $(jq -r .error "$WORK/body" | grep -q 'several repositories (example-org/termag, e2e-octocat/shop-web)' && echo yes || echo no)"
code=$(api POST "/projects/$PID/review" '{"workstream":"own","pr":4244,"url":"https://github.com/example-org/termag/pull/4244"}')
check "with the PR's URL the review starts" 201 "$code"
SESSION=$(jq -r .session "$WORK/body")
check "its pane opens in the PR's repository" "$WSDIR/termag" "$("$TMUX_BOX" list-panes -t "=$SESSION" -F '#{pane_current_path}' 2>/dev/null)"
code=$(api DELETE "/projects/$PID/review?workstream=own")
check "the review stops" 200 "$code"
code=$(api POST "/projects/$PID/review" '{"workstream":"own","pr":12,"url":"https://github.com/e2e-octocat/shop-web/pull/12"}')
SESSION=$(jq -r .session "$WORK/body")
check "an unedited review of shop-web#12 is prompted from shop-web's template" "201 yes" \
  "$code $(grep -qF 'Review https://github.com/e2e-octocat/shop-web/pull/12 by the shop-web rules.' "$ROOT/boxes/box-1/home/.termag/review-prompts/$SESSION.md" 2>/dev/null && echo yes || echo no)"
api DELETE "/projects/$PID/review?workstream=own" >/dev/null
rm -rf "$WSDIR/shop-web/.termag"

echo "--- a spawn's retire reads every repository"
UID_=$(sql "select \"userId\" from projects where id = '$PID'")
sql "insert into agent_spawns (id, \"userId\", relationship, \"childProjectId\", \"childProjectName\", \"childWorkstream\", \"childInstanceId\", provider, title, brief, state, \"reportedAt\", \"updatedAt\") values ('e2e-mr-spawn', '$UID_', 'delegate', '$PID', 'duo', 'own', '$BOX', 'claude', 'e2e', 'e2e', 'done', now(), now())" >/dev/null
code=$(api POST /spawns/e2e-mr-spawn/dismiss '{"action":"retire"}')
check "kept while shop-web has a commit never pushed, naming it" "409 kept: shop-web: 1 commit never pushed" "$code $(jq -r .error "$WORK/body")"
check "and the workstream is still there" yes "$( [ -d "$WSDIR/shop-web" ] && echo yes || echo no)"
git -C "$WSDIR/shop-web" reset -q --hard origin/main
code=$(api POST /spawns/e2e-mr-spawn/dismiss '{"action":"retire"}')
check "with nothing beyond base in either, it retires" "200 retired" "$code $(jq -r .lifecycle "$WORK/body")"
check "the workstream folder is gone, main's checkouts stay" "gone yes yes" \
  "$( [ -e "$WSDIR" ] && echo there || echo gone) $( [ -d "$DIR/termag/.git" ] && echo yes || echo no) $( [ -d "$DIR/shop-web/.git" ] && echo yes || echo no)"

echo
if [ "$fails" -eq 0 ]; then echo "multi-repo-prs: all checks passed"; else echo "multi-repo-prs: $fails check(s) failed"; exit 1; fi
