#!/bin/sh
# Tests deploy/claude-spawn-runner, the Claude Code orchestrator's spawn
# hook, against a stub backend:
#
#   * a 202 submits: exit 0, the request carried the bearer token from the
#     token file and the work order from the work-order file, and neither the
#     JWT nor the owner email reached stderr
#   * 503 (no box) and an unreachable backend are retryable: exit 1
#   * 404 with the backend's owner-not-found code (not a termag user) is
#     non-retryable: exit 2, with the backend's reason on stderr for the
#     Activity tab
#   * a plain 404 (route not mounted, or the URL reaches nginx) and a 401
#     (token mismatch) are this host's configuration, not the session's:
#     exit 1, so queued sessions wait for the fix
#   * the body carries only what the backend uses; the creator's account id
#     and the attempt count ride along when the orchestrator set them, and
#     never reach stderr
#   * orders with no session (pre-warming) or no owner email never call the
#     backend and exit 2; so does a missing CLAUDE_RUNNER_SPAWN_URL (no
#     default port: a guess that lands on nginx is a permanent 404)
#
# Run: sh deploy/claude-spawn-runner.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/claude-spawn-runner"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

NODE="$(command -v node)" || { echo "SKIP: node not installed"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }
command -v curl >/dev/null 2>&1 || { echo "SKIP: curl not installed"; exit 0; }

JWT='eyJhbGciOiJIUzI1NiJ9.eyJvcmRlciI6Im9yZC0xIn0.c2lnbmF0dXJlLXRlc3Q' # gitleaks:allow
printf '%s\n' "$JWT" > "$WORK/work-order"
printf 'spawn-secret-token\n' > "$WORK/token"

