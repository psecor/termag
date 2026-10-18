#!/usr/bin/env bash
# End-to-end check of spaces against a real local stack with
# Floci as S3, STS and KMS: the browser API creates a space and grants a box,
# the box's CLI (on its own agent token) puts and gets single and multipart
# files and folders, moves and removes them, an ungranted box and a revoked
# grant see nothing, a box cannot manage a space, objects land SSE-KMS under
# alias/termag-spaces in the derived bucket, and every transfer is in the
# space's events. Runs on its own ports and TMPDIR, beside any stack that is up.
#
# Run: bash scripts/e2e/spaces.test.sh   (or make e2e-test-spaces)
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-3960} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-5994} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55459} E2E_BOXES=2 \
  E2E_AWS_PORT=${E2E_TEST_AWS_PORT:-4676} E2E_FAKE_AWS=1 E2E_SPACES=1 E2E_FLAGS='{"spaces-enabled":true,"spaces-sharing-enabled":true}'
[ -n "${E2E_KEEP:-}" ] || trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

if [ ! -x "$repo/cli/node_modules/.bin/tsc" ]; then
  (cd "$repo/cli" && npm ci --no-audit --no-fund >"$WORK/cli-install.log" 2>&1) || { cat "$WORK/cli-install.log"; echo "FAIL: cli npm ci"; exit 1; }
fi
(cd "$repo/cli" && npm run build >"$WORK/cli-build.log" 2>&1) || { cat "$WORK/cli-build.log"; echo "FAIL: cli build"; exit 1; }
pass "cli builds"

if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"
  echo "FAIL: up.sh"
  exit 1
fi
pass "up.sh brought the stack up"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
API="http://127.0.0.1:$E2E_PORT/termag"
AWS="http://127.0.0.1:$E2E_AWS_PORT"
BUCKET=termag-spaces-000000000000-us-east-2-an
JAR="$WORK/browser-cookies"
curl -s -o /dev/null -c "$JAR" -b "$JAR" "$API/auth/login"
PSQL=(psql -tA "postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag")

