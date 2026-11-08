#!/bin/sh
# Static checks on the orchestrator's nginx check routes (deploy/nginx/termag-checks.conf):
# :3041 serves the four gateway checks and a health check, nothing else, and
# the plain :3040 gateway keeps refusing /termag/internal/. Then the preview
# links' server block and markers (termag-gateway.conf, termag-proxy.conf),
# statically and, where nginx is installed, running. The e2e harness
# runs both configs for real (scripts/e2e/fakes.test.sh with E2E_TEST_CLAUDE_GATEWAY).
#
# Run: sh deploy/termag-checks.test.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
CHECKS="$here/nginx/termag-checks.conf"
GATEWAY="$here/nginx/termag-gateway.conf"
SETUP="$here/../packer/scripts/orchestrator-setup.sh"
failed=0
fail() { printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3"; failed=1; }

code() { sed 's/#.*//' "$1"; }

got="$(code "$CHECKS" | grep -E '^\s*listen' | tr -s ' ' | sed 's/^ //')"
[ "$got" = 'listen 3041;' ] || fail 'the checks listener is :3041, plain HTTP behind the ALB' 'listen 3041;' "$got"

got="$(code "$CHECKS" | grep -E '^\s*location' | tr -s ' ' | sed 's/^ //' | tr '\n' '|')"
want='location = /healthz {|location /termag/internal/claude-authz/ {|location /termag/internal/github-authz/ {|location /termag/internal/mcp-authz/ {|location /termag/internal/fireworks-authz/ {|location / {|'
[ "$got" = "$want" ] || fail 'it serves the four checks and a health check only' "$want" "$got"

got="$(code "$CHECKS" | grep -c 'proxy_pass http://127.0.0.1:3100;')"
[ "$got" = 4 ] || fail 'only the four checks reach the backend' 4 "$got"

got="$(code "$CHECKS" | sed -n '/location \/ {/,/}/p' | grep -c 'return 404;')"
[ "$got" = 1 ] || fail 'everything else is a 404' 1 "$got"

if code "$CHECKS" | grep -qE 'ssl|X-Termag-Agent-Tls'; then
  fail 'no TLS or header trust on the listener' 'none' "$(code "$CHECKS" | grep -E 'ssl|X-Termag-Agent-Tls' | head -1)"
fi

got="$(code "$GATEWAY" | sed -n '/location \^~ \/termag\/internal\/ {/,/}/p' | grep -c 'return 404;')"
[ "$got" = 1 ] || fail ':3040 answers /termag/internal/ with 404 on the main host' 1 "$got"

# The preview-host markers:
# the shared snippet clears both on every upstream, and only the preview
# server block re-sets them, after the include, since nginx sends only the
# non-empty one of two values for a name. Its server_name is a snippet the
# boot script renders, so the preview domain never appears in the tree.
PROXY="$here/nginx/termag-proxy.conf"
got="$(code "$PROXY" | grep -cE 'proxy_set_header X-Termag-Preview-(Host|Name) "";')"
[ "$got" = 2 ] || fail 'termag-proxy.conf clears X-Termag-Preview-Host and -Name' 2 "$got"
preview="$(code "$GATEWAY" | sed -n '/server_name termag-preview.invalid;/,/^}/p')"
got="$(printf '%s\n' "$preview" | grep -E 'include /etc/nginx/snippets/termag-proxy.conf;|proxy_set_header X-Termag-Preview-(Host|Name) ' | tr -s ' ' | sed 's/^ //' | tr '\n' '|')"
# shellcheck disable=SC2016  # the nginx variable is literal text here
want='include /etc/nginx/snippets/termag-proxy.conf;|proxy_set_header X-Termag-Preview-Host 1;|proxy_set_header X-Termag-Preview-Name $termag_preview_name;|'
[ "$got" = "$want" ] || fail 'the preview block sets the markers after the snippet' "$want" "$got"
got="$(code "$GATEWAY" | grep -c 'X-Termag-Preview-Host 1')"
[ "$got" = 1 ] || fail 'nothing but the preview block sets the marker' 1 "$got"
got="$(printf '%s\n' "$preview" | grep -c 'include /etc/nginx/snippets/termag-preview-server-name\*.conf;')"
[ "$got" = 1 ] || fail 'the preview block takes its server_name from the rendered snippet' 1 "$got"
got="$(printf '%s\n' "$preview" | grep -cE '^\s*location ')"
[ "$got" = 1 ] || fail 'no location is special on a preview host (SR3)' 1 "$got"
if code "$GATEWAY" | grep -q 'server_name ~^preview'; then
  fail 'the bare preview.<zone> block from #166 is gone' 'absent' 'present'
fi

# The same rules with nginx running, when it is installed: a preview host
# with a /termag/api/ path reaches the backend with the marker and the name
# set; the main host's forged marker arrives empty; a host the snippet
# doesn't match is the main host's.
command -v nginx >/dev/null 2>&1 || { [ -x /usr/sbin/nginx ] && PATH="$PATH:/usr/sbin"; } || true
if [ -x "$here/../backend/node_modules/.bin/tsx" ]; then tsx="$here/../backend/node_modules/.bin/tsx"; else tsx=$(command -v tsx || true); fi
if command -v nginx >/dev/null 2>&1 && command -v curl >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1 && [ -n "$tsx" ]; then
  W=$(mktemp -d)
  npid=
  epid=
  cleanup() { [ -n "$npid" ] && kill "$npid" 2>/dev/null; [ -n "$epid" ] && kill "$epid" 2>/dev/null; rm -rf "$W"; }
  trap cleanup EXIT
  free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
  port=$(free_port)
  echo_port=$(free_port)
  # An upstream that answers with the path and headers it got.
  cat >"$W/echo.py" <<'PY'
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a):
        pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
  python3 "$W/echo.py" "$echo_port" &
  epid=$!
  mkdir -p "$W/logs" "$W/tmp" "$W/snippets"
  cp "$here/nginx/termag-proxy.conf" "$W/snippets/termag-proxy.conf"
  # The boot script itself (deploy/termag-preview-nginx.conf runs it before
  # nginx starts), for PREVIEW_LINKS_DOMAIN=previews.test.
  PREVIEW_LINKS_DOMAIN=previews.test TERMAG_PREVIEW_SNIPPET="$W/snippets/termag-preview-server-name.conf" TERMAG_NGINX_TEST='' \
    "$tsx" "$here/../backend/src/scripts/previewNginxSnippet.ts" 2>/dev/null ||
    fail 'the boot script renders the preview server_name' 'exit 0' "exit $?"
  sed -e "s#listen 3040 default_server#listen 127.0.0.1:$port default_server#" \
      -e "s#listen 3040;#listen 127.0.0.1:$port;#" \
      -e "s#/etc/nginx/snippets/#$W/snippets/#" \
      -e "s#include /srv/termag/apps/\*/nginx.conf;##" \
      -e "s#127.0.0.1:3100#127.0.0.1:$echo_port#" \
      -e "s#/var/log/nginx/#$W/logs/#" \
      "$GATEWAY" >"$W/gateway.conf"
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
  if nginx -p "$W" -c "$W/nginx.conf" -e "$W/logs/error.log" -t >"$W/t.out" 2>&1; then
    nginx -p "$W" -c "$W/nginx.conf" -e "$W/logs/error.log" &
    npid=$!
    for _ in $(seq 1 50); do curl -sf -o /dev/null "http://127.0.0.1:$port/termag/" && break; sleep 0.1; done
    ask() { curl -s -H "Host: $1" -H 'X-Termag-Preview-Host: forged' -H 'X-Termag-Preview-Name: forged' "http://127.0.0.1:$port$2"; }
    field() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["headers"].get(sys.argv[1], "<absent>"))' "$1"; }
    got="$(ask my-app.previews.test /termag/api/projects | field x-termag-preview-host)"
    [ "$got" = 1 ] || fail 'a preview host reaches the backend with the marker set' 1 "$got"
    got="$(ask my-app.previews.test /termag/api/projects | field x-termag-preview-name)"
    [ "$got" = my-app ] || fail 'the name nginx captured goes with it' my-app "$got"
    got="$(ask my-app.previews.test /termag/api/projects | python3 -c 'import json,sys; print(json.load(sys.stdin)["path"])')"
    [ "$got" = /termag/api/projects ] || fail 'a preview path under /termag/ is sent on as is' /termag/api/projects "$got"
    # A link's own host, <name>--<suffix> (SR19): the whole label goes to the backend, which parses it.
    got="$(ask my-app--abcdef.previews.test /termag/api/projects | field x-termag-preview-name)"
    [ "$got" = my-app--abcdef ] || fail "a link's own host sends its whole label" my-app--abcdef "$got"
    long=abcdefghijabcdefghijabcdefghijabcdefghij
    got="$(ask "$long--abcdef.previews.test" /termag/api/projects | field x-termag-preview-name)"
    [ "$got" = "$long--abcdef" ] || fail 'the longest label, a 40-character name and a 6-character suffix (48), is a preview host' "$long--abcdef" "$got"
    got="$(ask "$long--abcdefg.previews.test" /termag/api/projects | field x-termag-preview-host)"
    [ "$got" = '<absent>' ] || fail 'a label past the grammar is never a preview host' '<absent>' "$got"
    got="$(ask app.termag.test /termag/api/projects | field x-termag-preview-host)"
    [ "$got" = '<absent>' ] || fail 'the main host clears a forged marker' '<absent>' "$got"
    got="$(ask app.termag.test /termag/api/projects | field x-termag-preview-name)"
    [ "$got" = '<absent>' ] || fail 'the main host clears a forged name' '<absent>' "$got"
    got="$(ask a.b.previews.test /termag/api/projects | field x-termag-preview-host)"
    [ "$got" = '<absent>' ] || fail 'a host that is not one label under the domain is the main host' '<absent>' "$got"
    got="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: my-app.previews.test' "http://127.0.0.1:$port/termag/internal/github-authz/x")"
    [ "$got" = 200 ] || fail 'a preview host has no special locations: even /termag/internal/ goes to the dispatch' 200 "$got"
  else
    cat "$W/t.out"
    fail 'the gateway config loads' 'nginx -t ok' 'failed'
  fi
