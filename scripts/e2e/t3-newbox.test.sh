#!/usr/bin/env bash
# End-to-end check of the desktop app's "New box…" flow
# against a real local stack with E2E_FAKE_AWS (Floci; in Docker on macOS),
# E2E_EC2_LAUNCH, E2E_T3, E2E_FAKE_CLAUDE, E2E_FAKE_GITHUB and
# E2E_CREDENTIAL_STORE: a device sign-in, the user's GitHub token stored
# through PUT /api/cli/v1/github, a box launched through POST
# /api/cli/v1/boxes until it is running with its agent connected, its t3
# server ensured, a project created on it from e2e-org/sample with the agent
# the desktop passes (claude-chat: nothing idles in the box's agent pane), the
# clone through the box's durable clone unit with its state in /projects and
# t3/projects (waiting, cloning with no directory yet, done), a clone of a
# repository that isn't there reported failed and then retried through
# POST /projects/:id/clone/retry, the pairing exchange and a WebSocket through the relay,
# a Claude turn (the stand-in claude) in the cloned checkout, and then the
# whole stack torn down, its Floci container included. Runs on its own ports
# and TMPDIR, so it can run beside a stack that is already up.
#
# Run: bash scripts/e2e/t3-newbox.test.sh   (or make e2e-test-t3-newbox)
# E2E_T3_COMMAND=<cmd> runs the boxes on another t3 build (a fork's, say).
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-4210} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-6236} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55709} \
  E2E_AWS_PORT=${E2E_TEST_AWS_PORT:-4966} E2E_EC2_PORT=${E2E_TEST_EC2_PORT:-4967} E2E_GITHUB_PORT=${E2E_TEST_GITHUB_PORT:-4980} \
  E2E_BOXES=1 E2E_FAKE_AWS=1 E2E_EC2_LAUNCH=1 E2E_T3=1 E2E_FAKE_CLAUDE=1 E2E_FAKE_GITHUB=1 E2E_CREDENTIAL_STORE=1
trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }
yes_if() { if "$@"; then echo yes; else echo no; fi; }

if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"
  echo "FAIL: up.sh"
  exit 1
fi
pass "up.sh brought the stack up with new boxes, t3, the GitHub stub and the credential store"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
# shellcheck disable=SC1091
FLOCI_MODE=$(. "$ROOT/stack.env" && printf '%s' "${FLOCI_MODE:-}")
CONTAINER=$(cat "$ROOT/floci/container" 2>/dev/null || true)
if [ "$FLOCI_MODE" = docker ]; then
  check "Floci runs in its own container, named for the stack root" "termag-e2e-floci-${ROOT##*.} $ROOT" \
    "$CONTAINER $(docker inspect --format '{{index .Config.Labels "termag.e2e.root"}}' "$CONTAINER" 2>/dev/null)"
  check "the container publishes only 127.0.0.1:$E2E_AWS_PORT" "127.0.0.1:$E2E_AWS_PORT" \
    "$(docker port "$CONTAINER" 4566/tcp 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
  check "the Docker socket is not in the container" none \
    "$(docker inspect --format '{{range .Mounts}}{{.Source}} {{end}}' "$CONTAINER" 2>/dev/null | grep -q 'docker.sock' && echo mounted || echo none)"
  check "its data dir is the stack root's" "$ROOT/floci/data" \
    "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' "$CONTAINER" 2>/dev/null)"
fi

API="http://127.0.0.1:$E2E_PORT/termag"
CLI="$API/api/cli/v1"
U=$(id -un)

# ── a device sign-in, as the desktop app gets one ─────────────────────────
XDG_CONFIG_HOME="$WORK/xdg" bash "$here/cli-login.sh" "$API" >/dev/null 2>"$WORK/login.err"
JWT=$(jq -r --arg h "$API" '.hosts[$h].accessToken' "$WORK/xdg/termag/credentials.json" 2>/dev/null)
check "a device sign-in (PKCE, curl as the browser) gives an access token" yes "$([[ $JWT == eyJ*.*.* ]] && echo yes || echo no)"
auth=(-H "Authorization: Bearer $JWT")

