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
    nftables \
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
sudo rm -rf /opt/termag/backend/node_modules /opt/termag/frontend/node_modules /opt/termag/agent/node_modules
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
# Each user's host agent runs this checkout's agent (deploy/termag-agent-host.service).
cd /opt/termag/agent
npm ci --omit=dev
EOF

# ─────────────────────────────────────────────────────────────────────────────
# Host accounts on demand (backend/src/services/hostSetup.ts). The one thing the
# backend may run as root is the helper that creates a user's account and
# installs their host agent. Both it and the agent unit are installed
# root-owned, outside /opt/termag (which the termag user owns), so the backend
# can't rewrite what it is allowed to sudo. Inert unless cloud-init sets
# HOST_AUTOSETUP=true in the backend's .env.
# ─────────────────────────────────────────────────────────────────────────────
sudo install -m 0755 -o root -g root /opt/termag/deploy/termag-host-setup /usr/local/sbin/termag-host-setup
# What host users execute -- their termag-agent and the Claude hooks'
# termag-status -- runs from a root-owned copy. /opt/termag belongs to the
# termag service user, and anything it can rewrite would run as every host user
# on the next restart or hook (Cursor security review on #114). Only a bake
# changes these; termag-agent-host.service and termag-host-setup point here.
sudo rm -rf /usr/local/lib/termag
sudo install -d -m 0755 -o root -g root /usr/local/lib/termag
sudo cp -a /opt/termag/agent /usr/local/lib/termag/agent
sudo chown -R root:root /usr/local/lib/termag/agent
sudo chmod -R go-w /usr/local/lib/termag/agent
sudo install -m 0755 -o root -g root /opt/termag/deploy/termag-status /usr/local/lib/termag/termag-status
sudo install -m 0644 -o root -g root /opt/termag/deploy/claude-settings.json /usr/local/lib/termag/claude-settings.json
# MetaTerm's MCP server (dependency-free), which Claude runs as the user;
# backend/src/services/metaterm.ts prefers this copy when it exists.
sudo install -d -m 0755 -o root -g root /usr/local/lib/termag/metaterm
sudo install -m 0644 -o root -g root /opt/termag/metaterm/mcp-server.mjs /usr/local/lib/termag/metaterm/mcp-server.mjs
sudo install -d -m 0755 /etc/systemd/user
sudo install -m 0644 -o root -g root /opt/termag/deploy/termag-agent-host.service /etc/systemd/user/termag-agent-host.service
# The host data volume (every host home) moves to a new orchestrator only once
# the previous one lets go, so this unit attaches and mounts it after boot and
# marks host storage ready. Enabled, not
# started: it waits for cloud-init's /etc/termag/data-volume.
sudo install -m 0755 -o root -g root /opt/termag/deploy/termag-data-attach /usr/local/sbin/termag-data-attach
sudo install -m 0644 -o root -g root /opt/termag/deploy/termag-data-attach.service /etc/systemd/system/termag-data-attach.service
# Host accounts must not reach IMDS (the host role can read the .env secret).
# Rules are runtime state, so the unit reloads them on every boot. nftables.service
# stays off: its /etc/nftables.conf flushes the whole ruleset, Docker's too.
sudo systemctl disable nftables.service
sudo install -m 0644 -o root -g root /opt/termag/deploy/termag-imds-guard.nft /usr/local/lib/termag/termag-imds-guard.nft
sudo install -m 0644 -o root -g root /opt/termag/deploy/termag-imds-guard.service /etc/systemd/system/termag-imds-guard.service
# Fail closed: no host account's user manager (lingering included) or SSH login
# starts unless the guard started. Ubuntu 24.04's sshd is ssh.service (sshd.service
# is only its alias), socket-activated through ssh.socket.
for unit in user@.service ssh.service; do
  sudo install -d -m 0755 "/etc/systemd/system/$unit.d"
  sudo install -m 0644 -o root -g root /opt/termag/deploy/termag-imds-guard-required.conf "/etc/systemd/system/$unit.d/termag-imds-guard.conf"
