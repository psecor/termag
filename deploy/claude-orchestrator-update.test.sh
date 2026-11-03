#!/usr/bin/env bash
# Tests for deploy/claude-orchestrator-update (the orchestrator host's boot
# floor and requested runs), its start helper, its sudoers rule and its units.
# npm, claude and
# systemctl are stubs, /proc is a fake one, and nothing runs as root: the
# script's paths all move under a scratch directory through its TERMAG_CO_*
# variables.
#
# Covers:
#   * boot, below the floor: exactly the floor, the platform package named
#     too, verified; the record says updated
#   * boot, at the floor: npm is never asked to install; current
#   * boot, no claude at all: the floor is installed
#   * a failed install that changed nothing: not a rejection, still below
#   * a wrong install: rejected, the previous version put back and verified
#   * a wrong install that cannot be put back: the binary is quarantined
#   * a rejected record makes the next run reinstall, and a verified one clears it
#   * the time bound: a hung npm is stopped inside the budget
#   * the lock: a run that cannot get it installs nothing and records why
#   * --run: the request's target (a dist-tag resolved once), the runner
#     orchestrator try-restarted onto the new binary and waited for; STALE and
#     DOWN fail the run; a stopped runner stays stopped
#   * --run: no request, a bad request, a target below the floor, a request
#     floor below root's floor, no downgrade
#   * host users' sessions on an old binary are counted by user, not stopped
#   * bad run ids are refused by the recipe and the start helper; the helper
#     starts exactly one unit for a good one
#   * the sudoers file parses (visudo -cf, where there is one) and is one line
#   * the units: the boot unit is before the runner, not After=cloud-final,
#     not WantedBy anything, and its timeout covers the run's budget
# CI runs it as `sh <file>`.
[ -n "${BASH_VERSION:-}" ] || exec bash "$0" "$@"
set -u

DIR=$(cd "$(dirname "$0")" && pwd)
SCRIPT=$DIR/claude-orchestrator-update
W=$(mktemp -d)
trap 'rm -rf "$W"' EXIT

pass=0 failed=0
ok() { pass=$((pass + 1)); echo "ok    $1"; }
no() { failed=$((failed + 1)); echo "FAIL  $1"; }
is() { if [ "$2" = "$3" ]; then ok "$1: $2"; else no "$1: got '$2', want '$3'"; fi; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) no "$1: '$3' not in: $2" ;; esac; }
hasnt() { case "$2" in *"$3"*) no "$1: '$3' should not be in: $2" ;; *) ok "$1" ;; esac; }

PKGDIR=@anthropic-ai/claude-code
ROOT=$W/usr/lib/node_modules
WRAP=$ROOT/$PKGDIR
PLAT=$ROOT/$PKGDIR-linux-arm64
BIN=$W/usr/bin/claude
STATE=$W/state
FLOOR_FILE=$W/claude-code-floor
STUBS=$W/stubs
SYS=$W/sys
FPROC=$W/proc
RID=cmvdemo0orch0run0000000001
mkdir -p "$STUBS" "$SYS" "$FPROC" "$W/usr/bin" "$W/old"

# ── stubs ─────────────────────────────────────────────────────────────────────
# npm: `root -g`, `view <pkg>@<tag> version` and `install -g ... <pkg>@<v>...`.
# NPM_MODE: ok, fail (changes nothing), wrong (the binary says 2.1.999),
# wrong-once (wrong, then ok), hang. Every call is logged.
cat >"$STUBS/npm" <<EOF
#!/usr/bin/env bash
echo "npm \$*" >>"$W/npm.log"
case "\$1" in
  root) echo "$ROOT"; exit 0 ;;
  view) [ -n "\${FAKE_VIEW_FAIL:-}" ] && { echo "npm ERR! network" >&2; exit 1; }; echo "\${FAKE_LATEST:-2.1.316}"; exit 0 ;;
  install) ;;
  *) exit 1 ;;
esac
mode=\${NPM_MODE:-ok}
if [ "\$mode" = ok-then-fail ]; then
  if [ -e "$W/ok-done" ]; then mode=fail; else : >"$W/ok-done"; mode=ok; fi
fi
if [ "\$mode" = wrong-once ]; then
  if [ -e "$W/wrong-done" ]; then mode=ok; else : >"$W/wrong-done"; mode=wrong; fi
fi
# The runner orchestrator goes down while npm replaces the binary, and its
# Restart=always start is skipped by the unit's condition.
if [ -n "\${FAKE_RUNNER_DIES:-}" ]; then echo 0 >"$SYS/mainpid"; echo inactive >"$SYS/active"; echo dead >"$SYS/sub"; echo no >"$SYS/condresult"; fi
# A displaced host drains while npm runs: systemctl stop, after a start whose conditions held.
if [ -n "\${FAKE_RUNNER_DRAINED:-}" ]; then echo 0 >"$SYS/mainpid"; echo inactive >"$SYS/active"; echo dead >"$SYS/sub"; fi
case "\$mode" in
  fail) exit 1 ;;
  hang) sleep 100; exit 1 ;;
