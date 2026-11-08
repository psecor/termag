#!/bin/sh
# Tests deploy/termag-codex-update, the box's Codex updater,
# on deploy/termag-tool-update-lib, with npm, codex
# and the orchestrator (curl) stubbed on PATH:
#
#   * --run asks for Codex's policy (component=codex) with the agent token on
#     curl's stdin, never in an argument or a log line
#   * restart none installs the policy's exact target into the npm global,
#     only when behind it, and reports: component codex, the versions before
#     and after, the session counts; at the target it installs nothing
#   * a dist-tag target is resolved once (npm view), and that version, never
#     the tag, is installed; a target the policy names below the installed
#     version moves nothing down
#   * an install is accepted only when package.json and codex --version both
#     say the version asked for; otherwise it is rejected (exit 3, recorded),
#     put back to the version that ran (reinstalled and verified), or, when
#     none ran, quarantined (bin/codex.js renamed, not executable); a later
#     verified install clears the record
#   * no policy (refused, unreachable, unreadable, a stable target Codex does
#     not publish) installs nothing and restarts nothing, even below the
#     floor: Codex has no fallback floor; a 404 (no such run) posts no report
#   * a 200 with run null (the flag off since, the run expired) installs
#     nothing and restarts nothing
#   * the lock held by another run: it installs nothing
#   * bad usage, and Claude Code's modes (--ensure, --boot), exit 2
#   * the sessions, in a private PID namespace (sudo -n unshare, so the box's
#     own sessions are out of reach; skipped without sudo or tmux), with fake
#     codexes (copies of bash named codex) in real tmux panes, each holding
#     its rollout open as Codex does: force stops every Codex pane at once and
#     cuts the one in a turn, a session that ignores SIGTERM is SIGKILLed; a
#     pane with a conversation gets `codex resume <id>` typed, one without is
#     left at its shell; an agent pane (a --remote client whose rollout the
#     bridge's app server holds) is listed for the orchestrator with its
#     conversation id and never typed into; the app server, an exec turn, a
#     Codex outside tmux and a Codex on the current binary are left alone, as
#     is a Claude Code pane; idle waits for a turn to end (task_complete) and
#     cuts one still in it at drainSec; a run below the floor stops nothing
#
# Run: sh deploy/termag-codex-update.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-codex-update"
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
command -v jq >/dev/null 2>&1 || { echo 'SKIP: jq is required for this test'; exit 0; }

HOME_DIR="$WORK/home"
STUB="$WORK/stub"
STATE="$WORK/state"
NPMROOT="$WORK/npm/lib/node_modules"
PKGDIR="$NPMROOT/@openai/codex"
PKGJSON="$PKGDIR/package.json"
mkdir -p "$HOME_DIR" "$STUB" "$STATE" "$PKGDIR/bin" "$WORK/npm/bin"
LOG="$WORK/calls"
export LOG STATE NPMROOT PKGJSON

# ── stubs ───────────────────────────────────────────────────────────────────
# npm: `root -g` and `prefix -g` are the scratch prefix; `view` answers
# $STATE/latest; `install -g` writes the package.json of the version asked
# for (or $STATE/install-other(-once)), lays bin/codex.js down again, and
# fails with $STATE/npm-rc.
cat > "$STUB/npm" <<'EOF'
#!/bin/sh
echo "npm $*" >> "$LOG"
case "$1" in
  root) echo "$NPMROOT" ;;
  prefix) echo "${NPMROOT%/lib/node_modules}" ;;
  view) cat "$STATE/latest"; exit 0 ;;
  install)
    rc=$(cat "$STATE/npm-rc" 2>/dev/null || echo 0)
    [ "$rc" = 0 ] || { echo 'npm ERR! boom' >&2; exit "$rc"; }
    for a; do spec=$a; done
    v=${spec##*@}
    [ -s "$STATE/install-other" ] && v=$(cat "$STATE/install-other")
    [ -s "$STATE/install-other-once" ] && { v=$(cat "$STATE/install-other-once"); rm -f "$STATE/install-other-once"; }
    if [ -e "$STATE/tabs" ]; then printf '{\n\t"name": "@openai/codex",\n\t"version": "%s"\n}\n' "$v" > "$PKGJSON"
    else printf '{\n  "name": "@openai/codex",\n  "version": "%s"\n}\n' "$v" > "$PKGJSON"; fi
    rm -f "$STATE/broken"
    [ -e "$STATE/break-on-install" ] && : > "$STATE/broken"
    cp "$STATE/codex.js" "$NPMROOT/@openai/codex/bin/codex.js"; chmod +x "$NPMROOT/@openai/codex/bin/codex.js"
    exit 0 ;;
esac
EOF
# bin/codex.js, the launcher npm links as bin/codex: the version in its
# package.json, as codex-cli prints it.
cat > "$STATE/codex.js" <<'EOF'
#!/bin/sh
[ "$1" = resume ] && exec sleep 300
[ "$1" = --version ] || exit 1
[ -e "$STATE/broken" ] && exit 1
v=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$PKGJSON" 2>/dev/null)
[ -n "$v" ] || exit 1
echo "codex-cli $v"
EOF
chmod +x "$STUB/npm" "$STATE/codex.js"
cp "$STATE/codex.js" "$PKGDIR/bin/codex.js"
ln -s ../lib/node_modules/@openai/codex/bin/codex.js "$WORK/npm/bin/codex"

# curl: GET .../tool-update/policy answers $STATE/policy-code with
# $STATE/policy-body (no answer while $STATE/policy-down exists); POST
# .../tool-update/report records its body in $STATE/report-body and answers
# 204. Every call goes to $STATE/curl-calls with its arguments, and the config
# curl reads on stdin (-K -) to $STATE/curl-config.
cat > "$STUB/curl" <<'EOF'
#!/bin/sh
echo "curl $*" >> "$STATE/curl-args"
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
    printf '%s\n' "$data" > "$STATE/report-body"; : > "$out"; printf 204 ;;
  *) exit 6 ;;
