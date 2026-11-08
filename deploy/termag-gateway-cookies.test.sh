#!/bin/sh
# The orchestrator's nginx gateway (deploy/nginx/termag-gateway.conf) sends
# termag's session cookie, `__Host-termag.sid` on Path=/, only to termag's own
# /termag paths: a hosted app gets every other cookie, without that one. Runs
# the real config under a temp prefix, with termag and one hosted app both
# pointed at an upstream that answers with the Cookie header it got.
# Skips when nginx, curl or python3 is not installed.
#
# Run: sh deploy/termag-gateway-cookies.test.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
command -v nginx >/dev/null 2>&1 || { [ -x /usr/sbin/nginx ] && PATH="$PATH:/usr/sbin"; } || true
for tool in nginx curl python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "SKIP: termag-gateway-cookies needs nginx, curl and python3"; exit 0; }
done

W=$(mktemp -d)
pid=
echo_pid=
cleanup() { [ -n "$pid" ] && kill "$pid" 2>/dev/null; [ -n "$echo_pid" ] && kill "$echo_pid" 2>/dev/null; rm -rf "$W"; }
trap cleanup EXIT
failed=0
fail() { printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3"; failed=1; }

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
port=$(free_port)
upstream=$(free_port)

cat >"$W/echo.py" <<'EOF'
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = ('cookie=' + (self.headers.get('Cookie') or '<none>')).encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
EOF
python3 "$W/echo.py" "$upstream" &
echo_pid=$!

mkdir -p "$W/logs" "$W/tmp"
cp "$here/nginx/termag-proxy.conf" "$W/termag-proxy.conf"
cat >"$W/app.conf" <<EOF
location /myapp {
    proxy_pass http://127.0.0.1:$upstream;
    include $W/termag-proxy.conf;
}
EOF
sed -e "s#listen 3040 default_server#listen 127.0.0.1:$port default_server#" \
    -e "s#listen 3040;#listen 127.0.0.1:$(free_port);#" \
    -e "s#/etc/nginx/snippets/termag-proxy.conf#$W/termag-proxy.conf#" \
    -e "s#include /srv/termag/apps/\*/nginx.conf;#include $W/app.conf;#" \
    -e "s#127.0.0.1:3100#127.0.0.1:$upstream#" \
    -e "s#/var/log/nginx/#$W/logs/#" \
    "$here/nginx/termag-gateway.conf" >"$W/gateway.conf"
grep -q "include $W/app.conf;" "$W/gateway.conf" || { fail 'the hosted-app include is rewritten to the test app' 'present' 'missing'; exit 1; }
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
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$port/myapp/" && break; sleep 0.1; done

# check <what> <path> <Cookie header or empty> <want>
check() {
  if [ -n "$3" ]; then got=$(curl -s -H "Cookie: $3" "http://127.0.0.1:$port$2"); else got=$(curl -s "http://127.0.0.1:$port$2"); fi
  [ "$got" = "cookie=$4" ] || fail "$1" "cookie=$4" "$got"
}

S='__Host-termag.sid=s%3Aabc.sig'
check 'termag gets its session cookie'           /termag/api/me   "$S; app=1"        "$S; app=1"
check 'termag gets it at the bare /termag too'   /termag          "$S"               "$S"
check 'a hosted app gets the rest, first'        /myapp/          "$S; app=1; b=2"   'app=1; b=2'
check 'a hosted app gets the rest, between'      /myapp/x         "app=1; $S; b=2"   'app=1; b=2'
check 'a hosted app gets the rest, last'         /myapp/x         "app=1; $S"        'app=1; '
check 'a hosted app gets no header for it alone' /myapp/x         "$S"               '<none>'
check 'a hosted app keeps a cookie only ending in the name' /myapp/x "x$S; app=1"    "x$S; app=1"
check 'a hosted app keeps its cookies as they are' /myapp/x       'app=1; b=2'       'app=1; b=2'
check 'a hosted app with no cookies gets none'   /myapp/x         ''                 '<none>'
check 'a path that only starts with termag is not termag' /termagx "$S; app=1"       'app=1'
check 'a dot-segment into termag is still termag' /myapp/../termag/api "$S"          "$S"

if [ "$failed" = 0 ]; then
  echo 'PASS: the nginx gateway sends the session cookie to termag only'
else
  echo '--- error.log'; cat "$W/logs/error.log"
  exit 1
fi