esac
for a in "\$@"; do
  case "\$a" in
    $PKGDIR@*) v=\${a##*@}; say=\$v; [ "\$mode" = wrong ] && say=2.1.999
      mkdir -p "$WRAP/bin"
      printf '{\n  "name": "$PKGDIR",\n  "version": "%s"\n}\n' "\$v" >"$WRAP/package.json"
      printf '#!/bin/sh\necho "%s (Claude Code)"\n' "\$say" >"$WRAP/bin/claude.exe.new"
      chmod +x "$WRAP/bin/claude.exe.new"; mv -f "$WRAP/bin/claude.exe.new" "$WRAP/bin/claude.exe"
      ln -sfn "$WRAP/bin/claude.exe" "$BIN" ;;
    $PKGDIR-linux-arm64@*) v=\${a##*@}; mkdir -p "$PLAT"
      printf '{\n  "name": "$PKGDIR-linux-arm64",\n  "version": "%s"\n}\n' "\$v" >"$PLAT/package.json" ;;
  esac
done
exit 0
EOF
# systemctl: the runner orchestrator's MainPID and state come from $SYS;
# a restart applies $SYS/on_restart (current, stale, down).
cat >"$STUBS/systemctl" <<EOF
#!/usr/bin/env bash
echo "systemctl \$*" >>"$W/systemctl.log"
rd() { cat "$SYS/\$1" 2>/dev/null || echo "\$2"; }
case "\$*" in
  "show -p MainPID --value "*)
    # A runner that exits right after it starts: systemd restarts it, each
    # look sees a new process (on the current file) and one more restart.
    if [ -e "$SYS/flaky" ]; then
      n=\$(( \$(rd flakyn 4300) + 1 )); echo "\$n" >"$SYS/flakyn"; echo "\$(( \$(rd nrestarts 0) + 1 ))" >"$SYS/nrestarts"
      mkdir -p "$FPROC/\$n"; ln -sfn "\$(readlink -f "$BIN")" "$FPROC/\$n/exe"; echo "\$n"
    else rd mainpid 0; fi ;;
  "show -p NRestarts --value "*) rd nrestarts 0 ;;
  "show -p ActiveState --value "*) rd active inactive ;;
  "show -p SubState --value "*) rd sub dead ;;
  "show -p ConditionResult --value "*) rd condresult yes ;;
  "cat "*) [ -e "$SYS/has_unit" ] ;;
  "try-restart "*|"restart "*|"start --no-block "*)
    [ "\$1 \$2" = "start --no-block" ] && : >"$SYS/start_requested"
    # Whether the run still holds its lock while it restarts the runner (a floor run the restart starts would wait on it).
    if flock -n "$STATE/lock" true; then echo free >"$SYS/lock_at_restart"; else echo held >"$SYS/lock_at_restart"; fi
    case "\$1:\$(rd active inactive)" in try-restart:inactive|try-restart:failed) exit 0 ;; esac
    case "\$(rd on_restart current)" in
      flaky) : >"$SYS/flaky" ;;
      drained) echo 0 >"$SYS/mainpid"; echo inactive >"$SYS/active"; echo dead >"$SYS/sub" ;;
      flaky-then-ok) if [ -e "$SYS/flaked" ]; then rm -f "$SYS/flaky"; mkdir -p "$FPROC/4244"; ln -sfn "\$(readlink -f "$BIN")" "$FPROC/4244/exe"; echo 4244 >"$SYS/mainpid"; echo active >"$SYS/active"; echo running >"$SYS/sub"; else : >"$SYS/flaky"; : >"$SYS/flaked"; fi ;;
      current) mkdir -p "$FPROC/4242"; ln -sfn "\$(readlink -f "$BIN")" "$FPROC/4242/exe"; echo 4242 >"$SYS/mainpid"; echo active >"$SYS/active"; echo running >"$SYS/sub" ;;
      stale) mkdir -p "$FPROC/4243"; ln -sfn "$W/old/claude.exe" "$FPROC/4243/exe"; echo 4243 >"$SYS/mainpid" ;;
      down) echo 0 >"$SYS/mainpid"; echo activating >"$SYS/active"; echo auto-restart >"$SYS/sub" ;;
    esac ;;
  "stop "*) echo 0 >"$SYS/mainpid"; echo inactive >"$SYS/active"; echo dead >"$SYS/sub" ;;
  "is-enabled "*) if [ -e "$SYS/enabled" ]; then echo enabled; else echo disabled; exit 1; fi ;;
  *) echo "unexpected: systemctl \$*" >&2; exit 1 ;;
esac
EOF
chmod +x "$STUBS/npm" "$STUBS/systemctl"