esac
EOF
chmod +x "$STUB/curl"

npm_at() { printf '{\n  "name": "@openai/codex",\n  "version": "%s"\n}\n' "$1" > "$PKGJSON"; }
RUN_ID=cmvtrun0000000000000000002
printf '{"token":"tmag_box_token","termag_url":"wss://orch.example.test/termag/ws/agent"}\n' > "$WORK/agent.config.json"
policy() {  # policy CODE [RESTART [TARGET [DRAIN [RUN [FLOOR]]]]]
  printf '%s' "$1" > "$STATE/policy-code"
  printf '{"floor":"%s","target":"%s","restart":"%s","drainSec":%s,"run":%s}' \
    "${6:-0.131.0}" "${3:-0.166.0}" "${2:-none}" "${4:-5}" "${5:-{\"id\":\"$RUN_ID\",\"component\":\"codex\"\}}" > "$STATE/policy-body"
}
reset() {
  : > "$LOG"
  rm -f "$STATE/npm-rc" "$STATE/broken" "$STATE/break-on-install" "$STATE/install-other" "$STATE/install-other-once" \
    "$STATE/curl-calls" "$STATE/curl-args" "$STATE/curl-config" "$STATE/report-body" "$STATE/policy-down" \
    "$HOME_DIR/.termag/codex-update.rejected" "$PKGDIR/bin/codex.js.rejected"
  echo 0.166.0 > "$STATE/latest"
  cp "$STATE/codex.js" "$PKGDIR/bin/codex.js"; chmod +x "$PKGDIR/bin/codex.js"
}
run() {
  env -i PATH="$STUB:$WORK/npm/bin:/usr/bin:/bin" HOME="$HOME_DIR" NVM_DIR="$WORK/no-nvm" LOG="$LOG" STATE="$STATE" \
    NPMROOT="$NPMROOT" PKGJSON="$PKGJSON" TERMAG_CODEX_RETRY_SLEEP=0 TERMAG_CODEX_LOCK_WAIT=1 \
    TERMAG_AGENT_CONFIG="$WORK/agent.config.json" "$@" bash "$SCRIPT" ${ARGS:---run $RUN_ID} 2>"${ERRF:-$WORK/err}"
}
report() { jq -r "$1" "$STATE/report-body" 2>/dev/null; }