done
sudo systemctl daemon-reload
sudo systemctl enable termag-data-attach.service
sudo systemctl enable --now termag-imds-guard.service
sudo nft list chain inet termag_imds output
for unit in user@1000.service ssh.service; do
  systemctl show -p Requires --value "$unit" | grep -qw termag-imds-guard.service ||
    { echo "$unit does not require termag-imds-guard.service" >&2; exit 1; }
done
echo 'termag ALL=(root) NOPASSWD: /usr/local/sbin/termag-host-setup' | sudo tee /etc/sudoers.d/91-termag-host-setup >/dev/null
sudo chmod 0440 /etc/sudoers.d/91-termag-host-setup
sudo visudo -cf /etc/sudoers.d/91-termag-host-setup

# Aurora: Amazon's RDS CA bundle, which the backend
# verifies the cluster's certificate against (PG_SSL_CA_FILE), the cutover tool
# and the one-time role bootstrap. Inert until cloud-init renders the RDS .env.
sudo install -d -m 0755 -o root -g root /usr/local/share/termag
curl -fsSL --retry 3 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /tmp/rds-global-bundle.pem
grep -q 'BEGIN CERTIFICATE' /tmp/rds-global-bundle.pem
sudo install -m 0644 -o root -g root /tmp/rds-global-bundle.pem /usr/local/share/termag/rds-global-bundle.pem
rm -f /tmp/rds-global-bundle.pem
sudo install -m 0755 -o root -g root /opt/termag/deploy/termag-rds-cutover /usr/local/sbin/termag-rds-cutover
sudo install -m 0644 -o root -g root /opt/termag/deploy/termag-rds-bootstrap.sql /usr/local/share/termag/termag-rds-bootstrap.sql

# Claude Code cloud sessions on boxes: the
# self-hosted runner ORCHESTRATOR runs on this host and asks the backend to
# start one-shot runners on boxes. It runs the `claude` every host user already
# gets, which terraform's cloud-init installs from npm at boot (/usr/bin/claude);
# nothing here installs a second one. The hook and the unit are root-owned,
# outside /opt/termag for the same reason as the agent copy above; the unit is
# installed disabled and cloud-init enables it only once the environment key
# parameter is populated and that claude has the self-hosted-runner subcommand.
sudo install -d -m 0755 -o root -g root /usr/local/lib/termag/claude-hooks
sudo install -m 0755 -o root -g root /opt/termag/deploy/claude-spawn-runner /usr/local/lib/termag/claude-hooks/spawn-runner
sudo install -m 0644 -o root -g root /opt/termag/deploy/claude-runner-orchestrator.service /etc/systemd/system/claude-runner-orchestrator.service
sudo install -d -m 0755 -o root -g root /etc/claude
# The backend stops this unit when it drains for an overlapping deploy and
# starts it when it serves; that stop
# and start, and nothing else, are what this rule lets termag sudo.
sudo install -m 0440 -o root -g root /opt/termag/deploy/claude-runner-orchestrator.sudoers /etc/sudoers.d/92-termag-claude-runner
sudo visudo -cf /etc/sudoers.d/92-termag-claude-runner

# Key-only SSH: keys are what gate Session Manager SSH.
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' | sudo tee /etc/ssh/sshd_config.d/10-termag-keys-only.conf >/dev/null
sudo chmod 0644 /etc/ssh/sshd_config.d/10-termag-keys-only.conf
# sshd -t needs /run/sshd, which socket-activated sshd creates lazily.
sudo install -d -m 0755 /run/sshd
sudo sshd -t

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
# :3041 serves only the Claude gateway's check routes, for terraform's internal
# checks ALB. It needs no certificate: the ALB terminates TLS.
sudo install -m 644 /opt/termag/deploy/nginx/termag-checks.conf /etc/nginx/sites-available/termag-checks.conf
sudo ln -sf ../sites-available/termag-checks.conf /etc/nginx/sites-enabled/termag-checks.conf
sudo install -m 644 /opt/termag/deploy/nginx/termag-proxy.conf /etc/nginx/snippets/termag-proxy.conf
sudo install -m 755 /opt/termag/deploy/termag-apps-boot /usr/local/bin/termag-apps-boot
sudo install -m 644 /opt/termag/deploy/termag-apps.service /etc/systemd/system/termag-apps.service
sudo nginx -t
sudo systemctl disable --now nginx
sudo systemctl enable termag-apps.service

