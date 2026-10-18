#!/bin/sh
# Tests deploy/termag-host-setup.
#
# It runs as root with input the backend derives from a user's email, so the
# properties that matter are the refusals: bad or reserved usernames, a missing
# or malformed token, system accounts, and a hand-made agent config are all
# rejected before anything is created or started. Then the happy paths: a new
# account is created (inside the IMDS guard's uid range) and gets a 0600
# config, the Claude Code status hooks and a started unit; an existing account
# is reused; a config this script wrote is replaced with the new token. The
# hooks' termag-status is a symlink into the image (so it can't go stale), and a
# settings.json the user already has is never touched. When the user manager
# won't start (user@.service requires termag-imds-guard.service), or the
# guard's rules won't reload before the agent restarts, it fails without
# starting the agent. Without host storage (no ready file, or /home not the
# data volume's bind) it refuses with exit 3 before touching any account.
#
# Every system command it calls (id, useradd, getent, runuser, loginctl,
# systemctl, findmnt) is stubbed, and homes live under TERMAG_HOST_SETUP_ROOT, so this
# touches nothing real.
#
# Run: sh deploy/termag-host-setup.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-host-setup"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

STUB="$WORK/stub"
ROOTDIR="$WORK/root"
DEPLOYDIR="$ROOTDIR/usr/local/lib/termag"
mkdir -p "$STUB" "$WORK/users" "$ROOTDIR/home" "$DEPLOYDIR"
printf '#!/bin/sh\necho status\n' >"$DEPLOYDIR/termag-status"
chmod 755 "$DEPLOYDIR/termag-status"
printf '{"hooks":{"Stop":[]}}\n' >"$DEPLOYDIR/claude-settings.json"
LOG="$WORK/calls.log"

# Accounts are files in $WORK/users holding the uid.
cat >"$STUB/id" <<EOF
#!/bin/sh
[ "\$1" = -u ] && [ -f "$WORK/users/\$2" ] && cat "$WORK/users/\$2" && exit 0
exit 1
EOF
cat >"$STUB/useradd" <<EOF
#!/bin/sh
for a; do name="\$a"; done
echo 1500 >"$WORK/users/\$name"
mkdir -p "$ROOTDIR/home/\$name"
echo "useradd \$name" >>"$LOG"
echo "\$*" >"$WORK/useradd-args"
EOF
cat >"$STUB/getent" <<EOF
#!/bin/sh
u="\$2"; [ -f "$WORK/users/\$u" ] || exit 2
uid="\$(cat "$WORK/users/\$u")"
echo "\$u:x:\$uid:\$uid::\${HOME_OVERRIDE:-/home/\$u}:/bin/bash"
EOF
# runuser -u USER -- CMD...: run CMD as ourselves (the test can't switch users).
cat >"$STUB/runuser" <<EOF
#!/bin/sh
echo "runuser \$2" >>"$LOG"
while [ "\$1" != -- ]; do shift; done; shift
exec "\$@"
EOF
printf '#!/bin/sh\necho "loginctl $*" >>"%s"\n' "$LOG" >"$STUB/loginctl"
# With $WORK/guard-failed, user managers fail to start, as they do when
# termag-imds-guard.service failed; with $WORK/reload-fails, reloading the
# guard's rules fails.
cat >"$STUB/systemctl" <<EOF
#!/bin/sh
echo "systemctl \$*" >>"$LOG"
case "\$*" in
  "start user@"*) [ ! -f "$WORK/guard-failed" ] ;;
  "reload termag-imds-guard.service") [ ! -f "$WORK/reload-fails" ] ;;
esac
EOF
# Mount table: $WORK/mnt-srv and $WORK/mnt-home hold the SOURCE findmnt prints.
cat >"$STUB/findmnt" <<EOF
#!/bin/sh
while [ \$# -gt 0 ]; do
  case "\$1" in --mountpoint) shift; mp="\$1" ;; esac
  shift
done
case "\$mp" in
  /srv/termag) f="$WORK/mnt-srv" ;;
  /home) f="$WORK/mnt-home" ;;
  *) exit 1 ;;
