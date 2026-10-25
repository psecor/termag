#!/bin/bash
# The incremental bake's stand-in for setup.sh.
#
# Environment (set by Packer, see box.pkr.hcl):
#   BAKE_MODE            full | incremental
#   TERMAG_BAKED_SHA     commit of the checkout shipped as /tmp/termag.bundle
#   AGENT_WIKI_REPO_URL  agent-wiki remote, cloned if missing, pulled otherwise
set -euo pipefail

log() { echo "[packer/refresh] $*"; }

BAKE_MODE="${BAKE_MODE:-full}"
TERMAG_BAKED_SHA="${TERMAG_BAKED_SHA:-unknown}"
AGENT_WIKI_REPO_URL="${AGENT_WIKI_REPO_URL:-}"

if [ "$BAKE_MODE" != incremental ]; then
    log "full bake: setup.sh lays everything down; nothing to refresh"
    exit 0
fi

# Same reason as setup.sh: the sudo -u termag blocks inherit the cwd, and
# /home/ubuntu is mode 700.
cd /tmp

missing=()
id termag >/dev/null 2>&1 || missing+=("the termag user")
sudo test -f /home/termag/.termag-baked-sha || missing+=("~termag/.termag-baked-sha")
sudo test -s /home/termag/.nvm/nvm.sh || missing+=("~termag/.nvm")
sudo test -d /home/termag/src/termag/.git || missing+=("~termag/src/termag")
if [ ${#missing[@]} -gt 0 ]; then
    echo "[packer/refresh] the source image is not a termag box image (missing: ${missing[*]}); an incremental bake needs a published box AMI as source_ami" >&2
    exit 1
fi
prev_sha=$(sudo cat /home/termag/.termag-baked-sha)
log "source image was baked from termag ${prev_sha:0:9}; refreshing to ${TERMAG_BAKED_SHA:0:9}"

# shellcheck source=box-lib.sh
. /var/lib/termag-bake/box-lib.sh
wait_for_boot_units "[packer/refresh]"

sudo -u termag -H bash <<EOF
set -euo pipefail
export NVM_DIR="\$HOME/.nvm"
. "\$NVM_DIR/nvm.sh"

cd /home/termag/src
rm -rf termag
git clone /tmp/termag.bundle termag

origin=\$(cat /tmp/termag.bundle.origin 2>/dev/null || true)
if [ -n "\$origin" ]; then
  git -C termag remote set-url origin "\$origin"
else
  git -C termag remote remove origin
fi

baked=\$(git -C termag rev-parse HEAD)
if [ "${TERMAG_BAKED_SHA}" != unknown ] && [ "\$baked" != "${TERMAG_BAKED_SHA}" ]; then
  echo "bundle HEAD \$baked does not match TERMAG_BAKED_SHA ${TERMAG_BAKED_SHA}" >&2
  exit 1
fi

cd termag/agent
npm install --omit=dev
cd /home/termag/src

# The source image may predate the CLI; this installs or rebuilds it either way.
sh termag/cli/install.sh --bin-dir "\$HOME/.local/bin"

if [ -d agent-wiki/.git ]; then
  git -C agent-wiki pull --ff-only --quiet || echo "[packer/refresh] agent-wiki pull failed (non-fatal)"
elif [ -n "${AGENT_WIKI_REPO_URL}" ]; then
  git clone "${AGENT_WIKI_REPO_URL}" agent-wiki || true
fi

echo "\$baked" > /home/termag/.termag-baked-sha
EOF

install_deploy_artifacts
install_box_marker
install_guest_browser

# Truncate machine-id so each EC2 launched from this AMI gets a fresh one.
sudo truncate -s 0 /etc/machine-id

sudo rm -rf /tmp/* /var/tmp/* || true

log "refreshed: termag $(sudo cat /home/termag/.termag-baked-sha) (was ${prev_sha:0:9}), deploy/ artifacts reinstalled"
