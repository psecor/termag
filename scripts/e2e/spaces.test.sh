#!/usr/bin/env bash
# End-to-end check of spaces against a real local stack with
# Floci as S3, STS and KMS: the browser API creates a space and grants a box,
# the box's CLI (on its own agent token) puts and gets single and multipart
# files and folders, moves and removes them, an ungranted box and a revoked
# grant see nothing, a box cannot manage a space, objects land SSE-KMS under
# alias/termag-spaces in the derived bucket, and every transfer is in the
# space's events, and an automation in the space gets its folder
# (decision 13): the fixed .termag/automations/<id>, a
# chosen folder refused, its README written into the folder by the box, its
# files kept out of space memory, and the move script taking an old folder's
# notes there. Runs on its own ports and TMPDIR, beside any stack that is up.
#
# Run: bash scripts/e2e/spaces.test.sh   (or make e2e-test-spaces)
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-3960} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-5994} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55459} E2E_BOXES=2 \
  E2E_AWS_PORT=${E2E_TEST_AWS_PORT:-4676} E2E_FAKE_AWS=1 E2E_SPACES=1 E2E_FLAGS='{"automations-enabled":true,"automation-space-folder-enabled":true}'
[ -n "${E2E_KEEP:-}" ] || trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

# npm ci when the lockfile is newer than the last install (npm's own .package-lock.json), not only when
# there is none: an existing checkout must pick up a new dependency.
if [ "$repo/cli/package-lock.json" -nt "$repo/cli/node_modules/.package-lock.json" ]; then
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

echo "--- direct links"
link_path=/termag/files/team/docs/note.txt
check "space url prints the file's /termag/files/ link" "$link_path" \
  "$(on_box box-1 space url team:docs/note.txt 2>/dev/null | sed -E 's#^https?://[^/]+##')"
check "space url of a missing file is exit 3" 3 "$(on_box box-1 space url team:docs/nope.txt >/dev/null 2>&1; echo $?)"
loc=$(curl -s -o /dev/null -w '%{redirect_url}' -b "$JAR" "$API/files/team/docs/note.txt")
check "a signed-in link is a 302 to storage" "$AWS/$BUCKET/" "$(printf '%s' "$loc" | grep -o "^$AWS/$BUCKET/")"
check "which serves the file" "hello spaces" "$(curl -s "$loc")"
check "plain text opens inline" yes "$(curl -sI "$loc" | grep -qi '^content-disposition: inline' && echo yes || echo no)"
printf '<script>alert(1)</script>' >"$WORK/box-1/page.html"
on_box box-1 space put page.html team:docs/page.html >/dev/null 2>&1
html_loc=$(curl -s -o /dev/null -w '%{redirect_url}' -b "$JAR" "$API/files/team/docs/page.html")
html_head=$(curl -sI "$html_loc" | tr -d '\r')
check "HTML downloads as an attachment" yes "$(printf '%s' "$html_head" | grep -qi '^content-disposition: attachment' && echo yes || echo no)"
check "typed application/octet-stream" "application/octet-stream" "$(printf '%s' "$html_head" | sed -n 's/^content-type: //Ip')"
check "a missing file is 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$API/files/team/docs/nope.txt")"
check "an unknown space is the same 404" 404 "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$API/files/nope/docs/note.txt")"
check "the link works through the frontend's proxy" 302 \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "http://localhost:$E2E_FRONTEND_PORT$link_path")"
ANON="$WORK/anon-cookies"
check "signed out, the link sends you to sign in" "/termag/auth/login" \
  "$(curl -s -o /dev/null -w '%{redirect_url}' -c "$ANON" -b "$ANON" "$API/files/team/docs/note.txt" | sed -E 's#^https?://[^/]+##')"
check "and signing in comes back to the link" "$link_path" \
  "$(curl -s -o /dev/null -w '%{redirect_url}' -c "$ANON" -b "$ANON" "$API/auth/login" | sed -E 's#^https?://[^/]+##')"
check "the link's GET is an event" true \
  "$(browser GET /spaces/team/events | jq -r '[.events[] | select(.action == "file.get" and .path == "docs/page.html" and .actorInstanceId == null)] | length > 0')"

