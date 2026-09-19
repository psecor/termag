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

# Polling `fuser` on the dpkg/apt lock files is racy: the lock can be taken
# again between the check and the next apt invocation, which is exactly how a
# bake dies with "Could not get lock /var/lib/dpkg/lock-frontend" (exit 100)
# even after waiting. Let apt itself block on the lock instead.
#
# The retry also covers a second, unrelated flake: ports.ubuntu.com is a
# round-robin of mirrors that occasionally 404s a package its own index just
# advertised (mid-sync), which likewise exits 100. Refreshing the indexes and
# retrying clears it.
# Acquire::Retries makes apt retry an individual file before giving up on the
# whole transaction, which covers a single flaky mirror backend without burning
# one of the coarse attempts below.
APT_OPTS="-o DPkg::Lock::Timeout=600 -o Acquire::Retries=3"

apt_get() {
    local attempt
    for attempt in 1 2 3; do
        # shellcheck disable=SC2086  # APT_OPTS is a deliberate word-split list
        if sudo apt-get $APT_OPTS "$@"; then
            return 0
        fi
        echo "[packer] apt-get $* failed (attempt $attempt/3); refreshing indexes and retrying..."
        sleep 10
        # shellcheck disable=SC2086
        sudo apt-get $APT_OPTS update -y || true
    done
    echo "[packer] apt-get $* failed after 3 attempts" >&2
    return 1
}

# Ubuntu's per-region EC2 mirror is a round-robin of backends that periodically
# go bad as a group. Publish AMI run 32918809708 had most of
# us-east-1.ec2.ports.ubuntu.com returning 503 for both package files and the
# InRelease index, so no amount of retrying inside apt could make progress —
# meanwhile Canonical's ports.ubuntu.com served everything fine. Probe the
# configured regional mirror and fall back to the canonical host for the
# duration of the bake when it isn't reliably up.
#
# The swap is reverted on exit, so a bake that happens during a mirror outage
# still produces an AMI with the normal in-region sources.
CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
APT_SOURCES=/etc/apt/sources.list.d/ubuntu.sources
[ -f "$APT_SOURCES" ] || APT_SOURCES=/etc/apt/sources.list
REGIONAL_MIRROR="$(grep -ohE '[a-z0-9-]+\.ec2\.(ports|archive)\.ubuntu\.com' "$APT_SOURCES" 2>/dev/null | head -1 || true)"
APT_SOURCES_BAK="$APT_SOURCES.packer-orig"
MIRROR_SWAPPED=""
CANONICAL_MIRROR=""

# Restore by putting the original file back, NOT by reversing the sed: the
# security suite already points at the canonical host, so a global
# canonical->regional replace would also rewrite that line and leave the AMI
# pulling security updates from the regional mirror.
restore_mirror() {
    if [ -n "$MIRROR_SWAPPED" ]; then
        echo "[packer] restoring original $APT_SOURCES"
        sudo cp -a "$APT_SOURCES_BAK" "$APT_SOURCES"
        sudo rm -f "$APT_SOURCES_BAK"
    fi
}

if [ -n "$REGIONAL_MIRROR" ]; then
    case "$REGIONAL_MIRROR" in
        *.ec2.ports.ubuntu.com) CANONICAL_MIRROR=ports.ubuntu.com;   MIRROR_PATH=ubuntu-ports ;;
        *)                      CANONICAL_MIRROR=archive.ubuntu.com; MIRROR_PATH=ubuntu ;;
    esac

    # Require 3/3: a single 200 from a round-robin proves nothing when most of
    # the backends behind it are failing.
    mirror_healthy=1
    for _ in 1 2 3; do
        if ! curl -fsS --max-time 15 -o /dev/null \
            "http://$REGIONAL_MIRROR/$MIRROR_PATH/dists/$CODENAME/InRelease"; then
            mirror_healthy=0
            break
        fi
    done

    if [ "$mirror_healthy" -eq 1 ]; then
        echo "[packer] apt mirror $REGIONAL_MIRROR is healthy"
    else
        echo "[packer] apt mirror $REGIONAL_MIRROR is unhealthy; using $CANONICAL_MIRROR for this bake"
        sudo cp -a "$APT_SOURCES" "$APT_SOURCES_BAK"
        trap restore_mirror EXIT
        MIRROR_SWAPPED=1
        sudo sed -i "s|$REGIONAL_MIRROR|$CANONICAL_MIRROR|g" "$APT_SOURCES"
    fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# System packages. Superset of what the orchestrator cloud-init used to install
# at boot (git/build tools for npm native modules, mosh/tmux for engineer SSH).
# ─────────────────────────────────────────────────────────────────────────────
apt_get update -y

