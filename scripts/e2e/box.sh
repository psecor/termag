#!/usr/bin/env bash
# Start one stand-in box of the running e2e stack: agent/agent.js with its own
# HOME and tmux server under <root>/boxes/<name>. The box's agent config must
# already be at <root>/boxes/<name>/home/.termag/agent.config.json. Called by
# up.sh for the boxes it seeds and by the EC2 launch fake for launched ones;
# the rest of the context comes from <root>/box.env, which up.sh writes.
#
#   box.sh <root> <name>
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
# shellcheck source-path=SCRIPTDIR
. "$here/fakes/fakes.sh"

root=${1:-}; name=${2:-}
if [ -z "$root" ] || [ -z "$name" ]; then die "usage: box.sh <root> <name>"; fi
[ "$(head -n1 "$root/.termag-e2e" 2>/dev/null)" = "$root" ] || die "$root is not an e2e stack root"
case $name in *[!A-Za-z0-9._-]*|.*) die "bad box name '$name'" ;; esac
# shellcheck disable=SC1091
. "$root/box.env"

box="$ROOT/boxes/$name"
[ -f "$box/home/.termag/agent.config.json" ] || die "$name has no agent config"
mkdir -p "$box/bin" "$box/etc/claude-code" "$box/etc/profile.d"
# A private tmux server per box: every tmux the agent or a pane runs goes
# through this wrapper, including the pty attach, which only keeps PATH.
printf '#!/bin/sh\nexec %q -S %q "$@"\n' "$REAL_TMUX" "$box/tmux.sock" >"$box/bin/tmux"
install -m 0755 "$repo/deploy/termag-status" "$box/bin/termag-status"
chmod 0755 "$box/bin/tmux"
printf 'PS1=%q\n' "[$name] \\w \\$ " >"$box/home/.bashrc"
printf '[ -f ~/.bashrc ] && . ~/.bashrc\n' >"$box/home/.bash_profile"
git config -f "$box/home/.gitconfig" user.name "E2E User"
git config -f "$box/home/.gitconfig" user.email "$EMAIL"
fakes_box "$name" "$box"
log "starting $name (HOME=$box/home)"
# termag-credentials writes the system gitconfig and a profile.d file under
# /etc (and removes Claude managed settings an earlier revision wrote) through
# sudo on a real box; a stand-in box keeps its own copies and needs no sudo.
# The Claude gateway keys go into the box HOME's ~/.claude/settings.json.
start_daemon "$name" "$repo/agent" env -i "${base_env[@]}" \
  "HOME=$box/home" "PATH=$box/bin:$PATH" "SHELL=/bin/bash" "TERM=xterm-256color" \
  "TERMAG_CLAUDE_MANAGED_SETTINGS=$box/etc/claude-code/managed-settings.json" "TERMAG_CREDENTIALS_SUDO=" \
  "GIT_CONFIG_SYSTEM=$box/etc/gitconfig" "TERMAG_PROFILE_D=$box/etc/profile.d" \
  "${box_extra[@]}" \
  node agent.js "$box/home/.termag/agent.config.json"