browser() { # <method> <path> [json]
  if [ $# -ge 3 ]; then curl -s -b "$JAR" -X "$1" -H 'Content-Type: application/json' -d "$3" "$API/api$2"
  else curl -s -b "$JAR" -X "$1" "$API/api$2"; fi
}
status() { # <method> <path> [json]
  if [ $# -ge 3 ]; then curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X "$1" -H 'Content-Type: application/json' -d "$3" "$API/api$2"
  else curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X "$1" "$API/api$2"; fi
}
on_box() { local box=$1; shift; (cd "$WORK/$box" && HOME="$ROOT/boxes/$box/home" node "$repo/cli/bin/termag.js" "$@"); }
mkdir -p "$WORK/box-1" "$WORK/box-2"

echo "--- the browser API"
check "the seeded bucket is the derived name" "$BUCKET" "$(grep -o 'termag-spaces-[0-9a-z-]*-an' "$ROOT/logs/aws-seed.log" | tail -1)"
check "spaces list starts empty" "[]" "$(browser GET /spaces | jq -c .spaces)"
check "a bad space name is refused" 400 "$(status POST /spaces '{"name":"Bad Name"}')"
check "create a space" "team owner" "$(browser POST /spaces '{"name":"team","description":"e2e"}' | jq -r '"\(.space.name) \(.space.role)"')"
check "a taken name is refused" 409 "$(status POST /spaces '{"name":"team"}')"
check "a path with shell characters is refused" invalid_path "$(browser POST /spaces/team/files/upload '{"path":"$(id).txt","size":1}' | jq -r .code)"
check "a member who has not signed in yet becomes an invite" "other@termag.local editor" \
  "$(browser POST /spaces/team/members '{"email":"other@termag.local","role":"editor"}' | jq -r '"\(.invite.email) \(.invite.role)"')"
check "members: the owner and the invite" "e2e@termag.local owner|other@termag.local editor" \
  "$(browser GET /spaces/team/members | jq -r '[(.members[] | "\(.email) \(.role)"), (.invites[] | "\(.email) \(.role)")] | join("|")')"
"${PSQL[@]}" -c "INSERT INTO users (id, \"googleId\", \"googleEmail\", \"unixUsername\", \"displayName\") VALUES ('e2e-second', 'e2e-second', 'second@termag.local', 'second', 'Second')" >/dev/null
check "a signed-in user becomes a co-owner" "second@termag.local owner" \
  "$(browser POST /spaces/team/members '{"email":"second@termag.local","role":"owner"}' | jq -r '"\(.member.email) \(.member.role)"')"
check "a co-owner can be demoted" 200 "$(status PATCH /spaces/team/members/e2e-second '{"role":"viewer"}')"
check "the last owner cannot step down" "last_owner" "$(browser PATCH "/spaces/team/members/$("${PSQL[@]}" -c "SELECT id FROM users WHERE \"googleEmail\" = 'e2e@termag.local'")" '{"role":"editor"}' | jq -r .code)"
check "a member can be removed" 200 "$(status DELETE /spaces/team/members/e2e-second)"

echo "--- a box reaches only what it was given"
check "box-1 reaches no space before a grant" 0 "$(on_box box-1 space ls --json | jq '.spaces | length')"
on_box box-1 space ls team: >/dev/null 2>&1
check "box-1 cannot list team before a grant (exit 3)" 3 $?
check "grant box-1" box-1 "$(browser POST /spaces/team/boxes '{"box":"box-1"}' | jq -r .box.name)"
check "box-1 now reaches team, explicitly, with its granter's role" "team explicit owner" \
  "$(on_box box-1 space ls --json | jq -r '.spaces[] | "\(.name) \(.access.kind) \(.role)"')"
on_box box-2 space get team:anything >/dev/null 2>&1
check "box-2, never granted, gets not found (exit 3)" 3 $?
on_box box-1 space create other >"$WORK/create.out" 2>&1
check "a box cannot create a space (exit 1)" 1 $?
check "and is told why" yes "$(grep -q 'cannot manage spaces' "$WORK/create.out" && echo yes || echo no)"

echo "--- transfers from the box's CLI"
printf 'hello spaces\n' >"$WORK/box-1/note.txt"
check "put a small file (single PUT)" 0 "$(on_box box-1 space put note.txt team:docs/ >/dev/null 2>&1; echo $?)"
head -c $((70 * 1024 * 1024)) /dev/urandom >"$WORK/box-1/big.bin"
check "put a 70 MiB file (multipart)" 0 "$(on_box box-1 space put big.bin team:data/big.bin >"$WORK/put-big.out" 2>&1; echo $?)"
check "it went up in two parts" yes "$(grep -q 'part 2/2' "$WORK/put-big.out" && echo yes || echo no)"
mkdir -p "$WORK/box-1/site/img"
printf '<p>hi</p>' >"$WORK/box-1/site/index.html"
printf 'png' >"$WORK/box-1/site/img/a.png"
check "put a folder with -r" 0 "$(on_box box-1 space put -r site team:site >/dev/null 2>&1; echo $?)"
check "ls shows the folders" "data/ docs/ site/" "$(on_box box-1 space ls team: --json | jq -r '[.dirs[].name + "/"] | join(" ")')"
check "ls of a folder shows its files" "img/ index.html" \
  "$(on_box box-1 space ls team:site/ --json | jq -r '[(.dirs[].name + "/"), .files[].name] | join(" ")')"

check "get the small file back" "hello spaces" "$(on_box box-1 space get team:docs/note.txt copy.txt >/dev/null 2>&1; cat "$WORK/box-1/copy.txt")"
on_box box-1 space get team:data/big.bin big-copy.bin >/dev/null 2>&1
check "the 70 MiB file comes back byte for byte" "$(sha256sum <"$WORK/box-1/big.bin")" "$(sha256sum <"$WORK/box-1/big-copy.bin")"
check "get a folder with -r" "<p>hi</p> png" \
  "$(on_box box-1 space get -r team:site back >/dev/null 2>&1; echo "$(cat "$WORK/box-1/back/index.html") $(cat "$WORK/box-1/back/img/a.png")")"
printf 'star' >"$WORK/box-1/star.txt"
check "put a file named with * and ( )" 0 "$(on_box box-1 space put star.txt 'team:docs/a*(1).txt' >/dev/null 2>&1; echo $?)"
check "mv it to another name with * and ( )" 0 "$(on_box box-1 space mv 'team:docs/a*(1).txt' 'team:docs/b*(2).txt' >/dev/null 2>&1; echo $?)"
check "it comes back under the new name" star "$(on_box box-1 space get 'team:docs/b*(2).txt' star-copy.txt >/dev/null 2>&1; cat "$WORK/box-1/star-copy.txt")"
check "rm it" 0 "$(on_box box-1 space rm 'team:docs/b*(2).txt' >/dev/null 2>&1; echo $?)"
check "mv a folder" "Moved 2 files" "$(on_box box-1 space mv team:site/ team:www 2>/dev/null | cut -d: -f1)"
check "rm a folder" 0 "$(on_box box-1 space rm -r team:www/ >/dev/null 2>&1; echo $?)"
check "after mv and rm only data/ and docs/ are left" "data/ docs/" "$(on_box box-1 space ls team: --json | jq -r '[.dirs[].name + "/"] | join(" ")')"

echo "--- storage"
space_id=$(browser GET /spaces/team | jq -r .space.id)
key="$space_id/docs/note.txt"
head_out=$(curl -sI "$AWS/$BUCKET/$key")
check "the object is under <space id>/" 200 "$(printf '%s' "$head_out" | head -1 | awk '{print $2}')"
check "it is SSE-KMS" "aws:kms" "$(printf '%s' "$head_out" | tr -d '\r' | sed -n 's/^x-amz-server-side-encryption: //Ip')"
check "under the alias ARN" "arn:aws:kms:us-east-2:000000000000:alias/termag-spaces" \
  "$(printf '%s' "$head_out" | tr -d '\r' | sed -n 's/^x-amz-server-side-encryption-aws-kms-key-id: //Ip')"

echo "--- the browser's own transfers"
up=$(browser POST /spaces/team/files/upload '{"path":"docs/from-browser.md","size":6,"contentType":"text/markdown"}')
check "a small browser upload is one presigned PUT" single "$(echo "$up" | jq -r .kind)"
hdrs=()
while IFS= read -r h; do hdrs+=(-H "$h"); done < <(echo "$up" | jq -r '.headers | to_entries[] | "\(.key): \(.value)"')
check "the PUT to storage succeeds" 200 "$(printf "# hi!\\n" | curl -s -o /dev/null -w '%{http_code}' -X PUT "${hdrs[@]}" --data-binary @- "$(echo "$up" | jq -r .url)")"
check "and is recorded" 6 "$(browser POST /spaces/team/files/uploaded '{"path":"docs/from-browser.md"}' | jq -r .size)"
dl=$(browser POST /spaces/team/files/download '{"path":"docs/note.txt"}')
check "a download URL serves the file" "hello spaces" "$(curl -s "$(echo "$dl" | jq -r .url)")"
check "it downloads as an attachment" yes "$(curl -sI "$(echo "$dl" | jq -r .url)" | grep -qi '^content-disposition: attachment' && echo yes || echo no)"
check "a path outside the space is refused" 400 "$(status POST /spaces/team/files/download '{"path":"../x"}')"

echo "--- audit"
events=$(browser GET /spaces/team/events)
check "the box's puts are events, with the box as actor" true \
  "$(echo "$events" | jq -r '[.events[] | select(.action == "file.put" and .path == "data/big.bin" and .actorInstanceId != null)] | length > 0')"
check "the browser's put is an event with no box" true \
  "$(echo "$events" | jq -r '[.events[] | select(.action == "file.put" and .path == "docs/from-browser.md" and .actorInstanceId == null)] | length > 0')"
check "usage counts what was uploaded" true \
  "$(browser GET /spaces/team | jq -r '.space.usedBytes >= 73400320')"

echo "--- revoking"
box1=$("${PSQL[@]}" -c "select id from instances where name = 'box-1'")
check "remove box-1's grant" 200 "$(status DELETE "/spaces/team/boxes/$box1")"
on_box box-1 space get team:docs/note.txt again.txt >/dev/null 2>&1
check "box-1 no longer reaches team (exit 3)" 3 $?
check "delete the space" 200 "$(status DELETE /spaces/team)"
check "it is gone from the list" "[]" "$(browser GET /spaces | jq -c .spaces)"

echo
if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "all spaces checks passed"
