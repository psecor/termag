#!/bin/sh
# Tests deploy/termag-hook-run.
#
# Scope is the contract the warm-pool backend depends on, all of which is
# observable from outside the script:
#
#   * ~/.termag/on-warm.status.json is valid JSON in every outcome. The backend
#     reaches it through the agent, which parses it; a quoting bug in the log
#     tail is therefore a silent "this box never warms", not a visible error.
#   * a failing script stops the run, is named in the status file with its exit
#     code, and the runner exits non-zero
#   * a timeout is distinguishable from an ordinary failure, because the two
#     need different operator responses
#   * scripts run in filename order, and an unexecutable one is skipped
#   * the environment the scripts are promised (TERMAG_IS_WARM) is the
#     environment they get
#
# Everything runs against a temp HOME and a temp checkout, so there is no AWS,
# no systemd user manager and no real ~/.termag involved.
#
# Run: sh deploy/termag-hook-run.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-hook-run"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

HOME_DIR="$WORK/home"
CHECKOUT="$WORK/checkout"
STUB="$WORK/stub"
SCRIPTS="$CHECKOUT/deploy/on-warm.d"
STATUS="$HOME_DIR/.termag/on-warm.status.json"
mkdir -p "$HOME_DIR" "$SCRIPTS" "$STUB"

# The runner has no reason to talk to the user manager, and on a developer's
# box the real systemctl is the live one. Recorded rather than merely shadowed,
# so "it never calls it" is an assertion instead of an assumption.
cat > "$STUB/systemctl" <<'STUBEOF'
#!/bin/sh
echo "$*" >> "$SYSTEMCTL_LOG"
exit 0
STUBEOF
chmod 755 "$STUB/systemctl"
SYSTEMCTL_LOG="$WORK/systemctl-calls"; export SYSTEMCTL_LOG
: > "$SYSTEMCTL_LOG"

run() {
  HOME="$HOME_DIR" TERMAG_CHECKOUT="$CHECKOUT" PATH="$STUB:$PATH" "$SCRIPT" "$@"
}

reset_scripts() {
  rm -rf "$SCRIPTS" "$HOME_DIR/.termag"
  mkdir -p "$SCRIPTS"
}

# $1 name, $2 mode, $3.. body lines
seed_script() {
  name=$1; mode=$2; shift 2
  printf '#!/bin/sh\n%s\n' "$*" > "$SCRIPTS/$name"
  chmod "$mode" "$SCRIPTS/$name"
}

# $1 status file, $2 a python expression over the parsed document `d`.
jpy() {
  python3 - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
v = eval(sys.argv[2])
print('null' if v is None else v)
PY
}

want_json() {
  if ! python3 -m json.tool "$STATUS" > /dev/null 2>&1; then
    fail "$1" 'parseable JSON' "$(cat "$STATUS" 2>/dev/null)"
    return 1
  fi
  return 0
}

want_field() {
  got="$(jpy "$STATUS" "$2" 2>/dev/null)"
  [ "$got" = "$3" ] || fail "$1" "$3" "$got"
}

# ── the shipped scripts succeed ─────────────────────────────────────────────
# Against the real deploy/on-warm.d, not fixtures: these are what a pool box
# actually runs, so a test that substituted its own would not be testing the
# thing that ships.

