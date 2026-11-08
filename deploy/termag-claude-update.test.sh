#!/bin/sh
# Tests deploy/termag-claude-update, the box's Claude Code updater,
# with npm and claude stubbed on PATH:
#
#   * --ensure below the floor installs @anthropic-ai/claude-code@latest into
#     the npm global and exits 0 once the runner's claude is at the floor; at
#     the floor it installs nothing
#   * an install already at the target is never repeated (npm would reinstall
#     the same version under running sessions): --ensure only below the floor,
#     --boot only below it or behind latest
#   * an install is verified by running claude --version: a binary that does
#     not run is a failure
#   * a global prefix this user cannot write is skipped and reported as
#     root-owned, not failed
#   * an npm failure is retried once, then the run exits 1 and says FAILED
#   * the lock held by another run: it waits TERMAG_CLAUDE_LOCK_WAIT, installs
#     nothing, and exits on the version it finds
#   * two --ensure runs at once: without TERMAG_CLAUDE_LOCK_WAIT the second
#     waits as long as its budget allows, outlasting the first one's install,
#     then exits 0 on that version without installing; one capped short gives
#     up; a rejection the first records is honoured by the second
#   * a native ~/.local/bin/claude (the one a runner prefers) is brought up
#     with `claude install <x.y.z>`, never `claude update`; a native link
#     into node_modules is left to npm
#   * CLAUDE_BIN is the claude judged, as in termag-claude-runner
#   * --boot reads the floor file and waits for the npm registry, bounded:
#     with no network it installs nothing and exits on the floor; behind npm's
#     latest it installs latest; at latest it installs nothing
#   * an npm global whose claude does not run is reinstalled, whatever its
#     package.json says (an install stopped halfway)
#   * --boot stays inside TERMAG_CLAUDE_BUDGET: an npm install that would
#     outlive it is stopped by the script, children included, with no retry;
#     a spent budget runs nothing
#   * one exact version, resolved once, for npm and native, never a tag: a
#     latest that moves between npm view and npm install installs what was
#     resolved; an install that ends at another version (package.json or
#     --version), or whose binary does not run, is rejected: exit 3, recorded,
#     and reinstalled by the next run even if it looks current; a verified
#     install clears the record
#   * a rejected install is never left in place: the previous version is put
#     back and verified (npm reinstall, native relink), else the new binary is
#     quarantined (<name>.rejected, not executable); the record stays
#   * a record whose install path is gone (no npm package, no native binary)
#     is expired at the start of the next run, so it cannot wedge the box
#   * one install spec for npm and native: TARGET unless it resolves below
#     what the run wants (latest under the floor, --boot and --ensure) or
#     cannot be resolved, then that version itself; no install moves down
#   * bad usage exits 2
#   * --run <id> (phase 2), against a stub orchestrator (curl on PATH): the
#     policy is asked for with the agent token on curl's stdin; restart none
#     installs the policy's target, exactly, and only when behind it, and
#     reports; a dist-tag target is resolved once; a 200 with run null
#     restarts nothing; a refusal, no answer or an unreadable body is the
#     floor file alone (installing only below it), restarting nothing; a 404
#     (no such run) posts no report; the report body's shape; a bad run id
#     exits 2
#   * --run's sessions, in a private PID namespace (sudo -n unshare, so the
#     box's own sessions are out of reach; skipped without sudo or tmux), with
#     fake claudes (copies of bash named claude) in real tmux panes: force
#     stops every pane session at once and counts the busy one as cut, a
#     session that ignores SIGTERM is SIGKILLed, a runner gets SIGTERM and
#     drains, one that ignores it is left (runnersLeft) and never SIGKILLed,
#     -p turns and sessions outside tmux are counted as other and left alone,
#     a sub-claude goes with its parent and is not counted; idle waits for a
#     busy session to leave its turn and then stops it, and cuts one still
#     busy at drainSec; agent panes are listed for the orchestrator and never
#     typed into; any other pane with a transcript (under ~/.claude or the
#     process's CLAUDE_CONFIG_DIR) gets `claude --resume <id>` typed, one
#     without is left at its shell; hadConversation true and false in the
#     report; a refused policy or a run still below the floor stops nothing;
#     a run stopped by a signal while it waits reports failed and exits 143
#
# Run: sh deploy/termag-claude-update.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-claude-update"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}
has() {  # has NAME HAYSTACK NEEDLE
  case "$2" in *"$3"*) : ;; *) fail "$1" "$3" "$2" ;; esac
}
lacks() {
  case "$2" in *"$3"*) fail "$1" "(no '$3')" "$2" ;; esac
}
command -v flock >/dev/null 2>&1 || { echo 'SKIP: flock is required for this test'; exit 0; }

HOME_DIR="$WORK/home"
STUB="$WORK/stub"
STATE="$WORK/state"
NPMROOT="$WORK/npm/lib/node_modules"
PKGJSON="$NPMROOT/@anthropic-ai/claude-code/package.json"
mkdir -p "$HOME_DIR" "$STUB" "$STATE" "$NPMROOT/@anthropic-ai/claude-code"
LOG="$WORK/calls"
export LOG STATE NPMROOT PKGJSON

# ── stubs ───────────────────────────────────────────────────────────────────
# npm: `root -g` is the scratch prefix; `view` answers $STATE/latest, or fails
# while $STATE/offline exists; `install -g` lays down $STATE/latest as the
# package's version, or fails with $STATE/npm-rc.
cat > "$STUB/npm" <<'EOF'
#!/bin/sh
echo "npm $*" >> "$LOG"
case "$1" in
  root) echo "$NPMROOT" ;;
  prefix) echo "${NPMROOT%/lib/node_modules}" ;;
  view) [ -e "$STATE/offline" ] && { echo 'npm ERR! network' >&2; exit 1; }; cat "$STATE/latest"
    # $STATE/latest-after-view: the tag moves right after this answer.
    [ -s "$STATE/latest-after-view" ] && mv "$STATE/latest-after-view" "$STATE/latest"; exit 0 ;;
  install)
    # $STATE/install-sleep: an install that hangs, in a child as npm's own
    # work would be, so a stop has to reach the whole group.
    if [ -s "$STATE/install-sleep" ]; then
      sleep "$(cat "$STATE/install-sleep")" &
      echo "$!" > "$STATE/install-child"
      wait
    fi
    rc=$(cat "$STATE/npm-rc" 2>/dev/null || echo 0)
    [ "$rc" = 0 ] || { echo 'npm ERR! boom' >&2; exit "$rc"; }
    # The spec's version when it names one, else what the tag resolves to.
    for a; do spec=$a; done
    v=${spec##*@}
    case "$v" in [0-9]*.[0-9]*.[0-9]*) ;; *) v=$(cat "$STATE/latest") ;; esac
    # $STATE/install-other: a registry or mirror that serves another version;
    # $STATE/install-other-once: the same, for one install only.
    [ -s "$STATE/install-other" ] && v=$(cat "$STATE/install-other")
    [ -s "$STATE/install-other-once" ] && { v=$(cat "$STATE/install-other-once"); rm -f "$STATE/install-other-once"; }
    # $STATE/bin-version-on-install: the installed binary will say this.
    [ -s "$STATE/bin-version-on-install" ] && mv "$STATE/bin-version-on-install" "$STATE/bin-version"
    printf '{\n  "name": "@anthropic-ai/claude-code",\n  "version": "%s"\n}\n' "$v" > "$PKGJSON"
    rm -f "$STATE/broken"
    [ -e "$STATE/break-on-install" ] && : > "$STATE/broken"
    # npm lays the package's binary down again (it may have been quarantined).
    cp "$(dirname "$0")/claude" "${NPMROOT%/lib/node_modules}/bin/claude"
    exit 0 ;;
esac
EOF
# The npm global's claude: the version in its package.json.
cat > "$STUB/claude" <<'EOF'
#!/bin/sh
# What --run types into a pane: a session that stays up (the resume took).
[ "$1" = --resume ] && exec sleep 300
[ "$1" = --version ] || exit 1
# $STATE/broken: what an install whose binary does not run leaves.
[ -e "$STATE/broken" ] && exit 1
v=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$PKGJSON" 2>/dev/null)
[ -n "$v" ] || exit 1
# $STATE/bin-version: a binary that says another version than its package.
[ -s "$STATE/bin-version" ] && v=$(cat "$STATE/bin-version")
echo "$v (Claude Code)"
EOF
# A native install: its version is $STATE/native; `update` moves it to
# $STATE/native-update (if set), `install <t>` to $STATE/latest.
cat > "$WORK/native-claude" <<'EOF'
#!/bin/sh
case "$1" in
  --version) echo "$(cat "$STATE/native") (Claude Code)" ;;
  update) echo "native update DISABLE_AUTOUPDATER=${DISABLE_AUTOUPDATER:-unset}" >> "$LOG"
    [ -s "$STATE/native-update" ] && cp "$STATE/native-update" "$STATE/native"; exit 0 ;;
  install) echo "native install $2" >> "$LOG"
    case "$2" in [0-9]*.[0-9]*.[0-9]*) echo "$2" > "$STATE/native" ;; *) cp "$STATE/latest" "$STATE/native" ;; esac
    # $STATE/native-install-other: a download that is another build.
    [ -s "$STATE/native-install-other" ] && cp "$STATE/native-install-other" "$STATE/native"; exit 0 ;;
esac
EOF
# A native install as the real one lays it out: one file per version under
# ~/.local/share/claude/versions (its name is its version) and a link to it;
# `install <v>` adds a version file and moves the link.
cat > "$WORK/native-linker" <<'EOF'
#!/bin/sh
me=$(readlink -f "$0"); v=${me##*/}
case "$1" in
  --version) echo "$v (Claude Code)" ;;
  install) echo "native install $2" >> "$LOG"; nv=$2
    [ -s "$STATE/native-install-other" ] && nv=$(cat "$STATE/native-install-other")
    cp "$me" "${me%/*}/$nv"; ln -sfn "${me%/*}/$nv" "$HOME/.local/bin/claude" ;;
esac
EOF
chmod +x "$STUB/npm" "$STUB/claude" "$WORK/native-claude" "$WORK/native-linker"
# The claude npm links into the prefix's bin, what an install is verified with.
mkdir -p "$WORK/npm/bin"; cp "$STUB/claude" "$WORK/npm/bin/claude"

