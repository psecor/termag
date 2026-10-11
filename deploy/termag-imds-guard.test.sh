#!/bin/sh
# Tests deploy/termag-imds-guard.nft and how the orchestrator image wires it up.
#
# The guard is what stops a host account (a person's shell, their agent,
# MetaTerm's Claude) from taking the orchestrator role's credentials off IMDS.
# What matters: both endpoints are rejected for exactly the uid range host
# accounts live in, and the unit is installed, enabled and ordered ahead of any
# user session, and user@.service and ssh.service require it.
# deploy/termag-imds-guard-deps.test.sh checks that requirement in real systemd.
#
# When run as root with unshare, ip, nft, setpriv and python3 available, it also
# loads the real ruleset (twice) inside a throwaway network namespace and
# connects to a listener on each IMDS address as several uids. Otherwise that
# part prints SKIP, or fails with TERMAG_IMDS_GUARD_REQUIRE_LIVE=1 (CI).
#
# Run: sh deploy/termag-imds-guard.test.sh
#      sudo TERMAG_IMDS_GUARD_REQUIRE_LIVE=1 sh deploy/termag-imds-guard.test.sh
set -u

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
RULES="$DEPLOY/termag-imds-guard.nft"
UNIT="$DEPLOY/termag-imds-guard.service"
DROPIN="$DEPLOY/termag-imds-guard-required.conf"
SETUP="$DEPLOY/../packer/scripts/orchestrator-setup.sh"
HOST_SETUP="$DEPLOY/termag-host-setup"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

# ── the ruleset ───────────────────────────────────────────────────────────────
for want in \
  'ip daddr 169.254.169.254 meta skuid 1000-59999 reject' \
  'ip6 daddr fd00:ec2::254 meta skuid 1000-59999 reject' \
  'type filter hook output priority filter; policy accept;'; do
  grep -qF -- "$want" "$RULES" || fail "ruleset: has rule" "$want" "missing"
done
# Its own table, replaced whole: never `flush ruleset`, which takes Docker's too.
grep -q 'flush ruleset' "$RULES" && fail "ruleset: leaves other tables alone" "no flush ruleset" "flush ruleset"
got="$(grep -E '^(table|delete table)' "$RULES" | tr '\n' ';')"
want="table inet termag_imds;delete table inet termag_imds;table inet termag_imds {;"
[ "$got" = "$want" ] || fail "ruleset: declare, delete, redefine" "$want" "$got"

# ── the image wiring ──────────────────────────────────────────────────────────
installed=/usr/local/lib/termag/termag-imds-guard.nft
grep -qx "ExecStart=/usr/sbin/nft -f $installed" "$UNIT" \
  || fail "unit: loads the installed ruleset" "ExecStart=/usr/sbin/nft -f $installed" "$(grep ExecStart "$UNIT")"
# A reload reapplies the rules without restarting the units that require it.
grep -qx "ExecReload=/usr/sbin/nft -f $installed" "$UNIT" \
  || fail "unit: reload reloads the ruleset" "ExecReload=/usr/sbin/nft -f $installed" "$(grep ExecReload "$UNIT")"
before="$(grep '^Before=' "$UNIT")"
for t in network-pre.target systemd-user-sessions.service; do
  case " ${before#Before=} " in *" $t "*) ;; *) fail "unit: ordered before $t" "$t in Before=" "$before" ;; esac
done
grep -qx 'DefaultDependencies=no' "$UNIT" || fail "unit: can run before network-pre" "DefaultDependencies=no" "missing"
for want in \
  "deploy/termag-imds-guard.nft $installed" \
  'deploy/termag-imds-guard.service /etc/systemd/system/termag-imds-guard.service' \
  'systemctl enable --now termag-imds-guard.service' \
  'systemctl disable nftables.service' \
  'for unit in user@.service ssh.service; do' \
  'deploy/termag-imds-guard-required.conf "/etc/systemd/system/$unit.d/termag-imds-guard.conf"'; do
  grep -qF -- "$want" "$SETUP" || fail "orchestrator-setup.sh: wires the guard" "$want" "missing"
done
# The drop-in: user managers and sshd start only after the guard started.
for want in Requires=termag-imds-guard.service After=termag-imds-guard.service \
  'ExecStartPre=+/usr/bin/systemctl reload termag-imds-guard.service'; do
  grep -qx "$want" "$DROPIN" || fail "drop-in: $want" "$want" "$(grep -vE '^(#|$)' "$DROPIN" | tr '\n' ';')"
