#!/bin/bash
# Mount the bake's scratch volume and point the throwaway, write-heavy paths at
# it, so they never reach the AMI's snapshot.
#
# Environment (optional):
#   SCRATCH_MOUNT   where to mount     default /mnt/termag-bake-scratch
set -euo pipefail

log() { echo "[packer/scratch] $*"; }

MOUNT=${SCRATCH_MOUNT:-/mnt/termag-bake-scratch}
MARKER_DIR=/var/lib/termag-bake
MARKER=$MARKER_DIR/scratch
BAZELRC=/etc/bazel.bazelrc
APT_CONF=/etc/apt/apt.conf.d/99-termag-bake-scratch

sudo install -d -m 755 "$MARKER_DIR"

for f in "$MARKER" "$BAZELRC" "$APT_CONF"; do
    if sudo test -e "$f"; then
        log "ERROR: $f already exists on the source image (detach-scratch.sh did not run when it was baked?); refusing to bake on top of it"
        exit 1
    fi
done

root_disk=$(lsblk -n -o PKNAME,MOUNTPOINT | awk '$2 == "/" { print $1; exit }')
candidates=()
while read -r name; do
    [ "$name" = "$root_disk" ] && continue
    dev=/dev/$name
    [ "$(lsblk -n -o NAME "$dev" | wc -l)" -eq 1 ] || continue
    [ -z "$(sudo blkid -o value -s TYPE "$dev" 2>/dev/null)" ] || continue
    [ -z "$(lsblk -n -o MOUNTPOINT "$dev" | tr -d '[:space:]')" ] || continue
    candidates+=("$dev")
done < <(lsblk -d -n -o NAME,TYPE | awk '$2 == "disk" { print $1 }')

if [ ${#candidates[@]} -eq 0 ]; then
    log "no blank scratch disk attached; throwaway writes stay on the root volume"
    exit 0
fi
if [ ${#candidates[@]} -gt 1 ]; then
    log "ERROR: ${#candidates[@]} blank disks attached (${candidates[*]}); expected the one box.pkr.hcl maps"
    exit 1
fi
dev=${candidates[0]}

sudo mkfs.ext4 -q -L termag-bake-scratch -E lazy_itable_init=1,lazy_journal_init=1 "$dev"
sudo install -d -m 755 "$MOUNT"
sudo mount -o noatime "$dev" "$MOUNT"

sudo install -d -m 755 "$MOUNT/bazel-output"
printf 'startup --output_user_root=%s/bazel-output\n' "$MOUNT" | sudo tee "$BAZELRC" >/dev/null

# apt downloads into <archives>/partial as _apt, then moves the .deb up a level.
sudo install -d -m 755 "$MOUNT/apt-archives"
sudo install -d -m 700 -o _apt -g root "$MOUNT/apt-archives/partial"
printf 'Dir::Cache::Archives "%s/apt-archives/";\n' "$MOUNT" | sudo tee "$APT_CONF" >/dev/null

echo "$MOUNT" | sudo tee "$MARKER" >/dev/null
log "scratch $dev ($(lsblk -d -n -o SIZE "$dev" | tr -d ' ')) mounted at $MOUNT; bazel's output root and apt's archives go there"
