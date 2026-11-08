# shellcheck shell=bash
# Shared by up.sh, down.sh and status.sh. Sourced, not executed.
#
# A running stack lives entirely under one `mktemp -d` root. The pointer file
# is how down/status find it; the root's marker is how they know it is ours.

E2E_POINTER="${TMPDIR:-/tmp}/termag-e2e-$(id -un).root"

log() { printf '[e2e] %s\n' "$*"; }
die() { printf '[e2e] error: %s\n' "$*" >&2; exit 1; }

# E2E_FLAGS (a JSON object, already checked) with the flags production turns on
# together: simple-ui-review-clone-enabled wherever simple-ui-reviews-enabled is
# on, unless E2E_FLAGS names it. Without it,
# Review on a PR whose repository has no project here is a dead end ("No project
# on …") that production doesn't have.
e2e_flags_like_production() {
  node -e '
    const v = JSON.parse(process.argv[1]);
    if (v["simple-ui-reviews-enabled"] === true && !("simple-ui-review-clone-enabled" in v)) {
      process.stdout.write(JSON.stringify({ ...v, "simple-ui-review-clone-enabled": true }));
    } else {
      process.stdout.write(process.argv[1]);
    }
  ' "$1"
}

# Starts "$@" in <dir> as its own session/process group, so down.sh can stop
# the whole tree (tsx and vite each fork children) with one signal. The
# command is kept in cmds/<name> for scripts/e2e/ctl.sh to re-run. Needs ROOT.
start_daemon() {
  local name=$1 dir=$2; shift 2
  # shellcheck disable=SC2153
  printf '%s\0' "$dir" "$@" >"$ROOT/cmds/$name"
  launch_daemon "$ROOT" "$name"
}

# setsid(1), or perl's POSIX::setsid where there is none (macOS ships no
# setsid). The new session leader is the command itself, so its pid is the
# process group down.sh signals.
run_setsid() {
  if command -v setsid >/dev/null 2>&1; then exec setsid "$@"; fi
  exec perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; exec { $ARGV[0] } @ARGV or die "exec $ARGV[0]: $!"' -- "$@"
}

# Runs <root>/cmds/<name> as start_daemon describes, appending to its log.
launch_daemon() {
  local root=$1 name=$2 argv
  mapfile -d '' argv <"$root/cmds/$name"
  ( cd "${argv[0]}" && run_setsid "${argv[@]:1}" ) >>"$root/logs/$name.log" 2>&1 </dev/null &
  echo $! >"$root/pids/$name.pid"
}

# Prints the running stack's root, or fails when there is none. A root is only
# trusted when it sits in the temp dir, is a real directory and names itself
# in its marker, so a corrupt pointer can never aim down.sh elsewhere.
e2e_root() {
  local root
  [ -r "$E2E_POINTER" ] || return 1
  root=$(head -n1 "$E2E_POINTER")
  case $root in
    "${TMPDIR:-/tmp}"/termag-e2e.*) ;;
    *) return 1 ;;
  esac
  [ -d "$root" ] && [ ! -L "$root" ] || return 1
  [ "$(head -n1 "$root/.termag-e2e" 2>/dev/null)" = "$root" ] || return 1
  printf '%s\n' "$root"
}

# PIDs of this user's processes started by the stack at <root>. Every process
# the stack starts carries TERMAG_E2E_ROOT, and tmux servers and pane shells
# inherit it, so this also finds anything that escaped its process group.
e2e_pids() {
  local root=$1 p
  if [ ! -d /proc/self ]; then
    # No /proc (macOS), and its ps shows no other process's environment: fall
    # back to your own processes whose command line names a path under the
    # root (agents, tmux servers, postgres). The rest is in the process groups
    # down.sh signals. Never this shell, its ps and awk, or anything it runs
    # under: a caller's shell may well mention the root.
    local self=${BASHPID:-$$}
    ps -ww -U "$(id -u)" -o pid=,ppid=,command= 2>/dev/null | awk -v root="$root/" -v self="$self" '
      { parent[$1] = $2; line[$1] = $0 }
      END {
        for (p = self; p != "" && p != 0 && !(p in skip); p = parent[p]) skip[p] = 1
        for (p in line) if (!(p in skip) && parent[p] != self && index(line[p], root)) print p
      }'
    return 0
  fi
  for p in /proc/[0-9]*; do
    [ -O "$p" ] && [ -r "$p/environ" ] || continue
    if tr '\0' '\n' 2>/dev/null <"$p/environ" | grep -qxF "TERMAG_E2E_ROOT=$root"; then
      printf '%s\n' "${p#/proc/}"
    fi
  done
}

