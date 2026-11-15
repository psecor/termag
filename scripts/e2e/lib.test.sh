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
# PostgreSQL unpacked by the stack itself (pg_fetch) lands in the download cache.
mkdir -p "$H/.cache/termag-e2e/pg/16/root"
echo pg > "$H/.cache/termag-e2e/pg/16/root/postgres"
touch -t "$(($(date +%Y) + 10))01010000" "$H/future"

# $HOME is the first place e2e_leaks looks, so this sandbox's files come first
# and the 20-line cap can't drop them; anything else it finds is not ours. The
# sandbox sits under /tmp, which it also scans, hence sort -u.
all=$(HOME="$H" E2E_CACHE_DIR='' XDG_CACHE_HOME='' bash -c '. "$1/lib.sh"; e2e_leaks "$2/.started" "$2"' _ "$here" "$WORK")
got=$(printf '%s\n' "$all" | grep -F "$H/" | sort -u || true)

[ "$got" = "$H/leak" ] || fail 'e2e_leaks reports only the file written after the marker' "$H/leak" "$got"
case $got in *"$H/future"*) fail 'a file dated after the check is skipped (bazel install tree)' 'not listed' "$got" ;; esac
case $got in *"$H/.cache/termag-e2e/pg/"*) fail "PostgreSQL the stack unpacked into the e2e cache is skipped" 'not listed' "$got" ;; esac
case $got in *"$H/before"*) fail 'a file from before the marker is skipped' 'not listed' "$got" ;; esac
case $all in *"$WORK/own"*) fail "a file in the test's own work dir is skipped" 'not listed' "$all" ;; esac

# e2e_flags_like_production: reviews on bring Review's clone, as production's
# targeting does; a list that names the clone flag, or leaves reviews off, is kept.
like_prod() { bash -c '. "$1/lib.sh"; e2e_flags_like_production "$2"' _ "$here" "$1"; }
got=$(like_prod '{"simple-ui-chrome-refresh-enabled":true,"simple-ui-reviews-enabled":true}')
want='{"simple-ui-chrome-refresh-enabled":true,"simple-ui-reviews-enabled":true,"simple-ui-review-clone-enabled":true}'
[ "$got" = "$want" ] || fail 'reviews on turns the review clone on' "$want" "$got"
got=$(like_prod '{"simple-ui-reviews-enabled":true,"simple-ui-review-clone-enabled":false}')
[ "$got" = '{"simple-ui-reviews-enabled":true,"simple-ui-review-clone-enabled":false}' ] \
  || fail 'an explicit review clone is kept' '{"simple-ui-reviews-enabled":true,"simple-ui-review-clone-enabled":false}' "$got"
got=$(like_prod '{"simple-ui-reviews-enabled":false}')
[ "$got" = '{"simple-ui-reviews-enabled":false}' ] || fail 'reviews off adds nothing' '{"simple-ui-reviews-enabled":false}' "$got"
got=$(like_prod '{ "hyperspace-background-enabled": true }')
[ "$got" = '{ "hyperspace-background-enabled": true }' ] || fail 'a list without reviews is passed through as written' '{ "hyperspace-background-enabled": true }' "$got"

# pkce_challenge: RFC 7636's own example, and a verifier starting with "-",
# which node took for an option of its own (a device sign-in failed one run in
# 64 with "node: bad option").
got=$(bash -c '. "$1/lib.sh"; pkce_challenge "$2"' _ "$here" dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk 2>&1 || true)
[ "$got" = E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM ] \
  || fail 'pkce_challenge gives RFC 7636 appendix B challenge' E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM "$got"
got=$(bash -c '. "$1/lib.sh"; pkce_challenge "$2"' _ "$here" -hHjopntB8t3Wler83tic30sNT-YuU2YsNGL321HJRE 2>&1 || true)
[ "$got" = _X8-qG8a9VwOR0K8QzOhE-jPrFyTSIa7S8AuArNlGdo ] \
  || fail 'pkce_challenge takes a verifier that starts with -' _X8-qG8a9VwOR0K8QzOhE-jPrFyTSIa7S8AuArNlGdo "$got"

