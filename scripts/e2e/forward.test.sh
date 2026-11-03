#!/usr/bin/env bash
# End-to-end check of the native port forward: the real
# `termag forward` from cli/, the real orchestrator route behind
# box-port-forward-enabled, and the real box agent (port-forward-v1), on a
# local stack with E2E_FLAGS turning the flag on and the EC2 launch fake for a
# box to stop. On the box's loopback, as the test's own uid (the agent's port
# guard allows only that), fakes/forward-stand-ins.cjs serves an HTTP file, a
# WebSocket echo, a half-close echo and a server that speaks first. Through the
# forward: an HTTP GET; a 50 MiB download, then six at once (each whole, and
# its MB/s printed); six slow readers and three slow box-side writers
# (slow-client.py and fakes/slow-sink.py, E2E_FORWARD_SLOW_MB MiB each, default
# 24, at E2E_FORWARD_SLOW_KBPS KiB/s, default 192: about two minutes, well past
# the orchestrator's 25 s heartbeat), each of which must arrive whole and end,
# and a slow service that takes a whole upload, then answers 75 s later, past
# the agent's 60 s stall bound (E2E_FORWARD_SLOW=0 skips them); the three
# protocols; the refusals (a root port,
# port_closed, bad_port, no subprotocol, a box's own token, a local port
# already held); Ctrl-C's totals; a box stopped mid-forward (4409); an open
# forward counted in the box's host sample (Instance.openTunnels, which the
# `tunnels` busy check reads; up to 5 minutes for the next sample); the
# [FORWARD] log lines; the close of a forward a backend restart ends (1001);
# and, last, the flag turned off, where the CLI prints
# the `termag ssh … -N -L` fallback and exits. Runs on its own ports and
# TMPDIR, so it can run beside a stack that is already up.
#
# One longer check is opt-in:
#   E2E_FORWARD_EXP=1   a connection held past its access token's exp (the
#                       token's hour is fixed, so this runs about 65 minutes)
#                       must keep relaying: on termag-forward.v2 that takes
#                       the CLI's in-band renewals, or it closes with 4402.
# Not covered here: the 12 h cap (4408) and the process ceiling, which the
# stack can't shorten (cliForward.test.ts covers both), and 1012 on a drain
# (E2E_OVERLAP).
#
# Run: bash scripts/e2e/forward.test.sh   (or make e2e-test-forward)
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-3990} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-6016} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55479} E2E_BOXES=1 \
  E2E_AWS_PORT=${E2E_TEST_AWS_PORT:-4696} E2E_EC2_PORT=${E2E_TEST_EC2_PORT:-4697} E2E_FAKE_AWS=1 E2E_EC2_LAUNCH=1 \
  E2E_FLAGS='{"box-port-forward-enabled":true}'
SLOW_MB=${E2E_FORWARD_SLOW_MB:-24}
SLOW_KBPS=${E2E_FORWARD_SLOW_KBPS:-192}
pids=()
# ${pids[@]+…}: macOS's bash 3.2 takes an empty array for an unset one under set -u.
trap 'for p in ${pids[@]+"${pids[@]}"}; do kill "$p" 2>/dev/null; done; bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }
info() { echo "      $1"; }
# Portable to macOS, which has no sha256sum, timeout(1) or date +%N, and whose sed -i takes a suffix.
sha_of() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }
now_s() { node -e 'process.stdout.write(String(Date.now() / 1000))'; }
# timeout <seconds> <command>…: SIGALRM after that long (exit 142).
timeout() { perl -e 'alarm shift; exec @ARGV or die "exec: $!"' "$@"; }

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
pass "up.sh brought the stack up with box-port-forward-enabled and the EC2 launch fake"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
API="http://127.0.0.1:$E2E_PORT/termag"
CLI="$API/api/cli/v1"
LAPTOP="$WORK/laptop"
export NODE_PATH="$repo/backend/node_modules"
SI="$here/fakes/forward-stand-ins.cjs"
PSQL=(psql -tA "postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag")

