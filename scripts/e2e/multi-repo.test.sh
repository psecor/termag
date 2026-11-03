#!/usr/bin/env bash
# Multi-repo projects end to end on their own
# stack: a project of two public stub repositories on a stand-in box, both
# cloned into a root that is not a repository; a workstream with a worktree of
# each; asks into one repository (the real runner with a
# stub claude), a bare one refused; a removal refused while the workstream
# folder holds a file outside both repositories, and done with force. Runs on
# its own ports and TMPDIR, beside a stack that is already up.
#
# Run: bash scripts/e2e/multi-repo.test.sh
#   E2E_TEST_PORT_SHIFT=N        add N to every port
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_CACHE_DIR=${E2E_TEST_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/termag-e2e}
S=${E2E_TEST_PORT_SHIFT:-0}
export E2E_PORT=$((3990 + S)) E2E_FRONTEND_PORT=$((5998 + S)) E2E_PG_PORT=$((55479 + S)) E2E_GITHUB_PORT=$((4690 + S)) E2E_BOXES=1 \
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

BOX=$(jq -r '.[0].id' "$ROOT/boxes.json")
DIR="$ROOT/boxes/box-1/home/termag/projects/shop"

echo "--- create a project of two repositories"
code=$(api POST /projects "{\"name\":\"shop\",\"instanceId\":\"$BOX\",\"initialAgent\":{\"enabled\":true,\"provider\":\"claude\"},\"repos\":[{\"url\":\"https://github.com/e2e-octocat/shop-web.git\"},{\"url\":\"https://github.com/e2e-octocat/shop-api.git\"}]}")
check "POST /api/projects with repos answers 201" 201 "$code"
PID=$(jq -r .id "$WORK/body")
check "the project is a workspace" workspace "$(jq -r .layout "$WORK/body")"
is_ready() { [ "$(sql "select \"setupStatus\" from projects where id = '$PID'")" = ready ]; }
wait_for 90 is_ready
check "both repositories cloned, and the project is ready" "ready" "$(sql "select \"setupStatus\" from projects where id = '$PID'")"
check "the root holds the marker, the guide and both checkouts" "AGENTS.md CLAUDE.md shop-api shop-web" \
  "$( [ -f "$DIR/.termag-workspace" ] && cd "$DIR" && ls | tr '\n' ' ' | sed 's/ $//')"
check "the root is not a git repository" "no" "$( [ -e "$DIR/.git" ] && echo yes || echo no)"

echo "--- branch off"
code=$(api POST "/projects/$PID/workstreams" '{"name":"fix","branch":"e2e/fix"}')
check "POST workstreams answers 201" 201 "$code"
WS=$(jq -r .id "$WORK/body")
check "each repository has a worktree on the branch" "e2e/fix e2e/fix" \
  "$(git -C "$DIR/.worktrees/fix/shop-web" branch --show-current) $(git -C "$DIR/.worktrees/fix/shop-api" branch --show-current)"

echo "--- asks, one repository at a time"
# The runner a box image carries, with a stub claude that reports where it
# ran and the first line of the README its clone holds.
(cd "$repo/cli" && { [ "$repo/cli/package-lock.json" -ot "$repo/cli/node_modules/.package-lock.json" ] || npm ci --no-audit --no-fund; } && npm run build) \
  >"$WORK/cli-build.log" 2>&1 || { cat "$WORK/cli-build.log"; echo "FAIL: cli build"; exit 1; }