reset_scripts
cp "$(dirname "$SCRIPT")"/on-warm.d/*.sh "$SCRIPTS/"
chmod 755 "$SCRIPTS"/*.sh
out="$(run warm 2>&1)"; got=$?
[ "$got" = 0 ] || fail 'the shipped scripts exit 0' 0 "$got: $out"
want_json 'a successful run leaves valid JSON'
want_field 'a successful run reports succeeded' 'd["state"]' succeeded
want_field 'a successful run names no script'   'd["script"]' null
want_field 'a successful run has no exit code'  'd["exitCode"]' null
want_field 'a successful run has no reason'     'd["reason"]' null
want_field 'the shipped script is recorded' 'd["durations"][0]["script"]' 00-ready.sh
want_field 'the shipped script exited 0'    'd["durations"][0]["exitCode"]' 0
case "$out" in
  *'warm run succeeded'*) : ;;
  *) fail 'a successful run says so on stdout' 'warm run succeeded' "$out" ;;
esac

# The log tail is what an operator and the UI see for a box that never warms,
# so it has to carry the scripts' own output, not just the runner's.
got="$(jpy "$STATUS" 'd["logTail"]')"
case "$got" in
  *'on-warm: nothing to prepare'*) : ;;
  *) fail 'the log tail carries the script output' 'on-warm: nothing to prepare' "$got" ;;
esac

# ── the checkout reaches the scripts ────────────────────────────────────────
# A script is told which checkout it came from, so it can use the files that
# shipped beside the hook rather than baked copies.
#
# TERMAG_CHECKOUT is deliberately *not* in the caller's environment for these
# two, or a script would inherit it whether the runner exported it or not, and
# both assertions would hold with the export removed. The runner falls back to
# $HOME/src/termag, so a checkout there is what selects it.
DEFAULT_CO="$HOME_DIR/src/termag"
mkdir -p "$DEFAULT_CO/deploy/on-warm.d"
run_default_checkout() {
  rm -rf "$HOME_DIR/.termag"
  HOME="$HOME_DIR" PATH="$STUB:$PATH" "$SCRIPT" warm
}

# shellcheck disable=SC2016
printf '#!/bin/sh\nprintf "%%s\\n" "${TERMAG_CHECKOUT:-unset}" > %s\n' \
  "$WORK/saw-checkout" > "$DEFAULT_CO/deploy/on-warm.d/10-checkout.sh"
chmod 755 "$DEFAULT_CO/deploy/on-warm.d/10-checkout.sh"
rm -f "$WORK/saw-checkout"
run_default_checkout > /dev/null 2>&1
got="$(cat "$WORK/saw-checkout" 2>/dev/null)"
[ "$got" = "$DEFAULT_CO" ] || fail 'a script is told which checkout it came from' "$DEFAULT_CO" "$got"

rm -rf "$DEFAULT_CO" "$HOME_DIR/.termag"

# ── the promised environment reaches the script ─────────────────────────────

reset_scripts
# The expansion has to reach the generated script unexpanded, so the single
# quotes are the point.
# shellcheck disable=SC2016
seed_script 10-env.sh 755 'printf "%s\n" "${TERMAG_IS_WARM:-unset}" > '"$WORK/saw-warm"
run warm > /dev/null 2>&1
got="$(cat "$WORK/saw-warm" 2>/dev/null)"
[ "$got" = 1 ] || fail 'a script is given TERMAG_IS_WARM=1' 1 "$got"

# ── a failure stops the run ─────────────────────────────────────────────────

reset_scripts
# A test suite is not a warm step. deploy/ keeps its tests beside what they
# test, so a *.test.sh landing in on-warm.d is a mistake waiting to happen:
# the runner would execute it on a pool box, and one failing assertion would
# fail the run and burn the box.
reset_scripts
seed_script 10-real.sh 755 'printf ran > '"$WORK/saw-real"
seed_script 20-pretend.test.sh 755 'printf ran > '"$WORK/saw-test-suite"
rm -f "$WORK/saw-real" "$WORK/saw-test-suite"
run warm > /dev/null 2>&1; got=$?
[ "$got" = 0 ] || fail 'a run alongside a .test.sh succeeds' 0 "$got"
[ -f "$WORK/saw-real" ] || fail 'the real script still runs' 'ran' '(did not run)'
[ -e "$WORK/saw-test-suite" ] \
  && fail 'the runner does not execute a .test.sh' '(not run)' 'ran it'
got="$(jpy "$STATUS" 'len(d["durations"])')"
[ "$got" = 1 ] || fail 'a skipped .test.sh is not recorded as a step' 1 "$got"

reset_scripts
seed_script 10-fails.sh 755 'echo boom; exit 7'
seed_script 20-later.sh 755 "touch $WORK/later-ran"
rm -f "$WORK/later-ran"
run warm > /dev/null 2>&1; got=$?
[ "$got" != 0 ] || fail 'a failing script fails the run' 'non-zero' "$got"
want_json 'a failed run leaves valid JSON'
want_field 'a failed run reports failed'        'd["state"]' failed
want_field 'a failed run names the script'      'd["script"]' 10-fails.sh
want_field 'a failed run carries the exit code' 'd["exitCode"]' 7
want_field 'a failed run says why'              'd["reason"]' script-failed
[ -e "$WORK/later-ran" ] && fail 'a later script does not run after a failure' 'not run' 'ran'
want_field 'only the scripts that ran are recorded' 'len(d["durations"])' 1
want_field 'the failing script is recorded too' 'd["durations"][0]["exitCode"]' 7

# ── a timeout is its own reason ─────────────────────────────────────────────
# 124 is timeout(1)'s "I had to kill it". Distinguishing it matters because a
# timed-out box is usually a slow network, and a failed one is usually a bug.

reset_scripts
seed_script 10-hangs.sh 755 'sleep 30'
TERMAG_HOOK_TIMEOUT=1s run warm > /dev/null 2>&1; got=$?
[ "$got" != 0 ] || fail 'a hung script fails the run' 'non-zero' "$got"
want_json 'a timed-out run leaves valid JSON'
want_field 'a timeout is reported as a timeout' 'd["reason"]' timeout
want_field 'a timeout carries exit code 124'    'd["exitCode"]' 124
want_field 'a timeout names the script'         'd["script"]' 10-hangs.sh

# ── filename order, not directory order ─────────────────────────────────────

reset_scripts
ORDER="$WORK/order"
rm -f "$ORDER"
for n in 20-c 05-a 10-b; do
  seed_script "$n.sh" 755 "echo $n >> $ORDER"
done
run warm > /dev/null 2>&1
got="$(tr '\n' ' ' < "$ORDER" | sed 's/ $//')"
[ "$got" = '05-a 10-b 20-c' ] || fail 'scripts run in filename order' '05-a 10-b 20-c' "$got"
got="$(jpy "$STATUS" '" ".join(e["script"] for e in d["durations"])')"
[ "$got" = '05-a.sh 10-b.sh 20-c.sh' ] \
  || fail 'durations are recorded in run order' '05-a.sh 10-b.sh 20-c.sh' "$got"

# ── an unexecutable file is skipped ─────────────────────────────────────────
# Clearing the bit is how a script gets parked without deleting it, so this is
# a supported state and not an error.

reset_scripts
seed_script 10-parked.sh 644 "touch $WORK/parked-ran"
seed_script 20-runs.sh   755 'true'
rm -f "$WORK/parked-ran"
run warm > /dev/null 2>&1; got=$?
[ "$got" = 0 ] || fail 'an unexecutable file does not fail the run' 0 "$got"
[ -e "$WORK/parked-ran" ] && fail 'an unexecutable file is not run' 'skipped' 'ran'
want_field 'only the executable script is recorded' 'd["durations"][0]["script"]' 20-runs.sh
want_field 'the skipped file is not recorded' 'len(d["durations"])' 1

# ── an empty directory is a success, a missing one is not ───────────────────
# A checkout with no on-warm scripts has nothing to do. A checkout with no
# script directory at all is a broken box, and marking it warm would hand it
# to somebody.

reset_scripts
run warm > /dev/null 2>&1; got=$?
[ "$got" = 0 ] || fail 'an empty script directory succeeds' 0 "$got"
want_field 'an empty script directory reports succeeded' 'd["state"]' succeeded
want_field 'an empty script directory records nothing' 'len(d["durations"])' 0

rm -rf "$SCRIPTS" "$HOME_DIR/.termag"
run warm > /dev/null 2>&1; got=$?
[ "$got" != 0 ] || fail 'a missing script directory fails the run' 'non-zero' "$got"
want_json 'a missing script directory leaves valid JSON'
want_field 'a missing script directory says why' 'd["reason"]' missing-scripts
want_field 'a missing script directory is a failure' 'd["state"]' failed
mkdir -p "$SCRIPTS"

# ── hostile script output still yields valid JSON ───────────────────────────
# The log tail is arbitrary script output embedded in a JSON string, written
# without jq because a box may not have it. Quotes, backslashes, newlines,
# tabs and terminal escapes all reach it.

reset_scripts
seed_script 10-hostile.sh 755 \
  'printf "a\"b\\\\c\td\ne\033[31mf\007g\n"; printf "trailing \" quote\n"; exit 3'
run warm > /dev/null 2>&1
want_json 'hostile script output still leaves valid JSON'
got="$(jpy "$STATUS" 'd["logTail"]' | tr -d '\n')"
case "$got" in
  *'a"b\c'*) : ;;
  *) fail 'the log tail round-trips quotes and backslashes' 'a"b\c' "$got" ;;
esac
want_field 'a hostile script still reports its exit code' 'd["exitCode"]' 3

# A script name is interpolated into the JSON too, so it needs the same care.
reset_scripts
seed_script 'we"ird.sh' 755 'exit 4'
run warm > /dev/null 2>&1
want_json 'a quote in a script name still leaves valid JSON'
want_field 'a quoted script name round-trips' 'd["script"]' 'we"ird.sh'

# ── what a poller sees mid-run, and when the runner is killed ───────────────
# The agent reads this file every 2 s while a script is in flight, so "running"
# has to name the script that is actually running. Killing the runner is not
# hypothetical: termag-on-warm.service gives up at 45 min and SIGTERMs it, and
# a box that went quiet without a reason would sit in the backend's stuck sweep
# until that window expired.

reset_scripts
# Ticks rather than sleeps, so "did the script actually stop" is a question
# the test can answer. timeout(1) runs it in a process group of its own, so
# nothing about killing the runner reaches it unless the runner passes the
# signal on.
TICKS="$WORK/ticks"
rm -f "$TICKS"
seed_script 10-slow.sh 755 'while :; do echo tick >> '"$TICKS"'; sleep 0.2; done'

PIDFILE="$WORK/runner.pid"
cat > "$WORK/bg-run" <<BGEOF
#!/bin/sh
echo \$\$ > "$PIDFILE"
exec env HOME="$HOME_DIR" TERMAG_CHECKOUT="$CHECKOUT" PATH="$STUB:\$PATH" \\
  "$SCRIPT" warm
BGEOF
chmod 755 "$WORK/bg-run"
rm -f "$PIDFILE"
setsid "$WORK/bg-run" > /dev/null 2>&1 &

waited=0
while [ "$waited" -lt 100 ]; do
  [ -f "$STATUS" ] && [ "$(jpy "$STATUS" 'd["script"]' 2>/dev/null)" = 10-slow.sh ] && break
  sleep 0.1
  waited=$((waited + 1))
done

want_json 'a run in flight leaves valid JSON'
want_field 'a run in flight reports running'      'd["state"]' running
want_field 'a run in flight names the script'     'd["script"]' 10-slow.sh
want_field 'a run in flight has no exit code yet' 'd["exitCode"]' null
want_field 'a run in flight has no reason'        'd["reason"]' null

pgid="$(cat "$PIDFILE" 2>/dev/null)"
kill -TERM "-$pgid" 2>/dev/null
waited=0
while kill -0 "$pgid" 2>/dev/null && [ "$waited" -lt 100 ]; do
  sleep 0.1
  waited=$((waited + 1))
done
kill -0 "$pgid" 2>/dev/null && fail 'a SIGTERM ends the run' 'exited' 'still running'

want_json 'a killed runner leaves valid JSON'
want_field 'a killed runner does not stay running' 'd["state"]' failed
want_field 'a killed runner says why'              'd["reason"]' runner-error

# The script must go down with the runner. An orphan left holding the box's
# docker socket or a half-written clone is the thing a warm-pool replacement
# would then have to work around.
before="$(wc -c < "$TICKS")"
sleep 1
after="$(wc -c < "$TICKS")"
[ "$before" = "$after" ] || fail 'the script dies with the runner' "$before bytes" "$after bytes"

# ── the status file is replaced, never appended or left half-written ────────
# The agent polls this file every 2 s while the runner is writing it, so each
# write is a temp file plus a rename. A leftover temp file means that broke.

reset_scripts
seed_script 10-ok.sh 755 'true'
run warm > /dev/null 2>&1
got="$(find "$HOME_DIR/.termag" -name '*.tmp.*' | wc -l | tr -d ' ')"
[ "$got" = 0 ] || fail 'no temp status file is left behind' 0 "$got"

# ── the state directory is not world-readable ───────────────────────────────
# The on-claim credential lands here next.

got="$(stat -c %a "$HOME_DIR/.termag" 2>/dev/null)"
[ "$got" = 700 ] || fail 'the state directory is 700' 700 "$got"

chmod 755 "$HOME_DIR/.termag"
run warm > /dev/null 2>&1
got="$(stat -c %a "$HOME_DIR/.termag" 2>/dev/null)"
[ "$got" = 700 ] || fail 'a loose state directory is tightened' 700 "$got"

# ── mode handling ───────────────────────────────────────────────────────────

run > /dev/null 2>&1
got=$?
[ "$got" = 2 ] || fail 'no mode exits 2' 2 "$got"

run claim > /dev/null 2>&1
got=$?
[ "$got" = 0 ] || fail 'claim with no repository skips' 0 "$got"

run not-a-mode > /dev/null 2>&1
got=$?
[ "$got" = 2 ] || fail 'an unknown mode exits 2' 2 "$got"

# A rejected mode must not leave a status file behind for the agent to forward
# as if a run had happened.
rm -rf "$HOME_DIR/.termag"
run not-a-mode > /dev/null 2>&1
[ -e "$HOME_DIR/.termag/on-warm.status.json" ] \
  && fail 'a rejected mode writes no status file' '(no file)' 'wrote one'

out="$(run --help 2>&1)"; got=$?
[ "$got" = 0 ] || fail '--help exits 0' 0 "$got"
case "$out" in
  *'termag-hook-run warm'*) : ;;
  *) fail '--help documents the mode' 'termag-hook-run warm' "$out" ;;
esac

# ── on-claim dotfiles, with no GitHub token ─────────────────────────────────

CLAIM_STATUS="$HOME_DIR/.termag/on-claim.status.json"
DOTFILES_SOURCE="$WORK/dotfiles-source"
WORK_GIT_LOG="$WORK/claim-git-log"
WORK_GIT_FAIL="$WORK/claim-git-fail"
export DOTFILES_SOURCE WORK_GIT_LOG WORK_GIT_FAIL
mkdir -p "$DOTFILES_SOURCE"
cat > "$STUB/git" <<'STUBEOF'
#!/bin/sh
printf '%s cfg=%s\n' "$*" "${GIT_CONFIG_GLOBAL:-unset}" >> "$WORK_GIT_LOG"
case "$1" in
  clone)
    [ ! -e "$WORK_GIT_FAIL" ] || exit 9
    dest=
    for arg in "$@"; do dest=$arg; done
    mkdir -p "$dest"
    cp -R "$DOTFILES_SOURCE/." "$dest/"
    mkdir -p "$dest/.git"
    printf 'ref: refs/heads/main\n' > "$dest/.git/HEAD"
    cat "$DOTFILES_SOURCE/.stub-sha" > "$dest/.git/STUB_SHA" 2>/dev/null || printf 'sha-1\n' > "$dest/.git/STUB_SHA"
    ;;
  -C)
    dir=$2
    shift 2
    case "${1:-} ${2:-}" in
      'rev-parse --verify')
        [ -f "$dir/.git/HEAD" ] || exit 128
        cat "$dir/.git/STUB_SHA" 2>/dev/null || true
        ;;
      *)
        [ -d "$dir/.git" ] || exit 128
        ;;
    esac
    ;;
esac
STUBEOF
chmod 755 "$STUB/git"
cat > "$STUB/pnpm" <<'STUBEOF'
#!/bin/sh
echo pnpm > "$WORK/pnpm-invoked"
exit 1
STUBEOF
chmod 755 "$STUB/pnpm"

reset_claim() {
  rm -rf "$DOTFILES_SOURCE" "$HOME_DIR/.dotfiles" "$HOME_DIR/.termag" "$HOME_DIR/.vimrc" "$HOME_DIR/.config" "$WORK/claim-runs"
  mkdir -p "$DOTFILES_SOURCE" "$HOME_DIR/.termag"
  cat > "$HOME_DIR/.termag/on-claim.env" <<'ENVEOF'
TERMAG_DOTFILES_REPO_URL='https://github.com/ada/dotfiles'
TERMAG_OWNER_NAME='Ada Lovelace'
TERMAG_OWNER_EMAIL='ada@example.com'
ENVEOF
  chmod 600 "$HOME_DIR/.termag/on-claim.env"
  rm -f "$WORK_GIT_LOG" "$WORK_GIT_FAIL" "$WORK/pnpm-invoked" "$WORK/claim-ran" "$WORK/claim-env"
  : > "$WORK_GIT_LOG"
}

reset_claim
cat > "$DOTFILES_SOURCE/install.sh" <<ENTRYEOF
#!/bin/sh
printf '%s\n' "\${TERMAG_GITHUB_TOKEN:-unset}" > "$WORK/claim-env"
printf ran > "$WORK/claim-ran"
printf 'run\n' >> "$WORK/claim-runs"
ENTRYEOF
chmod 755 "$DOTFILES_SOURCE/install.sh"
TERMAG_GITHUB_TOKEN=github_pat_nope run claim > /dev/null 2>&1; got=$?
[ "$got" = 0 ] || fail 'a public dotfiles clone succeeds' 0 "$got"
got="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["state"])' "$CLAIM_STATUS")"
[ "$got" = succeeded ] || fail 'a public clone reports succeeded' succeeded "$got"
[ "$(cat "$WORK/claim-env")" = unset ] || fail 'the entrypoint inherits no GitHub token' unset "$(cat "$WORK/claim-env" 2>/dev/null)"
[ -e "$WORK/pnpm-invoked" ] && fail 'claim does not run pnpm' '(no pnpm)' 'pnpm ran'
[ -e "$HOME_DIR/.termag/on-claim-askpass" ] && fail 'claim writes no askpass helper' '(no file)' 'present'
got="$(grep -c '^clone ' "$WORK_GIT_LOG")"
[ "$got" = 1 ] || fail 'a public repo is cloned once' 1 "$(cat "$WORK_GIT_LOG")"
case "$(cat "$WORK_GIT_LOG")" in
  *'cfg=/dev/null'*) : ;;
  *) fail 'a claim-time clone neutralises gitconfig' 'cfg=/dev/null' "$(cat "$WORK_GIT_LOG")" ;;
esac
[ "$(cat "$HOME_DIR/.termag/dotfiles-repo-url")" = 'https://github.com/ada/dotfiles' ] \
  || fail 'the repo URL is persisted' 'https://github.com/ada/dotfiles' "$(cat "$HOME_DIR/.termag/dotfiles-repo-url" 2>/dev/null)"

# A finished checkout is not cloned again.
: > "$WORK_GIT_LOG"
run claim > /dev/null 2>&1; got=$?
[ "$got" = 0 ] || fail 'a finished clone is left alone' 0 "$got"
got="$(grep -c '^clone ' "$WORK_GIT_LOG")"
[ "$got" = 0 ] || fail 'a finished clone is not fetched again' 0 "$(cat "$WORK_GIT_LOG")"
# The owner reruns claim after GitHub login: an applied checkout's
# entrypoint does not run again, and the claim still reads succeeded.
got="$(wc -l < "$WORK/claim-runs" | tr -d ' ')"
[ "$got" = 1 ] || fail 'an applied checkout does not rerun its entrypoint' 1 "$got"
got="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["state"])' "$CLAIM_STATUS")"
[ "$got" = succeeded ] || fail 'a rerun over an applied checkout still reports succeeded' succeeded "$got"
# A new commit in the checkout is applied again.
printf 'sha-2\n' > "$HOME_DIR/.dotfiles/.git/STUB_SHA"
run claim > /dev/null 2>&1
got="$(wc -l < "$WORK/claim-runs" | tr -d ' ')"
[ "$got" = 2 ] || fail 'a checkout at a new commit runs its entrypoint again' 2 "$got"

# No entrypoint: top-level dotfiles are linked, but an existing real file or
# directory (a pool home has .config) is kept rather than failing the claim.
reset_claim
mkdir -p "$DOTFILES_SOURCE/.config/app" "$HOME_DIR/.config"
printf 'x\n' > "$DOTFILES_SOURCE/.vimrc"
printf 'mine\n' > "$HOME_DIR/.config/keep"
run claim > /dev/null 2>&1; got=$?
[ "$got" = 0 ] || fail 'the symlink fallback succeeds over an existing directory' 0 "$got"
got="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["state"])' "$CLAIM_STATUS")"
[ "$got" = succeeded ] || fail 'the symlink fallback reports succeeded' succeeded "$got"
[ -L "$HOME_DIR/.vimrc" ] || fail 'a new top-level dotfile is linked' '(symlink)' "$(ls -la "$HOME_DIR/.vimrc" 2>&1)"
[ ! -L "$HOME_DIR/.config" ] && [ -f "$HOME_DIR/.config/keep" ] \
  || fail 'an existing directory is kept, not replaced' '(real dir with keep)' "$(ls -la "$HOME_DIR/.config" 2>&1)"
# ln -sfn onto a real directory links inside it (or fails when that name is a
# directory there too); neither is applying a dotfile.
[ ! -e "$HOME_DIR/.config/.config" ] && [ ! -L "$HOME_DIR/.config/.config" ] \
  || fail 'nothing is linked inside an existing directory' '(no ~/.config/.config)' "$(ls -la "$HOME_DIR/.config" 2>&1)"

# Leftover .git without HEAD is fetched again.
reset_claim
printf 'true\n' > "$DOTFILES_SOURCE/install.sh"
mkdir -p "$HOME_DIR/.dotfiles/.git"
run claim > /dev/null 2>&1; got=$?
[ "$got" = 0 ] || fail 'an unfinished leftover clone is recovered' 0 "$got"
got="$(grep -c '^clone ' "$WORK_GIT_LOG")"
[ "$got" = 1 ] || fail 'an unfinished leftover clone is fetched again' 1 "$(cat "$WORK_GIT_LOG")"
[ -f "$HOME_DIR/.dotfiles/.git/HEAD" ] || fail 'the recovered clone records HEAD' '(HEAD)' '(missing)'

# Missing or private: skip, keep the URL, exit 0.
reset_claim
touch "$WORK_GIT_FAIL"
run claim > /dev/null 2>&1; got=$?
[ "$got" = 0 ] || fail 'an auth failure does not fail the claim run' 0 "$got"
got="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d["state"], d["reason"])' "$CLAIM_STATUS")"
[ "$got" = 'skipped needs-auth' ] || fail 'an auth failure is skipped' 'skipped needs-auth' "$got"
[ "$(cat "$HOME_DIR/.termag/dotfiles-repo-url")" = 'https://github.com/ada/dotfiles' ] \
  || fail 'an auth failure keeps the URL' 'url file' "$(cat "$HOME_DIR/.termag/dotfiles-repo-url" 2>/dev/null)"

# Owner git, after gh auth, does not neutralise gitconfig.
reset_claim
rm -f "$HOME_DIR/.termag/on-claim.env"
printf 'https://github.com/ada/dotfiles\n' > "$HOME_DIR/.termag/dotfiles-repo-url"
printf 'true\n' > "$DOTFILES_SOURCE/install.sh"
TERMAG_DOTFILES_USE_OWNER_GIT=1 run claim > /dev/null 2>&1; got=$?
[ "$got" = 0 ] || fail 'owner-git claim succeeds' 0 "$got"
case "$(cat "$WORK_GIT_LOG")" in
  *'cfg=unset'*) : ;;
  *) fail 'owner-git clone keeps the owner gitconfig' 'cfg=unset' "$(cat "$WORK_GIT_LOG")" ;;
esac

# ── the runner never touches the user manager ───────────────────────────────
# It is started by one; starting or stopping units from inside it would be a
# loop waiting to happen.

got="$(wc -l < "$SYSTEMCTL_LOG" | tr -d ' ')"
[ "$got" = 0 ] || fail 'the runner calls no systemctl' 0 "$(cat "$SYSTEMCTL_LOG")"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: status shape, stop-at-first-failure, timeout reason, ordering, skipping, JSON escaping'
  exit 0
fi
echo "$failures failure(s)"
exit 1
