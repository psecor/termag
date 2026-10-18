#!/bin/sh
# Tests that the orchestrator fails closed when termag-imds-guard.service
# fails: deploy/termag-imds-guard-required.conf, dropped into user@.service
# and ssh.service, keeps every host account's user manager (lingering
# included, and with it their termag-agent-host) and every SSH login from
# starting until the guard has started. That covers both ways lingering gets
# enabled: termag-host-setup, and the orchestrator cloud-init's re-adoption of
# homes after an instance replacement, whose commands this runs verbatim.
#
# It needs real systemd: run as root on a disposable Ubuntu host with systemd
# as PID 1 and openssh-server installed (CI's runner). Everything it installs
# goes under /run/systemd/system and is removed afterwards, along with the test
# accounts; it stops ssh.service for the duration. The guard's rules are not
# loaded (termag-imds-guard.test.sh covers them): a drop-in swaps its
# ExecStart and ExecReload for ones that succeed only while $WORK/guard-ok
# exists and record the load in $WORK/table-loaded, which the test deletes to
# stand for a table flushed behind the active unit. Without
# root and systemd it prints SKIP, or fails with
# TERMAG_IMDS_GUARD_REQUIRE_LIVE=1.
#
# Run: sudo TERMAG_IMDS_GUARD_REQUIRE_LIVE=1 sh deploy/termag-imds-guard-deps.test.sh
set -u

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
DROPIN="$DEPLOY/termag-imds-guard-required.conf"
GUARD="termag-imds-guard.service"
RUNDIR=/run/systemd/system
U=tmgguardtest
A=tmgadopttest # re-adopted from its home by cloud-init

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

live=1
[ "$(id -u)" -eq 0 ] || live=0
[ -d /run/systemd/system ] || live=0
for c in systemctl loginctl useradd usermod userdel groupadd groupdel runuser timeout ssh ssh-keygen; do
  command -v "$c" >/dev/null 2>&1 || live=0
done
[ "$live" -eq 1 ] && ! systemctl cat ssh.service >/dev/null 2>&1 && live=0
# Never on a host that has the real guard: this replaces it for the run.
[ "$live" -eq 1 ] && [ -e "/etc/systemd/system/$GUARD" ] && live=0
if [ "$live" -eq 0 ]; then
  if [ "${TERMAG_IMDS_GUARD_REQUIRE_LIVE:-}" = 1 ]; then
    echo "FAIL: live checks ran (need root, systemd as PID 1, ssh.service, no installed $GUARD)"
    exit 1
  fi
  echo "termag-imds-guard-deps: SKIP (need root, systemd as PID 1, ssh.service, no installed $GUARD)"
  exit 0
fi

WORK="$(mktemp -d)"
chmod 755 "$WORK"
ssh_was_active="$(systemctl is-active ssh.service)"
socket_was_active="$(systemctl is-active ssh.socket 2>/dev/null)"

remove_account() { # remove_account <name>
  loginctl disable-linger "$1" 2>/dev/null
  if u="$(id -u "$1" 2>/dev/null)"; then
    loginctl terminate-user "$1" 2>/dev/null
    systemctl stop "user@$u.service" 2>/dev/null
  fi
  userdel -f -r "$1" 2>/dev/null
  rm -rf "/var/lib/systemd/linger/${1:?}" "/home/${1:?}"
  getent group "$1" >/dev/null && groupdel "$1"
}
cleanup() {
  remove_account "$U"
  remove_account "$A"
  rm -rf "${RUNDIR:?}/$GUARD" "$RUNDIR/$GUARD.d" \
    "$RUNDIR/user@.service.d/termag-imds-guard.conf" "$RUNDIR/ssh.service.d/termag-imds-guard.conf"
  rmdir "$RUNDIR/user@.service.d" "$RUNDIR/ssh.service.d" 2>/dev/null
  systemctl daemon-reload
  systemctl reset-failed ssh.service ssh.socket 2>/dev/null
  [ "$socket_was_active" = active ] && systemctl start ssh.socket
  [ "$ssh_was_active" = active ] && systemctl start ssh.service
  rm -rf "$WORK"
}
trap cleanup EXIT