# Packer reaches this instance over an SSM session, and the SSM agent runs as
# a snap under systemd. A blanket upgrade that pulls a systemd/udev/snapd point
# release restarts/re-execs the daemons holding that session, killing the bake
# mid-provision ("document process failed unexpectedly: ipc messaging received
# timeout signal" — run 33002592841). Hold those packages across the upgrade;
# unattended-upgrades patches them at runtime on real instances.
SESSION_CRITICAL_PKGS="systemd systemd-sysv systemd-resolved systemd-dev libsystemd0 libsystemd-shared libnss-systemd libpam-systemd udev libudev1 snapd"

# apt-mark shells out to `dpkg --set-selections`, which unlike apt_get has no
# DPkg::Lock::Timeout — a first-boot apt-daily/unattended-upgrades run holding
# the dpkg lock makes it exit 100 immediately (run 33015573584). Retry instead.
apt_mark() {
    local attempt
    for attempt in $(seq 1 20); do
        # shellcheck disable=SC2086  # deliberate word-split list
        if sudo apt-mark "$@" $SESSION_CRITICAL_PKGS; then
            return 0
        fi
        echo "[packer] apt-mark $* failed (attempt $attempt/20); waiting for dpkg lock..."
        sleep 15
    done
    echo "[packer] apt-mark $* failed after 20 attempts" >&2
    return 1
}

apt_mark hold
apt_get upgrade -y
apt_mark unhold

apt_get install -y \
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
apt_get install -y nodejs
node --version
npm --version

# ─────────────────────────────────────────────────────────────────────────────
# GitHub CLI (gh) — upstream apt repo, not the stale Ubuntu one. Engineers and
# agents use it in termag sessions; before this it was installed by hand on
# the running instance, so every replacement silently dropped it (/usr is on
# the ephemeral root volume). Mirrors the box AMI's setup.sh block.
# ─────────────────────────────────────────────────────────────────────────────
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=arm64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list
apt_get update -y
apt_get install -y gh

# ─────────────────────────────────────────────────────────────────────────────
# Docker — the orchestrator runs Postgres as a container (cloud-init does the
# `docker run`). Bake the engine + enable it so it's up at boot.
# ─────────────────────────────────────────────────────────────────────────────
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo dd of=/etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list
apt_get update -y
apt_get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
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
# nginx gateway — owns :3040 and fans out by path prefix: /termag to the
# backend on 127.0.0.1:3100, everything else to hosted apps registered under
# /srv/termag/apps (see docs/hosted-apps.md). Installed + configured here but
# left DISABLED: whether nginx owns :3040 (and the backend moves to :3100) is
# decided by cloud-init when it renders .env — the orchestrator module enables
# nginx and runs termag-apps-boot when the AMI ships them. An instance
# launched from this AMI with an older cloud-init still works: nginx stays
# off and the backend binds :3040 directly, exactly as before.
# ─────────────────────────────────────────────────────────────────────────────
apt_get install -y nginx
sudo rm -f /etc/nginx/sites-enabled/default
sudo install -m 644 /opt/termag/deploy/nginx/termag-gateway.conf /etc/nginx/sites-available/termag-gateway.conf
sudo ln -sf ../sites-available/termag-gateway.conf /etc/nginx/sites-enabled/termag-gateway.conf
sudo install -m 644 /opt/termag/deploy/nginx/termag-proxy.conf /etc/nginx/snippets/termag-proxy.conf
sudo install -m 755 /opt/termag/deploy/termag-apps-boot /usr/local/bin/termag-apps-boot
sudo install -m 644 /opt/termag/deploy/termag-apps.service /etc/systemd/system/termag-apps.service
sudo nginx -t
sudo systemctl disable --now nginx
sudo systemctl enable termag-apps.service

# ─────────────────────────────────────────────────────────────────────────────
# Verify SSM agent is present and enabled (Canonical's AMI ships it via snap)
# ─────────────────────────────────────────────────────────────────────────────
snap list amazon-ssm-agent || sudo snap install amazon-ssm-agent --classic
sudo snap start amazon-ssm-agent || true

# ─────────────────────────────────────────────────────────────────────────────
# Cleanup so the AMI is leaner
# ─────────────────────────────────────────────────────────────────────────────
apt_get autoremove -y
apt_get clean
sudo rm -rf /var/lib/apt/lists/*
sudo rm -rf /tmp/* /var/tmp/* || true

# Truncate machine-id so each EC2 launched from this AMI gets a fresh one.
sudo truncate -s 0 /etc/machine-id
sudo rm -f /var/lib/dbus/machine-id
sudo ln -s /etc/machine-id /var/lib/dbus/machine-id

log "Orchestrator AMI bake complete. Baked termag SHA: $(sudo cat /opt/termag/.termag-baked-sha 2>/dev/null || echo unknown)"
