#!/usr/bin/env bash
# End-to-end check of the termag CLI (cli/) against a real local stack: browser
# sign-in through /auth/cli/authorize (a curl "browser" stands in for xdg-open),
# whoami, box and project lists, `termag tui` and the TUI's /api/cli/v1 routes,
# the box's own credential, box and project lifecycle through the EC2 launch
# fake, the approval page's CSRF guard, revoking from the web UI, and logout.
# Runs on its own ports and
# TMPDIR, so it can run beside a stack that is already up.
#
# Run: bash scripts/e2e/cli.test.sh   (or make e2e-test)
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-3950} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-5984} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55449} E2E_BOXES=2 \
  E2E_AWS_PORT=${E2E_TEST_AWS_PORT:-4666} E2E_EC2_PORT=${E2E_TEST_EC2_PORT:-4667} E2E_FAKE_AWS=1 E2E_EC2_LAUNCH=1
trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

if [ ! -x "$repo/cli/node_modules/.bin/tsc" ]; then
  (cd "$repo/cli" && npm ci --no-audit --no-fund >"$WORK/cli-install.log" 2>&1) || { cat "$WORK/cli-install.log"; echo "FAIL: cli npm ci"; exit 1; }
fi
(cd "$repo/cli" && npm run build >"$WORK/cli-build.log" 2>&1) || { cat "$WORK/cli-build.log"; echo "FAIL: cli build"; exit 1; }
pass "cli builds"
if [ ! -x "$repo/tui/node_modules/.bin/tsc" ]; then
  (cd "$repo/tui" && npm ci --no-audit --no-fund >"$WORK/tui-install.log" 2>&1) || { cat "$WORK/tui-install.log"; echo "FAIL: tui npm ci"; exit 1; }
fi
(cd "$repo/tui" && npm run build >"$WORK/tui-build.log" 2>&1) || { cat "$WORK/tui-build.log"; echo "FAIL: tui build"; exit 1; }
pass "tui builds"

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
JAR="$WORK/browser-cookies"
LAPTOP="$WORK/laptop"
mkdir -p "$LAPTOP" "$WORK/bin"

# The "browser" `termag login` opens: sign in, load the approval page, click
# Authorize (a same-origin form post), follow the redirect to the CLI.
cat >"$WORK/bin/xdg-open" <<EOF
#!/usr/bin/env bash
url=\$1
curl -s -o /dev/null -c "$JAR" -b "$JAR" "$API/auth/login"
curl -s -c "$JAR" -b "$JAR" -D "$WORK/approval.headers" -o "$WORK/approval.html" "\$url"
curl -s -o /dev/null -c "$JAR" -b "$JAR" -D "$WORK/approve.headers" \\
  -H "Origin: http://127.0.0.1:$E2E_PORT" --data "\${url#*\\?}&decision=approve" "$API/auth/cli/authorize"
loc=\$(grep -i '^location:' "$WORK/approve.headers" | tr -d '\r' | cut -d' ' -f2)
curl -s -o "$WORK/callback.html" "\$loc"
EOF
chmod +x "$WORK/bin/xdg-open"

termag() { HOME="$LAPTOP" PATH="$WORK/bin:$PATH" node "$repo/cli/bin/termag.js" "$@"; }
# `login` needs a terminal; script(1) gives it one.
termag_tty() {
  HOME="$LAPTOP" PATH="$WORK/bin:$PATH" script -qec "node '$repo/cli/bin/termag.js' $*" /dev/null
}

termag login --host "$API" >"$WORK/login-notty.out" 2>&1
check "login without a terminal exits 4" 4 $?
check "login without a terminal opened no browser" no "$([ -f "$WORK/approval.html" ] && echo yes || echo no)"

termag_tty login --host "$API" --device e2e-laptop >"$WORK/login.out" 2>&1
check "login exits 0" 0 $?
check "approval page names the account" yes "$(grep -q 'e2e@termag.local' "$WORK/approval.html" && echo yes || echo no)"
check "approval page forbids framing" yes "$(grep -qi "frame-ancestors 'none'" "$WORK/approval.headers" && echo yes || echo no)"
check "the CLI's loopback confirmed the sign-in" yes "$(grep -q 'termag CLI signed in' "$WORK/callback.html" && echo yes || echo no)"
creds="$LAPTOP/.config/termag/credentials.json"
check "credentials file is 0600" 600 "$(stat -c %a "$creds" 2>/dev/null)"
token=$(jq -r --arg h "$API" '.hosts[$h].token' "$creds")
check "a device token was stored" yes "$([[ $token == tmcli_* ]] && echo yes || echo no)"
check "the token never reached the terminal" no "$(grep -qF "$token" "$WORK/login.out" && echo yes || echo no)"
check "the token is stored hashed in the database" "0 1" \
  "$(psql -tA "postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag" -c "select count(*) filter (where \"tokenHash\" = '$token'), count(*) from cli_sessions" | tr '|' ' ')"
