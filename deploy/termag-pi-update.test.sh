#!/bin/sh
# Tests deploy/termag-pi-update, the box's pi updater (its package.json
# tab-indented, as pi's is),
# on deploy/termag-tool-update-lib, with npm, pi and
# the orchestrator (curl) stubbed on PATH:
#
#   * --run asks for pi's policy (component=pi) with the agent token on curl's
#     stdin, never in an argument or a log line
#   * restart none installs the policy's exact target into the npm global with
#     --ignore-scripts (as the image does), only when behind it, and reports
#   * latest is resolved once and never installed as a tag; nothing moves down
#   * an install is accepted only when package.json and pi --version both say
#     it; otherwise rejected (exit 3, recorded), put back to the version that
#     ran, or quarantined (dist/bundle/cli.js renamed, not executable)
#   * no policy (refused, unreachable, unreadable, a stable target pi does not
#     publish) installs nothing, and the report names no target; a 404 posts
#     no report; a 200 with run null installs nothing
#   * the lock held by another run: it installs nothing and reports failed
#   * bad usage exits 2
#   * the sessions, in a private PID namespace (sudo -n unshare; skipped
#     without it or tmux), with fake pis (a copy of bash named node running
#     the package's cli.js) in real tmux panes: a pi started before the
#     install is on old code, one started after is left alone; force stops
#     every pane's own pi and cuts the one working; a pane with a session
#     since it started gets `pi --continue` typed; a pi agent pane
#     (through termag-pi-headless) is listed with its session and never
#     typed into; a -p turn, an rpc mode run, one another agent runs and one
#     outside tmux are left alone; a signal lists the panes already stopped;
#     idle waits for the working indicator to go, and cuts one still working
#
# Run: sh deploy/termag-pi-update.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-pi-update"
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
PKGDIR="$NPMROOT/@earendil-works/pi-coding-agent"
PKGJSON="$PKGDIR/package.json"
mkdir -p "$HOME_DIR" "$STUB" "$STATE" "$PKGDIR/dist/bundle" "$WORK/npm/bin"
LOG="$WORK/calls"
export LOG STATE NPMROOT PKGJSON