# ── the sessions, in a private PID namespace ────────────────────────────────
# Fake codexes are copies of bash named codex (the script tells a Codex by
# /proc/<pid>/exe), so none is the current binary, unless started from the
# package's own vendor binary. Each holds its rollout open (fd 3) as Codex
# does; a line of task_started or task_complete is a turn's start or end.
sessions_cases() {
  [ "$$" = 1 ] || { echo 'FAIL: the session cases run only as PID 1 of their own PID namespace'; exit 1; }
  OLD="$WORK/old"; mkdir -p "$OLD" "$WORK/claude-old"
  cp "$(command -v bash)" "$OLD/codex"
  cp "$(command -v bash)" "$WORK/claude-old/claude"
  # The package's current native binary: a session on it is not stopped.
  VENDOR="$PKGDIR/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin"
  mkdir -p "$VENDOR"; cp "$(command -v bash)" "$VENDOR/codex"
  # The same build hoisted beside the package, as npm can lay it out (Bugbot on #1076).
  HOISTED="$NPMROOT/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin"
  mkdir -p "$HOISTED"; cp "$(command -v bash)" "$HOISTED/codex"
  # fake-codex.sh: ROLL (the rollout to hold open), STUBBORN=1 (ignores SIGTERM), SUB=1 (a sub-codex).
  cat > "$WORK/fake-codex.sh" <<'EOF'
[ -n "${ROLL:-}" ] && exec 3>>"$ROLL"
sub=
[ -n "${SUB:-}" ] && { "$BASH" -c 'while :; do sleep 0.2; done' & sub=$!; }
if [ -n "${STUBBORN:-}" ]; then trap '' TERM; else trap '[ -n "$sub" ] && kill "$sub"; exit 0' TERM; fi
# SLOW=1: takes 3 s to exit after its SIGTERM.
[ -n "${SLOW:-}" ] && trap 'sleep 3; exit 0' TERM
while :; do sleep 0.2; done
EOF
  # A file named for the subcommand, so `codex app-server --listen <url>`
  # and `codex exec` run (bash reads them as scripts) with that argv.
  mkdir -p "$WORK/sub"
  cp "$WORK/fake-codex.sh" "$WORK/sub/app-server"
  cp "$WORK/fake-codex.sh" "$WORK/sub/exec"
  S="$WORK/tmux.sock"
  uuid() { printf '019a%04d-1111-7222-8333-444444444444' "$1"; }
  # rollout ID STATE...: a rollout file with these events, as Codex writes them.
  rollout() {
    id=$1; shift
    f="$HOME_DIR/.codex/sessions/2026/10/30/rollout-2026-10-30T11-15-45-$id.jsonl"
    mkdir -p "${f%/*}"
    printf '{"timestamp":"t","type":"session_meta","payload":{"id":"%s","cwd":"/w"}}\n' "$id" > "$f"
    for e; do printf '{"timestamp":"t","type":"event_msg","payload":{"type":"%s"}}\n' "$e" >> "$f"; done
    printf '%s' "$f"
  }
  # pane NAME ENV...: a tmux session whose shell runs a fake codex.
  pane() {
    n=$1; shift
    mkdir -p "$WORK/cwd/$n"
    tmux -S "$S" -f /dev/null new-session -d -s "$n" -c "$WORK/cwd/$n" -x 200 -y 50 "env PATH=$STUB:$WORK/npm/bin:/usr/bin:/bin HOME=$HOME_DIR bash --norc --noprofile"
    tmux -S "$S" send-keys -t "$n" -l -- "env $* HOME=$HOME_DIR ${BIN:-$OLD/codex} $WORK/fake-codex.sh ${PARGS:-}"
    tmux -S "$S" send-keys -t "$n" Enter
  }
  bg() { ( "$@" </dev/null >/dev/null 2>&1 & echo "$!" ); }
  pid_in() { for _ in $(seq 1 50); do p=$(tmux -S "$S" list-panes -t "$1" -F '#{pane_pid}' 2>/dev/null); c=$(pgrep -P "$p" 2>/dev/null | head -n 1); [ -n "$c" ] && { echo "$c"; return; }; sleep 0.1; done; }
  setup() {
    rm -rf "$HOME_DIR/.codex" "$WORK/cwd"
    tmux -S "$S" kill-server 2>/dev/null
    reset; npm_at 0.166.0
  }
  teardown() { tmux -S "$S" kill-server 2>/dev/null; for p in $(pgrep -f "$OLD/codex") $(pgrep -f "$WORK/py/codex") $(pgrep -f "$VENDOR/codex") $(pgrep -f "$WORK/claude-old/claude") $(pgrep -f "$WORK/pi-old/pi") $(pgrep -f "$WORK/node-old/node"); do kill -KILL "$p" 2>/dev/null; done; sleep 0.3; }
  pane_text() { tmux -S "$S" capture-pane -p -t "$1" 2>/dev/null; }
  pane_cmd() { tmux -S "$S" display -p -t "$1" '#{pane_current_command}' 2>/dev/null; }
  is_running() { kill -0 "$1" 2>/dev/null && [ "$(sed -E 's/^.*\) ([A-Za-z]) .*$/\1/' "/proc/$1/stat")" != Z ]; }
  runs() { run TERMAG_CODEX_KILL_AFTER=2 TERMAG_CODEX_RESUME_WAIT=2 TERMAG_POLICY_TIMEOUT=5; }

  # force: every Codex pane at once.
  setup
  r1=$(rollout "$(uuid 1)" task_started task_complete)
  pane work ROLL="$r1" SUB=1
  r2=$(rollout "$(uuid 2)" task_started)               # in a turn
  pane busy ROLL="$r2"
  pane scratch                                         # no rollout: never used
  r6=$(rollout "$(uuid 6)")                            # a rollout with no turn: no conversation
  pane stubborn ROLL="$r6" STUBBORN=1
  # A termag agent pane: a --remote client; the bridge's app server holds its rollout.
  r3=$(rollout "$(uuid 3)" task_started task_complete)
  server=$( (cd "$WORK/sub" && ROLL="$r3" bg "$OLD/codex" app-server --listen ws://127.0.0.1:47999) )
  PARGS='--remote ws://127.0.0.1:47999 --no-alt-screen -a on-request' pane alice-proj-agent
  PARGS='--remote ws://127.0.0.1:47998' pane alice-proj-ws-agent   # its server holds no rollout
  exec_turn=$( (cd "$WORK/sub" && bg "$OLD/codex" exec 'a turn') )
  # Non-TUI subcommands behind flags, in a pane: still other. A copy of
  # python named codex takes any argv: `-c <code>` reads as Codex's
  # `-c key=value`, the code keeps it up.
  PY="$WORK/py/codex"; mkdir -p "$WORK/py"; cp "$(readlink -f "$(command -v python3)")" "$PY"
  KEEP='import time; time.sleep(300)'
  tmux -S "$S" -f /dev/null new-session -d -s flagged-exec -c "$WORK/cwd" "env PATH=$STUB:/usr/bin:/bin bash --norc --noprofile"
  tmux -S "$S" send-keys -t flagged-exec -l -- "$PY -c '$KEEP' exec 'a turn'"; tmux -S "$S" send-keys -t flagged-exec Enter
  tmux -S "$S" -f /dev/null new-session -d -s review-pane -c "$WORK/cwd" "env PATH=$STUB:/usr/bin:/bin bash --norc --noprofile"
  tmux -S "$S" send-keys -t review-pane -l -- "$PY -c '$KEEP' --full-auto review"; tmux -S "$S" send-keys -t review-pane Enter
  # Through the node launcher, as PATH starts it (a copy of bash named node
  # running bin/codex.js by a link, which forwards to its native child).
  mkdir -p "$WORK/node-old" "$WORK/l/@openai/codex/bin" "$WORK/lbin"; cp "$(command -v bash)" "$WORK/node-old/node"
  printf '"%s" "%s" & c=$!\ntrap '"'"'kill $c'"'"' TERM\nwait $c\n' "$OLD/codex" "$WORK/fake-codex.sh" > "$WORK/l/@openai/codex/bin/codex.js"
  ln -sf "$WORK/l/@openai/codex/bin/codex.js" "$WORK/lbin/codex"
  tmux -S "$S" -f /dev/null new-session -d -s launched -c "$WORK/cwd" "env PATH=$STUB:$WORK/npm/bin:/usr/bin:/bin bash --norc --noprofile"
  tmux -S "$S" send-keys -t launched -l -- "$WORK/node-old/node $WORK/lbin/codex"; tmux -S "$S" send-keys -t launched Enter
  # A Codex another pane agent runs (here a copy of bash named pi): its, too.
  mkdir -p "$WORK/pi-old"; cp "$(command -v bash)" "$WORK/pi-old/pi"
  tmux -S "$S" -f /dev/null new-session -d -s pi-tool -c "$WORK/cwd" "env PATH=$STUB:/usr/bin:/bin bash --norc --noprofile"
  tmux -S "$S" send-keys -t pi-tool -l -- "$WORK/pi-old/pi -c '$OLD/codex $WORK/fake-codex.sh; :'"; tmux -S "$S" send-keys -t pi-tool Enter
  # A Codex a Claude Code session's tool call runs, in its pane: the other agent's.
  tmux -S "$S" -f /dev/null new-session -d -s claude-tool -c "$WORK/cwd" "env PATH=$STUB:/usr/bin:/bin bash --norc --noprofile"
  tmux -S "$S" send-keys -t claude-tool -l -- "$WORK/claude-old/claude -c '$OLD/codex $WORK/fake-codex.sh; :'"; tmux -S "$S" send-keys -t claude-tool Enter
  outside=$(bg "$OLD/codex" "$WORK/fake-codex.sh")
  BIN="$VENDOR/codex" pane current
  BIN="$HOISTED/codex" pane hoisted
  BIN="$WORK/claude-old/claude" pane claude-pane
  sleep 1
  stub_pid=$(pid_in stubborn) current_pid=$(pid_in current) hoisted_pid=$(pid_in hoisted) claude_pid=$(pid_in claude-pane)
  flagged_pid=$(pgrep -f "$PY -c .* exec" | head -n 1) review_pid=$(pgrep -f "$PY -c .* --full-auto review" | head -n 1)
  pi_pid=$(pgrep -f "^$OLD/codex $WORK/fake-codex.sh\$" | while read -r p; do pp=$(ps -o ppid= -p "$p" | tr -d ' '); [ "$(readlink "/proc/$pp/exe")" = "$WORK/pi-old/pi" ] && echo "$p"; done | head -n 1)
  tool_pid=$(pgrep -f "^$OLD/codex $WORK/fake-codex.sh\$" | while read -r p; do pp=$(ps -o ppid= -p "$p" | tr -d ' '); [ "$(readlink "/proc/$pp/exe")" = "$WORK/claude-old/claude" ] && echo "$p"; done | head -n 1)
  policy 200 force 0.166.0 30
  t0=$(date +%s)
  runs; got=$?
  took=$(( $(date +%s) - t0 ))
  [ "$got" = 0 ] || fail 'force: exits 0' 0 "$got: $(tail -5 "$WORK/err")"
  [ "$took" -lt 30 ] || fail 'force: does not wait for drainSec' '< 30 s' "${took}s"
  got=$(report '[.sessions.stopped, .sessions.cut, .sessions.typed, .sessions.resumed, .sessions.fresh, .sessions.other, .sessions.runnersLeft] | join(" ")')
  [ "$got" = '7 1 2 2 3 7 0' ] || fail 'force: stopped cut typed resumed fresh other runnersLeft' '7 1 2 2 3 7 0' "$got; $(report .detail)"
  [ "$(report .component)" = codex ] || fail 'force: the report is Codex'"'"'s' codex "$(report .component)"
  got=$(report '[.panes[] | "\(.session):\(.role):\(.hadConversation):\(.sessionId // "-")"] | sort | join(" ")')
  want="alice-proj-agent:agent:true:$(uuid 3) alice-proj-ws-agent:agent:false:- busy:other:true:$(uuid 2) launched:other:false:- scratch:other:false:- stubborn:other:false:$(uuid 6) work:other:true:$(uuid 1)"
  [ "$got" = "$want" ] || fail 'force: every stopped pane listed, with its conversation' "$want" "$got"
  has 'force: a pane with a conversation gets codex resume typed' "$(pane_text work)" "codex resume $(uuid 1)"
  has 'force: the cut one too' "$(pane_text busy)" "codex resume $(uuid 2)"
  for n in scratch stubborn alice-proj-agent alice-proj-ws-agent launched; do
    lacks "force: nothing typed into $n" "$(pane_text "$n")" 'codex resume'
    [ "$(pane_cmd "$n")" = bash ] || fail "force: $n is left at its shell" bash "$(pane_cmd "$n")"
  done
  is_running "$stub_pid" && fail 'force: a session that ignores SIGTERM is SIGKILLed' killed alive
  has 'force: and the detail says so' "$(report .detail)" 'killed=1'
  is_running "$server" || fail 'force: the bridge'"'"'s app server is left to the relaunch' alive gone
  is_running "$exec_turn" || fail 'force: an exec turn is left alone' alive gone
  is_running "$outside" || fail 'force: a Codex outside tmux is left alone' alive gone
  is_running "$current_pid" || fail 'force: a Codex on the current binary is left alone' alive gone
  is_running "$hoisted_pid" || fail 'force: a Codex on a current binary hoisted beside the package is left alone' alive gone
  is_running "$claude_pid" || fail 'force: a Claude Code pane is left alone' alive gone
  [ -n "$flagged_pid" ] && is_running "$flagged_pid" || fail 'force: an exec behind flags, in a pane, is left alone' alive "gone ($flagged_pid)"
  [ -n "$review_pid" ] && is_running "$review_pid" || fail 'force: a review in a pane is left alone' alive "gone ($review_pid)"
  [ -n "$pi_pid" ] && is_running "$pi_pid" || fail 'force: a Codex another pane agent (pi) runs is left alone' alive "gone ($pi_pid)"
  [ -n "$tool_pid" ] && is_running "$tool_pid" || fail 'force: a Codex a Claude Code session runs is left alone' alive "gone ($tool_pid)"
  [ "$(pgrep -fc "$OLD/codex -c while")" = 0 ] || fail 'force: the sub-codex went with its parent' 0 "$(pgrep -fc "$OLD/codex -c while")"
  teardown

  # idle: a session in a turn waits for its task_complete, then stops.
  setup
  rb=$(rollout "$(uuid 11)" task_started task_complete task_started)
  pane busy ROLL="$rb"
  pane quiet
  sleep 1
  busy_pid=$(pid_in busy) quiet_pid=$(pid_in quiet)
  policy 200 idle 0.166.0 60
  t0=$(date +%s)
  runs & rp=$!
  sleep 4
  is_running "$quiet_pid" && fail 'idle: a session out of a turn is stopped at once' stopped alive
  is_running "$busy_pid" || fail 'idle: a session in a turn is not stopped' alive stopped
  printf '{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete"}}\n' >> "$rb"
  wait "$rp"; got=$?
  took=$(( $(date +%s) - t0 ))
  [ "$got" = 0 ] || fail 'idle: exits 0' 0 "$got"
  is_running "$busy_pid" && fail 'idle: stopped once its turn ended' stopped alive
  [ "$took" -lt 30 ] || fail 'idle: does not wait out drainSec once every session is idle' '< 30 s' "${took}s"
  got=$(report '[.sessions.stopped, .sessions.cut, .sessions.typed, .sessions.fresh] | join(" ")')
  [ "$got" = '2 0 1 1' ] || fail 'idle: stopped cut typed fresh' '2 0 1 1' "$got; $(report .detail)"
  has 'idle: resumed by id' "$(pane_text busy)" "codex resume $(uuid 11)"
  teardown

  # idle: still in a turn at drainSec, cut; a turn aborted is out of it.
  setup; npm_at 0.163.0
  rs=$(rollout "$(uuid 21)" task_started)
  pane stuck ROLL="$rs"
  ra=$(rollout "$(uuid 22)" task_started turn_aborted)
  pane aborted ROLL="$ra"
  sleep 1
  policy 200 idle 0.166.0 3
  runs
  got=$(report '[.outcome, .sessions.stopped, .sessions.cut, .fromVersion, .toVersion] | join(" ")')
  [ "$got" = 'updated 2 1 0.163.0 0.166.0' ] || fail 'idle cut: outcome stopped cut from to' 'updated 2 1 0.163.0 0.166.0' "$got; $(report .detail)"
  teardown

  # A signal while a stopped pane is still going (Bugbot on #995): the report
  # lists it, so the orchestrator relaunches it.
  setup
  rs=$(rollout "$(uuid 51)" task_started task_complete)
  pane alice-proj-agent ROLL="$rs" STUBBORN=1
  sleep 1
  policy 200 force 0.166.0 0
  run TERMAG_CODEX_KILL_AFTER=30 TERMAG_POLICY_TIMEOUT=5 & rp=$!
  sleep 4
  kill -TERM "$(pgrep -f "termag-codex-update --run $RUN_ID")"; wait "$rp"; got=$?
  [ "$got" = 143 ] || fail 'signal: exits 143' 143 "$got"
  [ "$(report .outcome)" = failed ] || fail 'signal: reports failed' failed "$(report .outcome)"
  got=$(report '[.panes[] | "\(.session):\(.role):\(.sessionId // "-")"] | join(" ")')
  [ "$got" = "alice-proj-agent:agent:$(uuid 51)" ] || fail 'signal: the pane it had stopped is listed' "alice-proj-agent:agent:$(uuid 51)" "$got"
  teardown

  # Below the floor (an install that fails): nothing is stopped.
  setup; npm_at 0.120.0
  pane keep
  sleep 1; keep_pid=$(pid_in keep)
  echo 1 > "$STATE/npm-rc"
  policy 200 force 0.166.0 0
  runs; got=$?
  [ "$got" = 1 ] || fail 'below the floor: exits 1' 1 "$got"
  is_running "$keep_pid" || fail 'below the floor: nothing is stopped' alive stopped
  has 'below the floor: says why nothing restarted' "$(report .detail)" 'restart=none(codex below-floor)'
  teardown

  # --sessions (a Node update run): no policy,
  # no install, no report. The Codex panes on an old binary are stopped as
  # restart says, each shell gets the new default's bin first on its PATH
  # before its resume, and the result is one JSON line on stdout; a Claude
  # Code pane is left alone, and a busy turn waits under idle.
  setup
  rw=$(rollout "$(uuid 71)" task_started task_complete)
  pane work ROLL="$rw"
  rb=$(rollout "$(uuid 72)" task_started)
  pane busy ROLL="$rb"
  r3=$(rollout "$(uuid 73)" task_started task_complete)
  pane alice-proj-agent ROLL="$r3"
  BIN="$WORK/claude-old/claude" pane claude-pane
  sleep 1
  busy_pid=$(pid_in busy) claude_pid=$(pid_in claude-pane)
  ARGS='--sessions idle 30' run TERMAG_CODEX_KILL_AFTER=2 TERMAG_CODEX_RESUME_WAIT=2 > "$WORK/sessions.json" & rp=$!
  sleep 4
  is_running "$busy_pid" || fail '--sessions idle: a session in a turn is not stopped' alive stopped
  printf '{"timestamp":"t","type":"event_msg","payload":{"type":"task_complete"}}\n' >> "$rb"
  wait "$rp"; got=$?
  [ "$got" = 0 ] || fail '--sessions: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
  out=$(tail -n 1 "$WORK/sessions.json")
  got=$(printf '%s' "$out" | jq -r '[.component, .restart, .sessions.stopped, .sessions.cut, .sessions.typed, .sessions.resumed, .sessions.other] | join(" ")')
  [ "$got" = 'codex idle 3 0 2 2 0' ] || fail '--sessions: component restart stopped cut typed resumed other' 'codex idle 3 0 2 2 0' "$got; $(tail -3 "$WORK/err")"
  got=$(printf '%s' "$out" | jq -r '[.panes[] | "\(.session):\(.role):\(.sessionId // "-")"] | sort | join(" ")')
  want="alice-proj-agent:agent:$(uuid 73) busy:other:$(uuid 72) work:other:$(uuid 71)"
  [ "$got" = "$want" ] || fail '--sessions: the stopped panes, for the caller'"'"'s report' "$want" "$got"
  has '--sessions: the new PATH, then the resume' "$(pane_text work)" "export PATH=$WORK/npm/bin:\"\$PATH\"; codex resume $(uuid 71)"
  has '--sessions: an agent pane gets the new PATH for its relaunch' "$(pane_text alice-proj-agent)" "export PATH=$WORK/npm/bin:"
  lacks '--sessions: and nothing more' "$(pane_text alice-proj-agent)" 'codex resume'
  is_running "$claude_pid" || fail '--sessions: a Claude Code pane is left alone' alive gone
  [ ! -e "$STATE/curl-calls" ] || fail '--sessions: no policy, no report' 'no orchestrator call' "$(cat "$STATE/curl-calls")"
  lacks '--sessions: installs nothing' "$(cat "$LOG")" 'npm install'
  teardown

  # --sessions stopped by a signal while a session is still going: the JSON
  # lists it, and its pane gets the new PATH once its shell is back, for the
  # orchestrator's relaunch (Bugbot on #1166).
  setup
  rs=$(rollout "$(uuid 81)" task_started task_complete)
  pane alice-proj-agent ROLL="$rs" SLOW=1
  sleep 1
  ARGS='--sessions force 0' run TERMAG_CODEX_KILL_AFTER=30 > "$WORK/sessions.json" & rp=$!
  sleep 1.5
  kill -TERM "$(pgrep -f 'termag-codex-update --sessions force 0')"; wait "$rp"; got=$?
  [ "$got" = 143 ] || fail '--sessions signal: exits 143' 143 "$got"
  got=$(tail -n 1 "$WORK/sessions.json" | jq -r '[.restart, ([.panes[] | "\(.session):\(.role)"] | join(" "))] | join(" ")')
  [ "$got" = 'force(stopped by a signal) alice-proj-agent:agent' ] || fail '--sessions signal: the pane it had stopped is listed' 'force(stopped by a signal) alice-proj-agent:agent' "$got"
  has '--sessions signal: and gets the new PATH' "$(pane_text alice-proj-agent)" "export PATH=$WORK/npm/bin:"
  teardown

  # --sessions none: nothing is stopped.
  setup
  pane keep
  sleep 1; keep_pid=$(pid_in keep)
  out=$(ARGS='--sessions none 0' run | tail -n 1)
  is_running "$keep_pid" || fail '--sessions none: nothing is stopped' alive stopped
  got=$(printf '%s' "$out" | jq -r '[.restart, .sessions.stopped] | join(" ")')
  [ "$got" = 'none 0' ] || fail '--sessions none: says so' 'none 0' "$got"
  teardown
}
if [ "${1:-}" = --sessions ]; then
  sessions_cases
  if [ "$failures" -eq 0 ]; then echo 'ok: termag-codex-update --run sessions (PID namespace)'; exit 0; fi
  echo "$failures failure(s) in the session cases"; exit 1
fi

# ── restart none: the exact target, reported ────────────────────────────────
reset; npm_at 0.163.0; policy 200 none 0.166.0
run; got=$?
[ "$got" = 0 ] || fail 'target: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'target: asks for Codex'"'"'s policy for its run' "$(cat "$STATE/curl-calls")" "GET https://orch.example.test/termag/api/tool-update/policy?component=codex&run=$RUN_ID"
has 'target: the token goes on curl'"'"'s stdin' "$(cat "$STATE/curl-config")" 'Authorization: Bearer tmag_box_token'
lacks 'target: never in an argument' "$(cat "$STATE/curl-args")" 'tmag_box_token'
lacks 'target: never in a log line' "$(cat "$WORK/err")" 'tmag_box_token'
has 'target: installs exactly the target' "$(cat "$LOG")" 'npm install -g --no-fund --no-audit --loglevel=error @openai/codex@0.166.0'
has 'target: verified by package.json and codex --version' "$(cat "$WORK/err")" 'npm installed @openai/codex@0.166.0, verified (package.json and codex --version)'
has 'target: the summary' "$(cat "$WORK/err")" "codex=$WORK/npm/bin/codex version=0.166.0 floor=0.131.0 state=ok npm=0.163.0->0.166.0"
got=$(report '[.component, .trigger, .run, .outcome, .target, .fromVersion, .toVersion, (.sessions | [.stopped, .resumed, .fresh, .cut, .typed, .other, .runnersLeft] | join(",")), (.panes | length)] | join(" ")')
[ "$got" = "codex manual $RUN_ID updated 0.166.0 0.163.0 0.166.0 0,0,0,0,0,0,0 0" ] || fail 'target: the report body' "codex manual $RUN_ID updated 0.166.0 0.163.0 0.166.0 0,0,0,0,0,0,0 0" "$got"
has 'target: the detail says restart none' "$(report .detail)" 'policy=ok restart=none'
[ -f "$HOME_DIR/.termag/codex-update.lock" ] || fail 'target: the lock is Codex'"'"'s own, under ~/.termag' present absent
[ ! -e "$HOME_DIR/.termag/claude-update.lock" ] || fail 'target: never Claude Code'"'"'s lock' absent present

# A tab-indented package.json (as pi's is) is read too: the install is verified.
reset; npm_at 0.163.0; policy 200 none 0.166.0
printf '{\n\t"name": "@openai/codex",\n\t"version": "0.163.0"\n}\n' > "$PKGJSON"; : > "$STATE/tabs"
run; got=$?
rm -f "$STATE/tabs"
[ "$got" = 0 ] || fail 'tabs: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
has 'tabs: verified' "$(cat "$WORK/err")" 'npm installed @openai/codex@0.166.0, verified'

# At the target: nothing installed, current.
reset; npm_at 0.166.0; policy 200 none 0.166.0
run; got=$?
[ "$got" = 0 ] || fail 'current: exits 0' 0 "$got"
lacks 'current: installs nothing' "$(cat "$LOG")" 'npm install'
[ "$(report .outcome)" = current ] || fail 'current: outcome current' current "$(report .outcome)"
# A target below what is installed moves nothing down.
reset; npm_at 0.170.0; policy 200 none 0.166.0
run
lacks 'no downgrade: installs nothing' "$(cat "$LOG")" 'npm install'

# ── latest: resolved once, never installed as a tag ─────────────────────────
reset; npm_at 0.163.0; policy 200 none latest
run; got=$?
[ "$got" = 0 ] || fail 'latest: exits 0' 0 "$got: $(cat "$WORK/err")"
[ "$(grep -c 'npm view @openai/codex@latest version' "$LOG")" = 1 ] || fail 'latest: asks npm once' 1 "$(grep -c 'npm view' "$LOG")"
has 'latest: installs what it resolved to' "$(cat "$LOG")" '@openai/codex@0.166.0'
lacks 'latest: never the tag' "$(cat "$LOG")" 'loglevel=error @openai/codex@latest'
[ "$(report .target)" = 0.166.0 ] || fail 'latest: the report names the version' 0.166.0 "$(report .target)"

# ── rejected, restored, quarantined ─────────────────────────────────────────
# npm installs another version than asked: rejected, then the version that ran is put back.
reset; npm_at 0.163.0; echo 0.199.0 > "$STATE/install-other-once"; policy 200 none 0.166.0
run; got=$?
[ "$got" = 3 ] || fail 'other version: rejected, exits 3' 3 "$got"
has 'other version: says what it got' "$(cat "$WORK/err")" 'asked for 0.166.0; package.json says 0.199.0'
has 'restore: reinstalls the version that ran' "$(cat "$LOG")" '@openai/codex@0.163.0'
has 'restore: verified' "$(cat "$WORK/err")" 'npm global @openai/codex is back at 0.163.0, verified'
[ "$("$WORK/npm/bin/codex" --version)" = 'codex-cli 0.163.0' ] || fail 'restore: codex is the version that ran' 'codex-cli 0.163.0' "$("$WORK/npm/bin/codex" --version 2>&1)"
grep -q '^npm ' "$HOME_DIR/.termag/codex-update.rejected" 2>/dev/null || fail 'restore: the record stays' 'npm ...' "$(cat "$HOME_DIR/.termag/codex-update.rejected" 2>/dev/null)"
[ "$(report .outcome)" = failed ] || fail 'restore: reported failed' failed "$(report .outcome)"
# The next run reinstalls and verifies, and clears the record.
: > "$LOG"; rm -f "$STATE/report-body"
run; got=$?
[ "$got" = 0 ] || fail 'rejected, then verified: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'rejected, then verified: reinstalled' "$(cat "$LOG")" '@openai/codex@0.166.0'
[ ! -e "$HOME_DIR/.termag/codex-update.rejected" ] || fail 'rejected, then verified: the record is gone' absent present
# No version that ran: the new launcher is quarantined.
reset; npm_at 0.163.0; : > "$STATE/broken"; echo 0.199.0 > "$STATE/install-other"; policy 200 none 0.166.0
run; got=$?
[ "$got" = 3 ] || fail 'quarantine: rejected, exits 3' 3 "$got"
[ ! -e "$PKGDIR/bin/codex.js" ] || fail 'quarantine: the rejected launcher is not left in place' 'moved away' present
[ -e "$PKGDIR/bin/codex.js.rejected" ] && [ ! -x "$PKGDIR/bin/codex.js.rejected" ] || fail 'quarantine: renamed, not executable' 'codex.js.rejected, not executable' "$(ls -l "$PKGDIR/bin" 2>&1)"
[ ! -x "$WORK/npm/bin/codex" ] || fail 'quarantine: nothing resolves codex to it' 'a dangling link' 'runs'
has 'quarantine: the summary says so' "$(cat "$WORK/err")" 'pin-mismatch,quarantined'
# A binary that does not run after a clean npm exit: rejected too.
reset; npm_at 0.163.0; : > "$STATE/break-on-install"; policy 200 none 0.166.0
run; got=$?
[ "$got" = 3 ] || fail 'binary does not run: rejected' 3 "$got"
has 'binary does not run: says so' "$(cat "$WORK/err")" 'codex --version says nothing (does not run)'
# npm fails outright: failed, retried once, nothing rejected.
reset; npm_at 0.163.0; echo 1 > "$STATE/npm-rc"; policy 200 none 0.166.0
run; got=$?
[ "$got" = 0 ] || fail 'npm failure: still at the floor, exits 0' 0 "$got"
[ "$(grep -c 'npm install' "$LOG")" = 2 ] || fail 'npm failure: one retry' 2 "$(grep -c 'npm install' "$LOG")"
has 'npm failure: says FAILED' "$(cat "$WORK/err")" 'npm=0.163.0->FAILED'
[ "$(report .outcome)" = failed ] || fail 'npm failure: reported failed' failed "$(report .outcome)"

# Not in the npm global (an empty global, or a new nvm prefix): an update,
# not an install, so nothing is installed, and the run fails with the reason
# instead of reading current (Bugbot on #1076).
reset; mv "$PKGJSON" "$WORK/pkgjson.aside"; policy 200 idle 0.166.0
# A codex that still runs from elsewhere (a new nvm prefix): the run is not
# below the floor, and still restarts nothing, since nothing was installed.
printf '#!/bin/sh\necho "codex-cli 0.163.0"\n' > "$WORK/other-codex"; chmod +x "$WORK/other-codex"
run CODEX_BIN="$WORK/other-codex"; got=$?
mv "$WORK/pkgjson.aside" "$PKGJSON"
lacks 'not in the npm global: installs nothing' "$(cat "$LOG")" 'npm install'
has 'not in the npm global: says so' "$(cat "$WORK/err")" '@openai/codex is not in the npm global'
[ "$(report .outcome)" = failed ] || fail 'not in the npm global: reported failed, never current' failed "$(report .outcome)"
has 'not in the npm global: the detail says why' "$(report .detail)" 'npm=none->FAILED:not-in-npm-global'
# Nothing installed: no session is restarted onto the binary it already ran (Bugbot on #1076).
has 'not in the npm global: restarts nothing' "$(report .detail)" 'restart=none(nothing installed)'

# latest does not resolve (npm answers nothing): above the floor, the run did
# not reach its target, so it is failed, never current (Bugbot on #1110).
reset; npm_at 0.163.0; : > "$STATE/latest"; policy 200 idle latest
run TERMAG_CODEX_RETRY_SLEEP=0; got=$?
echo 0.166.0 > "$STATE/latest"
lacks 'latest unresolved: installs nothing' "$(cat "$LOG")" 'npm install'
[ "$(report .outcome)" = failed ] || fail 'latest unresolved: reported failed, never current' failed "$(report .outcome)"
has 'latest unresolved: restarts nothing' "$(report .detail)" 'restart=none(target unresolved)'

# No npm at all: failed, and nothing restarted (Bugbot on #1076). Only where
# the recipe's own PATH (it appends /usr/local/bin, /usr/bin and /bin) finds
# no system npm: CI runners have one in /usr/local/bin.
if [ -x /usr/local/bin/npm ] || [ -x /usr/bin/npm ] || [ -x /bin/npm ]; then
  echo 'skip: no npm case (this host has a system npm the recipe would find)'
else
  reset; npm_at 0.163.0; policy 200 idle 0.166.0; mv "$STUB/npm" "$WORK/npm.aside"
  run CODEX_BIN="$WORK/other-codex"
  mv "$WORK/npm.aside" "$STUB/npm"
  [ "$(report .outcome)" = failed ] || fail 'no npm: reported failed, never current' failed "$(report .outcome)"
  has 'no npm: says why and restarts nothing' "$(report .detail)" 'restart=none(nothing installed)'
  has 'no npm: the note' "$(report .detail)" 'npm=none->FAILED:no-npm'
fi

# ── no policy: nothing at all ───────────────────────────────────────────────
for case in refused down unreadable stable; do
  reset; npm_at 0.120.0
  case $case in
    refused) policy 403 force ;;
    down) policy 200 force; : > "$STATE/policy-down" ;;
    unreadable) printf 200 > "$STATE/policy-code"; printf 'not json' > "$STATE/policy-body" ;;
    stable) policy 200 force stable ;;
  esac
  run; got=$?
  lacks "no policy ($case): installs nothing, even below the floor" "$(cat "$LOG")" 'npm install'
  has "no policy ($case): says why" "$(cat "$WORK/err")" 'Codex has no fallback floor'
  [ "$got" = 0 ] || fail "no policy ($case): exits 0 (no floor to be below)" 0 "$got"
  # Nothing installed or checked: the admin's update did not happen (Bugbot on #1080).
  [ "$(report .outcome)" = failed ] || fail "no policy ($case): reported failed, never current" failed "$(report .outcome)"
