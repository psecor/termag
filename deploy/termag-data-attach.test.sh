#!/bin/sh
# Tests deploy/termag-data-attach.
#
# The properties that matter: the volume is attached only when it is
# `available` (one attached to another instance is waited for and never
# detached), a volume in another AZ or a bad config stops the unit for good
# (exit 2), host storage is marked ready only after the volume is mounted and
# /home is its bind, accounts are re-adopted with the UID their home uses, and
# a host on the older cloud-init (which mounts the volume itself) gets the
# ready file without being re-adopted.
#
# aws, curl, findmnt, mount, blkid, mkfs.ext4, rsync, id, getent, groupadd,
# useradd, loginctl, systemctl, stat and sleep are stubbed, and every path lives under
# TERMAG_DATA_ATTACH_ROOT, so this touches nothing real.
#
# Run: sh deploy/termag-data-attach.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-data-attach"
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
mkdir -p "$STUB"
VOL=vol-0123456789abcdef0
SELF=i-0green0000000000
BLUE=i-0blue00000000000

# Mount table: $WORK/state/mnt-srv and mnt-home hold the SOURCE findmnt prints.
cat >"$STUB/findmnt" <<EOF
#!/bin/sh
while [ \$# -gt 0 ]; do
  case "\$1" in --mountpoint) shift; mp="\$1" ;; esac
  shift
done
case "\$mp" in
  /srv/termag) f="$WORK/state/mnt-srv" ;;
  /home) f="$WORK/state/mnt-home" ;;
  *) exit 1 ;;
esac
[ -f "\$f" ] && cat "\$f"
EOF
cat >"$STUB/mount" <<EOF
#!/bin/sh
echo "mount \$*" >>"$WORK/state/log"
if [ "\$1" = --bind ]; then
  [ -f "$WORK/state/mnt-srv" ] || exit 32
  echo "\$(cat "$WORK/state/mnt-srv")[/home]" >"$WORK/state/mnt-home"
else
  echo "\$1" >"$WORK/state/mnt-srv"
fi
EOF
# describe-volumes answers the next line of $WORK/state/volumes (the last line
# repeats); attach-volume and create-tags are logged.
cat >"$STUB/aws" <<EOF
#!/bin/sh
echo "aws \$*" >>"$WORK/state/log"
case "\$2" in
  describe-volumes)
    n=\$(cat "$WORK/state/vol-n" 2>/dev/null || echo 1)
    total=\$(wc -l <"$WORK/state/volumes")
    [ "\$n" -gt "\$total" ] && n=\$total
    sed -n "\${n}p" "$WORK/state/volumes"
    echo \$((n + 1)) >"$WORK/state/vol-n"
    ;;
  attach-volume) [ ! -f "$WORK/state/attach-fails" ] ;;
esac
EOF
cat >"$STUB/curl" <<EOF
#!/bin/sh
for a; do last="\$a"; done
case "\$last" in
  */api/token) echo tok ;;
  */instance-id) echo $SELF ;;
  */placement/availability-zone) cat "$WORK/state/az" ;;