# ── a device sign-in, stored where `termag login` keeps it ───────────────────
mkdir -p "$LAPTOP/.config"
XDG_CONFIG_HOME="$LAPTOP/.config" bash "$here/cli-login.sh" "$API" >"$WORK/login.out" 2>&1
check "a device sign-in for the laptop's CLI" 0 $?
TERMAG=(env HOME="$LAPTOP" XDG_CONFIG_HOME="$LAPTOP/.config" TERMAG_URL="$API" node "$repo/cli/bin/termag.js")
termag() { "${TERMAG[@]}" "$@"; }
JWT=$(jq -r '.hosts[].accessToken' "$LAPTOP/.config/termag/credentials.json")
auth=(-H "Authorization: Bearer $JWT")
BOX=$(termag box list --json | jq -r '.boxes[] | select(.name == "box-1") | .id')
check "box-1 is listed" yes "$([ -n "$BOX" ] && echo yes || echo no)"

# Free loopback ports: four for the stand-ins, then local ones for the forwards.
read -r -a P <<<"$(node -e '
  const net = require("net"); const n = Number(process.argv[1]); const got = [];
  (function next() {
    // Each held open until all are picked: one closed at once could be handed out again.
    if (got.length === n) { console.log(got.map((g) => g.port).join(" ")); got.forEach((g) => g.s.close()); return; }
    const s = net.createServer().listen(0, "127.0.0.1", () => { got.push({ s, port: s.address().port }); next(); });
  })();' 17)"
HTTP=${P[0]} WSP=${P[1]} HALF=${P[2]} GREET=${P[3]} CLOSED=${P[4]}
L_HTTP=${P[5]} L_WS=${P[6]} L_HALF=${P[7]} L_GREET=${P[8]} L_HELD=${P[9]} L_STOP=${P[10]} L_MISC=${P[11]} L_CLOSED=${P[12]}
SINK=${P[13]} L_SINK=${P[14]} LATE=${P[15]} L_LATE=${P[16]}
LATE_MB=8 LATE_S=75

node "$SI" serve "$HTTP" "$WSP" "$HALF" "$GREET" 2>"$WORK/stand-ins.log" &
pids+=($!)
python3 "$here/fakes/slow-sink.py" sink "$SINK" $((SLOW_KBPS * 1024)) "$WORK/sink.log" 2>"$WORK/sink.err" &
pids+=($!)
python3 "$here/fakes/slow-sink.py" sink "$LATE" $((SLOW_KBPS * 1024)) "$WORK/late.log" "$LATE_S" 2>"$WORK/late.err" &
pids+=($!)
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$HTTP/" && break; sleep 0.25; done