# ─────────────────────────────────────────────────────────────────────────────
# Log shipping over OTLP/HTTP (deploy/termag-otelcol.yaml). The
# journal, the cloud-init log and nginx's logs are on the root volume, which
# every deploy replaces. The upstream contrib build, checksum-pinned, under a
# system user that can read the journal (systemd-journal) and nginx's logs
# (adm). Enabled, not started: termag-otelcol-env reads the backend .env, which
# only cloud-init writes. Bump OTELCOL_VERSION and OTELCOL_SHA256 together
# (the release's otelcol-contrib_<v>_linux_arm64.tar.gz.sha256).
# ─────────────────────────────────────────────────────────────────────────────
OTELCOL_VERSION=0.161.0
OTELCOL_SHA256=cd5de93213a0dbb90e4998b3b9e4e15ed691ec635cf7cf4147f95799fb16b676
curl -fsSL --retry 3 -o /tmp/otelcol-contrib.tar.gz \
    "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${OTELCOL_VERSION}/otelcol-contrib_${OTELCOL_VERSION}_linux_arm64.tar.gz"
echo "${OTELCOL_SHA256}  /tmp/otelcol-contrib.tar.gz" | sha256sum -c -
sudo install -d -m 0755 -o root -g root /usr/local/lib/termag/otelcol
sudo tar -xzf /tmp/otelcol-contrib.tar.gz -C /usr/local/lib/termag/otelcol otelcol-contrib
sudo chown root:root /usr/local/lib/termag/otelcol/otelcol-contrib
rm -f /tmp/otelcol-contrib.tar.gz
/usr/local/lib/termag/otelcol/otelcol-contrib --version
if ! id -u termag-otelcol >/dev/null 2>&1; then
    sudo useradd -r -M -d /nonexistent -s /usr/sbin/nologin termag-otelcol
fi
sudo usermod -aG systemd-journal,adm termag-otelcol
sudo install -m 0755 -o root -g root /opt/termag/deploy/termag-otelcol-env /usr/local/lib/termag/termag-otelcol-env
sudo install -m 0644 -o root -g root /opt/termag/deploy/termag-otelcol.yaml /usr/local/lib/termag/otelcol/termag-otelcol.yaml
sudo install -m 0644 -o root -g root /opt/termag/deploy/termag-otelcol.service /etc/systemd/system/termag-otelcol.service
# Validate the baked config against a stand-in for what the env script renders.
otelcol_check=$(mktemp -d)
printf 'OBSERVABILITY_PROJECT=bakecheck\nOBSERVABILITY_OTLP_ENDPOINT=https://otel.example.com\n' >"$otelcol_check/env"
TERMAG_OTELCOL_BACKEND_ENV="$otelcol_check/env" TERMAG_OTELCOL_OUT="$otelcol_check/destination.yaml" \
    /usr/local/lib/termag/termag-otelcol-env
printf 'extensions:\n  file_storage:\n    directory: %s\n' "$otelcol_check" >"$otelcol_check/state.yaml"
/usr/local/lib/termag/otelcol/otelcol-contrib validate \
    --config=/usr/local/lib/termag/otelcol/termag-otelcol.yaml \
    --config="$otelcol_check/destination.yaml" --config="$otelcol_check/state.yaml"
rm -rf "$otelcol_check"
sudo systemctl daemon-reload
sudo systemctl enable termag-otelcol.service

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

# termag-otelcol ships the journal and nginx's logs from the beginning, so an
# instance would otherwise re-send the builder's on its first boot.
sudo journalctl --rotate
sudo journalctl --vacuum-time=1s
sudo find /var/log/nginx -type f -name '*.log' -exec truncate -s 0 {} +

# Truncate machine-id so each EC2 launched from this AMI gets a fresh one.
sudo truncate -s 0 /etc/machine-id
sudo rm -f /var/lib/dbus/machine-id
sudo ln -s /etc/machine-id /var/lib/dbus/machine-id

log "Orchestrator AMI bake complete. Baked termag SHA: $(sudo cat /opt/termag/.termag-baked-sha 2>/dev/null || echo unknown)"
