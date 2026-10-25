#!/bin/bash
# Make the box image hibernation-capable: ec2-hibinit-agent, KASLR off, and no
# swap file or resume offset left behind from the builder.
#
# Runs in full and incremental bakes alike (an incremental bake's source image
# may predate this step), and is idempotent. It fails the bake rather than
# shipping an image box.pkr.hcl tags Hibernation=supported that can't
# hibernate; set the template's `hibernation` variable to false to bake
# without it (the AMI is then tagged Hibernation=unsupported and the
# orchestrator launches boxes from it without HibernationOptions).
#
# What the noble package (1.0.0-0ubuntu16.24.04.1) does at each boot of a box
# launched with HibernationOptions, read from its source: asks IMDSv2 for
# meta-data/hibernation/configured (so HttpTokens=required is fine), then
# fallocates /swap-hibinit at max(RAM, 4000 MB) without touching its blocks
# (touch-swap = False), re-creating it when the instance type grew, and writes
# resume=/resume_offset= to /etc/default/grub.d/99-set-swap.cfg. It refuses
# when the root has less free space than that, which is why boxProvisioner
# grows the root by the RAM size.
#
# It also pins the image to noble's GA 6.8 kernel (linux-aws-lts-24.04) and
# purges every kernel from 6.16 on. From 6.16 (upstream 713335b6ee29,
# "irqchip/gic-v3-its: Implement .msi_teardown() callback") a Graviton resume
# leaves the GICv3 ITS unprogrammed, so ENA never gets an interrupt again
# ("didn't receive a MSI-X interrupt") and the box comes back without a
# network. The rolling linux-aws meta had moved noble to 7.0, which failed
# exactly that way on the first channel box. Purging the running kernel takes
# its /lib/modules with it, which is why box.pkr.hcl runs this after every
# step that may load a module.
#
# What this cannot check, because the builder is neither launched with
# HibernationOptions nor NitroTPM-registered yet: that the final UEFI/NitroTPM
# image's kernel lockdown mode permits hibernation, and that a resume works on
# m9g. docs/box-hibernation.md lists the one-box spike that does.
#
# Environment:
#   HIBERNATION          true (default) | false: skip, logging why
#   HIBERNATION_ROOT     test-only path prefix for the files this reads and writes
#   HIBERNATION_LIB_ONLY 1 = define the functions and return (for the test)
set -euo pipefail

log() { echo "[packer/hibernation] $*"; }

ROOT="${HIBERNATION_ROOT:-}"
GRUB_DROPIN="$ROOT/etc/default/grub.d/60-termag-hibernation.cfg"
# Written by hibinit-agent for the instance it runs on: the swap file's
# resume_offset is that instance's, so it must not be baked.
AGENT_GRUB_DROPIN="$ROOT/etc/default/grub.d/99-set-swap.cfg"
AGENT_STATE_DIR="$ROOT/var/lib/hibinit-agent"
AGENT_CONFIG="$ROOT/etc/hibinit-config.cfg"

# AWS's guidance for Ubuntu: hibernation needs KASLR off. A drop-in so the
# cloud image's own 50-cloudimg-settings.cfg stays untouched.
write_grub_dropin() {
    mkdir -p "$(dirname "$GRUB_DROPIN")"
    cat > "$GRUB_DROPIN" <<'EOF'
# termag: EC2 hibernation needs KASLR off (packer/scripts/enable-hibernation.sh).
GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT nokaslr"
EOF
}

# The config of the newest installed kernel, which is what the box boots:
# a full bake upgrades the kernel without rebooting the builder into it.
newest_kernel_config() {
    local configs=("$ROOT"/boot/config-*)
    [ -e "${configs[0]}" ] || return 1
    printf '%s\n' "${configs[@]}" | sort -V | tail -1
}

kernel_supports_hibernation() {
    grep -qx 'CONFIG_HIBERNATION=y' "$1"
}

GA_KERNEL_PKG=linux-aws-lts-24.04
ROLLING_KERNEL_PKGS="linux-aws linux-image-aws linux-headers-aws linux-tools-aws"
FIRST_BROKEN_KERNEL=6.16

kernel_version_of_config() {
    basename "$1" | sed 's/^config-//'
}

# $1 is a kernel release (7.0.0-1014-aws): whether it predates the ITS regression.
kernel_resumes_on_graviton() {
    [ "$(printf '%s\n' "$FIRST_BROKEN_KERNEL" "${1%%-*}" | sort -V | head -1)" != "$FIRST_BROKEN_KERNEL" ]
}

broken_kernel_versions() {
    local c v
    for c in "$ROOT"/boot/config-*; do
        [ -e "$c" ] || continue
        v=$(kernel_version_of_config "$c")
        kernel_resumes_on_graviton "$v" || echo "$v"
    done
}

# Installed package names on stdin; prints those that belong to kernel release
# $1: linux-image-unsigned-7.0.0-1014-aws, linux-aws-7.0-headers-7.0.0-1014, ...
kernel_packages_for() {
    local base=${1%-aws} p
    while read -r p; do
        case $p in linux-*-"$base"|linux-*-"$base"-aws) echo "$p" ;; esac
    done
}

installed_packages() {
    dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 'linux-*' 2>/dev/null | awk '$1 == "ii" { print $2 }'
}