echo "--- a box shares what a PR links (docs/spaces.md, \"Sharing a file\")"
# A third person, signed in to termag but no member of team: a session row and its signed cookie
# (docs/e2e-stack.md, "A second user"), and in ALLOWED_USERS, which every shared read re-checks.
"${PSQL[@]}" -c "INSERT INTO users (id, \"googleId\", \"googleEmail\", \"unixUsername\", \"displayName\", \"onboardedAt\") VALUES ('e2e-riley', 'e2e-riley', 'riley@termag.local', 'riley', 'Riley', now())" >/dev/null
"${PSQL[@]}" -c "INSERT INTO session (sid, sess, expire) VALUES ('e2e-riley-sid', '{\"cookie\":{\"originalMaxAge\":86400000,\"expires\":\"2099-01-01T00:00:00.000Z\",\"httpOnly\":true,\"path\":\"/termag\"},\"passport\":{\"user\":\"e2e-riley\"}}', now() + interval '1 day')" >/dev/null
sed -i -E 's/^(ALLOWED_USERS=.*)$/\1,riley@termag.local:riley/' "$ROOT/backend.env"
connected() { grep -c '\[AGENT\] Connected: ' "$ROOT/logs/backend.log" 2>/dev/null || true; }
before=$(connected)
bash "$here/ctl.sh" restart backend >/dev/null 2>&1
# Both boxes' agents reconnect before anything below (the automations) needs them.
for _ in $(seq 1 240); do [ "$(connected)" -ge $((before + 2)) ] && break; sleep 0.25; done
RILEY="termag.sid=$(cd "$repo/backend" && node -e 'process.stdout.write(encodeURIComponent("s:" + require("cookie-signature").sign("e2e-riley-sid", process.argv[1])))' \
  "$(sed -n 's/^SESSION_SECRET=//p' "$ROOT/backend.env")")"
as_riley() { curl -s -o /dev/null -w "$1" -H "Cookie: $RILEY" "$API/files/team/$2"; }
printf 'png' >"$WORK/box-1/x.png"
on_box box-1 space put x.png team:artifacts/x.png >/dev/null 2>&1
on_box box-1 space put x.png team:notes.md >/dev/null 2>&1
check "riley is signed in" riley@termag.local "$(curl -s -H "Cookie: $RILEY" "$API/auth/me" | jq -r .email)"
check "before the share, the link is a 404 for riley" 404 "$(as_riley '%{http_code}' artifacts/x.png)"
check "the box shares a file" 0 "$(on_box box-1 space share team:artifacts/x.png >/dev/null 2>&1; echo $?)"
check "space ls marks it shared" "x.png (shared)" "$(on_box box-1 space ls team:artifacts/ 2>/dev/null | grep -o 'x.png (shared)')"
check "the share names the box's owner" "e2e@termag.local" \
  "$(on_box box-1 space share team:artifacts/x.png --json 2>/dev/null | jq -r .sharedBy.email)"
check "and its event the box" "$("${PSQL[@]}" -c "select id from instances where name = 'box-1'")" \
  "$(browser GET /spaces/team/events | jq -r '[.events[] | select(.action == "file.share" and .path == "artifacts/x.png")][0].actorInstanceId')"
check "riley, no member, opens the box's link" "$AWS/$BUCKET/" "$(as_riley '%{redirect_url}' artifacts/x.png | grep -o "^$AWS/$BUCKET/")"
check "the box shares a file at the space root too: there is no folder limit" 0 "$(on_box box-1 space share team:notes.md >/dev/null 2>&1; echo $?)"
check "which riley opens as well" "$AWS/$BUCKET/" "$(as_riley '%{redirect_url}' notes.md | grep -o "^$AWS/$BUCKET/")"
check "the box makes it private again" 0 "$(on_box box-1 space unshare team:notes.md >/dev/null 2>&1; echo $?)"
check "the box unshares it" 0 "$(on_box box-1 space unshare team:artifacts/x.png >/dev/null 2>&1; echo $?)"
check "and riley's link is a 404 again" 404 "$(as_riley '%{http_code}' artifacts/x.png)"

echo "--- audit"
events=$(browser GET /spaces/team/events)
check "the box's puts are events, with the box as actor" true \
  "$(echo "$events" | jq -r '[.events[] | select(.action == "file.put" and .path == "data/big.bin" and .actorInstanceId != null)] | length > 0')"
check "the browser's put is an event with no box" true \
  "$(echo "$events" | jq -r '[.events[] | select(.action == "file.put" and .path == "docs/from-browser.md" and .actorInstanceId == null)] | length > 0')"
check "usage counts what was uploaded" true \
  "$(browser GET /spaces/team | jq -r '.space.usedBytes >= 73400320')"

echo "--- an automation's folder"
# The box runs `~/.local/bin/termag space put` as a one-shot, as termag-reconcile installs it on real boxes.
BOX1_HOME="$ROOT/boxes/box-1/home"
mkdir -p "$BOX1_HOME/.local/bin"
printf '#!/bin/sh\nexec node %s/cli/bin/termag.js "$@"\n' "$repo" >"$BOX1_HOME/.local/bin/termag"
chmod +x "$BOX1_HOME/.local/bin/termag"
box1=$("${PSQL[@]}" -c "select id from instances where name = 'box-1'")
auto() { printf '{"name":"%s","instanceId":"%s","schedule":"0 9 * * 1","timezone":"UTC","prompt":"Say hi.","tier":"read","enabled":false,"spaceName":"team"%s}' "$1" "$box1" "${2:+,\"spaceFolder\":\"$2\"}"; }
created=$(browser POST /automations "$(auto weekly)")
weekly=$(echo "$created" | jq -r .automation.id)
check "an automation in a space lives in .termag/automations/<its id>" "team .termag/automations/$weekly" \
  "$(echo "$created" | jq -r '"\(.automation.spaceName) \(.automation.spaceFolder)"')"
