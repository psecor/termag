# shellcheck shell=bash
# Shared by up.sh, down.sh and status.sh. Sourced, not executed.
#
# A running stack lives entirely under one `mktemp -d` root. The pointer file
# is how down/status find it; the root's marker is how they know it is ours.

E2E_POINTER="${TMPDIR:-/tmp}/termag-e2e-$(id -un).root"

log() { printf '[e2e] %s\n' "$*"; }
die() { printf '[e2e] error: %s\n' "$*" >&2; exit 1; }

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