access=$(jq -r --arg h "$API" '.hosts[$h].accessToken' "$creds")
check "an access token (JWT) was stored" yes "$([[ $access == eyJ*.*.* ]] && echo yes || echo no)"
check "the access token authenticates" e2e@termag.local \
  "$(curl -s -H "Authorization: Bearer $access" "$API/api/cli/v1/whoami" | jq -r .user.email)"
check "jwks.json publishes the signing key" "1 RS256" \
  "$(curl -s "$API/api/cli/v1/jwks.json" | jq -r '"\(.keys | length) \(.keys[0].alg)"')"
check "the device token refreshes the access token" true \
  "$(curl -s -H 'Content-Type: application/json' -d "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"$token\"}" "$API/api/cli/v1/token" | jq -r '.accessToken | startswith("eyJ")')"

who=$(termag whoami --host "$API" --json)
check "whoami: user" e2e@termag.local "$(echo "$who" | jq -r .user.email)"
check "whoami: device credential" "device e2e-laptop" "$(echo "$who" | jq -r '"\(.credential.kind) \(.credential.deviceName)"')"

boxes=$(termag box list --host "$API" --json)
check "box list" "box-1 running true,box-2 running true" \
  "$(echo "$boxes" | jq -r '.boxes | sort_by(.name) | map("\(.name) \(.state) \(.agentConnected)") | join(",")')"
check "box list (text) shows the seeded project" yes \
  "$(termag box list --host "$API" | grep -Eq '^box-1 +running +connected +sample$' && echo yes || echo no)"
check "project list addresses <box>/<project>" box-1/sample \
  "$(termag project list --host "$API" --json | jq -r '.projects | map(.ref) | join(",")')"

# `termag tui` runs the TUI on the CLI's sign-in, and the TUI reaches its
# routes under /api/cli/v1 with it.
tui_ls=$(termag tui --host "$API" ls 2>&1)
check "termag tui ls with the device sign-in lists the seeded project" yes \
  "$(grep -Eq ' sample +(working|waiting|idle|not_running|—)' <<<"$tui_ls" && echo yes || echo no)"
pid=$(curl -s -H "Authorization: Bearer $token" "$API/api/cli/v1/lobby" | jq -r '.projects[] | select(.name == "sample") | .id')
check "lobby: the seeded project, owned" owner \
  "$(curl -s -H "Authorization: Bearer $token" "$API/api/cli/v1/lobby" | jq -r --arg id "$pid" '.projects[] | select(.id == $id) | .role')"
check "sessions: the project's agent and ctrl sessions" "agent ctrl" \
  "$(curl -s -H "Authorization: Bearer $token" "$API/api/cli/v1/sessions" | jq -r --arg id "$pid" '[.sessions[] | select(.projectId == $id) | .role] | sort | join(" ")')"
# Read-only: the CLI API has no send-keys until CLI sessions can be revoked.
check "no send-keys over /api/cli/v1" 404 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    --data '{"keys":"echo nope"}' "$API/api/cli/v1/projects/$pid/sessions/ctrl/send-keys")"
"$ROOT/boxes/box-1/bin/tmux" send-keys -t "$(id -un)-sample-ctrl" 'echo tui-e2e-$((6 * 7))' Enter
seen=no
for _ in 1 2 3 4 5; do
  sleep 1.2
  if curl -s -H "Authorization: Bearer $token" "$API/api/cli/v1/projects/$pid/sessions/ctrl/capture?lines=20" | jq -r .content | grep -q 'tui-e2e-42'; then seen=yes; break; fi
done
check "capture over /api/cli/v1 shows what was typed in the session" yes "$seen"
check "a device token is refused on the cookie routes" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$API/api/sessions")"

# The CLI API takes only bearer tokens: the browser's cookie gets nothing.
check "cookie alone is refused on /api/cli" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$API/api/cli/v1/whoami")"
check "unknown CLI path is a JSON 404" not_found \
  "$(curl -s -H "Authorization: Bearer $token" "$API/api/cli/v1/nope" | jq -r .code)"

# The approval POST refuses anything but the termag page itself.
form="port=50000&state=abcdefghijklmnopqrstuv&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&device_name=evil&decision=approve"
check "approve from a foreign origin is refused" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H 'Origin: https://evil.example' --data "$form" "$API/auth/cli/authorize")"
check "approve from a same-site page is refused" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H 'Sec-Fetch-Site: same-site' --data "$form" "$API/auth/cli/authorize")"