# Stub backend: answers with the status the test asked for (first path
# segment) and records the last request to a file the test reads.
cat > "$WORK/server.js" <<'EOF'
const http = require('http'); const fs = require('fs');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    fs.writeFileSync(process.env.RECORD, JSON.stringify({ auth: req.headers.authorization, path: req.url, body }));
    const seg = req.url.split('/')[1];
    const status = Number(seg.replace('owner', '')) || 500;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(seg === '404owner'
      ? { error: 'the session owner is not a termag user', code: 'owner-not-found' }
      : { error: `status ${status}` }));
  });
});
server.listen(0, '127.0.0.1', () => { fs.writeFileSync(process.env.PORT_FILE, String(server.address().port)); });
EOF
RECORD="$WORK/record" PORT_FILE="$WORK/port" "$NODE" "$WORK/server.js" &
SERVER_PID=$!
# Node takes a moment to start; a slow CI runner has taken over two seconds,
# and every case below then fails with HTTP 000. Wait up to ten, and say so.
i=0
while [ ! -s "$WORK/port" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
[ -s "$WORK/port" ] || { echo "FAIL: the fake backend did not write its port within 10 s"; exit 1; }
PORT="$(cat "$WORK/port")"

run() {
  # $1 = backend status to answer; rest = extra env overrides
  status=$1; shift
  env -i PATH="$PATH" HOME="$WORK" \
    CLAUDE_RUNNER_SPAWN_URL="http://127.0.0.1:$PORT/$status/spawn" \
    CLAUDE_RUNNER_SPAWN_TOKEN_FILE="$WORK/token" \
    CLAUDE_RUNNER_WORK_ORDER_FILE="$WORK/work-order" \
    CLAUDE_RUNNER_ORDER_ID=ord-1 CLAUDE_RUNNER_SESSION_ID=sess-1 \
    CLAUDE_RUNNER_ACCOUNT_EMAIL=ada@example.com CLAUDE_RUNNER_ATTEMPT=1 \
    CLAUDE_RUNNER_PRIMARY_REPO_URL=https://github.com/example/repo \
    "$@" bash "$HOOK" 2>"$WORK/err"
}

rm -f "$WORK/record"
run 202; got=$?
[ "$got" = 0 ] || fail '202 submits with exit 0' 0 "$got"
auth="$(jq -r .auth "$WORK/record" 2>/dev/null)"
[ "$auth" = 'Bearer spawn-secret-token' ] || fail 'bearer token comes from the token file' 'Bearer spawn-secret-token' "$auth"
sent_jwt="$(jq -r '.body | fromjson | .workOrder' "$WORK/record" 2>/dev/null)"
[ "$sent_jwt" = "$JWT" ] || fail 'work order is the JWT from the file, newline stripped' "$JWT" "$sent_jwt"
sent_email="$(jq -r '.body | fromjson | .accountEmail' "$WORK/record" 2>/dev/null)"
[ "$sent_email" = 'ada@example.com' ] || fail 'owner email is in the body' 'ada@example.com' "$sent_email"
sent_order="$(jq -r '.body | fromjson | .orderId' "$WORK/record" 2>/dev/null)"
[ "$sent_order" = 'ord-1' ] || fail 'order id is in the body' 'ord-1' "$sent_order"
grep -q "$JWT" "$WORK/err" && fail 'the JWT never reaches stderr' '(absent)' 'present'
grep -q 'ada@example.com' "$WORK/err" && fail 'the owner email never reaches stderr' '(absent)' 'present'
grep -q 'ord-1' "$WORK/err" || fail 'stderr names the order' 'ord-1' "$(cat "$WORK/err")"
keys="$(jq -r '.body | fromjson | keys | join(",")' "$WORK/record" 2>/dev/null)"
[ "$keys" = 'accountEmail,attempt,orderId,sessionId,workOrder' ] || fail 'body carries only what the backend uses' 'accountEmail,attempt,orderId,sessionId,workOrder' "$keys"
sent_attempt="$(jq -r '.body | fromjson | .attempt' "$WORK/record" 2>/dev/null)"
[ "$sent_attempt" = 1 ] || fail 'the attempt count is in the body as a number' 1 "$sent_attempt"

# The creator's account id rides along when the orchestrator set it.
rm -f "$WORK/record"
run 202 CLAUDE_RUNNER_ACCOUNT_ID=user_01HXYZ; got=$?
[ "$got" = 0 ] || fail 'account id: submits' 0 "$got"
sent_account="$(jq -r '.body | fromjson | .accountId' "$WORK/record" 2>/dev/null)"
[ "$sent_account" = 'user_01HXYZ' ] || fail 'the account id is in the body when set' 'user_01HXYZ' "$sent_account"
grep -q 'user_01HXYZ' "$WORK/err" && fail 'the account id never reaches stderr' '(absent)' 'present'
rm -f "$WORK/record"
run 202 CLAUDE_RUNNER_ATTEMPT=; got=$?
keys="$(jq -r '.body | fromjson | keys | join(",")' "$WORK/record" 2>/dev/null)"
[ "$keys" = 'accountEmail,orderId,sessionId,workOrder' ] || fail 'without an account id or attempt the body is as before' 'accountEmail,orderId,sessionId,workOrder' "$keys"

run 503; got=$?
[ "$got" = 1 ] || fail '503 (no ready box) is retryable' 1 "$got"

run 404owner; got=$?
[ "$got" = 2 ] || fail '404 owner-not-found (not a termag user) is non-retryable' 2 "$got"
grep -q 'not a termag user' "$WORK/err" || fail "404's reason is relayed to stderr" 'not a termag user' "$(cat "$WORK/err")"

run 404; got=$?
[ "$got" = 1 ] || fail 'a plain 404 (route not mounted) is retryable' 1 "$got"
grep -q 'CLAUDE_RUNNER_SPAWN_TOKEN' "$WORK/err" || fail 'a plain 404 points at the backend config' 'CLAUDE_RUNNER_SPAWN_TOKEN' "$(cat "$WORK/err")"

run 401; got=$?
[ "$got" = 1 ] || fail '401 (token mismatch) is retryable' 1 "$got"

run 400; got=$?
[ "$got" = 2 ] || fail '400 is non-retryable' 2 "$got"

run 500; got=$?
[ "$got" = 1 ] || fail '500 is retryable' 1 "$got"

rm -f "$WORK/record"
run 202 CLAUDE_RUNNER_SPAWN_URL="http://127.0.0.1:1/spawn"; got=$?
[ "$got" = 1 ] || fail 'unreachable backend is retryable' 1 "$got"

rm -f "$WORK/record"
run 202 CLAUDE_RUNNER_SESSION_ID=; got=$?
[ "$got" = 2 ] || fail 'pre-warming order (no session) exits 2' 2 "$got"
[ ! -e "$WORK/record" ] || fail 'pre-warming order never calls the backend' '(no request)' 'request made'

rm -f "$WORK/record"
run 202 CLAUDE_RUNNER_ACCOUNT_EMAIL=; got=$?
[ "$got" = 2 ] || fail 'order without owner email exits 2' 2 "$got"
[ ! -e "$WORK/record" ] || fail 'ownerless order never calls the backend' '(no request)' 'request made'

run 202 CLAUDE_RUNNER_WORK_ORDER_FILE="$WORK/nope"; got=$?
[ "$got" = 2 ] || fail 'missing work-order file exits 2' 2 "$got"

rm -f "$WORK/record"
run 202 CLAUDE_RUNNER_SPAWN_URL=; got=$?
[ "$got" = 2 ] || fail 'unset spawn URL exits 2 instead of guessing a port' 2 "$got"
[ ! -e "$WORK/record" ] || fail 'unset spawn URL never calls anything' '(no request)' 'request made'
grep -q 'orchestrator.env' "$WORK/err" || fail 'unset spawn URL points at the env file' 'orchestrator.env' "$(cat "$WORK/err")"

if [ "$failures" -eq 0 ]; then
  echo "ok: spawn-runner"
else
  echo "$failures failure(s)"
  exit 1
fi