# ── the user's GitHub token, stored the way the desktop would store it ────
# Never contains _bad or _noscope, which the GitHub stub refuses.
GH_TOKEN=gho_e2eDesktopToken0123456789abcdefABCD # gitleaks:allow (a fake token only the GitHub stub knows)
check "PUT /github stores the token (checked with the GitHub stub)" "@e2e-octocat" \
  "$(curl -s -X PUT "${auth[@]}" -H 'Content-Type: application/json' -d "{\"token\":\"$GH_TOKEN\"}" "$CLI/github" | jq -r .label)"
check "GET /credentials says GitHub is connected" "@e2e-octocat" \
  "$(curl -s "${auth[@]}" "$CLI/credentials" | jq -r .github.connected.label)"
PSQL=(psql -X -tA "postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag")
check "it is stored encrypted (Floci's KMS key), never in the clear" "1 0" \
  "$("${PSQL[@]}" -c "select count(*), count(*) filter (where position(convert_to('$GH_TOKEN', 'UTF8') in ciphertext) > 0) from user_credentials where provider = 'github'" | tr '|' ' ')"

# ── launch a box through the CLI API ──────────────────────────────────────
curl -s "${auth[@]}" -H 'Content-Type: application/json' -d '{"name":"deskbox"}' "$CLI/boxes" >"$WORK/launch.json"
check "POST /boxes launches a box" "deskbox provisioning false" "$(jq -r '"\(.box.name) \(.box.state) \(.claimed)"' "$WORK/launch.json")"
BOX=$(jq -r .box.id "$WORK/launch.json")
state=""
for _ in $(seq 1 240); do
  state=$(curl -s "${auth[@]}" "$CLI/boxes" | jq -r --arg id "$BOX" '.boxes[] | select(.id == $id) | "\(.state) \(.agentConnected)"')
  [ "$state" = "running true" ] && break
  sleep 0.5
done
check "the box reaches running with its agent connected" "running true" "$state"
check "it is an EC2 instance in Floci" yes \
  "$(yes_if grep -q '^i-' <<<"$(curl -s "${auth[@]}" "$CLI/boxes" | jq -r --arg id "$BOX" '.boxes[] | select(.id == $id) | .ec2InstanceId')")"
check "the launch fake started a stand-in box from its user data" yes \
  "$(yes_if grep -q 'started box deskbox' "$ROOT/logs/ec2-launch.log")"
BOX_HOME="$ROOT/boxes/deskbox/home"
TB="$ROOT/boxes/deskbox/bin/tmux"

# ── its t3 server ─────────────────────────────────────────────────────────
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "${auth[@]}" "$CLI/boxes/$BOX/t3/ensure")" != 409 ] && break
  sleep 0.5
done
for _ in $(seq 1 120); do
  curl -s -X POST "${auth[@]}" "$CLI/boxes/$BOX/t3/ensure" >"$WORK/ensure.json"
  [ "$(jq -r .state "$WORK/ensure.json")" = ready ] && break
  sleep 1
done
check "t3/ensure: the new box's t3 server comes up (it advertises t3-v1)" "ready $BOX_HOME" \
  "$(jq -r '"\(.state) \(.home)"' "$WORK/ensure.json")"
version=$(jq -r .version "$WORK/ensure.json")
check "the server runs in the box's tmux session termag-t3" yes "$(yes_if "$TB" has-session -t =termag-t3)"

