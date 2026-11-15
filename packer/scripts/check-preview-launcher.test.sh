#!/bin/sh
# Tests packer/scripts/check-preview-launcher.sh on a fixture root: it checks
# the kernel the image boots (the newest under /boot, its System.map and
# config), not the builder's, and that box.pkr.hcl runs it after the GA-kernel
# pin while box-lib.sh's install no longer reads the builder's /proc/kallsyms.
#
# Hermetic: no sudo, no packer, no kernel. Needs bash, GNU sort -V and comm.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT=$HERE/check-preview-launcher.sh
PKR=$HERE/../box.pkr.hcl
LIB=$HERE/box-lib.sh
REAL_LIST=$HERE/../../preview-launcher/syscalls-arm64.txt

fails=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; fails=$((fails + 1)); }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# A fixture root: the checkout's list, an installed launcher, and no kernels yet.
fresh_root() {
    ROOT=$TMP/root-$1
    mkdir -p "$ROOT/boot" "$ROOT/home/termag/src/termag/preview-launcher" "$ROOT/usr/local/bin"
    printf '# reviewed\nread\nwrite\nopenat\n' > "$ROOT/home/termag/src/termag/preview-launcher/syscalls-arm64.txt"
    printf '#!/bin/sh\necho 4\n' > "$ROOT/usr/local/bin/termag-preview"
    chmod +x "$ROOT/usr/local/bin/termag-preview"
}
# kernel <release> <system call>...: its config (Landlock on) and System.map.
kernel() {
    rel=$1; shift
    printf 'CONFIG_SECURITY_LANDLOCK=y\nCONFIG_LSM="landlock,lockdown,yama,integrity,apparmor"\n' > "$ROOT/boot/config-$rel"
    : > "$ROOT/boot/System.map-$rel"
    for c in "$@"; do
        printf 'ffff800080001000 T __arm64_sys_%s\n' "$c" >> "$ROOT/boot/System.map-$rel"
        printf 'ffff800080002000 t __se_sys_%s\n' "$c" >> "$ROOT/boot/System.map-$rel"
    done
    printf 'ffff800080003000 T vfs_read\n' >> "$ROOT/boot/System.map-$rel"
}
run() { PREVIEW_CHECK_ROOT=$ROOT bash "$SCRIPT" > "$TMP/out" 2>&1; }

# ── the box's kernel, every call reviewed ────────────────────────────────────
fresh_root ok
kernel 6.8.0-1070-aws read write openat
if run; then pass "passes a 6.8 kernel whose calls are all listed"; else fail "refused a clean 6.8 kernel: $(cat "$TMP/out")"; fi
if grep -q 'kernel 6.8.0-1070-aws: all 3 system calls' "$TMP/out"; then pass "names the kernel and counts its calls"; else fail "log: $(cat "$TMP/out")"; fi

# ── the 11-10 failure: an unreviewed call on the kernel the box boots ────────
fresh_root new-call
kernel 7.0.0-1014-aws read write openat mseal file_getattr
if run; then
    fail "accepted a kernel with unreviewed calls"
elif grep -q "boots 7.0.0-1014-aws, which has system calls preview-launcher/seccomp.go wasn't reviewed against: file_getattr mseal$" "$TMP/out"; then
    pass "refuses a kernel with unreviewed calls, naming them"
else
    fail "unexpected refusal: $(cat "$TMP/out")"
fi

# ── the boot kernel is the newest under /boot, as enable-hibernation.sh says ──
fresh_root newest
kernel 6.8.0-1067-aws read write openat mseal
kernel 6.8.0-1071-aws read write openat
if run && grep -q 'kernel 6.8.0-1071-aws' "$TMP/out"; then pass "checks the newest kernel, not an older one left in /boot"; else fail "newest: $(cat "$TMP/out")"; fi
fresh_root newest-bad
kernel 6.8.0-1067-aws read write openat
kernel 6.8.0-1100-aws read write openat mseal
if run; then fail "checked an older kernel than the one the box boots"; else pass "refuses when the newest kernel has an unreviewed call"; fi