esac
EOF
cat >"$STUB/blkid" <<EOF
#!/bin/sh
[ -f "$WORK/state/blank" ] || echo ext4
EOF
printf '#!/bin/sh\necho "mkfs.ext4 $*" >>"%s"\nrm -f "%s"\n' "$WORK/state/log" "$WORK/state/blank" >"$STUB/mkfs.ext4"
printf '#!/bin/sh\necho "rsync $*" >>"%s"\n' "$WORK/state/log" >"$STUB/rsync"
printf '#!/bin/sh\nexit 0\n' >"$STUB/sleep"
# Accounts: $WORK/state/users/<name> holds the uid.
cat >"$STUB/id" <<EOF
#!/bin/sh
[ "\$1" = -u ] || [ "\$1" = -g ] || exit 1
[ -f "$WORK/state/users/\$2" ] && cat "$WORK/state/users/\$2" && exit 0
exit 1
EOF
cat >"$STUB/getent" <<EOF
#!/bin/sh
[ "\$1" = passwd ] && grep -lx "\$2" "$WORK/state/users"/* >/dev/null 2>&1 && exit 0
exit 2
EOF
printf '#!/bin/sh\necho "groupadd $*" >>"%s"\n' "$WORK/state/log" >"$STUB/groupadd"
cat >"$STUB/useradd" <<EOF
#!/bin/sh
for a; do name="\$a"; done
uid=""; prev=""
for a; do [ "\$prev" = -u ] && uid="\$a"; prev="\$a"; done
echo "\$uid" >"$WORK/state/users/\$name"
echo "useradd \$*" >>"$WORK/state/log"
EOF
printf '#!/bin/sh\necho "loginctl $*" >>"%s"\n' "$WORK/state/log" >"$STUB/loginctl"
printf '#!/bin/sh\necho "systemctl $*" >>"%s"\n' "$WORK/state/log" >"$STUB/systemctl"
# A home's owner is the number in its .uid file.
cat >"$STUB/stat" <<'EOF'
#!/bin/sh
cat "$3/.uid"
EOF
chmod +x "$STUB"/*

ROOTDIR="$WORK/root"
setup() { # setup <az>: a fresh host with the volume configured
  rm -rf "$WORK/state" "$ROOTDIR"
  mkdir -p "$WORK/state/users" "$ROOTDIR/etc/termag" "$ROOTDIR/dev/disk/by-id" "$ROOTDIR/home" \
    "$ROOTDIR/srv/termag/home/alice" "$ROOTDIR/srv/termag/home/bob"
  echo 1500 >"$ROOTDIR/srv/termag/home/alice/.uid"
  echo 1600 >"$ROOTDIR/srv/termag/home/bob/.uid"
  echo 1600 >"$WORK/state/users/bob"
  : >"$WORK/state/log"
  echo "${1:-us-east-1a}" >"$WORK/state/az"
  printf 'VOLUME_ID=%s\nREGION=us-east-1\n' "$VOL" >"$ROOTDIR/etc/termag/data-volume"
  : >"$ROOTDIR/dev/nvme1n1"
  ln -s "$ROOTDIR/dev/nvme1n1" "$ROOTDIR/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_vol${VOL#vol-}"
}
volumes() { printf '%s\n' "$@" >"$WORK/state/volumes"; }
run() {
  out="$(PATH="$STUB:$PATH" TERMAG_DATA_ATTACH_ROOT="$ROOTDIR" bash "$SCRIPT" 2>&1)"
  rc=$?
}
log_has() { grep -q -- "$1" "$WORK/state/log"; }
ready() { [ -f "$ROOTDIR/run/termag/host-storage-ready" ]; }

# ── available: attach, mount, bind, adopt, ready, tag ────────────────────────
setup
volumes "us-east-1a available None None" "us-east-1a in-use $SELF attaching" "us-east-1a in-use $SELF attached"
run
[ "$rc" -eq 0 ] || fail "available: succeeds" "exit 0" "exit $rc ($out)"
log_has "attach-volume --volume-id $VOL --instance-id $SELF --device /dev/sdf" \
  || fail "available: attached to this instance" "attach-volume" "$(cat "$WORK/state/log")"
log_has "^mount $ROOTDIR/dev/nvme1n1 /srv/termag$" || fail "available: mounted by serial" "mount nvme1n1" "$(cat "$WORK/state/log")"
log_has "^mount --bind /srv/termag/home /home$" || fail "available: /home bound" "mount --bind" "$(cat "$WORK/state/log")"
log_has "rsync -aXS --ignore-existing" || fail "available: image homes copied without overwriting" "rsync --ignore-existing" "$(cat "$WORK/state/log")"
log_has "useradd -M -s /bin/bash -d /home/alice -u 1500 -g 1500 alice" \
  || fail "available: alice adopted with her home's uid" "useradd -u 1500 alice" "$(cat "$WORK/state/log")"
log_has "useradd.* bob$" && fail "available: existing bob left alone" "no useradd bob" "$(cat "$WORK/state/log")"
log_has "loginctl enable-linger alice" || fail "available: alice lingers" "enable-linger alice" "$(cat "$WORK/state/log")"
log_has "mkfs" && fail "available: a formatted volume is not reformatted" "no mkfs" "$(cat "$WORK/state/log")"
log_has "try-restart" && fail "available: no manager restarted (bob doesn't linger, alice just adopted)" "no try-restart" "$(cat "$WORK/state/log")"
log_has "^systemctl start --no-block termag-apps.service$" || fail "available: hosted apps registered after the mount" "start termag-apps" "$(cat "$WORK/state/log")"
apps="$(grep -n 'termag-apps' "$WORK/state/log" | cut -d: -f1)"
last_mount="$(grep -n '^mount' "$WORK/state/log" | tail -1 | cut -d: -f1)"
[ "$last_mount" -lt "$apps" ] || fail "available: apps started after the mounts" "line $last_mount < $apps" "$(cat "$WORK/state/log")"
ready || fail "available: ready file written" "host-storage-ready" "absent ($out)"
log_has "create-tags --resources $VOL --tags Key=TermagHostStorageReady,Value=$SELF" \
  || fail "available: volume tagged ready" "create-tags" "$(cat "$WORK/state/log")"
# Ready comes last: after both mounts and the adoption.
order="$(grep -nE '^(mount|useradd)' "$WORK/state/log" | tail -1 | cut -d: -f1)"
tag="$(grep -n 'create-tags' "$WORK/state/log" | cut -d: -f1)"
[ "$order" -lt "$tag" ] || fail "available: tagged after mount and adoption" "line $order < $tag" "$(cat "$WORK/state/log")"

# ── attached to blue: wait, never detach, attach once blue lets go ───────────
setup
volumes "us-east-1a in-use $BLUE attached" "us-east-1a in-use $BLUE attached" "us-east-1a in-use $BLUE detaching" \
  "us-east-1a available None None" "us-east-1a in-use $SELF attached"
run
[ "$rc" -eq 0 ] || fail "blue holds it: succeeds once released" "exit 0" "exit $rc ($out)"
log_has "detach-volume" && fail "blue holds it: never detaches" "no detach-volume" "$(cat "$WORK/state/log")"
[ "$(grep -c 'attach-volume' "$WORK/state/log")" -eq 1 ] || fail "blue holds it: attaches once, after release" "1 attach" "$(cat "$WORK/state/log")"
first_attach="$(grep -n 'attach-volume' "$WORK/state/log" | cut -d: -f1)"
[ "$(head -n "$first_attach" "$WORK/state/log" | grep -c describe-volumes)" -eq 4 ] \
  || fail "blue holds it: attach only after available" "4 describes first" "$(cat "$WORK/state/log")"
echo "$out" | grep -q "waiting for $VOL: attached to $BLUE" || fail "blue holds it: logs the holder" "waiting ... $BLUE" "$out"
ready || fail "blue holds it: ready in the end" "ready" "absent"

# ── attach-volume fails once (IAM propagation): retried ──────────────────────
setup
touch "$WORK/state/attach-fails"
volumes "us-east-1a available None None"
cat >"$STUB/sleep" <<EOF
#!/bin/sh
rm -f "$WORK/state/attach-fails"
printf '%s\n' "us-east-1a available None None" "us-east-1a in-use $SELF attached" >"$WORK/state/volumes"
echo 1 >"$WORK/state/vol-n"
EOF
chmod +x "$STUB/sleep"
run
[ "$rc" -eq 0 ] || fail "attach fails once: retried" "exit 0" "exit $rc ($out)"
[ "$(grep -c 'attach-volume' "$WORK/state/log")" -eq 2 ] || fail "attach fails once: two attempts" "2" "$(grep -c attach-volume "$WORK/state/log")"
printf '#!/bin/sh\nexit 0\n' >"$STUB/sleep"

# ── already attached to this instance (a reboot): mount, no attach ───────────
# alice and bob exist from the first boot; logind already started bob's
# lingering manager against the root disk's /home. carol (an admin, say)
# doesn't linger.
setup
echo 1500 >"$WORK/state/users/alice"
mkdir -p "$ROOTDIR/srv/termag/home/carol" "$ROOTDIR/var/lib/systemd/linger"
echo 1700 >"$ROOTDIR/srv/termag/home/carol/.uid"
echo 1700 >"$WORK/state/users/carol"
: >"$ROOTDIR/var/lib/systemd/linger/alice"
: >"$ROOTDIR/var/lib/systemd/linger/bob"
volumes "us-east-1a in-use $SELF attached"
run
[ "$rc" -eq 0 ] || fail "reboot: succeeds" "exit 0" "exit $rc ($out)"
log_has "attach-volume" && fail "reboot: no attach" "no attach-volume" "$(cat "$WORK/state/log")"
log_has "^mount $ROOTDIR/dev/nvme1n1 /srv/termag$" || fail "reboot: mounted" "mount" "$(cat "$WORK/state/log")"
log_has "useradd" && fail "reboot: no account recreated" "no useradd" "$(cat "$WORK/state/log")"
log_has "^systemctl try-restart user@1500.service$" || fail "reboot: alice's lingering manager restarted" "try-restart user@1500" "$(cat "$WORK/state/log")"
log_has "^systemctl try-restart user@1600.service$" || fail "reboot: bob's lingering manager restarted" "try-restart user@1600" "$(cat "$WORK/state/log")"
log_has "user@1700" && fail "reboot: carol (not lingering) left alone" "no restart of 1700" "$(cat "$WORK/state/log")"
bind="$(grep -n '^mount --bind' "$WORK/state/log" | cut -d: -f1)"
restart="$(grep -n '^systemctl try-restart' "$WORK/state/log" | head -1 | cut -d: -f1)"
[ "$bind" -lt "$restart" ] || fail "reboot: managers restarted after the bind" "line $bind < $restart" "$(cat "$WORK/state/log")"
log_has "^systemctl start --no-block termag-apps.service$" || fail "reboot: hosted apps registered" "start termag-apps" "$(cat "$WORK/state/log")"
ready || fail "reboot: ready" "ready" "absent"

# ── already mounted (restart after a partial run): no second mount ───────────
setup
volumes "us-east-1a in-use $SELF attached"
echo /dev/nvme1n1 >"$WORK/state/mnt-srv"
run
[ "$rc" -eq 0 ] || fail "half done: succeeds" "exit 0" "exit $rc ($out)"
log_has "^mount /dev\|^mount $ROOTDIR/dev" && fail "half done: volume not mounted twice" "bind only" "$(cat "$WORK/state/log")"
log_has "^mount --bind" || fail "half done: bind finished" "mount --bind" "$(cat "$WORK/state/log")"
ready || fail "half done: ready" "ready" "absent"

# ── restart once fully mounted: managers left alone ──────────────────────────
setup
mkdir -p "$ROOTDIR/var/lib/systemd/linger" && : >"$ROOTDIR/var/lib/systemd/linger/bob"
volumes "us-east-1a in-use $SELF attached"
echo /dev/nvme1n1 >"$WORK/state/mnt-srv"
echo '/dev/nvme1n1[/home]' >"$WORK/state/mnt-home"
run
[ "$rc" -eq 0 ] || fail "all done: succeeds" "exit 0" "exit $rc ($out)"
log_has "^mount" && fail "all done: nothing mounted" "no mount" "$(cat "$WORK/state/log")"
log_has "try-restart" && fail "all done: no manager restarted" "no try-restart" "$(cat "$WORK/state/log")"
ready || fail "all done: ready" "ready" "absent"

# ── blank volume: formatted once ─────────────────────────────────────────────
setup
touch "$WORK/state/blank"
volumes "us-east-1a in-use $SELF attached"
run
log_has "mkfs.ext4 -L termag-data $ROOTDIR/dev/nvme1n1" || fail "blank: formatted" "mkfs.ext4 -L termag-data" "$(cat "$WORK/state/log")"

# ── wrong AZ: exit 2, nothing attached or ready ──────────────────────────────
setup us-east-1b
volumes "us-east-1a available None None"
run
[ "$rc" -eq 2 ] || fail "wrong AZ: exit 2" "exit 2" "exit $rc ($out)"
log_has "attach-volume" && fail "wrong AZ: not attached" "no attach" "$(cat "$WORK/state/log")"
ready && fail "wrong AZ: not ready" "no ready file" "ready"

# ── bad config: exit 2 ───────────────────────────────────────────────────────
setup
printf 'VOLUME_ID=%s\nREGION=us-east-1\n' 'vol-;reboot' >"$ROOTDIR/etc/termag/data-volume"
volumes "us-east-1a available None None"
run
[ "$rc" -eq 2 ] || fail "bad config: exit 2" "exit 2" "exit $rc ($out)"
log_has "^aws" && fail "bad config: no AWS call" "none" "$(cat "$WORK/state/log")"

# ── the device never shows up: fails (the unit restarts), not ready ──────────
setup
rm -f "$ROOTDIR/dev/disk/by-id/"*
volumes "us-east-1a in-use $SELF attached"
run
{ [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; } || fail "no device: restartable failure" "exit 1" "exit $rc ($out)"
ready && fail "no device: not ready" "no ready file" "ready"

# ── older cloud-init mounted the volume itself: ready, no adoption ───────────
setup
rm -f "$ROOTDIR/etc/termag/data-volume"
mkdir -p "$ROOTDIR/var/lib/cloud/instance" && : >"$ROOTDIR/var/lib/cloud/instance/boot-finished"
echo /dev/nvme1n1 >"$WORK/state/mnt-srv"
echo '/dev/nvme1n1[/home]' >"$WORK/state/mnt-home"
run
[ "$rc" -eq 0 ] || fail "older cloud-init: succeeds" "exit 0" "exit $rc ($out)"
ready || fail "older cloud-init: ready" "ready" "absent"
log_has "useradd\|^aws\|^mount" && fail "older cloud-init: nothing else done" "no calls" "$(cat "$WORK/state/log")"

# ── no config and no volume: exit 0, never ready ─────────────────────────────
setup
rm -f "$ROOTDIR/etc/termag/data-volume"
mkdir -p "$ROOTDIR/var/lib/cloud/instance" && : >"$ROOTDIR/var/lib/cloud/instance/boot-finished"
run
[ "$rc" -eq 0 ] || fail "no volume: exits 0" "exit 0" "exit $rc ($out)"
ready && fail "no volume: never ready" "no ready file" "ready"

# ── /home bound to something else: not ready ─────────────────────────────────
setup
rm -f "$ROOTDIR/etc/termag/data-volume"
mkdir -p "$ROOTDIR/var/lib/cloud/instance" && : >"$ROOTDIR/var/lib/cloud/instance/boot-finished"
echo /dev/nvme1n1 >"$WORK/state/mnt-srv"
echo '/dev/nvme2n1[/home]' >"$WORK/state/mnt-home"
run
ready && fail "foreign /home: not ready" "no ready file" "ready"

if [ "$failures" -eq 0 ]; then
  echo "termag-data-attach: all tests passed"
else
  echo "termag-data-attach: $failures failure(s)"
  exit 1
fi
