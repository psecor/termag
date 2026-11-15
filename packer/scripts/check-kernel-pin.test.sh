#!/bin/sh
# Tests packer/scripts/check-kernel-pin.sh: it passes on the repo as it is, and
# fails, saying how to review the new kernel, when enable-hibernation.sh's
# GA_KERNEL_PKG and syscalls-arm64.txt's reviewed-kernel-package disagree.
#
# Hermetic: scratch copies of the two files, no apt.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK=$HERE/check-kernel-pin.sh
REAL_SCRIPT=$HERE/enable-hibernation.sh
REAL_LIST=$HERE/../../preview-launcher/syscalls-arm64.txt

fails=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; fails=$((fails + 1)); }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
run() { KERNEL_PIN_SCRIPT=$TMP/pin.sh KERNEL_PIN_LIST=$TMP/list.txt bash "$CHECK" > "$TMP/out" 2>&1; }
fresh() { cp "$REAL_SCRIPT" "$TMP/pin.sh"; cp "$REAL_LIST" "$TMP/list.txt"; }

# The package pinned today, read from the script the cases copy, so a bump that
# moves the pin and the list together keeps this test green; OTHER always differs.
CUR=$(sed -n 's/^GA_KERNEL_PKG=\([^[:space:]#]*\).*/\1/p' "$REAL_SCRIPT")
[ -n "$CUR" ] || { echo "FAIL: no GA_KERNEL_PKG= in $REAL_SCRIPT" >&2; exit 1; }
OTHER=$CUR-scratch

if bash "$CHECK" > "$TMP/out" 2>&1; then pass "the repo's pin and reviewed list agree"; else fail "the repo's pin and list disagree: $(cat "$TMP/out")"; fi

fresh
sed -i "s/^GA_KERNEL_PKG=.*/GA_KERNEL_PKG=$OTHER/" "$TMP/pin.sh"
if run; then fail "passed a pin the list wasn't reviewed against"; else pass "fails when the pin changes"; fi
if grep -qF "pins the box kernel to $OTHER, but" "$TMP/out" && grep -qF "reviewed against $CUR." "$TMP/out"; then pass "names both packages"; else fail "message: $(cat "$TMP/out")"; fi
if grep -q 'apt-get download linux-modules-' "$TMP/out" && grep -q 'System.map' "$TMP/out" && grep -q 'reviewed-kernel-package' "$TMP/out"; then
    pass "says how to list the new kernel's calls and what to update"
else fail "no review instructions: $(cat "$TMP/out")"; fi

sed -i "s/^# reviewed-kernel-package:.*/# reviewed-kernel-package: $OTHER/" "$TMP/list.txt"
if run; then pass "passes once the list records the new package"; else fail "refused a matching pin: $(cat "$TMP/out")"; fi

fresh
sed -i '/^# reviewed-kernel-package:/d' "$TMP/list.txt"
if run; then fail "passed a list that records no package"; else pass "fails when the list records no package"; fi

fresh
sed -i '/^GA_KERNEL_PKG=/d' "$TMP/pin.sh"
if run; then fail "passed a script with no GA_KERNEL_PKG"; else pass "fails when the pin can't be found"; fi

fresh
echo "# reviewed-kernel-package: $CUR" >> "$TMP/list.txt"
if run; then fail "passed a list recording the package twice"; else pass "fails on a second reviewed-kernel-package line"; fi

# A tree with CI workflows runs the check in Box AMI CI.
if [ -d "$HERE/../../.github/workflows" ]; then
  if grep -q 'packer/scripts/check-kernel-pin.sh' "$HERE/../../.github/workflows/box-ami-ci.yml"; then pass "Box AMI CI runs the check"; else fail "box-ami-ci.yml doesn't run check-kernel-pin.sh"; fi
fi

[ "$fails" -eq 0 ] || { echo "$fails failure(s)" >&2; exit 1; }