else
  echo 'SKIP: the running-nginx cases need nginx, curl, python3 and tsx (the backend'"'"'s node_modules)'
fi

# The box confirmation's id (preview links, SR11) is the key to its sealed
# share URL: both paths it travels in are logged through termag_redacted's
# map, and their error log, which quotes the request line, is crit only.
for path in '/termag/previews/confirm/' '/termag/api/cli/v1/preview-links/confirmations/'; do
  esc=$(printf '%s' "$path" | sed 's#/#\\/#g')
  # The raw file: the rule's regex holds a #, which code() would read as a comment.
  # shellcheck disable=SC2016 # the map's own $1 and $2, literally
  got="$(grep -F "\"~^($path)[^/?#]+(.*)\$\"" "$GATEWAY" | grep -cF '"$1<redacted>$2";' || true)"
  [ "$got" = 1 ] || fail "the log map redacts the id in $path" 1 "$got"
  got="$(code "$GATEWAY" | sed -n "/location ^~ $esc {/,/}/p" | grep -c 'error_log /var/log/nginx/error.log crit;')"
  [ "$got" = 1 ] || fail "$path logs only crit errors" 1 "$got"
done
got="$(code "$GATEWAY" | sed -n '/listen 3040 default_server/,/^}/p' | grep -c 'access_log /var/log/nginx/access.log termag_redacted;')"
[ "$got" = 1 ] || fail 'the main host logs through termag_redacted' 1 "$got"
# Every server block, the preview host's included (a /__termag/auth code, an
# app's query string), logs through termag_redacted at its own level: a block
# without one falls back to the default format, which writes $request_uri as is.
# Counted by brace depth, so a location's own access_log doesn't count.
blocks="$(code "$GATEWAY" | awk '
  /^server[ \t]*\{/ { in_s = 1; depth = 0; n++; ok[n] = 0 }
  in_s {
    if (depth == 1 && $0 ~ /^[ \t]*access_log \/var\/log\/nginx\/access\.log termag_redacted;/) ok[n] = 1
    o = gsub(/\{/, "{"); c = gsub(/\}/, "}"); depth += o - c
    if (depth == 0) in_s = 0
  }
  END { for (i = 1; i <= n; i++) printf "%d", ok[i]; print "" }')"
case "$blocks" in
  ''|*0*) fail 'every server block in termag-gateway.conf logs through termag_redacted' 'all 1' "${blocks:-no server blocks}" ;;
