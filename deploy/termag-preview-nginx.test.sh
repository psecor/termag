#!/bin/sh
# nginx's preview server_name, rendered at boot from PREVIEW_LINKS_DOMAIN
# (backend/src/scripts/previewNginxSnippet.ts, run before every nginx start by
# deploy/termag-preview-nginx.conf), against the real gateway config and real
# nginx:
#   - for a placeholder domain the snippet loads (`nginx -t`), and nginx sends
#     to the preview block exactly the labels the backend's
#     PREVIEW_HOST_LABEL_RE accepts (services/previewHostGrammar.ts, the one
#     source of both), with the label as X-Termag-Preview-Name;
#   - unset: no snippet, nginx starts, every preview host is the main host's;
#   - malformed: no snippet, an error, nginx starts, the same.
# The domain is a placeholder: the real one never goes in the tree.
#
# Needs nginx, curl, python3 and a way to run the backend's TypeScript (its
# node_modules' tsx, or tsx on PATH); skips otherwise. With Docker, nginx 1.22
# as on Debian bookworm:
#   docker run --rm -v "$PWD:/src:ro" -w /src node:24-bookworm sh -c \
#     'apt-get update -qq && apt-get install -y -qq nginx curl >/dev/null && npm i -g tsx >/dev/null 2>&1 && sh deploy/termag-preview-nginx.test.sh'
#
# Run: sh deploy/termag-preview-nginx.test.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
backend="$here/../backend"
command -v nginx >/dev/null 2>&1 || { [ -x /usr/sbin/nginx ] && PATH="$PATH:/usr/sbin"; } || true
if [ -x "$backend/node_modules/.bin/tsx" ]; then tsx="$backend/node_modules/.bin/tsx"; else tsx=$(command -v tsx || true); fi
if ! command -v nginx >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 || ! command -v python3 >/dev/null 2>&1 || [ -z "$tsx" ]; then
  echo 'SKIP: termag-preview-nginx needs nginx, curl, python3 and tsx'
  exit 0
fi
nginx -v 2>&1

W=$(mktemp -d)
npid=
epid=
cleanup() { [ -n "$npid" ] && kill "$npid" 2>/dev/null; [ -n "$epid" ] && kill "$epid" 2>/dev/null; rm -rf "$W"; }
trap cleanup EXIT
failed=0
fail() { printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3"; failed=1; }
pass() { printf 'ok: %s\n' "$1"; }

free_port() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
port=$(free_port)
echo_port=$(free_port)
cat >"$W/echo.py" <<'PY'
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"headers": {k.lower(): v for k, v in self.headers.items()}}).encode()
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
sed -e "s#listen 3040 default_server#listen 127.0.0.1:$port default_server#" \
    -e "s#listen 3040;#listen 127.0.0.1:$port;#" \
    -e "s#/etc/nginx/snippets/#$W/snippets/#" \
    -e "s#include /srv/termag/apps/\*/nginx.conf;##" \
    -e "s#127.0.0.1:3100#127.0.0.1:$echo_port#" \
    -e "s#/var/log/nginx/#$W/logs/#" \
    "$here/nginx/termag-gateway.conf" >"$W/gateway.conf"
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
NGINX_T="nginx -q -p $W -c $W/nginx.conf -e $W/logs/error.log -t"
SNIPPET="$W/snippets/termag-preview-server-name.conf"

