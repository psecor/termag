#!/bin/bash
# Provisions the lean box-min AMI. Runs once at AMI bake time — the
# --minimal-flavor counterpart of packer/scripts/setup.sh.
#
# What this bakes is the box contract and nothing else, matching the docs' box
# -min list (docs/box-provisioning.md, "The minimal flavor"):
#   * the placeholder `termag` unix user (zsh shell, sudo group + group-keyed
#     NOPASSWD sudoers, keys-only sshd, linger) cloud-init renames to the box
#     owner at launch
#   * nvm + a default Node alias — there is no system node; the agent's
#     run-node.sh and the CLI launcher resolve the runtime through it
#   * the termag source from the /tmp bundle (scripts/bundle-source.sh), agent
#     npm-installed at ~termag/src/termag/agent, CLI built at ~/.local/bin
#   * git; zsh; tmux (the agent creates tmux panes); jq (termag-reconcile's
#     config merges); gh (the attended first-run flow's GitHub auth);
#     ca-certificates/curl for everything above; build-essential/python3 for
#     the agent's node-pty native compile
#   * Docker (docker-ce + buildx + compose, the ECR credential helper and the
#     docker group for the box user): a project's dev stack
#     runs in panes ON the box, so the engine is contract, not war cache —
#     the compose images pull per project
#   * the agent CLIs, same set and shapes as the full bake: @anthropic-ai/
#     claude-code and @openai/codex npm-global under nvm, pi pinned by
#     deploy/termag-pi-update's PINS, its checked package installed with
#     --ignore-scripts, cursor-agent and devin from their vendor installers
#   * the deploy/ units and scripts for the agent (box-lib.sh's
#     install_deploy_artifacts), the TERMAG_BOX marker
#     (install_box_marker), the guest-browser wiring (install_guest_browser),
#     the GitHub CLI's root updater (install_gh_updater)
#   * the SSM agent (Canonical ships it — asserted, not installed)
#
# Everything setup.sh installs beyond this stays out, and box-min.test.sh
# holds it that way: language toolchains, Playwright, Chromium and the snap,
# neovim, oh-my-zsh, browser-harness/clickhousectl, and the whole
# app war cache (clones, node_modules, pnpm store,
# the bazel disk cache, pre-pulled dev-stack images). Skills and MCP
# registrations are deliberately not baked either — shipping them is not
# this bake's call: they re-land from the checkout through termag-reconcile
# at boot, and the bootstrapper (the termag-herdr plugin's install or the
# owner's own script) decides what is wanted. NO awscli: a minimal box is
# provisioned from the owner's machine, not asked to act as an AWS client
# (add it via the owner's bootstrap when they want it).
#
# Environment variables (set by Packer):
#   TERMAG_BAKED_SHA     commit of the checkout shipped as /tmp/termag.bundle
#                        ("unknown" on a hand-run build)

set -euo pipefail

log() { echo "[packer/box-min] $*"; }

# Echo every command so the packer build log is debuggable when something
# changes upstream and an install command starts failing.
set -x

export DEBIAN_FRONTEND=noninteractive

# Same pattern as setup.sh: Packer runs this from /home/ubuntu; the
# `sudo -u termag` blocks below need a cwd termag can sit in.
cd /tmp

# Ubuntu cloud images run unattended-upgrades in the background. Stop it and
# the apt timers before any apt command; disabled the way setup.sh disables
# it, so this script owns apt for the bake's duration.
sudo systemctl stop unattended-upgrades.service 2>/dev/null || true
sudo systemctl stop apt-daily.service apt-daily.timer apt-daily-upgrade.service apt-daily-upgrade.timer 2>/dev/null || true
sudo systemctl disable unattended-upgrades.service 2>/dev/null || true

# apt itself blocks on the dpkg lock (DPkg::Lock::Timeout), and the coarse
# retry covers the round-robin-mirror 404s setup.sh documents (run
# 32918809708). No mirror swap here: this bake is minutes-long, so the retry
# window covers the transient backend set without the probing dance.
APT_OPTS="-o DPkg::Lock::Timeout=600 -o Acquire::Retries=3"

