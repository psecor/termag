#!/usr/bin/env bash
# `termag ask` across two orchestrators on one database: the reply is never stored, so a `termag ask` that
# long-polls one backend only gets it if the backend the box posted the result
# to hands it over through Postgres LISTEN/NOTIFY. Runs on the E2E_OVERLAP
# stack (two backends, the box network standing in for the ALB):
#
#   1. live overlap: the ask starts on blue, green takes the lease, the CLI
#      waits on draining blue and the result lands on green;
#   2. across a restart: the CLI waits on green, green stops and starts again
#      under the CLI (which retries), and the result lands on blue.
#
# The run itself is a stub `termag-subagent-run` on box-1 that stays alive the
# way a real run does; the test posts the box's result with box-1's token, as
# the runner would, to the backend it picks. The reply is multi-chunk and
# multibyte, so it has to be reassembled from several notifications.
#
# Run: bash scripts/e2e/ask-overlap.test.sh   (or make e2e-test-ask-overlap)
#   E2E_TEST_PORT_SHIFT=N        add N to every port
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
S=${E2E_TEST_PORT_SHIFT:-0}
export E2E_PORT=$((4010 + S)) E2E_GREEN_PORT=$((4013 + S)) E2E_FRONTEND_PORT=$((6036 + S)) E2E_PG_PORT=$((55509 + S)) \
  E2E_BOXES=2 E2E_OVERLAP=1
