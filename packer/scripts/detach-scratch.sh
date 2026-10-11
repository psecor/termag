#!/bin/bash
# Undo scripts/prepare-scratch.sh before the image is snapshotted.
set -euo pipefail

log() { echo "[packer/scratch] $*"; }

MARKER=/var/lib/termag-bake/scratch
BAZELRC=/etc/bazel.bazelrc
APT_CONF=/etc/apt/apt.conf.d/99-termag-bake-scratch

if ! sudo test -f "$MARKER"; then
    log "no scratch volume was mounted; nothing to detach"
    exit 0
fi
MOUNT=$(sudo cat "$MARKER")
case "$MOUNT" in
    /mnt/?*) ;;
    *) log "ERROR: unexpected scratch mount '$MOUNT' in $MARKER"; exit 1 ;;
esac

sudo rm -f "$BAZELRC" "$APT_CONF"

refs=$({
    sudo find /home/termag -xdev -type l -lname "$MOUNT*" -print
    sudo grep -rIlF -- "$MOUNT" /home/termag/.bazelrc /home/termag/.termag /home/termag/.config
} 2>/dev/null || true)
if [ -n "$refs" ]; then
    echo "[packer/scratch] the image still refers to the scratch volume; refusing to bake:" >&2
    printf '%s\n' "$refs" | sed 's/^/    /' >&2
    exit 1
fi

if sudo mountpoint -q "$MOUNT"; then
    if ! sudo umount "$MOUNT"; then
        echo "[packer/scratch] $MOUNT is busy; refusing to bake with it mounted:" >&2
        sudo fuser -vm "$MOUNT" >&2 || true
        exit 1
    fi
fi
sudo rmdir "$MOUNT"
sudo rm -f "$MARKER"
log "scratch volume detached; $BAZELRC and $APT_CONF removed"