pg_bindir() {
  if [ -n "${E2E_PG_BIN:-}" ]; then printf '%s\n' "$E2E_PG_BIN"; return; fi
  if command -v pg_config >/dev/null 2>&1 && [ -x "$(pg_config --bindir)/initdb" ]; then
    pg_config --bindir; return
  fi
  find /usr/lib/postgresql -maxdepth 2 -name bin -type d 2>/dev/null | sort -V | tail -n1
}

# The S256 PKCE challenge for a CLI device sign-in's verifier (RFC 7636), as
# `termag login` and the desktop app make it. A base64url verifier starts with
# "-" one time in 64, and node takes such an argument for one of its own
# options unless "--" ends them.
pkce_challenge() {
  node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("base64url"))' -- "$1"
}

# Files created or modified since <marker> in the places a stack could leak
# into, other than <work> (the test's own temp dir). Skips the repo's .git and
# node_modules, the roots of other e2e stacks (a test runs beside the one a
# Cursor VM boots with), and editor, browser and VM state that changes on its
# own; E2E_LEAK_IGNORE adds an extended regex of paths to skip on other machines.
# Files dated after the check itself are skipped too: nothing the stack wrote
# can be, and bazel stamps its install tree ten years ahead
# (~/.cache/bazel/_bazel_*/install), which is on every box with webapp.
e2e_leaks() {
  local marker=$1 work=$2 repo now
  repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  now="$work/.leak-check-now"
  : >"$now"
  find "$HOME" /var/tmp /tmp "$repo" -xdev -newer "$marker" ! -newer "$now" \( -type f -o -type l -o -type s \) \
    -not -path "$work/*" -not -path "$repo/.git/*" -not -path '*/node_modules/*' \
    -not -path '/tmp/termag-e2e.*/*' -not -path '/var/tmp/termag-e2e.*/*' \
    -not -path "$HOME/.cursor/*" -not -path "$HOME/.cursor-server/*" \
    -not -path "$HOME/.config/google-chrome/*" -not -path "$HOME/.cache/google-chrome/*" \
    -not -path /tmp/agent-store-fuse.log -not -path '/tmp/computer-use/*' 2>/dev/null \
    | { if [ -n "${E2E_LEAK_IGNORE:-}" ]; then grep -Ev "$E2E_LEAK_IGNORE"; else cat; fi; } | head -n 20
}

# The status the backend files for <session> under box <box>: read with that
# box's agent token (on curl's stdin, not argv), as the box's agent reads it.
e2e_box_status() {
  local root=$1 box=$2 api=$3 session=$4
  jq -r '"header = \"Authorization: Bearer \(.token)\""' "$root/boxes/$box/home/.termag/agent.config.json" \
    | curl -s -K - "$api/api/status/$session" | jq -r .status
}

# Writes <wrapper>, a stand-in box's bin/tmux: every tmux call for the box goes
# through it, and a box's tmux server must only ever hold the box's
# environment. A server started from your own shell would give every pane in it
# your HOME (your ~/.claude hooks, your termag agent config and token), and
# termag-status in those panes would post to your real orchestrator. So the
# wrapper runs tmux under `env -i` with <env> (the box agent's environment),
# keeping only the caller's TERM and COLORTERM, and TMUX and TMUX_PANE when
# they name this box's socket (a pane's own tmux calls need them). The
# socket's directory is read-only except while the wrapper starts the server,
# so a `tmux -S <socket>` that bypasses the wrapper cannot start one there; it
# can only reach the running server, whose environment is the box's. The
# server is kept up with no sessions (exit-empty off), so there is no gap for a
# stray one to fill. <fault file> (E2E_TMUX_FAULTS) is read before each call.
#   write_box_tmux <wrapper> <real tmux> <socket> <fault file or ''> <env>...
write_box_tmux() {
  local wrapper=$1 real=$2 sock=$3 fault=$4
  shift 4
  {
    echo '#!/usr/bin/env bash'
    echo '# Written by scripts/e2e/box.sh (write_box_tmux in scripts/e2e/lib.sh).'
    printf 'real=%q sock=%q\n' "$real" "$sock"
    printf 'box_env=('; printf ' %q' "$@"; printf ' )\n'
    if [ -n "$fault" ]; then
      # Modes match the agent's attach sequence: it sets set-clipboard right
      # before each `tmux attach-session`, and polls with capture-pane.
      printf 'mode=$(cat %q 2>/dev/null)\n' "$fault"
      cat <<'FAULT'
case "$mode:${1-} ${2-} ${3-}" in
  attach-delay=*:"set-option -g set-clipboard") sleep "${mode#attach-delay=}" ;;
  hang:capture-pane*|hang:display-message*) exec sleep 100000 ;;
