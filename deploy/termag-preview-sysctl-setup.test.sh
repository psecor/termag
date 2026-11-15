#!/usr/bin/env bash
# deploy/termag-preview-sysctl-setup, without root (a temp root):
# - client Fast Open on and ptrace_scope 0 are drift; applied, both drop-ins are in
#   place and the live values are 0 and 1; then nothing to do;
# - a stricter ptrace_scope (2) is left as it is, never lowered;
# - a changed drop-in is drift again;
# - it refuses to run as a user outside tests.
set -u
SETUP="$(cd "$(dirname "$0")" && pwd)/termag-preview-sysctl-setup"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
fails=0
fail() { printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3"; fails=$((fails + 1)); }
R="$WORK/root"
mkdir -p "$R/proc/sys/net/ipv4" "$R/proc/sys/kernel/yama"
echo 1 > "$R/proc/sys/net/ipv4/tcp_fastopen"
echo 0 > "$R/proc/sys/kernel/yama/ptrace_scope"
setup() { TERMAG_SYSCTL_SETUP_ROOT="$R" bash "$SETUP" "$@"; }
tfo="$R/etc/sysctl.d/60-termag-tcp-fastopen.conf"
yama="$R/etc/sysctl.d/11-termag-yama.conf"

out=$(setup --check 2>&1); got=$?
[ "$got" = 1 ] || fail 'client Fast Open on and ptrace_scope 0 are drift' 1 "$got"
for want in '60-termag-tcp-fastopen.conf is missing' 'tcp_fastopen is 1, not 0' '11-termag-yama.conf is missing' 'ptrace_scope is 0, not 1 or more'; do
  case "$out" in *"$want"*) ;; *) fail "--check names: $want" "$want" "$out" ;; esac
done
[ -e "$tfo" ] || [ -e "$yama" ] && fail '--check changes nothing' 'no drop-ins' 'written'

out=$(setup 2>&1); got=$?
[ "$got" = 0 ] || fail 'applies' 0 "$got: $out"
grep -qx 'net.ipv4.tcp_fastopen = 0' "$tfo" || fail 'the Fast Open drop-in sets 0' 'net.ipv4.tcp_fastopen = 0' "$(cat "$tfo" 2>&1)"
grep -qx 'kernel.yama.ptrace_scope = 1' "$yama" || fail 'the Yama drop-in sets 1' 'kernel.yama.ptrace_scope = 1' "$(cat "$yama" 2>&1)"
for f in "$tfo" "$yama"; do [ "$(stat -c %a "$f")" = 644 ] || fail "$(basename "$f") is 0644" 644 "$(stat -c %a "$f")"; done
[ "$(cat "$R/proc/sys/net/ipv4/tcp_fastopen")" = 0 ] || fail 'tcp_fastopen is 0 live' 0 "$(cat "$R/proc/sys/net/ipv4/tcp_fastopen")"
[ "$(cat "$R/proc/sys/kernel/yama/ptrace_scope")" = 1 ] || fail 'ptrace_scope is 1 live' 1 "$(cat "$R/proc/sys/kernel/yama/ptrace_scope")"

out=$(setup 2>&1); got=$?
[ "$got" = 0 ] && [ -z "$out" ] || fail 'a current box writes nothing' '0, silent' "$got: $out"
setup --check >/dev/null 2>&1 || fail 'no drift once applied' 0 1

