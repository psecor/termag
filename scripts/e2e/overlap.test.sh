#!/usr/bin/env bash
# Overlapping orchestrator deploys end to end on their own stack
# (E2E_OVERLAP): a second backend on the same database
# takes the lease; the first stops serving its health check, refuses new
# sockets and, after the grace, closes its box agents' sockets and then its
# browsers'. The agents redial at once and land on the second, which then
# answers everything; the cookie session works on both. Then the first is
# restarted and takes the boxes back, and when it stops the second takes the
# lease back after the stale window. Along the way: only the holder keeps a
# Slack Socket Mode connection (fakes/slack-stub.mjs), a status written to the
# draining backend reaches the new one when it re-reads session_statuses, and
# the draining one answers the runner spawn hook with 503. The box network
# stands in for the ALB (scripts/e2e/box-network.mjs). Runs on its own ports
# and TMPDIR.
#
# Run: bash scripts/e2e/overlap.test.sh   (or make e2e-test-overlap)
#   E2E_TEST_PORT_SHIFT=N        add N to every port
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
S=${E2E_TEST_PORT_SHIFT:-0}
export E2E_PORT=$((3980 + S)) E2E_GREEN_PORT=$((3983 + S)) E2E_FRONTEND_PORT=$((6006 + S)) E2E_PG_PORT=$((55479 + S)) \
  E2E_BOXES=2 E2E_OVERLAP=1
SLACK_PORT=$((3990 + S))
slack_pid=
trap '[ -z "$slack_pid" ] || kill "$slack_pid" 2>/dev/null; bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

fails=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

# Slack Socket Mode against a stub, to see which backend holds the connection,
# and the runner spawn route, to see a draining backend refuse it.
(cd "$repo/backend" && exec node ../scripts/e2e/fakes/slack-stub.mjs "$SLACK_PORT") >"$WORK/slack-stub.log" 2>&1 &
slack_pid=$!
RUNNER_TOKEN=e2e-runner-spawn-token
cat >"$WORK/overlap.env" <<EOF
SLACK_BOT_TOKEN=xoxb-e2e
SLACK_APP_TOKEN=xapp-e2e
SLACK_SIGNING_SECRET=e2e
SLACK_API_URL=http://127.0.0.1:$SLACK_PORT/api/
CLAUDE_RUNNER_SPAWN_TOKEN=$RUNNER_TOKEN
EOF
export E2E_BACKEND_ENV=$WORK/overlap.env

if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"; echo "FAIL: up.sh with E2E_OVERLAP"; exit 1
fi
pass "up.sh brought the stack up with E2E_OVERLAP=1"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
BLUE="http://127.0.0.1:$E2E_PORT/termag"
GREEN="http://127.0.0.1:$E2E_GREEN_PORT/termag"
PSQL=(psql -tA "postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag")
JAR="$WORK/cookies"

