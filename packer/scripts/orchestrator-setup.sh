#!/bin/bash
# Provisions a termag ORCHESTRATOR AMI. Runs once at AMI bake time.
#
# Unlike the box setup, the termag source is NOT cloned here — Packer's `file`
# provisioner has already uploaded the CI checkout to /tmp/termag-src. This
# script installs the runtime deps, stages the source to /opt/termag, and
# pre-builds the backend + frontend so the running instance only needs to
# render .env, start Postgres, and launch the service.
#
# Environment variables (set by Packer):
#   TERMAG_BAKED_SHA   git SHA of the baked source (for traceability)

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
# System packages. Superset of what the orchestrator cloud-init used to install
# at boot (git/build tools for npm native modules, mosh/tmux for engineer SSH).
# ─────────────────────────────────────────────────────────────────────────────
sudo apt-get update -y
sudo apt-get upgrade -y
sudo apt-get install -y \
    git \
    mosh \
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
    software-properties-common \
    python3 \
    python3-pip \
    postgresql-client \
    rsync \
    apparmor-utils

# ─────────────────────────────────────────────────────────────────────────────
# AWS CLI v2 (Canonical's AMI doesn't ship it; cloud-init reads Secrets Manager)
# ─────────────────────────────────────────────────────────────────────────────
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install
rm -rf /tmp/awscliv2.zip /tmp/aws

# ─────────────────────────────────────────────────────────────────────────────
# Node.js 20 (NodeSource) — matches the version the orchestrator built against
# when it cloned-and-built at boot.
# ─────────────────────────────────────────────────────────────────────────────
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version
npm --version

# ─────────────────────────────────────────────────────────────────────────────
# Docker — the orchestrator runs Postgres as a container (cloud-init does the
# `docker run`). Bake the engine + enable it so it's up at boot.
# ─────────────────────────────────────────────────────────────────────────────
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo dd of=/etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable docker

# ─────────────────────────────────────────────────────────────────────────────
# termag service user (runs the backend). Matches the cloud-init user shape.
# ─────────────────────────────────────────────────────────────────────────────
if ! id -u termag >/dev/null 2>&1; then
    sudo useradd -r -m -s /bin/bash -d /home/termag termag
fi
sudo usermod -aG docker termag

# ─────────────────────────────────────────────────────────────────────────────
# Stage the uploaded source to /opt/termag (root volume — NOT /srv/termag,
# which is the mount point for the persistent EBS volume and would shadow it).
# Prune the dirs that aren't part of the runtime image to keep the AMI lean.
# ─────────────────────────────────────────────────────────────────────────────
sudo rm -rf /opt/termag
sudo mv /tmp/termag-src /opt/termag
sudo rm -rf /opt/termag/.git /opt/termag/packer /opt/termag/terraform /opt/termag/relay
# Drop any node_modules that rode along from a local checkout — we install clean.
sudo rm -rf /opt/termag/backend/node_modules /opt/termag/frontend/node_modules
sudo chown -R termag:termag /opt/termag

echo "${TERMAG_BAKED_SHA}" | sudo -u termag tee /opt/termag/.termag-baked-sha >/dev/null

# ─────────────────────────────────────────────────────────────────────────────
# Build backend + frontend as the termag user. The orchestrator runs the
# backend (which also serves the built frontend's dist/), so both are baked.
# `npm ci` uses the committed lockfiles; `db:generate` runs `prisma generate`
# so the Prisma client + query engine are present in the image.
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<'EOF'
set -euo pipefail
cd /opt/termag/backend
npm ci
npm run db:generate
npm run build
cd /opt/termag/frontend
npm ci
npm run build
EOF

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

log "Orchestrator AMI bake complete. Baked termag SHA: $(sudo cat /opt/termag/.termag-baked-sha 2>/dev/null || echo unknown)"
