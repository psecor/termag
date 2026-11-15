#!/bin/bash
# PR-time half of the preview launcher's kernel gate: the GA kernel package
# enable-hibernation.sh pins the box image to (GA_KERNEL_PKG) must be the one
# preview-launcher/syscalls-arm64.txt was reviewed against (its
# "# reviewed-kernel-package:" line). check-preview-launcher.sh holds the bake
# to the same list, but only at bake time, hours after a pin change merges;
# this fails the PR instead. Box AMI CI runs it, and check-kernel-pin.test.sh.
#
# It compares the package names only: a new ABI of the same package (6.8.0-1070
# after 1069) is still caught by the bake's System.map check.
#
# Environment (test-only):
#   KERNEL_PIN_SCRIPT  the script holding GA_KERNEL_PKG (default enable-hibernation.sh)
#   KERNEL_PIN_LIST    the reviewed list (default preview-launcher/syscalls-arm64.txt)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${KERNEL_PIN_SCRIPT:-$HERE/enable-hibernation.sh}"
LIST="${KERNEL_PIN_LIST:-$HERE/../../preview-launcher/syscalls-arm64.txt}"
fail() { echo "[packer/kernel-pin] $*" >&2; exit 1; }

pinned=$(sed -n 's/^GA_KERNEL_PKG=\([^[:space:]#]*\).*/\1/p' "$SCRIPT")
[ "$(printf '%s\n' "$pinned" | grep -c .)" = 1 ] || fail "$SCRIPT should set GA_KERNEL_PKG= exactly once"
reviewed=$(sed -n 's/^# reviewed-kernel-package:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$LIST")
[ "$(printf '%s\n' "$reviewed" | grep -c .)" = 1 ] || fail "$LIST should have exactly one '# reviewed-kernel-package: <package>' line"

if [ "$pinned" != "$reviewed" ]; then
    fail "enable-hibernation.sh pins the box kernel to $pinned, but preview-launcher/syscalls-arm64.txt was reviewed against $reviewed.
The launcher's seccomp filter allows by default, so review $pinned's system calls before the box boots it,
or the bake fails in check-preview-launcher.sh. On any noble arm64 machine, no reboot needed:
  apt-cache depends \$(apt-cache depends $pinned | awk '/Depends: linux-image/ { print \$2 }')   # its release, e.g. 6.8.0-1069-aws
  r=<release>; apt-get download linux-modules-\$r
  dpkg-deb --fsys-tarfile linux-modules-\${r}_*.deb | tar -xO ./boot/System.map-\$r \\
    | awk '\$3 ~ /^__arm64_sys_/ { sub(/^__arm64_sys_/, \"\", \$3); print \$3 }' | sort -u > calls
  comm -13 <(grep -v '^#' preview-launcher/syscalls-arm64.txt | sort -u) calls   # the calls to review
Review each new call against preview-launcher/seccomp.go's deny list (deny it there if it needs to be),
then replace the list's names with those in calls, and update its reviewed-kernel-package and reviewed-kernel-release lines."
fi
echo "[packer/kernel-pin] $pinned is the kernel package preview-launcher/syscalls-arm64.txt was reviewed against"
