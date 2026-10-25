#!/bin/bash
# Functions shared by the box bake's provisioners. box.pkr.hcl ships this to
# /tmp/box-lib.sh and an inline provisioner right after copies it to
# /var/lib/termag-bake/box-lib.sh, which outlives the /tmp wipes setup.sh and
# refresh-box.sh do at their end. Source it from there.

# Wait for termag's boot-time user unit (termag-reconcile)
# to finish. $1 = log prefix for the refusal message.
wait_for_boot_units() {
    local prefix=${1:-[packer]} uid busy=""
    uid=$(id -u termag)
    for _ in $(seq 1 120); do
        busy=$(sudo -u termag XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user list-units \
                    --type=service --state=running,activating --no-legend --plain 2>/dev/null \
                | awk '{print $1}' | grep -E '^termag-reconcile\.service$' || true)
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
