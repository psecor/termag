#!/bin/bash
# Provisions a termag box AMI. Runs once at AMI bake time.
#
# Goal: bake a box with a full devbox toolset, so an agent on a box has the
# same capabilities a human gets on a workstation: full language toolchains (Go, Python, Rust, Node),
# the agent CLIs (Claude Code, Codex, cursor, devin), and the dev tooling
# (Docker, terraform, uv, ripgrep, neovim, zsh, …).
#
# Everything user-scoped is installed under /home/termag. At launch,
# cloudinit.sh.tftpl renames `termag` → the box owner's Unix username and
# rewrites the baked-in paths, so these installs follow the rename.
#
# Environment variables (set by Packer):
#   TERMAG_BAKED_SHA     commit of the checkout shipped as /tmp/termag.bundle
#                        ("unknown" on a hand-run build)
#   AGENT_WIKI_REPO_URL

set -euo pipefail

log() { echo "[packer] $*"; }

# Echo every command so the packer build log is debuggable when something
# changes upstream and an install command starts failing.
set -x

export DEBIAN_FRONTEND=noninteractive

# Packer runs this script from the builder's login dir (/home/ubuntu, mode
# 700). The `sudo -u termag -H bash` blocks below inherit that cwd, and some
# toolchain tools (goenv/pyenv) internally `cd "$PWD"` for project-version
# detection — which fails "Permission denied" because termag can't enter
# /home/ubuntu, aborting the bake. Move to a world-accessible cwd so every
# sub-shell has a PWD it can sit in; all real paths below are absolute.
cd /tmp

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
# System packages (mirrors the devbox base set + termag extras + pyenv build deps)
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
    python3-venv \
    zsh \
    zoxide \
    ripgrep \
    keychain \
    postgresql-client \
    rsync \
    tpm2-tools
# pyenv build dependencies (so `pyenv install` can compile CPython)
apt_get install -y \
    make libssl-dev zlib1g-dev libbz2-dev libreadline-dev libsqlite3-dev \
    llvm libncursesw5-dev xz-utils tk-dev libxml2-dev libxmlsec1-dev \
    libffi-dev liblzma-dev

# ─────────────────────────────────────────────────────────────────────────────
# Neovim (latest stable — the apt build is too old for the plugin set)
# ─────────────────────────────────────────────────────────────────────────────
curl -fsSL "https://github.com/neovim/neovim/releases/latest/download/nvim-linux-arm64.tar.gz" -o /tmp/nvim.tar.gz
sudo tar -xzf /tmp/nvim.tar.gz -C /opt
sudo ln -sf /opt/nvim-linux-arm64/bin/nvim /usr/local/bin/nvim
rm -f /tmp/nvim.tar.gz

# ─────────────────────────────────────────────────────────────────────────────
# GitHub CLI (gh) — upstream apt repo, not the stale Ubuntu one
# ─────────────────────────────────────────────────────────────────────────────
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=arm64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list

# ─────────────────────────────────────────────────────────────────────────────
# HashiCorp apt repo (terraform) — arm64
# ─────────────────────────────────────────────────────────────────────────────
curl -fsSL https://apt.releases.hashicorp.com/gpg \
    | sudo gpg --dearmor -o /usr/share/keyrings/hashicorp-archive-keyring.gpg
echo "deb [arch=arm64 signed-by=/usr/share/keyrings/hashicorp-archive-keyring.gpg] https://apt.releases.hashicorp.com $(lsb_release -cs) main" \
    | sudo tee /etc/apt/sources.list.d/hashicorp.list

apt_get update -y
apt_get install -y gh terraform

# ─────────────────────────────────────────────────────────────────────────────
# AWS CLI v2 (Canonical's AMI doesn't ship this)
# ─────────────────────────────────────────────────────────────────────────────
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o /tmp/awscliv2.zip
unzip -q /tmp/awscliv2.zip -d /tmp
sudo /tmp/aws/install
rm -rf /tmp/awscliv2.zip /tmp/aws

# ─────────────────────────────────────────────────────────────────────────────
# Doppler CLI (devbox parity)
# ─────────────────────────────────────────────────────────────────────────────
curl -fsSL https://cli.doppler.com/install.sh | sudo sh || true

# ─────────────────────────────────────────────────────────────────────────────
# Docker (devbox parity — docker-ce + buildx + compose)
# ─────────────────────────────────────────────────────────────────────────────
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /tmp/docker.asc
sudo install -m 0644 /tmp/docker.asc /etc/apt/keyrings/docker.asc
rm -f /tmp/docker.asc
echo "deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list
apt_get update -y
apt_get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# ─────────────────────────────────────────────────────────────────────────────
# Chromium — browser-harness drives this over CDP. Snap is the supported
# Chromium channel on Ubuntu 24.04 arm64. (Headless CDP / VNC wiring is
# per-user; we only bake the binary.)
# ─────────────────────────────────────────────────────────────────────────────
sudo snap install chromium || true