# On a box, the CLI uses the box's agent token with no login.
box_who=$(HOME="$ROOT/boxes/box-1/home" node "$repo/cli/bin/termag.js" whoami --json)
check "on a box: box credential, no login" "box e2e@termag.local" \
  "$(echo "$box_who" | jq -r '"\(.credential.kind) \(.user.email)"')"

box_tui=$(HOME="$ROOT/boxes/box-1/home" node "$repo/cli/bin/termag.js" tui ls 2>&1)
check "on a box: termag tui ls runs on the box's credentials" yes \
  "$(grep -Eq ' sample +(working|waiting|idle|not_running|—)' <<<"$box_tui" && echo yes || echo no)"

# Admin tokens share agent_tokens and the tmag_ prefix, but are not box credentials.
admin_token="tmag_$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
psql -q "postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag" -c "insert into agent_tokens (id, name, \"tokenHash\", \"tokenPrefix\", \"userId\", scope) \
  select 'e2e-admin-token', 'e2e admin', '$(printf %s "$admin_token" | sha256sum | cut -d' ' -f1)', 'tmag_e2e...', id, 'admin' \
  from users where \"googleEmail\" = 'e2e@termag.local'"
check "an admin-scoped tmag_ token is refused on /api/cli" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $admin_token" "$API/api/cli/v1/whoami")"

# A browser that isn't signed in yet signs in and comes back to the approval page.
ANON="$WORK/anon-cookies"
authz="$API/auth/cli/authorize?port=50000&state=abcdefghijklmnopqrstuv&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&device_name=e2e-return"
check "anonymous approval page sends the browser to sign in" "$API/auth/login" \
  "$(curl -s -o /dev/null -w '%{redirect_url}' -c "$ANON" -b "$ANON" "$authz")"
back=$(curl -s -o /dev/null -w '%{redirect_url}' -c "$ANON" -b "$ANON" "$API/auth/login")
check "sign-in returns to the approval page" "/termag/auth/cli/authorize?${authz#*\?}" "/termag${back#*/termag}"
check "the returned-to approval page renders for the new session" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' -c "$ANON" -b "$ANON" "$API${back#*/termag}")"
check "the next sign-in goes to the app again" "/termag/" \
  "/termag$(curl -s -o /dev/null -w '%{redirect_url}' -c "$ANON" -b "$ANON" "$API/auth/login" | sed 's|.*/termag||')"
check "/auth/cli answers nothing but /authorize" 404 \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" "$API/auth/cli?port=50000&state=abcdefghijklmnopqrstuv")"

echo "--- lifecycle: box create/stop/start/rm, project create/rename/archive (E2E_EC2_LAUNCH)"
PSQL=(psql -tA "postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag")
box_status() { "${PSQL[@]}" -c "select status from instances where name = '$1' order by \"createdAt\" desc limit 1"; }
wait_status() { # <box> <status>: up to 90s, for the 10s power sweep
  local i
  for i in $(seq 1 90); do [ "$(box_status "$1")" = "$2" ] && { echo "$2"; return; }; sleep 1; done
  box_status "$1"
}
box_tmux() { tmux -S "$ROOT/boxes/cli-box/tmux.sock" ls -F '#S' 2>/dev/null | sort | tr '\n' ' ' | sed 's/ $//'; }

termag box create 'bad name' --host "$API" >/dev/null 2>&1
check "box create: a name outside the rule is a usage error" 2 $?
check "the API refuses it too (CLI route)" 400 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $access" -H 'content-type: application/json' -d '{"name":"bad name"}' "$API/api/cli/v1/boxes")"
check "the API refuses it too (web UI route)" "Box names may contain only letters, digits, - and _" \
  "$(curl -s -b "$JAR" -H 'content-type: application/json' -d '{"name":"bad name"}' "$API/api/instances" | jq -r .error)"

termag box create cli-box --wait --timeout 300 --host "$API" >"$WORK/create.out" 2>"$WORK/create.err"
check "box create --wait exits 0" 0 $?
check "box create --wait says the box is running" "Created box cli-box; it is running." "$(cat "$WORK/create.out")"
check "box create --wait reported progress on stderr" yes "$(grep -q '^cli-box: provisioning' "$WORK/create.err" && echo yes || echo no)"
created=$(termag box list --host "$API" --json | jq -c '{box: (.boxes[] | select(.name == "cli-box"))}')
check "box list: the new box is running with its agent" "running true" \
  "$(echo "$created" | jq -r '"\(.box.state) \(.box.agentConnected)"')"
check "box create --if-not-exists returns the existing box" "false $(echo "$created" | jq -r .box.id)" \
  "$(termag box create cli-box --if-not-exists --host "$API" --json | jq -r '"\(.created) \(.box.id)"')"