# ── install, the way orchestrator-setup.sh does, but under /run ──────────────
install -m 0644 "$DEPLOY/$GUARD" "$RUNDIR/$GUARD"
mkdir -p "$RUNDIR/$GUARD.d"
cat >"$RUNDIR/$GUARD.d/test.conf" <<EOF
[Service]
ExecStart=
ExecStart=/bin/sh -c 'test -e $WORK/guard-ok && touch $WORK/table-loaded'
ExecReload=
ExecReload=/bin/sh -c 'test -e $WORK/guard-ok && touch $WORK/table-loaded'
EOF
for unit in user@.service ssh.service; do
  mkdir -p "$RUNDIR/$unit.d"
  install -m 0644 "$DROPIN" "$RUNDIR/$unit.d/termag-imds-guard.conf"
done
systemctl daemon-reload

# Host accounts whose user manager runs a service that leaves probe-ran
# behind, standing in for termag-agent-host.
add_account() { # add_account <name>
  remove_account "$1"
  useradd --create-home --shell /bin/sh --user-group -K UID_MAX=59999 "$1"
  runuser -u "$1" -- sh -c '
    mkdir -p ~/.config/systemd/user/default.target.wants ~/.ssh
    printf "[Service]\nType=oneshot\nExecStart=/bin/sh -c \"id -u >%%h/probe-ran\"\n" \
      >~/.config/systemd/user/guard-probe.service
    ln -s ../guard-probe.service ~/.config/systemd/user/default.target.wants/guard-probe.service
  '
}
# One made by termag-host-setup, with an SSH key.
add_account "$U"
usermod -p '*' "$U" # no password, but not locked: sshd takes the key
uid="$(id -u "$U")"
home="$(getent passwd "$U" | cut -d: -f6)"
ssh-keygen -q -t ed25519 -N '' -f "$WORK/key"
install -o "$U" -g "$U" -m 0600 "$WORK/key.pub" "$home/.ssh/authorized_keys"
chmod 700 "$home/.ssh"

login() { # prints the remote uid, or nothing
  timeout 20 ssh -n -i "$WORK/key" -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ConnectTimeout=5 -o LogLevel=ERROR "$U@127.0.0.1" 'id -u' 2>/dev/null
}
wait_for() { # wait_for <seconds> <command...>
  n=$(($1 * 5)); shift
  while [ "$n" -gt 0 ]; do "$@" && return 0; sleep 0.2; n=$((n - 1)); done
  return 1
}
# logind starts user@ asynchronously: wait for either outcome, then a little
# longer for a manager that did start to run its services.
wait_for_manager() { # wait_for_manager <uid>
  wait_for 20 sh -c "systemctl is-active -q user@$1.service || systemctl is-failed -q $GUARD"
  sleep 2
}

# The other one survived an instance replacement: its home is on the
# persistent volume, its passwd entry is gone.
add_account "$A"
ahome="/home/$A"
userdel "$A"

for unit in "user@$uid.service" ssh.service; do
  for prop in Requires After; do
    systemctl show -p "$prop" --value "$unit" | grep -qw "$GUARD" \
      || fail "$unit: $prop=$GUARD" "$GUARD in $prop" "$(systemctl show -p "$prop" --value "$unit")"
  done
done

# ── the guard fails: nothing of the account's starts ─────────────────────────
systemctl stop ssh.service
systemctl reset-failed ssh.service ssh.socket "$GUARD" 2>/dev/null
loginctl enable-linger "$U"
wait_for_manager "$uid"
[ "$(systemctl is-active "$GUARD")" = failed ] \
  || fail "guard failing: guard failed" "failed" "$(systemctl is-active "$GUARD")"
[ "$(systemctl is-active "user@$uid.service")" = active ] \
  && fail "guard failing: lingering starts no user manager" "user@$uid inactive" "active"
[ -e "$home/probe-ran" ] && fail "guard failing: lingering starts no user service" "no probe-ran" "probe ran as uid $(cat "$home/probe-ran")"
systemctl start "user@$uid.service" 2>/dev/null \
  && fail "guard failing: user@$uid won't start (termag-host-setup's path)" "start fails" "started"
[ -e "$home/probe-ran" ] && fail "guard failing: explicit start runs no user service" "no probe-ran" "probe ran"
systemctl start ssh.service 2>/dev/null && fail "guard failing: ssh.service won't start" "start fails" "started"
got="$(login)"
[ -n "$got" ] && fail "guard failing: no SSH login" "login refused" "logged in as uid $got"
[ "$(systemctl is-active ssh.service)" = active ] && fail "guard failing: sshd not running" "inactive" "active"