esac
FAULT
    fi
    cat <<'BODY'
for v in TERM COLORTERM; do [ -n "${!v-}" ] && box_env+=("$v=${!v}"); done
case ${TMUX-} in "$sock",*) box_env+=("TMUX=$TMUX" "TMUX_PANE=${TMUX_PANE-}") ;; esac
case " $* " in
  *" new-session "*|*" new "*|*" start-server "*|*" start "*)
    if ! env -i "${box_env[@]}" "$real" -S "$sock" list-sessions >/dev/null 2>&1; then
      chmod u+w "${sock%/*}"
      env -i "${box_env[@]}" "$real" -S "$sock" start-server \; set-option -g exit-empty off
      chmod u-w "${sock%/*}"
    fi ;;
esac
exec env -i "${box_env[@]}" "$real" -S "$sock" "$@"
BODY
  } >"$wrapper"
  chmod 0755 "$wrapper"
}

# Every tmux server under the stack at <root> whose environment is not a
# box's, one line each; nothing when all is well. A box's server has
# TERMAG_E2E_ROOT=<root> and a HOME under <root>, globally and in each session
# (new-session -e can set either); anything else, a server started outside a
# box's bin/tmux above all, runs its panes' hooks with someone else's HOME.
e2e_tmux_isolation() {
  local root=$1 sock global sess val
  # Any socket under the root is asked, not only the boxes': a stray server is
  # the point. A socket that does not answer as tmux does within 3s is skipped,
  # on a bound of bash's own (macOS has no GNU timeout). tmux hands its stdin
  # and stdout to whatever it connects to, and a socket that isn't tmux's can
  # keep them (tsx watch's IPC socket did): so it gets /dev/null and a file,
  # never these loops' pipes, which would then never see EOF.
  tmux3() {
    local out pid rc i=0
    out=$(mktemp) || return 1
    tmux "$@" </dev/null >"$out" 2>/dev/null &
    pid=$!
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; rm -f "$out"; return 1
    fi
    wait "$pid"; rc=$?
    cat "$out"; rm -f "$out"
    return "$rc"
  }
  while IFS= read -r sock; do
    global=$(tmux3 -S "$sock" show-environment -g 2>/dev/null) || continue
    val=$(printf '%s\n' "$global" | sed -n 's/^HOME=//p')
    case $val in "$root"/*) ;; *) echo "${sock#"$root"/}: HOME=${val:-(unset)}, not a box's home" ;; esac
    printf '%s\n' "$global" | grep -qxF "TERMAG_E2E_ROOT=$root" \
      || echo "${sock#"$root"/}: no TERMAG_E2E_ROOT=$root in its environment"
    while IFS= read -r sess; do
      val=$(tmux3 -S "$sock" show-environment -t "=$sess" HOME 2>/dev/null) || continue
      case $val in HOME="$root"/*|-HOME) ;; *) echo "${sock#"$root"/}: session $sess has $val" ;; esac
    done < <(tmux3 -S "$sock" list-sessions -F '#{session_name}' 2>/dev/null)
  # tsx watch's IPC sockets (the backend's, under <root>/tmp) are never tmux's.
  done < <(find "$root" \( -path "$root/pg" -o -path "$root/tmp/tsx-*" \) -prune -o -type s -print 2>/dev/null)
}

# The tools a stand-in box takes from your PATH, linked by name into <dir>
# (<root>/bin). A box's PATH is its own bin/, then <dir>, then the system
# directories (box_path below), never your PATH: ~/.local/bin, nvm's bin,
# /usr/local/bin and Homebrew hold your agent CLIs (claude, codex, …), your
# termag and termag-status, which would run in the box's panes. Only what the
# box's agent, panes, units and fakes call is listed; a tool you have nowhere
# is skipped. E2E_CLAUDE_BIN and the fakes are linked into the box's own bin/.
E2E_BOX_TOOLS="node npm npx git jq curl tmux perl setsid ssh ssh-keygen timeout gtimeout flock python3 openssl gh"
link_box_tools() {
  local dir=$1 t p
  mkdir -p "$dir"
  for t in $E2E_BOX_TOOLS; do
    p=$(command -v "$t" 2>/dev/null) || continue
    case $p in /*) ln -sfn "$p" "$dir/$t" ;; esac
  done
}

# A stand-in box's PATH: <box>/bin, the stack's linked tools, the system dirs.
box_path() { printf '%s/bin:%s/bin:/usr/bin:/bin:/usr/sbin:/sbin' "$1" "$2"; }