# The real boot script, as the nginx unit runs it, against a test .env.
render() {
  printf '%s\n' 'SESSION_SECRET=not-read' "$1" >"$W/.env"
  TERMAG_ENV_FILE="$W/.env" TERMAG_PREVIEW_SNIPPET="$SNIPPET" TERMAG_NGINX_TEST="$NGINX_T" \
    "$tsx" "$backend/src/scripts/previewNginxSnippet.ts" 2>"$W/render.err"
}
start_nginx() {
  stop_nginx
  if ! $NGINX_T >"$W/t.out" 2>&1; then cat "$W/t.out"; fail "$1: the gateway config loads" 'nginx -t ok' 'failed'; return 1; fi
  nginx -p "$W" -c "$W/nginx.conf" -e "$W/logs/error.log" &
  npid=$!
  for _ in $(seq 1 50); do curl -sf -o /dev/null "http://127.0.0.1:$port/termag/" && return 0; sleep 0.1; done
  fail "$1: nginx answers" 'up' 'down'; return 1
}
stop_nginx() { if [ -n "$npid" ]; then kill "$npid" 2>/dev/null || true; wait "$npid" 2>/dev/null || true; npid=; fi; }
# What the backend sees for Host $1: "<marker>|<name>".
seen() {
  curl -s -H "Host: $1" -H 'X-Termag-Preview-Host: forged' -H 'X-Termag-Preview-Name: forged' "http://127.0.0.1:$port/termag/probe" |
    python3 -c 'import json,sys; h=json.load(sys.stdin)["headers"]; print(h.get("x-termag-preview-host","-")+"|"+h.get("x-termag-preview-name","-"))'
}

# ── A placeholder domain ────────────────────────────────────────────────────
if render 'PREVIEW_LINKS_DOMAIN=previews.test'; then pass 'renders for previews.test'; else cat "$W/render.err"; fail 'renders for previews.test' 'exit 0' "exit $?"; fi
want=$("$tsx" -e "import { nginxServerNameLine } from '$backend/src/services/previewHostGrammar'; process.stdout.write(nginxServerNameLine('previews.test'))")
got=$(cat "$SNIPPET" 2>/dev/null || echo '<none>')
[ "$got" = "$want" ] || fail 'the snippet is the backend-generated line' "$want" "$got"
case "$got" in 'server_name "~^'*'\.previews\.test$";') pass "snippet: $got" ;; *) fail 'quoted, domain escaped' 'server_name "~^…\.previews\.test$";' "$got" ;; esac

x40=x$(printf '%039d' 0)
labels="abc my-app a1b my-app--k3x7q2 my-app--k3x9q2 abc--abcd abc--abc abc--abcdefg my--app my--app--abcd ab--cd abc--d abc--d--abcd a--abcd abc---abcd $x40 ${x40}1 $x40--abcdef ${x40}1--abcdef ab -ab ab- a_b a b0-ab9-z m"
# One tsx run for the backend's verdicts, labels in the environment (a
# leading hyphen would read as an option). The backend accepts a label as
# classifyHost does: the grammar nginx gets, and parseHostLabel.
LABELS="$labels" "$tsx" -e "import { PREVIEW_HOST_LABEL_RE } from '$backend/src/services/previewHostGrammar'; import { parseHostLabel } from '$backend/src/services/previewLinkRules'; for (const l of process.env.LABELS!.split(' ')) console.log(l + ' ' + (PREVIEW_HOST_LABEL_RE.test(l) && parseHostLabel(l) ? 'preview' : 'main'))" >"$W/verdicts"
# A label the backend accepts, for the checks below that need any preview host.
sample=$(awk '$2 == "preview" { print $1; exit }' "$W/verdicts")
[ -n "$sample" ] || fail 'the label list holds a preview label' 'one' 'none'
if start_nginx 'previews.test'; then
  pass 'nginx -t accepts the rendered snippet'
  # The pin: nginx and the backend accept the same labels: bare names,
  # <name>--<suffix>, and the near misses either side of each rule. A grammar
  # change in previewHostGrammar.ts is checked here against real nginx
  # without editing this list.
  while read -r label backend_says; do
    got=$(seen "$label.previews.test")
    case "$got" in "1|$label") nginx_says=preview ;; '-|-') nginx_says=main ;; *) nginx_says="odd($got)" ;; esac
    if [ "$nginx_says" = "$backend_says" ]; then pass "$label.previews.test: both say $backend_says"; else fail "$label.previews.test: nginx agrees with the backend" "$backend_says" "$nginx_says"; fi
  done <"$W/verdicts"
  [ "$(wc -l <"$W/verdicts")" -eq "$(echo $labels | wc -w)" ] || fail 'the backend judged every label' "$(echo $labels | wc -w)" "$(wc -l <"$W/verdicts")"
  for host in a.b.previews.test previews.test "$sample.previews.test.evil.test" "$sample.previewsxtest" "$sample.other.test" "x.$sample.previews.test"; do
    got=$(seen "$host")
    [ "$got" = '-|-' ] && pass "$host is the main host's, forged markers cleared" || fail "$host is the main host's" '-|-' "$got"
  done
  got=$(seen "$(printf '%s' "$sample.previews.test" | tr a-z A-Z)")
  [ "$got" = "1|$sample" ] && pass 'a Host in capitals is matched lowercased, as the backend reads it' || fail 'a Host in capitals is matched lowercased' "1|$sample" "$got"