# ── a project from a GitHub repository, as the desktop creates it ─────────
# The stack has no GitHub broker (that is the Claude gateway's, E2E_CLAUDE_GATEWAY),
# so nothing hands a box's git a GitHub credential and the stored token stays on
# the orchestrator: serve e2e-org/sample as public, as ask-box.test.sh does.
touch "$ROOT/github/e2e-org/sample.git/termag-e2e-public"
# The stub holds the pack back for 3 s, so the clone is seen while it runs.
echo 3 >"$ROOT/github/e2e-org/sample.git/termag-e2e-slow"
SAMPLE=https://github.com/e2e-org/sample
start=$(date +%s)
curl -s "${auth[@]}" -H 'Content-Type: application/json' \
  -d "{\"boxId\":\"$BOX\",\"name\":\"app\",\"agent\":\"claude-chat\",\"from\":\"$SAMPLE\"}" "$CLI/projects" >"$WORK/project.json"
took=$(( $(date +%s) - start ))
check "POST /projects from the repository, with agent claude-chat" "deskbox/app claude-chat $SAMPLE" \
  "$(jq -r '"\(.project.ref) \(.project.provider) \(.repoUrl)"' "$WORK/project.json")"
check "the create answers at once (no wait for a GitHub delivery this orchestrator never makes)" yes \
  "$([ "$took" -lt 15 ] && echo yes || echo "no, ${took}s")"
check "it answers with the clone not done yet" yes \
  "$(case $(jq -r .project.clone.state "$WORK/project.json") in waiting|cloning) echo yes ;; *) jq -c .project.clone "$WORK/project.json" ;; esac)"
APP_ID=$(jq -r .project.id "$WORK/project.json")
APP="$BOX_HOME/termag/projects/app"

# The clone's state as /projects and t3/projects give it, every 0.25 s until it
# is done or failed: each change once, and whether t3/projects already saw the
# directory while the clone ran.
clone_json() { curl -s "${auth[@]}" "$CLI/projects" | jq -c --arg id "$1" '.projects[] | select(.id == $id) | .clone'; }
clone_state() { clone_json "$1" | jq -r '.state // "none"'; }
t3_entry() { curl -s "${auth[@]}" "$CLI/boxes/$BOX/t3/projects" | jq -c --arg id "$1" '.projects[] | select(.id == $id)'; }
watch_clone() { # watch_clone ID: sets SEEN ("waiting cloning done"), DIR_WHILE_CLONING
  local st last='' entry
  SEEN='' DIR_WHILE_CLONING=''
  for _ in $(seq 1 240); do
    st=$(clone_state "$1")
    [ "$st" = "$last" ] || { SEEN="${SEEN:+$SEEN }$st"; last=$st; }
    if [ "$st" = cloning ]; then
      entry=$(t3_entry "$1")
      [ "$(jq -r .clone.state <<<"$entry")" = cloning ] && DIR_WHILE_CLONING="${DIR_WHILE_CLONING:-$(jq -r .exists <<<"$entry")}"
    fi
    case $st in done|failed) return ;; esac
    sleep 0.25
  done
}
watch_clone "$APP_ID"
check "the clone goes waiting, cloning, done, as the box's clone unit reports it" yes \
  "$(case "$SEEN" in *cloning\ done) echo yes ;; *) echo "$SEEN" ;; esac)"
echo "      seen: $SEEN"
check "t3/projects says the clone is running, its directory not there yet" "false" "$DIR_WHILE_CLONING"
rm -f "$ROOT/github/e2e-org/sample.git/termag-e2e-slow"
check "the box ran it as termag-project-clone@ (its state file reads ready)" ready \
  "$(jq -r .status "$BOX_HOME/.termag/clones/$APP_ID.json" 2>/dev/null)"
check "the clone lands in the project's directory on the box" "# e2e-org/sample" "$(head -n1 "$APP/README.md" 2>/dev/null)"
check "it is a checkout of the repository's main" "$SAMPLE main" \
  "$(git -C "$APP" remote get-url origin 2>/dev/null) $(git -C "$APP" branch --show-current 2>/dev/null)"
pane=""
for _ in $(seq 1 40); do
  pane=$("$TB" list-panes -a -F '#{session_name} #{pane_current_command}' 2>/dev/null | awk -v s="$U-app-agent" '$1 == s { print $2 }')
  [ "$pane" = bash ] && break
  sleep 0.25