# A host with claude at version $1 (none: no claude), the floor $2, no runner.
host() {
  rm -rf "${W:?}/usr" "$STATE" "$SYS" "$FPROC" "$W/old" "$W/npm.log" "$W/systemctl.log" "$W/wrong-done" "$W/ok-done"
  mkdir -p "$W/usr/bin" "$SYS" "$FPROC" "$W/old" "$ROOT"
  if [ "$1" != none ]; then NPM_MODE=ok "$STUBS/npm" install -g "$PKGDIR-linux-arm64@$1" "$PKGDIR@$1"; rm -f "$W/npm.log"; fi
  echo "$2" >"$FLOOR_FILE"
}
# The runner orchestrator running, on the binary installed now (an old copy of it once npm replaces it).
runner_on_current() {
  : >"$SYS/has_unit"; echo active >"$SYS/active"; echo running >"$SYS/sub"; echo 4000 >"$SYS/mainpid"
  ln -f "$(readlink -f "$BIN")" "$W/old/claude.exe"
  mkdir -p "$FPROC/4000"; ln -sfn "$W/old/claude.exe" "$FPROC/4000/exe"
}
run() {
  env TERMAG_CO_PATH_PREFIX="$STUBS:$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/node)")" TERMAG_CO_CLAUDE_BIN="$BIN" TERMAG_CO_FLOOR_FILE="$FLOOR_FILE" TERMAG_CO_STATE_DIR="$STATE" \
    TERMAG_CO_PLATFORM=aarch64 TERMAG_CO_PROC="$FPROC" TERMAG_CO_RETRY_SLEEP=0 TERMAG_CO_UNIT_WAIT_TRIES=4 TERMAG_CO_SETTLE=1 \
    TERMAG_CO_BOOT_ID=0123456789abcdef0123456789abcdef "$@" "$SCRIPT" ${ARGS:---boot} >"$W/out" 2>"$W/err"
  echo $?
}
rec() { jq -r "$1" "$STATE/runs/${REC:-boot0123456789abcdef0123456789abcdef}.json" 2>/dev/null; }
installs() { grep -c '^npm install' "$W/npm.log" 2>/dev/null || true; }
claude_v() { "$BIN" --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+'; }
plat_v() { sed -n 's/.*"version": "\(.*\)".*/\1/p' "$PLAT/package.json" 2>/dev/null; }
request() { mkdir -p "$STATE/requests"; printf '%s' "$1" >"$STATE/requests/$RID.json"; }

# ── boot ──────────────────────────────────────────────────────────────────────
host 2.1.292 2.1.308
is 'boot below the floor: exit' "$(run)" 0
is '  claude is the floor' "$(claude_v)" 2.1.308
is '  the platform package too' "$(plat_v)" 2.1.308
has '  npm named the platform package and the wrapper' "$(cat "$W/npm.log")" "npm install -g --no-fund --no-audit --loglevel=error $PKGDIR-linux-arm64@2.1.308 $PKGDIR@2.1.308"
is '  the record: updated' "$(rec .outcome)" updated
is '  the record: trigger boot, its id' "$(rec '.trigger + " " + .run')" "boot boot0123456789abcdef0123456789abcdef"
is '  the record: versions' "$(rec '.fromVersion + "->" + .toVersion')" "2.1.292->2.1.308"
is '  the record: the target' "$(rec .target)" 2.1.308
has '  the summary line' "$(cat "$W/err")" "outcome=updated claude=2.1.292->2.1.308 state=ok floor=2.1.308"
hasnt '  never npm view at boot' "$(cat "$W/npm.log")" "npm view"

host 2.1.308 2.1.308
is 'boot at the floor: exit' "$(run)" 0
is '  npm installs nothing' "$(installs)" 0
is '  the record: current' "$(rec .outcome)" current

host 2.1.316 2.1.308
is 'boot above the floor: exit' "$(run)" 0
is '  npm installs nothing (no downgrade to the floor)' "$(installs)" 0
is '  still 2.1.316' "$(claude_v)" 2.1.316

host none 2.1.308
is 'boot with no claude at all: exit' "$(run)" 0
is '  the floor is installed' "$(claude_v)" 2.1.308

host 2.1.292 2.1.308
is 'boot, npm fails and changes nothing: exit 1 (below the floor)' "$(run NPM_MODE=fail)" 1
is '  still the old version' "$(claude_v)" 2.1.292
is '  not a rejection' "$([ -e "$STATE/rejected" ] && echo yes || echo no)" no
is '  tried twice (one retry)' "$(installs)" 2
is '  the record: failed' "$(rec .outcome)" failed
has '  says npm failed' "$(rec .detail)" npm-FAILED

host 2.1.292 2.1.308
is 'boot, a wrong install: exit 3' "$(run NPM_MODE=wrong-once)" 3
is '  put back to the previous version, verified' "$(claude_v)" 2.1.292
is '  the platform package back too' "$(plat_v)" 2.1.292
has '  the rejection is recorded' "$(cat "$STATE/rejected")" "asked for 2.1.308"
has '  the record says rejected and restored' "$(rec .detail)" "REJECTED(2.1.308) restored(2.1.292)"
is '  the record: failed' "$(rec .outcome)" failed
is 'the next boot reinstalls (the record is there): exit' "$(run)" 0
is '  now the floor' "$(claude_v)" 2.1.308
is '  the rejection is cleared once verified' "$([ -e "$STATE/rejected" ] && echo yes || echo no)" no

host 2.1.292 2.1.308
is 'boot, a wrong install that cannot be put back: exit 3' "$(run NPM_MODE=wrong)" 3
is '  the unverified binary is quarantined' "$([ -e "$WRAP/bin/claude.exe.rejected" ] && [ ! -x "$WRAP/bin/claude.exe.rejected" ] && [ ! -e "$WRAP/bin/claude.exe" ] && echo yes || echo no)" yes
has '  and the record says so' "$(rec .detail)" quarantined

# The time bound: a hung npm is stopped by the run itself, inside its budget.
host 2.1.292 2.1.308
t0=$SECONDS
code=$(run NPM_MODE=hang TERMAG_CO_BUDGET=14 TERMAG_CO_KILL_GRACE=1 TERMAG_CO_VER_TIMEOUT=1)
took=$((SECONDS - t0))
is 'boot, npm hangs: exit 1' "$code" 1
if [ "$took" -le 14 ]; then ok "  ended inside the 14 s budget (${took}s)"; else no "  took ${took}s, past the 14 s budget"; fi
is '  claude untouched' "$(claude_v)" 2.1.292
is '  the record: failed' "$(rec .outcome)" failed

# The lock: another run holds it for longer than this one's budget.
host 2.1.292 2.1.308
mkdir -p "$STATE"; exec 8>>"$STATE/lock"; flock 8
is 'lock held: exit 1' "$(run TERMAG_CO_BUDGET=12 TERMAG_CO_KILL_GRACE=1 TERMAG_CO_VER_TIMEOUT=1)" 1
exec 8>&-
is '  installed nothing' "$(installs)" 0
has '  the record says why' "$(rec .detail)" lock-busy

# ── --run ─────────────────────────────────────────────────────────────────────
REC=$RID
host 2.1.308 2.1.308; runner_on_current
request '{"floor":"2.1.308","target":"2.1.316"}'
is 'run, pinned to 2.1.316: exit' "$(ARGS="--run $RID" run)" 0
hasnt '  never asks the registry for a tag' "$(cat "$W/npm.log")" "npm view"
is '  installed exactly 2.1.316' "$(claude_v)/$(plat_v)" 2.1.316/2.1.316
has '  try-restarted the runner orchestrator' "$(cat "$W/systemctl.log")" "systemctl try-restart claude-runner-orchestrator.service"
is '  with its lock released first (Bugbot on #1165)' "$(cat "$SYS/lock_at_restart")" free
is '  the record: updated, manual, its run' "$(rec '.outcome + " " + .trigger + " " + .run')" "updated manual $RID"
is '  target' "$(rec .target)" 2.1.316
has '  the runner runs the new binary' "$(rec .detail)" "runner-restarted unit_binary=current"
has '  the summary' "$(cat "$W/err")" "unit_binary=current"
is '  the request is left for the backend to clear' "$([ -e "$STATE/requests/$RID.json" ] && echo yes || echo no)" yes

host 2.1.308 2.1.308; runner_on_current; echo stale >"$SYS/on_restart"
request '{"target":"2.1.316"}'
is 'run, the runner comes back on an old binary: exit 1' "$(ARGS="--run $RID" run)" 1
has '  STALE' "$(rec .detail)" "unit_binary=STALE($W/old/claude.exe)"
is '  the record: failed' "$(rec .outcome)" failed

host 2.1.308 2.1.308; runner_on_current; echo down >"$SYS/on_restart"
request '{"target":"2.1.316"}'
is 'run, the runner does not come back: exit 1' "$(ARGS="--run $RID" run)" 1
has '  DOWN' "$(rec .detail)" "unit_binary=DOWN(activating/auto-restart)"

host 2.1.308 2.1.308; : >"$SYS/has_unit"; echo inactive >"$SYS/active"
request '{"target":"2.1.316"}'
is 'run, the runner is stopped (a draining host): exit' "$(ARGS="--run $RID" run)" 0
is '  updated' "$(claude_v)" 2.1.316
hasnt '  and stays stopped' "$(cat "$W/systemctl.log")" "restart"
has '  unit_binary -' "$(rec .detail)" "unit_binary=-"

host 2.1.292 2.1.308
is 'run, no request: exit' "$(ARGS="--run $RID" run)" 0
is '  the floor only' "$(claude_v)" 2.1.308
has '  says so' "$(rec .detail)" "policy=none"

host 2.1.292 2.1.308
request '{"target":"$(id)","floor":"1.0.0"}'
is 'run, a bad target and a lower floor: exit' "$(ARGS="--run $RID" run)" 0
is '  the floor file still holds' "$(claude_v)" 2.1.308
has '  says the target was refused' "$(rec .detail)" "target-refused(id)"

host 2.1.292 2.1.308
request 'not json'
is 'run, an unreadable request: exit' "$(ARGS="--run $RID" run)" 0
is '  the floor only' "$(claude_v)" 2.1.308

host 2.1.292 2.1.308
request '{"target":"2.1.300"}'
is 'run, a target below the floor: exit' "$(ARGS="--run $RID" run)" 0
is '  the floor instead' "$(claude_v)" 2.1.308
has '  says so' "$(rec .detail)" "target-below-floor(2.1.300)"

host 2.1.312 2.1.308
request '{"target":"2.1.316","floor":"2.1.314"}'
is 'run, the request raises the floor: exit' "$(ARGS="--run $RID" run)" 0
has '  the floor is the request'"'"'s' "$(cat "$W/err")" "floor=2.1.314"

host 2.1.320 2.1.308
request '{"target":"2.1.316"}'
is 'run, pinned below what is installed: exit' "$(ARGS="--run $RID" run)" 0
is '  the host runs exactly the pin: a downgrade' "$(claude_v)/$(plat_v)" 2.1.316/2.1.316
has '  says so' "$(rec .detail)" "downgrade(2.1.320->2.1.316)"
is '  updated' "$(rec .outcome)" updated
host 2.1.320 2.1.308
request '{"target":"2.1.300"}'
is 'run, pinned below what is installed and below the floor: exit' "$(ARGS="--run $RID" run)" 0
is '  down to the floor, not below it' "$(claude_v)" 2.1.308
has '  says the pin was below the floor' "$(rec .detail)" "target-below-floor(2.1.300)"
host 2.1.316 2.1.308
request '{"target":"2.1.316"}'
is 'run, pinned to what is installed: exit' "$(ARGS="--run $RID" run)" 0
is '  npm installs nothing' "$(installs)" 0
is '  current' "$(rec .outcome)" current

# Host users' sessions: two on the old root binary (one user's with a
# sub-claude), one on the new one, one on the user's own claude. Counted, not stopped.
host 2.1.308 2.1.308
request '{"target":"2.1.316"}'
proc() { mkdir -p "$FPROC/$1"; ln -sfn "$2" "$FPROC/$1/exe"; printf '%s (claude) S %s 1 1\n' "$1" "$3" >"$FPROC/$1/stat"; printf 'Name:\tclaude\nUid:\t%s\t%s\t%s\t%s\n' "$4" "$4" "$4" "$4" >"$FPROC/$1/status"; }
proc 5001 "$WRAP/bin/claude.exe (deleted)" 1 4001
proc 5002 "$WRAP/bin/claude.exe (deleted)" 5001 4001
# npm renames the old package directory while it installs: what a live process shows then.
proc 5003 "$ROOT/@anthropic-ai/.claude-code-ZjqcDZyQ/bin/claude.exe (deleted)" 1 4002
proc 5005 "$W/home/u/.local/share/claude/versions/2.1.290" 1 4002
is 'run with host sessions: exit' "$(ARGS="--run $RID" run)" 0
proc 5004 "$(readlink -f "$BIN")" 1 4002
is '  the old-binary sessions are counted' "$(rec .sessions.other)" 2
is '  nothing is stopped' "$(rec .sessions.stopped)" 0
has '  by user, left running' "$(rec .detail)" "host sessions on an old binary: 2 ("
has '  one each, the sub-claude not counted' "$(rec .detail)" "2 (uid4001 1, uid4002 1), left running"

host 2.1.308 2.1.308; runner_on_current
request '{"target":"2.1.316"}'
is 'run, the runner goes down during the install: exit' "$(ARGS="--run $RID" run FAKE_RUNNER_DIES=1)" 0
has '  it is started again on the new binary (Bugbot on #1165)' "$(cat "$W/systemctl.log")" "systemctl start --no-block claude-runner-orchestrator.service"
has '  and runs it' "$(rec .detail)" "runner-restarted unit_binary=current"
host 2.1.308 2.1.308; runner_on_current
request '{"target":"2.1.316"}'
is 'run, a drain stops the runner during the install: exit' "$(ARGS="--run $RID" run FAKE_RUNNER_DRAINED=1)" 0
hasnt '  it stays stopped (Bugbot on #1165)' "$(cat "$W/systemctl.log")" "start --no-block"
is '  down' "$(cat "$SYS/active")" inactive

# Exact versions only (orchestrator-claude-update-policy, decided on
# #1165). No pin: the floor only, recorded floor-only when nothing moved. A
# tag (or anything else) is refused, and the run is the floor only.
host 2.1.312 2.1.308
request '{"floor":"2.1.308","target":null}'
is 'run, no pin: exit' "$(ARGS="--run $RID" run)" 0
is '  floor-only, not current' "$(rec .outcome)" floor-only
is '  nothing installed' "$(installs)/$(claude_v)" 0/2.1.312
has '  says why' "$(rec .detail)" "policy=floor-only"
host 2.1.292 2.1.308
request '{"floor":"2.1.308"}'
is 'run, no pin, below the floor: exit' "$(ARGS="--run $RID" run)" 0
is '  brought up to the floor' "$(claude_v)" 2.1.308
is '  updated' "$(rec .outcome)" updated
for tag in latest stable 'next;id'; do
  host 2.1.312 2.1.308
  request "{\"target\":\"$tag\"}"
  is "run, the tag '$tag' is refused: exit" "$(ARGS="--run $RID" run)" 0
  is '  floor only: nothing installed, floor-only' "$(installs)/$(rec .outcome)" 0/floor-only
  has '  and logged' "$(cat "$W/err")" "is not an exact version; refused"
  hasnt '  never resolved through the registry' "$(cat "$W/npm.log" 2>/dev/null)" "npm view"
done
host 2.1.312 2.1.308
request '{"target":"2.1.399"}'
is 'run, a pin npm does not have: exit 1' "$(ARGS="--run $RID" run NPM_MODE=fail)" 1
is '  failed, the pin kept as the target' "$(rec '.outcome + " " + .target')" "failed 2.1.399"
is '  unchanged' "$(claude_v)" 2.1.312

# A release whose runner exits right after it starts: DOWN, not current; the
# version that ran is put back and the runner restarted onto it.
host 2.1.308 2.1.308; runner_on_current; echo flaky-then-ok >"$SYS/on_restart"
request '{"target":"2.1.316"}'
is 'run, the runner exits right after starting on 2.1.316: exit 1' "$(ARGS="--run $RID" run)" 1
has '  it did not settle' "$(rec .detail)" "runner-not-settled("
has '  2.1.308 is put back' "$(rec .detail)" "runner-down-on(2.1.316) put-back(2.1.308)"
is '  verified, on disk' "$(claude_v)/$(plat_v)" 2.1.308/2.1.308
has '  and the runner runs it' "$(rec .detail)" "unit_binary=current"
is '  failed: the target did not hold' "$(rec '.outcome + " " + .toVersion')" "failed 2.1.308"
host 2.1.308 2.1.308; runner_on_current; echo flaky >"$SYS/on_restart"
request '{"target":"2.1.316"}'
is 'run, the runner will not stay up on either version: exit 1' "$(ARGS="--run $RID" run)" 1
is '  put back all the same' "$(claude_v)" 2.1.308
has '  DOWN recorded' "$(rec .detail)" "put-back(2.1.308)"
has '  ...' "$(rec .detail)" "unit_binary=DOWN("

# The put-back's install does not run or changes nothing: the verified new
# version is not rejected or quarantined (Bugbot on #1165).
host 2.1.308 2.1.308; runner_on_current; echo flaky >"$SYS/on_restart"
request '{"target":"2.1.316"}'
is 'run, DOWN and the put-back changes nothing: exit 1' "$(ARGS="--run $RID" run NPM_MODE=ok-then-fail)" 1
is '  the verified 2.1.316 stays' "$(claude_v)" 2.1.316
is '  not rejected, not quarantined, not held' "$([ -e "$STATE/rejected" ] || [ -e "$STATE/runner-held" ] || [ -e "$WRAP/bin/claude.exe.rejected" ] && echo yes || echo no)" no
has '  says so' "$(rec .detail)" "put-back-FAILED(nothing-changed)"
# A drain stops the runner during the settle: not DOWN, no put-back, and the
# stop stays (Bugbot on #1165).
host 2.1.308 2.1.308; runner_on_current; echo drained >"$SYS/on_restart"
request '{"target":"2.1.316"}'
is 'run, a drain during the settle: exit' "$(ARGS="--run $RID" run)" 0
is '  2.1.316 stays' "$(claude_v)" 2.1.316
hasnt '  no put-back' "$(rec .detail)" "put-back"
has '  says the runner was stopped meanwhile' "$(rec .detail)" "runner-stopped-meanwhile unit_binary=-"
is '  and it stays stopped' "$(grep -c 'restart claude-runner' "$W/systemctl.log")/$(cat "$SYS/active")" 1/inactive

# A rejected upgrade put back to a verified version above the floor: the next
# boot keeps it. The record must not make it install the floor, a downgrade
# (Devin on #1165).
REC=$RID
host 2.1.312 2.1.308
request '{"target":"2.1.316"}'
is 'run, a wrong upgrade from above the floor: exit 3' "$(ARGS="--run $RID" run NPM_MODE=wrong-once)" 3
is '  put back to 2.1.312, verified' "$(claude_v)/$(plat_v)" 2.1.312/2.1.312
REC=boot0123456789abcdef0123456789abcdef
rm -f "$W/npm.log"
is 'the next boot: exit' "$(run)" 0
is '  keeps the restored 2.1.312 (no downgrade to the floor)' "$(claude_v)" 2.1.312
is '  npm installs nothing' "$(installs)" 0
is '  the stale rejection is cleared' "$([ -e "$STATE/rejected" ] && echo yes || echo no)" no
has '  and the record says so' "$(rec .detail)" "rejection-cleared(2.1.312)"
is '  current' "$(rec .outcome)" current
# The same record with a binary that no longer verifies still reinstalls.
host 2.1.312 2.1.308; mkdir -p "$STATE"; echo "x asked for 2.1.316" >"$STATE/rejected"
sed -i 's/"version": "2.1.312"/"version": "2.1.311"/' "$PLAT/package.json"
is 'a rejection with an unverified binary on disk: exit' "$(run)" 0
is '  reinstalled, at the floor (all it wants at boot)' "$(claude_v)/$(plat_v)" 2.1.308/2.1.308

# ── the hold: a quarantine keeps the runner orchestrator from running ─────────
# What systemd does with the runner's unit: its Condition*= lines, read from
# the real unit file, with /usr/bin/claude and the state directory mapped here.
runner_may_start() {
  local line path
  while IFS= read -r line; do
    case "$line" in
      ConditionFileIsExecutable=*) path=${line#*=}; path=${path/\/usr\/bin\/claude/$BIN}; [ -x "$path" ] && [ -f "$path" ] || return 1 ;;
      'ConditionPathExists=!'*) path=${line#*=!}; path=${path/\/var\/lib\/claude-orchestrator-update/$STATE}; [ ! -e "$path" ] || return 1 ;;
    esac
  done <"$DIR/claude-runner-orchestrator.service"
}
# A boot: cloud-init starts the runner, which runs the floor unit first, then
# starts only if its conditions hold. Prints started or skipped.
boot() {
  run "$@" >/dev/null
  if runner_may_start; then runner_on_current_now; echo started; else echo skipped; fi
}
runner_on_current_now() {
  : >"$SYS/has_unit"; echo active >"$SYS/active"; echo running >"$SYS/sub"; echo 4100 >"$SYS/mainpid"
  mkdir -p "$FPROC/4100"; ln -sfn "$(readlink -f "$BIN")" "$FPROC/4100/exe"
}
grep -qx 'ConditionFileIsExecutable=/usr/bin/claude' "$DIR/claude-runner-orchestrator.service" && ok 'runner unit: needs an executable /usr/bin/claude' || no 'runner unit: no ConditionFileIsExecutable=/usr/bin/claude'
grep -qx 'ConditionPathExists=!/var/lib/claude-orchestrator-update/runner-held' "$DIR/claude-runner-orchestrator.service" && ok 'runner unit: conditions on the hold marker' || no 'runner unit: no ConditionPathExists=! on the hold marker'

REC=boot0123456789abcdef0123456789abcdef
host 2.1.292 2.1.308; : >"$SYS/has_unit"; : >"$SYS/enabled"
is 'boot quarantine: the runner never starts' "$(boot NPM_MODE=wrong)" skipped
is '  the hold marker is there' "$([ -e "$STATE/runner-held" ] && echo yes || echo no)" yes
has '  the record says quarantined and held' "$(rec .detail)" "quarantined runner-held"
is '  failed' "$(rec .outcome)" failed
hasnt '  nothing was asked to start it' "$(cat "$W/systemctl.log")" "start --no-block"
has '  the summary says so' "$(cat "$W/err")" "runner_held=yes"
is 'the next boot installs and verifies: the runner starts' "$(boot)" started
is '  the marker is gone' "$([ -e "$STATE/runner-held" ] && echo yes || echo no)" no
has '  the record says the runner was released' "$(rec .detail)" "runner-released"
is '  updated' "$(rec .outcome)" updated

# A hold whose binary was put back by other means (a reinstall by hand): the
# next run releases it even though it installs nothing (Bugbot on #1165).
host 2.1.292 2.1.308; : >"$SYS/has_unit"; : >"$SYS/enabled"
is 'boot quarantine, again' "$(boot NPM_MODE=wrong)" skipped
NPM_MODE=ok "$STUBS/npm" install -g "$PKGDIR-linux-arm64@2.1.312" "$PKGDIR@2.1.312"; rm -f "$W/npm.log"
is 'a verified 2.1.312 put back by hand: the next boot starts the runner' "$(boot)" started
is '  installing nothing' "$(installs)" 0
is '  the marker is gone' "$([ -e "$STATE/runner-held" ] && echo yes || echo no)" no
has '  the record says the rejection was cleared' "$(rec .detail)" "rejection-cleared(2.1.312)"
has '  and the runner released' "$(rec .detail)" "runner-released"

# No claude at all and an install that fails: nothing to start onto either.
host none 2.1.308; : >"$SYS/has_unit"
is 'boot with no claude and npm failing: the runner never starts' "$(boot NPM_MODE=fail)" skipped

REC=$RID
host 2.1.308 2.1.308; runner_on_current; : >"$SYS/enabled"
request '{"target":"2.1.316"}'
is 'run quarantine: exit 3' "$(ARGS="--run $RID" run NPM_MODE=wrong)" 3
has '  the running runner is stopped' "$(cat "$W/systemctl.log")" "systemctl stop claude-runner-orchestrator.service"
is '  and is down' "$(cat "$SYS/active")/$(cat "$SYS/mainpid")" inactive/0
hasnt '  never restarted onto nothing' "$(cat "$W/systemctl.log")" "restart claude-runner-orchestrator"
has '  the record says quarantined and stopped' "$(rec .detail)" "quarantined runner-stopped"
if runner_may_start; then no '  the backend or Restart=always could start it again'; else ok '  nothing can start it while held'; fi
rm -f "$W/systemctl.log"
request '{"target":"2.1.316"}'
is 'a later good run: exit' "$(ARGS="--run $RID" run)" 0
is '  verified' "$(claude_v)" 2.1.316
has '  starts the runner again' "$(cat "$W/systemctl.log")" "systemctl start --no-block claude-runner-orchestrator.service"
if runner_may_start; then ok '  its conditions hold again'; else no '  still held after a verified install'; fi
has '  the record says released and started' "$(rec .detail)" "runner-released runner-started"

host 2.1.308 2.1.308; runner_on_current
request '{"target":"2.1.316"}'
ARGS="--run $RID" run NPM_MODE=wrong >/dev/null; rm -f "$SYS/enabled"; rm -f "$W/systemctl.log"
request '{"target":"2.1.316"}'
ARGS="--run $RID" run >/dev/null
hasnt 'a disabled runner (no key on this host) is released but not started' "$(cat "$W/systemctl.log")" "start --no-block"

# ── run ids ───────────────────────────────────────────────────────────────────
for a in 'x;id' short "$RID $RID" "../$RID" "${RID^^}" "$(printf 'a%.0s' $(seq 41))"; do
  is "the recipe refuses run id '${a:0:30}'" "$(ARGS="--run $a" run)" 2
done
is 'the recipe refuses no arguments' "$(env PATH="$STUBS:$PATH" bash "$SCRIPT" >/dev/null 2>&1; echo $?)" 2

HELPER=$W/helper
sed "s|^SYSTEMCTL=/usr/bin/systemctl$|SYSTEMCTL=$STUBS/systemctl-start|" "$DIR/claude-orchestrator-update-start" >"$HELPER"
printf '#!/bin/sh\nprintf "%%s|" "$@" >"%s"\n' "$W/helper.argv" >"$STUBS/systemctl-start"; chmod +x "$STUBS/systemctl-start"
grep -q "SYSTEMCTL=$STUBS/systemctl-start" "$HELPER" && ok 'the helper names systemctl in one place' || no 'the helper no longer has SYSTEMCTL=/usr/bin/systemctl'
for a in 'x;id' short "$RID x" '' "-h" "${RID}\$(id)"; do
  rm -f "$W/helper.argv"
  code=$(bash "$HELPER" "$a" >/dev/null 2>&1; echo $?)
  is "the helper refuses '${a:0:30}'" "$code/$([ -e "$W/helper.argv" ] && echo started || echo nothing)" 2/nothing
done
is 'the helper refuses two arguments' "$(bash "$HELPER" "$RID" "$RID" >/dev/null 2>&1; echo $?)" 2
rm -f "$W/helper.argv"
is 'the helper takes a run id' "$(bash "$HELPER" "$RID"; echo $?)" 0
is '  and starts exactly that unit, without waiting' "$(cat "$W/helper.argv")" "start|--no-block|claude-orchestrator-update@$RID.service|"

# ── sudoers ───────────────────────────────────────────────────────────────────
SUDOERS=$DIR/claude-orchestrator-update.sudoers
is 'sudoers: one rule, the helper only, one run-id argument' "$(grep -v '^#' "$SUDOERS" | grep -v '^$')" \
  'termag ALL=(root) NOPASSWD: /usr/local/libexec/termag/claude-orchestrator-update-start ^[a-z0-9]+$'
if command -v visudo >/dev/null 2>&1; then
  if visudo -cf "$SUDOERS" >/dev/null 2>&1; then ok 'sudoers: visudo -cf parses it'; else no "sudoers: visudo -cf: $(visudo -cf "$SUDOERS" 2>&1)"; fi
else
  echo "skip  sudoers: no visudo here"
fi

# ── units ─────────────────────────────────────────────────────────────────────
BOOT=$DIR/claude-orchestrator-floor.service RUNU=$DIR/claude-orchestrator-update@.service ORCH=$DIR/claude-runner-orchestrator.service
has 'boot unit: before the runner orchestrator' "$(cat "$BOOT")" "Before=claude-runner-orchestrator.service"
hasnt 'boot unit: never After=cloud-final (cloud-init enables the runner and would wait on it)' "$(grep -v '^#' "$BOOT")" "cloud-final"
hasnt 'boot unit: no [Install] (it would run before cloud-init'"'"'s install)' "$(grep -v '^#' "$BOOT")" "[Install]"
has 'boot unit: runs --boot' "$(cat "$BOOT")" "ExecStart=/usr/local/libexec/termag/claude-orchestrator-update --boot"
has 'boot unit: stays active once run' "$(cat "$BOOT")" "RemainAfterExit=yes"
has 'boot unit: outcomes, and a signal, are success exits' "$(cat "$BOOT")" "SuccessExitStatus=0 1 3 143"
t=$(sed -n 's/^TimeoutStartSec=//p' "$BOOT"); b=$(sed -n 's/.*boot) BUDGET=\${TERMAG_CO_BUDGET:-\([0-9]*\)}.*/\1/p' "$SCRIPT")
if [ -n "$t" ] && [ -n "$b" ] && [ "$t" -gt "$b" ]; then ok "boot unit: TimeoutStartSec $t covers the ${b}s budget"; else no "boot unit: TimeoutStartSec '$t' vs budget '$b'"; fi
t=$(sed -n 's/^TimeoutStartSec=//p' "$RUNU"); b=$(sed -n 's/.*\*) BUDGET=\${TERMAG_CO_BUDGET:-\([0-9]*\)}.*/\1/p' "$SCRIPT")
if [ -n "$t" ] && [ -n "$b" ] && [ "$t" -gt "$b" ]; then ok "run unit: TimeoutStartSec $t covers the ${b}s budget"; else no "run unit: TimeoutStartSec '$t' vs budget '$b'"; fi
for u in "$BOOT" "$RUNU"; do
  # ProtectHome=read-only makes /root read-only: npm needs its cache elsewhere (found on a systemd host: EROFS).
  if grep -qx 'ProtectHome=read-only' "$u"; then
    has "$(basename "$u"): npm's cache is a CacheDirectory" "$(cat "$u")" $'CacheDirectory=claude-orchestrator-update\nEnvironment=npm_config_cache=/var/cache/claude-orchestrator-update/npm'
  fi
done
has 'run unit: runs --run %i' "$(cat "$RUNU")" "ExecStart=/usr/local/libexec/termag/claude-orchestrator-update --run %i"
has 'runner orchestrator: Wants= the boot unit' "$(grep '^Wants=' "$ORCH")" "claude-orchestrator-floor.service"
has 'runner orchestrator: After= the boot unit' "$(grep '^After=' "$ORCH")" "claude-orchestrator-floor.service"
hasnt 'runner orchestrator: never Requires= it' "$(grep -E '^(Requires|BindsTo|Requisite)=' "$ORCH")" "claude-orchestrator-floor"

echo "$pass passed, $failed failed"
[ "$failed" = 0 ]
