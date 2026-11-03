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
# through bin/tmux (write_box_tmux in lib.sh), which runs it with the box's
# environment whoever calls it, including the pty attach, which only keeps
# PATH. The socket sits alone in a directory only the wrapper makes writable,
# so no other tmux can start a server for the box (docs/e2e-stack.md,
# "Isolation").
# A unix socket's path must fit sun_path (104 bytes on macOS, whose TMPDIR is
# long already; 108 on Linux), and a launched box is named by its owner, so a
# path that would not fit is replaced by one under <root>/tmux named by a
# checksum of the box name. down.sh stops the servers on both.
box_sock_dir="$box/tmux"
if [ "${#box_sock_dir}" -ge 95 ]; then
  box_sock_dir="$ROOT/tmux/$(printf '%s' "$name" | cksum | cut -d' ' -f1)"
  [ "${#box_sock_dir}" -lt 95 ] || die "the stack root $ROOT is too long for a tmux socket path; use a shorter TMPDIR"
fi
box_sock="$box_sock_dir/sock"
mkdir -p "$box_sock_dir"
chmod 0500 "$box_sock_dir"
install -m 0755 "$repo/deploy/termag-status" "$box/bin/termag-status"
printf 'PS1=%q\n' "[$name] \\w \\$ " >"$box/home/.bashrc"
# Panes are login shells, and a login shell runs the system profile first
# (/etc/profile and profile.d, macOS's path_helper, /etc/zsh/zshenv and
# zprofile), which puts /usr/local/bin, Homebrew or /snap/bin, where your own
# CLIs live, back on PATH. The box's own login profiles run after it and end
# on the box's allow-list PATH. Replaced, never written through: a dotfiles
# link here would otherwise carry this into your dotfiles clone.
box_path_line="export PATH=$(printf %q "$(box_path "$box" "$ROOT")")"
rm -f "$box/home/.bash_profile" "$box/home/.profile" "$box/home/.zprofile"
printf '%s\n[ -f ~/.bashrc ] && . ~/.bashrc\n' "$box_path_line" >"$box/home/.bash_profile"
printf '%s\n' "$box_path_line" >"$box/home/.profile"
printf '%s\n' "$box_path_line" >"$box/home/.zprofile"
git config -f "$box/home/.gitconfig" user.name "E2E User"
git config -f "$box/home/.gitconfig" user.email "$EMAIL"
fakes_box "$name" "$box"
# termag-credentials writes the system gitconfig and a profile.d file under
# /etc (and removes Claude managed settings an earlier revision wrote) through
# sudo on a real box; a stand-in box keeps its own copies and needs no sudo.
# The Claude gateway keys go into the box HOME's ~/.claude/settings.json.
# macOS's /bin/bash opens every pane (and t3 terminal) with a "default shell is
# now zsh" notice unless told not to.
# The box's boot id (agent/box-notice.js): the stand-in boxes share this
# machine's kernel, so each box keeps its own, new after a power stop
# (fakes/ec2-launcher.mjs removes it) and kept across an agent restart.
[ -s "$box/boot_id" ] || node -e 'process.stdout.write(require("crypto").randomUUID())' >"$box/boot_id"
box_env=("${base_env[@]}"
  "TERMAG_BOOT_ID_FILE=$box/boot_id"
  "HOME=$box/home" "PATH=$(box_path "$box" "$ROOT")" "SHELL=/bin/bash" "TERM=xterm-256color" BASH_SILENCE_DEPRECATION_WARNING=1
  "TERMAG_CLAUDE_MANAGED_SETTINGS=$box/etc/claude-code/managed-settings.json" "TERMAG_CREDENTIALS_SUDO="
  "GIT_CONFIG_SYSTEM=$box/etc/gitconfig" "TERMAG_PROFILE_D=$box/etc/profile.d"
  "${box_extra[@]}")
write_box_tmux "$box/bin/tmux" "$REAL_TMUX" "$box_sock" "${TMUX_FAULTS:+$box/tmux-fault}" "${box_env[@]}"
# Up before the agent, and up for as long as the box is: a server is started
# only here or by the wrapper, never lazily by whichever tmux comes first.
"$box/bin/tmux" start-server || die "$name's tmux server did not start"
log "starting $name (HOME=$box/home)"
start_daemon "$name" "$repo/agent" env -i "${box_env[@]}" node agent.js "$box/home/.termag/agent.config.json"
