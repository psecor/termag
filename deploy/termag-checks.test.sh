#!/bin/sh
# Static checks on the orchestrator's nginx check routes (deploy/nginx/termag-checks.conf):
# :3041 serves the three gateway checks and a health check, nothing else, and
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
want='location = /healthz {|location /termag/internal/claude-authz/ {|location /termag/internal/github-authz/ {|location / {|'
[ "$got" = "$want" ] || fail 'it serves the two checks and a health check only' "$want" "$got"

got="$(code "$CHECKS" | grep -c 'proxy_pass http://127.0.0.1:3100;')"
[ "$got" = 2 ] || fail 'only the two checks reach the backend' 2 "$got"

got="$(code "$CHECKS" | sed -n '/location \/ {/,/}/p' | grep -c 'return 404;')"
[ "$got" = 1 ] || fail 'everything else is a 404' 1 "$got"

if code "$CHECKS" | grep -qE 'ssl|X-Termag-Agent-Tls'; then
  fail 'no TLS or header trust on the listener' 'none' "$(code "$CHECKS" | grep -E 'ssl|X-Termag-Agent-Tls' | head -1)"
fi

got="$(code "$GATEWAY" | sed -n '/location \^~ \/termag\/internal\/ {/,/}/p' | grep -c 'return 404;')"
[ "$got" = 1 ] || fail ':3040 answers /termag/internal/ with 404' 1 "$got"

inst=$(grep -n 'termag-checks.conf /etc/nginx/sites-enabled/termag-checks.conf' "$SETUP" | cut -d: -f1)
test_line=$(grep -n '^sudo nginx -t' "$SETUP" | cut -d: -f1)
[ -n "$inst" ] && [ -n "$test_line" ] && [ "$inst" -lt "$test_line" ] ||
  fail 'the bake enables the checks listener before nginx -t' "enabled before line $test_line" "${inst:-not enabled}"

if [ "$failed" = 0 ]; then
  echo 'PASS: termag-checks listener serves the gateway checks only'
else
  exit 1
fi
