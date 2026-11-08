#!/bin/bash
# Functions shared by the box bake's provisioners. box.pkr.hcl ships this to
# /tmp/box-lib.sh and an inline provisioner right after copies it to
# /var/lib/termag-bake/box-lib.sh, which outlives the /tmp wipes setup.sh and
# refresh-box.sh do at their end. Source it from there.

# Wait for termag's boot-time user units (termag-reconcile,
# termag-claude-update-boot) to finish. $1 = log prefix for the refusal message.
# termag-claude-update-boot is skipped in a bake (it needs an agent config,
# which only a launched box has), so it is here only in case that ever
# changes: an npm install into ~/.nvm must not be cut by the bake's sweep of
# termag's processes, or still be writing at its home write baseline. Its own
# cap is 5 min (TimeoutStartSec), inside this wait's 10.
wait_for_boot_units() {
    local prefix=${1:-[packer]} uid busy=""
    uid=$(id -u termag)
    for _ in $(seq 1 120); do
        busy=$(sudo -u termag XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user list-units \
                    --type=service --state=running,activating --no-legend --plain 2>/dev/null \
                | awk '{print $1}' | grep -E '^termag-(reconcile|claude-update-boot)\.service$' || true)
        [ -z "$busy" ] && return 0
        sleep 5
    done
    echo "$prefix $busy still running after 10 minutes; refusing to continue under it" >&2
    exit 1
}

# Install the deploy/ artifacts box.pkr.hcl shipped to /tmp onto their paths
# in termag's home.
install_deploy_artifacts() {
    sudo mkdir -p /home/termag/.config/systemd/user/default.target.wants /home/termag/.claude /home/termag/.local/bin
    sudo cp /tmp/termag-agent.service /home/termag/.config/systemd/user/termag-agent.service
    sudo cp /tmp/claude-settings.json /home/termag/.claude/settings.json
    sudo install -m 755 /tmp/termag-status /home/termag/.local/bin/termag-status
    sudo install -m 755 /tmp/termag-reconcile /home/termag/.local/bin/termag-reconcile
    sudo cp /tmp/termag-reconcile.service /home/termag/.config/systemd/user/termag-reconcile.service
    sudo ln -sf ../termag-reconcile.service \
        /home/termag/.config/systemd/user/default.target.wants/termag-reconcile.service
    # No default.target.wants symlink: the backend starts this unit through the
    # agent once it has connected. Starting it at boot would run it with no
    # credential. termag-reconcile lists it as noenable for the same reason.
    sudo install -m 755 /tmp/termag-hook-run /home/termag/.local/bin/termag-hook-run
    sudo cp /tmp/termag-on-warm.service \
        /home/termag/.config/systemd/user/termag-on-warm.service
    sudo chown -R termag:termag /home/termag/.config /home/termag/.claude /home/termag/.local/bin
}

# The browser pane's guest user: termag-guest,
# its Chromium wrapper and sudoers entry, and the egress rule that keeps it to
# the agent's pane proxies. Runs from the checkout cloned above, as termag:
# cloud-init renames that user at launch and the sudoers entry names its uid,
# which the rename keeps. termag-reconcile runs the same script on every boot,
# so a box baked before it converges too.
install_guest_browser() {
    sudo bash /home/termag/src/termag/deploy/termag-guest-browser-setup --agent-user termag
}

# The GitHub CLI's root updater: its recipe, root's copy of the lib, the start helper, the system
# unit and the one sudoers line that lets the agent user start it. gh is
# installed above as root, from GitHub's apt repository. Runs from the
# checkout cloned above, as termag (the sudoers line names its uid, which the
# rename at launch keeps); termag-reconcile runs the same script on every
# boot, so a box baked before it converges too.
install_gh_updater() {
    sudo bash /home/termag/src/termag/deploy/termag-gh-update-setup --agent-user termag
}

# The AWS CLI v2's root updater: the GitHub CLI's seam again, with AWS's PGP key as the
# keyring every zip is verified with. The AWS CLI is installed above as root,
# with AWS's installer; termag-reconcile runs the same script on every boot.
install_aws_updater() {
    sudo bash /home/termag/src/termag/deploy/termag-aws-update-setup --agent-user termag
}

# Docker's at-start updater ("Docker: an update at the
# box's start"): its recipe, root's copy of the lib and the system unit that
# installs a queued Docker update at boot, before docker.service. Docker is
# installed above from download.docker.com; termag-reconcile runs the same
# script on every boot.
install_docker_updater() {
    sudo bash /home/termag/src/termag/deploy/termag-docker-update-setup --agent-user termag
}

# Terminfo for terminals Ubuntu 24.04's ncurses lacks (Ghostty's
# xterm-ghostty), system-wide in /etc/terminfo, so plain ssh and editor
# Remote-SSH from those terminals reach a tmux that will attach. From the
# checkout cloned above, like install_guest_browser; termag-reconcile runs the
# same script on every boot, so a box baked before it converges too.
install_terminfo() {
    sudo bash /home/termag/src/termag/deploy/termag-terminfo-setup
}

# Mark the box for login shells, so tooling can tell it runs on a termag box
# (the hostname is no signal), and a shell from ssh or a bare `tmux` of the
# owner's does not pass through termag-agent.service, which sets the same variable for
# everything the agent spawns. Written on every bake, full or incremental, so
# an image refreshed from an older source picks it up too.
#
# Two files, because the box user's shell is zsh: /etc/profile.d is read by
# bash login shells only, and Debian's zsh never reads it (its /etc/zsh/zprofile
# is empty), so termag-credentials puts GH_HOST in ~/.zshenv for the same
# reason. /etc/zsh/zshenv is read by every zsh, login or not, survives the
# home rename at launch, and zsh is installed well before this runs. Appended
# once, below the package's own PATH guard.
#
# ~/.local/bin goes on PATH there too. ~/.zshrc puts it there for interactive
# shells only, so a non-interactive zsh (`ssh box -- termag ask …`, `zsh -c`)
# could not find the termag CLI, termag-status or the agent CLIs installed
# there. The termag launcher pins its own Node, so this is all the CLI needs
# (nvm stays in ~/.zshrc). Guarded on its own line, because an image refreshed
# from an older source already has the marker. ~/.zshrc prepends it again
# later; a repeated PATH entry is harmless.
ZSHENV_LOCAL_BIN='if [ -d "$HOME/.local/bin" ]; then case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac; fi'
install_box_marker() {
    printf 'export TERMAG_BOX=1\n' | sudo tee /etc/profile.d/termag-box.sh >/dev/null
    sudo chmod 0644 /etc/profile.d/termag-box.sh
    if ! sudo grep -qxF 'export TERMAG_BOX=1' /etc/zsh/zshenv 2>/dev/null; then
        printf '\n# termag box marker (packer/scripts/box-lib.sh, install_box_marker)\nexport TERMAG_BOX=1\n' \
            | sudo tee -a /etc/zsh/zshenv >/dev/null
    fi
    if ! sudo grep -qxF "$ZSHENV_LOCAL_BIN" /etc/zsh/zshenv 2>/dev/null; then
        printf '\n# ~/.local/bin for non-interactive zsh (packer/scripts/box-lib.sh, install_box_marker)\n%s\n' "$ZSHENV_LOCAL_BIN" \
            | sudo tee -a /etc/zsh/zshenv >/dev/null
    fi
}