# e2e_tmux_isolation asks every socket under the root with tmux. A socket that
# isn't tmux's and never answers kept the descriptors tmux handed it (tsx
# watch's IPC socket did), so the check's loops never saw EOF and up.sh hung
# before "stack is up". It must come back, with nothing to say about it.
if command -v tmux >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
  R="$T/root"
  mkdir -p "$R/boxes/box-1"
  node -e 'require("net").createServer({ pauseOnConnect: true }, () => {}).listen(process.argv[1], () => console.log("up"))' \
    "$R/boxes/box-1/silent.sock" > "$T/silent.out" 2>&1 &
  silent=$!
  i=0; until grep -q up "$T/silent.out" 2>/dev/null || [ "$i" -ge 50 ]; do sleep 0.1; i=$((i + 1)); done
  bash -c '. "$1/lib.sh"; e2e_tmux_isolation "$2"' _ "$here" "$R" > "$T/isolation.out" 2>&1 &
  asking=$!
  i=0; while kill -0 "$asking" 2>/dev/null && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i + 1)); done
  if kill -0 "$asking" 2>/dev/null; then
    kill -9 "$asking" 2>/dev/null
    fail 'e2e_tmux_isolation comes back from a socket that never answers' 'done within 15 s' 'still asking'
  else
    [ -z "$(cat "$T/isolation.out")" ] \
      || fail 'a socket that never answers is not a stray server' '' "$(cat "$T/isolation.out")"
  fi
  kill "$silent" 2>/dev/null || true
  wait "$silent" 2>/dev/null || true
fi

# pg_fetch, up.sh's fallback when no server is installed, runs the
# pg-tools.sh beside it in ../stage; a copy of lib.sh beside a stand-in tells
# what it does with that script's output and its failures.
F="$T/pgfetch"; mkdir -p "$F/e2e" "$F/stage"
cp "$here/lib.sh" "$F/e2e/lib.sh"
cat >"$F/stage/pg-tools.sh" <<'STUB'
if [ "$1" = env ]; then echo "LD_LIBRARY_PATH=$2/root/usr/lib/x86_64-linux-gnu"; exit 0; fi
[ -n "${STUB_FAIL:-}" ] && { echo 'download failed' >&2; exit 1; }
echo "$2/root/usr/lib/postgresql/$1/bin"
STUB
got=$(E2E_CACHE_DIR="$T/cache" bash -c '. "$1/e2e/lib.sh"; pg_fetch 16' _ "$F")
want="$T/cache/pg/16/root/usr/lib/postgresql/16/bin
$T/cache/pg/16/root/usr/lib/x86_64-linux-gnu"
[ "$got" = "$want" ] || fail 'pg_fetch prints the bin directory, then the library directory' "$want" "$got"
# As up.sh calls it: in $(...) || die, where errexit is off.
if E2E_CACHE_DIR="$T/cache" STUB_FAIL=1 bash -c 'set -e; . "$1/e2e/lib.sh"; got=$(pg_fetch 16) || exit 0; exit 1' _ "$F" 2>/dev/null; then :; else
  fail "pg_fetch fails when pg-tools.sh does, as up.sh calls it" 'non-zero' '0'
fi

# pg-tools.sh reuses an unpacked server only when every binary the stack runs
# is there: a cache with postgres and no initdb (an unpack that stopped
# part-way) is fetched again, here from a curl that cannot reach PGDG.
S="$T/pgstub"; mkdir -p "$S"
for c in gpg gpgv gunzip sha256sum dpkg-deb; do printf '#!/bin/sh\nexit 0\n' >"$S/$c"; done
printf '#!/bin/sh\necho amd64\n' >"$S/dpkg"
printf '#!/bin/sh\necho offline >&2\nexit 22\n' >"$S/curl"
chmod +x "$S"/*
C="$T/pgcache"; pgbin="$C/root/usr/lib/postgresql/16/bin"; mkdir -p "$pgbin"
for b in pg_dump psql postgres; do printf '#!/bin/sh\n' >"$pgbin/$b"; chmod +x "$pgbin/$b"; done
if PATH="$S:$PATH" bash "$here/../stage/pg-tools.sh" 16 "$C" server >/dev/null 2>&1; then
  fail 'a server cache without initdb is not reused' 'non-zero (fetched again)' '0 (reused)'
fi
[ -x "$pgbin/postgres" ] || fail 'a failed fetch leaves the old cache in place' "$pgbin/postgres" 'gone'
for b in initdb pg_ctl createdb pg_isready; do printf '#!/bin/sh\n' >"$pgbin/$b"; chmod +x "$pgbin/$b"; done
got=$(PATH="$S:$PATH" bash "$here/../stage/pg-tools.sh" 16 "$C" server 2>&1) \
  || fail 'a complete server cache is reused without fetching' "$pgbin" "$got"

if [ "$failures" -eq 0 ]; then echo 'PASS: e2e_leaks reports writes after the marker, and skips older, future-dated and own-work files; pkce_challenge; e2e_tmux_isolation skips a socket that never answers; pg_fetch and the pg-tools.sh server cache'; fi
[ "$failures" -eq 0 ]