# Purges exactly the rolling meta and the broken kernels; anything else apt
# would take with them fails the bake instead.
purge_broken_kernels() {
    local purge=() p v unexpected
    while read -r p; do
        case " $ROLLING_KERNEL_PKGS " in *" $p "*) purge+=("$p") ;; esac
    done < <(installed_packages)
    while read -r v; do
        [ -n "$v" ] || continue
        while read -r p; do purge+=("$p"); done < <(installed_packages | kernel_packages_for "$v")
    done < <(broken_kernel_versions)
    if [ ${#purge[@]} -eq 0 ]; then
        log "no rolling or post-${FIRST_BROKEN_KERNEL} kernel packages to purge"
        return 0
    fi
    unexpected=$(sudo apt-get -s purge "${purge[@]}" | awk '$1 == "Purg" || $1 == "Remv" { print $2 }' \
        | grep -vxF -f <(printf '%s\n' "${purge[@]}") || true)
    if [ -n "$unexpected" ]; then
        echo "[packer/hibernation] purging the post-${FIRST_BROKEN_KERNEL} kernels would also remove: $unexpected" >&2
        exit 1
    fi
    log "purging ${purge[*]}"
    sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 purge -y "${purge[@]}"
}

# The swap file the agent was told to use, plus the names it has defaulted to.
swap_candidates() {
    local configured=""
    if [ -f "$AGENT_CONFIG" ]; then
        configured=$(sed -n 's/^[[:space:]]*swapfile[[:space:]]*=[[:space:]]*//p' "$AGENT_CONFIG" | tail -1)
    fi
    printf '%s\n' ${configured:+"$ROOT$configured"} "$ROOT/swap" "$ROOT/swap-hibinit" | awk '!seen[$0]++'
}

# Anything hibinit-agent made on the builder. A baked swap file would cost the
# snapshot its size and first boot a lazily-restored read of every block;
# a baked state dir would tell the
# box's agent its setup is already done.
remove_builder_residue() {
    local f
    while read -r f; do
        [ -n "$f" ] && [ -f "$f" ] || continue
        if [ -z "$ROOT" ]; then sudo swapoff "$f" 2>/dev/null || true; fi
        rm -f "$f"
        log "removed builder swap file $f"
    done < <(swap_candidates)
    rm -f "$AGENT_GRUB_DROPIN"
    rm -rf "$AGENT_STATE_DIR"
}

if [ "${HIBERNATION_LIB_ONLY:-}" = 1 ]; then
    # shellcheck disable=SC2317  # reached only when sourced
    return 0 2>/dev/null || exit 0
fi

if [ "${HIBERNATION:-true}" != true ]; then
    log "HIBERNATION=${HIBERNATION:-}: baking without hibernation support"
    exit 0
fi

log "installing ec2-hibinit-agent and $GA_KERNEL_PKG"
sudo apt-get -o DPkg::Lock::Timeout=600 update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends \
    ec2-hibinit-agent "$GA_KERNEL_PKG"
purge_broken_kernels
sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/*
dpkg-query -W -f='${Package} ${Version}\n' ec2-hibinit-agent "$GA_KERNEL_PKG"
# The builder has no HibernationOptions, so the agent should have done nothing
# here; stop it anyway before cleaning up after it.
sudo systemctl stop hibinit-agent.service 2>/dev/null || true
sudo systemctl enable hibinit-agent.service
systemctl is-enabled hibinit-agent.service >/dev/null

config=$(newest_kernel_config) || { echo "[packer/hibernation] no /boot/config-* to check" >&2; exit 1; }
if ! kernel_supports_hibernation "$config"; then
    echo "[packer/hibernation] $config has no CONFIG_HIBERNATION=y; this kernel cannot hibernate" >&2
    exit 1
fi
kernel=$(kernel_version_of_config "$config")
if ! kernel_resumes_on_graviton "$kernel"; then
    echo "[packer/hibernation] the box would boot $kernel, which cannot resume on Graviton (>= $FIRST_BROKEN_KERNEL)" >&2
    exit 1
fi
log "kernel $kernel has CONFIG_HIBERNATION=y and predates $FIRST_BROKEN_KERNEL"

sudo bash -c "$(declare -f write_grub_dropin); GRUB_DROPIN='$GRUB_DROPIN'; write_grub_dropin"
sudo update-grub
grub_cfg=/boot/grub/grub.cfg
if ! sudo grep -q 'nokaslr' "$grub_cfg"; then
    echo "[packer/hibernation] $grub_cfg has no nokaslr after update-grub" >&2
    exit 1
fi
log "nokaslr is on the kernel command line in $grub_cfg"

sudo bash -c "$(declare -f log swap_candidates remove_builder_residue); \
    ROOT=''; AGENT_CONFIG='$AGENT_CONFIG'; AGENT_GRUB_DROPIN='$AGENT_GRUB_DROPIN'; AGENT_STATE_DIR='$AGENT_STATE_DIR'; \
    remove_builder_residue"

lockdown=$(cat /sys/kernel/security/lockdown 2>/dev/null || echo unavailable)
log "builder kernel lockdown: $lockdown (the NitroTPM-registered image is not checked here)"
log "hibernation support baked"