npm_at() { printf '{\n  "name": "@anthropic-ai/claude-code",\n  "version": "%s"\n}\n' "$1" > "$PKGJSON"; }
reset() {
  : > "$LOG"
  rm -f "$STATE/offline" "$STATE/npm-rc" "$STATE/native-update" "$STATE/broken" "$STATE/break-on-install" "$STATE/install-sleep" "$STATE/install-child" "$STATE/latest-after-view" "$STATE/install-other" "$STATE/bin-version" "$STATE/bin-version-on-install" "$STATE/native-install-other" "$HOME_DIR/.local/bin/claude" "$HOME_DIR/.termag/claude-update.rejected"
  echo 2.1.312 > "$STATE/latest"
  # A rejected install is quarantined (renamed to .rejected); put the harness's
  # npm-global claude back for the next case.
  rm -f "$WORK/npm/bin/claude.rejected" "$STATE/install-other-once"
  cp "$STUB/claude" "$WORK/npm/bin/claude"
}
run() {
  env -i PATH="$STUB:/usr/bin:/bin" HOME="$HOME_DIR" NVM_DIR="$WORK/no-nvm" LOG="$LOG" STATE="$STATE" \
    NPMROOT="$NPMROOT" PKGJSON="$PKGJSON" TERMAG_CLAUDE_RETRY_SLEEP=0 TERMAG_CLAUDE_LOCK_WAIT=1 \
    TERMAG_CLAUDE_FLOOR_FILE="$WORK/floor" "$@" bash "$SCRIPT" $ARGS 2>"${ERRF:-$WORK/err}"
}
echo 2.1.308 > "$WORK/floor"

# ── --run <id>: the orchestrator's policy (stub curl) ──────────────────────
# curl: GET .../tool-update/policy answers $STATE/policy-code with
# $STATE/policy-body (no answer at all while $STATE/policy-down exists); POST
# .../tool-update/report records its body in $STATE/report-body and answers
# $STATE/report-code (204). Every call is logged to $STATE/curl-calls, and the
# config curl reads on stdin (-K -) to $STATE/curl-config.
cat > "$STUB/curl" <<'EOF'
#!/bin/sh
out=/dev/null data= method=GET url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    --data-binary) data=$2; shift ;;
    -X) method=$2; shift ;;
    -K) [ "$2" = - ] && cat > "$STATE/curl-config"; shift ;;
    -m|-w|-H) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
echo "$method $url" >> "$STATE/curl-calls"
case "$url" in
  */tool-update/policy\?*)
    [ -e "$STATE/policy-down" ] && exit 7
    cat "$STATE/policy-body" > "$out"; printf '%s' "$(cat "$STATE/policy-code")" ;;
  */tool-update/report)
    printf '%s\n' "$data" > "$STATE/report-body"; : > "$out"; printf '%s' "$(cat "$STATE/report-code" 2>/dev/null || echo 204)" ;;
  *) exit 6 ;;
esac
EOF
chmod +x "$STUB/curl"
RUN_ID=cmvtrun0000000000000000001
printf '{"token":"tmag_box_token","termag_url":"wss://orch.example.test/termag/ws/agent"}\n' > "$WORK/agent.config.json"
policy() {  # policy CODE [RESTART [TARGET [DRAIN [RUN]]]]: what the stub orchestrator answers
  printf '%s' "$1" > "$STATE/policy-code"
  printf '{"floor":"2.1.308","target":"%s","restart":"%s","drainSec":%s,"run":%s}' \
    "${3:-2.1.312}" "${2:-none}" "${4:-5}" "${5:-{\"id\":\"$RUN_ID\",\"component\":\"claude\"\}}" > "$STATE/policy-body"
}
run_reset() { reset; rm -f "$STATE/curl-calls" "$STATE/curl-config" "$STATE/report-body" "$STATE/report-code" "$STATE/policy-down"; }
runrun() { ARGS="--run $RUN_ID" run TERMAG_AGENT_CONFIG="$WORK/agent.config.json" "$@"; }
report() { jq -r "$1" "$STATE/report-body" 2>/dev/null; }


