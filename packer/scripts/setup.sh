#!/bin/bash
# Provisions a termag box AMI. Runs once at AMI bake time.
# Environment variables (set by Packer):
#   TERMAG_REPO_URL, TERMAG_REF, AGENT_WIKI_REPO_URL

set -euo pipefail

log() { echo "[packer] $*"; }

# Echo every command so the packer build log is debuggable when something
# changes upstream and an install command starts failing.
set -x

export DEBIAN_FRONTEND=noninteractive

# Ubuntu cloud images run unattended-upgrades in the background after first
# boot. cloud-init returns "done" before that finishes, so apt locks can be
# held when our script starts. Stop the service and wait on the locks before
# running any apt commands.
sudo systemctl stop unattended-upgrades.service 2>/dev/null || true
sudo systemctl stop apt-daily.service apt-daily.timer apt-daily-upgrade.service apt-daily-upgrade.timer 2>/dev/null || true
sudo systemctl disable unattended-upgrades.service 2>/dev/null || true

wait_for_apt() {
    for f in /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/cache/apt/archives/lock; do
        while sudo fuser "$f" >/dev/null 2>&1; do
            echo "[packer] Waiting for apt lock on $f..."
            sleep 5
        done
    done
}

wait_for_apt

# ─────────────────────────────────────────────────────────────────────────────
# System packages
# ─────────────────────────────────────────────────────────────────────────────
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y \
    git \
    tmux \
    build-essential \
    curl \
    wget \
    unzip \
    jq \
    htop \
    ca-certificates \
    gnupg \
    lsb-release \
    python3 \
    python3-pip \
    python3-venv \
    postgresql-client \
    rsync

# ─────────────────────────────────────────────────────────────────────────────
# GitHub CLI (gh) — pulled from upstream apt repo, not the stale Ubuntu one
# ─────────────────────────────────────────────────────────────────────────────
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=arm64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list
sudo apt-get update -y
sudo apt-get install -y gh

# ─────────────────────────────────────────────────────────────────────────────
# AWS CLI v2 (Canonical's AMI doesn't ship this; discovered during smoke test)
# ─────────────────────────────────────────────────────────────────────────────
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install
rm -rf /tmp/awscliv2.zip /tmp/aws

# ─────────────────────────────────────────────────────────────────────────────
# Node.js LTS — NodeSource apt repo for system-wide install. termag-agent and
# the Claude Code CLI both need it.
# ─────────────────────────────────────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
npm --version

# ─────────────────────────────────────────────────────────────────────────────
# termag unix user
# ─────────────────────────────────────────────────────────────────────────────
if ! id termag >/dev/null 2>&1; then
    sudo useradd -m -s /bin/bash -c "termag agent runtime" termag
fi
# Allow termag's systemd --user to keep running without an interactive session.
sudo loginctl enable-linger termag

# ─────────────────────────────────────────────────────────────────────────────
# Agent CLIs
# ─────────────────────────────────────────────────────────────────────────────

# Claude Code — official npm package
sudo npm install -g @anthropic-ai/claude-code

# Cursor agent CLI — vendor installer is per-user (puts binaries under
# ~/.local/bin and similar). Run it as termag so the install lands in the
# right home, then verify the `agent` binary the registry expects shows up
# on termag's PATH at login.
sudo -u termag -H bash -c "curl https://cursor.com/install -fsS | bash"

# Devin for Terminal — same per-user shape as cursor. Note the installer
# auto-runs `devin login` at the end, which is interactive and bombs out in
# the AMI bake context. The binary itself is installed before login is
# attempted, so we accept the non-zero exit and verify presence below.
sudo -u termag -H bash -c "curl -fsSL https://cli.devin.ai/install.sh | bash" || true

# Verify the install actually landed (catches the case where the failure
# preceded binary placement, vs. our expected post-install login failure).
sudo -u termag test -x /home/termag/.local/bin/devin \
    || { echo "[packer] devin binary missing after install — failing build"; exit 1; }

# Both installers typically extend ~/.bashrc with a PATH addition. Since the
# tmux panes the agent spawns run /bin/bash (which sources .bashrc), the
# `agent` and `devin` commands resolve at use time without further config.

# ─────────────────────────────────────────────────────────────────────────────
# Clone termag-agent + agent-wiki into the termag user's home
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<EOF
set -euo pipefail
mkdir -p /home/termag/src
cd /home/termag/src

git clone --depth 1 --branch "${TERMAG_REF}" "${TERMAG_REPO_URL}" termag
cd termag/agent
npm install --omit=dev
cd /home/termag/src

git clone --depth 1 "${AGENT_WIKI_REPO_URL}" agent-wiki || true

# Also record the cloned commit so we can verify what's in the AMI later.
cd termag
git rev-parse HEAD > /home/termag/.termag-baked-sha
EOF

# ─────────────────────────────────────────────────────────────────────────────
# systemd --user unit
# Cloud-init writes ~termag/src/termag/agent/agent.config.json with the bearer
# token at instance launch (that's the path the unit's ExecStart reads —
# `agent.js <home>/src/termag/agent/agent.config.json`), then
# `systemctl --user enable --now termag-agent`. We install the unit here so
# cloud-init doesn't have to.
# ─────────────────────────────────────────────────────────────────────────────
sudo mkdir -p /home/termag/.config/systemd/user
sudo cp /tmp/termag-agent.service /home/termag/.config/systemd/user/termag-agent.service
sudo chown -R termag:termag /home/termag/.config

# ─────────────────────────────────────────────────────────────────────────────
# Verify SSM agent is present and enabled (Canonical's AMI ships it via snap)
# ─────────────────────────────────────────────────────────────────────────────
snap list amazon-ssm-agent || sudo snap install amazon-ssm-agent --classic
sudo snap start amazon-ssm-agent || true

# ─────────────────────────────────────────────────────────────────────────────
# Cleanup so the AMI is leaner
# ─────────────────────────────────────────────────────────────────────────────
sudo apt-get autoremove -y
sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/*
sudo rm -rf /tmp/* /var/tmp/* || true

# Truncate machine-id so each EC2 launched from this AMI gets a fresh one.
sudo truncate -s 0 /etc/machine-id
sudo rm -f /var/lib/dbus/machine-id
sudo ln -s /etc/machine-id /var/lib/dbus/machine-id

log "AMI bake complete. Baked termag SHA: $(sudo cat /home/termag/.termag-baked-sha 2>/dev/null || echo unknown)"
