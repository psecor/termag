#!/usr/bin/env bash
# claude-floor.sh's checks of the runner orchestrator's unit (unit_binary,
# unit_wait_current, unit_report), against real processes with systemctl
# stubbed. The script itself runs as root against /etc/systemd and
# /usr/bin/claude, so this loads just those functions from it, by name.
# CI runs it as `sh <file>`; the functions need bash.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -u

here=$(cd "$(dirname "$0")" && pwd)
script=$here/claude-floor.sh
work=$(mktemp -d)
pids=()
cleanup() {
  local p
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
  rm -rf "$work"
}
trap cleanup EXIT

pass=0 fail=0
ok() { pass=$((pass + 1)); echo "ok    $1"; }
no() { fail=$((fail + 1)); echo "FAIL  $1"; }
is() { if [ "$2" = "$3" ]; then ok "$1: $2"; else no "$1: got '$2', want '$3'"; fi; }
# shellcheck disable=SC2254  # $3 is a glob on purpose
like() { case "$2" in $3) ok "$1: $2" ;; *) no "$1: got '$2', want $3" ;; esac; }

# A top-level `name() {` ... `}` block from the script, defined here.
load() {
  local body
  body=$(awk -v n="$1" '$0 == n "() {" { on = 1 } on { print } on && /^}$/ { exit }' "$script")
  [ -n "$body" ] || { echo "FAIL  no top-level $1() in $script"; exit 1; }
  eval "$body"
}
for f in ustate unit_binary unit_wait_current unit_report; do load "$f"; done

# systemctl, answering only what the functions ask.
MAINPID=0 ACTIVE=inactive SUB=dead
systemctl() {
  case "$*" in
    "show -p MainPID --value "*) echo "$MAINPID" ;;
    "show -p ActiveState --value "*) echo "$ACTIVE" ;;
    "show -p SubState --value "*) echo "$SUB" ;;
    *) echo "unexpected: systemctl $*" >&2; return 1 ;;
  esac
}
start() { "$@" & MAINPID=$!; pids+=("$MAINPID"); ACTIVE=active SUB=running; }

# ounit, unit_wait_tries and ob are read by the functions load() defined.
# shellcheck disable=SC2034  # read by the eval'd functions
ounit=claude-runner-orchestrator.service
# shellcheck disable=SC2034  # read by the eval'd functions
unit_wait_tries=6   # 3 s here; 15 s in the script
sleep_bin=$(command -v sleep)
mkdir -p "$work/lib" "$work/bin"
cp "$sleep_bin" "$work/lib/claude.exe"       # the binary /usr/bin/claude is now
cp "$sleep_bin" "$work/lib/old-claude.exe"   # another one
ln -s "$work/lib/claude.exe" "$work/bin/claude"
# shellcheck disable=SC2034  # read by the eval'd functions
ob=$work/bin/claude

# The unit wasn't running, and nothing restarted it: -, which doesn't fail.
is "not running, no restart" "$(unit_report report-only)" "-"

start "$work/lib/claude.exe" 300
is "running the current binary" "$(unit_binary)" current
is "  and its report after a restart" "$(unit_report installed,restarted)" current

start "$work/lib/old-claude.exe" 300
is "running another binary" "$(unit_binary)" "STALE($work/lib/old-claude.exe)"

# npm replaced the file under a running process.
start "$work/lib/claude.exe" 300
cp "$work/lib/claude.exe" "$work/lib/claude.exe.new"
mv -f "$work/lib/claude.exe.new" "$work/lib/claude.exe"
is "running a replaced file" "$(unit_binary)" "STALE($work/lib/claude.exe,deleted)"

# The race: after a restart the main process is systemd's fork for a moment,
# then it execs claude. Here a shell execs it after 1 s.
start bash -c "sleep 1; exec '$work/lib/claude.exe' 300"
like "forked, not exec'd yet" "$(unit_binary)" "STALE(*bash)"
if unit_wait_current; then ok "the wait sees the exec"; else no "the wait timed out on a delayed exec"; fi
is "  then it's current" "$(unit_report installed,restarted)" current

# A process that never runs the new binary: the wait gives up, still STALE.
start "$work/lib/old-claude.exe" 300
t0=$SECONDS
if unit_wait_current; then no "the wait passed a stale binary"; else ok "the wait gives up on a stale binary"; fi
waited=$((SECONDS - t0))
like "  after the bounded wait (${waited}s)" "$waited" "[2-5]"
like "  and reports it" "$(unit_report installed,restarted)" "STALE($work/lib/old-claude.exe)"

# A restart that left no process (the new one exited; systemd is between
# restarts): DOWN, which fails the run, not -.
MAINPID=0 ACTIVE=activating SUB=auto-restart
if unit_wait_current; then no "the wait passed a unit with no process"; else ok "the wait gives up with no process"; fi
is "restarted, then no process" "$(unit_report installed,restarted)" "DOWN(activating/auto-restart)"
is "restarted, failed for good" "$(ACTIVE=failed SUB=failed; unit_report current,restarted)" "DOWN(failed/failed)"
is "no process, no restart" "$(unit_report report-only)" "-"

# The final check fails the run on STALE and DOWN (claude-floor.sh).
grep -q 'case "$unit_bin" in STALE\*|DOWN\*) rc=1' "$script" \
  && ok "STALE and DOWN set rc=1 in the script" || no "the script no longer fails the run on STALE and DOWN"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