# ── Landlock ─────────────────────────────────────────────────────────────────
fresh_root no-landlock
kernel 6.8.0-1070-aws read write openat
sed -i 's/^CONFIG_SECURITY_LANDLOCK=y/# CONFIG_SECURITY_LANDLOCK is not set/' "$ROOT/boot/config-6.8.0-1070-aws"
if run; then fail "accepted a kernel without Landlock"; elif grep -q 'built without Landlock' "$TMP/out"; then pass "refuses a kernel without Landlock"; else fail "no-landlock: $(cat "$TMP/out")"; fi
fresh_root lsm
kernel 6.8.0-1070-aws read write openat
sed -i 's/^CONFIG_LSM=.*/CONFIG_LSM="lockdown,yama,integrity,apparmor"/' "$ROOT/boot/config-6.8.0-1070-aws"
if run; then fail "accepted Landlock missing from CONFIG_LSM"; elif grep -q 'does not enable Landlock by default' "$TMP/out"; then pass "refuses Landlock left out of CONFIG_LSM"; else fail "lsm: $(cat "$TMP/out")"; fi
fresh_root old
kernel 6.6.0-1001-aws read write openat
if run; then fail "accepted a kernel before Landlock ABI 4"; elif grep -q 'predates Landlock ABI 4' "$TMP/out"; then pass "refuses a kernel before 6.7"; else fail "old: $(cat "$TMP/out")"; fi

# ── what it needs to read ────────────────────────────────────────────────────
fresh_root no-map
kernel 6.8.0-1070-aws read write openat
rm "$ROOT/boot/System.map-6.8.0-1070-aws"
if run; then fail "accepted a kernel with no System.map"; else pass "refuses a kernel with no System.map"; fi
fresh_root empty-map
kernel 6.8.0-1070-aws
if run; then fail "accepted a System.map with no system calls"; else pass "refuses a System.map naming no system calls"; fi
fresh_root no-launcher
kernel 6.8.0-1070-aws read write openat
rm "$ROOT/usr/local/bin/termag-preview"
if run; then fail "passed with no launcher installed"; else pass "refuses when termag-preview isn't installed"; fi
fresh_root no-kernel
if run; then fail "passed with no kernel in /boot"; else pass "refuses when /boot has no kernel"; fi

# ── the list itself: a read that fails or finds nothing fails the bake ───────
# The 11-10 failure: the provisioner (ubuntu) couldn't read /home/termag, the
# read was silent, and an empty list made every call unreviewed.
fresh_root empty-list
kernel 6.8.0-1070-aws read write openat
printf '# reviewed\n\n' > "$ROOT/home/termag/src/termag/preview-launcher/syscalls-arm64.txt"
if run; then fail "passed against a list with no names"; elif grep -q 'names no system calls' "$TMP/out"; then pass "refuses a list with no names"; else fail "empty-list: $(cat "$TMP/out")"; fi
if [ "$(id -u)" -ne 0 ]; then
    fresh_root unreadable
    kernel 6.8.0-1070-aws read write openat
    chmod 000 "$ROOT/home/termag/src/termag/preview-launcher/syscalls-arm64.txt"
    if run; then
        fail "passed with an unreadable list"
    elif grep -q "can't read .*syscalls-arm64.txt" "$TMP/out" && ! grep -q "wasn't reviewed against" "$TMP/out"; then
        pass "an unreadable list fails as unreadable, not as every call unreviewed"
    else
        fail "unreadable: $(cat "$TMP/out")"
    fi
    chmod 644 "$ROOT/home/termag/src/termag/preview-launcher/syscalls-arm64.txt"
else
    echo "SKIP: unreadable-list case (running as root reads anything)"
fi

# ── the real list parses: names only, no blank or duplicate lines ────────────
if grep -v '^#' "$REAL_LIST" | grep -qvE '^[a-z0-9_]+$'; then fail "syscalls-arm64.txt has a line that is not a system call name"; else pass "syscalls-arm64.txt is names only"; fi
if [ "$(grep -v '^#' "$REAL_LIST" | sort | uniq -d | wc -l)" -eq 0 ]; then pass "syscalls-arm64.txt has no duplicates"; else fail "syscalls-arm64.txt has duplicates"; fi

# ── box.pkr.hcl runs it after the GA-kernel pin; the install no longer checks the builder ──
hib=$(grep -n 'scripts/enable-hibernation.sh' "$PKR" | head -1 | cut -d: -f1)
chk=$(grep -n 'scripts/check-preview-launcher.sh' "$PKR" | head -1 | cut -d: -f1)
if [ -n "$hib" ] && [ -n "$chk" ] && [ "$chk" -gt "$hib" ]; then pass "box.pkr.hcl runs the check after enable-hibernation.sh"; else fail "box.pkr.hcl order: enable-hibernation at ${hib:-none}, check at ${chk:-none}"; fi
if grep -q 'kallsyms' "$LIB"; then fail "box-lib.sh still reads the builder's /proc/kallsyms"; else pass "box-lib.sh's install doesn't read the builder's kernel"; fi

if [ "$fails" -gt 0 ]; then echo "$fails failure(s)" >&2; exit 1; fi
echo "all passed"