# ── stubs ───────────────────────────────────────────────────────────────────
# npm: `root -g` and `prefix -g` are the scratch prefix; `view` answers
# $STATE/latest; `install -g` writes the package.json of the version asked
# for (or $STATE/install-other(-once)), lays dist/bundle/cli.js down again, and
# fails with $STATE/npm-rc.
cat > "$STUB/npm" <<'EOF'
#!/bin/sh
echo "npm $*" >> "$LOG"
case "$1" in
  root) echo "$NPMROOT" ;;
  prefix) echo "${NPMROOT%/lib/node_modules}" ;;
  view) cat "$STATE/latest"; exit 0 ;;
  # pack <pkg>@<v>: a stand-in package file for that version in the current
  # directory ($STATE/pack-other: other bytes), its name printed.
  pack)
    for a; do spec=$a; done
    v=${spec##*@} f=earendil-works-pi-coding-agent-${spec##*@}.tgz
    { echo "pi package $v"; [ -e "$STATE/pack-other" ] && echo tampered; } > "$f"
    echo "$f"; exit 0 ;;
  install)
    rc=$(cat "$STATE/npm-rc" 2>/dev/null || echo 0)
    [ "$rc" = 0 ] || { echo 'npm ERR! boom' >&2; exit "$rc"; }
    for a; do spec=$a; done
    v=${spec##*@}
    # A package file (the pinned bytes): its version is in its name.
    case "$spec" in *.tgz) v=${spec##*-}; v=${v%.tgz}; echo "installed from $spec" >> "$STATE/install-files" ;; esac
    [ -s "$STATE/install-other" ] && v=$(cat "$STATE/install-other")
    [ -s "$STATE/install-other-once" ] && { v=$(cat "$STATE/install-other-once"); rm -f "$STATE/install-other-once"; }
    printf '{\n\t"name": "@earendil-works/pi-coding-agent",\n\t"version": "%s"\n}\n' "$v" > "$PKGJSON"
    rm -f "$STATE/broken"
    [ -e "$STATE/break-on-install" ] && : > "$STATE/broken"
    cp "$STATE/cli.js" "$NPMROOT/@earendil-works/pi-coding-agent/dist/bundle/cli.js"; chmod +x "$NPMROOT/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
    exit 0 ;;
esac
EOF
# dist/bundle/cli.js, what npm links as bin/pi: the version in its
# package.json; `--continue` stays up (a resumed session); run with no
# argument it is a session (sessions_cases).
cat > "$STATE/cli.js" <<'EOF'
#!/bin/sh
[ "$1" = --continue ] && exec sleep 300
if [ "$1" = --version ]; then
  [ -e "$STATE/broken" ] && exit 1
  v=$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$PKGJSON" 2>/dev/null)
  [ -n "$v" ] || exit 1
  echo "$v"; exit 0
fi
if [ -n "${STUBBORN:-}" ]; then trap '' TERM; else trap 'exit 0' TERM; fi
shown=
while :; do
  if [ -n "${BUSY_UNTIL:-}" ] && [ ! -e "$BUSY_UNTIL" ]; then
    [ "$shown" = busy ] || { printf '\033[2J\033[H \342\240\213 Working (esc to interrupt)\n'; shown=busy; }
  else
    [ "$shown" = idle ] || { printf '\033[2J\033[H\n > \n'; shown=idle; }
  fi
  sleep 0.2
done
EOF
chmod +x "$STUB/npm" "$STATE/cli.js"
cp "$STATE/cli.js" "$PKGDIR/dist/bundle/cli.js"
ln -s ../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js "$WORK/npm/bin/pi"

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

npm_at() { printf '{\n\t"name": "@earendil-works/pi-coding-agent",\n\t"version": "%s"\n}\n' "$1" > "$PKGJSON"; }
RUN_ID=cmvtrun0000000000000000005
printf '{"token":"tmag_box_token","termag_url":"wss://orch.example.test/termag/ws/agent"}\n' > "$WORK/agent.config.json"
policy() {  # policy CODE [RESTART [TARGET [DRAIN [RUN [FLOOR]]]]]
  printf '%s' "$1" > "$STATE/policy-code"
  printf '{"floor":"%s","target":"%s","restart":"%s","drainSec":%s,"run":%s}' \
    "${6:-0.79.0}" "${3:-1.4.0}" "${2:-none}" "${4:-5}" "${5:-{\"id\":\"$RUN_ID\",\"component\":\"pi\"\}}" > "$STATE/policy-body"
}
reset() {
  : > "$LOG"
  rm -f "$STATE/npm-rc" "$STATE/pack-other" "$STATE/install-files" "$STATE/broken" "$STATE/break-on-install" "$STATE/install-other" "$STATE/install-other-once" \
    "$STATE/curl-calls" "$STATE/curl-args" "$STATE/curl-config" "$STATE/report-body" "$STATE/policy-down" \
    "$HOME_DIR/.termag/pi-update.rejected" "$PKGDIR/dist/bundle/cli.js.rejected"
  echo 1.4.0 > "$STATE/latest"
  cp "$STATE/cli.js" "$PKGDIR/dist/bundle/cli.js"; chmod +x "$PKGDIR/dist/bundle/cli.js"
}
# The pins the run checks against: every x.y.z this test names, with the stub's
# stand-in integrity (TERMAG_PI_PINS).
grep -oE '[0-9]+\.[0-9]+\.[0-9]+' "$0" | sort -u | while read -r v; do echo "$v sha512-$(echo "pi package $v" | openssl dgst -sha512 -binary | base64 -w0)"; done > "$WORK/pins"
run() {
  env -i PATH="$STUB:$WORK/npm/bin:/usr/bin:/bin" HOME="$HOME_DIR" NVM_DIR="$WORK/no-nvm" LOG="$LOG" STATE="$STATE" \
    NPMROOT="$NPMROOT" PKGJSON="$PKGJSON" TERMAG_PI_RETRY_SLEEP=0 TERMAG_PI_LOCK_WAIT=1 TERMAG_PI_PINS="${PINS_FILE:-$WORK/pins}" \
    TERMAG_AGENT_CONFIG="$WORK/agent.config.json" "$@" bash "$SCRIPT" ${ARGS:---run $RUN_ID} 2>"${ERRF:-$WORK/err}"
}
report() { jq -r "$1" "$STATE/report-body" 2>/dev/null; }
# run_plain ARGS...: the script with these arguments, its stdout kept.
run_plain() {
  env -i PATH="$STUB:$WORK/npm/bin:/usr/bin:/bin" HOME="$HOME_DIR" NVM_DIR="$WORK/no-nvm" LOG="$LOG" STATE="$STATE" \
    NPMROOT="$NPMROOT" PKGJSON="$PKGJSON" TERMAG_PI_PINS="$WORK/pins" bash "$SCRIPT" "$@" 2>>"$WORK/err"
}

# ── the sessions, in a private PID namespace ────────────────────────────────
# A fake pi is node (a copy of bash named node) running the package's
# dist/bundle/cli.js, which, run as a session, shows pi's working indicator
# while $BUSY_UNTIL is missing, and its prompt once it exists (STUBBORN=1:
# ignores SIGTERM). Its session file is ~/.pi/agent/sessions/--<cwd>--/.
sessions_cases() {
  [ "$$" = 1 ] || { echo 'FAIL: the session cases run only as PID 1 of their own PID namespace'; exit 1; }
  S="$WORK/tmux.sock"
  NODE="$WORK/nodebin/node"; mkdir -p "$WORK/nodebin"; cp "$(command -v bash)" "$NODE"
  CLI="$PKGDIR/dist/bundle/cli.js"
  # pane NAME ENV...: a tmux session whose shell runs a fake pi (LAUNCH: through a launcher script of that name).
  pane() {
    n=$1; shift
    mkdir -p "$WORK/cwd/$n"
    tmux -S "$S" -f /dev/null new-session -d -s "$n" -c "$WORK/cwd/$n" -x 200 -y 50 "env PATH=$STUB:$WORK/npm/bin:/usr/bin:/bin HOME=$HOME_DIR STATE=$STATE PKGJSON=$PKGJSON bash --norc --noprofile"
    if [ -n "${LAUNCH:-}" ]; then
      printf '#!/bin/sh\n"%s" "%s" "$@"\n' "$NODE" "$CLI" > "$WORK/nodebin/$LAUNCH"; chmod +x "$WORK/nodebin/$LAUNCH"
      tmux -S "$S" send-keys -t "$n" -l -- "env $* $WORK/nodebin/$LAUNCH ${PARGS:-}"
    else
      tmux -S "$S" send-keys -t "$n" -l -- "env $* $NODE $CLI ${PARGS:-}"
    fi
    tmux -S "$S" send-keys -t "$n" Enter
  }
  uuid() { printf '019a%04d-1111-7222-8333-444444444444' "$1"; }
  # session NAME ID: a session file for that pane's directory, written now.
  session() { d="$HOME_DIR/.pi/agent/sessions/--$(printf '%s' "${WORK#/}/cwd/$1" | tr '/:' '--')--"; mkdir -p "$d"; printf '{"type":"session"}\n' > "$d/2026-10-30T12-00-00-000Z_$2.jsonl"; }
  pid_in() { for _ in $(seq 1 50); do p=$(pgrep -f "^$NODE $CLI" | while read -r q; do e=$(env_of "$q" TMUX_PANE); [ -n "$e" ] && [ "$(tmux -S "$S" display -p -t "$e" '#{session_name}' 2>/dev/null)" = "$1" ] && echo "$q"; done | head -n 1); [ -n "$p" ] && { echo "$p"; return; }; sleep 0.1; done; }
  env_of() { tr '\0' '\n' <"/proc/$1/environ" 2>/dev/null | sed -n "s/^$2=//p" | head -n 1; }
  setup() {
    rm -rf "$HOME_DIR/.pi" "$WORK/cwd"
    tmux -S "$S" kill-server 2>/dev/null
    reset; npm_at 1.0.2
  }
  teardown() { tmux -S "$S" kill-server 2>/dev/null; for p in $(pgrep -f "$CLI") $(pgrep -f "$WORK/claude-old/claude"); do kill -KILL "$p" 2>/dev/null; done; sleep 0.3; }
  pane_text() { tmux -S "$S" capture-pane -p -t "$1" 2>/dev/null; }
  pane_cmd() { tmux -S "$S" display -p -t "$1" '#{pane_current_command}' 2>/dev/null; }
  is_running() { kill -0 "$1" 2>/dev/null && [ "$(sed -E 's/^.*\) ([A-Za-z]) .*$/\1/' "/proc/$1/stat")" != Z ]; }
  runs() { run TERMAG_PI_KILL_AFTER=2 TERMAG_PI_RESUME_WAIT=2 TERMAG_POLICY_TIMEOUT=5; }

  # force: every pane's own pi at once.
  setup
  pane work
  pane busy BUSY_UNTIL="$WORK/never"
  pane scratch
  pane stubborn STUBBORN=1
  LAUNCH=termag-pi-headless pane alice-proj-agent
  PARGS='-p a-turn' pane print-turn
  PARGS='--mode rpc' pane rpc-turn
  mkdir -p "$WORK/claude-old"; cp "$(command -v bash)" "$WORK/claude-old/claude"
  mkdir -p "$WORK/cwd/claude-tool"
  tmux -S "$S" -f /dev/null new-session -d -s claude-tool -c "$WORK/cwd/claude-tool" "env PATH=/usr/bin:/bin bash --norc --noprofile"
  tmux -S "$S" send-keys -t claude-tool -l -- "$WORK/claude-old/claude -c '$NODE $CLI; :'"; tmux -S "$S" send-keys -t claude-tool Enter
  # pi as it really runs: its title replaces its command line ("pi"; here argv0
  # pi, and a script that is not the bundle).
  cp "$CLI" "$WORK/nodebin/titled.sh"
  mkdir -p "$WORK/cwd/titled"
  tmux -S "$S" -f /dev/null new-session -d -s titled -c "$WORK/cwd/titled" "env PATH=$STUB:$WORK/npm/bin:/usr/bin:/bin HOME=$HOME_DIR STATE=$STATE PKGJSON=$PKGJSON bash --norc --noprofile"
  tmux -S "$S" send-keys -t titled -l -- "bash -c 'exec -a pi \"\$0\" \"\$1\"' $NODE $WORK/nodebin/titled.sh"; tmux -S "$S" send-keys -t titled Enter
  outside=$( ( "$NODE" "$CLI" </dev/null >/dev/null 2>&1 & echo "$!" ) )
  sleep 2
  session work "$(uuid 1)"; session busy "$(uuid 2)"; session alice-proj-agent "$(uuid 3)"
  sleep 11
  stub_pid=$(pid_in stubborn) print_pid=$(pid_in print-turn) rpc_pid=$(pid_in rpc-turn) tool_pid=$(pid_in claude-tool)
  policy 200 force 1.4.0 30
  runs; got=$?
  [ "$got" = 0 ] || fail 'force: exits 0' 0 "$got: $(tail -5 "$WORK/err")"
  got=$(report '[.sessions.stopped, .sessions.cut, .sessions.typed, .sessions.resumed, .sessions.fresh, .sessions.other] | join(" ")')
  [ "$got" = '6 1 2 2 3 4' ] || fail 'force: stopped cut typed resumed fresh other' '6 1 2 2 3 4' "$got; $(report .detail)"
  got=$(report '[.panes[] | "\(.session):\(.role):\(.hadConversation):\(.sessionId // "-")"] | sort | join(" ")')
  want="alice-proj-agent:agent:true:$(uuid 3) busy:other:true:$(uuid 2) scratch:other:false:- stubborn:other:false:- titled:other:false:- work:other:true:$(uuid 1)"
  [ "$got" = "$want" ] || fail 'force: every stopped pane listed, with its session' "$want" "$got"
  has 'force: a pane with a session gets pi --continue typed' "$(pane_text work)" 'pi --continue'
  [ "$(pane_cmd work)" = sleep ] || fail 'force: the typed resume took' sleep "$(pane_cmd work)"
  for n in scratch stubborn alice-proj-agent; do
    lacks "force: nothing typed into $n" "$(pane_text "$n")" 'pi --continue'
    [ "$(pane_cmd "$n")" = bash ] || fail "force: $n is left at its shell" bash "$(pane_cmd "$n")"
  done
  is_running "$stub_pid" && fail 'force: a session that ignores SIGTERM is SIGKILLed' killed alive
  [ -n "$print_pid" ] && is_running "$print_pid" || fail 'force: a -p turn in a pane is left alone' alive "gone ($print_pid)"
  [ -n "$rpc_pid" ] && is_running "$rpc_pid" || fail 'force: an rpc mode run (the chat runner'"'"'s) is left alone' alive "gone ($rpc_pid)"
  [ -n "$tool_pid" ] && is_running "$tool_pid" || fail 'force: a pi another agent runs is left alone' alive "gone ($tool_pid)"
  is_running "$outside" || fail 'force: a pi outside tmux is left alone' alive gone
  kill -KILL "$outside" 2>/dev/null
  teardown

  # A pi that continued an earlier session and has not written it since it
  # started: that session is the pane's, and it is continued (Bugbot on #1088).
  setup
  session continued "$(uuid 61)"; touch -d '1 hour ago' "$HOME_DIR/.pi/agent/sessions/"*/*"_$(uuid 61).jsonl"
  pane continued
  sleep 2
  policy 200 force 1.4.0 0
  runs
  got=$(report '[.panes[] | "\(.session):\(.hadConversation):\(.sessionId // "-")"] | join(" ")')
  [ "$got" = "continued:true:$(uuid 61)" ] || fail 'continued: the earlier session is the pane'"'"'s' "continued:true:$(uuid 61)" "$got"
  has 'continued: it gets pi --continue typed' "$(pane_text continued)" 'pi --continue'
  teardown

  # Started after the installed package was written: on the current code, left alone.
  setup; npm_at 1.4.0; sleep 1.2
  pane fresh-start
  sleep 2; fresh_pid=$(pid_in fresh-start)
  policy 200 force 1.4.0 0
  runs
  is_running "$fresh_pid" || fail 'current: a pi started after the install is left alone' alive gone
  teardown

  # Two pi panes in one directory: its newest session may be either's, so
  # neither continues it (Devin on #1088).
  setup
  pane twin-a
  tmux -S "$S" -f /dev/null new-session -d -s twin-b -c "$WORK/cwd/twin-a" -x 200 -y 50 "env PATH=$STUB:$WORK/npm/bin:/usr/bin:/bin HOME=$HOME_DIR STATE=$STATE PKGJSON=$PKGJSON bash --norc --noprofile"
  tmux -S "$S" send-keys -t twin-b -l -- "$NODE $CLI"; tmux -S "$S" send-keys -t twin-b Enter
  sleep 2; session twin-a "$(uuid 71)"; sleep 11
  policy 200 force 1.4.0 0
  runs
  got=$(report '[.panes[] | "\(.session):\(.hadConversation):\(.sessionId // "-")"] | sort | join(" ")')
  [ "$got" = "twin-a:false:- twin-b:false:-" ] || fail 'shared directory: neither pane continues the guessed session' "twin-a:false:- twin-b:false:-" "$got"
  for n in twin-a twin-b; do lacks "shared directory: nothing typed into $n" "$(pane_text "$n")" 'pi --continue'; done
  teardown

  # A pi that started just before its package was replaced, in the same
  # second: on the old code, so stopped (Devin on #1088). The package's time
  # is set 0.02 s after the pi's start, once the whole-second start the old
  # check read is that second too (it can read up to 2 s early; a pane is
  # started again until it does not).
  setup
  btime=$(awk '/^btime /{print $2}' /proc/stat); hz=$(getconf CLK_TCK)
  for _ in $(seq 1 40); do
    tmux -S "$S" kill-session -t same-second 2>/dev/null
    pane same-second; ss_pid=$(pid_in same-second)
    ticks=$(sed -E 's/^.*\) [A-Za-z] //' "/proc/$ss_pid/stat" | awk '{print $19}')
    read -r up _ </proc/uptime; now=$(date +%s%N)
    up_cs=$(printf '%s' "$up" | tr -d . | sed 's/^0*//; s/^$/0/')
    real_cs=$(( now / 10000000 - up_cs + ticks * 100 / hz )); at_cs=$(( real_cs + 2 ))
    [ $(( btime + ticks / hz )) -ge $(( at_cs / 100 )) ] && break
    ss_pid=
  done
  if [ -n "$ss_pid" ]; then
    touch -d "@$(( at_cs / 100 )).$(printf '%02d' $(( at_cs % 100 )))" "$PKGJSON"
    policy 200 force 1.0.2 0
    runs
    is_running "$ss_pid" && fail 'same second: a pi started just before the package is stopped' stopped alive
  else
    echo 'skip: same second (no start the whole-second check reads as that second)'
  fi
  teardown

  # A signal while a stopped pane is still going (Bugbot on #995): the report lists it.
  setup
  LAUNCH=termag-pi-headless pane alice-proj-agent STUBBORN=1
  sleep 2; session alice-proj-agent "$(uuid 51)"; sleep 11
  policy 200 force 1.4.0 0
  run TERMAG_PI_KILL_AFTER=30 TERMAG_POLICY_TIMEOUT=5 & rp=$!
  sleep 5
  kill -TERM "$(pgrep -f "termag-pi-update --run $RUN_ID")"; wait "$rp"; got=$?
  [ "$got" = 143 ] || fail 'signal: exits 143' 143 "$got"
  got=$(report '[.panes[] | "\(.session):\(.role):\(.sessionId // "-")"] | join(" ")')
  [ "$got" = "alice-proj-agent:agent:$(uuid 51)" ] || fail 'signal: the pane it had stopped is listed' "alice-proj-agent:agent:$(uuid 51)" "$got"
  teardown

  # idle: waits for the working indicator to go, then stops; one still working at drainSec is cut.
  setup
  pane busy BUSY_UNTIL="$WORK/done-busy"
  pane stuck BUSY_UNTIL="$WORK/never"
  sleep 1.2; busy_pid=$(pid_in busy) stuck_pid=$(pid_in stuck)
  policy 200 idle 1.4.0 8
  runs & rp=$!
  sleep 4
  is_running "$busy_pid" || fail 'idle: a pane that is working is not stopped' alive stopped
  : > "$WORK/done-busy"
  wait "$rp"
  is_running "$busy_pid" && fail 'idle: stopped once it stopped working' stopped alive
  is_running "$stuck_pid" && fail 'idle: one still working at drainSec is cut' stopped alive
  [ "$(report '.sessions.cut')" = 1 ] || fail 'idle: one cut' 1 "$(report .detail)"
  teardown
}
if [ "${1:-}" = --sessions ]; then
  sessions_cases
  if [ "$failures" -eq 0 ]; then echo 'ok: termag-pi-update --run sessions (PID namespace)'; exit 0; fi
  echo "$failures failure(s) in the session cases"; exit 1
fi

# ── restart none: the exact target, reported ────────────────────────────────
reset; npm_at 1.0.2; policy 200 none 1.4.0
run; got=$?
[ "$got" = 0 ] || fail 'target: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'target: asks for pi'"'"'s policy for its run' "$(cat "$STATE/curl-calls")" "GET https://orch.example.test/termag/api/tool-update/policy?component=pi&run=$RUN_ID"
has 'target: the token goes on curl'"'"'s stdin' "$(cat "$STATE/curl-config")" 'Authorization: Bearer tmag_box_token'
lacks 'target: never in an argument' "$(cat "$STATE/curl-args")" 'tmag_box_token'
lacks 'target: never in a log line' "$(cat "$WORK/err")" 'tmag_box_token'
# The target's pinned package file (Security review on #1088), as the image installs it.
has 'target: installs exactly the target' "$(cat "$LOG")" 'npm install -g --no-fund --no-audit --loglevel=error --ignore-scripts '
has 'target: installs exactly the target' "$(cat "$LOG")" '/earendil-works-pi-coding-agent-1.4.0.tgz'
has 'target: verified by package.json and pi --version' "$(cat "$WORK/err")" 'npm installed @earendil-works/pi-coding-agent@1.4.0, verified (package.json and pi --version)'
has 'target: the summary' "$(cat "$WORK/err")" "pi=$WORK/npm/bin/pi version=1.4.0 floor=0.79.0 state=ok npm=1.0.2->1.4.0"
got=$(report '[.component, .trigger, .run, .outcome, .target, .fromVersion, .toVersion, (.sessions | [.stopped, .resumed, .fresh, .cut, .typed, .other, .runnersLeft] | join(",")), (.panes | length)] | join(" ")')
[ "$got" = "pi manual $RUN_ID updated 1.4.0 1.0.2 1.4.0 0,0,0,0,0,0,0 0" ] || fail 'target: the report body' "pi manual $RUN_ID updated 1.4.0 1.0.2 1.4.0 0,0,0,0,0,0,0 0" "$got"
has 'target: the detail says restart none' "$(report .detail)" 'policy=ok restart=none'
[ -f "$HOME_DIR/.termag/pi-update.lock" ] || fail 'target: the lock is pi'"'"'s own, under ~/.termag' present absent
[ ! -e "$HOME_DIR/.termag/claude-update.lock" ] || fail 'target: never Claude Code'"'"'s lock' absent present

# At the target: nothing installed, current.
reset; npm_at 1.4.0; policy 200 none 1.4.0
run; got=$?
[ "$got" = 0 ] || fail 'current: exits 0' 0 "$got"
lacks 'current: installs nothing' "$(cat "$LOG")" 'npm install'
[ "$(report .outcome)" = current ] || fail 'current: outcome current' current "$(report .outcome)"
# A target below what is installed moves nothing down.
reset; npm_at 1.9.0; policy 200 none 1.4.0
run
lacks 'no downgrade: installs nothing' "$(cat "$LOG")" 'npm install'

# ── latest: resolved once, never installed as a tag ─────────────────────────
reset; npm_at 1.0.2; policy 200 none latest
run; got=$?
[ "$got" = 0 ] || fail 'latest: exits 0' 0 "$got: $(cat "$WORK/err")"
[ "$(grep -c 'npm view @earendil-works/pi-coding-agent@latest version' "$LOG")" = 1 ] || fail 'latest: asks npm once' 1 "$(grep -c 'npm view' "$LOG")"
has 'latest: installs what it resolved to' "$(cat "$LOG")" '@earendil-works/pi-coding-agent@1.4.0'
lacks 'latest: never the tag' "$(cat "$LOG")" 'loglevel=error @earendil-works/pi-coding-agent@latest'
[ "$(report .target)" = 1.4.0 ] || fail 'latest: the report names the version' 1.4.0 "$(report .target)"

# ── pinned versions only (Security review on #1088) ─────────────────────────
# A version with no pin: npm installs nothing, the run fails.
reset; npm_at 1.0.2; policy 200 none 1.4.0
grep -v '^1\.4\.0 ' "$WORK/pins" > "$WORK/pins-without"
PINS_FILE="$WORK/pins-without" run
lacks 'unpinned: npm installs nothing' "$(cat "$LOG")" 'npm install'
[ "$(report .outcome)" = failed ] || fail 'unpinned: reported failed' failed "$(report .outcome)"
has 'unpinned: says why' "$(report .detail)" 'npm=1.0.2->FAILED:unpinned:1.4.0'
# A pinned version whose package is not the pinned bytes: not installed.
reset; npm_at 1.0.2; policy 200 none 1.4.0; : > "$STATE/pack-other"
run
lacks 'other bytes: npm installs nothing' "$(cat "$LOG")" 'npm install'
has 'other bytes: says why' "$(cat "$WORK/err")" "pi 1.4.0's package is not the pinned one"
# A pinned version: npm installs the checked file itself, never a second fetch.
reset; npm_at 1.0.2; policy 200 none 1.4.0
run
has 'pinned: npm installs the checked package file' "$(cat "$STATE/install-files" 2>/dev/null)" 'earendil-works-pi-coding-agent-1.4.0.tgz'
lacks 'pinned: never the registry spec' "$(grep 'npm install' "$LOG")" '@earendil-works/pi-coding-agent@1.4.0'
# --pinned-package: the checked file for another updater (termag-node-update).
mkdir -p "$WORK/pp"; got=$(run_plain --pinned-package 1.4.0 "$WORK/pp"); rc=$?
[ "$rc" = 0 ] && [ "$got" = "$WORK/pp/earendil-works-pi-coding-agent-1.4.0.tgz" ] || fail 'pinned package: its path' "$WORK/pp/earendil-works-pi-coding-agent-1.4.0.tgz" "$rc $got"
: > "$STATE/pack-other"; run_plain --pinned-package 1.4.0 "$WORK/pp" >/dev/null; rc=$?; rm -f "$STATE/pack-other"
[ "$rc" = 1 ] || fail 'pinned package: other bytes refused' 1 "$rc"
# With no TERMAG_PI_PINS the script's own table is read: the image's 1.0.2 is
# pinned with its registry integrity, and 1.4.0 is not.
grep -qE "^PINS='1\.0\.2 sha512-[A-Za-z0-9+/=]{88}'\$" "$SCRIPT" || fail 'pins: the script pins the image'"'"'s 1.0.2' pinned absent
reset; npm_at 1.0.2; policy 200 none 1.4.0
run TERMAG_PI_PINS=
has 'the script'"'"'s pins: 1.4.0 is not pinned' "$(report .detail)" 'FAILED:unpinned:1.4.0'

# ── rejected, restored, quarantined ─────────────────────────────────────────
# npm installs another version than asked: rejected, then the version that ran is put back.
reset; npm_at 1.0.2; echo 1.8.8 > "$STATE/install-other-once"; policy 200 none 1.4.0
run; got=$?
[ "$got" = 3 ] || fail 'other version: rejected, exits 3' 3 "$got"
has 'other version: says what it got' "$(cat "$WORK/err")" 'asked for 1.4.0; package.json says 1.8.8'
has 'restore: reinstalls the version that ran' "$(cat "$LOG")" '@earendil-works/pi-coding-agent@1.0.2'
has 'restore: verified' "$(cat "$WORK/err")" 'npm global @earendil-works/pi-coding-agent is back at 1.0.2, verified'
[ "$("$WORK/npm/bin/pi" --version)" = '1.0.2' ] || fail 'restore: pi is the version that ran' '1.0.2' "$("$WORK/npm/bin/pi" --version 2>&1)"
grep -q '^npm ' "$HOME_DIR/.termag/pi-update.rejected" 2>/dev/null || fail 'restore: the record stays' 'npm ...' "$(cat "$HOME_DIR/.termag/pi-update.rejected" 2>/dev/null)"
[ "$(report .outcome)" = failed ] || fail 'restore: reported failed' failed "$(report .outcome)"
# The next run reinstalls and verifies, and clears the record.
: > "$LOG"; rm -f "$STATE/report-body"
run; got=$?
[ "$got" = 0 ] || fail 'rejected, then verified: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'rejected, then verified: reinstalled' "$(cat "$LOG")" '@earendil-works/pi-coding-agent@1.4.0'
[ ! -e "$HOME_DIR/.termag/pi-update.rejected" ] || fail 'rejected, then verified: the record is gone' absent present
# No version that ran: the new launcher is quarantined.
reset; npm_at 1.0.2; : > "$STATE/broken"; echo 1.8.8 > "$STATE/install-other"; policy 200 none 1.4.0
run; got=$?
[ "$got" = 3 ] || fail 'quarantine: rejected, exits 3' 3 "$got"
[ ! -e "$PKGDIR/dist/bundle/cli.js" ] || fail 'quarantine: the rejected launcher is not left in place' 'moved away' present
[ -e "$PKGDIR/dist/bundle/cli.js.rejected" ] && [ ! -x "$PKGDIR/dist/bundle/cli.js.rejected" ] || fail 'quarantine: renamed, not executable' 'cli.js.rejected, not executable' "$(ls -l "$PKGDIR/dist/bundle" 2>&1)"
[ ! -x "$WORK/npm/bin/pi" ] || fail 'quarantine: nothing resolves pi to it' 'a dangling link' 'runs'
has 'quarantine: the summary says so' "$(cat "$WORK/err")" 'pin-mismatch,quarantined'
# A binary that does not run after a clean npm exit: rejected too.
reset; npm_at 1.0.2; : > "$STATE/break-on-install"; policy 200 none 1.4.0
run; got=$?
[ "$got" = 3 ] || fail 'binary does not run: rejected' 3 "$got"
has 'binary does not run: says so' "$(cat "$WORK/err")" 'pi --version says nothing (does not run)'
# npm fails outright: failed, retried once, nothing rejected.
reset; npm_at 1.0.2; echo 1 > "$STATE/npm-rc"; policy 200 none 1.4.0
run; got=$?
[ "$got" = 0 ] || fail 'npm failure: still at the floor, exits 0' 0 "$got"
[ "$(grep -c 'npm install' "$LOG")" = 2 ] || fail 'npm failure: one retry' 2 "$(grep -c 'npm install' "$LOG")"
has 'npm failure: says FAILED' "$(cat "$WORK/err")" 'npm=1.0.2->FAILED'
[ "$(report .outcome)" = failed ] || fail 'npm failure: reported failed' failed "$(report .outcome)"

# Not in the npm global: nothing installed, and the run fails with the reason
# (Bugbot on #1076, the same code).
reset; mv "$PKGJSON" "$WORK/pkgjson.aside"; policy 200 none 1.4.0
run
mv "$WORK/pkgjson.aside" "$PKGJSON"
lacks 'not in the npm global: installs nothing' "$(cat "$LOG")" 'npm install'
[ "$(report .outcome)" = failed ] || fail 'not in the npm global: reported failed, never current' failed "$(report .outcome)"
has 'not in the npm global: the detail says why' "$(report .detail)" 'npm=none->FAILED:not-in-npm-global'

# ── no policy: nothing at all ───────────────────────────────────────────────
for case in refused down unreadable stable; do
  reset; npm_at 0.70.0
  case $case in
    refused) policy 403 force ;;
    down) policy 200 force; : > "$STATE/policy-down" ;;
    unreadable) printf 200 > "$STATE/policy-code"; printf 'not json' > "$STATE/policy-body" ;;
    stable) policy 200 force stable ;;
  esac
  run; got=$?
  lacks "no policy ($case): installs nothing, even below the floor" "$(cat "$LOG")" 'npm install'
  has "no policy ($case): says why" "$(cat "$WORK/err")" 'pi has no fallback floor'
  [ "$got" = 0 ] || fail "no policy ($case): exits 0 (no floor to be below)" 0 "$got"
  # Nothing installed or checked: the admin's update did not happen (Bugbot on #1080).
  [ "$case" = null ] || [ "$(report .outcome)" = failed ] || fail "no policy ($case): reported failed, never current" failed "$(report .outcome)"
