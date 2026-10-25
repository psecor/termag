#!/usr/bin/env bash
# End-to-end check of the desktop app's box bridge
# against a real local stack with E2E_T3=1: a CLI device sign-in (the PKCE
# flow the desktop app runs, with curl as the browser), then ensure, projects
# and pair on box-1, the pairing exchange, the descriptor, a session check and
# a WebSocket through the relay, a Claude turn on the box (the stand-in claude
# under the Agent SDK, running the box's Claude hooks) through the relay, what
# termag's status, working time and box activity make of such turns (a project
# checkout, a workstream's, two threads at once, a folder no project owns), t3's
# New worktree as a termag workstream (POST/DELETE …/projects/:id/workstreams),
# the box's t3 server restarted behind the relay's back, the refusals, and one
# t3 session per pairing label (a second pair, and t3/revoke). Runs on
# its own ports and TMPDIR, so it can run beside a stack that is already up.
#
# Run: bash scripts/e2e/t3.test.sh   (or make e2e-test-t3)
# E2E_T3_COMMAND=<cmd> runs the boxes on another t3 build (a fork's, say).
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-3960} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-5994} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55459} E2E_BOXES=1 \
  E2E_T3=1 E2E_FAKE_CLAUDE=1
trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"
  echo "FAIL: up.sh"
  exit 1
fi
pass "up.sh brought the stack up with E2E_T3=1"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
API="http://127.0.0.1:$E2E_PORT/termag"
CLI="$API/api/cli/v1"
JAR="$WORK/browser-cookies"

# ── a device sign-in, the way `termag login` and the desktop app get one ─────
verifier=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')
challenge=$(pkce_challenge "$verifier")
pkce_state=$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))')
query="port=45999&state=$pkce_state&code_challenge=$challenge&code_challenge_method=S256&device_name=e2e-desktop"
curl -s -o /dev/null -c "$JAR" -b "$JAR" "$API/auth/login"
curl -s -o /dev/null -c "$JAR" -b "$JAR" "$API/auth/cli/authorize?$query"
curl -s -o /dev/null -c "$JAR" -b "$JAR" -D "$WORK/approve.headers" \
  -H "Origin: http://127.0.0.1:$E2E_PORT" --data "$query&decision=approve" "$API/auth/cli/authorize"
code=$(grep -i '^location:' "$WORK/approve.headers" | tr -d '\r' | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
check "the approval redirects to the loopback with a code" yes "$([ -n "$code" ] && echo yes || echo no)"
curl -s -H 'Content-Type: application/json' -d "{\"grant_type\":\"authorization_code\",\"code\":\"$code\",\"code_verifier\":\"$verifier\"}" "$CLI/token" >"$WORK/token.json"
JWT=$(jq -r .accessToken "$WORK/token.json")
check "the code is traded for an access token" yes "$([[ $JWT == eyJ*.*.* ]] && echo yes || echo no)"
auth=(-H "Authorization: Bearer $JWT")

BOX=$(curl -s "${auth[@]}" "$CLI/boxes" | jq -r '.boxes[] | select(.name == "box-1") | .id')
check "box-1 is listed" yes "$([ -n "$BOX" ] && echo yes || echo no)"
# The agent advertises t3-v1 only where a t3 command resolves; give its hello a moment.
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${auth[@]}" "$CLI/boxes/$BOX/t3/ensure")" != 409 ] && break
  sleep 0.5
done

# ── ensure, projects, pair ────────────────────────────────────────────────
state=""
for _ in $(seq 1 120); do
  curl -s -X POST "${auth[@]}" "$CLI/boxes/$BOX/t3/ensure" >"$WORK/ensure.json"
  state=$(jq -r .state "$WORK/ensure.json")
  [ "$state" = ready ] && break
  sleep 1
done
check "ensure: the box's t3 server comes up" ready "$state"
check "ensure: home is the box's own" "$ROOT/boxes/box-1/home" "$(jq -r .home "$WORK/ensure.json")"
version=$(jq -r .version "$WORK/ensure.json")
check "ensure: reports a version" yes "$([ -n "$version" ] && [ "$version" != null ] && echo yes || echo no)"
T1="$ROOT/boxes/box-1/bin/tmux"
check "the server runs in the box's tmux session termag-t3" yes "$("$T1" has-session -t =termag-t3 2>/dev/null && echo yes || echo no)"
t3port=$(jq -r .port "$ROOT/boxes/box-1/home/.termag/t3.json")
check "its port is kept in ~/.termag/t3.json" yes "$([[ $t3port =~ ^[0-9]+$ ]] && echo yes || echo no)"
check "the server answers on loopback only" yes "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$t3port/.well-known/t3/environment" | grep -qx 200 && echo yes || echo no)"
check "its state is under the box's ~/.t3" yes "$([ -d "$ROOT/boxes/box-1/home/.t3/userdata" ] && echo yes || echo no)"