# ── --run's sessions, in a private PID namespace ─────────────────────────────
# Fake claudes are copies of bash named claude (the script tells claude by
# /proc/<pid>/exe), so none is the current binary; each pane session writes
# its own session file. Only ever inside the namespace: outside it, every
# real Claude on this box would be on "an old binary" to this test's stubs.
sessions_cases() {
  [ "$$" = 1 ] || { echo 'FAIL: the session cases run only as PID 1 of their own PID namespace'; exit 1; }
  OLD="$WORK/old"; mkdir -p "$OLD" "$HOME_DIR/.claude/sessions" "$WORK/cfg2/sessions"
  cp "$(command -v bash)" "$OLD/claude"
  # fake-session.sh: SID, ST (idle|busy), STUBBORN=1 (ignores SIGTERM), SUB=1 (a sub-claude).
  cat > "$WORK/fake-session.sh" <<'EOF'
cfg=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
printf '{"pid":%s,"sessionId":"%s","cwd":"%s","status":"%s","kind":"interactive"}\n' "$$" "$SID" "$PWD" "${ST:-idle}" > "$cfg/sessions/$$.json"
sub=
[ -n "${SUB:-}" ] && { "$BASH" -c 'while :; do sleep 0.2; done' & sub=$!; }
if [ -n "${STUBBORN:-}" ]; then trap '' TERM; else trap '[ -n "$sub" ] && kill "$sub"; exit 0' TERM; fi
while :; do sleep 0.2; done
EOF
  cat > "$WORK/fake-runner.sh" <<'EOF'
if [ -n "${STUBBORN:-}" ]; then trap '' TERM; else trap 'sleep 1; exit 0' TERM; fi
while :; do sleep 0.2; done
EOF
  S="$WORK/tmux.sock"
  uuid() { printf '%08d-1111-2222-3333-444444444444' "$1"; }
  enc() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }
  # pane NAME SID ST [ENV...]: a tmux session whose shell runs a fake claude.
  pane() {
    n=$1 sid=$2 st=$3; shift 3
    mkdir -p "$WORK/cwd/$n"
    tmux -S "$S" -f /dev/null new-session -d -s "$n" -c "$WORK/cwd/$n" -x 200 -y 50 "env PATH=$STUB:/usr/bin:/bin HOME=$HOME_DIR bash --norc --noprofile"
    tmux -S "$S" send-keys -t "$n" -l -- "env $* HOME=$HOME_DIR SID=$sid ST=$st $OLD/claude $WORK/fake-session.sh"
    tmux -S "$S" send-keys -t "$n" Enter
  }
  bg() { ( "$@" </dev/null >/dev/null 2>&1 & echo "$!" ); }
  transcript() { mkdir -p "$1/projects/$(enc "$2")"; : > "$1/projects/$(enc "$2")/$3.jsonl"; }
  pid_of_sid() { grep -l "\"sessionId\":\"$1\"" "$HOME_DIR"/.claude/sessions/*.json "$WORK"/cfg2/sessions/*.json 2>/dev/null | head -n 1 | sed 's|.*/||; s|\.json$||'; }
  wait_sessions() { for _ in $(seq 1 50); do [ "$(find "$HOME_DIR/.claude/sessions" "$WORK/cfg2/sessions" -name '*.json' | wc -l)" -ge "$1" ] && return 0; sleep 0.1; done; }
  setup() {
    rm -rf "$HOME_DIR/.claude" "$WORK/cfg2" "$WORK/cwd"; mkdir -p "$HOME_DIR/.claude/sessions" "$WORK/cfg2/sessions"
    tmux -S "$S" kill-server 2>/dev/null
    run_reset; npm_at 2.1.312
  }
  teardown() { tmux -S "$S" kill-server 2>/dev/null; for p in $(pgrep -f "$OLD/claude"); do kill -KILL "$p" 2>/dev/null; done; sleep 0.3; }
  pane_text() { tmux -S "$S" capture-pane -p -t "$1" 2>/dev/null; }
  # The same with a long typed line joined back up (a resume after a notice wraps at 200 columns).
  pane_textj() { tmux -S "$S" capture-pane -pJ -t "$1" 2>/dev/null; }
  pane_cmd() { tmux -S "$S" display -p -t "$1" '#{pane_current_command}' 2>/dev/null; }
  runs() { runrun TERMAG_CLAUDE_KILL_AFTER=2 TERMAG_CLAUDE_RUNNER_WAIT="${RW:-6}" TERMAG_CLAUDE_RESUME_WAIT=2 TERMAG_POLICY_TIMEOUT=5; }

  # force: every pane session at once.
  setup
  pane work "$(uuid 1)" idle SUB=1;            transcript "$HOME_DIR/.claude" "$WORK/cwd/work" "$(uuid 1)"
  pane scratch "$(uuid 2)" busy                 # no transcript: never used
  pane alice-proj-agent "$(uuid 3)" idle;      transcript "$HOME_DIR/.claude" "$WORK/cwd/alice-proj-agent" "$(uuid 3)"
  pane alice-proj-ws-agent "$(uuid 4)" idle    # an agent pane that never had a conversation
  pane cfgdir "$(uuid 5)" idle CLAUDE_CONFIG_DIR="$WORK/cfg2"; transcript "$WORK/cfg2" "$WORK/cwd/cfgdir" "$(uuid 5)"
  pane stubborn "$(uuid 6)" idle STUBBORN=1
  mkdir -p "$WORK/cwd/turn"; tmux -S "$S" new-session -d -s turn -c "$WORK/cwd/turn" 'bash --norc --noprofile'
  tmux -S "$S" send-keys -t turn -l -- "$OLD/claude $WORK/fake-runner.sh -p a-turn"; tmux -S "$S" send-keys -t turn Enter
  # Started from a subshell, so they are not this shell's jobs (no "Killed"
  # notices at teardown).
  outside=$(bg "$OLD/claude" "$WORK/fake-runner.sh" -p 'a chat turn')
  runner=$(bg "$OLD/claude" "$WORK/fake-runner.sh" self-hosted-runner --drain-wait-sec 600)
  wait_sessions 6
  stub_pid=$(pid_of_sid "$(uuid 6)")
  policy 200 force 2.1.312 30
  t0=$(date +%s)
  runs; got=$?
  took=$(( $(date +%s) - t0 ))
  [ "$got" = 0 ] || fail 'force: exits 0' 0 "$got: $(tail -5 "$WORK/err")"
  [ "$took" -lt 30 ] || fail 'force: does not wait for drainSec' '< 30 s' "${took}s"
  got=$(report '[.sessions.stopped, .sessions.cut, .sessions.typed, .sessions.resumed, .sessions.fresh, .sessions.other, .sessions.runnersLeft] | join(" ")')
  [ "$got" = '6 1 2 2 2 2 0' ] || fail 'force: stopped cut typed resumed fresh other runnersLeft' '6 1 2 2 2 2 0' "$got; $(report .detail)"
  [ "$(report .outcome)" = current ] || fail 'force: nothing installed, all done: current' current "$(report .outcome)"
  got=$(report '[.panes[] | "\(.session):\(.role):\(.hadConversation):\(.sessionId // "-")"] | sort | join(" ")')
  want="alice-proj-agent:agent:true:$(uuid 3) alice-proj-ws-agent:agent:false:$(uuid 4) cfgdir:other:true:$(uuid 5) scratch:other:false:$(uuid 2) stubborn:other:false:$(uuid 6) work:other:true:$(uuid 1)"
  [ "$got" = "$want" ] || fail 'force: every stopped pane listed, with hadConversation' "$want" "$got"
  has 'force: a pane with a conversation gets claude --resume typed' "$(pane_text work)" "claude --resume $(uuid 1)"
  has 'force: under CLAUDE_CONFIG_DIR too' "$(pane_text cfgdir)" "claude --resume $(uuid 5)"
  # The restart notice: a policy with no trigger (an older orchestrator) gives no reason.
  [ "$(pane_text work | grep -cxF '[termag] Claude Code was updated to 2.1.312; resuming your session.')" = 1 ] \
    || fail 'force: the notice is printed once, before the resume' 'one notice line' "$(pane_text work)"
  # A pane with nothing to resume is left at its shell, and says why (Devin on #1223).
  [ "$(pane_text scratch | grep -cxF '[termag] Claude Code was updated to 2.1.312; its session was stopped, start it again when you need it.')" = 1 ] \
    || fail 'force: a fresh pane gets the notice, once' 'one notice line' "$(pane_text scratch)"
  lacks 'force: and no notice in an agent pane (the orchestrator relaunches it with its own)' "$(pane_text alice-proj-agent)" '[termag]'
  # The report says which line each pane printed, for its chat; an agent pane none.
  got=$(report '[.panes[] | "\(.session)=\(.notice // "-")"] | sort | join("|")')
  want="alice-proj-agent=-|alice-proj-ws-agent=-|cfgdir=[termag] Claude Code was updated to 2.1.312; resuming your session.|scratch=[termag] Claude Code was updated to 2.1.312; its session was stopped, start it again when you need it.|stubborn=[termag] Claude Code was updated to 2.1.312; its session was stopped, start it again when you need it.|work=[termag] Claude Code was updated to 2.1.312; resuming your session."
  [ "$got" = "$want" ] || fail 'force: each pane reports the notice it printed' "$want" "$got"
  [ "$(pane_cmd work)" = sleep ] || fail 'force: the typed resume took (the stub claude --resume runs)' sleep "$(pane_cmd work)"
  for n in scratch alice-proj-agent alice-proj-ws-agent stubborn; do
    lacks "force: nothing typed into $n" "$(pane_text "$n")" 'claude --resume'
    [ "$(pane_cmd "$n")" = bash ] || fail "force: $n is left at its shell" bash "$(pane_cmd "$n")"
  done
  is_running() { kill -0 "$1" 2>/dev/null && [ "$(sed -E 's/^.*\) ([A-Za-z]) .*$/\1/' "/proc/$1/stat")" != Z ]; }
  is_running "$stub_pid" && fail 'force: a session that ignores SIGTERM is SIGKILLed' killed alive
  has 'force: and the detail says so' "$(report .detail)" 'killed=1'
  is_running "$runner" && fail 'force: the runner drained on SIGTERM' exited alive
  is_running "$outside" || fail 'force: a -p turn outside tmux is left alone' alive gone
  [ "$(pane_cmd turn)" = claude ] || fail 'force: a -p turn in a pane is left alone' claude "$(pane_cmd turn)"
  [ "$(pgrep -fc "$OLD/claude -c while")" = 0 ] || fail 'force: the sub-claude went with its parent' 0 "$(pgrep -fc "$OLD/claude -c while")"
  teardown

  # idle: a busy session waits for its turn to end, then stops; an idle one stops at once.
  setup
  pane busy "$(uuid 11)" busy; transcript "$HOME_DIR/.claude" "$WORK/cwd/busy" "$(uuid 11)"
  pane quiet "$(uuid 12)" idle
  wait_sessions 2
  busy_pid=$(pid_of_sid "$(uuid 11)") quiet_pid=$(pid_of_sid "$(uuid 12)")
  policy 200 idle 2.1.312 60
  t0=$(date +%s)
  runs & rp=$!
  sleep 4
  is_running "$quiet_pid" && fail 'idle: an idle session is stopped at once' stopped alive
  is_running "$busy_pid" || fail 'idle: a busy session is not stopped while busy' alive stopped
  sed -i 's/"status":"busy"/"status":"idle"/' "$HOME_DIR/.claude/sessions/$busy_pid.json"
  wait "$rp"; got=$?
  took=$(( $(date +%s) - t0 ))
  [ "$got" = 0 ] || fail 'idle: exits 0' 0 "$got"
  is_running "$busy_pid" && fail 'idle: stopped once out of its turn' stopped alive
  [ "$took" -lt 30 ] || fail 'idle: does not wait out drainSec once every session is idle' '< 30 s' "${took}s"
  got=$(report '[.sessions.stopped, .sessions.cut, .sessions.typed, .sessions.fresh] | join(" ")')
  [ "$got" = '2 0 1 1' ] || fail 'idle: stopped cut typed fresh' '2 0 1 1' "$got; $(report .detail)"
  has 'idle: the busy one is resumed by id' "$(pane_text busy)" "claude --resume $(uuid 11)"
  teardown

  # The restart notice: one line,
  # printed once before the typed resume, naming the run's trigger from the
  # policy. A trigger off the allow-list gives no reason and types nothing of
  # its own, and restart none types nothing at all.
  notice_case() {  # notice_case NAME TRIGGER RESTART
    setup
    pane "$1" "$(uuid 81)" idle; transcript "$HOME_DIR/.claude" "$WORK/cwd/$1" "$(uuid 81)"
    wait_sessions 1
    policy 200 "$3" 2.1.312 0 "$(jq -nc --arg id "$RUN_ID" --arg t "$2" '{id: $id, component: "claude", trigger: $t}')"
    runs
  }
  notice_line() { pane_text "$1" | grep -E '^\[termag\]'; }
  for t in 'manual:update requested by an admin' 'nightly:automatic nightly run' \
    'floor:automatic run: below the minimum version' 'resume:automatic run after the box resumed'; do
    notice_case "n-${t%%:*}" "${t%%:*}" force
    want="[termag] Claude Code was updated to 2.1.312 (${t#*:}); resuming your session."
    [ "$(notice_line "n-${t%%:*}")" = "$want" ] || fail "notice: ${t%%:*}" "$want" "$(pane_text "n-${t%%:*}")"
    [ "$(report '.panes[0].notice')" = "$want" ] || fail "notice: ${t%%:*}: the report has the same line" "$want" "$(report '.panes[0].notice')"
    has "notice: ${t%%:*}: then the resume" "$(pane_textj "n-${t%%:*}")" "; claude --resume $(uuid 81)"
    [ "$(pane_cmd "n-${t%%:*}")" = sleep ] || fail "notice: ${t%%:*}: the resume took" sleep "$(pane_cmd "n-${t%%:*}")"
    teardown
  done
  # A hostile trigger: a quote, a command substitution and a newline. None of it is typed.
  rm -f "$WORK/pwned"
  notice_case n-hostile "nightly'; touch $WORK/pwned; echo '\$(touch $WORK/pwned)
x" force
  [ "$(notice_line n-hostile)" = '[termag] Claude Code was updated to 2.1.312; resuming your session.' ] \
    || fail 'notice: a trigger off the allow-list gives no reason' 'no reason' "$(pane_text n-hostile)"
  lacks 'notice: nothing of the hostile trigger is typed' "$(pane_text n-hostile)" 'pwned'
  [ ! -e "$WORK/pwned" ] || fail 'notice: the hostile trigger ran nothing' 'no file' 'pwned'
  teardown
  # restart none: no session is restarted, so no notice.
  notice_case n-none nightly none
  lacks 'notice: restart none prints nothing' "$(pane_text n-none)" '[termag]'
  [ "$(report '[.panes[] | .notice // empty] | length')" = 0 ] || fail 'notice: restart none reports no notice' 0 "$(report '.panes')"
  [ "$(pane_cmd n-none)" = claude ] || fail 'notice: restart none leaves the session running' claude "$(pane_cmd n-none)"
  teardown

  # idle: still busy at drainSec, cut; a runner that ignores SIGTERM is left, never killed.
  setup; npm_at 2.1.300
  pane stuck "$(uuid 21)" busy
  runner=$(STUBBORN=1 bg "$OLD/claude" "$WORK/fake-runner.sh" self-hosted-runner --drain-wait-sec 600)
  wait_sessions 1
  policy 200 idle 2.1.312 3
  RW=5 runs; got=$?
  got=$(report '[.outcome, .sessions.stopped, .sessions.cut, .sessions.runnersLeft, .fromVersion, .toVersion] | join(" ")')
  [ "$got" = 'partial 1 1 1 2.1.300 2.1.312' ] || fail 'idle cut: outcome stopped cut runnersLeft from to' 'partial 1 1 1 2.1.300 2.1.312' "$got; $(report .detail)"
  is_running "$runner" || fail 'idle cut: the runner that ignores SIGTERM is never SIGKILLed' alive killed
  kill -KILL "$runner" 2>/dev/null
  teardown

  # Stopped by a signal while it waits (systemctl stop): reports failed, exits 143.
  setup
  pane waiting "$(uuid 41)" busy
  wait_sessions 1; waiting_pid=$(pid_of_sid "$(uuid 41)")
  policy 200 idle 2.1.312 60
  runs & rp=$!
  sleep 3
  # The script itself, not the subshell running `runs` (this namespace holds nothing else).
  kill -TERM "$(pgrep -f "termag-claude-update --run $RUN_ID")"; wait "$rp"; got=$?
  [ "$got" = 143 ] || fail 'signal: exits 143' 143 "$got"
  [ "$(report .outcome)" = failed ] || fail 'signal: reports failed' failed "$(report .outcome)"
  has 'signal: says why' "$(report .detail)" 'stopped by a signal'
  is_running "$waiting_pid" || fail 'signal: the busy session it was waiting for is left running' alive stopped
  teardown

  # A signal after a pane was sent SIGTERM, before it finished: the report still
  # lists it, so the orchestrator relaunches the agent pane (Bugbot on #995).
  setup
  pane alice-proj-agent "$(uuid 51)" idle STUBBORN=1; transcript "$HOME_DIR/.claude" "$WORK/cwd/alice-proj-agent" "$(uuid 51)"
  wait_sessions 1; stubborn_pid=$(pid_of_sid "$(uuid 51)")
  policy 200 force 2.1.312 0
  runrun TERMAG_CLAUDE_KILL_AFTER=60 TERMAG_CLAUDE_RUNNER_WAIT=6 TERMAG_CLAUDE_RESUME_WAIT=2 TERMAG_POLICY_TIMEOUT=5 & rp=$!
  sleep 3
  kill -TERM "$(pgrep -f "termag-claude-update --run $RUN_ID")"; wait "$rp"
  got=$(report '[.outcome, (.panes[] | "\(.session):\(.role):\(.hadConversation)")] | join(" ")')
  [ "$got" = 'failed alice-proj-agent:agent:true' ] || fail 'signal after SIGTERM: the stopped pane is still reported' 'failed alice-proj-agent:agent:true' "$got"
  kill -KILL "$stubborn_pid" 2>/dev/null
  teardown

  # Refused, or still below the floor: nothing is stopped.
  setup
  pane keep "$(uuid 31)" idle
  wait_sessions 1; keep_pid=$(pid_of_sid "$(uuid 31)")
  policy 403 force
  runs
  is_running "$keep_pid" || fail 'refused: a refused policy stops nothing' alive stopped
  printf 200 > "$STATE/policy-code"
  printf '{"floor":"2.1.400","target":"2.1.400","restart":"force","drainSec":0,"run":{"id":"%s","component":"claude"}}' "$RUN_ID" > "$STATE/policy-body"
  echo 1 > "$STATE/npm-rc"
  runs; got=$?
  [ "$got" = 1 ] || fail 'below the floor: exits 1' 1 "$got"
  is_running "$keep_pid" || fail 'below the floor: nothing is stopped' alive stopped
  [ "$(report .outcome)" = failed ] || fail 'below the floor: outcome failed' failed "$(report .outcome)"
  has 'below the floor: says why nothing restarted' "$(report .detail)" 'restart=none(claude below-floor)'
  teardown

  # The npm global fails, but the native claude a session starts is already
  # the target: an old pane still moves to it (Devin on #1076).
  setup
  mkdir -p "$HOME_DIR/.local/bin"; cp "$WORK/native-claude" "$HOME_DIR/.local/bin/claude"; echo 2.1.312 > "$STATE/native"
  npm_at 2.1.300; echo 1 > "$STATE/npm-rc"
  pane npmfail "$(uuid 41)" idle
  wait_sessions 1; nf_pid=$(pid_of_sid "$(uuid 41)")
  policy 200 force 2.1.312 0
  runs
  ! is_running "$nf_pid" || fail 'npm fails, native current: the old pane is stopped' stopped alive
  has 'npm fails, native current: restarts as asked' "$(report .detail)" 'restart=force '
  rm -f "$HOME_DIR/.local/bin/claude"
  teardown

  # --sessions (a Node update run): no policy,
  # no install, no report. The Claude Code panes on an old binary are stopped
  # as restart says, each shell gets the new default's bin first on its PATH
  # before its resume, and the result is one JSON line on stdout; a busy
  # session waits for its turn under idle.
  setup
  pane work "$(uuid 71)" idle;            transcript "$HOME_DIR/.claude" "$WORK/cwd/work" "$(uuid 71)"
  pane busy "$(uuid 72)" busy;            transcript "$HOME_DIR/.claude" "$WORK/cwd/busy" "$(uuid 72)"
  pane alice-proj-agent "$(uuid 73)" idle; transcript "$HOME_DIR/.claude" "$WORK/cwd/alice-proj-agent" "$(uuid 73)"
  wait_sessions 3
  busy_pid=$(pid_of_sid "$(uuid 72)")
  ARGS='--sessions idle 30' run TERMAG_CLAUDE_KILL_AFTER=2 TERMAG_CLAUDE_RUNNER_WAIT=0 TERMAG_CLAUDE_RESUME_WAIT=2 > "$WORK/sessions.json" & rp=$!
  sleep 4
  is_running "$busy_pid" || fail '--sessions idle: a session in a turn is not stopped' alive stopped
  sed -i 's/"status":"busy"/"status":"idle"/' "$HOME_DIR/.claude/sessions/$busy_pid.json"
  wait "$rp"; got=$?
  [ "$got" = 0 ] || fail '--sessions: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
  out=$(tail -n 1 "$WORK/sessions.json")
  got=$(printf '%s' "$out" | jq -r '[.component, .restart, .sessions.stopped, .sessions.cut, .sessions.typed, .sessions.resumed] | join(" ")')
  [ "$got" = 'claude idle 3 0 2 2' ] || fail '--sessions: component restart stopped cut typed resumed' 'claude idle 3 0 2 2' "$got; $(tail -3 "$WORK/err")"
  got=$(printf '%s' "$out" | jq -r '[.panes[] | "\(.session):\(.role):\(.sessionId // "-")"] | sort | join(" ")')
  want="alice-proj-agent:agent:$(uuid 73) busy:other:$(uuid 72) work:other:$(uuid 71)"
  [ "$got" = "$want" ] || fail '--sessions: the stopped panes, for the caller'"'"'s report' "$want" "$got"
  has '--sessions: the new PATH, then the resume' "$(pane_text work)" "export PATH=$WORK/npm/bin:\"\$PATH\"; claude --resume $(uuid 71)"
  has '--sessions: an agent pane gets the new PATH for its relaunch' "$(pane_text alice-proj-agent)" "export PATH=$WORK/npm/bin:"
  lacks '--sessions: and nothing more' "$(pane_text alice-proj-agent)" 'claude --resume'
  [ ! -e "$STATE/curl-calls" ] || fail '--sessions: no policy, no report' 'no orchestrator call' "$(cat "$STATE/curl-calls")"
  lacks '--sessions: installs nothing' "$(cat "$LOG")" 'npm install'
  teardown

  # --sessions with its caller's notice (Node's run): printed before the
  # resume, after the PATH; one that is not safe to type is dropped.
  for nt in ok hostile; do
    setup
    pane "s-$nt" "$(uuid 75)" idle; transcript "$HOME_DIR/.claude" "$WORK/cwd/s-$nt" "$(uuid 75)"
    wait_sessions 1
    if [ "$nt" = ok ]; then n='[termag] Node was updated to 22.21.1 (automatic nightly run); resuming your session.'
    else n="[termag] Node'; touch $WORK/pwned; echo '"; fi
    rm -f "$WORK/pwned"
    ARGS='--sessions force 0' run TERMAG_CLAUDE_KILL_AFTER=2 TERMAG_CLAUDE_RUNNER_WAIT=0 TERMAG_CLAUDE_RESUME_WAIT=2 "TERMAG_RESTART_NOTICE=$n" > "$WORK/sessions.json"
    if [ "$nt" = ok ]; then
      [ "$(pane_text s-ok | grep -cxF "$n")" = 1 ] || fail '--sessions: the caller'"'"'s notice, once' "$n" "$(pane_text s-ok)"
      has '--sessions: PATH, notice, resume' "$(pane_textj s-ok)" "\"\$PATH\"; printf '%s\\n' '$n'; claude --resume $(uuid 75)"
    else
      lacks '--sessions: an unsafe notice is not typed' "$(pane_text s-hostile)" 'pwned'
      has '--sessions: the resume all the same' "$(pane_textj s-hostile)" "\"\$PATH\"; claude --resume $(uuid 75)"
      [ ! -e "$WORK/pwned" ] || fail '--sessions: the unsafe notice ran nothing' 'no file' 'pwned'
    fi
    teardown
  done

  # --sessions none: nothing is stopped.
  setup
  pane keep "$(uuid 74)" idle
  wait_sessions 1; keep_pid=$(pid_of_sid "$(uuid 74)")
  out=$(ARGS='--sessions none 0' run | tail -n 1)
  is_running "$keep_pid" || fail '--sessions none: nothing is stopped' alive stopped
  got=$(printf '%s' "$out" | jq -r '[.restart, .sessions.stopped] | join(" ")')
  [ "$got" = 'none 0' ] || fail '--sessions none: says so' 'none 0' "$got"
  teardown
}
if [ "${1:-}" = --sessions ]; then
  sessions_cases
  if [ "$failures" -eq 0 ]; then echo 'ok: termag-claude-update --run sessions (PID namespace)'; exit 0; fi
  echo "$failures failure(s) in the session cases"; exit 1
