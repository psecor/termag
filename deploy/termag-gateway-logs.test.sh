#!/bin/sh
# The orchestrator's nginx gateway (deploy/nginx/termag-gateway.conf) never
# writes a box agent's token to its logs: not from an old agent that sends it
# as /termag/ws/agent?token=, and not from a new one that sends Authorization.
# Nor a box confirmation's id (SR11):
# /termag/previews/confirm/<id> and the CLI's
# /termag/api/cli/v1/preview-links/confirmations/<id>, each logged as <redacted>.
# Nor a preview link's own secrets (SR11,
# SR21): the token in /termag/previews/<name>/<token>, a reverify ?ticket=,
# the whole query of any landing URL (a next= carries the app's own URL), and
# a preview host's /__termag/auth?code=, each logged as <redacted>.
# Runs the real config under a temp prefix with no backend behind it, so every
# request is a 502 and the upstream failure lands in the error log too.
# Skips when nginx is not installed.
#
# Run: sh deploy/termag-gateway-logs.test.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
command -v nginx >/dev/null 2>&1 || { [ -x /usr/sbin/nginx ] && PATH="$PATH:/usr/sbin"; } || true
if [ -x "$here/../backend/node_modules/.bin/tsx" ]; then tsx="$here/../backend/node_modules/.bin/tsx"; else tsx=$(command -v tsx || true); fi
if ! command -v nginx >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || [ -z "$tsx" ]; then
  echo 'SKIP: termag-gateway-logs needs nginx, curl and tsx (the backend'"'"'s node_modules)'
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
# The boot script itself (deploy/termag-preview-nginx.conf runs it before
# nginx starts), for PREVIEW_LINKS_DOMAIN=previews.test.
PREVIEW_LINKS_DOMAIN=previews.test TERMAG_PREVIEW_SNIPPET="$W/termag-preview-server-name.conf" TERMAG_NGINX_TEST='' \
  "$tsx" "$here/../backend/src/scripts/previewNginxSnippet.ts" 2>/dev/null ||
  { fail 'the boot script renders the preview server_name' 'exit 0' "exit $?"; exit 1; }
sed -e "s#listen 3040 default_server#listen 127.0.0.1:$port default_server#" \
    -e "s#listen 3040;#listen 127.0.0.1:$port;#" \
    -e "s#/etc/nginx/snippets/termag-proxy.conf#$W/termag-proxy.conf#" \
    -e "s#/etc/nginx/snippets/termag-preview-server-name#$W/termag-preview-server-name#" \
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
CONFIRM_ID=Cnf""SecretConfirmId0123456789abcdefghijklmnopq
POLL_ID=Pol""SecretConfirmId0123456789abcdefghijklmnopq
curl -s -o /dev/null "http://127.0.0.1:$port/termag/previews/confirm/$CONFIRM_ID"
curl -s -o /dev/null -X POST -d 'decision=publish&csrf=x' "http://127.0.0.1:$port/termag/previews/confirm/$CONFIRM_ID"
curl -s -o /dev/null "http://127.0.0.1:$port/termag/api/cli/v1/preview-links/confirmations/$POLL_ID?probe=1"
# The preview host's server block logs through termag_redacted too: a PUT of a
# confirmation path, redacted by the shared map, can only come from that block.
PREVIEW_ID=Prv""SecretConfirmId0123456789abcdefghijklmnopq
curl -s -o /dev/null -X PUT -H 'Host: my-app.previews.test' "http://127.0.0.1:$port/termag/previews/confirm/$PREVIEW_ID"
LINK_TOKEN=Lnk""Tok3nSecretAbcdefgh
TICKET=Tkt""SecretTicketValue0123456789abcdefghijklmn
CODE=Cde""SecretCodeValue0123456789abcdefghijklmnopq
curl -s -o /dev/null "http://127.0.0.1:$port/termag/previews/my-app/$LINK_TOKEN?next=/deep"
curl -s -o /dev/null "http://127.0.0.1:$port/termag/previews/my-app/reverify?ticket=$TICKET"
# A signed-out viewer sent back with the app's URL in next=, percent-encoded past the collector's name rules (Cursor Security).
APP_SECRET=App""OauthCodeValue0123456789abcdefghij
curl -s -o /dev/null "http://127.0.0.1:$port/termag/previews/my-app?next=%2Fcallback%3Fcode%3D$APP_SECRET"
curl -s -o /dev/null "http://127.0.0.1:$port/termag/previews/my-app/$LINK_TOKEN/x?next=%2Fcb%3Ftoken%3D$APP_SECRET"
curl -s -o /dev/null "http://127.0.0.1:$port/termag/previews/my-app/reverify?next=/x&ticket=$TICKET&z=1"
curl -s -o /dev/null -H 'Host: my-app.previews.test' "http://127.0.0.1:$port/__termag/auth?code=$CODE&next=%2F"
# Repeated parameters: the backend reads the first, so neither may survive.
curl -s -o /dev/null -H 'Host: my-app.previews.test' "http://127.0.0.1:$port/__termag/auth?code=$CODE&code=other"
curl -s -o /dev/null "http://127.0.0.1:$port/termag/previews/my-app/reverify?ticket=$TICKET&ticket=other"
# A Referer that carries a link token (Cursor Security, #1107): never logged as is.
# The token is a separate one: an upstream error line quotes the Referer, which the collector masks (termag-otelcol.test.sh).
REF_TOKEN=Ref""Tok3nSecretAbcdefgh
REF_CODE=Rfc""SecretCodeValue0123456789abcdefghijklmnopq
curl -s -o /dev/null -H "Referer: https://app.termag.test/termag/previews/my-app/$REF_TOKEN?next=/x" "http://127.0.0.1:$port/termag/api/status?ref=1"
curl -s -o /dev/null -H "Referer: https://my-app.previews.test/__termag/auth?code=$REF_CODE" -H 'Host: my-app.previews.test' "http://127.0.0.1:$port/app.js"
kill "$pid"; wait "$pid" 2>/dev/null || true; pid=