curl -s "${auth[@]}" "$CLI/boxes/$BOX/t3/projects" >"$WORK/projects.json"
check "projects: the seeded project, where the box keeps it" "sample $ROOT/boxes/box-1/home/termag/projects/sample true" \
  "$(jq -r '.projects[] | select(.name == "sample") | "\(.name) \(.directory) \(.exists)"' "$WORK/projects.json")"

curl -s -X POST "${auth[@]}" -H 'Content-Type: application/json' -d '{"label":"e2e desktop"}' "$CLI/boxes/$BOX/t3/pair" >"$WORK/pair.json"
cred=$(jq -r .credential "$WORK/pair.json")
check "pair: a one-time credential" yes "$([ -n "$cred" ] && [ "$cred" != null ] && echo yes || echo no)"

# ── through the relay ─────────────────────────────────────────────────────
R="$CLI/boxes/$BOX/t3/relay"
curl -s "${auth[@]}" -X POST "$R/oauth/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode "subject_token=$cred" \
  --data-urlencode 'subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap' \
  --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
  --data-urlencode 'client_label=e2e desktop' >"$WORK/t3token.json"
T3TOK=$(jq -r .access_token "$WORK/t3token.json")
check "relay: the pairing credential is exchanged for a t3 session" yes "$([ -n "$T3TOK" ] && [ "$T3TOK" != null ] && echo yes || echo no)"
check "relay: a credential is good once (t3 answers 401)" 401 "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X POST "$R/oauth/token" \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' --data-urlencode "subject_token=$cred" \
  --data-urlencode 'subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap' \
  --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token')"
check "relay: the descriptor" "$version 2" \
  "$(curl -s "${auth[@]}" "$R/.well-known/t3/environment" | jq -r '"\(.serverVersion) \(.orchestrationProtocolVersion)"')"
check "relay: the t3 session authenticates (X-T3-Authorization)" true \
  "$(curl -s "${auth[@]}" -H "X-T3-Authorization: Bearer $T3TOK" "$R/api/auth/session" | jq -r .authenticated)"
check "relay: without it, t3 sees no session" false \
  "$(curl -s "${auth[@]}" "$R/api/auth/session" | jq -r .authenticated)"
check "relay: responses are no-store" yes \
  "$(curl -s -D - -o /dev/null "${auth[@]}" "$R/.well-known/t3/environment" | grep -qi '^cache-control: no-store' && echo yes || echo no)"
ticket=$(curl -s "${auth[@]}" -H "X-T3-Authorization: Bearer $T3TOK" -X POST "$R/api/auth/websocket-ticket" | jq -r .ticket)
check "relay: a WebSocket ticket" yes "$([ -n "$ticket" ] && [ "$ticket" != null ] && echo yes || echo no)"

ws_try() {
  NODE_PATH="$repo/backend/node_modules" node -e '
    const WebSocket = require("ws");
    const [url, jwt] = process.argv.slice(1);
    const ws = new WebSocket(url, { headers: jwt ? { authorization: `Bearer ${jwt}` } : {} });
    const done = (s) => { console.log(s); process.exit(0); };
    ws.on("open", () => { ws.close(1000); });
    ws.on("close", (code) => done(`closed ${code}`));
    ws.on("unexpected-response", (_q, res) => done(`http ${res.statusCode}`));
    ws.on("error", (e) => done(`error ${e.message}`));
    setTimeout(() => done("timeout"), 15000);
  ' "$1" "${2:-}"
}
WSR="ws://127.0.0.1:$E2E_PORT/termag/api/cli/v1/boxes/$BOX/t3/relay"
check "relay: the t3 WebSocket opens and closes cleanly" "closed 1000" "$(ws_try "$WSR/ws?wsTicket=$ticket&orchestrationProtocol=2" "$JWT")"
check "relay: a bad ticket is the box's refusal" "http 401" "$(ws_try "$WSR/ws?wsTicket=nope&orchestrationProtocol=2" "$JWT")"
check "relay: no termag credential, no upgrade" "http 401" "$(ws_try "$WSR/ws?wsTicket=$ticket&orchestrationProtocol=2")"