fi

# ── --ensure, below the floor ───────────────────────────────────────────────
reset; npm_at 2.1.300
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'below: exits 0 once updated' 0 "$got: $(cat "$WORK/err")"
has 'below: installs the exact version latest resolved to' "$(cat "$LOG")" "npm install -g --no-fund --no-audit --loglevel=error @anthropic-ai/claude-code@2.1.312"
lacks 'below: never the tag itself' "$(cat "$LOG")" 'loglevel=error @anthropic-ai/claude-code@latest'
has 'below: logs the exact version, verified' "$(cat "$WORK/err")" 'npm installed @anthropic-ai/claude-code@2.1.312, verified'
has 'below: the summary says ok' "$(cat "$WORK/err")" "version=2.1.312 floor=2.1.308 state=ok npm=2.1.300->2.1.312"
[ -f "$HOME_DIR/.termag/claude-update.lock" ] || fail 'below: the lock is under ~/.termag' present absent

# ── --ensure, at the floor ──────────────────────────────────────────────────
reset; npm_at 2.1.308
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'at: exits 0' 0 "$got"
lacks 'at: installs nothing' "$(cat "$LOG")" 'npm install'
has 'at: says so' "$(cat "$WORK/err")" 'at or above the floor 2.1.308; nothing to do'
# Above the floor too.
reset; npm_at 2.1.400
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'above: exits 0' 0 "$got"
lacks 'above: installs nothing (sort -V, not string order)' "$(cat "$LOG")" 'npm install'

# ── --ensure, npm fails ─────────────────────────────────────────────────────
reset; npm_at 2.1.300; echo 1 > "$STATE/npm-rc"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 1 ] || fail 'npm failure: exits 1' 1 "$got"
got=$(grep -c 'npm install' "$LOG")
[ "$got" = 2 ] || fail 'npm failure: one retry' 2 "$got"
has 'npm failure: the summary says FAILED and below-floor' "$(cat "$WORK/err")" 'state=below-floor npm=2.1.300->FAILED'