done
check "the agent pane is an idle shell: no agent runs in tmux (claude-chat)" bash "$pane"
check "the box has the project's agent and ctrl sessions" "$U-app-agent $U-app-ctrl" \
  "$("$TB" ls -F '#S' 2>/dev/null | grep -- '-app-' | sort | tr '\n' ' ' | sed 's/ $//')"

curl -s "${auth[@]}" "$CLI/boxes/$BOX/t3/projects" >"$WORK/projects.json"
check "t3/projects: the project, where the box keeps it, exists, its clone done" "app $APP true main done" \
  "$(jq -r '.projects[] | select(.name == "app") | "\(.name) \(.directory) \(.exists) \(.workstreams | join(",")) \(.clone.state)"' "$WORK/projects.json")"
check "a clone that is done is not retryable, and Retry refuses it" "false 409" \
  "$(clone_json "$APP_ID" | jq -r .retryable) $(curl -s -o /dev/null -w '%{http_code}' -X POST "${auth[@]}" "$CLI/projects/$APP_ID/clone/retry")"

# ── a repository that isn't there: failed, then retried ───────────────────
MISSING=https://github.com/e2e-org/no-such-repo
curl -s "${auth[@]}" -H 'Content-Type: application/json' \
  -d "{\"boxId\":\"$BOX\",\"name\":\"gone\",\"agent\":\"claude-chat\",\"from\":\"$MISSING\"}" "$CLI/projects" >"$WORK/gone.json"
GONE_ID=$(jq -r .project.id "$WORK/gone.json")
watch_clone "$GONE_ID"
check "a clone of a repository that isn't there ends failed" failed "${SEEN##* }"
clone_json "$GONE_ID" >"$WORK/gone-clone.json"
echo "      seen: $SEEN; error: $(jq -r .error "$WORK/gone-clone.json")"
check "with the box's error, and Retry offered" "yes true $MISSING" \
  "$([ -n "$(jq -r '.error // empty' "$WORK/gone-clone.json")" ] && echo yes || echo no) $(jq -r '"\(.retryable) \(.repoUrl)"' "$WORK/gone-clone.json")"
check "t3/projects: failed, and no directory on the box" "failed false" "$(t3_entry "$GONE_ID" | jq -r '"\(.clone.state) \(.exists)"')"
check "no sessions were started for it" "" "$("$TB" ls -F '#S' 2>/dev/null | grep -- '-gone-')"
# The repository appears; Retry clones it.
git clone -q --bare "$ROOT/github/e2e-org/sample.git" "$ROOT/github/e2e-org/no-such-repo.git" && touch "$ROOT/github/e2e-org/no-such-repo.git/termag-e2e-public"
curl -s -X POST "${auth[@]}" "$CLI/projects/$GONE_ID/clone/retry" -o "$WORK/retry.json" -w '%{http_code}' >"$WORK/retry.code"
check "POST /projects/:id/clone/retry restarts it" "202 yes" \
  "$(cat "$WORK/retry.code") $(case $(jq -r .project.clone.state "$WORK/retry.json") in waiting|cloning|done) echo yes ;; *) jq -c . "$WORK/retry.json" ;; esac)"
watch_clone "$GONE_ID"
check "the retried clone is done" "done" "${SEEN##* }"
check "and its checkout is in place" "# e2e-org/sample" "$(head -n1 "$BOX_HOME/termag/projects/gone/README.md" 2>/dev/null)"