# ── a Claude turn on the box, through the relay ─────────────────────────────
check "t3's Claude is pinned to the box's claude" "$ROOT/boxes/box-1/bin/claude" \
  "$(jq -r .providerInstances.claudeAgent.config.binaryPath "$ROOT/boxes/box-1/home/.t3/userdata/settings.json")"
answer=$(NODE_PATH="$repo/backend/node_modules" node "$here/t3-turn.mjs" "$R" "$JWT" "$T3TOK" "$ROOT/boxes/box-1/home/termag/projects/sample" "hello from e2e" 2>"$WORK/turn.err")
check "a thread's first turn is answered by Claude on the box" "Stub Claude here (turn 1, bypassPermissions). You said: hello from e2e" "$answer"
[ -s "$WORK/turn.err" ] && cat "$WORK/turn.err"

# ── what termag records for a desktop turn ────────────────────────────────
# The stand-in runs the box's Claude hooks (deploy/claude-settings.json) as
# Claude Code under the SDK does; termag-status, inside the t3 server, files
# each post under the project whose checkout the thread runs in.
# Hooks post in
# the background, so every read polls.
BOXTOK=$(jq -r .token "$ROOT/boxes/box-1/home/.termag/agent.config.json")
HOME1="$ROOT/boxes/box-1/home"
SAMPLE_DIR="$HOME1/termag/projects/sample"
SAMPLE=$("$T1" list-sessions -F '#{session_name}' | grep -- '-sample-agent$' | head -n1)
PSQL=(psql -tA "postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag")
status_of() { curl -s -H "Authorization: Bearer $BOXTOK" "$API/api/status/$1" | jq -r "$2"; }
until_status() {  # until_status <session> <jq> <want> [tries]: poll every 0.25 s, print the last reading
  local got=""
  for _ in $(seq 1 "${4:-40}"); do got=$(status_of "$1" "$2"); [ "$got" = "$3" ] && break; sleep 0.25; done
  printf '%s' "$got"
}
turn() {  # turn <dir> <prompt>: one thread turn, the answer on stdout
  NODE_PATH="$repo/backend/node_modules" node "$here/t3-turn.mjs" "$R" "$JWT" "$T3TOK" "$1" "$2" 2>>"$WORK/turn.err"
}

check "the server runs with TERMAG_T3 (the hooks' cue)" yes \
  "$("$T1" list-panes -t =termag-t3 -F '#{pane_start_command}' | grep -q 'TERMAG_T3=1' && echo yes || echo no)"
check "the first turn is filed under the project's agent session: idle now, from t3:claude, with the thread's id" "idle t3:claude true" \
  "$(until_status "$SAMPLE" '"\(.status) \(.source) \(.threadId != null)"' "idle t3:claude true")"

turn "$SAMPLE_DIR" "long turn from e2e" >/dev/null &
long=$!
check "while a turn runs, the project is working" "working t3:claude" \
  "$(until_status "$SAMPLE" '"\(.status) \(.source)"' "working t3:claude")"
wait "$long"
check "...and idle once it has stopped" idle "$(until_status "$SAMPLE" .status idle)"
check "its working time is booked to the project, as Claude, on the box" yes \
  "$("${PSQL[@]}" -c "select coalesce(sum(\"totalMs\"), 0) > 1000 from work_time_entries where project = 'sample' and provider = 'claude' and \"instanceId\" = '$BOX'" | sed 's/^t$/yes/')"
check "a desktop turn moves the box's idle clock" yes \
  "$("${PSQL[@]}" -c "select \"lastActivityAt\" is not null from instances where id = '$BOX'" | sed 's/^t$/yes/')"

