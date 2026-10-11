#!/usr/bin/env bash
# End-to-end check of the local stack: up.sh from nothing, then through the real
# HTTP and WebSocket surfaces: local sign-in, two ready boxes, the seeded
# project, a terminal round trip, a status write from a box pane, a same-name
# project on the second box, and finally down.sh leaving no process or file
# behind. Runs on its own ports and TMPDIR, so it can run beside a stack that is
# already up.
#
# Run: bash scripts/e2e/e2e.test.sh   (or make e2e-test)
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-3940} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-5974} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55439} E2E_BOXES=2
trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

touch "$WORK/.started"
sleep 1

if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"
  echo "FAIL: up.sh"
  exit 1
fi
pass "up.sh brought the stack up"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
USER_NAME=$(id -un)
API="http://127.0.0.1:$E2E_PORT/termag"
UI="http://localhost:$E2E_FRONTEND_PORT/termag"
JAR="$WORK/cookies"

# Sign in through the frontend's proxy, the way the browser does.
code=$(curl -s -o /dev/null -w '%{http_code}' -c "$JAR" "$UI/auth/login")
check "GET /auth/login redirects" 302 "$code"
check "auth mode" local "$(curl -s "$UI/auth/config" | jq -r .mode)"
check "signed-in user" e2e@termag.local "$(curl -s -b "$JAR" "$UI/auth/me" | jq -r .email)"

boxes=$(curl -s -b "$JAR" "$UI/api/instances")
check "two ready boxes" "box-1 ready,box-2 ready" \
  "$(echo "$boxes" | jq -r 'sort_by(.name) | map("\(.name) \(.status)") | join(",")')"
check "box-1 reports its temp home" "$ROOT/boxes/box-1/home" \
  "$(echo "$boxes" | jq -r '.[] | select(.name=="box-1") | .hostHome')"