# ─────────────────────────────────────────────────────────────────────────────
# termag unix user (placeholder — renamed to the box owner at launch). zsh is
# the default shell to match the devbox; docker + sudo group membership follow
# the rename.
# ─────────────────────────────────────────────────────────────────────────────
if ! id termag >/dev/null 2>&1; then
    sudo useradd -m -s /bin/zsh -c "termag agent runtime" termag
fi
sudo usermod -aG docker termag
# Passwordless sudo for the box owner. The box is single-tenant (one user per
# box), the account is created without a password, and users need to install
# their own tooling (apt/etc.) — so NOPASSWD is required for `sudo` to work at
# all. The policy is keyed on the `sudo` *group*, not a username, so it survives
# the `termag` → box-owner rename cloud-init does at launch; membership is baked
# here and re-asserted in cloudinit.sh.tftpl after the rename.
sudo usermod -aG sudo termag
printf '%%sudo ALL=(ALL:ALL) NOPASSWD:ALL\n' | sudo tee /etc/sudoers.d/90-termag-box >/dev/null
sudo chmod 0440 /etc/sudoers.d/90-termag-box
sudo visudo -cf /etc/sudoers.d/90-termag-box
# Allow termag's systemd --user to keep running without an interactive session.
sudo loginctl enable-linger termag

# ─────────────────────────────────────────────────────────────────────────────
# nvm + Node LTS + corepack (yarn/pnpm) + the npm-based agent CLIs.
# nvm-only: there is no system Node. The agent's systemd unit sources nvm to
# find node (see deploy/termag-agent.service). corepack provides yarn + pnpm.
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<'NVM_INSTALL'
set -euo pipefail
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm install --lts
nvm alias default 'lts/*'
corepack enable
corepack prepare yarn@stable --activate
corepack prepare pnpm@latest --activate
# Agent CLIs that live on the Node toolchain:
npm install -g @anthropic-ai/claude-code @openai/codex
NVM_INSTALL

# ─────────────────────────────────────────────────────────────────────────────
# goenv + Go (1.26.1)
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<'GOENV_INSTALL'
set -euo pipefail
git clone https://github.com/go-nv/goenv.git "$HOME/.goenv"
export GOENV_ROOT="$HOME/.goenv"
export PATH="$GOENV_ROOT/bin:$PATH"
eval "$(goenv init -)"
goenv install 1.26.1
goenv global 1.26.1
GOENV_INSTALL

# ─────────────────────────────────────────────────────────────────────────────
# pyenv + Python + poetry
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<'PYENV_INSTALL'
set -euo pipefail
git clone https://github.com/pyenv/pyenv.git "$HOME/.pyenv"
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
pyenv install 3.13
pyenv global 3.13
pip install poetry
PYENV_INSTALL

# ─────────────────────────────────────────────────────────────────────────────
# Rust (rustup) — cargo for building rtk and Rust projects
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<'RUST_INSTALL'
set -euo pipefail
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
RUST_INSTALL

# ─────────────────────────────────────────────────────────────────────────────
# uv (Astral) — Python package/tool manager; also installs browser-harness
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<'UV_INSTALL'
set -euo pipefail
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
# browser-harness — public repo, installed as a uv tool. Needs Chromium (baked
# above) + per-user CDP/VNC wiring at use time.
uv tool install "git+https://github.com/browser-use/browser-harness" || echo "[packer] browser-harness install skipped (non-fatal)"
UV_INSTALL

# ─────────────────────────────────────────────────────────────────────────────
# rtk (Rust Token Killer) — public repo, built with cargo into ~/.cargo/bin
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<'RTK_INSTALL'
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"
git clone --depth 1 https://github.com/rtk-ai/rtk.git /tmp/rtk
( cd /tmp/rtk && cargo install --path . ) || echo "[packer] rtk build failed (non-fatal)"
rm -rf /tmp/rtk
RTK_INSTALL

# ─────────────────────────────────────────────────────────────────────────────
# clickhousectl (official ClickHouse CLI) — best-effort; the upstream installer
# surface changes, so this is non-fatal.
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<'CHCTL_INSTALL'
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
curl -fsSL https://clickhouse.com/ | sh || echo "[packer] clickhousectl install skipped (non-fatal)"
CHCTL_INSTALL

# ─────────────────────────────────────────────────────────────────────────────
# Agent CLIs that ship their own per-user installers (land under ~/.local/bin)
# ─────────────────────────────────────────────────────────────────────────────

# Cursor agent CLI
sudo -u termag -H bash -c "curl https://cursor.com/install -fsS | bash"

