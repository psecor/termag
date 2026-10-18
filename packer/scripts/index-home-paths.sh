#!/bin/bash
# Index the baked home's references to its own absolute path, so first boot can
# rewrite them without walking the volume.
#
# cloud-init renames /home/termag to /home/<owner> (buildCloudInit in
# backend/src/services/boxProvisioner.ts, terraform/box/cloudinit.sh.tftpl) and
# then has to fix every symlink target and text file that embeds the old path.
# It used to find them at boot: `find -type l -lname '/home/termag/*'` over the
# whole home and `grep -rIl /home/termag` over the toolchain dirs. A box's root
# volume is a fresh EBS volume restored lazily from the AMI snapshot, so every
# first read of an inode or block is a round trip to S3, and that walk cost
# minutes on a well-filled image -- against a 15-minute stuck-provisioning
# sweep -- to rewrite about 200 symlinks and 3 files.
#
# This runs the same walk at bake time, when the volume is warm and it takes
# seconds, and records the results under INDEX_DIR. The boot half,
# scripts/rewrite-home-paths.sh (installed here as
# /usr/local/sbin/termag-rewrite-home-paths), touches only the recorded entries.
#
# MUST be the last provisioner that runs on the instance: anything written
# under /home/termag after the index is taken is not rewritten at boot.
# scripts/home-paths.test.sh exercises both halves on a fixture home and checks
# that ordering in box.pkr.hcl.
#
# Environment (optional; the defaults are the bake):
#   HOME_DIR      home to index                        default /home/termag
#   INDEX_DIR     where the index is written           default /var/lib/termag-bake/home-paths
#   SCAN_DIRS     dirs under HOME_DIR scanned for text files, space-separated.
#                 default ".pyenv .goenv .nvm .local .cargo .config": the same
#                 set cloud-init scanned, so the rewrite's reach is unchanged.
#                 Symlinks are indexed under the whole home, as before.
#   REWRITE_SRC   rewrite-home-paths.sh to install; empty skips the install
#                 default /tmp/rewrite-home-paths.sh (where box.pkr.hcl ships it)
#   REWRITE_DEST  where to install it    default /usr/local/sbin/termag-rewrite-home-paths
#   SUDO          prefix for privileged commands; cleared when already root
set -euo pipefail

HOME_DIR=${HOME_DIR:-/home/termag}
INDEX_DIR=${INDEX_DIR:-/var/lib/termag-bake/home-paths}
SCAN_DIRS=${SCAN_DIRS-.pyenv .goenv .nvm .local .cargo .config}
REWRITE_SRC=${REWRITE_SRC-/tmp/rewrite-home-paths.sh}
REWRITE_DEST=${REWRITE_DEST:-/usr/local/sbin/termag-rewrite-home-paths}
if [ "$(id -u)" -eq 0 ]; then SUDO=; else SUDO=${SUDO-sudo}; fi

log() { echo "[index-home-paths] $*"; }

case "$HOME_DIR" in
  /*) ;;
  *) log "ERROR: HOME_DIR must be absolute: $HOME_DIR"; exit 1 ;;
esac
[ -d "$HOME_DIR" ] || { log "ERROR: $HOME_DIR is not a directory"; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
start=$(date +%s)

# Symlinks anywhere under the home whose target is inside the home. %P is the
# path relative to the starting point; NUL-separated because a name may hold
# anything.
$SUDO find "$HOME_DIR" -xdev -type l -lname "$HOME_DIR/*" -printf '%P\0' > "$tmp/symlinks"

# Text files under the scanned dirs that embed the home path. -I skips binaries
# (CPython's ELF RUNPATH is handled by cloud-init's ldconfig step, not by sed).
# grep exits 1 when a dir has no match, which is normal for a binaries-only
# ~/.cargo, so that is not an error here.
: > "$tmp/files"
# shellcheck disable=SC2086  # SCAN_DIRS is a space-separated list by contract
for d in $SCAN_DIRS; do
  [ -d "$HOME_DIR/$d" ] || continue
  { $SUDO grep -rIlZ --fixed-strings -- "$HOME_DIR" "$HOME_DIR/$d" || true; } \
    | while IFS= read -r -d '' p; do printf '%s\0' "${p#"$HOME_DIR/"}"; done >> "$tmp/files"
done

n_links=$(tr -cd '\000' < "$tmp/symlinks" | wc -c | tr -d ' ')
n_files=$(tr -cd '\000' < "$tmp/files" | wc -c | tr -d ' ')

{
  echo "home=$HOME_DIR"
  echo "scan_dirs=$SCAN_DIRS"
  echo "symlinks=$n_links"
  echo "files=$n_files"
  echo "indexed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$tmp/meta"

$SUDO mkdir -p "$INDEX_DIR"
$SUDO install -m 644 "$tmp/symlinks" "$INDEX_DIR/symlinks"
$SUDO install -m 644 "$tmp/files" "$INDEX_DIR/files"
$SUDO install -m 644 "$tmp/meta" "$INDEX_DIR/meta"

if [ -n "$REWRITE_SRC" ]; then
  if [ ! -f "$REWRITE_SRC" ]; then
    log "ERROR: $REWRITE_SRC is missing; box.pkr.hcl ships it right before this step"
    exit 1
  fi
  $SUDO install -D -m 755 "$REWRITE_SRC" "$REWRITE_DEST"
  log "installed $REWRITE_DEST"
fi

log "indexed $n_links symlink(s) and $n_files text file(s) under $HOME_DIR in $(( $(date +%s) - start ))s -> $INDEX_DIR"

# The agent CLIs alone (cursor-agent, devin, the npm-global bins) put well over
# a hundred symlinks in the index. Zero means the walk found nothing, and a box
# would boot with every one of those symlinks dangling; say so where the bake
# log is read. Not fatal: an image with fewer installers is different, not wrong.
if [ "$n_links" -eq 0 ]; then
  log "WARNING: no symlinks into $HOME_DIR were found; if this image carries the agent CLIs, the index is wrong"
fi
