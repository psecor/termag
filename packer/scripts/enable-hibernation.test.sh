#!/bin/sh
# Tests packer/scripts/enable-hibernation.sh's file handling on a fixture root
# (the grub drop-in, the newest-kernel check, the GA-kernel pin's selection,
# the builder-residue cleanup) and
# that box.pkr.hcl runs it and tags the AMI to match.
#
# Hermetic: no sudo, no apt, no packer. Needs bash and GNU sort -V.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT=$HERE/enable-hibernation.sh
PKR=$HERE/../box.pkr.hcl

fails=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; fails=$((fails + 1)); }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ROOT=$TMP/root

lib() {
    HIBERNATION_ROOT=$ROOT HIBERNATION_LIB_ONLY=1 SCRIPT=$SCRIPT bash -c '. "$SCRIPT"; '"$1"
}

# ── grub drop-in: appends nokaslr to whatever the cloud image set ────────────
lib write_grub_dropin
cmdline=$(bash -c 'GRUB_CMDLINE_LINUX_DEFAULT="console=tty1 console=ttyS0"; . "$1"; echo "$GRUB_CMDLINE_LINUX_DEFAULT"' _ \
    "$ROOT/etc/default/grub.d/60-termag-hibernation.cfg")
if [ "$cmdline" = "console=tty1 console=ttyS0 nokaslr" ]; then pass "drop-in appends nokaslr"; else fail "drop-in gave '$cmdline'"; fi
lib write_grub_dropin
if [ "$(grep -c nokaslr "$ROOT/etc/default/grub.d/60-termag-hibernation.cfg")" -eq 1 ]; then
    pass "rewriting the drop-in is idempotent"
else
    fail "drop-in grew on a second run"
fi

# ── newest kernel: the one the box boots, not the builder's running one ──────
mkdir -p "$ROOT/boot"
echo 'CONFIG_HIBERNATION=y' > "$ROOT/boot/config-6.8.0-1009-aws"
echo '# CONFIG_HIBERNATION is not set' > "$ROOT/boot/config-6.8.0-1021-aws"
newest=$(lib newest_kernel_config)
if [ "$newest" = "$ROOT/boot/config-6.8.0-1021-aws" ]; then pass "picks the newest kernel by version"; else fail "picked $newest"; fi
if HIBERNATION_ROOT=$ROOT HIBERNATION_LIB_ONLY=1 bash -c '. "$1"; kernel_supports_hibernation "$2"' _ "$SCRIPT" "$newest"; then
    fail "accepted a kernel without CONFIG_HIBERNATION"
else
    pass "refuses a kernel without CONFIG_HIBERNATION"
fi
if HIBERNATION_ROOT=$ROOT HIBERNATION_LIB_ONLY=1 bash -c '. "$1"; kernel_supports_hibernation "$2"' _ "$SCRIPT" "$ROOT/boot/config-6.8.0-1009-aws"; then
    pass "accepts CONFIG_HIBERNATION=y"
else
    fail "refused CONFIG_HIBERNATION=y"
fi

# ── GA-kernel pin: nothing from 6.16 on, where a Graviton resume loses ENA ───
resumes() { HIBERNATION_LIB_ONLY=1 bash -c '. "$1"; kernel_resumes_on_graviton "$2"' _ "$SCRIPT" "$1"; }
for v in 6.8.0-1067-aws 6.15.9-1001-aws 6.9.0-1001-aws; do
    if resumes "$v"; then pass "$v resumes"; else fail "$v refused"; fi
done
for v in 6.16.0-1001-aws 6.17.0-1003-aws 7.0.0-1014-aws; do
    if resumes "$v"; then fail "$v accepted"; else pass "$v refused"; fi
done

echo 'CONFIG_HIBERNATION=y' > "$ROOT/boot/config-7.0.0-1014-aws"
broken=$(lib broken_kernel_versions)
if [ "$broken" = "7.0.0-1014-aws" ]; then pass "lists only the post-6.16 kernels"; else fail "listed '$broken'"; fi
rm "$ROOT/boot/config-7.0.0-1014-aws"