# ── an install whose binary does not run ────────────────────────────────────
# npm exits 0 and the package.json says the version, but claude --version
# fails (a postinstall that did not run could leave that): rejected, exit 3,
# recorded until a later run installs it again and verifies it.
reset; npm_at 2.1.300; : > "$STATE/break-on-install"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 3 ] || fail 'binary does not run: rejected, exits 3' 3 "$got"
has 'binary does not run: the summary says so' "$(cat "$WORK/err")" 'state=rejected npm=2.1.300->pin-mismatch'
has 'binary does not run: logged' "$(cat "$WORK/err")" 'does not run'
[ -s "$HOME_DIR/.termag/claude-update.rejected" ] || fail 'binary does not run: recorded' 'claude-update.rejected' absent
# Still recorded, so a run whose reinstall fails still exits 3...
rm -f "$STATE/break-on-install"; : > "$LOG"
echo 1 > "$STATE/npm-rc"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 3 ] || fail 'rejected: a failed retry keeps the record (exit 3)' 3 "$got"
# ...and a verified reinstall clears it, even though the package already says current.
rm -f "$STATE/npm-rc" "$STATE/broken"; : > "$LOG"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'rejected: a verified reinstall clears it' 0 "$got: $(cat "$WORK/err")"
has 'rejected: reinstalled although at the floor' "$(cat "$LOG")" 'npm install'
[ ! -e "$HOME_DIR/.termag/claude-update.rejected" ] || fail 'rejected: the record is gone' absent "$(cat "$HOME_DIR/.termag/claude-update.rejected")"

# ── exactly the resolved version, or rejected ───────────────────────────────
# latest moves between npm view and npm install: the resolved version is installed.
reset; npm_at 2.1.300; echo 2.1.399 > "$STATE/latest-after-view"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'moving tag: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'moving tag: installs what was resolved' "$(cat "$LOG")" '@anthropic-ai/claude-code@2.1.312'
has 'moving tag: summary' "$(cat "$WORK/err")" 'npm=2.1.300->2.1.312'
# The same for --boot.
reset; npm_at 2.1.308; echo 2.1.399 > "$STATE/latest-after-view"
ARGS='--boot' run; got=$?
has 'moving tag, boot: installs what was resolved' "$(cat "$LOG")" '@anthropic-ai/claude-code@2.1.312'
# npm installs another version than asked: rejected, exit 3, even above the floor.
reset; npm_at 2.1.300; echo 2.1.399 > "$STATE/install-other"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 3 ] || fail 'other version: rejected, exits 3' 3 "$got"
has 'other version: says what it got' "$(cat "$WORK/err")" 'asked for 2.1.312; package.json says 2.1.399'
# The next run goes back to the verified version, though 2.1.399 is "higher".
rm -f "$STATE/install-other"; : > "$LOG"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'other version, then verified: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'other version: replaced by the verified version, not kept as a "no-downgrade"' "$(cat "$LOG")" '@anthropic-ai/claude-code@2.1.312'
# The package says the version but the binary another: rejected too.
reset; npm_at 2.1.300; echo 2.1.400 > "$STATE/bin-version-on-install"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 3 ] || fail 'binary disagrees with its package: rejected, exits 3' 3 "$got"
has 'binary disagrees: says so' "$(cat "$WORK/err")" '--version says 2.1.400'

# ── a rejected npm install is put back, or quarantined ──────────────────────
# The previous version ran: it is reinstalled and verified; the record stays.
reset; npm_at 2.1.300; echo 2.1.399 > "$STATE/install-other-once"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 3 ] || fail 'npm restore: rejected, exits 3' 3 "$got"
has 'npm restore: reinstalls the version that ran' "$(cat "$LOG")" '@anthropic-ai/claude-code@2.1.300'
has 'npm restore: verified' "$(cat "$WORK/err")" 'is back at 2.1.300, verified'
has 'npm restore: the summary says restored' "$(cat "$WORK/err")" 'npm=2.1.300->pin-mismatch,restored:2.1.300'
[ "$("$WORK/npm/bin/claude" --version 2>/dev/null)" = '2.1.300 (Claude Code)' ] || fail 'npm restore: the npm global claude is the version that ran' '2.1.300 (Claude Code)' "$("$WORK/npm/bin/claude" --version 2>&1)"
grep -q '^npm ' "$HOME_DIR/.termag/claude-update.rejected" 2>/dev/null || fail 'npm restore: the record stays' 'npm ...' "$(cat "$HOME_DIR/.termag/claude-update.rejected" 2>/dev/null)"
# The same at boot: the agent's pane relaunch must not start the rejected build.
reset; npm_at 2.1.300; echo 2.1.399 > "$STATE/install-other-once"
ARGS='--boot' run; got=$?
[ "$got" = 3 ] || fail 'npm restore, boot: rejected, exits 3' 3 "$got"
has 'npm restore, boot: verified' "$(cat "$WORK/err")" 'is back at 2.1.300, verified'
# No version that ran to go back to: the new binary is quarantined.
reset; npm_at 2.1.300; : > "$STATE/broken"; echo 2.1.399 > "$STATE/install-other"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 3 ] || fail 'npm quarantine: rejected, exits 3' 3 "$got"
[ ! -e "$WORK/npm/bin/claude" ] || fail 'npm quarantine: the rejected binary is not left in place' 'moved away' present
[ -e "$WORK/npm/bin/claude.rejected" ] && [ ! -x "$WORK/npm/bin/claude.rejected" ] || fail 'npm quarantine: renamed, not executable' 'claude.rejected, not executable' "$(ls -l "$WORK/npm/bin" 2>&1)"
has 'npm quarantine: the summary says so' "$(cat "$WORK/err")" 'pin-mismatch,quarantined'
lacks 'npm quarantine: no restore without a version that ran' "$(cat "$WORK/err")" 'putting the npm global back'

# ── a stale record is expired ──────────────────────────────────────────
# A native record whose path is gone: the run proceeds, and the record is cleared.
reset; npm_at 2.1.312; mkdir -p "$HOME_DIR/.termag"
printf 'native asked for 2.1.312; --version says 2.1.399\n' > "$HOME_DIR/.termag/claude-update.rejected"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'stale native record: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'stale native record: expired' "$(cat "$WORK/err")" 'the rejected native install is gone'
[ ! -e "$HOME_DIR/.termag/claude-update.rejected" ] || fail 'stale native record: cleared' absent "$(cat "$HOME_DIR/.termag/claude-update.rejected")"
# A native record whose path is now a link into node_modules: expired too.
reset; npm_at 2.1.312; mkdir -p "$HOME_DIR/.local/bin" "$NPMROOT/@anthropic-ai/claude-code/bin"
cp "$STUB/claude" "$NPMROOT/@anthropic-ai/claude-code/bin/claude.exe"
ln -sfn "$NPMROOT/@anthropic-ai/claude-code/bin/claude.exe" "$HOME_DIR/.local/bin/claude"
printf 'native asked for 2.1.312; --version says 2.1.399\n' > "$HOME_DIR/.termag/claude-update.rejected"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'native record, now an npm link: exits 0' 0 "$got: $(cat "$WORK/err")"
[ ! -e "$HOME_DIR/.termag/claude-update.rejected" ] || fail 'native record, now an npm link: cleared' absent present
rm -f "$HOME_DIR/.local/bin/claude"
# An npm record whose package is uninstalled: expired, never exit 3 for ever.
reset; rm -f "$PKGJSON"
printf 'npm asked for 2.1.312; package.json says 2.1.399, --version says 2.1.399\n' > "$HOME_DIR/.termag/claude-update.rejected"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" != 3 ] || fail 'stale npm record: not wedged at exit 3' 'not 3' "$got"
has 'stale npm record: expired' "$(cat "$WORK/err")" 'the rejected npm global @anthropic-ai/claude-code is gone'
[ ! -e "$HOME_DIR/.termag/claude-update.rejected" ] || fail 'stale npm record: cleared' absent present

# ── a global prefix this user cannot write (root's /usr) ────────────────────
if [ "$(id -u)" = 0 ]; then
  echo 'skip: root-owned prefix (root can write any directory)'
else
  reset; npm_at 2.1.300
  chmod 555 "$NPMROOT"
  ARGS='--ensure 2.1.308' run; got=$?
  chmod 755 "$NPMROOT"
  [ "$got" = 1 ] || fail 'root-owned below the floor: exits 1 (the floor decides)' 1 "$got"
  lacks 'root-owned: no npm install' "$(cat "$LOG")" 'npm install'
  has 'root-owned: reported' "$(cat "$WORK/err")" 'npm=2.1.300(root-owned)'
  reset; npm_at 2.1.308
  chmod 555 "$NPMROOT"
  ARGS='--boot' run; got=$?
  chmod 755 "$NPMROOT"
  [ "$got" = 0 ] || fail 'root-owned at the floor, behind latest: skipped, not failed' 0 "$got"
  lacks 'root-owned boot: no npm install' "$(cat "$LOG")" 'npm install'
fi

# ── a half-written npm global is repaired ───────────────────────────────────
# An install stopped halfway: package.json already says latest, but its
# claude does not run. Judged by the binary, so it is reinstalled.
reset; npm_at 2.1.312; : > "$STATE/broken"
ARGS='--boot' run; got=$?
[ "$got" = 0 ] || fail 'repair: a broken npm global is reinstalled and works' 0 "$got: $(cat "$WORK/err")"
has 'repair: installs although package.json says latest' "$(cat "$LOG")" 'npm install'
has 'repair: says it was broken' "$(cat "$WORK/err")" 'npm=broken->2.1.312'
reset; npm_at 2.1.312; : > "$STATE/broken"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'repair: --ensure reinstalls a broken npm global too' 0 "$got"