# ── pair through the relay ────────────────────────────────────────────────
curl -s -X POST "${auth[@]}" -H 'Content-Type: application/json' -d '{"label":"e2e new box"}' "$CLI/boxes/$BOX/t3/pair" >"$WORK/pair.json"
cred=$(jq -r .credential "$WORK/pair.json")
check "t3/pair: a one-time credential" yes "$([ -n "$cred" ] && [ "$cred" != null ] && echo yes || echo no)"
R="$CLI/boxes/$BOX/t3/relay"
curl -s "${auth[@]}" -X POST "$R/oauth/token" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=urn:ietf:params:oauth:grant-type:token-exchange' \
  --data-urlencode "subject_token=$cred" \
  --data-urlencode 'subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap' \
  --data-urlencode 'requested_token_type=urn:ietf:params:oauth:token-type:access_token' \
  --data-urlencode 'client_label=e2e new box' >"$WORK/t3token.json"
T3TOK=$(jq -r .access_token "$WORK/t3token.json")
check "relay: the pairing credential is exchanged for a t3 session" yes "$([ -n "$T3TOK" ] && [ "$T3TOK" != null ] && echo yes || echo no)"
check "relay: the descriptor is the box's server" "$version" "$(curl -s "${auth[@]}" "$R/.well-known/t3/environment" | jq -r .serverVersion)"
check "relay: the t3 session authenticates" true \
  "$(curl -s "${auth[@]}" -H "X-T3-Authorization: Bearer $T3TOK" "$R/api/auth/session" | jq -r .authenticated)"
ticket=$(curl -s "${auth[@]}" -H "X-T3-Authorization: Bearer $T3TOK" -X POST "$R/api/auth/websocket-ticket" | jq -r .ticket)
ws=$(NODE_PATH="$repo/backend/node_modules" node -e '
  const WebSocket = require("ws");
  const [url, jwt] = process.argv.slice(1);
  const ws = new WebSocket(url, { headers: { authorization: `Bearer ${jwt}` } });
  const done = (s) => { console.log(s); process.exit(0); };
  ws.on("open", () => { ws.close(1000); });
  ws.on("close", (code) => done(`closed ${code}`));
  ws.on("unexpected-response", (_q, res) => done(`http ${res.statusCode}`));
  ws.on("error", (e) => done(`error ${e.message}`));
  setTimeout(() => done("timeout"), 15000);
' "ws://127.0.0.1:$E2E_PORT/termag/api/cli/v1/boxes/$BOX/t3/relay/ws?wsTicket=$ticket&orchestrationProtocol=2" "$JWT")
check "relay: the t3 WebSocket opens and closes cleanly" "closed 1000" "$ws"

answer=$(NODE_PATH="$repo/backend/node_modules" node "$here/t3-turn.mjs" "$R" "$JWT" "$T3TOK" "$APP" "hello from the new box" 2>"$WORK/turn.err")
check "a t3 thread in the cloned checkout is answered by Claude on the new box" \
  "Stub Claude here (turn 1, bypassPermissions). You said: hello from the new box" "$answer"
[ -s "$WORK/turn.err" ] && cat "$WORK/turn.err"

if [ "$failures" -gt 0 ]; then
  echo "--- last lines of the backend, launch fake and box logs"
  tail -n 30 "$ROOT/logs/backend.log" "$ROOT/logs/ec2-launch.log" "$ROOT/logs/deskbox.log" "$BOX_HOME/.termag/t3.log" 2>/dev/null
fi

# ── teardown, its Floci container included ────────────────────────────────
bash "$here/down.sh" >"$WORK/down.log" 2>&1
check "down.sh tears the stack down" 0 $?
check "the stack root is gone" no "$(yes_if test -e "$ROOT")"
check "no process mentions the stack root" "" "$(ps -wwA -o pid=,command= | grep -F "$ROOT/" | grep -v grep)"
if [ "$FLOCI_MODE" = docker ]; then
  check "its Floci container is gone" gone "$(docker inspect --type container "$CONTAINER" >/dev/null 2>&1 && echo still-there || echo gone)"
fi

if [ "$failures" -gt 0 ]; then
  echo "t3-newbox.test.sh: $failures failure(s)"
  exit 1
fi
echo "t3-newbox.test.sh: all checks passed"