done
# /usr/local/lib/termag is recreated from scratch earlier in the same script.
wipe="$(grep -n 'rm -rf /usr/local/lib/termag$' "$SETUP" | cut -d: -f1)"
inst="$(grep -nF "deploy/termag-imds-guard.nft $installed" "$SETUP" | cut -d: -f1)"
[ -n "$wipe" ] && [ -n "$inst" ] && [ "$inst" -gt "$wipe" ] \
  || fail "orchestrator-setup.sh: installs the ruleset after recreating $installed's dir" "line > ${wipe:-?}" "${inst:-missing}"

# A running manager doesn't start again, so the rules are reapplied before
# the agent restarts.
grep -qx 'systemctl reload termag-imds-guard.service' "$HOST_SETUP" \
  || fail "host-setup: reloads the guard before restarting the agent" "systemctl reload termag-imds-guard.service" "missing"

# The guard's range is the host-account range: termag-host-setup refuses
# existing accounts outside it and creates new ones inside it.
grep -qF 'uid < 1000 || uid >= 60000' "$HOST_SETUP" \
  || fail "host-setup: refuses existing accounts outside 1000-59999" "uid < 1000 || uid >= 60000" "missing"
grep -qF -- '-K UID_MAX=59999' "$HOST_SETUP" \
  || fail "host-setup: creates accounts inside 1000-59999" "-K UID_MAX=59999" "missing"

# ── real rules in a throwaway network namespace ───────────────────────────────
live=1
[ "$(id -u)" -eq 0 ] || live=0
for c in unshare ip nft setpriv python3; do
  command -v "$c" >/dev/null 2>&1 || live=0
done
if [ "$live" -eq 1 ]; then
  cat >"$WORK/probe.py" <<'EOF'
import socket, sys
try:
    socket.create_connection((sys.argv[1], 80), timeout=2).close()
    print("open")
except ConnectionRefusedError:
    print("refused")
except OSError as e:
    print("error:%s" % e)
EOF
  # The probes run as other uids.
  chmod 755 "$WORK"
  chmod 644 "$WORK/probe.py"
  cat >"$WORK/live.sh" <<EOF
set -u
ip link set lo up
ip addr add 169.254.169.254/32 dev lo
ip -6 addr add fd00:ec2::254/128 dev lo nodad
cd "$WORK"
python3 -m http.server 80 --bind 169.254.169.254 >/dev/null 2>&1 &
p4=\$!
python3 -m http.server 80 --bind fd00:ec2::254 >/dev/null 2>&1 &
p6=\$!
trap 'kill \$p4 \$p6 2>/dev/null' EXIT
for _ in \$(seq 50); do
  [ "\$(python3 probe.py 169.254.169.254)\$(python3 probe.py fd00:ec2::254)" = openopen ] && break
  sleep 0.1
done
nft -f "$RULES" && nft -f "$RULES" || { echo "load failed"; exit 1; }
echo "rules \$(nft list table inet termag_imds | grep -c reject)"
for addr in 169.254.169.254 ::ffff:169.254.169.254 fd00:ec2::254; do
  for uid in 0 999 1000 1500 59999 60000; do
    echo "\$addr \$uid \$(setpriv --reuid=\$uid --regid=\$uid --clear-groups python3 probe.py \$addr)"
  done
done
EOF
  unshare -n sh "$WORK/live.sh" >"$WORK/live.out" 2>&1
  got="$(awk '$1 == "rules" { print $2 }' "$WORK/live.out")"
  [ "$got" = 2 ] || fail "live: reloading replaces, not stacks" "2 reject rules" "${got:-$(cat "$WORK/live.out")}"
  # An AF_INET6 socket to the v4-mapped address sends IPv4, so the ip rule covers it.
  for addr in 169.254.169.254 ::ffff:169.254.169.254 fd00:ec2::254; do
    for pair in 0:open 999:open 1000:refused 1500:refused 59999:refused 60000:open; do
      uid="${pair%%:*}" want="${pair#*:}"
      got="$(awk -v a="$addr" -v u="$uid" '$1 == a && $2 == u { print $3 }' "$WORK/live.out")"
      [ "$got" = "$want" ] || fail "live: uid $uid to $addr" "$want" "${got:-$(cat "$WORK/live.out")}"
    done
  done
  echo "termag-imds-guard: live network-namespace checks ran"
elif [ "${TERMAG_IMDS_GUARD_REQUIRE_LIVE:-}" = 1 ]; then
  fail "live checks ran" "root, unshare, ip, nft, setpriv, python3" "skipped"
else
  echo "termag-imds-guard: SKIP live checks (need root, unshare, ip, nft, setpriv, python3)"
fi

if [ "$failures" -eq 0 ]; then
  echo "termag-imds-guard: all tests passed"
else
  echo "termag-imds-guard: $failures failure(s)"
  exit 1
fi