# The orchestrator's cloud-init re-adopts every home under /home with these
# lines (terraform: projects/termag/root-modules/orchestrator/modules/termag/
# cloudinit.sh.tpl), after the guard has already had its chance at boot.
home="$ahome" name="$A"
adopt_uid="$(stat -c %u "$home")"
adopt_gid="$(stat -c %g "$home")"
getent group "$adopt_gid" >/dev/null || groupadd -g "$adopt_gid" "$name"
useradd -M -s /bin/bash -d "$home" -u "$adopt_uid" -g "$adopt_gid" "$name"
loginctl enable-linger "$name" || true
home="$(getent passwd "$U" | cut -d: -f6)"
auid="$adopt_uid"
wait_for_manager "$auid"
[ "$(systemctl is-active "user@$auid.service")" = active ] \
  && fail "guard failing: cloud-init's re-adoption lingering starts no user manager" "user@$auid inactive" "active"
[ -e "$ahome/probe-ran" ] \
  && fail "guard failing: cloud-init's re-adoption starts no user service" "no probe-ran" "probe ran as uid $(cat "$ahome/probe-ran")"

# ── the guard starts: lingering and SSH work again ───────────────────────────
touch "$WORK/guard-ok"
# The refused login above spun ssh.socket into its trigger limit (20 in 2s)
# and the guard into its start limit; let the burst end, then reset both.
sleep 3
systemctl reset-failed "$GUARD" "user@$uid.service" ssh.service ssh.socket 2>/dev/null
[ "$socket_was_active" = active ] && systemctl start ssh.socket
# Re-enabling while logind still holds the closing user would be ignored.
loginctl disable-linger "$U"
wait_for 20 sh -c "! loginctl show-user $U >/dev/null 2>&1"
loginctl enable-linger "$U"
wait_for 20 test -e "$home/probe-ran" \
  || fail "guard loaded: lingering starts the user's services" "probe-ran" "$(systemctl status "user@$uid.service" 2>&1 | tail -5)"
[ "$(systemctl is-active "$GUARD")" = active ] || fail "guard loaded: guard active" "active" "$(systemctl is-active "$GUARD")"
[ "$socket_was_active" = active ] || systemctl start ssh.service
got="$(login)"
[ "$got" = "$uid" ] || fail "guard loaded: SSH login works" "uid $uid" "${got:-no login}"
# What held the re-adopted account back was the guard: its manager starts now.
systemctl start "user@$auid.service" && wait_for 20 test -e "$ahome/probe-ran" \
  || fail "guard loaded: re-adopted account's services start" "probe-ran" "$(systemctl status "user@$auid.service" 2>&1 | tail -5)"

# ── table flushed behind the active guard: every start reapplies it ─────────
for unit in "user@$auid.service" ssh.service; do
  systemctl stop "$unit"
  rm -f "$WORK/table-loaded"
  systemctl start "$unit" || fail "table flushed: $unit starts" "started" "$(systemctl status "$unit" 2>&1 | tail -5)"
  [ -e "$WORK/table-loaded" ] || fail "table flushed: starting $unit reloads the rules" "table-loaded" "not reloaded"
done
# ... and a start whose reload fails doesn't happen.
rm -f "$WORK/guard-ok" "$ahome/probe-ran"
systemctl stop "user@$auid.service"
systemctl start "user@$auid.service" 2>/dev/null \
  && fail "rules won't load: user@$auid won't start" "start fails" "started"
[ -e "$ahome/probe-ran" ] && fail "rules won't load: no user service runs" "no probe-ran" "probe ran"
systemctl stop ssh.service
systemctl start ssh.service 2>/dev/null && fail "rules won't load: ssh.service won't start" "start fails" "started"
touch "$WORK/guard-ok"

# ── stopping the guard stops them ────────────────────────────────────────────
systemctl stop "$GUARD"
for u in "$uid" "$auid"; do
  [ "$(systemctl is-active "user@$u.service")" = active ] \
    && fail "guard stopped: user@$u stopped" "inactive" "active"
done
[ "$(systemctl is-active ssh.service)" = active ] && fail "guard stopped: sshd stopped" "inactive" "active"

if [ "$failures" -eq 0 ]; then
  echo "termag-imds-guard-deps: all tests passed"
else
  echo "termag-imds-guard-deps: $failures failure(s)"
  exit 1
fi