# A stricter ptrace_scope is the owner's: never lowered, live or at the next boot (Devin, #1637). Another file
# configures 2, and the box runs 2: our drop-in says 2, and a re-run changes nothing.
mkdir -p "$R/etc/sysctl.d"
echo 'kernel.yama.ptrace_scope = 2' > "$R/etc/sysctl.d/10-owner.conf"
echo 2 > "$R/proc/sys/kernel/yama/ptrace_scope"
setup >/dev/null 2>&1
grep -qx 'kernel.yama.ptrace_scope = 2' "$yama" || fail 'a configured 2 is what our drop-in says' 'kernel.yama.ptrace_scope = 2' "$(grep ptrace "$yama")"
[ "$(cat "$R/proc/sys/kernel/yama/ptrace_scope")" = 2 ] || fail 'ptrace_scope 2 is left as it is' 2 "$(cat "$R/proc/sys/kernel/yama/ptrace_scope")"
out=$(setup 2>&1); got=$?
[ "$got" = 0 ] && [ -z "$out" ] || fail 'a re-run with 2 configured changes nothing' '0, silent' "$got: $out"
setup --check >/dev/null 2>&1 || fail '2 configured and live is no drift' 0 1
# The slash form, in /usr/lib/sysctl.d, counts too.
rm -f "$R/etc/sysctl.d/10-owner.conf"; mkdir -p "$R/usr/lib/sysctl.d"
echo 'kernel/yama/ptrace_scope=2' > "$R/usr/lib/sysctl.d/50-vendor.conf"
echo 1 > "$R/proc/sys/kernel/yama/ptrace_scope"
setup >/dev/null 2>&1
grep -qx 'kernel.yama.ptrace_scope = 2' "$yama" || fail 'a vendor 2 (slash form) is kept' 'kernel.yama.ptrace_scope = 2' "$(grep ptrace "$yama")"
rm -f "$R/usr/lib/sysctl.d/50-vendor.conf"
# A vendor 3 its admin masked (a same-named /etc/sysctl.d link to /dev/null) is never applied, so it doesn't count:
# with live 1, the drop-in stays 1 (Devin, #1637). Unmasked, an /etc file of the same name wins over the vendor's.
mkdir -p "$R/usr/lib/sysctl.d" "$R/etc/sysctl.d"
echo 'kernel.yama.ptrace_scope = 3' > "$R/usr/lib/sysctl.d/50-debug.conf"
ln -sf /dev/null "$R/etc/sysctl.d/50-debug.conf"
echo 1 > "$R/proc/sys/kernel/yama/ptrace_scope"
setup >/dev/null 2>&1
grep -qx 'kernel.yama.ptrace_scope = 1' "$yama" || fail 'a masked vendor 3 is ignored' 'kernel.yama.ptrace_scope = 1' "$(grep ptrace "$yama")"
rm -f "$R/etc/sysctl.d/50-debug.conf"
echo 'kernel.yama.ptrace_scope = 1' > "$R/etc/sysctl.d/50-debug.conf"
setup >/dev/null 2>&1
grep -qx 'kernel.yama.ptrace_scope = 1' "$yama" || fail 'an /etc file overrides the vendor file of its name' 'kernel.yama.ptrace_scope = 1' "$(grep ptrace "$yama")"
rm -f "$R/etc/sysctl.d/50-debug.conf" "$R/usr/lib/sysctl.d/50-debug.conf"
# 3, which can't be lowered without a reboot, stays 3.
echo 3 > "$R/proc/sys/kernel/yama/ptrace_scope"
setup >/dev/null 2>&1
grep -qx 'kernel.yama.ptrace_scope = 3' "$yama" || fail 'a live 3 stays 3' 'kernel.yama.ptrace_scope = 3' "$(grep ptrace "$yama")"
[ "$(cat "$R/proc/sys/kernel/yama/ptrace_scope")" = 3 ] || fail 'ptrace_scope 3 left as it is' 3 "$(cat "$R/proc/sys/kernel/yama/ptrace_scope")"
setup --check >/dev/null 2>&1 || fail '3 is no drift' 0 1
# 0 configured, or nothing: 1.
echo 'kernel.yama.ptrace_scope = 0' > "$R/etc/sysctl.d/10-owner.conf"
echo 0 > "$R/proc/sys/kernel/yama/ptrace_scope"
setup >/dev/null 2>&1
grep -qx 'kernel.yama.ptrace_scope = 1' "$yama" || fail 'a configured 0 gives 1' 'kernel.yama.ptrace_scope = 1' "$(grep ptrace "$yama")"
[ "$(cat "$R/proc/sys/kernel/yama/ptrace_scope")" = 1 ] || fail 'a live 0 is raised to 1' 1 "$(cat "$R/proc/sys/kernel/yama/ptrace_scope")"
rm -f "$R/etc/sysctl.d/10-owner.conf"

echo 'net.ipv4.tcp_fastopen = 1' > "$tfo"
setup --check >/dev/null 2>&1 && fail 'a changed drop-in is drift' 1 0
if [ "$(id -u)" != 0 ]; then
  bash "$SETUP" >/dev/null 2>&1 && fail 'refuses to run as a user' 1 0
fi
if [ "$fails" -gt 0 ]; then printf '%d failed\n' "$fails"; exit 1; fi
echo 'PASS: termag-preview-sysctl-setup: Fast Open and Yama drift, apply, current, a stricter Yama kept at boot (2, 3, vendor), a masked or overridden vendor value ignored, 0 raised, a changed drop-in, root only'
