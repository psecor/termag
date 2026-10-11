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
# What this cannot check, because the builder is neither launched with
# HibernationOptions nor NitroTPM-registered yet: that the final UEFI/NitroTPM
# image's kernel lockdown mode permits hibernation, and that a resume works on
# m9g. docs/box-hibernation.md lists the one-box spike that does.
#
# Environment:
#   HIBERNATION          true (default) | false: skip, logging why
#   HIBERNATION_ROOT     test-only path prefix for every file this touches
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

# The swap file the agent was told to use, plus the names it has defaulted to.
swap_candidates() {
    local configured=""
    if [ -f "$AGENT_CONFIG" ]; then
        configured=$(sed -n 's/^[[:space:]]*swapfile[[:space:]]*=[[:space:]]*//p' "$AGENT_CONFIG" | tail -1)
    fi
    printf '%s\n' ${configured:+"$ROOT$configured"} "$ROOT/swap" "$ROOT/swap-hibinit" | awk '!seen[$0]++'
}

# Anything hibinit-agent made on the builder. A baked swap file would cost the
# snapshot its size and first boot a lazily-restored read of every block
# (AGENTS.md, the home-path index gotcha); a baked state dir would tell the
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

if ! dpkg-query -W -f='${Status}' ec2-hibinit-agent 2>/dev/null | grep -q 'install ok installed'; then
    log "installing ec2-hibinit-agent"
    sudo apt-get -o DPkg::Lock::Timeout=600 update -y
    sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 install -y --no-install-recommends ec2-hibinit-agent
    sudo apt-get clean
    sudo rm -rf /var/lib/apt/lists/*
fi
dpkg-query -W -f='${Package} ${Version}\n' ec2-hibinit-agent
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
log "kernel $(basename "$config" | sed 's/^config-//') has CONFIG_HIBERNATION=y"

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