done
has 'no policy: the report says which' "$(report .detail)" 'policy=unreadable restart=none'
[ "$(report 'has("target")')" = false ] || fail 'no policy: the report names no target (Bugbot on #995)' 'no target' "$(report .target)"
# A 404: the orchestrator knows no such run, so nothing to report to.
reset; npm_at 0.163.0; policy 404
run
lacks '404: installs nothing' "$(cat "$LOG")" 'npm install'
[ ! -e "$STATE/report-body" ] || fail '404: posts no report' 'no report' "$(cat "$STATE/report-body")"
# A 200 with run null (the flag off since, the run expired): not this run's to install.
reset; npm_at 0.163.0; policy 200 force 0.166.0 5 null
run
lacks 'run null: installs nothing' "$(cat "$LOG")" 'npm install'
# Below the floor, too: not this run's floor, so not a failed run.
reset; npm_at 0.120.0; policy 200 force 0.166.0 5 null
run; got=$?
[ "$got" = 0 ] || fail 'run null, below the floor: exits 0' 0 "$got"
[ "$(report .outcome)" = current ] || fail 'run null, below the floor: not reported failed' current "$(report .outcome)"
reset; npm_at 0.163.0; policy 200 force 0.166.0 5 null
run
has 'run null: says why' "$(cat "$WORK/err")" "the orchestrator did not start run $RUN_ID"
has 'run null: restarts nothing' "$(report .detail)" 'policy=ok-no-run restart=none'