# Devin for Terminal — its installer auto-runs an interactive `devin login` at
# the end that bombs out in the bake; the binary is placed before that, so we
# accept the non-zero exit and verify presence below.
sudo -u termag -H bash -c "curl -fsSL https://cli.devin.ai/install.sh | bash" || true
sudo -u termag test -x /home/termag/.local/bin/devin \
    || { echo "[packer] devin binary missing after install — failing build"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# Oh My Zsh + autosuggestions, TPM, and the devbox dotfiles. The .zshrc wires
# every toolchain above onto PATH for the agent's interactive tmux panes (zsh).
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<'OMZ_INSTALL'
set -euo pipefail
RUNZSH=no KEEP_ZSHRC=yes sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
git clone https://github.com/zsh-users/zsh-autosuggestions "$HOME/.oh-my-zsh/custom/plugins/zsh-autosuggestions"
git clone https://github.com/tmux-plugins/tpm "$HOME/.tmux/plugins/tpm"
OMZ_INSTALL

# .zshrc — PATH + version-manager init (nvm, goenv, pyenv, cargo, uv, ~/.local/bin).
sudo -u termag tee /home/termag/.zshrc >/dev/null <<'ZSHRC'
export PATH="$HOME/.local/bin:$HOME/bin:$HOME/.cargo/bin:$PATH"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"

command -v zoxide >/dev/null 2>&1 && eval "$(zoxide init zsh)"

export GOENV_ROOT="$HOME/.goenv"
export PATH="$GOENV_ROOT/bin:$PATH"
eval "$(goenv init -)"
export PATH="$PATH:$(go env GOPATH 2>/dev/null)/bin"

export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"

export ZSH="$HOME/.oh-my-zsh"
ZSH_THEME="robbyrussell"
plugins=(git vi-mode zsh-autosuggestions)
source $ZSH/oh-my-zsh.sh

export EDITOR=nvim
export VISUAL=nvim
alias vim="nvim"
ZSHRC

# .tmux.conf — devbox tmux config (mouse, pane nav, vi copy, clipboard, TPM).
sudo -u termag tee /home/termag/.tmux.conf >/dev/null <<'TMUX_CONF'
set -g mouse on
set -g status on
set -g status-style 'bg=#333333 fg=#ffffff'
set -g window-status-current-style 'bg=#5555ff fg=#ffffff bold'
set -g pane-border-status top
set -g pane-border-format ' #{?pane_active,#[fg=#5555ff bold],#[fg=#888888]}#{pane_current_command} '
bind -n C-h select-pane -L
bind -n C-j select-pane -D
bind -n C-k select-pane -U
bind -n C-l select-pane -R
bind -n C-p previous-window
bind -n C-n next-window
set-window-option -g mode-keys vi
bind-key -T copy-mode-vi v send-keys -X begin-selection
bind-key -T copy-mode-vi y send-keys -X copy-selection-and-cancel
set -g set-clipboard on
set -g extended-keys always
set -as terminal-features 'xterm*:extkeys'
set -g @plugin 'tmux-plugins/tpm'
set -g @plugin 'tmux-plugins/tmux-resurrect'
set -g @plugin 'tmux-plugins/tmux-continuum'
set -g @continuum-restore 'on'
run '~/.tmux/plugins/tpm/tpm'
TMUX_CONF

# .gitconfig — sane defaults. user.name/email are filled in at launch by cloud-init.
sudo -u termag tee /home/termag/.gitconfig >/dev/null <<'GITCONF'
[init]
    defaultBranch = main
[pull]
    rebase = true
[push]
    autoSetupRemote = true
[help]
    autocorrect = 1
GITCONF

# Neovim config (vim-plug + treesitter/telescope/tree — matches the devbox).
sudo -u termag mkdir -p /home/termag/.config/nvim
sudo -u termag tee /home/termag/.config/nvim/init.lua >/dev/null <<'INITLUA'
local plug_path = vim.fn.stdpath("data") .. "/site/autoload/plug.vim"
if vim.fn.filereadable(plug_path) == 0 then
  vim.fn.system({ "curl", "-fLo", plug_path, "--create-dirs",
    "https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim" })
  vim.cmd("source " .. plug_path)
end
local Plug = vim.fn["plug#"]
vim.call("plug#begin")
Plug("EdenEast/nightfox.nvim")
Plug("nvim-treesitter/nvim-treesitter", { ["do"] = ":TSUpdate" })
Plug("nvim-tree/nvim-web-devicons")
Plug("nvim-tree/nvim-tree.lua")
Plug("nvim-lua/plenary.nvim")
Plug("nvim-telescope/telescope.nvim")
vim.call("plug#end")
if vim.fn.isdirectory(vim.fn.stdpath("data") .. "/plugged/nightfox.nvim") == 0 then
  vim.cmd("autocmd VimEnter * PlugInstall --sync | source $MYVIMRC")
  return
end
vim.cmd.colorscheme("carbonfox")
vim.opt.clipboard = "unnamedplus"
vim.opt.number = true
vim.opt.relativenumber = true
local ok_telescope, tb = pcall(require, "telescope.builtin")
if ok_telescope then
  vim.keymap.set("n", "<C-o>", tb.find_files, { desc = "Find files" })
  vim.keymap.set("n", "<C-f>", tb.live_grep, { desc = "Search in files" })
end
INITLUA

sudo chown -R termag:termag /home/termag/.config /home/termag/.gitconfig /home/termag/.zshrc /home/termag/.tmux.conf

# ─────────────────────────────────────────────────────────────────────────────
# Clone termag (from the shipped bundle) + agent-wiki into the termag user's
# home, install deps with the nvm toolchain.
# ─────────────────────────────────────────────────────────────────────────────
sudo -u termag -H bash <<EOF
set -euo pipefail
export NVM_DIR="\$HOME/.nvm"
. "\$NVM_DIR/nvm.sh"

mkdir -p /home/termag/src
cd /home/termag/src

# The termag source is THIS checkout, shipped by box.pkr.hcl as a git bundle
# (scripts/bundle-source.sh): full history, so git log/blame/bisect work on the
# box; no credentials, no node_modules, nothing untracked. Nothing is cloned
# from a remote. A merge to main reaches new boxes through the scheduled bake,
# whose staleness check diffs agent/ for exactly this reason.
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

git clone "${AGENT_WIKI_REPO_URL}" agent-wiki || true

# Record the baked commit so a live box can be checked against the TermagSha
# tag of the image it launched from.
echo "\$baked" > /home/termag/.termag-baked-sha
EOF

# ─────────────────────────────────────────────────────────────────────────────
# systemd --user unit. Cloud-init writes
# ~termag/src/termag/agent/agent.config.json with the bearer token at launch,
# then `systemctl --user enable --now termag-agent`. The unit sources nvm to
# locate node (nvm-only — no system node).
# ─────────────────────────────────────────────────────────────────────────────
sudo mkdir -p /home/termag/.config/systemd/user
sudo cp /tmp/termag-agent.service /home/termag/.config/systemd/user/termag-agent.service
sudo chown -R termag:termag /home/termag/.config

# ─────────────────────────────────────────────────────────────────────────────
# Claude Code status hooks. termag tracks working/waiting/idle state via hooks
# that POST to the local agent; without them the status lights stay grey. Baked
# from deploy/claude-settings.json (file-provisioned to /tmp) so this is no
# longer the manual step it used to be in setup.md.
# ─────────────────────────────────────────────────────────────────────────────
sudo mkdir -p /home/termag/.claude /home/termag/.local/bin
sudo cp /tmp/claude-settings.json /home/termag/.claude/settings.json
# The hooks call termag-status, which resolves the server endpoint from the
# agent's own termag_url. Hardcoding localhost here breaks every box whose
# server is not co-located, and does so silently.
sudo install -m 755 /tmp/termag-status /home/termag/.local/bin/termag-status
sudo chown -R termag:termag /home/termag/.claude /home/termag/.local

# ─────────────────────────────────────────────────────────────────────────────
# Artifact reconciliation. `deploy/` is the source of truth for the agent unit
# and the per-user scripts, but until now nothing installed it onto the live
# paths outside this bake -- so a box whose checkout was current could still be
# *running* artifacts from the AMI it launched from. Observed on a live box:
# ~/src/termag carried the merged KillMode=process fix while the installed unit
# did not, and the installed termag-status was a 95-line intermediate copy that
# predated the endpoint-resolution fix. Both merged; neither in effect.
#
# The unit is ordered before termag-agent.service, so the agent starts from the
# reconciled unit and nothing needs restarting.
#
# The wants symlink below is load-bearing, not belt-and-braces: it is what makes
# the reconciler run on a new box's first boot. termag-reconcile maintains the
# other units' symlinks itself from then on, but it cannot enable itself on a box
# that never had it -- there, one manual run of `termag-reconcile` does that.
# ─────────────────────────────────────────────────────────────────────────────
sudo install -m 755 /tmp/termag-reconcile /home/termag/.local/bin/termag-reconcile
sudo cp /tmp/termag-reconcile.service \
    /home/termag/.config/systemd/user/termag-reconcile.service
sudo ln -sf ../termag-reconcile.service \
    /home/termag/.config/systemd/user/default.target.wants/termag-reconcile.service

sudo chown -R termag:termag /home/termag/.local /home/termag/.config

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

log "AMI bake complete. Baked termag SHA: $(sudo cat /home/termag/.termag-baked-sha 2>/dev/null || echo unknown)"
