#!/bin/sh
# Tests e2e_leaks (scripts/e2e/lib.sh), the "no files written outside the temp
# root" check every e2e suite ends with, in a sandboxed HOME: what it must
# report and what it must skip, including a file dated in the future (bazel
# stamps its install tree ten years ahead, ~/.cache/bazel/_bazel_*/install).
#
# Run: sh scripts/e2e/lib.test.sh
set -eu

here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
H="$T/home"; WORK="$T/work"
mkdir -p "$H" "$WORK"

failures=0
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }

# Coarse mtimes on some filesystems: a second either side of the marker.
echo before > "$H/before"
sleep 1
: > "$WORK/.started"
sleep 1
echo leak > "$H/leak"
echo own > "$WORK/own"
echo future > "$H/future"
touch -t "$(($(date +%Y) + 10))01010000" "$H/future"

# $HOME is the first place e2e_leaks looks, so this sandbox's files come first
# and the 20-line cap can't drop them; anything else it finds is not ours. The
# sandbox sits under /tmp, which it also scans, hence sort -u.
all=$(HOME="$H" bash -c '. "$1/lib.sh"; e2e_leaks "$2/.started" "$2"' _ "$here" "$WORK")
got=$(printf '%s\n' "$all" | grep -F "$H/" | sort -u || true)

[ "$got" = "$H/leak" ] || fail 'e2e_leaks reports only the file written after the marker' "$H/leak" "$got"
case $got in *"$H/future"*) fail 'a file dated after the check is skipped (bazel install tree)' 'not listed' "$got" ;; esac
case $got in *"$H/before"*) fail 'a file from before the marker is skipped' 'not listed' "$got" ;; esac
case $all in *"$WORK/own"*) fail "a file in the test's own work dir is skipped" 'not listed' "$all" ;; esac

# pkce_challenge: RFC 7636's own example, and a verifier starting with "-",
# which node took for an option of its own (a device sign-in failed one run in
# 64 with "node: bad option").
got=$(bash -c '. "$1/lib.sh"; pkce_challenge "$2"' _ "$here" dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk 2>&1 || true)
[ "$got" = E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM ] \
  || fail 'pkce_challenge gives RFC 7636 appendix B challenge' E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM "$got"
got=$(bash -c '. "$1/lib.sh"; pkce_challenge "$2"' _ "$here" -hHjopntB8t3Wler83tic30sNT-YuU2YsNGL321HJRE 2>&1 || true)
[ "$got" = _X8-qG8a9VwOR0K8QzOhE-jPrFyTSIa7S8AuArNlGdo ] \
  || fail 'pkce_challenge takes a verifier that starts with -' _X8-qG8a9VwOR0K8QzOhE-jPrFyTSIa7S8AuArNlGdo "$got"

if [ "$failures" -eq 0 ]; then echo 'PASS: e2e_leaks reports writes after the marker, and skips older, future-dated and own-work files; pkce_challenge'; fi
[ "$failures" -eq 0 ]