termag box create cli-box --host "$API" >/dev/null 2>&1
check "box create on a taken name exits 1" 1 $?
U=$(echo "$who" | jq -r .user.unixUsername)
BOX_HOME="$ROOT/boxes/cli-box/home"
project_dirs() { find "$BOX_HOME" -maxdepth 4 -type d -path '*/projects/*' -prune -printf '%f\n' | sort | tr '\n' ' ' | sed 's/ $//'; }

proj=$(termag project create cli-box/proj --agent claude --host "$API" --json)
check "project create" "true cli-box/proj claude" "$(echo "$proj" | jq -r '"\(.created) \(.project.ref) \(.project.provider)"')"
check "project create made the sessions on the box" "$U-proj-agent $U-proj-ctrl" "$(box_tmux)"
check "project create made the directory on the box" proj "$(project_dirs)"
check "project create --if-not-exists returns it" false \
  "$(termag project create cli-box/proj --agent claude --if-not-exists --host "$API" --json | jq -r .created)"
termag project create cli-box/other --host "$API" >/dev/null 2>&1
check "project create without --agent is a usage error" 2 $?
termag project create nobox/x --agent claude --host "$API" >/dev/null 2>&1
check "project create on an unknown box exits 3" 3 $?

termag project rename cli-box/proj proj2 --host "$API" >/dev/null
check "project rename exits 0" 0 $?
check "project rename renamed the box's sessions" "$U-proj2-agent $U-proj2-ctrl" "$(box_tmux)"
check "project rename moved the directory on the box" proj2 "$(project_dirs)"
check "project list shows the new name" yes \
  "$(termag project list --host "$API" --json | jq -e '.projects | map(.ref) | index("cli-box/proj2")' >/dev/null && echo yes || echo no)"

# On the box itself: its own token creates projects but can't terminate boxes.
on_box() { HOME="$BOX_HOME" node "$repo/cli/bin/termag.js" "$@"; }
check "on the box: project create with the box's token" true \
  "$(on_box project create cli-box/from-box --agent claude --json | jq -r .created)"
on_box box rm cli-box --yes >"$WORK/box-rm.out" 2>&1
check "on the box: box rm is refused" "1 yes" \
  "$? $(grep -q "own credentials can't terminate" "$WORK/box-rm.out" && echo yes || echo no)"
termag project archive cli-box/from-box --host "$API" >/dev/null 2>&1
check "project archive without a terminal needs --yes" 2 $?
termag project archive cli-box/from-box --yes --host "$API" >/dev/null
check "project archive --yes exits 0" 0 $?

check "box stop" stopping "$(termag box stop cli-box --host "$API" --json | jq -r .box.state)"
check "the box settles to stopped" stopped "$(wait_status cli-box stopped)"
check "stopping powered the box off" "" "$(box_tmux)"
termag project create cli-box/while-stopped --agent claude --host "$API" >"$WORK/stopped.out" 2>&1
check "project create on a stopped box says so" "1 yes" "$? $(grep -q 'This box is stopped' "$WORK/stopped.out" && echo yes || echo no)"
check "box stop on a stopped box is a no-op" false "$(termag box stop cli-box --host "$API" --json | jq -r .stopped)"

check "box start --wait" "true running" \
  "$(termag box start cli-box --wait --timeout 300 --host "$API" --json 2>/dev/null | jq -r '"\(.started) \(.box.state)"')"
check "the project's sessions came back" "$U-proj2-agent $U-proj2-ctrl" "$(box_tmux)"

termag box rm cli-box --host "$API" >/dev/null 2>&1
check "box rm without a terminal needs --yes" 2 $?
check "box rm --yes archives the box's project" 1 "$(termag box rm cli-box --yes --host "$API" --json | jq -r .archivedProjects)"
check "the box is terminated" terminated "$(box_status cli-box)"
check "box list no longer shows it" "" "$(termag box list --host "$API" --json | jq -r '.boxes | map(select(.name == "cli-box")) | .[].name')"

devices=$(curl -s -b "$JAR" "$API/api/cli-devices")
check "web UI lists the device" e2e-laptop "$(echo "$devices" | jq -r 'map(.deviceName) | join(",")')"

termag logout --host "$API" >/dev/null
check "logout exits 0" 0 $?
termag whoami --host "$API" >/dev/null 2>&1
check "whoami after logout exits 4" 4 $?
check "the token is revoked server-side" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$API/api/cli/v1/whoami")"

# Revoking from the web UI signs the device out.
termag_tty login --host "$API" --device e2e-laptop >/dev/null 2>&1
id=$(curl -s -b "$JAR" "$API/api/cli-devices" | jq -r '.[0].id')
check "web UI revoke" true "$(curl -s -b "$JAR" -X DELETE "$API/api/cli-devices/$id" | jq -r .ok)"
termag whoami --host "$API" >/dev/null 2>&1
check "whoami after a web UI revoke exits 4" 4 $?

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all CLI e2e checks passed"