# ── the lock ────────────────────────────────────────────────────────────────
reset; npm_at 0.163.0; policy 200 none 0.166.0; mkdir -p "$HOME_DIR/.termag"
( exec 9>"$HOME_DIR/.termag/codex-update.lock"; flock 9; sleep 4 ) & holder=$!
sleep 0.5
run; got=$?
wait "$holder"
lacks 'lock held: installs nothing' "$(cat "$LOG")" 'npm install'
has 'lock held: says so' "$(cat "$WORK/err")" 'another termag-codex-update held the lock'
[ "$(report .outcome)" = failed ] || fail 'lock held: the run did not happen, reported failed (Bugbot on #995)' failed "$(report .outcome)"
has 'lock held: the detail says why' "$(report .detail)" 'lock=held-by-another-run'

# ── usage ───────────────────────────────────────────────────────────────────
for a in '' '--run' '--run short' "--run $RUN_ID extra" '--ensure 0.131.0' '--boot' "--run ${RUN_ID}X;id"; do
  ARGS="${a:- }" run; got=$?
  [ "$got" = 2 ] || fail "usage '$a': exits 2" 2 "$got"
done

# ── the session cases ───────────────────────────────────────────────────────
if ! command -v tmux >/dev/null 2>&1; then
  echo 'skip: session cases need tmux'
elif ! sudo -n true 2>/dev/null || ! command -v unshare >/dev/null 2>&1 || ! command -v setpriv >/dev/null 2>&1; then
  echo 'skip: session cases need sudo -n, unshare and setpriv (a private PID namespace)'
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
  echo "ok: termag-codex-update"
else
  echo "$failures failure(s)"
  exit 1
fi