# Two threads in one checkout: the first one's Stop must not show the project
# idle while the second still works (services/sessionTurns.ts). The stand-in
# writes a turn's answer to its transcript as it finishes streaming, right
# before its Stop hook: the project may read idle only once the second
# thread's answer is there.
B_PROMPT="long b, a longer prompt, so that this thread goes on well after the first one has stopped"
b_answered() {
  local f
  for f in "$HOME1"/.claude/projects/*/*.jsonl; do
    grep -qF "$B_PROMPT" "$f" 2>/dev/null && grep -q '"type":"assistant"' "$f" && { echo yes; return; }
  done
  echo no
}
turn "$SAMPLE_DIR" "long a" >/dev/null &
sleep 1
turn "$SAMPLE_DIR" "$B_PROMPT" >/dev/null &
saw_working=no idle_early=unknown
for _ in $(seq 1 120); do
  st=$(status_of "$SAMPLE" .status)
  [ "$st" = working ] && saw_working=yes
  if [ "$saw_working" = yes ] && [ "$st" = idle ]; then
    if [ "$(b_answered)" = yes ]; then idle_early=no; else idle_early=yes; fi
    break
  fi
  sleep 0.25
done
wait
check "two threads at once: the project stays working until the last one stops" "working=yes idle-early=no" "working=$saw_working idle-early=$idle_early"

# A workstream's worktree is that workstream's session, never main's.
JSON=(-H 'Content-Type: application/json')
PROJECT_ID=$(jq -r '.projects[] | select(.name == "sample") | .id' "$WORK/projects.json")
curl -s -o /dev/null -c "$JAR" -b "$JAR" -H "Origin: http://127.0.0.1:$E2E_PORT" "${JSON[@]}" -d '{"name":"desk"}' "$API/api/projects/$PROJECT_ID/workstreams"
DESK=${SAMPLE%-agent}-desk-agent
for _ in $(seq 1 40); do "$T1" has-session -t "=$DESK" 2>/dev/null && break; sleep 0.25; done
# Its pane's own claude posts idle as it starts; let that land first.
until_status "$DESK" .status idle 12 >/dev/null
check "a turn in a workstream's worktree is filed under that workstream" "idle t3:claude" \
  "$(turn "$SAMPLE_DIR/.worktrees/desk" "hello workstream" >/dev/null; until_status "$DESK" '"\(.status) \(.source)"' "idle t3:claude")"

# A folder no project owns: box activity under the t3 server's own session,
# no project's status and no working time.
mkdir -p "$HOME1/scratch"
before=$(status_of "$SAMPLE" .updatedAt)
check "a turn outside every project's checkout is the box's own (termag-t3)" "idle t3:claude" \
  "$(turn "$HOME1/scratch" "hello scratch" >/dev/null; until_status termag-t3 '"\(.status) \(.source)"' "idle t3:claude")"
check "...and leaves the project's status alone" "$before" "$(status_of "$SAMPLE" .updatedAt)"
check "...and books no working time to any project" 0 \
  "$("${PSQL[@]}" -c "select count(*) from work_time_entries where project not in ('sample', 'sample-desk')")"

# ── t3's New worktree on a termag project: a termag workstream ──────────────
# The desktop makes it through POST /api/cli/v1/projects/:id/workstreams with
# t3's temporary branch name (t3/<hex> as t3-<hex>) and agent claude-chat, then
# runs the thread there as t3 runs one in an existing worktree.
WS=t3-0a1b2c3d
WS_DIR="$SAMPLE_DIR/.worktrees/$WS"
WS_SESSION=${SAMPLE%-agent}-$WS-agent
BASE=$(git -C "$SAMPLE_DIR" branch --show-current)
ws_post() {  # ws_post <json body>: the status line, then the body
  curl -s -X POST "${auth[@]}" "${JSON[@]}" -d "$1" -w '\n%{http_code}' "$CLI/projects/$PROJECT_ID/workstreams"
}
ws_post "{\"name\":\"$WS\",\"base\":\"$BASE\",\"agent\":\"claude-chat\"}" >"$WORK/ws.out"
check "workstreams: created (201)" 201 "$(tail -n1 "$WORK/ws.out")"
sed '$d' "$WORK/ws.out" >"$WORK/ws.json"
check "workstreams: answers its name, branch, and directory as the box sees it" "$WS $WS $WS_DIR true" \
  "$(jq -r '.workstream | "\(.name) \(.branch) \(.directory) \(.exists)"' "$WORK/ws.json")"
check "workstreams: the worktree is on the box, on the branch of its name" "$WS" "$(git -C "$WS_DIR" branch --show-current 2>&1)"
check "workstreams: its agent workflow is claude-chat" claude-chat \
  "$("${PSQL[@]}" -c "select f.provider from workflows f join workstreams s on s.id = f.\"workstreamId\" where s.name = '$WS' and f.type = 'agent'")"
check "workstreams: its tmux pair is in the worktree" "$(cd "$WS_DIR" && pwd -P)" \
  "$(for _ in $(seq 1 40); do "$T1" has-session -t "=$WS_SESSION" 2>/dev/null && break; sleep 0.25; done; "$T1" display-message -p -t "=$WS_SESSION:" '#{pane_current_path}' 2>&1)"
pane_cmd=$("$T1" display-message -p -t "=$WS_SESSION:" '#{pane_current_command}' 2>&1)
check "workstreams: nothing interactive runs in its agent pane (claude-chat)" yes \
  "$(case "$pane_cmd" in bash|zsh|sh|dash|fish) echo yes ;; *) echo "no ($pane_cmd)" ;; esac)"
check "workstreams: t3/projects lists it under the project" yes \
  "$(curl -s "${auth[@]}" "$CLI/boxes/$BOX/t3/projects" | jq -r --arg ws "$WS" '.projects[] | select(.name == "sample") | .workstreams | index($ws) != null' | sed 's/^true$/yes/')"
answer=$(NODE_PATH="$repo/backend/node_modules" node "$here/t3-turn.mjs" "$R" "$JWT" "$T3TOK" "$SAMPLE_DIR" "hello new worktree" "$WS_DIR" "$WS" 2>>"$WORK/turn.err")
check "workstreams: a t3 thread in it, as t3 runs one in an existing worktree, is answered" \
  "Stub Claude here (turn 1, bypassPermissions). You said: hello new worktree" "$answer"
check "workstreams: ...and filed under the workstream's session" "idle t3:claude" \
  "$(until_status "$WS_SESSION" '"\(.status) \(.source)"' "idle t3:claude")"
echo "      (the worktree's branch after the turn: $(git -C "$WS_DIR" branch --show-current); t3 renames a temporary one when its text generation answers)"

check "workstreams: a taken name is a conflict" "409 conflict" \
  "$(ws_post "{\"name\":\"$WS\"}" | { read -r body; read -r status; echo "$status $(jq -r .code <<<"$body")"; })"
for bad in '{"name":"no.dots"}' '{"name":"main"}' '{"name":"x","agent":"codex"}' '{"name":""}'; do
  check "workstreams: refuses $bad" "400 invalid_request" \
    "$(ws_post "$bad" | { read -r body; read -r status; echo "$status $(jq -r .code <<<"$body")"; })"
done
check "workstreams: another project is not found" 404 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${auth[@]}" "${JSON[@]}" -d '{"name":"x"}' "$CLI/projects/not-a-project/workstreams")"

ws_branch=$(git -C "$WS_DIR" branch --show-current)
check "workstreams: removed, keeping its branch as t3 does" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "${auth[@]}" "${JSON[@]}" -d '{"force":true,"keepBranch":true}' "$CLI/projects/$PROJECT_ID/workstreams/$WS")"
check "workstreams: ...its worktree, sessions and row are gone, its branch is not" "no no 0 yes" \
  "$([ -d "$WS_DIR" ] && echo yes || echo no) $("$T1" has-session -t "=$WS_SESSION" 2>/dev/null && echo yes || echo no) $("${PSQL[@]}" -c "select count(*) from workstreams where name = '$WS'") $(git -C "$SAMPLE_DIR" rev-parse --verify -q "refs/heads/$ws_branch" >/dev/null && echo yes || echo no)"
check "workstreams: removing it again is not found" 404 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "${auth[@]}" "$CLI/projects/$PROJECT_ID/workstreams/$WS")"

# ── refusals ──────────────────────────────────────────────────────────────
check "a box's own token is refused" 403 "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $BOXTOK" "$R/.well-known/t3/environment")"
check "no credential is refused" 401 "$(curl -s -o /dev/null -w '%{http_code}' "$R/.well-known/t3/environment")"
check "another box id is not found" 404 "$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$CLI/boxes/not-a-box/t3/relay/.well-known/t3/environment")"
check "a tunnel id nobody asked for is refused" "http 404" \
  "$(ws_try "ws://127.0.0.1:$E2E_PORT/termag/ws/agent-tunnel?id=$(printf 'a%.0s' $(seq 1 64))" "$BOXTOK")"

# ── the server restarted behind the relay's back ──────────────────────────
"$T1" kill-session -t =termag-t3 2>/dev/null
for _ in $(seq 1 20); do curl -s -o /dev/null "http://127.0.0.1:$t3port/" || break; sleep 0.25; done
check "relay: a stopped server is started again on the next request" "$version" \
  "$(curl -s -m 60 "${auth[@]}" "$R/.well-known/t3/environment" | jq -r .serverVersion)"
check "relay: the t3 session survives the restart" true \
  "$(curl -s "${auth[@]}" -H "X-T3-Authorization: Bearer $T3TOK" "$R/api/auth/session" | jq -r .authenticated)"

# ── one t3 session per pairing label ──────────────────────────────────────
# The desktop pairs each box with one label per device (`termag-desktop
# <device> <box>`): a pair of that label revokes the session an earlier one
# was redeemed for and any credential nobody redeemed, and t3/revoke (Forget,
# sign-out) revokes both. Sessions of other labels are left alone.
T3_BIN=$(sed -n 's/^T3_COMMAND=//p' "$ROOT/stack.env")
LBL="termag-desktop e2e0 $BOX"
sessions_of() {  # the box's active t3 sessions carrying label $1
  "$T3_BIN" auth session list --json --base-dir "$HOME1/.t3" 2>/dev/null | jq --arg l "$1" '[.[] | select(.client.label == $l)] | length'
}
pairings_of() {  # the box's unredeemed t3 pairing credentials carrying label $1
  "$T3_BIN" auth pairing list --json --base-dir "$HOME1/.t3" 2>/dev/null | jq --arg l "$1" '[.[] | select(.label == $l)] | length'
}
pair_label() { curl -s -X POST "${auth[@]}" "${JSON[@]}" -d "{\"label\":\"$1\"}" "$CLI/boxes/$BOX/t3/pair" | jq -r .credential; }
redeem() {  # a pairing credential exchanged through the relay; the t3 token on stdout
  curl -s "${auth[@]}" -X POST "$R/oauth/token" \
    -H 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
    --data-urlencode "subject_token=$1" \
    --data-urlencode 'subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap' \
    --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' | jq -r .access_token
}
session_ok() { curl -s "${auth[@]}" -H "X-T3-Authorization: Bearer $1" "$R/api/auth/session" | jq -r '.authenticated // false'; }
TOK1=$(redeem "$(pair_label "$LBL")")
check "a labeled pair's session carries the label" 1 "$(sessions_of "$LBL")"
TOK2=$(redeem "$(pair_label "$LBL")")
check "a second pair with the same label leaves one session" 1 "$(sessions_of "$LBL")"
check "...the newer one: the first no longer authenticates" "false true" "$(session_ok "$TOK1") $(session_ok "$TOK2")"
pair_label "$LBL" >/dev/null
pair_label "$LBL" >/dev/null
check "a pair revokes an unredeemed credential of its label too" "1 0" "$(pairings_of "$LBL") $(sessions_of "$LBL")"
curl -s -X POST "${auth[@]}" "${JSON[@]}" -d "{\"label\":\"$LBL\"}" "$CLI/boxes/$BOX/t3/revoke" >"$WORK/revoke.json"
check "revoke: the label's unredeemed credential (its session went with the last pair)" "0 1" \
  "$(jq -r '"\(.revoked.sessions) \(.revoked.pairings)"' "$WORK/revoke.json")"
TOK3=$(redeem "$(pair_label "$LBL")")
curl -s -X POST "${auth[@]}" "${JSON[@]}" -d "{\"label\":\"$LBL\"}" "$CLI/boxes/$BOX/t3/revoke" >"$WORK/revoke.json"
check "revoke: the label's session" "1 0 false" "$(jq -r '"\(.revoked.sessions) \(.revoked.pairings)"' "$WORK/revoke.json") $(session_ok "$TOK3")"
check "...and leaves other labels' sessions alone" true "$(session_ok "$T3TOK")"
check "revoke: a label is required" 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${auth[@]}" "${JSON[@]}" -d '{}' "$CLI/boxes/$BOX/t3/revoke")"
check "revoke: a box's own token is refused" 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $BOXTOK" "${JSON[@]}" -d "{\"label\":\"$LBL\"}" "$CLI/boxes/$BOX/t3/revoke")"

if [ "$failures" -gt 0 ]; then
  echo "t3.test.sh: $failures failure(s); logs under $ROOT/logs, box t3 log $ROOT/boxes/box-1/home/.termag/t3.log"
  tail -n 30 "$ROOT/logs/backend.log" "$ROOT/logs/box-1.log" "$ROOT/boxes/box-1/home/.termag/t3.log" 2>/dev/null
  exit 1
fi
echo "t3.test.sh: all checks passed"