esac
[ -f "\$f" ] && cat "\$f"
EOF
chmod +x "$STUB"/*
storage_ready() {
  mkdir -p "$ROOTDIR/run/termag" && : >"$ROOTDIR/run/termag/host-storage-ready"
  echo /dev/nvme1n1 >"$WORK/mnt-srv"
  echo '/dev/nvme1n1[/home]' >"$WORK/mnt-home"
}
storage_ready

TOKEN="tmag_$(printf '%064d' 0 | tr 0 a)"
TOKEN2="tmag_$(printf '%064d' 0 | tr 0 b)"

run() { # run <token-or-empty> <args...>; sets $out, $rc
  tok="$1"; shift
  : >"$LOG"
  out="$(printf '%s\n' "$tok" | PATH="$STUB:$PATH" TERMAG_HOST_SETUP_ROOT="$ROOTDIR" bash "$SCRIPT" "$@" 2>&1)"
  rc=$?
}

expect_refused() { # expect_refused <label> <token> <args...>
  label="$1"; shift
  run "$@"
  [ "$rc" -eq 2 ] || fail "$label: refused" "exit 2" "exit $rc ($out)"
  grep -q . "$LOG" && fail "$label: nothing created or started" "no calls" "$(tr '\n' ';' <"$LOG")"
}

# ── refusals ──────────────────────────────────────────────────────────────────
expect_refused "no args" "$TOKEN"
expect_refused "two args" "$TOKEN" alice bob
expect_refused "uppercase" "$TOKEN" Alice
expect_refused "path traversal" "$TOKEN" ../etc
expect_refused "shell metachar" "$TOKEN" 'a;rm'
expect_refused "33 chars" "$TOKEN" "a$(printf '%032d' 0)"
for r in root termag ubuntu ssm-user nobody docker systemd-network _apt; do
  expect_refused "reserved $r" "$TOKEN" "$r"
done
expect_refused "no token" "" alice
expect_refused "malformed token" "tmag_short" alice
expect_refused "token with trailing junk" "$TOKEN x" alice
echo 999 >"$WORK/users/svc"
expect_refused "system uid" "$TOKEN" svc

# ── no host storage: exit 3, nothing created or started ──────────────────────
expect_no_storage() { # expect_no_storage <label>
  run "$TOKEN" alice
  [ "$rc" -eq 3 ] || fail "$1: refused" "exit 3" "exit $rc ($out)"
  grep -q . "$LOG" && fail "$1: nothing created or started" "no calls" "$(tr '\n' ';' <"$LOG")"
  [ -e "$ROOTDIR/home/alice" ] && fail "$1: no home" "no $ROOTDIR/home/alice" "$(ls -a "$ROOTDIR/home/alice")"
  storage_ready
}
rm -f "$ROOTDIR/run/termag/host-storage-ready"
expect_no_storage "no ready file"
rm -f "$WORK/mnt-home"
expect_no_storage "/home not a mount"
rm -f "$WORK/mnt-srv"
expect_no_storage "/srv/termag not a mount"
echo '/dev/nvme0n1p1[/srv/home]' >"$WORK/mnt-home"
expect_no_storage "/home bound from the root disk"

# ── new account ───────────────────────────────────────────────────────────────
run "$TOKEN" alice
[ "$rc" -eq 0 ] || fail "new account: succeeds" "exit 0" "exit $rc ($out)"
grep -q '^useradd alice$' "$LOG" || fail "new account: created" "useradd alice" "$(tr '\n' ';' <"$LOG")"
grep -q -- '-K UID_MAX=59999' "$WORK/useradd-args" \
  || fail "new account: uid stays in the IMDS guard's range" "-K UID_MAX=59999" "$(cat "$WORK/useradd-args")"
cfg="$ROOTDIR/home/alice/.termag/agent.config.json"
grep -q "\"token\": \"$TOKEN\"" "$cfg" 2>/dev/null || fail "new account: config holds token" "$TOKEN in $cfg" "$(cat "$cfg" 2>&1)"
grep -q '"managed_by": "termag-host-setup"' "$cfg" || fail "new account: config marked" "managed_by marker" "$(cat "$cfg")"
grep -q '"termag_url": "ws://127.0.0.1:3040/termag/ws/agent"' "$cfg" || fail "new account: loopback url" "ws://127.0.0.1:3040/..." "$(cat "$cfg")"
mode="$(ls -l "$cfg" | cut -c1-10)"
[ "$mode" = "-rw-------" ] || fail "new account: config mode" "-rw-------" "$mode"
grep -q '^runuser alice$' "$LOG" || fail "new account: config written as the user" "runuser alice" "$(tr '\n' ';' <"$LOG")"
want="loginctl enable-linger alice;systemctl start user@1500.service;systemctl --user -M alice@ daemon-reload;systemctl --user -M alice@ enable termag-agent-host.service;systemctl reload termag-imds-guard.service;systemctl --user -M alice@ restart termag-agent-host.service;"
got="$(grep -E '^(loginctl|systemctl)' "$LOG" | tr '\n' ';')"
[ "$got" = "$want" ] || fail "new account: linger + unit" "$want" "$got"
for leftover in "$ROOTDIR/home/alice/.termag"/.agent.config.* "$ROOTDIR/home/alice/.claude"/.settings.*; do
  [ -e "$leftover" ] && fail "new account: no temp file left" "none" "$leftover"
done
status="$ROOTDIR/home/alice/.local/bin/termag-status"
[ -L "$status" ] && [ "$(readlink "$status")" = "$DEPLOYDIR/termag-status" ] \
  || fail "new account: termag-status links into the image" "symlink -> $DEPLOYDIR/termag-status" "$(ls -l "$status" 2>&1)"
settings="$ROOTDIR/home/alice/.claude/settings.json"
cmp -s "$settings" "$DEPLOYDIR/claude-settings.json" \
  || fail "new account: hooks settings installed" "copy of claude-settings.json" "$(cat "$settings" 2>&1)"

# ── existing account, and replacing our own config ────────────────────────────
# Meanwhile the user edits their Claude settings and something left a stale
# regular-file copy of termag-status behind.
printf '{"hooks":{},"mine":true}\n' >"$settings"
rm -f "$status"; printf 'stale\n' >"$status"
run "$TOKEN2" alice
[ "$rc" -eq 0 ] || fail "rerun: succeeds" "exit 0" "exit $rc ($out)"
grep -q '^useradd' "$LOG" && fail "rerun: account reused" "no useradd" "$(tr '\n' ';' <"$LOG")"
grep -q "\"token\": \"$TOKEN2\"" "$cfg" || fail "rerun: token replaced" "$TOKEN2" "$(cat "$cfg")"
grep -q '"mine":true' "$settings" || fail "rerun: user's settings.json untouched" '{"mine":true}' "$(cat "$settings")"
[ -L "$status" ] && [ "$(readlink "$status")" = "$DEPLOYDIR/termag-status" ] \
  || fail "rerun: stale termag-status copy replaced by the link" "symlink" "$(ls -l "$status" 2>&1)"

# ── user manager won't start (IMDS guard failed): the agent unit is left alone ─
touch "$WORK/guard-failed"
run "$TOKEN" alice
[ "$rc" -ne 0 ] || fail "guard failed: fails" "non-zero exit" "exit 0 ($out)"
grep -q -- '--user' "$LOG" && fail "guard failed: agent unit not touched" "no systemctl --user" "$(tr '\n' ';' <"$LOG")"
rm -f "$WORK/guard-failed"

# ── manager already running but the guard's rules won't load: agent not restarted
touch "$WORK/reload-fails"
run "$TOKEN" alice
[ "$rc" -ne 0 ] || fail "rules won't reload: fails" "non-zero exit" "exit 0 ($out)"
grep -q -- '--user -M alice@ restart' "$LOG" \
  && fail "rules won't reload: agent not restarted" "no restart" "$(tr '\n' ';' <"$LOG")"
rm -f "$WORK/reload-fails"

# ── hand-made config is never clobbered ───────────────────────────────────────
echo 1600 >"$WORK/users/bob"
mkdir -p "$ROOTDIR/home/bob/.termag"
printf '{"termag_url":"wss://elsewhere","token":"mine"}\n' >"$ROOTDIR/home/bob/.termag/agent.config.json"
run "$TOKEN" bob
[ "$rc" -eq 2 ] || fail "hand-made config: refused" "exit 2" "exit $rc ($out)"
grep -q '"token":"mine"' "$ROOTDIR/home/bob/.termag/agent.config.json" || fail "hand-made config: unchanged" "original" "$(cat "$ROOTDIR/home/bob/.termag/agent.config.json")"
grep -qE '^(loginctl|systemctl)' "$LOG" && fail "hand-made config: nothing started" "no unit calls" "$(tr '\n' ';' <"$LOG")"
[ -e "$ROOTDIR/home/bob/.claude" ] && fail "hand-made config: no hooks installed" "no ~/.claude" "$(ls -a "$ROOTDIR/home/bob")"

# ── unexpected home ───────────────────────────────────────────────────────────
echo 1700 >"$WORK/users/carol"
: >"$LOG"
out="$(printf '%s\n' "$TOKEN" | HOME_OVERRIDE=/srv/carol PATH="$STUB:$PATH" TERMAG_HOST_SETUP_ROOT="$ROOTDIR" bash "$SCRIPT" carol 2>&1)"; rc=$?
[ "$rc" -eq 2 ] || fail "odd home: refused" "exit 2" "exit $rc ($out)"

if [ "$failures" -eq 0 ]; then
  echo "termag-host-setup: all tests passed"
else
  echo "termag-host-setup: $failures failure(s)"
  exit 1
fi
