#!/bin/bash
# Bake the pinned t3 server (deploy/t3-server.pin) into the box image, the
# desktop app's box half, but only
# when this bake was handed its tarball.
#
# Inert without one. box.pkr.hcl's t3_server_artifact names a local tarball,
# which stage-t3-server.sh uploads as /tmp/t3-server.tar.gz; without it the
# uploaded file is empty and this does nothing: no /opt/termag-t3, no agent
# drop-in, and no fetch. A bake never fetches the pin's base_url, which is a
# gh:// release asset read with the box owner's gh login, and a bake has no
# owner. A box whose image has no server installs the pinned one itself:
# termag-reconcile runs deploy/termag-t3-install on every boot and box update.
#
# With a tarball, the work is deploy/termag-t3-install from the termag checkout
# this bake just cloned, run as termag with TERMAG_T3_SERVER_SOURCE set to that
# file, so it installs the tarball or nothing. The pin's digest has to match;
# a mismatch, a pin with no digest for this architecture, an unpack that fails
# or a server that won't run fails the bake. It creates /opt/termag-t3 (owned
# by termag, whose uid becomes the owner's at the rename, like
# /opt/ms-playwright) and the agent drop-in under ~/.config.
#
# Runs in full and incremental bakes alike (an incremental bake's source image
# may predate this step), after setup.sh / refresh-box.sh (both wipe /tmp, so
# the tarball is uploaded after them) and before the home-path index, which
# must stay last. Nothing it writes under /home/termag embeds that path.
#
# Env (tests only): T3_STAGED, T3_INSTALLER, T3_ROOT override the paths below.
set -euo pipefail

log() { echo "[packer/t3-server] $*"; }

ROOT=${T3_ROOT:-/opt/termag-t3}
INSTALLER=${T3_INSTALLER:-/home/termag/src/termag/deploy/termag-t3-install}
STAGED=${T3_STAGED:-/tmp/t3-server.tar.gz}

cd /tmp

if [ ! -s "$STAGED" ]; then
    sudo rm -f "$STAGED"
    log "no t3_server_artifact: this image has no t3 server; a box installs the pinned one on boot"
    exit 0
fi

if ! sudo test -f "$INSTALLER"; then
    log "t3_server_artifact was given, but the checkout has no deploy/termag-t3-install"
    exit 1
fi

sudo install -d -m 0755 -o termag -g termag "$ROOT"
sudo chmod 0644 "$STAGED"
log "installing the t3 server from the tarball this bake was handed"
sudo -u termag -H env "TERMAG_T3_SERVER_SOURCE=$STAGED" bash "$INSTALLER"
sudo rm -f "$STAGED"

if ! sudo test -x "$ROOT/bin/t3"; then
    log "t3_server_artifact was given, but no t3 server was installed: does deploy/t3-server.pin have this tarball's version and a sha256 for this architecture?"
    exit 1
fi
log "installed: $(sudo readlink "$ROOT/current") ($(sudo -u termag -H "$ROOT/bin/t3" --version 2>&1 | head -n 1))"
