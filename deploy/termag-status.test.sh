#!/bin/sh
# Tests endpoint resolution in deploy/termag-status.
#
# Only --print-endpoint is exercised: it is the part that was wrong (a hardcoded
# localhost) and it is pure, so the tests need no network, no tmux and no server.
#
# Run: sh deploy/termag-status.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-status"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

# Resolve with a given agent.config.json body ("" = no config file at all).
resolve() {
  cfg="$WORK/agent.config.json"
  if [ -z "$1" ]; then
    rm -f "$cfg"
    TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" HOME="$WORK/empty-home" \
      "$SCRIPT" --print-endpoint
  else
    printf '%s' "$1" > "$cfg"
    TERMAG_AGENT_CONFIG="$cfg" "$SCRIPT" --print-endpoint
  fi
}

check() {
  desc="$1"; body="$2"; want="$3"
  got="$(resolve "$body")"
  [ "$got" = "$want" ] || fail "$desc" "$want" "$got"
}

# ws:// -> http://, and /ws/agent -> /api/status
check 'remote ws' \
  '{"termag_url":"ws://ip-10-0-0-1.ec2.internal:3040/termag/ws/agent","token":"x"}' \
  'http://ip-10-0-0-1.ec2.internal:3040/termag/api/status'

# wss:// -> https:// (reverse-proxied deployment)
check 'remote wss' \
  '{"termag_url":"wss://termag.example.com/termag/ws/agent","token":"x"}' \
  'https://termag.example.com/termag/api/status'

# co-located server: the same derivation, not a special case
check 'co-located localhost' \
  '{"termag_url":"ws://localhost:3040/termag/ws/agent","token":"x"}' \
  'http://localhost:3040/termag/api/status'

# a query string on the URL must not leak into the endpoint (it can carry a token)
check 'query stripped' \
  '{"termag_url":"ws://localhost:3040/termag/ws/agent?token=secret","token":"x"}' \
  'http://localhost:3040/termag/api/status'

# a non-default BASE_PATH still resolves relative to the ws path
check 'custom base path' \
  '{"termag_url":"wss://example.com/some/base/ws/agent","token":"x"}' \
  'https://example.com/some/base/api/status'

# missing termag_url -> agent.js's fallback, not an empty or malformed URL
check 'config without termag_url' \
  '{"token":"x"}' \
  'http://127.0.0.1:3040/termag/api/status'

# unreadable/absent config -> same fallback
got="$(resolve '')"
want='http://127.0.0.1:3040/termag/api/status'
[ "$got" = "$want" ] || fail 'no config at all' "$want" "$got"

# malformed JSON must not produce a garbage endpoint
check 'malformed json' \
  'not json at all' \
  'http://127.0.0.1:3040/termag/api/status'

if [ "$failures" -eq 0 ]; then
  echo "PASS: all endpoint-resolution cases"
  exit 0
fi
echo "$failures failure(s)"
exit 1
