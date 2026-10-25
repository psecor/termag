#!/bin/sh
# Static checks on the orchestrator's nginx check routes (deploy/nginx/termag-checks.conf):
# :3041 serves the four gateway checks and a health check, nothing else, and
# the plain :3040 gateway keeps refusing /termag/internal/. The e2e harness
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
[ "$got" = 2 ] || fail ':3040 answers /termag/internal/ with 404 on the main and the preview host' 2 "$got"

# The app-proxy marker: the shared snippet clears it on
# every main-host upstream, and only the preview host re-sets it — after the
# include, since nginx applies the last proxy_set_header for a name.
PROXY="$here/nginx/termag-proxy.conf"
got="$(code "$PROXY" | grep -c 'proxy_set_header X-Termag-App-Proxy "";')"
[ "$got" = 1 ] || fail 'termag-proxy.conf clears X-Termag-App-Proxy' 1 "$got"
preview="$(code "$GATEWAY" | sed -n '/server_name ~^preview/,/^}/p')"
got="$(printf '%s\n' "$preview" | grep -E 'include /etc/nginx/snippets/termag-proxy.conf;|proxy_set_header X-Termag-App-Proxy 1;' | tr -s ' ' | sed 's/^ //' | tr '\n' '|')"
want='include /etc/nginx/snippets/termag-proxy.conf;|proxy_set_header X-Termag-App-Proxy 1;|'
[ "$got" = "$want" ] || fail 'the preview host sets the marker after the snippet' "$want" "$got"
got="$(code "$GATEWAY" | grep -c 'X-Termag-App-Proxy 1')"
[ "$got" = 1 ] || fail 'nothing but the preview host sets the marker' 1 "$got"

inst=$(grep -n 'termag-checks.conf /etc/nginx/sites-enabled/termag-checks.conf' "$SETUP" | cut -d: -f1)
test_line=$(grep -n '^sudo nginx -t' "$SETUP" | cut -d: -f1)
[ -n "$inst" ] && [ -n "$test_line" ] && [ "$inst" -lt "$test_line" ] ||
  fail 'the bake enables the checks listener before nginx -t' "enabled before line $test_line" "${inst:-not enabled}"

if [ "$failed" = 0 ]; then
  echo 'PASS: termag-checks listener serves the gateway checks only'
else
  exit 1
fi