ROOT=
cleanup() {
  # The stub runs are detached from their agent; stop them by their pid files.
  if [ -n "$ROOT" ]; then
    for f in "$ROOT"/boxes/*/home/.termag/subagent/jobs/*.pid; do
      [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null
    done
  fi
  bash "$here/down.sh" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

fails=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

if [ ! -x "$repo/cli/node_modules/.bin/tsc" ]; then
  (cd "$repo/cli" && npm ci --no-audit --no-fund >"$WORK/cli-install.log" 2>&1) || { cat "$WORK/cli-install.log"; echo "FAIL: cli npm ci"; exit 1; }
fi
(cd "$repo/cli" && npm run build >"$WORK/cli-build.log" 2>&1) || { cat "$WORK/cli-build.log"; echo "FAIL: cli build"; exit 1; }
pass "cli builds"

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
status_of() { "${PSQL[@]}" -c "select status from agent_messages where id = '$1'"; }
wait_status() { # <message> <status> <seconds>
  for _ in $(seq 1 $(($3 * 4))); do [ "$(status_of "$1")" = "$2" ] && break; sleep 0.25; done
  status_of "$1"
}

BOX1_HOME=$ROOT/boxes/box-1/home
BOX1_TOKEN=$(jq -r .token "$BOX1_HOME/.termag/agent.config.json")
BOX2_TOKEN=$(jq -r .token "$ROOT/boxes/box-2/home/.termag/agent.config.json")

# The asker is box-2, on its own box credential, pinned to one backend by a
# config whose agent URL names that backend's port (cli/src/config.ts).
mkdir -p "$WORK/asker"
for port in "$E2E_PORT" "$E2E_GREEN_PORT"; do
  jq -n --arg t "$BOX2_TOKEN" --arg u "ws://127.0.0.1:$port/termag/ws/agent" '{token: $t, termag_url: $u}' >"$WORK/cfg-$port.json"
done
ask_on() { # <port> <ask args...>
  local port=$1; shift
  HOME="$WORK/asker" TERMAG_AGENT_CONFIG="$WORK/cfg-$port.json" timeout 300 node "$repo/cli/bin/termag.js" ask "$@"
}
# What box-1's runner would post when the run ends, to the backend given.
post_result() { # <base> <message> <body file>
  curl -s -o "$WORK/result-$2.out" -w '%{http_code}' -X POST -H "Authorization: Bearer $BOX1_TOKEN" \
    -H 'content-type: application/json' --data-binary "@$3" "$1/api/cli/v1/ask/runs/$2/result"
}
enveloped_sha() { # the text inside the CLI's <untrusted-reply> fence
  node -e '
    const s = require("fs").readFileSync(process.argv[1], "utf8");
    const start = s.indexOf("\n", s.indexOf("<untrusted-reply ")) + 1;
    process.stdout.write(s.slice(start, s.indexOf("\n</untrusted-reply>", start)));
  ' "$1" 2>/dev/null | sha256sum | cut -d' ' -f1
}
reply_sha() { jq -j '.artifacts[] | select(.name == "reply") | .parts[0].text' "$1" 2>/dev/null | sha256sum | cut -d' ' -f1; }

# A reply over several 5400-byte NOTIFY chunks, multibyte so a chunk boundary
# lands inside a character.
make_reply() { # <tag> <out reply> <out body>
  node -e '
    const [tag, replyFile, bodyFile] = process.argv.slice(1);
    let s = `reply ${tag}\n`;
    for (let i = 0; Buffer.byteLength(s) < 30000; i++) s += `line ${i}: é✓ 日本語 — ${tag}\n`;
    require("fs").writeFileSync(replyFile, s);
    require("fs").writeFileSync(bodyFile, JSON.stringify({ result: s, isError: false, numTurns: 1 }));
  ' "$1" "$2" "$3"
}

# --- a stub run on box-1: the agent announces ask-v1 once the runner is there.
mkdir -p "$BOX1_HOME/.local/bin"
cat >"$BOX1_HOME/.local/bin/termag-subagent-run" <<'EOF'
#!/bin/sh
# e2e stand-in: a run that is still going until the test posts its result.
echo "$1" >>"$HOME/stub-runs"
exec sleep 900
EOF
chmod +x "$BOX1_HOME/.local/bin/termag-subagent-run"
before=$(connected backend)
bash "$here/ctl.sh" restart box-1 >/dev/null
wait_connected backend $((before + 1)) 30 >/dev/null
askable=
for _ in $(seq 1 60); do
  askable=$(ask_on "$E2E_PORT" --targets --json 2>/dev/null \
    | jq -r '.agents[] | select(.name == "box-1/sample") | .capabilities.extensions[]? | select(.uri == "urn:termag:ask:v1") | .params.askable' 2>/dev/null)
  [ "$askable" = true ] && break; sleep 0.5
done
check "box-1/sample is askable through blue" true "$askable"

echo "--- 1. live overlap: the CLI waits on blue, the result lands on green"
ask_on "$E2E_PORT" box-1/sample "first question" --no-wait --json >"$WORK/m1.json" 2>"$WORK/m1.err"
check "ask on blue exits 0" 0 $?
M1=$(jq -r .id "$WORK/m1.json")
check "box-1 took the run" working "$(wait_status "$M1" working 20)"

bash "$here/ctl.sh" start backend-green >/dev/null
check "green serves" 200 "$(wait_serving "$GREEN" 200 60)"
check "blue stops serving (draining)" 503 "$(wait_serving "$BLUE" 503 5)"
check "both boxes moved to green" 2 "$(wait_connected backend-green 2 30)"

ask_on "$E2E_PORT" --reply "$M1" --json >"$WORK/r1.json" 2>"$WORK/r1.err" &
r1=$!
sleep 3
check "the CLI is still waiting on blue" yes "$(kill -0 "$r1" 2>/dev/null && echo yes || echo no)"
make_reply one "$WORK/reply1.txt" "$WORK/body1.json"
code=$(post_result "$GREEN" "$M1" "$WORK/body1.json")
check "green took box-1's result" yes "$([ "${code:0:1}" = 2 ] && echo yes || echo "$code $(cat "$WORK/result-$M1.out")")"
wait "$r1"
check "the CLI on blue exits 0" 0 $?
check "it got the reply green received, byte for byte" "$(sha256sum <"$WORK/reply1.txt" | cut -d' ' -f1)" "$(reply_sha "$WORK/r1.json")"
check "the message is completed" completed "$(status_of "$M1")"
check "and marked delivered" t "$("${PSQL[@]}" -c "select \"readAt\" is not null from agent_messages where id = '$M1'")"
check "the reply took several notifications" yes "$([ "$(wc -c <"$WORK/reply1.txt")" -gt 10800 ] && echo yes || echo no)"

echo "--- 2. across a restart: the CLI waits on green, green restarts under it, the result lands on blue"
ask_on "$E2E_GREEN_PORT" box-1/sample "second question" --thread "$(jq -r .contextId "$WORK/m1.json")" --no-wait --json \
  >"$WORK/m2.json" 2>"$WORK/m2.err"
check "follow-up on green exits 0" 0 $?
M2=$(jq -r .id "$WORK/m2.json")
check "box-1 took the second run" working "$(wait_status "$M2" working 20)"

# Plain output this time: --json keeps stderr quiet, and the retry line is the point.
ask_on "$E2E_GREEN_PORT" --reply "$M2" >"$WORK/r2.out" 2>"$WORK/r2.err" &
r2=$!
sleep 3
bash "$here/ctl.sh" stop backend-green >/dev/null
check "blue serves again after the stale window" 200 "$(wait_serving "$BLUE" 200 30)"
check "the CLI is still waiting with green down" yes "$(kill -0 "$r2" 2>/dev/null && echo yes || echo no)"
bash "$here/ctl.sh" start backend-green >/dev/null
check "the new green serves" 200 "$(wait_serving "$GREEN" 200 60)"
check "blue drains again" 503 "$(wait_serving "$BLUE" 503 5)"
wait_connected backend-green 4 30 >/dev/null
# The CLI's backoff tops out at 5 s; give its retry time to land on the new green.
sleep 7
check "the CLI is still waiting, now on the new green" yes "$(kill -0 "$r2" 2>/dev/null && echo yes || echo no)"
make_reply two "$WORK/reply2.txt" "$WORK/body2.json"
code=$(post_result "$BLUE" "$M2" "$WORK/body2.json")
check "draining blue took box-1's result" yes "$([ "${code:0:1}" = 2 ] && echo yes || echo "$code $(cat "$WORK/result-$M2.out")")"
wait "$r2"
check "the CLI exits 0" 0 $?
check "it got the reply blue received, byte for byte" "$(sha256sum <"$WORK/reply2.txt" | cut -d' ' -f1)" "$(enveloped_sha "$WORK/r2.out")"
check "the CLI said it was retrying through the restart" yes "$(grep -q "retrying (message $M2)" "$WORK/r2.err" && echo yes || echo no)"
check "the second message is completed" completed "$(status_of "$M2")"

check "no reply text in the database" 0 \
  "$("${PSQL[@]}" -c "select count(*) from information_schema.columns where table_name in ('agent_messages','agent_threads') and column_name in ('reply','replyText','body','prompt')")"

[ "$fails" -eq 0 ] || { echo "$fails ask overlap check(s) failed"; for f in "$WORK"/r*.err "$WORK"/r*.out; do echo "== $f"; cat "$f"; done; exit 1; }
echo "all ask overlap e2e checks passed"
