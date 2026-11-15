#!/bin/bash
# Check the kernel the box image boots against what termag-preview
# (/usr/local/bin/termag-preview, installed by box-lib.sh's
# install_preview_launcher) was reviewed for
# :
#
# - every system call the kernel has is in preview-launcher/syscalls-arm64.txt,
#   the list seccomp.go's deny list was reviewed against. The filter allows by
#   default, so a call a newer kernel adds is unreviewed, and the bake fails
#   until someone reviews it;
# - Landlock is built in and in the default LSM list, at ABI 4 or later
#   (kernel 6.7: the TCP rule that refuses port 80).
#
# The boot kernel, not the builder's. A full bake runs on Canonical's image,
# whose rolling linux-aws kernel the box never boots: enable-hibernation.sh
# pins the image to noble's GA 6.8 kernel and purges the newer ones. So this
# runs after it, reads the newest kernel under /boot as that script does
# (newest_kernel_config), and takes its system calls from that kernel's
# System.map, which names them as /proc/kallsyms does. The builder's kernel
# had 12 calls 6.8 doesn't on 11-10 (mseal, the *xattrat family,
# open_tree_attr, file_getattr, listns, ...).
#
# Every input is read as root, into a variable, and a failed or empty read
# fails the bake: provisioners run as `ubuntu`, which can't read /home/termag.
# The check #1519 put in setup.sh read the list there inside a process
# substitution, so its "Permission denied" was silent, the reviewed list came
# out empty and every call the kernel has (accept first) read as unreviewed:
# that failed every full bake after #1519.
#
# Environment:
#   PREVIEW_CHECK_LIST  the reviewed list to check against (default: the bake's
#                       checkout's)
#   PREVIEW_CHECK_ROOT  test-only path prefix for /boot, the checkout and
#                       /usr/local/bin; set, nothing runs under sudo and the
#                       launcher is not run
set -euo pipefail
log() { echo "[packer/preview-launcher] $*"; }
fail() { echo "[packer/preview-launcher] $*" >&2; exit 1; }

ROOT="${PREVIEW_CHECK_ROOT:-}"
# The bake's checkout; a box update passes its own (deploy/termag-preview-launcher-setup:
# a renamed box user's home is /home/<name>).
LIST="${PREVIEW_CHECK_LIST:-$ROOT/home/termag/src/termag/preview-launcher/syscalls-arm64.txt}"
LAUNCHER="$ROOT/usr/local/bin/termag-preview"
# Landlock ABI 4 (TCP connect and bind rules) landed in 6.7.
LANDLOCK_ABI4_KERNEL=6.7

# System.map is root-only (0600), and /home/termag isn't the provisioner's.
as_root() { if [ -n "$ROOT" ]; then "$@"; else sudo "$@"; fi; }

as_root test -f "$LIST" || fail "no $LIST to check the kernel against"
list=$(as_root cat "$LIST") || fail "can't read $LIST"
reviewed=$(printf '%s\n' "$list" | sed -e '/^#/d' -e '/^[[:space:]]*$/d' | sort -u)
[ -n "$reviewed" ] || fail "$LIST names no system calls"
[ -x "$LAUNCHER" ] || fail "$LAUNCHER is not installed (box-lib.sh install_preview_launcher)"

configs=("$ROOT"/boot/config-*)
[ -e "${configs[0]}" ] || fail "no /boot/config-* to check"
config=$(printf '%s\n' "${configs[@]}" | sort -V | tail -1)
release=${config##*/config-}
map="$ROOT/boot/System.map-$release"
as_root test -f "$map" || fail "the box boots $release, which has no $map"

calls=$(as_root awk '$3 ~ /^__arm64_sys_/ { sub(/^__arm64_sys_/, "", $3); print $3 }' "$map" | sort -u) \
    || fail "can't read $map"
[ -n "$calls" ] || fail "$map names no __arm64_sys_ system calls"
unknown=$(comm -23 <(printf '%s\n' "$calls") <(printf '%s\n' "$reviewed") | tr '\n' ' ')
if [ -n "${unknown// /}" ]; then
    fail "the box boots $release, which has system calls preview-launcher/seccomp.go wasn't reviewed against: ${unknown% }"
fi
log "kernel $release: all $(printf '%s\n' "$calls" | wc -l) system calls are in syscalls-arm64.txt"

grep -q '^CONFIG_SECURITY_LANDLOCK=y' "$config" || fail "$release is built without Landlock (CONFIG_SECURITY_LANDLOCK)"
grep -E '^CONFIG_LSM=' "$config" | grep -q 'landlock' || fail "$release does not enable Landlock by default (CONFIG_LSM)"
version=${release%%-*}
if [ "$(printf '%s\n' "$LANDLOCK_ABI4_KERNEL" "$version" | sort -V | head -1)" != "$LANDLOCK_ABI4_KERNEL" ]; then
    fail "$release predates Landlock ABI 4 ($LANDLOCK_ABI4_KERNEL): termag-preview can't refuse port 80"
fi

# The launcher's own answer, where the builder runs the kernel the box boots
# (an incremental bake, which starts from a box image).
if [ -z "$ROOT" ] && [ "$(uname -r)" = "$release" ]; then
    abi=$("$LAUNCHER" abi)
    [ "$abi" -ge 4 ] || fail "Landlock ABI $abi on $release: termag-preview can't refuse port 80"
    log "Landlock ABI $abi on the running $release"
else
    log "Landlock built in and enabled on $release (ABI 4 from $LANDLOCK_ABI4_KERNEL); the builder runs $(uname -r)"
fi