done
has 'no policy: the report says which' "$(report .detail)" 'policy=unreadable restart=none'
[ "$(report 'has("target")')" = false ] || fail 'no policy: the report names no target (Bugbot on #995)' 'no target' "$(report .target)"
# A 404: the orchestrator knows no such run, so nothing to report to.
reset; npm_at 1.0.2; policy 404
run
lacks '404: installs nothing' "$(cat "$LOG")" 'npm install'
[ ! -e "$STATE/report-body" ] || fail '404: posts no report' 'no report' "$(cat "$STATE/report-body")"
# A 200 with run null (the flag off since, the run expired): not this run's to install.
reset; npm_at 1.0.2; policy 200 force 1.4.0 5 null
run
lacks 'run null: installs nothing' "$(cat "$LOG")" 'npm install'
# Below the floor, too: not this run's floor, so not a failed run.
reset; npm_at 0.70.0; policy 200 force 1.4.0 5 null
run; got=$?
[ "$got" = 0 ] || fail 'run null, below the floor: exits 0' 0 "$got"
[ "$(report .outcome)" = current ] || fail 'run null, below the floor: not reported failed' current "$(report .outcome)"
reset; npm_at 1.0.2; policy 200 force 1.4.0 5 null
run
has 'run null: says why' "$(cat "$WORK/err")" "the orchestrator did not start run $RUN_ID"
has 'run null: restarts nothing' "$(report .detail)" 'policy=ok-no-run restart=none'

# ── the lock ────────────────────────────────────────────────────────────────
reset; npm_at 1.0.2; policy 200 none 1.4.0; mkdir -p "$HOME_DIR/.termag"
( exec 9>"$HOME_DIR/.termag/pi-update.lock"; flock 9; sleep 4 ) & holder=$!
sleep 0.5
run; got=$?
wait "$holder"
lacks 'lock held: installs nothing' "$(cat "$LOG")" 'npm install'
has 'lock held: says so' "$(cat "$WORK/err")" 'another termag-pi-update held the lock'
[ "$(report .outcome)" = failed ] || fail 'lock held: the run did not happen, reported failed (Bugbot on #995)' failed "$(report .outcome)"
has 'lock held: the detail says why' "$(report .detail)" 'lock=held-by-another-run'

# ── usage ───────────────────────────────────────────────────────────────────
for a in '' '--run' '--run short' "--run $RUN_ID extra" '--ensure 0.79.0' '--boot' "--run ${RUN_ID}X;id"; do
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
  echo "ok: termag-pi-update"
else
  echo "$failures failure(s)"
  exit 1
fi