# fwd_start <name> <box> <spec>…: `termag forward` in the background, once it listens.
fwd_start() {
  local name=$1; shift
  "${TERMAG[@]}" forward "$@" >"$WORK/$name.out" 2>"$WORK/$name.err" &
  local pid=$!
  pids+=("$pid")
  eval "PID_$name=$pid"
  for _ in $(seq 1 60); do grep -q '^Ctrl-C to stop' "$WORK/$name.out" 2>/dev/null && return 0; kill -0 "$pid" 2>/dev/null || return 1; sleep 0.25; done
  return 1
}
# fwd_stop <name>: Ctrl-C, and its exit status.
fwd_stop() {
  local pid
  pid=$(eval "echo \$PID_$1")
  kill -INT "$pid" 2>/dev/null
  wait "$pid"
}
blob_sha() { node -e '
  const b = Buffer.alloc(1048576);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 0xff;
  const h = require("crypto").createHash("sha256");
  for (let n = 0; n < Number(process.argv[1]); n++) h.update(b);
  process.stdout.write(h.digest("hex"));' "$1"; }

# ── the probe ───────────────────────────────────────────────────────────────
check "probe: ok, port-forward-v1, 128 connections" "true port-forward-v1 128" \
  "$(curl -s "${auth[@]}" "$CLI/boxes/$BOX/forward" | jq -r '"\(.ok) \(.capability) \(.maxConnections)"')"

# ── basics ──────────────────────────────────────────────────────────────────
fwd_start main box-1 "$HTTP:$L_HTTP" "$WSP:$L_WS" "$HALF:$L_HALF" "$GREET:$L_GREET" "$SINK:$L_SINK" "$LATE:$L_LATE"
check "termag forward listens on every port" 6 "$(grep -c '^Forwarding localhost:' "$WORK/main.out")"
check "on loopback only, both families" yes \
  "$(grep -q "^Forwarding localhost:$L_HTTP to box-1:$HTTP (127.0.0.1:$L_HTTP, \[::1\]:$L_HTTP)$" "$WORK/main.out" && echo yes || echo no)"
check "an HTTP GET through the forward" "hello from the box|200" \
  "$(curl -s -m 20 -w '|%{http_code}' "http://127.0.0.1:$L_HTTP/" | tr -d '\n')"

# A connection held open for the busy check below, which waits for a host sample.
fwd_start held box-1 "$WSP:$L_HELD"
node "$SI" hold "$L_HELD" 330 15 >"$WORK/held.out" 2>&1 &
held_pid=$!
pids+=("$held_pid")

# ── throughput ──────────────────────────────────────────────────────────────
want50=$(blob_sha 50)
curl -s -m 120 -o "$WORK/blob.bin" -w '%{http_code} %{size_download} %{speed_download}' "http://127.0.0.1:$L_HTTP/blob?mb=50" >"$WORK/blob.txt"
read -r status size speed <"$WORK/blob.txt"
check "a 50 MiB download arrives whole" "200 52428800 $want50" "$status $size $(sha_of "$WORK/blob.bin")"
info "$(awk -v s="$speed" 'BEGIN { printf "one download: %.0f MB/s", s / 1e6 }')"
start=$(now_s)
six=()
for i in 1 2 3 4 5 6; do
  curl -s -m 300 -o "$WORK/blob.$i.bin" -w '%{http_code} %{size_download} %{speed_download}' "http://127.0.0.1:$L_HTTP/blob?mb=50" >"$WORK/blob.$i.txt" &
  six+=($!)
done
wait "${six[@]}"
end=$(now_s)
for i in 1 2 3 4 5 6; do
  read -r status size speed <"$WORK/blob.$i.txt"
  check "six at once: download $i arrives whole" "200 52428800 $want50" "$status $size $(sha_of "$WORK/blob.$i.bin")"
  rm -f "$WORK/blob.$i.bin"
done
info "$(awk -v s="$start" -v e="$end" 'BEGIN { printf "six at once: %.0f MB/s together, in %.1f s", 6 * 52428800 / (e - s) / 1e6, e - s }')"

# ── protocols ───────────────────────────────────────────────────────────────
check "a WebSocket echo (text and binary frames)" "text:hello hmr binary:000102ff" "$(node "$SI" ws "$L_WS")"
check "half-close: the box sees EOF, answers, and the laptop sees EOF" "got 17 bytes: half-close please | eof" "$(node "$SI" half "$L_HALF")"
check "a server that speaks first: its greeting arrives before the client writes" \
  "SSH-2.0-e2e-greeting | client speaks second" "$(node "$SI" greet "$L_GREET")"

# ── refusals ────────────────────────────────────────────────────────────────
fwd_start refusals box-1 "22:$L_MISC" "$CLOSED:$L_CLOSED"
# Port 22 refuses only where a listener the agent doesn't own (a root sshd) holds it.
if [ -r /proc/net/tcp ] && awk 'NR > 1 && $4 == "0A" && substr($2, index($2, ":") + 1) == "0016" && $8 != uid { f = 1 } END { exit !f }' uid="$(id -u)" /proc/net/tcp /proc/net/tcp6 2>/dev/null; then
  curl -s -m 20 -o /dev/null "http://127.0.0.1:$L_MISC/"
  check "port 22 (another uid's sshd): port_refused, with the agent's reason" yes \
    "$(grep -q "box-1:22 (localhost:$L_MISC): port_refused: box-1 refused to forward port 22: " "$WORK/refusals.err" && echo yes || echo no)"
else
  echo "skip: port 22 (nothing another uid owns listens on it here)"
fi
curl -s -m 20 -o /dev/null "http://127.0.0.1:$L_CLOSED/"
check "a closed port: port_closed" yes \
  "$(grep -q "box-1:$CLOSED (localhost:$L_CLOSED): port_closed: nothing listens on port $CLOSED on box-1" "$WORK/refusals.err" && echo yes || echo no)"
fwd_stop refusals
check "Ctrl-C exits 0" 0 $?
check "Ctrl-C prints the totals" yes \
  "$(grep -Eq '^Forwarded [0-9]+ connections? \([0-9]+ failed\): .* to box-1, .* from it\.$' "$WORK/refusals.out" && echo yes || echo no)"

upgrade=(-H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $(head -c 16 /dev/urandom | base64)")
refusal() { curl -s -m 20 -w ' %{http_code}' "$@" | jq -Rr 'split(" ") as $p | (($p[:-1] | join(" ")) | fromjson? | .code) + " " + $p[-1]'; }
check "port 080: bad_port" "bad_port 400" "$(refusal "${auth[@]}" "${upgrade[@]}" -H 'Sec-WebSocket-Protocol: termag-forward.v2' "$CLI/boxes/$BOX/forward/080")"
check "port 0: bad_port" "bad_port 400" "$(refusal "${auth[@]}" "${upgrade[@]}" -H 'Sec-WebSocket-Protocol: termag-forward.v2' "$CLI/boxes/$BOX/forward/0")"
check "no termag-forward subprotocol: invalid_request" "invalid_request 400" "$(refusal "${auth[@]}" "${upgrade[@]}" "$CLI/boxes/$BOX/forward/$HTTP")"
check "a GET without an upgrade: upgrade_required" "upgrade_required 426" "$(refusal "${auth[@]}" "$CLI/boxes/$BOX/forward/$HTTP")"

# An old CLI's socket: v1 alone opens and relays until FORWARD_V1_REFUSE_AFTER, and is refused with cli_outdated from then on.
v1_dial() {
  node -e '
    const WebSocket = require("ws");
    const [url, token] = process.argv.slice(1);
    const ws = new WebSocket(url, "termag-forward.v1", { headers: { Authorization: `Bearer ${token}` }, perMessageDeflate: false });
    ws.on("open", () => ws.send(Buffer.from("GET / HTTP/1.0\r\n\r\n"), { binary: true }));
    ws.on("message", (d, binary) => { if (binary && String(d).startsWith("HTTP/1.")) { console.log(`${ws.protocol} ${String(d).split(" ")[1]}`); ws.close(1000); } });
    ws.on("unexpected-response", (_q, res) => { let t = ""; res.on("data", (c) => { t += c; }); res.on("end", () => { console.log(`refused ${res.statusCode} ${JSON.parse(t).code}`); process.exit(0); }); });
    ws.on("close", () => process.exit(0));
    ws.on("error", (e) => { console.log(`error ${e.message}`); process.exit(0); });
    setTimeout(() => process.exit(1), 15000);' "$1" "$JWT"
}
if node -e 'process.exit(Date.now() >= Date.parse("2026-11-19T00:00:00Z") ? 0 : 1)'; then want_v1="refused 426 cli_outdated"; else want_v1="termag-forward.v1 200"; fi
check "an old CLI's v1-only socket: $want_v1" "$want_v1" "$(v1_dial "${CLI/http/ws}/boxes/$BOX/forward/$HTTP")"

BT=$(jq -r .token "$ROOT/boxes/box-1/home/.termag/agent.config.json")
check "a box's own token: the probe is forbidden" "forbidden 403" "$(refusal -H "Authorization: Bearer $BT" "$CLI/boxes/$BOX/forward")"
check "a box's own token: the socket is forbidden" "forbidden 403" \
  "$(refusal -H "Authorization: Bearer $BT" "${upgrade[@]}" -H 'Sec-WebSocket-Protocol: termag-forward.v2' "$CLI/boxes/$BOX/forward/$HTTP")"
HOME="$ROOT/boxes/box-1/home" XDG_CONFIG_HOME='' timeout 30 node "$repo/cli/bin/termag.js" forward box-1 "$HTTP:$L_MISC" >"$WORK/boxtoken.out" 2>&1
check "termag forward on a box's credentials exits 1 and says why" "1 yes" \
  "$? $(grep -q "a box's own credentials can't forward" "$WORK/boxtoken.out" && echo yes || echo no)"

python3 -c 'import socket, time; s = socket.socket(); s.bind(("127.0.0.1", int(__import__("sys").argv[1]))); s.listen(); time.sleep(60)' "$L_MISC" &
holder=$!
pids+=("$holder")
sleep 0.5
start=$(date +%s)
timeout 30 "${TERMAG[@]}" forward box-1 "$HTTP:$L_MISC" >"$WORK/held-port.out" 2>&1
code=$?
took=$(($(date +%s) - start))
kill "$holder" 2>/dev/null
check "a local port already held: exits 1 at once (${took} s), naming the holder" "1 yes yes" \
  "$code $([ "$took" -le 10 ] && echo yes || echo no) $(grep -q "Local port $L_MISC is already in use by python3 (pid $holder" "$WORK/held-port.out" && echo yes || echo no)"

# ── a box stopped mid-forward ───────────────────────────────────────────────
termag box create fwd-stop --wait --timeout 300 >"$WORK/create.out" 2>&1
check "box create fwd-stop (EC2 launch fake)" 0 $?
STOP_BOX=$(termag box list --json | jq -r '.boxes[] | select(.name == "fwd-stop") | .id')
fwd_start stop fwd-stop "$WSP:$L_STOP"
node "$SI" hold "$L_STOP" 120 2 >"$WORK/stop-hold.out" 2>&1 &
stop_hold=$!
opened=no
for _ in $(seq 1 40); do grep -q "\[FORWARD\] open user=[^ ]* box=$STOP_BOX port=$WSP " "$ROOT/logs/backend.log" && { opened=yes; break; }; sleep 0.25; done
check "a connection through the forward to fwd-stop opens" yes "$opened"
sleep 2
termag box stop fwd-stop >/dev/null 2>&1
wait "$stop_hold"
check "the forward closes with 4409" code=4409 \
  "$(grep "\[FORWARD\] close user=[^ ]* box=$STOP_BOX port=$WSP " "$ROOT/logs/backend.log" | grep -o 'code=[0-9]*$' | tr '\n' ' ' | sed 's/ $//')"
check "and the CLI says the box was stopped, keeping its listeners" \
  "termag forward: a connection to fwd-stop:$WSP dropped: fwd-stop was stopped or hibernated; listeners stay up and new connections dial again" \
  "$(cat "$WORK/stop.err")"
fwd_stop stop

# ── slow transfers: six downloads to slow readers, three uploads to a slow service, ──
# and one to a slow service that answers late. They run through the busy wait below, and are checked after it.
slow=()
if [ "${E2E_FORWARD_SLOW:-1}" != 0 ]; then
  want_slow=$(blob_sha "$SLOW_MB")
  # slow-client.py, not curl: its fixed small receive buffer keeps the kernel from soaking up the body on loopback.
  for i in 1 2 3 4 5 6; do
    AUTH=none python3 "$here/slow-client.py" "http://127.0.0.1:$L_HTTP/blob?mb=$SLOW_MB" $((SLOW_KBPS * 1024)) 60 >"$WORK/slow.$i.out" 2>"$WORK/slow.$i.err" &
    slow+=($!)
  done
  for i in 1 2 3; do
    python3 "$here/fakes/slow-sink.py" send "$L_SINK" "$SLOW_MB" >"$WORK/upload.$i.out" 2>&1 &
    slow+=($!)
  done
  # Paused for the slow service when the upload's fin comes, then idle past the stall bound until it answers.
  python3 "$here/fakes/slow-sink.py" send "$L_LATE" "$LATE_MB" >"$WORK/late.out" 2>&1 &
  slow+=($!)
fi

# ── busy: the open forward is in the box's host sample ──────────────────────
since=$(date -u '+%Y-%m-%d %H:%M:%S')
tunnels=""
for _ in $(seq 1 340); do
  tunnels=$("${PSQL[@]}" -c "select \"openTunnels\" from instances where id = '$BOX' and \"hostSampledAt\" >= '$since'")
  [ -n "$tunnels" ] && break
  sleep 1
done
check "a host sample counts the open forward (Instance.openTunnels > 0)" yes "$([ "${tunnels:-0}" -gt 0 ] 2>/dev/null && echo yes || echo no)"
kill "$held_pid" 2>/dev/null
fwd_stop held

# ── slow readers and writers, started before the busy wait above ────────────
if [ "${E2E_FORWARD_SLOW:-1}" != 0 ]; then
  slow_bytes=$((SLOW_MB * 1048576))
  wait "${slow[@]}"
  for i in 1 2 3 4 5 6; do
    read -r status size sha _ how <"$WORK/slow.$i.out" 2>/dev/null
    check "slow reader $i: 200, all $slow_bytes bytes, in order, the answer ended" "200 $slow_bytes ended $want_slow" \
      "${status:-} ${size:-} ${how:-} ${sha:-}$(tail -1 "$WORK/slow.$i.err" 2>/dev/null)"
  done
  for i in 1 2 3; do
    check "slow writer $i: the box's service got all $slow_bytes bytes, in order, and answered" "sent done" "$(cat "$WORK/upload.$i.out")"
  done
  check "the service saw each upload end, whole" "3 $slow_bytes eof $want_slow" \
    "$(sort "$WORK/sink.log" | uniq -c | awk '{ print $1, $2, $3, $4 }')"
  check "a service that took the whole upload and answered ${LATE_S} s later got its answer through" \
    "$((LATE_MB * 1048576)) eof $(blob_sha "$LATE_MB") | sent done" "$(cat "$WORK/late.log") | $(cat "$WORK/late.out")"
  check "the agent gave up no tunnel" 0 "$(grep -c 'tunnel gave up' "$ROOT/logs/box-1.log")"
fi

# ── past the access token's exp (opt-in; see the header) ────────────────────
if [ -n "${E2E_FORWARD_EXP:-}" ]; then
  # The token's hour is fixed (CLI_ACCESS_TOKEN_TTL_S), and the CLI may mint a fresh one for this connection;
  # past it, only the renewed tokens it sends in band keep the connection open (v2).
  fwd_start exp box-1 "$WSP:$L_HELD"
  secs=3780
  info "holding a connection ${secs} s, past any access token's exp"
  check "a connection held past its token's exp keeps relaying" yes \
    "$(node "$SI" hold "$L_HELD" "$secs" 30 | grep -q '^held [0-9]* echoes$' && echo yes || echo no)"
  check "and no forward closed for want of a renewed token (4402)" 0 "$(grep -c '\[FORWARD\] close .* code=4402$' "$ROOT/logs/backend.log")"
  fwd_stop exp
fi

# ── logs ────────────────────────────────────────────────────────────────────
check "the backend logged opens with their subprotocol (the CLI's is v2) and setup time" yes \
  "$(grep -Eq "\[FORWARD\] open user=[^ ]+ box=$BOX port=$HTTP protocol=v2 setupMs=[0-9]+$" "$ROOT/logs/backend.log" && echo yes || echo no)"
check "and normal closes with byte counts" yes \
  "$(grep -Eq "\[FORWARD\] close user=[^ ]+ box=$BOX port=$HTTP bytesIn=[0-9]+ bytesOut=52428[0-9]{3} durationMs=[0-9]+ code=1000$" "$ROOT/logs/backend.log" && echo yes || echo no)"
check "and refusals with their code" yes \
  "$(grep -Eq "\[FORWARD\] refused user=[^ ]+ box=$BOX port=$CLOSED status=502 code=port_closed$" "$ROOT/logs/backend.log" && echo yes || echo no)"

# ── the flag off: the CLI points at ssh instead ─────────────────────────────
# A connection still open through the restart: its close is logged, though the process exits before the handshake ends.
opens=$(grep -c "\[FORWARD\] open user=[^ ]* box=$BOX port=$WSP " "$ROOT/logs/backend.log")
node "$SI" hold "$L_WS" 60 2 >"$WORK/restart-hold.out" 2>&1 &
pids+=($!)
for _ in $(seq 1 40); do [ "$(grep -c "\[FORWARD\] open user=[^ ]* box=$BOX port=$WSP " "$ROOT/logs/backend.log")" -gt "$opens" ] && break; sleep 0.25; done
# Through a temp file, then cat over the original so it keeps its mode: BSD sed -i takes the expression as a backup suffix.
sed 's/^TERMAG_FLAGS=.*/TERMAG_FLAGS='"'"'{"box-port-forward-enabled":false}'"'"'/' "$ROOT/backend.env" >"$WORK/backend.env" \
  && cat "$WORK/backend.env" >"$ROOT/backend.env"
bash "$here/ctl.sh" restart backend >/dev/null 2>&1
check "a restart logs the close of the forward it ends (1001)" yes \
  "$(grep -Eq "\[FORWARD\] close user=[^ ]+ box=$BOX port=$WSP .* code=1001$" "$ROOT/logs/backend.log" && echo yes || echo no)"
fwd_stop main
check "Ctrl-C on the main forward exits 0" 0 $?
# The restart retired the CLI's cached access token (the stack's key is in the backend's
# memory, localCliJwtKey); the CLI refreshes it on the 401, so nothing here helps it.
creds="$LAPTOP/.config/termag/credentials.json"
for _ in $(seq 1 120); do termag box list >/dev/null 2>&1 && break; sleep 0.5; done
auth=(-H "Authorization: Bearer $(jq -r '.hosts[].accessToken' "$creds")")
check "flag off: the probe is not_found" "not_found 404" "$(refusal "${auth[@]}" "$CLI/boxes/$BOX/forward")"
start=$(date +%s)
timeout 30 "${TERMAG[@]}" forward box-1 "$HTTP:$L_MISC" >"$WORK/flag-off.out" 2>&1
code=$?
took=$(($(date +%s) - start))
check "flag off: termag forward exits 1 at once (${took} s)" "1 yes" "$code $([ "$took" -le 10 ] && echo yes || echo no)"
check "flag off: and prints the ssh fallback" yes \
  "$(grep -qF "\`termag ssh box-1 -N -L $L_MISC:localhost:$HTTP\` forwards the same ports over SSM" "$WORK/flag-off.out" && echo yes || echo no)"

echo
if [ "$failures" -eq 0 ]; then echo "all forward checks passed"; else echo "$failures forward check(s) failed"; fi
[ "$failures" -eq 0 ]
