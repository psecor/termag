#!/usr/bin/env bash
# Regression check for the desktop bridge's HTTP relay under slow clients:
# six parallel downloads through
# /api/cli/v1/boxes/:id/t3/relay, each of E2E_T3_SLOW_MB (12 MiB) read at
# E2E_T3_SLOW_KBPS (100 KiB/s) by slow-client.py, so each runs about two
# minutes, well past the orchestrator's 25 s tunnel heartbeat. Every one must
# arrive whole and end. On loopback the kernel's send buffers take in about
# 4 MB of each answer at once, so the body has to be well over that for the
# relay to stay held back. Before the fixes this checks, every download stopped
# at the same byte count about 50 s in (the heartbeat terminated the paused
# tunnel) and then hung, its answer never ended. The box runs
# fakes/t3-blob.mjs as its t3 server. Runs on its own ports and TMPDIR, so it
# can run beside a stack that is already up.
#
# Run: bash scripts/e2e/t3-slow-relay.test.sh   (or make e2e-test-t3-slow-relay)
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-3980} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-6006} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55469} E2E_BOXES=1 \
  E2E_T3=1 E2E_T3_COMMAND="$here/fakes/t3-blob.mjs"
MB=${E2E_T3_SLOW_MB:-12}
KBPS=${E2E_T3_SLOW_KBPS:-100}
STREAMS=6
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
pass "up.sh brought the stack up with E2E_T3=1 and the blob server"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
API="http://127.0.0.1:$E2E_PORT/termag"
CLI="$API/api/cli/v1"
JAR="$WORK/browser-cookies"

# ── a device sign-in, as t3.test.sh does it ──────────────────────────────────
verifier=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')
challenge=$(pkce_challenge "$verifier")
pkce_state=$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))')
query="port=45999&state=$pkce_state&code_challenge=$challenge&code_challenge_method=S256&device_name=e2e-slow-relay"
curl -s -o /dev/null -c "$JAR" -b "$JAR" "$API/auth/login"
curl -s -o /dev/null -c "$JAR" -b "$JAR" "$API/auth/cli/authorize?$query"
curl -s -o /dev/null -c "$JAR" -b "$JAR" -D "$WORK/approve.headers" \
  -H "Origin: http://127.0.0.1:$E2E_PORT" --data "$query&decision=approve" "$API/auth/cli/authorize"
code=$(grep -i '^location:' "$WORK/approve.headers" | tr -d '\r' | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
curl -s -H 'Content-Type: application/json' -d "{\"grant_type\":\"authorization_code\",\"code\":\"$code\",\"code_verifier\":\"$verifier\"}" "$CLI/token" >"$WORK/token.json"
JWT=$(jq -r .accessToken "$WORK/token.json")
check "a device sign-in" yes "$([[ $JWT == eyJ*.*.* ]] && echo yes || echo no)"
auth=(-H "Authorization: Bearer $JWT")
BOX=$(curl -s "${auth[@]}" "$CLI/boxes" | jq -r '.boxes[] | select(.name == "box-1") | .id')

state=""
for _ in $(seq 1 120); do
  state=$(curl -s -X POST "${auth[@]}" "$CLI/boxes/$BOX/t3/ensure" | jq -r .state 2>/dev/null)
  [ "$state" = ready ] && break
  sleep 1
done
check "ensure: the box runs the blob server as its t3" ready "$state"

# ── six slow clients at once ───────────────────────────────────────────────
want_bytes=$((MB * 1024 * 1024))
want_sha=$(node -e '
  const b = Buffer.alloc(1048576);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 0xff;
  const h = require("crypto").createHash("sha256");
  for (let n = 0; n < Number(process.argv[1]); n++) h.update(b);
  process.stdout.write(h.digest("hex"));
' "$MB")
R="$CLI/boxes/$BOX/t3/relay"
# slow-client.py, not curl: its fixed small receive buffer keeps the kernel
# from soaking up the whole body on loopback, so the relay is really held back
# for the whole download, as behind a slow link. It reports a hang after 60 s
# of nothing instead of waiting for a proxy's hour.
for i in $(seq 1 $STREAMS); do
  AUTH="Bearer $JWT" python3 "$here/slow-client.py" "$R/blob?mb=$MB" $((KBPS * 1024)) 60 >"$WORK/blob.$i.out" 2>"$WORK/blob.$i.err" &
done
wait

for i in $(seq 1 $STREAMS); do
  read -r status size sha secs how <"$WORK/blob.$i.out"
  check "download $i: 200, all $want_bytes bytes, and the answer ended" "200 $want_bytes ended" "${status:-} ${size:-} ${how:-}"
  check "download $i: the bytes are the box's, in order" "$want_sha" "${sha:-}"
  check "download $i: ran past the 25 s heartbeat (${secs%.*} s)" yes "$(awk -v s="${secs:-0}" 'BEGIN { print (s > 30) ? "yes" : "no" }')"
done
check "the relay logged no cut-short answer" 0 "$(grep -c '\[T3-RELAY\]' "$ROOT/logs/backend.log")"
check "the agent gave up no tunnel" 0 "$(grep -c 'tunnel gave up' "$ROOT/logs/box-1.log")"

echo
if [ "$failures" -eq 0 ]; then echo "all t3 slow-relay checks passed"; else echo "$failures t3 slow-relay check(s) failed"; fi
[ "$failures" -eq 0 ]