# ── the --boot budget ───────────────────────────────────────────────────────
# An npm install that would outlive the budget is stopped by the script
# itself (its share is the budget less the 30 s reserve), children and all,
# well before anything outside could cut it, and there is no retry.
reset; npm_at 2.1.300; echo 120 > "$STATE/install-sleep"
start=$(date +%s)
ARGS='--boot' run TERMAG_CLAUDE_BUDGET=45; got=$?
took=$(( $(date +%s) - start ))
child=$(cat "$STATE/install-child" 2>/dev/null)
[ "$got" = 1 ] || fail 'budget: a stopped install leaves it below the floor: exits 1' 1 "$got"
[ "$took" -lt 30 ] || fail 'budget: the script stops the install itself, inside the budget' '< 30 s (budget 45)' "${took}s"
[ "$took" -ge 8 ] || fail 'budget: the install got its share of the budget' '>= 8 s' "${took}s"
got=$(grep -c 'npm install' "$LOG")
[ "$got" = 1 ] || fail 'budget: no retry without room for one' 1 "$got"
has 'budget: says so' "$(cat "$WORK/err")" 'budget has no room for a retry'
has 'budget: the summary says FAILED' "$(cat "$WORK/err")" 'npm=2.1.300->FAILED'
if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
  fail "budget: the install's children are stopped too" '(gone)' "pid $child alive"
  kill "$child" 2>/dev/null
fi
# The runner's budget (deploy/termag-claude-runner: a 180 s cap, a 170 s
# budget): the install gets the budget less the reserve, not 75 s (Bugbot's
# "runner install window is too short"), so a slow 100 s install completes.
reset; npm_at 2.1.300; echo 100 > "$STATE/install-sleep"
start=$(date +%s)
ARGS='--ensure 2.1.308' run TERMAG_CLAUDE_BUDGET=170; got=$?
took=$(( $(date +%s) - start ))
[ "$got" = 0 ] || fail 'runner budget: a 100 s install completes' 0 "$got: $(cat "$WORK/err")"
[ "$took" -lt 170 ] || fail 'runner budget: inside the budget' '< 170 s' "${took}s"
cap=$(sed -n 's/.*installing .* (at most \([0-9]*\)s)$/\1/p' "$WORK/err" | head -n 1)
[ "${cap:-0}" -ge 135 ] || fail 'runner budget: the install window is the budget less the 30 s reserve' '>= 135 s' "${cap:-none}s"
# A spent budget runs nothing: no lock wait, no registry, no install.
reset; npm_at 2.1.300
ARGS='--boot' run TERMAG_CLAUDE_BUDGET=0; got=$?
[ "$got" = 1 ] || fail 'budget 0: exits on the floor' 1 "$got"
lacks 'budget 0: installs nothing' "$(cat "$LOG")" 'npm install'

# ── the lock held by another run ────────────────────────────────────────────
# The holder execs sleep with the lock's fd, so killing $! releases it.
hold_lock() { exec 8>"$HOME_DIR/.termag/claude-update.lock"; flock 8; exec sleep 5; }
reset; npm_at 2.1.300
mkdir -p "$HOME_DIR/.termag"
hold_lock &
holder=$!
sleep 0.3
ARGS='--ensure 2.1.308' run; got=$?
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
[ "$got" = 1 ] || fail 'lock held: exits on the version it finds (below)' 1 "$got"
lacks 'lock held: installs nothing' "$(cat "$LOG")" 'npm install'
has 'lock held: says so' "$(cat "$WORK/err")" 'held the lock for 1s; installing nothing'
# At the floor, a held lock is still a 0.
npm_at 2.1.308
hold_lock &
holder=$!
sleep 0.3
ARGS='--ensure 2.1.308' run; got=$?
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
[ "$got" = 0 ] || fail 'lock held at the floor: exits 0' 0 "$got"

# ── two runs at once (Bugbot: "the lock wait is shorter than an update in flight") ─
# Two runner slots spawned together after a floor bump both run --ensure. The
# first holds the lock through a 20 s install; the second waits as long as its
# own budget allows (no TERMAG_CLAUDE_LOCK_WAIT), then finds the floor met and
# exits 0 on the first one's version without installing. A third, capped at
# 5 s, gives up the way the old fixed wait did (120 s against a 140 s install).
reset; npm_at 2.1.300; echo 20 > "$STATE/install-sleep"
ERRF="$WORK/err.holder" ARGS='--ensure 2.1.308' run TERMAG_CLAUDE_BUDGET=60 &
holder=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q 'npm install' "$LOG" 2>/dev/null && break; sleep 0.5; done
ERRF="$WORK/err.capped" ARGS='--ensure 2.1.308' run TERMAG_CLAUDE_BUDGET=60 TERMAG_CLAUDE_LOCK_WAIT=5 &
capped=$!
start=$(date +%s)
ERRF="$WORK/err.waiter" ARGS='--ensure 2.1.308' run TERMAG_CLAUDE_BUDGET=60 TERMAG_CLAUDE_LOCK_WAIT=; got=$?
took=$(( $(date +%s) - start ))
wait "$holder"; holder_rc=$?
wait "$capped"; capped_rc=$?
[ "$holder_rc" = 0 ] || fail 'concurrent: the holder installs and exits 0' 0 "$holder_rc: $(cat "$WORK/err.holder")"
[ "$got" = 0 ] || fail 'concurrent: the waiter outlasts the install and exits 0' 0 "$got: $(cat "$WORK/err.waiter")"
[ "$took" -ge 10 ] || fail 'concurrent: the waiter really waited for the holder' '>= 10 s' "${took}s"
has 'concurrent: the waiter says it waited, then checked again' "$(cat "$WORK/err.waiter")" 'checking again'
has 'concurrent: the waiter finds the floor met' "$(cat "$WORK/err.waiter")" 'is 2.1.312, at or above the floor 2.1.308; nothing to do'
got=$(grep -c 'npm install' "$LOG")
[ "$got" = 1 ] || fail 'concurrent: only the holder installs' 1 "$got"
[ "$capped_rc" = 1 ] || fail 'concurrent: a 5 s lock wait gives up below the floor (the old failure)' 1 "$capped_rc: $(cat "$WORK/err.capped")"
has 'concurrent: the capped waiter says so' "$(cat "$WORK/err.capped")" 'held the lock for 5s; installing nothing'
# A rejection the holder records is honoured by the waiter: no exit 0 on it.
reset; npm_at 2.1.300; echo 10 > "$STATE/install-sleep"; echo 2.1.399 > "$STATE/install-other"
ERRF="$WORK/err.holder" ARGS='--ensure 2.1.308' run TERMAG_CLAUDE_BUDGET=60 &
holder=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do grep -q 'npm install' "$LOG" 2>/dev/null && break; sleep 0.5; done
ERRF="$WORK/err.waiter" ARGS='--ensure 2.1.308' run TERMAG_CLAUDE_BUDGET=60 TERMAG_CLAUDE_LOCK_WAIT=; got=$?
wait "$holder"; holder_rc=$?
[ "$holder_rc" = 3 ] || fail 'concurrent, rejected: the holder rejects its install' 3 "$holder_rc"
[ "$got" = 3 ] || fail 'concurrent, rejected: the waiter honours the record (exit 3), though 2.1.399 is above the floor' 3 "$got: $(cat "$WORK/err.waiter")"

# ── a native ~/.local/bin/claude ────────────────────────────────────────────
reset; npm_at 2.1.312
mkdir -p "$HOME_DIR/.local/bin"
cp "$WORK/native-claude" "$HOME_DIR/.local/bin/claude"
echo 2.1.290 > "$STATE/native"; echo 2.1.310 > "$STATE/native-update"
ARGS='--ensure 2.1.308' run DISABLE_AUTOUPDATER=1; got=$?
[ "$got" = 0 ] || fail 'native: exits 0 after claude install' 0 "$got: $(cat "$WORK/err")"
lacks 'native: never claude update (its own channel picks the bytes)' "$(cat "$LOG")" 'native update'
has 'native: claude install of the exact resolved version' "$(cat "$LOG")" 'native install 2.1.312'
lacks 'native: never a tag' "$(cat "$LOG")" 'native install latest'
lacks 'native: an npm global already at the floor is left alone' "$(cat "$LOG")" 'npm install'
has 'native: the runner would start the native one' "$(cat "$WORK/err")" "claude=$HOME_DIR/.local/bin/claude version=2.1.312"
has 'native: verified' "$(cat "$WORK/err")" 'is now 2.1.312, verified'
# claude install puts another build in place: rejected (exit 3), recorded as native.
reset; npm_at 2.1.312
cp "$WORK/native-claude" "$HOME_DIR/.local/bin/claude"
echo 2.1.290 > "$STATE/native"; echo 2.1.399 > "$STATE/native-install-other"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 3 ] || fail 'native, another build: rejected, exits 3' 3 "$got: $(cat "$WORK/err")"
has 'native, another build: says what it got' "$(cat "$WORK/err")" 'REJECTED native install: asked for 2.1.312'
grep -q '^native ' "$HOME_DIR/.termag/claude-update.rejected" 2>/dev/null || fail 'native, another build: recorded as native' 'native ...' "$(cat "$HOME_DIR/.termag/claude-update.rejected" 2>/dev/null)"
# Nothing to put back (this plain-file native's previous build is gone), so the
# rejected one is quarantined: nothing resolves claude to it now.
[ ! -e "$HOME_DIR/.local/bin/claude" ] || fail 'native, another build: not left in place' 'quarantined' 'still at ~/.local/bin/claude'
[ -e "$HOME_DIR/.local/bin/claude.rejected" ] && [ ! -x "$HOME_DIR/.local/bin/claude.rejected" ] || fail 'native, another build: quarantined, not executable' "$HOME_DIR/.local/bin/claude.rejected, not executable" "$(ls -l "$HOME_DIR/.local/bin" 2>&1)"
has 'native, another build: the summary says quarantined' "$(cat "$WORK/err")" 'native=2.1.290->pin-mismatch,quarantined'
# The next run finds that native path gone: its record is expired, the npm
# global (2.1.312) is what a runner would start, and nothing wedges.
rm -f "$STATE/native-install-other" "$HOME_DIR/.local/bin/claude.rejected"; : > "$LOG"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'native, quarantined: the next run exits 0' 0 "$got: $(cat "$WORK/err")"
has 'native, quarantined: the record is expired' "$(cat "$WORK/err")" 'the rejected native install is gone'
[ ! -e "$HOME_DIR/.termag/claude-update.rejected" ] || fail 'native, quarantined: the record is gone' absent present
# A native install that keeps its previous version file: the rejected build is
# replaced by a relink to the version that ran, verified; the record stays.
reset; npm_at 2.1.312
V=$HOME_DIR/.local/share/claude/versions; mkdir -p "$V"
cp "$WORK/native-linker" "$V/2.1.290"; ln -sfn "$V/2.1.290" "$HOME_DIR/.local/bin/claude"
echo 2.1.399 > "$STATE/native-install-other"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 3 ] || fail 'native restore: rejected, exits 3' 3 "$got: $(cat "$WORK/err")"
[ "$(readlink -f "$HOME_DIR/.local/bin/claude")" = "$V/2.1.290" ] || fail 'native restore: the link points at the version that ran' "$V/2.1.290" "$(readlink -f "$HOME_DIR/.local/bin/claude")"
has 'native restore: verified' "$(cat "$WORK/err")" 'is back at 2.1.290, verified'
has 'native restore: the summary says restored' "$(cat "$WORK/err")" 'native=2.1.290->pin-mismatch,restored:2.1.290'
grep -q '^native ' "$HOME_DIR/.termag/claude-update.rejected" 2>/dev/null || fail 'native restore: the record stays' 'native ...' "$(cat "$HOME_DIR/.termag/claude-update.rejected" 2>/dev/null)"
rm -rf "$HOME_DIR/.local/bin/claude" "$HOME_DIR/.local/share/claude"
# A native link into node_modules is npm's.
reset; npm_at 2.1.300
mkdir -p "$NPMROOT/@anthropic-ai/claude-code/bin"
cp "$STUB/claude" "$NPMROOT/@anthropic-ai/claude-code/bin/claude.exe"
ln -sfn "$NPMROOT/@anthropic-ai/claude-code/bin/claude.exe" "$HOME_DIR/.local/bin/claude"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'native link: exits 0' 0 "$got"
lacks 'native link: no claude update' "$(cat "$LOG")" 'native update'
has 'native link: npm updates it' "$(cat "$WORK/err")" 'native=link-to-npm'
rm -f "$HOME_DIR/.local/bin/claude"