BOX1_HOME=$ROOT/boxes/box-1/home
mkdir -p "$BOX1_HOME/.local/bin" "$BOX1_HOME/.local/lib/termag" "$WORK/claudebin"
install -m 0755 "$repo/deploy/termag-subagent-run" "$BOX1_HOME/.local/lib/termag/termag-subagent-run"
cat >"$WORK/claudebin/claude" <<'EOF'
#!/usr/bin/env bash
resume=
while [ $# -gt 0 ]; do case $1 in --resume) resume=$2; shift ;; esac; shift; done
prompt=$(cat)
case $PWD in "$HOME"/.termag/subagent/threads/*/repo) where=thread ;; *) where="$PWD" ;; esac
reply="ask-run prompt=[$prompt] where=$where readme=[$(head -n1 README.md 2>/dev/null)] resume=${resume:-none}"
jq -n --arg r "$reply" '{result: $r, session_id: "sess-e2e", num_turns: 1, is_error: false}'
EOF
cat >"$BOX1_HOME/.local/bin/termag-subagent-run" <<EOF
#!/bin/sh
export TERMAG_SUBAGENT_CLAUDE='$WORK/claudebin/claude'
exec '$BOX1_HOME/.local/lib/termag/termag-subagent-run' "\$@"
EOF
chmod +x "$WORK/claudebin/claude" "$BOX1_HOME/.local/bin/termag-subagent-run"
# The agent announces asks only where the runner is installed, so it restarts to see it.
bash "$here/ctl.sh" restart box-1 >"$WORK/restart.log" 2>&1 || { cat "$WORK/restart.log"; echo "FAIL: restart box-1"; exit 1; }
on_box1() { HOME="$BOX1_HOME" timeout 120 node "$repo/cli/bin/termag.js" "$@"; }
askable() { [ "$(on_box1 ask --targets --json 2>/dev/null | jq -r '.agents[] | select(.name == "box-1/shop:shop-web") | .capabilities.extensions[0].params.askable')" = true ]; }
wait_for 60 askable
check "--targets lists each repository of each workstream, and no bare project" \
  "box-1/shop:shop-web box-1/shop:shop-api box-1/shop@fix:shop-web box-1/shop@fix:shop-api" \
  "$(on_box1 ask --targets --json | jq -r '[.agents[].name | select(startswith("box-1/shop"))] | join(" ")')"

on_box1 ask box-1/shop "which repo?" >"$WORK/bare.out" 2>"$WORK/bare.err"
check "a bare ask is refused, naming the repositories" "1 yes" \
  "$? $(grep -qF 'rejected: box-1/shop holds several repositories (shop-web, shop-api); name one, as box-1/shop:<repo>' "$WORK/bare.err" && echo yes || cat "$WORK/bare.err")"
on_box1 ask box-1/shop:shop-db "hi" >/dev/null 2>"$WORK/unknown.err"
check "a repository the project does not hold is refused" "1 yes" \
  "$? $(grep -qF 'box-1/shop has no repository shop-db; it holds shop-web, shop-api' "$WORK/unknown.err" && echo yes || cat "$WORK/unknown.err")"
on_box1 ask box-1/sample:web "hi" >/dev/null 2>"$WORK/single.err"
check "a repository on a single-repository project is refused" "1 yes" \
  "$? $(grep -qF 'box-1/sample has one repository, so it takes no ":web"; ask box-1/sample' "$WORK/single.err" && echo yes || cat "$WORK/single.err")"
check "none of them made a thread" 0 "$(sql "select count(*) from agent_threads where \"projectId\" = '$PID'")"

on_box1 ask box-1/shop:shop-web "say hi" >"$WORK/web.out" 2>"$WORK/web.err"
check "an ask into shop-web exits 0" 0 $?
check "it ran in a clone of shop-web's checkout" yes \
  "$(grep -qF 'ask-run prompt=[say hi] where=thread readme=[# e2e-octocat/shop-web] resume=none' "$WORK/web.out" && echo yes || cat "$WORK/web.out" "$WORK/web.err")"
thread=$(sed -nE 's/^thread: ([a-z0-9]+).*/\1/p' "$WORK/web.out" | head -n1)
check "the thread records its repository" shop-web "$(sql "select \"repoName\" from agent_threads where id = '$thread'")"
on_box1 ask box-1/shop:shop-web "again" --thread "$thread" >"$WORK/again.out" 2>&1
check "a follow-up resumes it in the same clone" "0 yes" "$? $(grep -qF 'prompt=[again] where=thread readme=[# e2e-octocat/shop-web] resume=sess-e2e' "$WORK/again.out" && echo yes || cat "$WORK/again.out")"
on_box1 ask box-1/shop:shop-api "elsewhere" --thread "$thread" >"$WORK/mismatch.out" 2>&1
check "a follow-up naming the other repository is refused" "1 yes" "$? $(grep -qF 'another project, workstream or repository' "$WORK/mismatch.out" && echo yes || cat "$WORK/mismatch.out")"

# The fix workstream's worktree of shop-api gets a commit its remote has, so
# the run's base (the newest commit the branch's upstream has) is its own.
FIX_API="$DIR/.worktrees/fix/shop-api"
printf '# shop-api on e2e/fix\n' >"$FIX_API/README.md"
git -C "$FIX_API" -c user.name=e2e -c user.email=e2e@example.com commit -qam 'e2e: the fix branch'
git -C "$FIX_API" update-ref refs/remotes/origin/e2e/fix HEAD
git -C "$FIX_API" branch -q --set-upstream-to=origin/e2e/fix
on_box1 ask box-1/shop@fix:shop-api "and here?" >"$WORK/fix.out" 2>"$WORK/fix.err"
check "an ask into the fix workstream's shop-api exits 0" 0 $?
check "it ran in a clone of that workstream's worktree" yes \
  "$(grep -qF 'ask-run prompt=[and here?] where=thread readme=[# shop-api on e2e/fix] resume=none' "$WORK/fix.out" && echo yes || cat "$WORK/fix.out" "$WORK/fix.err")"
check "and the reply names the target with its repository" yes "$(grep -qF 'from="box-1/shop@fix:shop-api"' "$WORK/fix.out" && echo yes || echo no)"

echo "--- remove the workstream"
echo "draft" >"$DIR/.worktrees/fix/notes.md"
code=$(api DELETE "/projects/$PID/workstreams/$WS")
check "a file outside both repositories refuses the removal, naming it" "409 notes.md" "$code $(jq -r .error "$WORK/body" | grep -o 'notes\.md' | head -1)"
check "and nothing was removed" "yes yes" \
  "$( [ -d "$DIR/.worktrees/fix/shop-web" ] && echo yes || echo no) $( [ -d "$DIR/.worktrees/fix/shop-api" ] && echo yes || echo no)"
code=$(api DELETE "/projects/$PID/workstreams/$WS?force=1")
check "with force it goes, folder and all" "200 gone" "$code $( [ -e "$DIR/.worktrees/fix" ] && echo there || echo gone)"
check "main's checkouts are untouched" "yes yes" \
  "$( [ -d "$DIR/shop-web/.git" ] && echo yes || echo no) $( [ -d "$DIR/shop-api/.git" ] && echo yes || echo no)"

echo
if [ "$fails" -eq 0 ]; then echo "multi-repo: all checks passed"; else echo "multi-repo: $fails check(s) failed"; exit 1; fi