check "box agents send their token in a header, and no log holds it" "0|" \
  "$(grep -c '\[AGENT-WS\].*query string' "$ROOT/logs/backend.log")|$(for b in 1 2; do
      grep -l -F -- "$(jq -r .token "$ROOT/boxes/box-$b/home/.termag/agent.config.json")" "$ROOT"/logs/*.log; done)"
box1=$(echo "$boxes" | jq -r '.[] | select(.name=="box-1") | .id')
box2=$(echo "$boxes" | jq -r '.[] | select(.name=="box-2") | .id')

projects=$(curl -s -b "$JAR" "$UI/api/projects")
sample=$(echo "$projects" | jq -r --arg b "$box1" '.[] | select(.name=="sample" and .instanceId==$b) | .id')
if [ -n "$sample" ]; then pass "seeded project sample is on box-1"; else fail "seeded project" "sample on box-1" "$projects"; fi
check "sample's directory is in box-1's home" yes \
  "$([ -f "$ROOT/boxes/box-1/home/termag/projects/sample/AGENTS.md" ] && echo yes || echo no)"

# Terminal: attach to the ctrl pane over the same WebSocket the UI uses, type,
# and read the echo back. The pane's shell, not this one, expands $((6*7)).
nonce="e2e-$RANDOM$RANDOM"
# shellcheck disable=SC2016
out=$(cd "$repo/backend" && E2E_WS="ws://localhost:$E2E_FRONTEND_PORT/termag/ws/terminal?session=$USER_NAME-sample-ctrl&projectId=$sample" \
  E2E_COOKIE="$(awk '$6=="termag.sid"{print "termag.sid="$7}' "$JAR")" E2E_NONCE="$nonce" node -e '
    const WebSocket = require("ws");
    const ws = new WebSocket(process.env.E2E_WS, { headers: { cookie: process.env.E2E_COOKIE } });
    let buf = "";
    const done = (r) => { console.log(r); process.exit(0); };
    setTimeout(() => done("timeout: " + JSON.stringify(buf.slice(-300))), 15000);
    ws.on("open", () => setTimeout(() => ws.send(JSON.stringify({ type: "input", data: "echo " + process.env.E2E_NONCE + "-$((6*7))\r" })), 1000));
    ws.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.type === "output") buf += msg.data;
      if (buf.includes(process.env.E2E_NONCE + "-42")) done("echoed");
    });
    ws.on("close", (c, r) => done("closed " + c + " " + r));
  ')
check "terminal round trip through box-1" echoed "$out"

# Status: a box pane reports through deploy/termag-status with the box token,
# which is what the Claude Code hooks run. The box reaches the stack from
# another address (box-network.mjs), so the backend files it under box-1, where
# box-1's status pill reads it, and not under the orchestrator.
T1="$ROOT/boxes/box-1/bin/tmux"
"$T1" send-keys -t "$USER_NAME-sample-agent" 'termag-status working' Enter
st=
for _ in $(seq 1 20); do
  st=$(e2e_box_status "$ROOT" box-1 "$API" "$USER_NAME-sample-agent")
  [ "$st" = working ] && break
  sleep 0.25
done
check "status write from box-1's agent pane is filed under box-1" working "$st"
check "and not under the orchestrator" no \
  "$([ "$(curl -s "$API/api/status/$USER_NAME-sample-agent" | jq -r .status)" = working ] && echo yes || echo no)"
check "both box agents reach the backend from 127.0.0.2" yes \
  "$([ "$(ss -Htn state established src 127.0.0.2 dport = :"$E2E_PORT" | wc -l)" -ge 2 ] && echo yes || echo no)"

# Persisted status: a waiting pill survives a backend restart. The status is
# written through to session_statuses and hydrated before the backend listens,
# so both the box's read and the UI's /ws/status replay still say waiting.
"$T1" send-keys -t "$USER_NAME-sample-agent" \
  "echo '{\"notification_type\":\"permission_prompt\",\"message\":\"e2e needs approval\"}' | termag-status notification" Enter
for _ in $(seq 1 20); do
  st=$(e2e_box_status "$ROOT" box-1 "$API" "$USER_NAME-sample-agent")
  [ "$st" = waiting ] && break
  sleep 0.25
done
check "notification from box-1's pane sets waiting" waiting "$st"
bash "$here/ctl.sh" restart backend >/dev/null 2>&1
for _ in $(seq 1 120); do curl -sf -o /dev/null "$API/health" && break; sleep 0.25; done
check "still waiting after a backend restart" waiting "$(e2e_box_status "$ROOT" box-1 "$API" "$USER_NAME-sample-agent")"
# shellcheck disable=SC2016
pill=$(cd "$repo/backend" && E2E_WS="ws://localhost:$E2E_FRONTEND_PORT/termag/ws/status" \
  E2E_COOKIE="$(awk '$6=="termag.sid"{print "termag.sid="$7}' "$JAR")" E2E_SESSION="$USER_NAME-sample-agent" E2E_BOX="$box1" node -e '
    const WebSocket = require("ws");
    const ws = new WebSocket(process.env.E2E_WS, { headers: { cookie: process.env.E2E_COOKIE } });
    const done = (r) => { console.log(r); process.exit(0); };
    setTimeout(() => done("no status replayed"), 10000);
    ws.on("message", (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.type === "status" && msg.session === process.env.E2E_SESSION && msg.instanceId === process.env.E2E_BOX) done(msg.status);
    });
    ws.on("close", (c, r) => done("closed " + c + " " + r));
  ')
check "the UI's status replay after the restart shows the pill waiting" waiting "$pill"
# The box agents redial on their own (every 5 s); the checks below need both.
for _ in $(seq 1 60); do
  [ "$(ss -Htn state established src 127.0.0.2 dport = :"$E2E_PORT" | wc -l)" -ge 2 ] && break
  sleep 0.25
done

# Cross-box: the same project name on box-2 gets its own sessions on box-2.
created=$(curl -s -b "$JAR" -H 'content-type: application/json' -X POST "$UI/api/projects" \
  -d "{\"name\":\"sample\",\"instanceId\":\"$box2\",\"initialAgent\":{\"enabled\":true,\"provider\":\"claude\"}}")
check "same-name project on box-2" "$box2" "$(echo "$created" | jq -r '.instanceId // .project.instanceId')"
sessions2=
for _ in $(seq 1 20); do
  sessions2=$("$ROOT/boxes/box-2/bin/tmux" ls -F '#S' 2>/dev/null | sort | tr '\n' ' ')
  [ -n "$sessions2" ] && break
  sleep 0.25
done
check "box-2 runs its own tmux sessions" "$USER_NAME-sample-agent $USER_NAME-sample-ctrl " "$sessions2"
check "box-1 still runs its own" "$USER_NAME-sample-agent $USER_NAME-sample-ctrl " \
  "$("$T1" ls -F '#S' | sort | tr '\n' ' ')"

# Teardown.
bash "$here/down.sh" >"$WORK/down.log" 2>&1
check "down.sh exit" 0 "$?"
check "stack root removed" gone "$([ -e "$ROOT" ] && echo present || echo gone)"
check "pointer removed" gone "$([ -e "$E2E_POINTER" ] && echo present || echo gone)"
check "no stack processes left" "" "$(e2e_pids "$ROOT" | tr '\n' ' ')"
for p in "$E2E_PORT" $((E2E_PORT + 1)) "$E2E_FRONTEND_PORT" "$E2E_PG_PORT"; do
  check "port $p released" closed "$( (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && echo open || echo closed)"
done
leaked=$(e2e_leaks "$WORK/.started" "$WORK")
check "no files written outside the temp root" "" "$leaked"

echo
if [ "$failures" -eq 0 ]; then echo "all e2e checks passed"; else echo "$failures e2e check(s) failed"; fi
[ "$failures" -eq 0 ]