# ── CLAUDE_BIN is the claude judged ─────────────────────────────────────────
reset; npm_at 2.1.312
echo 2.1.200 > "$STATE/native"
ARGS='--ensure 2.1.308' run CLAUDE_BIN="$WORK/native-claude"; got=$?
[ "$got" = 1 ] || fail 'CLAUDE_BIN below the floor: exits 1' 1 "$got"
lacks 'CLAUDE_BIN: an npm global already past the floor is never reinstalled' "$(cat "$LOG")" 'npm install'
has 'CLAUDE_BIN: judged' "$(cat "$WORK/err")" "claude=$WORK/native-claude version=2.1.200 floor=2.1.308 state=below-floor npm=2.1.312"

# ── no claude at all ────────────────────────────────────────────────────────
reset; rm -f "$PKGJSON"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 1 ] || fail 'no claude: exits 1' 1 "$got"
lacks 'no claude: installs nothing (only where installed)' "$(cat "$LOG")" 'npm install'

# ── --boot, no network ──────────────────────────────────────────────────────
reset; npm_at 2.1.308; : > "$STATE/offline"
ARGS='--boot' run TERMAG_CLAUDE_NETWORK_WAIT=0; got=$?
[ "$got" = 0 ] || fail 'boot offline at the floor: exits 0' 0 "$got"
lacks 'boot offline: installs nothing' "$(cat "$LOG")" 'npm install'
has 'boot offline: asked the registry' "$(cat "$LOG")" 'npm view @anthropic-ai/claude-code@latest version'
has 'boot offline: says so' "$(cat "$WORK/err")" 'no answer from the npm registry within 0s'
npm_at 2.1.300
ARGS='--boot' run TERMAG_CLAUDE_NETWORK_WAIT=0; got=$?
[ "$got" = 1 ] || fail 'boot offline below the floor: exits 1' 1 "$got"
# The registry answers on a later try: the wait is a retry loop, not one probe.
reset; npm_at 2.1.300; : > "$STATE/offline"
( sleep 2; rm -f "$STATE/offline" ) &
ARGS='--boot' run TERMAG_CLAUDE_NETWORK_WAIT=30; got=$?
wait
[ "$got" = 0 ] || fail 'boot: waits for the network, then updates' 0 "$got: $(cat "$WORK/err")"
has 'boot: installs once the registry answers' "$(cat "$LOG")" 'npm install'

# ── --boot, behind npm's latest ─────────────────────────────────────────────
reset; npm_at 2.1.308
ARGS='--boot' run; got=$?
[ "$got" = 0 ] || fail 'boot behind latest: exits 0' 0 "$got"
has 'boot behind latest: installs latest' "$(cat "$LOG")" '@anthropic-ai/claude-code@latest'
has 'boot behind latest: summary' "$(cat "$WORK/err")" 'npm=2.1.308->2.1.312'
# At latest: nothing.
reset; npm_at 2.1.312
ARGS='--boot' run; got=$?
[ "$got" = 0 ] || fail 'boot at latest: exits 0' 0 "$got"
lacks 'boot at latest: installs nothing (no same-version reinstall)' "$(cat "$LOG")" 'npm install'
# Above the floor but behind latest: installs.
reset; npm_at 2.1.310
ARGS='--boot' run; got=$?
[ "$got" = 0 ] || fail 'boot above the floor, behind latest: exits 0' 0 "$got"
has 'boot above the floor, behind latest: installs' "$(cat "$LOG")" 'npm install'
# No floor file: latest only, and 0.
reset; npm_at 2.1.312
ARGS='--boot' run TERMAG_CLAUDE_FLOOR_FILE="$WORK/no-floor"; got=$?
[ "$got" = 0 ] || fail 'boot without a floor file: exits 0' 0 "$got"
has 'boot without a floor file: says so' "$(cat "$WORK/err")" 'no floor in'

# ── latest below the floor: install the floor version ──────────────────────
reset; npm_at 2.1.305; echo 2.1.300 > "$STATE/latest"
ARGS='--boot' run; got=$?
[ "$got" = 0 ] || fail 'boot, latest under the floor: exits 0 at the floor' 0 "$got: $(cat "$WORK/err")"
has 'boot, latest under the floor: installs the floor version' "$(cat "$LOG")" '@anthropic-ai/claude-code@2.1.308'
lacks 'boot, latest under the floor: never installs @latest' "$(cat "$LOG")" 'loglevel=error @anthropic-ai/claude-code@latest'
has 'boot, latest under the floor: summary' "$(cat "$WORK/err")" 'npm=2.1.305->2.1.308'
reset; npm_at 2.1.305; echo 2.1.300 > "$STATE/latest"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'ensure, latest under the floor: exits 0 at the floor' 0 "$got: $(cat "$WORK/err")"
has 'ensure, latest under the floor: installs the floor version' "$(cat "$LOG")" '@anthropic-ai/claude-code@2.1.308'
has 'ensure, latest under the floor: says why' "$(cat "$WORK/err")" 'latest resolves to 2.1.300, below 2.1.308'
has 'ensure, latest under the floor: installs exactly the floor' "$(cat "$WORK/err")" 'installing exactly 2.1.308'
# --ensure without a registry answer installs the floor version, not a tag.
reset; npm_at 2.1.300; : > "$STATE/offline"
ARGS='--ensure 2.1.308' run; got=$?
has 'ensure offline: installs the floor version explicitly' "$(cat "$LOG")" '@anthropic-ai/claude-code@2.1.308'
# Native: straight to claude install <floor>, no claude update on latest's channel.
reset; npm_at 2.1.312; echo 2.1.300 > "$STATE/latest"
mkdir -p "$HOME_DIR/.local/bin"; cp "$WORK/native-claude" "$HOME_DIR/.local/bin/claude"
echo 2.1.290 > "$STATE/native"
ARGS='--ensure 2.1.308' run; got=$?
[ "$got" = 0 ] || fail 'native, latest under the floor: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'native, latest under the floor: claude install 2.1.308' "$(cat "$LOG")" 'native install 2.1.308'
lacks 'native, latest under the floor: no claude update' "$(cat "$LOG")" 'native update'
rm -f "$HOME_DIR/.local/bin/claude"

# ── an install never moves down ─────────────────────────────────────────────
# Devin's case: floor 2.1.308, latest 2.1.300, installed 2.1.305. Installing
# latest would move it to 2.1.300; the floor version moves it up instead. The
# boot case above is this with --boot; here --ensure, and a pinned target.
reset; npm_at 2.1.305; echo 2.1.300 > "$STATE/latest"
ARGS='--ensure 2.1.308' run; got=$?
lacks 'no downgrade: never installs latest (2.1.300) over 2.1.305' "$(cat "$LOG")" 'loglevel=error @anthropic-ai/claude-code@latest'
has 'no downgrade: 2.1.305 goes up to the floor' "$(cat "$WORK/err")" 'npm=2.1.305->2.1.308'
reset; npm_at 2.1.305
ARGS='--ensure 2.1.308' run TERMAG_CLAUDE_TARGET=2.1.300; got=$?
[ "$got" = 0 ] || fail 'no downgrade, pinned target: exits 0' 0 "$got: $(cat "$WORK/err")"
lacks 'no downgrade: never the pinned 2.1.300 over 2.1.305' "$(cat "$LOG")" '@anthropic-ai/claude-code@2.1.300'
has 'no downgrade, pinned target: the floor version' "$(cat "$LOG")" '@anthropic-ai/claude-code@2.1.308'
# Native at 2.1.305 with latest 2.1.300: claude install 2.1.308, never latest.
reset; npm_at 2.1.312; echo 2.1.300 > "$STATE/latest"
mkdir -p "$HOME_DIR/.local/bin"; cp "$WORK/native-claude" "$HOME_DIR/.local/bin/claude"; echo 2.1.305 > "$STATE/native"
ARGS='--boot' run; got=$?
[ "$got" = 0 ] || fail 'no downgrade, native: exits 0' 0 "$got: $(cat "$WORK/err")"
lacks 'no downgrade, native: never claude install latest' "$(cat "$LOG")" 'native install latest'
has 'no downgrade, native: 2.1.305 goes up to the floor' "$(cat "$WORK/err")" 'native=2.1.305->2.1.308'
rm -f "$HOME_DIR/.local/bin/claude"

# ── bad usage ───────────────────────────────────────────────────────────────
for a in '' '--ensure' '--ensure 2.1' '--ensure latest' '--boot extra' '--nope'; do
  ARGS=$a run; got=$?
  [ "$got" = 2 ] || fail "bad usage '$a' exits 2" 2 "$got"
done
ARGS='--boot' run TERMAG_CLAUDE_TARGET='latest;rm'; got=$?
[ "$got" = 2 ] || fail 'a bad target exits 2' 2 "$got"