esac
[ "${#blocks}" -ge 2 ] || fail 'the check sees both :3040 server blocks' '>= 2' "${#blocks}"
got="$(printf '%s\n' "$preview" | grep -c 'error_log /var/log/nginx/error.log crit;')"
[ "$got" = 1 ] || fail 'the preview host logs only crit errors (its request line carries a code or an app query)' 1 "$got"

inst=$(grep -n 'termag-checks.conf /etc/nginx/sites-enabled/termag-checks.conf' "$SETUP" | cut -d: -f1)
test_line=$(grep -n '^sudo nginx -t' "$SETUP" | cut -d: -f1)
[ -n "$inst" ] && [ -n "$test_line" ] && [ "$inst" -lt "$test_line" ] ||
  fail 'the bake enables the checks listener before nginx -t' "enabled before line $test_line" "${inst:-not enabled}"

# The preview server_name is rendered before every nginx start, by a drop-in
# the bake installs, and a failed render never stops nginx (the leading -).
DROPIN="$here/termag-preview-nginx.conf"
got="$(code "$DROPIN" | grep -E '^ExecStartPre=' || true)"
want='ExecStartPre=-/usr/bin/node /usr/local/lib/termag/preview-nginx/scripts/previewNginxSnippet.js'
[ "$got" = "$want" ] || fail 'the nginx drop-in runs the root-owned copy of the preview snippet script, tolerating failure' "$want" "$got"
[ -f "$here/../backend/src/scripts/previewNginxSnippet.ts" ] || fail 'the script the drop-in runs exists' 'present' 'absent'
got="$(grep -c '^sudo install -m 644 /opt/termag/deploy/termag-preview-nginx.conf /etc/systemd/system/nginx.service.d/termag-preview.conf$' "$SETUP" || true)"
[ "$got" = 1 ] || fail 'the bake installs the nginx drop-in' 1 "$got"
# Root runs it: the bake copies both compiled files root-owned, out of the
# termag-owned /opt/termag (the script's own imports test pins that it needs no others).
for f in scripts/previewNginxSnippet.js services/previewHostGrammar.js; do
  got="$(grep -c "^sudo install -m 0644 -o root -g root /opt/termag/backend/dist/$f /usr/local/lib/termag/preview-nginx/$f\$" "$SETUP" || true)"
  [ "$got" = 1 ] || fail "the bake installs $f root-owned for the drop-in" 1 "$got"
done

if [ "$failed" = 0 ]; then
  echo 'PASS: termag-checks listener serves the gateway checks only'
else
  exit 1
fi