packages=$(printf '%s\n' linux-image-7.0.0-1014-aws linux-image-unsigned-7.0.0-1014-aws linux-modules-7.0.0-1014-aws \
    linux-headers-7.0.0-1014-aws linux-aws-7.0-headers-7.0.0-1014 linux-aws-7.0-tools-7.0.0-1014 \
    linux-image-6.8.0-1067-aws linux-modules-6.8.0-1067-aws linux-aws-lts-24.04 linux-image-7.0.0-10140-aws linux-base)
picked=$(echo "$packages" | lib 'kernel_packages_for 7.0.0-1014-aws' | sort | tr '\n' ' ')
want="linux-aws-7.0-headers-7.0.0-1014 linux-aws-7.0-tools-7.0.0-1014 linux-headers-7.0.0-1014-aws linux-image-7.0.0-1014-aws linux-image-unsigned-7.0.0-1014-aws linux-modules-7.0.0-1014-aws "
if [ "$picked" = "$want" ]; then pass "picks every package of that kernel and nothing else"; else fail "picked '$picked'"; fi

# ── builder residue: swap files, the agent's resume offset and its state ─────
mkdir -p "$ROOT/etc" "$ROOT/var/lib/hibinit-agent" "$ROOT/srv"
printf '[core]\nswapfile = /srv/hib-swap\n' > "$ROOT/etc/hibinit-config.cfg"
for f in "$ROOT/swap" "$ROOT/swap-hibinit" "$ROOT/srv/hib-swap" "$ROOT/etc/default/grub.d/99-set-swap.cfg" \
         "$ROOT/var/lib/hibinit-agent/hibernation-enabled"; do
    echo x > "$f"
done
lib remove_builder_residue >/dev/null
left=""
for f in "$ROOT/swap" "$ROOT/swap-hibinit" "$ROOT/srv/hib-swap" "$ROOT/etc/default/grub.d/99-set-swap.cfg" "$ROOT/var/lib/hibinit-agent"; do
    [ -e "$f" ] && left="$left $f"
done
if [ -z "$left" ]; then pass "removes the builder's swap files, resume offset and agent state"; else fail "left:$left"; fi
if [ -f "$ROOT/etc/default/grub.d/60-termag-hibernation.cfg" ]; then pass "keeps termag's own drop-in"; else fail "removed the nokaslr drop-in"; fi

# ── box.pkr.hcl wiring ───────────────────────────────────────────────────────
if grep -q 'scripts/enable-hibernation.sh' "$PKR"; then pass "box.pkr.hcl runs the script"; else fail "box.pkr.hcl does not run enable-hibernation.sh"; fi
if grep -q 'HIBERNATION=${var.hibernation}' "$PKR"; then pass "the script follows var.hibernation"; else fail "HIBERNATION is not passed from var.hibernation"; fi
if grep -Eq 'Hibernation += var\.hibernation \? "supported" : "unsupported"' "$PKR"; then
    pass "the AMI tag follows var.hibernation"
else
    fail "box.pkr.hcl does not tag Hibernation from var.hibernation"
fi
hib_line=$(grep -n 'scripts/enable-hibernation.sh' "$PKR" | head -1 | cut -d: -f1)
index_line=$(grep -n 'scripts/index-home-paths.sh' "$PKR" | head -1 | cut -d: -f1)
if [ -n "$hib_line" ] && [ -n "$index_line" ] && [ "$hib_line" -lt "$index_line" ]; then
    pass "runs before the home-path index"
else
    fail "enable-hibernation.sh must run before index-home-paths.sh"
fi
setup_line=$(grep -n 'scripts/setup.sh' "$PKR" | head -1 | cut -d: -f1)
if [ -n "$hib_line" ] && [ -n "$setup_line" ] && [ "$hib_line" -gt "$setup_line" ]; then
    pass "runs after setup.sh, the last step that loads modules"
else
    fail "enable-hibernation.sh purges the running kernel and must run after setup.sh"
fi

if [ "$fails" -gt 0 ]; then
    echo "$fails check(s) failed" >&2
    exit 1
fi
echo "all enable-hibernation checks passed"