# ── --run <id>, policy cases (restart none, or no restart allowed: these run
# outside the PID namespace, where a stop would reach the box's real sessions) ──
if command -v jq >/dev/null 2>&1; then
# restart none: the target, exactly, and the report.
run_reset; npm_at 2.1.300; policy 200 none 2.1.320
runrun; got=$?
[ "$got" = 0 ] || fail 'run: exits 0 once updated' 0 "$got: $(cat "$WORK/err")"
has 'run: asks for its policy, component and run in the query' "$(cat "$STATE/curl-calls" 2>/dev/null)" "GET https://orch.example.test/termag/api/tool-update/policy?component=claude&run=$RUN_ID"
has 'run: the token goes on curl stdin' "$(cat "$STATE/curl-config" 2>/dev/null)" 'header = "Authorization: Bearer tmag_box_token"'
has 'run: installs the policy target exactly' "$(cat "$LOG")" 'loglevel=error @anthropic-ai/claude-code@2.1.320'
has 'run: posts the report' "$(cat "$STATE/curl-calls" 2>/dev/null)" 'POST https://orch.example.test/termag/api/tool-update/report'
got=$(report '[.component, .trigger, .run, .outcome, .target, .fromVersion, .toVersion] | join(" ")')
[ "$got" = "claude manual $RUN_ID updated 2.1.320 2.1.300 2.1.320" ] || fail 'run: the report names the run, its outcome and versions' "claude manual $RUN_ID updated 2.1.320 2.1.300 2.1.320" "$got"
got=$(report '.sessions | keys | join(",")')
[ "$got" = 'cut,fresh,other,resumed,runnersLeft,stopped,typed' ] || fail 'run: the report counts sessions with the contract keys' 'cut,fresh,other,resumed,runnersLeft,stopped,typed' "$got"
got=$(report '[.sessions.stopped, .sessions.typed, (.panes | length)] | join(" ")')
[ "$got" = '0 0 0' ] || fail 'run: restart none stops nothing and lists no pane' '0 0 0' "$got"
has 'run: the detail says what happened' "$(report .detail)" 'policy=ok restart=none'
has 'run: the report is logged' "$(cat "$WORK/err")" 'report: posted (updated)'
# The report's trigger: the run's, from the policy (only an allow-listed one),
# else manual. The orchestrator's log line names it; the run's row keeps its own.
for t in nightly floor resume manual; do
  run_reset; npm_at 2.1.300; policy 200 none 2.1.320 5 "$(jq -nc --arg id "$RUN_ID" --arg t "$t" '{id: $id, component: "claude", trigger: $t}')"
  runrun
  [ "$(report .trigger)" = "$t" ] || fail "run: a $t run reports trigger $t" "$t" "$(report .trigger)"
done
run_reset; npm_at 2.1.300; policy 200 none 2.1.320 5 "$(jq -nc --arg id "$RUN_ID" '{id: $id, component: "claude", trigger: "boot\"; rm -rf /"}')"
runrun
[ "$(report .trigger)" = manual ] || fail 'run: a trigger off the allow-list reports manual' manual "$(report .trigger)"
# At the target: nothing installed again, outcome current.
run_reset; npm_at 2.1.320; policy 200 none 2.1.320
runrun; got=$?
lacks 'run, at the target: installs nothing' "$(cat "$LOG")" 'npm install'
[ "$(report .outcome)" = current ] || fail 'run, at the target: outcome current' current "$(report .outcome)"
# A dist-tag target is resolved once and installed as that exact version.
run_reset; npm_at 2.1.300; policy 200 none stable
runrun; got=$?
has 'run, a tag: resolved through npm view' "$(cat "$LOG")" 'npm view @anthropic-ai/claude-code@stable version'
has 'run, a tag: installed as its version' "$(cat "$LOG")" 'loglevel=error @anthropic-ai/claude-code@2.1.312'
lacks 'run, a tag: never the tag itself' "$(cat "$LOG")" 'loglevel=error @anthropic-ai/claude-code@stable'
# A 200 with run null (the flag off, the run expired): the floor and target, restart none.
run_reset; npm_at 2.1.312; policy 200 force 2.1.312 5 null
runrun; got=$?
has 'run null: no restart' "$(cat "$WORK/err")" 'policy for run '"$RUN_ID"': ok-no-run (HTTP 200); floor 2.1.308, target 2.1.312, restart none'
has 'run null: still reported' "$(report .detail)" 'policy=ok-no-run restart=none'
# Refused: the floor file alone, nothing installed above it, nothing restarted, still reported.
run_reset; npm_at 2.1.312; echo 2.1.399 > "$STATE/latest"; policy 403 force
runrun; got=$?
[ "$got" = 0 ] || fail 'refused: exits 0 at the floor' 0 "$got"
lacks 'refused: installs nothing at the floor (floor only)' "$(cat "$LOG")" 'npm install'
has 'refused: says so' "$(cat "$WORK/err")" 'refused:403 (HTTP 403); floor from the floor file, target latest, restart none'
has 'refused: reported with the reason' "$(report .detail)" 'policy=refused:403 restart=none'
[ "$(report .target)" = 2.1.308 ] || fail 'refused, at the floor: the report target is the floor, not latest (Bugbot on #995)' 2.1.308 "$(report .target)"
# The lock held by another run: nothing was installed or restarted, so the run
# is not reported current although the box is at the floor (Bugbot on #995).
run_reset; npm_at 2.1.312; policy 200 none 2.1.320
mkdir -p "$HOME_DIR/.termag"
hold_lock &
holder=$!
sleep 0.3
runrun; got=$?
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
lacks 'run, lock held: installs nothing' "$(cat "$LOG")" 'npm install'
[ "$(report .outcome)" = failed ] || fail 'run, lock held: reported failed, not current' failed "$(report .outcome)"
has 'run, lock held: the detail says why' "$(report .detail)" 'lock=held-by-another-run'
# Refused, below the floor file: brought to exactly the floor, never to npm's
# latest above it (Devin on #995), and no target resolved.
for code in 401 404 000; do
  run_reset; npm_at 2.1.300; echo 2.1.400 > "$STATE/latest"; policy "$code" force
  [ "$code" = 000 ] && : > "$STATE/policy-down"
  runrun; got=$?
  [ "$got" = 0 ] || fail "refused $code, below: exits 0 at the floor" 0 "$got: $(cat "$WORK/err")"
  [ "$(grep -c 'npm install' "$LOG")" = 1 ] || fail "refused $code, below: one install" 1 "$(cat "$LOG")"
  has "refused $code, below: installs the floor version" "$(cat "$LOG")" 'loglevel=error @anthropic-ai/claude-code@2.1.308'
  lacks "refused $code, below: never latest" "$(cat "$LOG")" '@anthropic-ai/claude-code@2.1.400'
  lacks "refused $code, below: no target resolved" "$(cat "$LOG")" 'npm view'
  has "refused $code, below: verified" "$(cat "$WORK/err")" 'npm installed @anthropic-ai/claude-code@2.1.308, verified'
done
run_reset; npm_at 2.1.300; echo 2.1.400 > "$STATE/latest"; policy 401 force
runrun
[ "$(report '[.outcome, .toVersion] | join(" ")')" = 'updated 2.1.308' ] || fail 'refused, below: reports updated to the floor' 'updated 2.1.308' "$(report '[.outcome, .toVersion] | join(" ")')"
# An unreadable 200 is a refusal too.
run_reset; npm_at 2.1.312; printf 200 > "$STATE/policy-code"; printf '{"floor":"latest;rm","restart":"force"}' > "$STATE/policy-body"
runrun; got=$?
has 'unreadable: floor only' "$(report .detail)" 'policy=unreadable restart=none'
# No such run (404): nothing to report to.
run_reset; npm_at 2.1.312; policy 404
runrun; got=$?
lacks 'no such run: no report' "$(cat "$STATE/curl-calls" 2>/dev/null)" 'POST'
has 'no such run: says so' "$(cat "$WORK/err")" "report: not posted: the orchestrator knows no run $RUN_ID"
# No answer: three tries, the floor file, and a report that cannot go either.
run_reset; npm_at 2.1.312; policy 200; : > "$STATE/policy-down"
runrun; got=$?
[ "$(grep -c 'tool-update/policy' "$STATE/curl-calls")" = 3 ] || fail 'unreachable: the policy is asked three times' 3 "$(grep -c 'tool-update/policy' "$STATE/curl-calls")"
has 'unreachable: floor only' "$(cat "$WORK/err")" 'unreachable (HTTP 000)'
# No agent config: the floor only, and no report.
run_reset; npm_at 2.1.312; policy 200
ARGS="--run $RUN_ID" run TERMAG_AGENT_CONFIG="$WORK/no-such-config"; got=$?
has 'no agent config: floor only' "$(cat "$WORK/err")" "policy for run $RUN_ID: no-agent-config"
[ ! -e "$STATE/curl-calls" ] || fail 'no agent config: no call' '(none)' "$(cat "$STATE/curl-calls")"
# Bad usage.
for a in '--run' '--run short' '--run CMVTRUN0000000000000000001' "--run $RUN_ID extra" '--run cmvtrun00000000000000000/1'; do
  ARGS=$a run; got=$?
  [ "$got" = 2 ] || fail "bad usage '$a' exits 2" 2 "$got"
done
else
  echo 'skip: --run cases need jq'
fi

# ── --run's sessions: run in a private PID namespace (see sessions_cases) ──
if ! command -v tmux >/dev/null 2>&1 || ! command -v jq >/dev/null 2>&1; then
  echo 'skip: --run session cases need tmux and jq'
elif ! sudo -n true 2>/dev/null || ! command -v unshare >/dev/null 2>&1 || ! command -v setpriv >/dev/null 2>&1; then
  echo 'skip: --run session cases need sudo -n, unshare and setpriv (a private PID namespace)'
else
  # As this user, in a PID namespace of its own (/proc remounted), so pgrep
  # there sees only the fakes. Unprivileged user namespaces are blocked on
  # the boxes (AppArmor), hence sudo for the unshare alone.
  # shellcheck disable=SC2024 # the output file is this user's, not root's
  sudo -n unshare --pid --fork --mount-proc setpriv --reuid="$(id -u)" --regid="$(id -g)" --init-groups \
    env -i PATH=/usr/bin:/bin HOME="$WORK/ns-home" TMPDIR="${TMPDIR:-/tmp}" bash "$0" --sessions > "$WORK/sessions.out" 2>&1
  rc=$?
  cat "$WORK/sessions.out"
  [ "$rc" = 0 ] || failures=$((failures + 1))
fi

if [ "$failures" -eq 0 ]; then
  echo "ok: termag-claude-update"
else
  echo "$failures failure(s)"
  exit 1
fi
