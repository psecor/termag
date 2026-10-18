#!/bin/sh
# The orchestrator's nginx gateway (deploy/nginx/termag-gateway.conf) never
# writes a box agent's token to its logs: not from an old agent that sends it
# as /termag/ws/agent?token=, and not from a new one that sends Authorization.
# Runs the real config under a temp prefix with no backend behind it, so every
# request is a 502 and the upstream failure lands in the error log too.
# Skips when nginx is not installed.
#
# Run: sh deploy/termag-gateway-logs.test.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
command -v nginx >/dev/null 2>&1 || { [ -x /usr/sbin/nginx ] && PATH="$PATH:/usr/sbin"; } || true
if ! command -v nginx >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  echo 'SKIP: termag-gateway-logs needs nginx and curl'
  exit 0
fi

W=$(mktemp -d)
pid=
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; rm -rf "$W"; }
trap cleanup EXIT
failed=0
fail() { printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3"; failed=1; }

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
port=$(free_port)
dead=$(free_port)

mkdir -p "$W/logs" "$W/tmp"
cp "$here/nginx/termag-proxy.conf" "$W/termag-proxy.conf"
sed -e "s#listen 3040 default_server#listen 127.0.0.1:$port default_server#" \
    -e "s#listen 3040;#listen 127.0.0.1:$port;#" \
    -e "s#/etc/nginx/snippets/termag-proxy.conf#$W/termag-proxy.conf#" \
    -e "s#include /srv/termag/apps/\*/nginx.conf;##" \
    -e "s#127.0.0.1:3100#127.0.0.1:$dead#" \
    -e "s#/var/log/nginx/#$W/logs/#" \
    "$here/nginx/termag-gateway.conf" >"$W/gateway.conf"
if grep -nE '^[^#]*listen 3040' "$W/gateway.conf"; then
  fail 'every :3040 listener is rewritten to the test port' 'none left' "$(grep -E '^[^#]*listen 3040' "$W/gateway.conf" | head -1)"; exit 1
fi
cat >"$W/nginx.conf" <<EOF
daemon off;
worker_processes 1;
pid $W/nginx.pid;
error_log $W/logs/error.log;
events {}
http {
    access_log $W/logs/access.log;
    client_body_temp_path $W/tmp/body;
    proxy_temp_path $W/tmp/proxy;
    fastcgi_temp_path $W/tmp/fastcgi;
    uwsgi_temp_path $W/tmp/uwsgi;
    scgi_temp_path $W/tmp/scgi;
    include $W/gateway.conf;
}
EOF
nginx -p "$W" -c "$W/nginx.conf" -e "$W/logs/error.log" -t >"$W/t.out" 2>&1 || { cat "$W/t.out"; fail 'the gateway config loads' 'nginx -t ok' 'failed'; exit 1; }
nginx -p "$W" -c "$W/nginx.conf" -e "$W/logs/error.log" &
pid=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.1; done

QUERY_TOKEN=tmag_""queryFormSecret0123456789
HEADER_TOKEN=tmag_""headerFormSecret0123456789
upgrade='-H Connection:Upgrade -H Upgrade:websocket -H Sec-WebSocket-Version:13 -H Sec-WebSocket-Key:dGhlIHNhbXBsZSBub25jZQ==' # gitleaks:allow
# shellcheck disable=SC2086
curl -s -o /dev/null $upgrade "http://127.0.0.1:$port/termag/ws/agent?token=$QUERY_TOKEN"
# shellcheck disable=SC2086
curl -s -o /dev/null $upgrade -H "Authorization: Bearer $HEADER_TOKEN" "http://127.0.0.1:$port/termag/ws/agent"
curl -s -o /dev/null "http://127.0.0.1:$port/termag/api/projects?probe=1"
kill "$pid"; wait "$pid" 2>/dev/null || true; pid=

for t in "$QUERY_TOKEN" "$HEADER_TOKEN"; do
  if grep -rq "$t" "$W/logs"; then fail "no log holds $t" absent "$(grep -rh "$t" "$W/logs" | head -1)"; fi
done

got=$(grep -c '"GET /termag/ws/agent HTTP/1.1" 502 .* token=query$' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail 'the old agent is logged by path, with token=query' 1 "$got"
got=$(grep -c '"GET /termag/ws/agent HTTP/1.1" 502 .* token=header$' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail 'the new agent is logged by path, with token=header' 1 "$got"
got=$(grep -c '"GET /termag/api/projects?probe=1 HTTP/1.1"' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail 'other locations keep the default format, query string included' 1 "$got"
got=$(grep -c 'ws/agent' "$W/logs/error.log" || true)
[ "$got" = 0 ] || fail 'the agent location writes no upstream errors' 0 "$got"
got=$(grep -c 'connect() failed.*/termag/api/projects' "$W/logs/error.log" || true)
[ "$got" = 1 ] || fail 'the same upstream error still shows for /termag' 1 "$got"

if [ "$failed" = 0 ]; then
  echo 'PASS: the nginx gateway logs no agent token, in either form'
else
  echo '--- access.log'; cat "$W/logs/access.log"; echo '--- error.log'; cat "$W/logs/error.log"
  exit 1
fi