fi

# A domain with a hyphen and three labels.
render 'PREVIEW_LINKS_DOMAIN=my-previews.example.test' || fail 'renders for my-previews.example.test' 'exit 0' "exit $?"
if start_nginx 'my-previews.example.test'; then
  got=$(seen "$sample.my-previews.example.test")
  [ "$got" = "1|$sample" ] && pass "$sample.my-previews.example.test is a preview" || fail 'a hyphenated domain matches' "1|$sample" "$got"
  got=$(seen "$sample.my-previewsxexample.test")
  [ "$got" = '-|-' ] && pass 'the dots are literal' || fail 'the dots are literal' '-|-' "$got"
fi

# ── Unset ───────────────────────────────────────────────────────────────────
if render '# no PREVIEW_LINKS_DOMAIN'; then pass 'unset: exit 0'; else fail 'unset: exit 0' 0 "$?"; fi
[ ! -e "$SNIPPET" ] && pass 'unset: no snippet (the earlier one is removed)' || fail 'unset: no snippet' 'absent' "$(cat "$SNIPPET")"
grep -q 'is unset' "$W/render.err" && pass "unset: says so: $(cat "$W/render.err")" || fail 'unset: says so' 'is unset' "$(cat "$W/render.err")"
if start_nginx 'unset'; then
  pass 'unset: nginx -t passes and nginx starts'
  got=$(seen "$sample.previews.test")
  [ "$got" = '-|-' ] && pass 'unset: a preview host is the main host'"'"'s' || fail 'unset: preview hosts match nothing' '-|-' "$got"
  got=$(seen termag-preview.invalid)
  [ "$got" = '1|termag-preview' ] && pass 'unset: only the reserved .invalid name reaches the block' || fail 'unset: the block keeps its reserved name' '1|termag-preview' "$got"
fi

# ── Malformed ───────────────────────────────────────────────────────────────
for bad in 'previews.test"; return 200; #' '*.previews.test' 'previews test' 'previews' 'previews.test:443' 'prévues.test'; do
  render 'PREVIEW_LINKS_DOMAIN=previews.test' >/dev/null 2>&1 || true
  if render "PREVIEW_LINKS_DOMAIN='$bad'"; then fail "malformed ($bad): refused" 'exit 1' 'exit 0'; else pass "malformed ($bad): exit 1"; fi
  [ ! -e "$SNIPPET" ] || fail "malformed ($bad): no snippet" 'absent' "$(cat "$SNIPPET")"
  grep -q 'ERROR: PREVIEW_LINKS_DOMAIN is set but is not a domain' "$W/render.err" || fail "malformed ($bad): logged" 'ERROR: …' "$(cat "$W/render.err")"
  if grep -qF "$bad" "$W/render.err"; then fail "malformed ($bad): the raw value isn't echoed" 'absent' 'present'; fi
done
printf 'ok: malformed says: %s\n' "$(cat "$W/render.err")"
if start_nginx 'malformed'; then
  pass 'malformed: nginx -t passes and nginx starts'
  got=$(seen "$sample.previews.test")
  [ "$got" = '-|-' ] && pass 'malformed: a preview host is the main host'"'"'s' || fail 'malformed: preview hosts match nothing' '-|-' "$got"
fi
stop_nginx

if [ "$failed" = 0 ]; then
  echo 'PASS: the preview server_name is rendered from the backend grammar, and unset or malformed domains leave nginx serving'
else
  exit 1
fi
