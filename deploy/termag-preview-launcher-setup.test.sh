#!/usr/bin/env bash
# deploy/termag-preview-launcher-setup, without root: the paths under a temp root,
# a stand-in for the go build and for check-preview-launcher.sh. What is pinned:
# a box without the launcher gets it, root's mode 0755; a current box rebuilds
# nothing; a changed source or boot kernel is drift; a failed kernel check
# removes the binary (no launcher, every confined run refused); a failed build
# leaves the installed one alone; and it refuses to run as anyone but root.
set -u
SETUP="$(cd "$(dirname "$0")" && pwd)/termag-preview-launcher-setup"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fails=0
fail() { printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3"; fails=$((fails + 1)); }

ROOT="$WORK/root"
HOMEDIR=/home/agent
SRC="$ROOT$HOMEDIR/src/termag/preview-launcher"
mkdir -p "$SRC" "$ROOT/boot"
printf 'package main\n' > "$SRC/main.go"
printf 'module x\n' > "$SRC/go.mod"
printf 'read\nwrite\n' > "$SRC/syscalls-arm64.txt"
touch "$ROOT/boot/config-6.8.0-1069-aws"

BUILD_LOG="$WORK/build-log"; : > "$BUILD_LOG"
cat > "$WORK/build" <<EOF
#!/bin/bash
echo build >> "$BUILD_LOG"
[ -f "$WORK/build-fails" ] && exit 1
printf '#!/bin/sh\necho launcher-%s\n' "\$(date +%s%N)" > "\$1/termag-preview"
EOF
cat > "$WORK/check" <<EOF
#!/bin/bash
[ ! -f "$WORK/check-fails" ] || { echo 'unreviewed: mseal' >&2; exit 1; }
EOF
chmod +x "$WORK/build" "$WORK/check"
DEST="$ROOT/usr/local/bin/termag-preview"
STAMP="$ROOT/var/lib/termag/preview-launcher/stamp"

setup() {
  TERMAG_PREVIEW_SETUP_ROOT="$ROOT" TERMAG_PREVIEW_SETUP_HOME="$HOMEDIR" \
    TERMAG_PREVIEW_SETUP_BUILD="$WORK/build" TERMAG_PREVIEW_SETUP_CHECK="$WORK/check" \
    bash "$SETUP" --agent-user "$(id -un)" "$@"
}

# A box without the launcher: drift, then installed, 0755, with its stamp.
out=$(setup --check 2>&1); got=$?
[ "$got" = 1 ] || fail 'a missing launcher is drift' 1 "$got"
case "$out" in *'DRIFT: /usr/local/bin/termag-preview is missing'*) ;; *) fail '--check names a missing launcher' 'DRIFT: …missing' "$out" ;; esac
[ -e "$DEST" ] && fail '--check changes nothing' 'no launcher' 'installed'
out=$(setup 2>&1); got=$?
[ "$got" = 0 ] || fail 'installs the launcher' 0 "$got: $out"
case "$out" in *'installed: /usr/local/bin/termag-preview'*) ;; *) fail 'says it installed it' 'installed: …' "$out" ;; esac
[ "$(stat -c %a "$DEST" 2>/dev/null)" = 755 ] || fail 'installed 0755' 755 "$(stat -c %a "$DEST" 2>&1)"
[ -s "$STAMP" ] || fail 'records what it built from' 'a stamp' 'none'

# Current: nothing rebuilt, nothing said, no drift.
: > "$BUILD_LOG"
out=$(setup 2>&1); got=$?
[ "$got" = 0 ] && [ -z "$out" ] || fail 'a current box writes nothing' '0, silent' "$got: $out"
[ -s "$BUILD_LOG" ] && fail 'a current box builds nothing' 'no build' "$(cat "$BUILD_LOG")"
setup --check >/dev/null 2>&1 || fail 'a current box has no drift' 0 1

# A changed source, or a new boot kernel: drift, and rebuilt.
printf 'package main // changed\n' > "$SRC/main.go"
out=$(setup --check 2>&1); got=$?
[ "$got" = 1 ] || fail 'a changed source is drift' 1 "$got"
case "$out" in *'older than the checkout'*) ;; *) fail '--check names an old launcher' 'DRIFT: …older…' "$out" ;; esac
setup >/dev/null 2>&1 || fail 'rebuilds a changed source' 0 1
setup --check >/dev/null 2>&1 || fail 'current after the rebuild' 0 1
touch "$ROOT/boot/config-6.8.0-1070-aws"
setup --check >/dev/null 2>&1 && fail 'a new boot kernel is drift' 1 0
setup >/dev/null 2>&1 || fail 'rechecks a new boot kernel' 0 1

# A failed build leaves the installed launcher alone.
before=$(cat "$DEST")
printf 'package main // again\n' > "$SRC/main.go"
touch "$WORK/build-fails"
out=$(setup 2>&1); got=$?
[ "$got" = 1 ] || fail 'a failed build fails' 1 "$got"
[ "$(cat "$DEST" 2>/dev/null)" = "$before" ] || fail 'a failed build leaves the launcher as it was' "$before" "$(cat "$DEST" 2>&1)"
rm -f "$WORK/build-fails"

# A kernel that fails the check: the launcher is removed, nothing recorded.
stamp_before=$(cat "$STAMP")
touch "$WORK/check-fails"
out=$(setup 2>&1); got=$?
[ "$got" = 1 ] || fail 'a failed kernel check fails' 1 "$got"
[ -e "$DEST" ] && fail 'a failed kernel check removes the launcher' 'no launcher' 'still installed'
case "$out" in *'confined runs are refused'*) ;; *) fail 'says confined runs are refused' '…confined runs are refused…' "$out" ;; esac
[ "$(cat "$STAMP")" = "$stamp_before" ] || fail 'a failed check records nothing' "$stamp_before" "$(cat "$STAMP")"
rm -f "$WORK/check-fails"
setup >/dev/null 2>&1 && [ -x "$DEST" ] || fail 'installs once the check passes' 'installed' 'not'

# Never as anyone but root, outside the tests' temp root.
if [ "$(id -u)" != 0 ]; then
  out=$(bash "$SETUP" --agent-user "$(id -un)" 2>&1); got=$?
  [ "$got" = 1 ] || fail 'refuses to run as a user' 1 "$got: $out"
fi
out=$(TERMAG_PREVIEW_SETUP_ROOT="$ROOT" bash "$SETUP" --agent-user root 2>&1); got=$?
[ "$got" = 2 ] || fail 'refuses root as the agent user' 2 "$got: $out"

if [ "$fails" -gt 0 ]; then printf '%d failed\n' "$fails"; exit 1; fi
echo 'PASS: termag-preview-launcher-setup: install, current, drift, failed build, failed kernel check, root only'