apt_get() {
    local attempt
    for attempt in 1 2 3; do
        # shellcheck disable=SC2086  # APT_OPTS is a deliberate word-split list
        if sudo apt-get $APT_OPTS "$@"; then
            return 0
        fi
        echo "[packer/box-min] apt-get $* failed (attempt $attempt/3); refreshing indexes and retrying..."
        sleep 10
        # shellcheck disable=SC2086
        sudo apt-get $APT_OPTS update -y || true
    done
    echo "[packer/box-min] apt-get $* failed after 3 attempts" >&2
    return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# System packages: GitHub CLI from upstream's apt repo (the Ubuntu one is
# stale), then the contract set in one transaction.
# ─────────────────────────────────────────────────────────────────────────────
sudo install -m 0755 -d /usr/share/keyrings
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=arm64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list

apt_get update -y
apt_get install -y \
    build-essential \
    ca-certificates \
    curl \
    git \
    gh \
    jq \
    python3 \
    tmux \
    zsh \
    tpm2-tools
# build-essential + python3 because the agent's runtime deps include
# node-pty, which npm compiles from source during the bake (`npm install
# --omit=dev` runs node-gyp). The full bake's build-essential covers the
# same need; a lean image that skips them fails exactly there and
# publishes no Component=box-min image at all.

# ─────────────────────────────────────────────────────────────────────────────
# Docker — the engine for a project's dev stack on the box (docker-ce,
# buildx, compose), plus the amazon-ecr-credential-helper so a pull from an
# ECR registry can authenticate with the box role once a docker config names
# it. The
# war-cache half of the full bake's docker story — pre-pulled dev-stack
# images — stays out on purpose: images pull per project.
# ─────────────────────────────────────────────────────────────────────────────
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /tmp/docker.asc
sudo install -m 0644 /tmp/docker.asc /etc/apt/keyrings/docker.asc
rm -f /tmp/docker.asc
echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list
apt_get update -y
apt_get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    amazon-ecr-credential-helper

# ─────────────────────────────────────────────────────────────────────────────
# termag unix user (placeholder — renamed to the box owner at launch). Same
# shape as setup.sh's block, minus the docker group: this image ships no
# Docker, and the plugin's forwarding resolves compose locally.
# ─────────────────────────────────────────────────────────────────────────────
if ! id termag >/dev/null 2>&1; then
    sudo useradd -m -s /bin/zsh -c "termag agent runtime" termag
fi
sudo usermod -s /bin/zsh termag
# Passwordless sudo for the box owner, keyed on the `sudo` *group* so it
# survives the `termag` → owner rename at launch.
sudo usermod -aG sudo termag
# The docker group exists by now (docker-ce's postinst created it): compose
# stacks run in the box's own panes, the same membership the full bake gives.
# Group membership survives the `termag` → owner rename (uid/gid stable).
sudo usermod -aG docker termag
printf '%%sudo ALL=(ALL:ALL) NOPASSWD:ALL\n' | sudo tee /etc/sudoers.d/90-termag-box >/dev/null
sudo chmod 0440 /etc/sudoers.d/90-termag-box
sudo visudo -cf /etc/sudoers.d/90-termag-box
# Key-only SSH: keys are what gate Session Manager SSH.
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' | sudo tee /etc/ssh/sshd_config.d/10-termag-keys-only.conf >/dev/null
sudo chmod 0644 /etc/ssh/sshd_config.d/10-termag-keys-only.conf
# sshd -t needs /run/sshd, which socket-activated sshd creates lazily.
sudo install -d -m 0755 /run/sshd
sudo sshd -t

# Allow termag's systemd --user to keep running without an interactive session.
sudo loginctl enable-linger termag

# ─────────────────────────────────────────────────────────────────────────────
# nvm + Node LTS. The ONLY Node on the image: the agent service, the CLI
# launcher and the owner's installs (the plugin's bootstrap installs pi exactly
# this way) all resolve through nvm. No corepack, no npm-global CLIs — the
# full bake has them; --minimal boxes bring their own.
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<'NVM_INSTALL'
set -euo pipefail
# Node is PINNED, the same declared value the full bake's setup.sh installs
# (a floating --lts silently decided whether a bake had a security fix,
# CVE-2026-111497, and the security review of this bake flagged the same
# gap: whoever publishes Node's LTS file then chooses the interpreter every
# --minimal box runs). Bump it for Node security releases, together with
# setup.sh's NODE_VERSION — box-min.test.sh pins that the two agree.
NODE_VERSION=24.22.1
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
[ "$(node -v)" = "v$NODE_VERSION" ] || { echo "[packer/box-min] node is $(node -v), not the pinned v$NODE_VERSION -- failing build" >&2; exit 1; }
# The agent CLIs, with the full bake's shapes: claude + codex as installed by
# every box, pi pinned and --ignore-scripts (its optional native helpers are
# not needed; the bootstrap pins the same version, so a bootstrap re-run is
# a no-op rather than a downgrade), cursor-agent and devin from their vendor
# installers — devin's auto-login bombs out at bake, the binary is placed
# before that, so a non-zero exit is accepted here and verified below.
npm install -g @anthropic-ai/claude-code @openai/codex
# pi: below, from the termag checkout's pinned package (deploy/termag-pi-update).
NVM_INSTALL

# Cursor agent CLI (vendor installer, lands in ~/.local/bin). Non-fatal: if
# the installer is down, the box ships claude/codex/pi and the owner can
# install cursor later; parity with the full bake's tolerance.
if sudo -u termag -H bash -c "curl https://cursor.com/install -fsS | bash"; then
    sudo -u termag test -x /home/termag/.local/bin/cursor-agent \
        || { echo "[packer/box-min] cursor-agent binary missing after install — failing build" >&2; exit 1; }
else
    echo "[packer/box-min] the cursor installer failed (non-fatal; skip)" >&2
fi

# Devin for Terminal. Its installer auto-runs an interactive `devin login` at
# the end that bombs out in a non-interactive bake (same behavior the full
# bake accepts); the binary is placed before that, so non-zero exit is
# expected and the presence check below is the real assertion.
sudo -u termag -H bash -c "curl -fsSL https://cli.devin.ai/install.sh | bash" || true
sudo -u termag test -x /home/termag/.local/bin/devin \
    || { echo "[packer/box-min] devin binary missing after install — failing build" >&2; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# The termag source: clone the shipped bundle into the termag user's home,
# npm-install the agent, install the CLI. Nothing cloned from a remote.
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<EOF
set -euo pipefail
export NVM_DIR="\$HOME/.nvm"
. "\$NVM_DIR/nvm.sh"

mkdir -p /home/termag/src
cd /home/termag/src

git clone /tmp/termag.bundle termag

# A bundle clone's origin is the bundle file. Point it at the checkout's real
# remote (recorded by bundle-source.sh) so a pull on the box goes somewhere
# that exists; with no remote recorded, leave the clone remote-less.
origin=\$(cat /tmp/termag.bundle.origin 2>/dev/null || true)
if [ -n "\$origin" ]; then
  git -C termag remote set-url origin "\$origin"
else
  git -C termag remote remove origin
fi

# The AMI's TermagSha tag must name what is actually on the image. Refuse to
# bake if the bundle's HEAD is not the commit CI said it was baking.
baked=\$(git -C termag rev-parse HEAD)
if [ "${TERMAG_BAKED_SHA}" != unknown ] && [ "\$baked" != "${TERMAG_BAKED_SHA}" ]; then
  echo "bundle HEAD \$baked does not match TERMAG_BAKED_SHA ${TERMAG_BAKED_SHA}" >&2
  exit 1
fi

cd termag/agent
npm install --omit=dev
cd /home/termag/src

# The termag CLI, built in the checkout with a launcher at ~/.local/bin/termag
# that pins this nvm Node. termag-reconcile runs the same installer on every
# boot; the launcher's /home/termag paths are rewritten at first boot like the
# other text files under ~/.local.
sh termag/cli/install.sh --bin-dir "\$HOME/.local/bin"

# Record the baked commit so a live box can be checked against the TermagSha
# tag of the image it launched from.
echo "\$baked" > /home/termag/.termag-baked-sha
EOF

# pi, as the full bake installs it (packer/scripts/setup.sh): the newest pin
# in deploy/termag-pi-update's PINS, its package checked against the pin's
# sha512 and npm-installed from that file with --ignore-scripts. A package
# that is not the pinned one fails the build.
sudo -u termag -H bash <<'PI_INSTALL'
set -euo pipefail
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
"$HOME/src/termag/deploy/termag-pi-update" --install-pinned || { echo "[packer/box-min] pi's pinned package did not install, or is not the pinned one -- failing build" >&2; exit 1; }
want=$("$HOME/src/termag/deploy/termag-pi-update" --newest-pin)
command -v pi >/dev/null || { echo "[packer/box-min] pi missing after its install -- failing build" >&2; exit 1; }
[ "$(pi --version 2>/dev/null)" = "$want" ] || { echo "[packer/box-min] pi is not the pinned $want -- failing build" >&2; exit 1; }
PI_INSTALL

# ─────────────────────────────────────────────────────────────────────────────
# systemd --user unit + per-user scripts + the box marker. Cloud-init writes
# ~termag/src/termag/agent/agent.config.json with the bearer token at launch,
# then `systemctl --user enable --now termag-agent`.
# ─────────────────────────────────────────────────────────────────────────────
# shellcheck source=box-lib.sh
. /var/lib/termag-bake/box-lib.sh
install_deploy_artifacts
install_box_marker
install_guest_browser
install_gh_updater

sudo chown -R termag:termag /home/termag/.local /home/termag/.config

# ─────────────────────────────────────────────────────────────────────────────
# Verify SSM agent is present and enabled (Canonical's AMI ships it via snap)
# ─────────────────────────────────────────────────────────────────────────────
snap list amazon-ssm-agent || sudo snap install amazon-ssm-agent --classic
sudo snap start amazon-ssm-agent || true

# Contract probes: the things cloud-init and the first-run flow depend on, so
# a regression fails the bake instead of shipping a box-min image that boxes
# die provisioning on (cloud-init's step 6 needs git; the first-run flow's
# GitHub phase needs gh; the plugin's landing pane needs tmux panes).
command -v git >/dev/null || { log "git missing after install — failing build"; exit 1; }
command -v gh   >/dev/null || { log "gh missing after install — failing build"; exit 1; }
command -v tmux >/dev/null || { log "tmux missing after install — failing build"; exit 1; }
command -v docker >/dev/null || { log "docker missing after install — failing build"; exit 1; }
# The npm CLIs live under the termag user's nvm, not root's PATH.
sudo -u termag -H bash -c '. "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; command -v claude >/dev/null 2>&1 && command -v codex >/dev/null 2>&1 && command -v pi >/dev/null 2>&1' \
    || { log "the npm agent CLIs (claude/codex/pi) are missing — failing build"; exit 1; }
sudo -u termag -H [ -x /home/termag/.local/bin/devin ] \
    || { log "devin missing after install — failing build"; exit 1; }
sudo -u termag -H [ -f /home/termag/src/termag/agent/agent.js ] \
    && sudo -u termag -H [ -d /home/termag/src/termag/agent/node_modules ] \
    || { log "the agent checkout is missing — failing build"; exit 1; }
# run-node.sh is invoked as `bash run-node.sh` everywhere (the tracked mode
# is 100644); presence, not the exec bit, is its contract.
sudo -u termag -H [ -x /home/termag/.local/bin/termag ] \
    || { log "the termag CLI is missing — failing build"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# Cleanup so the AMI is leaner; same machine-id reset as the full bake.
# ─────────────────────────────────────────────────────────────────────────────
apt_get autoremove -y
apt_get clean
sudo rm -rf /var/lib/apt/lists/*
sudo rm -rf /tmp/* /var/tmp/* || true

sudo truncate -s 0 /etc/machine-id
sudo rm -f /var/lib/dbus/machine-id
sudo ln -s /etc/machine-id /var/lib/dbus/machine-id

log "box-min bake complete. Baked termag SHA: $(sudo cat /home/termag/.termag-baked-sha 2>/dev/null || echo unknown)"