check "a body naming a folder is refused: the folder is fixed" space_folder_fixed \
  "$(browser POST /automations "$(auto other 'automations/weekly')" | jq -r .code)"
daily=$(browser POST /automations "$(auto daily)" | jq -r .automation.id)
check "another automation of the space gets a folder of its own" ".termag/automations/$daily" \
  "$(browser GET "/automations/$daily" | jq -r .spaceFolder)"
readme=""
for _ in $(seq 1 60); do
  readme=$(on_box box-1 space get "team:.termag/automations/$weekly/README.md" readme.md >/dev/null 2>&1 && head -1 "$WORK/box-1/readme.md")
  [ -n "$readme" ] && break
  sleep 1
done
check "the box wrote the README into the folder" "# Automation weekly" "$readme"
check "which lays out the folder" yes "$(grep -q 'memory/MEMORY.md' "$WORK/box-1/readme.md" && grep -q 'runs/<run>.md' "$WORK/box-1/readme.md" && echo yes || echo no)"
check "an automation's files are not in the space memory log" 0 \
  "$(browser GET /spaces/team/memory/log | jq '[.entries[] | select(.path | startswith(".termag/automations/"))] | length')"
printf 'the box pasted AKIA%s here\n' ZZZZZZZZZZZZZZZZ >"$WORK/box-1/run.md"
check "a run log under .termag/automations/ is not refused by the memory secret scan" 0 \
  "$(on_box box-1 space put run.md "team:.termag/automations/$weekly/runs/run-1.md" >/dev/null 2>&1; echo $?)"

echo "--- moving an old folder (scripts/moveAutomationFolders.ts)"
legacy=$(browser POST /automations "$(auto legacy)" | jq -r .automation.id)
printf '# notes\nlearned a thing\n' >"$WORK/box-1/notes.md"
on_box box-1 space put notes.md team:automations/legacy/memory/MEMORY.md >/dev/null 2>&1
printf 'keep me\n' >"$WORK/box-1/out.txt"
on_box box-1 space put out.txt team:automations/legacy/outputs/run-1/out.txt >/dev/null 2>&1
"${PSQL[@]}" -c "update automations set \"spaceFolder\" = 'automations/legacy' where id = '$legacy'" >/dev/null
move() { (cd "$repo/backend" && set -a && . "$ROOT/backend.env" && set +a && npx tsx src/scripts/moveAutomationFolders.ts "$@" 2>/dev/null | grep "^{"); }  # the backend logs to stdout too
check "a dry run says it would move the notes" would_move "$(move | jq -r "select(.id == \"$legacy\") | .result")"
check "and moves nothing" "automations/legacy" "$(browser GET "/automations/$legacy" | jq -r .spaceFolder)"
check "--apply moves it" moved "$(move --apply | jq -r "select(.id == \"$legacy\") | .result")"
check "the row says the fixed folder" ".termag/automations/$legacy" "$(browser GET "/automations/$legacy" | jq -r .spaceFolder)"
on_box box-1 space get "team:.termag/automations/$legacy/memory/MEMORY.md" moved.md >/dev/null 2>&1
check "the notes are at the fixed folder" "learned a thing" "$(sed -n 2p "$WORK/box-1/moved.md")"
on_box box-1 space get team:automations/legacy/memory/MEMORY.md gone.md >/dev/null 2>&1
check "and gone from the old one (exit 3)" 3 $?
check "a run's outputs stay where people may link to them" 0 \
  "$(on_box box-1 space get team:automations/legacy/outputs/run-1/out.txt kept.txt >/dev/null 2>&1; echo $?)"
check "a second run has nothing left to do" "" "$(move --apply | jq -r "select(.id == \"$legacy\") | .result")"

echo "--- revoking"
check "remove box-1's grant" 200 "$(status DELETE "/spaces/team/boxes/$box1")"
on_box box-1 space get team:docs/note.txt again.txt >/dev/null 2>&1
check "box-1 no longer reaches team (exit 3)" 3 $?
check "delete the space" 200 "$(status DELETE /spaces/team)"
check "it is gone from the list" "[]" "$(browser GET /spaces | jq -c .spaces)"

echo
if [ "$failures" -gt 0 ]; then echo "$failures check(s) failed"; exit 1; fi
echo "all spaces checks passed"