for t in "$QUERY_TOKEN" "$HEADER_TOKEN" "$CONFIRM_ID" "$POLL_ID" "$PREVIEW_ID" "$LINK_TOKEN" "$TICKET" "$CODE" "$APP_SECRET"; do
  if grep -rq "$t" "$W/logs"; then fail "no log holds $t" absent "$(grep -rh "$t" "$W/logs" | head -1)"; fi
done

got=$(grep -c '"GET /termag/ws/agent HTTP/1.1" 502 .* token=query$' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail 'the old agent is logged by path, with token=query' 1 "$got"
got=$(grep -c '"GET /termag/ws/agent HTTP/1.1" 502 .* token=header$' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail 'the new agent is logged by path, with token=header' 1 "$got"
got=$(grep -c '"GET /termag/previews/confirm/<redacted> HTTP/1.1" 502' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail "the confirm page's id is logged as <redacted>" 1 "$got"
got=$(grep -c '"POST /termag/previews/confirm/<redacted> HTTP/1.1" 502' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail "the confirm form's POST logs the id as <redacted>" 1 "$got"
got=$(grep -c '"GET /termag/api/cli/v1/preview-links/confirmations/<redacted>?probe=1 HTTP/1.1" 502' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail "the CLI's poll logs the id as <redacted>, its query kept" 1 "$got"
got=$(grep -c '"PUT /termag/previews/confirm/<redacted> HTTP/1.1" 502' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail "the preview host's server block logs through termag_redacted" 1 "$got"
got=$(grep -c 'server: termag-preview.invalid' "$W/logs/error.log" || true)
[ "$got" = 0 ] || fail 'the preview host writes no upstream errors (they quote the request line)' 0 "$got"
got=$(grep -c 'connect() failed.*\(previews/confirm\|preview-links/confirmations\)' "$W/logs/error.log" || true)
[ "$got" = 0 ] || fail 'the two confirmation locations write no upstream errors (they quote the request line)' 0 "$got"
got=$(grep -c '"GET /termag/previews/my-app/<redacted>?<redacted> HTTP/1.1" 502' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail "a link token in the landing path is logged as <redacted>, and its query too" 1 "$got"
got=$(grep -c '"GET /termag/previews/my-app/<redacted>/x?<redacted> HTTP/1.1" 502' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail "a link token's path after it is kept, its query <redacted>" 1 "$got"
got=$(grep -c '"GET /termag/previews/my-app?<redacted> HTTP/1.1" 502' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail "the landing page's next= (an app URL, encoded) is logged as <redacted>" 1 "$got"
got=$(grep -c '"GET /termag/previews/my-app/reverify?<redacted> HTTP/1.1"' "$W/logs/access.log" || true)
[ "$got" = 3 ] || fail "a reverify's whole query (its ticket, once, among others or repeated) is logged as <redacted>" 3 "$got"
got=$(grep -c '"GET /__termag/auth?<redacted> HTTP/1.1"' "$W/logs/access.log" || true)
[ "$got" = 2 ] || fail "a preview host's /__termag/auth query (its code, once or repeated) is logged as <redacted>" 2 "$got"
for t in "$REF_TOKEN" "$REF_CODE"; do
  if grep -q "$t" "$W/logs/access.log"; then fail "the access log holds no Referer secret $t" absent "$(grep -h "$t" "$W/logs/access.log" | head -1)"; fi
done
got=$(grep -c '"GET /termag/api/projects?probe=1 HTTP/1.1" 502 [0-9]* "-"' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail 'no Referer is logged as "-", as the default format does' 1 "$got"
got=$(grep -c '"GET /termag/api/status?ref=1 HTTP/1.1" 502 [0-9]* "https://app.termag.test/termag/previews/<redacted>"' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail 'a Referer carrying a link token is logged with everything after the preview path <redacted>' 1 "$got"
got=$(grep -c '"GET /app.js HTTP/1.1" 502 [0-9]* "https://my-app.previews.test/__termag/<redacted>"' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail "a Referer carrying a preview host's code is logged <redacted>" 1 "$got"
got=$(grep -c 'connect() failed.*request: "[A-Z]* /termag/previews/' "$W/logs/error.log" || true)
[ "$got" = 0 ] || fail 'the preview landing location writes no upstream errors (they quote the request line)' 0 "$got"
got=$(grep -c '"GET /termag/api/projects?probe=1 HTTP/1.1"' "$W/logs/access.log" || true)
[ "$got" = 1 ] || fail 'other locations keep the default format, query string included' 1 "$got"
got=$(grep -c 'ws/agent' "$W/logs/error.log" || true)
[ "$got" = 0 ] || fail 'the agent location writes no upstream errors' 0 "$got"
got=$(grep -c 'connect() failed.*/termag/api/projects' "$W/logs/error.log" || true)
[ "$got" = 1 ] || fail 'the same upstream error still shows for /termag' 1 "$got"

if [ "$failed" = 0 ]; then
  echo 'PASS: the nginx gateway logs no agent token, in either form, no box confirmation id, and no preview link token, ticket or code'
else
  echo '--- access.log'; cat "$W/logs/access.log"; echo '--- error.log'; cat "$W/logs/error.log"
  exit 1
fi