serving() { curl -s -o /dev/null -w '%{http_code}' "$1/health/serving"; }
wait_serving() { # <url> <code> <seconds>
  for _ in $(seq 1 $(($3 * 4))); do [ "$(serving "$1")" = "$2" ] && break; sleep 0.25; done
  serving "$1"
}
connected() { grep -c '\[AGENT\] Connected: ' "$ROOT/logs/$1.log" 2>/dev/null || true; }
wait_connected() { # <log> <count> <seconds>
  for _ in $(seq 1 $(($3 * 4))); do [ "$(connected "$1")" -ge "$2" ] && break; sleep 0.25; done
  connected "$1"
}
holder() { "${PSQL[@]}" -c "select \"holderLabel\" from orchestrator_leases"; }
slack_sockets() { curl -s "http://127.0.0.1:$SLACK_PORT/_e2e/sockets" | jq -r "$1"; }
wait_slack() { # <jq filter> <value> <seconds>
  for _ in $(seq 1 $(($3 * 4))); do [ "$(slack_sockets "$1")" = "$2" ] && break; sleep 0.25; done
  slack_sockets "$1"
}
spawn_code() { # <base>: the runner spawn hook's call, for a session owner termag does not know
  curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $RUNNER_TOKEN" -H 'content-type: application/json' \
    -d '{"orderId":"e2e-order","sessionId":"e2e-session","accountEmail":"nobody@termag.local","workOrder":"a.b.c"}' \
    "$1/internal/claude-runner/spawn"
}
REHYDRATE_SESSION=e2e-overlap-rehydrate
status_of() { curl -s "$1/api/status/$REHYDRATE_SESSION" | jq -r .status; }
capture() { # <base>: the sample project's agent pane, through that backend's agent connection
  curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$1/api/projects/$sample/sessions/agent/capture?lines=5"
}
# Close code of an agent WebSocket to <base>, with box-1's token.
ws_close_code() {
  local token
  token=$(jq -r .token "$ROOT/boxes/box-1/home/.termag/agent.config.json")
  # shellcheck disable=SC2016 # JavaScript, not shell
  (cd "$repo/backend" && node -e '
    const WebSocket = require("ws");
    const ws = new WebSocket(process.argv[1], { headers: { Authorization: `Bearer ${process.argv[2]}` } });
    ws.on("close", code => { console.log(code); process.exit(0); });
    ws.on("error", () => {});
    setTimeout(() => { console.log("open"); process.exit(0); }, 3000);
  ' "${1/http/ws}/ws/agent" "$token")
}

check "blue serves" 200 "$(serving "$BLUE")"
blue_holder=$(holder)
check "blue holds the lease" yes "$([ -n "$blue_holder" ] && echo yes || echo no)"
check "blue opened the only Slack socket" 1 "$(wait_slack .open 1 20)"
check "blue's log says Slack is up" yes "$(grep -q '\[SLACK\] Bot running in Socket Mode' "$ROOT/logs/backend.log" && echo yes || echo no)"
curl -s -o /dev/null -c "$JAR" "$BLUE/auth/login"
sample=$(curl -s -b "$JAR" "$BLUE/api/projects" | jq -r '.[] | select(.name == "sample") | .id' | head -n1)
check "capture through blue" 200 "$(capture "$BLUE")"
blue_boxes=$(wait_connected backend 2 20)
check "both boxes connected to blue" 2 "$blue_boxes"

# A browser's status socket on blue, to see when blue closes it.
cookie=$(awk -F'\t' 'NF >= 7 { printf "%s%s=%s", sep, $6, $7; sep="; " }' "$JAR")
# shellcheck disable=SC2016 # JavaScript, not shell
(cd "$repo/backend" && exec node -e '
  const WebSocket = require("ws");
  const ws = new WebSocket(process.argv[1], { headers: { Cookie: process.argv[2], Origin: process.argv[3] } });
  ws.on("close", code => { console.log(`${code} ${Date.now()}`); process.exit(0); });
  ws.on("error", () => {});
  setTimeout(() => process.exit(1), 120000);
' "${BLUE/http/ws}/ws/status" "$cookie" "http://localhost:$E2E_FRONTEND_PORT") >"$WORK/status-close.txt" 2>&1 &

for _ in $(seq 1 20); do grep -q 'Client connected for' "$ROOT/logs/backend.log" && break; sleep 0.25; done

echo "--- green starts and takes the lease"
bash "$here/ctl.sh" start backend-green >/dev/null
check "green serves" 200 "$(wait_serving "$GREEN" 200 60)"
check "blue stops serving" 503 "$(wait_serving "$BLUE" 503 5)"
check "green holds the lease" yes "$([ "$(holder)" != "$blue_holder" ] && echo yes || echo no)"
# A status a same-host hook writes to blue in the grace, before the boxes move.
curl -s -o /dev/null -X POST -H 'content-type: application/json' \
  -d "{\"session\":\"$REHYDRATE_SESSION\",\"status\":\"working\"}" "$BLUE/api/status"
check "blue took the status write while draining" working "$(status_of "$BLUE")"
check "green does not have it yet" not_running "$(status_of "$GREEN")"
check "blue answers the runner spawn hook with a retryable 503" 503 "$(spawn_code "$BLUE")"
check "green handles it (404: the owner is not a termag user)" 404 "$(spawn_code "$GREEN")"
wait_slack .opened 2 20 >/dev/null
check "Slack moved: one socket open" 1 "$(wait_slack .open 1 10)"
check "Slack moved: blue's closed, green's opened" "2 1" "$(slack_sockets '"\(.opened) \(.closed)"')"
check "blue's log says it stopped Slack" yes "$(grep -q '\[SLACK\] stopped (not the lease holder)' "$ROOT/logs/backend.log" && echo yes || echo no)"
check "green's log says Slack is up" yes "$(grep -q '\[SLACK\] Bot running in Socket Mode' "$ROOT/logs/backend-green.log" && echo yes || echo no)"
check "blue refuses a new agent socket with 4503" 4503 "$(ws_close_code "$BLUE")"
check "blue still answers HTTP while draining (capture through its agent)" 200 "$(capture "$BLUE")"
check "the session cookie works on green" e2e@termag.local "$(curl -s -b "$JAR" "$GREEN/auth/me" | jq -r .email)"

# The agent close is the moment the boxes leave blue; time how long until both are on green.
for _ in $(seq 1 400); do grep -q '\[DRAIN\] closed [0-9]* agent' "$ROOT/logs/backend.log" && break; sleep 0.1; done
closed_at=$(date +%s%3N)
check "blue closed its agents after the grace" yes "$(grep -q '\[DRAIN\] closed 2 agent' "$ROOT/logs/backend.log" && echo yes || echo no)"
for _ in $(seq 1 100); do [ "$(connected backend-green)" -ge 2 ] && break; sleep 0.05; done
moved_ms=$(($(date +%s%3N) - closed_at))
check "both boxes are on green within 2 s of the close (took ${moved_ms} ms)" yes "$([ "$(connected backend-green)" -ge 2 ] && [ "$moved_ms" -lt 2000 ] && echo yes || echo no)"
check "the box agents redialled at once, not after their 5 s interval" yes \
  "$(grep -Eq 'Disconnected \(4503\)\. Reconnecting in 0\.[0-9]s' "$ROOT/logs/box-1.log" && echo yes || echo no)"
for _ in $(seq 1 40); do [ -s "$WORK/status-close.txt" ] && break; sleep 0.25; done
check "blue then closed the browser's status socket with the drain code" 4503 "$(cut -d' ' -f1 "$WORK/status-close.txt")"
check "and only after the agents (browser delay)" yes \
  "$([ "$(($(cut -d' ' -f2 "$WORK/status-close.txt") - closed_at))" -ge 1000 ] && echo yes || echo no)"
check "capture through green" 200 "$(capture "$GREEN")"
check "blue stopped its sweeps" yes "$(grep -q '\[LEASE\] displaced' "$ROOT/logs/backend.log" && echo yes || echo no)"

# Green reads session_statuses again once blue has closed its agents and browsers.
for _ in $(seq 1 60); do grep -q '\[STATUS\] re-read session_statuses' "$ROOT/logs/backend-green.log" && break; sleep 0.25; done
check "green re-read session_statuses after the drain" yes \
  "$(grep -Eq '\[STATUS\] re-read session_statuses after taking the lease: [1-9][0-9]* newer' "$ROOT/logs/backend-green.log" && echo yes || echo no)"
check "green now has the status blue took in the grace" working "$(status_of "$GREEN")"

echo "--- blue goes away: nothing on green drops"
bash "$here/ctl.sh" stop backend >/dev/null
sleep 3
check "Slack stays on green" 1 "$(slack_sockets .open)"
check "green's boxes stay connected" 0 "$(grep -c '\[AGENT\] Disconnected' "$ROOT/logs/backend-green.log" || true)"
check "capture through green after blue is gone" 200 "$(capture "$GREEN")"

echo "--- a new blue takes the lease back from green"
before=$(connected backend)
bash "$here/ctl.sh" start backend >/dev/null
check "the new blue serves" 200 "$(wait_serving "$BLUE" 200 60)"
check "green stops serving" 503 "$(wait_serving "$GREEN" 503 5)"
check "the boxes move back to blue" $((before + 2)) "$(wait_connected backend $((before + 2)) 30)"
wait_slack .opened 3 20 >/dev/null
check "Slack moves back to blue: one socket open" 1 "$(wait_slack .open 1 10)"

echo "--- blue stops without anyone replacing it: green takes the lease back"
bash "$here/ctl.sh" stop backend >/dev/null
check "green serves again after the stale window" 200 "$(wait_serving "$GREEN" 200 20)"
check "the boxes come back to green" 4 "$(wait_connected backend-green 4 30)"
wait_slack .opened 4 20 >/dev/null
check "Slack comes back to green: one socket open" 1 "$(wait_slack .open 1 10)"

[ "$fails" -eq 0 ] || { echo "$fails overlap check(s) failed"; exit 1; }
echo "all overlap e2e checks passed"
