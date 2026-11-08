#!/bin/sh
# Tests deploy/termag-cursor-update, the box's Cursor agent updater,
# on deploy/termag-tool-update-lib, with curl (the
# installer, the downloads and the orchestrator) stubbed on PATH and the
# Cursor agent laid out as its installer lays it out (versions/<build>/, two
# links in ~/.local/bin):
#
#   * --run asks for the Cursor agent's policy (component=cursor) with the
#     agent token on curl's stdin, never in an argument or a log line
#   * an exact target is downloaded for this machine's architecture, checked
#     by its own cursor-agent --version, moved into versions/<build>, and
#     both links pointed at it; the report says cursor, the builds before and
#     after; at the target nothing is downloaded, and nothing moves down
#   * latest is the build the installer names, asked for once
#   * a package that says another build is never installed: the links stay,
#     the run fails, nothing is recorded
#   * a build that, once linked, is not what a session starts is rejected
#     (exit 3, recorded), and the links go back to the build that ran,
#     verified, or, with none, the new build is quarantined and the links
#     removed; a later verified install clears the record
#   * a download that fails changes nothing
#   * no policy, or a run the orchestrator did not start, installs nothing
#   * the lock held by another run: it installs nothing
#   * bad usage exits 2
#   * the sessions, in a private PID namespace (sudo -n unshare; skipped
#     without it or tmux), with fake Cursor agents (copies of bash as a build's
#     node) in real tmux panes: force stops every pane's session the pane's
#     shell started, and cuts the one in a turn; a pane whose chat store was
#     written since it started gets `cursor-agent --resume <id>` typed, one
#     with only an older chat is left at its shell; an agent pane is listed
#     with its chat id and never typed into; a -p turn, a subcommand, one that
#     another agent runs, one on the current build and one outside tmux are
#     left alone; idle waits until the pane shows no turn, and cuts one still
#     in a turn at drainSec
#
# Run: sh deploy/termag-cursor-update.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-cursor-update"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}
has() { case "$2" in *"$3"*) : ;; *) fail "$1" "$3" "$2" ;; esac; }
lacks() { case "$2" in *"$3"*) fail "$1" "(no '$3')" "$2" ;; esac; }
command -v flock >/dev/null 2>&1 || { echo 'SKIP: flock is required for this test'; exit 0; }
command -v jq >/dev/null 2>&1 || { echo 'SKIP: jq is required for this test'; exit 0; }

HOME_DIR="$WORK/home"
STUB="$WORK/stub"
STATE="$WORK/state"
VERSIONS="$HOME_DIR/.local/share/cursor-agent/versions"
mkdir -p "$HOME_DIR/.local/bin" "$STUB" "$STATE" "$VERSIONS" "$WORK/pkgs"
LOG="$WORK/calls"
export LOG STATE

OLD=2026.10.01-0a1b2c3
NEW=2026.10.22-27dcf5f
LATER=2026.11.02-9f8e7d6

# A package as Cursor publishes it: one top directory holding cursor-agent,
# node and index.js. Its cursor-agent says BUILD, or SAYS: from its download
# directory (.tmp-termag-*) always SAYS, once moved $STATE/live-says when that
# exists, so a test can tell the two checks apart. `--resume` stays up (a
# resumed session).
mkpkg() {  # mkpkg BUILD [SAYS]
  d="$WORK/pkgsrc/$1/dist-package"; rm -rf "$WORK/pkgsrc/$1"; mkdir -p "$d"
  cat > "$d/cursor-agent" <<EOF
#!/bin/sh
[ "\$1" = --resume ] && exec sleep 300
[ "\$1" = --version ] || [ "\$1" = -v ] || exit 0
[ -s "\$STATE/notice" ] && cat "\$STATE/notice"
case "\$(dirname "\$(readlink -f "\$0")")" in
  */.tmp-termag-*) echo "${2:-$1}" ;;
  *) if [ -s "\$STATE/live-says" ]; then cat "\$STATE/live-says"; else echo "${2:-$1}"; fi ;;
esac
EOF
  chmod +x "$d/cursor-agent"; cp "$(command -v bash)" "$d/node"; : > "$d/index.js"
  tar -czf "$WORK/pkgs/$1.tgz" -C "$WORK/pkgsrc/$1" dist-package
}
# installed BUILD: that build laid out and linked, as the installer leaves it.
installed() {
  rm -rf "$VERSIONS"; mkdir -p "$VERSIONS/$1"
  tar --strip-components=1 -xzf "$WORK/pkgs/$1.tgz" -C "$VERSIONS/$1"
  ln -sfn "$VERSIONS/$1/cursor-agent" "$HOME_DIR/.local/bin/cursor-agent"
  ln -sfn "$VERSIONS/$1/cursor-agent" "$HOME_DIR/.local/bin/agent"
}
mkpkg "$OLD"; mkpkg "$NEW"; mkpkg "$LATER"
# The pins the run checks downloads against: these builds' packages, for this
# machine's arch (TERMAG_CURSOR_PINS).
case "$(uname -m)" in x86_64|amd64) PIN_ARCH=x64 ;; *) PIN_ARCH=arm64 ;; esac
# pins_now: every package the stub serves up to the day of the build the
# installer names (what a pin refresh has pinned by then), pinned as it is
# now; prints the file.
pins_now() {
  lday=$(cut -d- -f1 "$STATE/latest" 2>/dev/null)
  for f in "$WORK"/pkgs/*.tgz; do
    b=${f##*/}; b=${b%.tgz}
    [ -z "$lday" ] || [ "$(printf '%s\n%s\n' "${b%%-*}" "$lday" | sort -V | tail -n 1)" = "$lday" ] || continue
    echo "$b $PIN_ARCH $(sha256sum "$f" | cut -c1-64)"
  done > "$WORK/pins"
  printf '%s' "$WORK/pins"
}

# curl: the installer names $STATE/latest; a download copies its build's
# package (fails while $STATE/dl-fail exists, or for a build with none); the
# orchestrator as in termag-codex-update.test.sh.
cat > "$STUB/curl" <<'EOF'
#!/bin/sh
echo "curl $*" >> "$STATE/curl-args"
out=/dev/stdout data= method=GET url=
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
  https://cursor.com/install)
    printf '#!/usr/bin/env bash\nDOWNLOAD_URL="https://downloads.cursor.com/lab/%s/${OS}/${ARCH}/agent-cli-package.tar.gz"\n' "$(cat "$STATE/latest")" ;;
  https://downloads.cursor.com/lab/*/linux/*/agent-cli-package.tar.gz)
    [ -e "$STATE/dl-fail" ] && exit 22
    [ -e "$STATE/dl-slow" ] && sleep 6
    b=${url#https://downloads.cursor.com/lab/}; b=${b%%/*}
    [ -f "$PKGS/$b.tgz" ] || exit 22
    cp "$PKGS/$b.tgz" "$out" ;;
  */tool-update/policy\?*)
    [ -e "$STATE/policy-down" ] && exit 7
    cat "$STATE/policy-body" > "$out"; printf '%s' "$(cat "$STATE/policy-code")" ;;
  */tool-update/report)
    printf '%s\n' "$data" > "$STATE/report-body"; : > "$out"; printf 204 ;;
  *) exit 6 ;;
esac
EOF
chmod +x "$STUB/curl"

RUN_ID=cmvtrun0000000000000000003
printf '{"token":"tmag_box_token","termag_url":"wss://orch.example.test/termag/ws/agent"}\n' > "$WORK/agent.config.json"
policy() {  # policy CODE [RESTART [TARGET [DRAIN [RUN]]]]
  printf '%s' "$1" > "$STATE/policy-code"
  printf '{"floor":"2025.09.17-25b418f","target":"%s","restart":"%s","drainSec":%s,"run":%s}' \
    "${3:-$NEW}" "${2:-none}" "${4:-5}" "${5:-{\"id\":\"$RUN_ID\",\"component\":\"cursor\"\}}" > "$STATE/policy-body"
}
reset() {
  rm -f "$STATE/curl-calls" "$STATE/curl-args" "$STATE/curl-config" "$STATE/report-body" "$STATE/policy-down" "$STATE/dl-fail" "$STATE/dl-slow" "$STATE/live-says" \
    "$HOME_DIR/.termag/cursor-update.rejected"
  echo "$NEW" > "$STATE/latest"
}
run() {
  env -i PATH="$STUB:/usr/bin:/bin" HOME="$HOME_DIR" LOG="$LOG" STATE="$STATE" PKGS="$WORK/pkgs" \
    TERMAG_CURSOR_LOCK_WAIT=1 TERMAG_AGENT_CONFIG="$WORK/agent.config.json" TERMAG_CURSOR_PINS="${PINS_FILE:-$(pins_now)}" "$@" bash "$SCRIPT" ${ARGS:---run $RUN_ID} 2>"${ERRF:-$WORK/err}"
}
report() { jq -r "$1" "$STATE/report-body" 2>/dev/null; }
link() { readlink "$HOME_DIR/.local/bin/$1" 2>/dev/null; }

# ── the sessions, in a private PID namespace ────────────────────────────────
sessions_cases() {
  [ "$$" = 1 ] || { echo 'FAIL: the session cases run only as PID 1 of their own PID namespace'; exit 1; }
  S="$WORK/tmux.sock"
  # fake-cursor.sh, run as a build's node with it as index.js (so argv reads
  # node .../index.js [args]): BUSY_UNTIL (a file: "Thinking" until it
  # exists, then the prompt), STUBBORN=1 (ignores SIGTERM).
  mkdir -p "$WORK/fake"
  cat > "$WORK/fake/index.js" <<'EOF'
if [ -n "${STUBBORN:-}" ]; then trap '' TERM; else trap 'exit 0' TERM; fi
shown=
while :; do
  # STALE=1: a tool row that failed keeps its word, with no spinner, on a
  # screen that no longer changes.
  if [ -n "${STALE:-}" ]; then
    [ "$shown" = stale ] || { printf '\033[2J\033[H  Globbing "*.ts" in src\n\n  \342\206\222 Add a follow-up\n'; shown=stale; }
  elif [ -n "${BUSY_UNTIL:-}" ] && [ ! -e "$BUSY_UNTIL" ]; then
    [ "$shown" = busy ] || { printf '\033[2J\033[H  Thinking  \342\240\213\n'; shown=busy; }
  else
    [ "$shown" = idle ] || { printf '\033[2J\033[H\n  \342\206\222 Add a follow-up\n'; shown=idle; }
  fi
  sleep 0.2
done
EOF
  ON_OLD="$VERSIONS/$OLD/node"
  uuid() { printf '%08d-1111-4222-8333-444444444444' "$1"; }
  md5() { printf '%s' "$1" | md5sum | cut -c1-32; }
  # pane NAME [ENV...]: a tmux session whose shell runs a fake Cursor agent on the old build.
  pane() {
    n=$1; shift
    mkdir -p "$WORK/cwd/$n"
    tmux -S "$S" -f /dev/null new-session -d -s "$n" -c "$WORK/cwd/$n" -x 200 -y 50 "env PATH=$HOME_DIR/.local/bin:/usr/bin:/bin HOME=$HOME_DIR STATE=$STATE bash --norc --noprofile"
    tmux -S "$S" send-keys -t "$n" -l -- "env $* ${BIN:-$ON_OLD} $WORK/fake/index.js ${PARGS:-}"
    tmux -S "$S" send-keys -t "$n" Enter
  }
  chat() { d="$HOME_DIR/.cursor/chats/$(md5 "$WORK/cwd/$1")/$2"; mkdir -p "$d"; : > "$d/store.db"; [ -n "${3:-}" ] && touch -d "$3" "$d/store.db"; }
  pid_in() { for _ in $(seq 1 50); do p=$(tmux -S "$S" list-panes -t "$1" -F '#{pane_pid}' 2>/dev/null); c=$(pgrep -P "$p" 2>/dev/null | head -n 1); [ -n "$c" ] && { echo "$c"; return; }; sleep 0.1; done; }
  is_running() { kill -0 "$1" 2>/dev/null && [ "$(sed -E 's/^.*\) ([A-Za-z]) .*$/\1/' "/proc/$1/stat")" != Z ]; }
  pane_text() { tmux -S "$S" capture-pane -p -t "$1" 2>/dev/null; }
  pane_cmd() { tmux -S "$S" display -p -t "$1" '#{pane_current_command}' 2>/dev/null; }
  setup() { rm -rf "$HOME_DIR/.cursor" "$WORK/cwd"; tmux -S "$S" kill-server 2>/dev/null; reset; installed "$OLD"; }
  teardown() { tmux -S "$S" kill-server 2>/dev/null; for p in $(pgrep -f "$WORK/fake/index.js"); do kill -KILL "$p" 2>/dev/null; done; sleep 0.3; }
  runs() { run TERMAG_CURSOR_KILL_AFTER=2 TERMAG_CURSOR_RESUME_WAIT=2 TERMAG_POLICY_TIMEOUT=5; }

  # force: every pane's own session at once.
  setup
  pane work
  pane busy BUSY_UNTIL="$WORK/never"
  pane scratch
  pane stubborn STUBBORN=1
  pane alice-proj-agent
  PARGS='-p a-turn' pane print-turn
  PARGS='ls' pane listing
  mkdir -p "$WORK/pi-old"; cp "$(command -v bash)" "$WORK/pi-old/pi"
  mkdir -p "$WORK/cwd/pi-tool"
  tmux -S "$S" -f /dev/null new-session -d -s pi-tool -c "$WORK/cwd/pi-tool" "env PATH=/usr/bin:/bin bash --norc --noprofile"
  tmux -S "$S" send-keys -t pi-tool -l -- "$WORK/pi-old/pi -c '$ON_OLD $WORK/fake/index.js; :'"; tmux -S "$S" send-keys -t pi-tool Enter
  outside=$( ( "$ON_OLD" "$WORK/fake/index.js" </dev/null >/dev/null 2>&1 & echo "$!" ) )
  sleep 2
  # Chats written since each started (and older than 5 s by the run, so not
  # a turn in progress); scratch only has one from before it started.
  chat work "$(uuid 1)"; chat busy "$(uuid 2)"; chat alice-proj-agent "$(uuid 3)"; chat scratch "$(uuid 4)" '2 hours ago'
  sleep 6
  stub_pid=$(pid_in stubborn) print_pid=$(pid_in print-turn) ls_pid=$(pid_in listing)
  tool_pid=$(pgrep -f "^$ON_OLD $WORK/fake/index.js\$" | while read -r p; do pp=$(ps -o ppid= -p "$p" | tr -d ' '); [ "$(readlink "/proc/$pp/exe")" = "$WORK/pi-old/pi" ] && echo "$p"; done | head -n 1)
  policy 200 force "$NEW" 30
  runs; got=$?
  [ "$got" = 0 ] || fail 'force: exits 0' 0 "$got: $(tail -5 "$WORK/err")"
  got=$(report '[.sessions.stopped, .sessions.cut, .sessions.typed, .sessions.resumed, .sessions.fresh, .sessions.other] | join(" ")')
  [ "$got" = '5 1 2 2 2 4' ] || fail 'force: stopped cut typed resumed fresh other' '5 1 2 2 2 4' "$got; $(report .detail)"
  got=$(report '[.panes[] | "\(.session):\(.role):\(.hadConversation):\(.sessionId // "-")"] | sort | join(" ")')
  want="alice-proj-agent:agent:true:$(uuid 3) busy:other:true:$(uuid 2) scratch:other:false:- stubborn:other:false:- work:other:true:$(uuid 1)"
  [ "$got" = "$want" ] || fail 'force: every stopped pane listed, with its chat' "$want" "$got"
  has 'force: a pane with a chat gets cursor-agent --resume typed' "$(pane_text work)" "cursor-agent --resume $(uuid 1)"
  [ "$(pane_cmd work)" = sleep ] || fail 'force: the typed resume took (the new build runs it)' sleep "$(pane_cmd work)"
  for n in scratch stubborn alice-proj-agent; do
    lacks "force: nothing typed into $n" "$(pane_text "$n")" 'cursor-agent --resume'
    [ "$(pane_cmd "$n")" = bash ] || fail "force: $n is left at its shell" bash "$(pane_cmd "$n")"
  done
  is_running "$stub_pid" && fail 'force: a session that ignores SIGTERM is SIGKILLed' killed alive
  [ -n "$print_pid" ] && is_running "$print_pid" || fail 'force: a -p turn in a pane is left alone' alive "gone ($print_pid)"
  [ -n "$ls_pid" ] && is_running "$ls_pid" || fail 'force: a subcommand is left alone' alive "gone ($ls_pid)"
  [ -n "$tool_pid" ] && is_running "$tool_pid" || fail 'force: one another agent (pi) runs is left alone' alive "gone ($tool_pid)"
  is_running "$outside" || fail 'force: one outside tmux is left alone' alive gone
  [ "$(link cursor-agent)" = "$VERSIONS/$NEW/cursor-agent" ] || fail 'force: the links are on the new build' "$VERSIONS/$NEW/cursor-agent" "$(link cursor-agent)"
  kill -KILL "$outside" 2>/dev/null
  teardown

  # A signal while a stopped pane is still going (Bugbot on #995): the report lists it.
  setup
  pane alice-proj-agent STUBBORN=1
  sleep 2; chat alice-proj-agent "$(uuid 51)"; sleep 6
  policy 200 force "$NEW" 0
  run TERMAG_CURSOR_KILL_AFTER=30 TERMAG_POLICY_TIMEOUT=5 & rp=$!
  sleep 5
  kill -TERM "$(pgrep -f "termag-cursor-update --run $RUN_ID")"; wait "$rp"; got=$?
  [ "$got" = 143 ] || fail 'signal: exits 143' 143 "$got"
  got=$(report '[.panes[] | "\(.session):\(.role):\(.sessionId // "-")"] | join(" ")')
  [ "$got" = "alice-proj-agent:agent:$(uuid 51)" ] || fail 'signal: the pane it had stopped is listed' "alice-proj-agent:agent:$(uuid 51)" "$got"
  teardown

  # A pane resumed with --resume <id> by the last update, idle since: its chat
  # has not been written since it started, and is still the pane's (Bugbot on #1080).
  setup
  mkdir -p "$WORK/cwd/resumed"; chat resumed "0000006A-AAAA-4BBB-8CCC-DDDDDDDDDDDD" '2 hours ago'
  PARGS="--resume 0000006A-AAAA-4BBB-8CCC-DDDDDDDDDDDD" pane resumed
  sleep 2
  policy 200 force "$NEW" 0
  runs
  got=$(report '[.panes[] | "\(.session):\(.hadConversation):\(.sessionId // "-")"] | join(" ")')
  # (an id in capitals, as a directory name may have it)
  [ "$got" = "resumed:true:0000006A-AAAA-4BBB-8CCC-DDDDDDDDDDDD" ] || fail 'resumed: the chat it resumed is the pane'"'"'s' "resumed:true:0000006A-AAAA-4BBB-8CCC-DDDDDDDDDDDD" "$got"
  has 'resumed: its chat is resumed again' "$(pane_text resumed)" "cursor-agent --resume 0000006A-AAAA-4BBB-8CCC-DDDDDDDDDDDD"
  teardown

  # On the current build: left alone.
  setup; installed "$NEW"
  BIN="$VERSIONS/$NEW/node" pane current
  sleep 1; cur_pid=$(pid_in current)
  policy 200 force "$NEW" 0
  runs
  is_running "$cur_pid" || fail 'current: a session on the current build is left alone' alive gone
  has 'current: says nothing ran on an old build' "$(report .detail)" 'restart=force(nothing on an old binary)'
  teardown

  # idle: waits for the pane to leave its turn, then stops it; one still in a turn at drainSec is cut.
  setup
  pane busy BUSY_UNTIL="$WORK/done-busy"
  pane stuck BUSY_UNTIL="$WORK/never"
  sleep 1; busy_pid=$(pid_in busy) stuck_pid=$(pid_in stuck)
  policy 200 idle "$NEW" 8
  runs & rp=$!
  sleep 4
  is_running "$busy_pid" || fail 'idle: a pane in a turn is not stopped' alive stopped
  : > "$WORK/done-busy"
  wait "$rp"
  is_running "$busy_pid" && fail 'idle: stopped once out of its turn' stopped alive
  is_running "$stuck_pid" && fail 'idle: one still in a turn at drainSec is cut' stopped alive
  [ "$(report '.sessions.cut')" = 1 ] || fail 'idle: one cut' 1 "$(report .detail)"
  teardown

  # idle: an activity word left on a screen that no longer changes, with no
  # spinner, is not a turn; the pane stops at once (Devin on #1080).
  setup
  pane stale STALE=1
  sleep 1; stale_pid=$(pid_in stale)
  policy 200 idle "$NEW" 30
  t0=$(date +%s); runs; took=$(( $(date +%s) - t0 ))
  is_running "$stale_pid" && fail 'stale word: stopped' stopped alive
  [ "$took" -lt 20 ] || fail 'stale word: does not wait for drainSec' '< 20 s' "${took}s"
  [ "$(report '.sessions.cut')" = 0 ] || fail 'stale word: not counted cut' 0 "$(report .detail)"
  teardown

  # A pane that names its chat in argv keeps that id, store or not, in either
  # case of hex (as the CLI was given it); with none, the store's (Bugbot on #1080).
  setup
  PARGS="--resume $(uuid 71)" pane resume-nostore
  PARGS="--new-session-id $(uuid 72)" pane new-id
  PARGS="--resume $(uuid 73 | tr 'a-f' 'A-F')" pane mixed-case
  pane from-store
  sleep 2; chat from-store "$(uuid 74)"; sleep 6
  policy 200 force "$NEW" 0
  runs
  got=$(report '[.panes[] | "\(.session):\(.hadConversation):\(.sessionId // "-")"] | sort | join(" ")')
  want="from-store:true:$(uuid 74) mixed-case:true:$(uuid 73 | tr 'a-f' 'A-F') new-id:true:$(uuid 72) resume-nostore:true:$(uuid 71)"
  [ "$got" = "$want" ] || fail 'argv ids: each pane keeps the id its argv names, else its store'"'"'s' "$want" "$got"
  has 'argv ids: --resume with no store is resumed' "$(pane_text resume-nostore)" "cursor-agent --resume $(uuid 71)"
  has 'argv ids: a mixed-case id is resumed as given' "$(pane_text mixed-case)" "cursor-agent --resume $(uuid 73 | tr 'a-f' 'A-F')"
  teardown

  # Two panes in one workspace: the newest chat there may be either's, so a
  # guessed one is neither's and no pane resumes it; a pane that named its
  # chat (--resume) keeps it (Devin on #1080).
  setup
  mkdir -p "$WORK/cwd/shared"
  PARGS="--workspace $WORK/cwd/shared" pane guess-a
  PARGS="--workspace $WORK/cwd/shared" pane guess-b
  sleep 2; chat shared "$(uuid 61)"; chat shared "$(uuid 62)"
  PARGS="--workspace $WORK/cwd/shared --resume $(uuid 61)" pane named
  sleep 6
  policy 200 force "$NEW" 0
  runs
  got=$(report '[.panes[] | "\(.session):\(.hadConversation):\(.sessionId // "-")"] | sort | join(" ")')
  want="guess-a:false:- guess-b:false:- named:true:$(uuid 61)"
  [ "$got" = "$want" ] || fail 'shared workspace: guesses dropped, a named chat kept' "$want" "$got"
  for n in guess-a guess-b; do lacks "shared workspace: nothing typed into $n" "$(pane_text "$n")" 'cursor-agent --resume'; done
  has 'shared workspace: the named one resumes its own chat' "$(pane_text named)" "cursor-agent --resume $(uuid 61)"
  teardown
}
if [ "${1:-}" = --sessions ]; then
  sessions_cases
  if [ "$failures" -eq 0 ]; then echo 'ok: termag-cursor-update --run sessions (PID namespace)'; exit 0; fi
  echo "$failures failure(s) in the session cases"; exit 1
fi

# ── the pinned digest (Security review on #1080) ────────────────────────────
# A build with no pin: not downloaded, nothing changed, the run fails.
reset; installed "$OLD"; policy 200 none "$NEW"
grep -v "^$NEW " "$(pins_now)" > "$WORK/pins-without"
PINS_FILE="$WORK/pins-without" run; got=$?
[ "$got" = 0 ] || fail 'unpinned: exits 0 (the build that ran is untouched)' 0 "$got: $(tail -3 "$WORK/err")"
lacks 'unpinned: never downloaded' "$(cat "$STATE/curl-calls")" "lab/$NEW/linux"
[ ! -e "$VERSIONS/$NEW" ] && [ "$(link cursor-agent)" = "$VERSIONS/$OLD/cursor-agent" ] || fail 'unpinned: nothing changed' "$VERSIONS/$OLD/cursor-agent" "$(link cursor-agent)"
[ "$(report .outcome)" = failed ] || fail 'unpinned: reported failed' failed "$(report .outcome)"
has 'unpinned: says why' "$(report .detail)" "install=$OLD->FAILED:unpinned:$NEW"
# With no TERMAG_CURSOR_PINS, the script's own table is what is read: the
# stand-in package for 2026.10.22-27dcf5f is not Cursor's, so its pin is found
# and the digest refuses it (never "unpinned").
reset; installed "$OLD"; policy 200 none "$NEW"
run TERMAG_CURSOR_PINS=
has 'the script'"'"'s pins: found, and the stand-in refused by digest' "$(report .detail)" "install=$OLD->FAILED:digest:$NEW"
# The pin for the stable builds is in the script, for both arches.
for a in x64 arm64; do
  grep -qE "(^|')2026\.10\.22-27dcf5f $a [0-9a-f]{64}('|\$)" "$SCRIPT" || fail "pins: the script pins 2026.10.22-27dcf5f for $a" pinned absent
done
# A package that is not the pinned one: never unpacked or run, nothing changed.
reset; installed "$OLD"; policy 200 none "$NEW"
cp "$(pins_now)" "$WORK/pins-good"; cp "$WORK/pkgs/$NEW.tgz" "$WORK/pkgs/$NEW.tgz.good"
rm -rf "$WORK/evil"; mkdir -p "$WORK/evil"; tar -xzf "$WORK/pkgs/$NEW.tgz.good" -C "$WORK/evil"
printf '#!/bin/sh\n: > "$STATE/evil-ran"\necho %s\n' "$NEW" > "$WORK/evil/dist-package/cursor-agent"
tar -czf "$WORK/pkgs/$NEW.tgz" -C "$WORK/evil" dist-package; rm -f "$STATE/evil-ran"
PINS_FILE="$WORK/pins-good" run; got=$?
mv "$WORK/pkgs/$NEW.tgz.good" "$WORK/pkgs/$NEW.tgz"
[ ! -e "$STATE/evil-ran" ] || fail 'other package: nothing in it runs' 'not run' ran
[ ! -e "$VERSIONS/$NEW" ] && [ "$(link cursor-agent)" = "$VERSIONS/$OLD/cursor-agent" ] || fail 'other package: nothing changed' "$VERSIONS/$OLD/cursor-agent" "$(link cursor-agent)"
for d in "$VERSIONS"/.tmp*; do [ -e "$d" ] && fail 'other package: no download left behind' none "$d"; done
has 'other package: says why' "$(report .detail)" "install=$OLD->FAILED:digest:$NEW"

# ── an exact target, installed and reported ─────────────────────────────────
reset; installed "$OLD"; policy 200 none "$NEW"
run; got=$?
[ "$got" = 0 ] || fail 'target: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'target: asks for the Cursor agent'"'"'s policy for its run' "$(cat "$STATE/curl-calls")" "GET https://orch.example.test/termag/api/tool-update/policy?component=cursor&run=$RUN_ID"
has 'target: the token goes on curl'"'"'s stdin' "$(cat "$STATE/curl-config")" 'Authorization: Bearer tmag_box_token'
lacks 'target: never in an argument' "$(cat "$STATE/curl-args")" 'tmag_box_token'
lacks 'target: never in a log line' "$(cat "$WORK/err")" 'tmag_box_token'
case "$(uname -m)" in x86_64|amd64) a=x64 ;; *) a=arm64 ;; esac
has 'target: downloads that build for this machine' "$(cat "$STATE/curl-calls")" "GET https://downloads.cursor.com/lab/$NEW/linux/$a/agent-cli-package.tar.gz"
[ -x "$VERSIONS/$NEW/cursor-agent" ] || fail 'target: the build is in versions/<build>' present absent
for l in cursor-agent agent; do [ "$(link $l)" = "$VERSIONS/$NEW/cursor-agent" ] || fail "target: $l points at the new build" "$VERSIONS/$NEW/cursor-agent" "$(link $l)"; done
[ -d "$VERSIONS/$OLD" ] || fail 'target: the old build is left for sessions still on it' present absent
for d in "$VERSIONS"/.tmp*; do [ -e "$d" ] && fail 'target: no download directory left behind' none "$d"; done
has 'target: verified' "$(cat "$WORK/err")" "cursor-agent is now build $NEW, verified"
got=$(report '[.component, .outcome, .target, .fromVersion, .toVersion] | join(" ")')
[ "$got" = "cursor updated $NEW $OLD $NEW" ] || fail 'target: the report' "cursor updated $NEW $OLD $NEW" "$got"

# At the target: nothing downloaded. Above it: nothing moves down.
reset; installed "$NEW"; policy 200 none "$NEW"; run
lacks 'current: downloads nothing' "$(cat "$STATE/curl-calls")" 'downloads.cursor.com'
[ "$(report .outcome)" = current ] || fail 'current: outcome current' current "$(report .outcome)"
reset; installed "$LATER"; policy 200 none "$NEW"; run
lacks 'no downgrade: downloads nothing' "$(cat "$STATE/curl-calls")" 'downloads.cursor.com'

# Another build of the target's day: installed, not taken as at it (Bugbot on #1080).
SAMEDAY=2026.10.22-0a1b2c3; mkpkg "$SAMEDAY"
reset; installed "$SAMEDAY"; policy 200 none "$NEW"; run; got=$?
[ "$got" = 0 ] || fail 'same day: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ "$(link cursor-agent)" = "$VERSIONS/$NEW/cursor-agent" ] || fail 'same day: the build asked for is installed' "$NEW" "$(link cursor-agent)"
lacks 'same day: not a downgrade' "$(cat "$WORK/err")" 'would move it down'
# Against the floor the day counts: latest naming another build of the floor's
# day is not below it, so it is installed, and the box is not below-floor
# (Bugbot on #1080).
PREFLOOR=2025.09.01-aaaaaaa FLOORDAY=2025.09.17-0000001; mkpkg "$PREFLOOR"; mkpkg "$FLOORDAY"
reset; installed "$PREFLOOR"; echo "$FLOORDAY" > "$STATE/latest"; policy 200 none latest; run; got=$?
[ "$got" = 0 ] || fail 'floor day: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ "$(link cursor-agent)" = "$VERSIONS/$FLOORDAY/cursor-agent" ] || fail 'floor day: the build of the floor'"'"'s day is installed' "$FLOORDAY" "$(link cursor-agent)"
has 'floor day: not below the floor' "$(cat "$WORK/err")" 'state=ok'

# A leftover directory of the target that nothing links (Cursor's own updater
# relinked away from it, and a session may still run from it): kept aside,
# never deleted (Bugbot on #1080).
reset; installed "$OLD"; mkdir -p "$VERSIONS/$NEW"; echo in-use > "$VERSIONS/$NEW/marker"; policy 200 none "$NEW"
# A process still runs from it, so the prune after the install keeps it.
cp "$(command -v sleep)" "$VERSIONS/$NEW/node"; user_pid=$( { "$VERSIONS/$NEW/node" 30 </dev/null >/dev/null 2>&1 & echo "$!"; } )
run; got=$?
kill "$user_pid" 2>/dev/null
[ "$got" = 0 ] || fail 'unlinked leftover: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ "$(link cursor-agent)" = "$VERSIONS/$NEW/cursor-agent" ] && [ -x "$VERSIONS/$NEW/cursor-agent" ] || fail 'unlinked leftover: the new build is installed in its place' "$VERSIONS/$NEW" "$(ls -a "$VERSIONS")"
kept=$(ls -d "$VERSIONS/.$NEW".unlinked-* 2>/dev/null | head -n 1)
[ -n "$kept" ] && [ "$(cat "$kept/marker" 2>/dev/null)" = in-use ] || fail 'unlinked leftover: kept aside, not deleted' ".$NEW.unlinked-<pid>/marker" "$(ls -a "$VERSIONS")"

# A notice ahead of the version naming another build (an update or migration
# message) never passes for the version: the build installs and verifies
# (Bugbot on #1080).
reset; installed "$OLD"; policy 200 none "$NEW"; printf 'Update available: %s (run cursor-agent update)\n' "$LATER" > "$STATE/notice"
run; got=$?
rm -f "$STATE/notice"
[ "$got" = 0 ] || fail 'notice: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ "$(link cursor-agent)" = "$VERSIONS/$NEW/cursor-agent" ] || fail 'notice: the build asked for is installed' "$NEW" "$(link cursor-agent)"
has 'notice: verified' "$(cat "$WORK/err")" "cursor-agent is now build $NEW, verified"

# The build moved aside cannot go back into its directory: $dir is never left
# empty, and a cursor-agent always runs (Bugbot on #1080).
# (a) The relink fails, then the build that ran cannot move back: the new
# build, verified in its package, stays where the links point.
reset; installed "$NEW"; policy 200 none "$NEW"
printf 'cursor asked for %s; an earlier run\n' "$NEW" > "$HOME_DIR/.termag/cursor-update.rejected"
printf '#!/bin/sh\ncase "$*" in *-Tf*/agent.tmp.*) exit 1 ;; *.replaced-*" $VERSIONS/$NEW") exit 1 ;; esac\nexec /bin/mv "$@"\n' | sed "s#\$VERSIONS#$VERSIONS#; s#\$NEW#$NEW#" > "$STUB/mv"; chmod +x "$STUB/mv"
run
rm -f "$STUB/mv"
[ -x "$VERSIONS/$NEW/cursor-agent" ] && [ "$("$HOME_DIR/.local/bin/cursor-agent" --version)" = "$NEW" ] || fail 'relink and put-back fail: a cursor-agent still runs' "$NEW" "$(ls -a "$VERSIONS"; "$HOME_DIR/.local/bin/cursor-agent" --version 2>&1)"
# (b) A live mismatch, then the build that ran cannot move back: the links
# name it where it was moved aside.
reset; installed "$NEW"; policy 200 none "$NEW"
sed -i "s|cat \"\$STATE/live-says\"|echo $NEW|" "$VERSIONS/$NEW/cursor-agent"
printf 'cursor asked for %s; an earlier run\n' "$NEW" > "$HOME_DIR/.termag/cursor-update.rejected"
printf '2026.10.23-5555555\n' > "$STATE/live-says"
printf '#!/bin/sh\ncase "$*" in *.replaced-*" $VERSIONS/$NEW") exit 1 ;; esac\nexec /bin/mv "$@"\n' | sed "s#\$VERSIONS#$VERSIONS#; s#\$NEW#$NEW#" > "$STUB/mv"; chmod +x "$STUB/mv"
run; got=$?
rm -f "$STUB/mv" "$STATE/live-says"
[ "$("$HOME_DIR/.local/bin/cursor-agent" --version 2>/dev/null)" = "$NEW" ] || fail 'mismatch and put-back fail: the build that ran runs from where it was moved aside' "$NEW" "$(link cursor-agent); $("$HOME_DIR/.local/bin/cursor-agent" --version 2>&1)"
has 'mismatch and put-back fail: says so' "$(cat "$WORK/err")" 'where it was moved aside'

# latest is the newest pinned build: Cursor naming a newer one that is not
# pinned yet installs the newest pinned one, and says so (a review on #1080).
reset; installed "$OLD"; echo 2026.12.01-abcdef0 > "$STATE/latest"; policy 200 none latest
run; got=$?
[ "$got" = 0 ] || fail 'latest, newer unpinned named: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ "$(link cursor-agent)" = "$VERSIONS/$LATER/cursor-agent" ] || fail 'latest, newer unpinned named: the newest pinned build' "$LATER" "$(link cursor-agent)"
lacks 'latest, newer unpinned named: never downloads it' "$(cat "$STATE/curl-calls")" 'lab/2026.12.01-abcdef0/'
has 'latest, newer unpinned named: says a pin is due' "$(cat "$WORK/err")" 'names build 2026.12.01-abcdef0, which is not pinned yet'
[ "$(report .outcome)" = updated ] || fail 'latest, newer unpinned named: updated' updated "$(report .outcome)"
# A box ahead of every pin (Cursor's own updater): current, left alone, marked.
grep -E "^($OLD|$NEW) " "$(pins_now)" > "$WORK/pins-two"
reset; installed "$LATER"; policy 200 none latest
PINS_FILE="$WORK/pins-two" run; got=$?
[ "$got" = 0 ] && [ "$(report .outcome)" = current ] || fail 'ahead of the pins: current' "0 current" "$got $(report .outcome)"
[ "$(link cursor-agent)" = "$VERSIONS/$LATER/cursor-agent" ] || fail 'ahead of the pins: left alone' "$LATER" "$(link cursor-agent)"
has 'ahead of the pins: marked' "$(report .detail)" "install=$LATER(ahead-of-pins)"
lacks 'ahead of the pins: downloads nothing' "$(cat "$STATE/curl-calls")" 'downloads.cursor.com'
# On the newest pinned build: current.
reset; installed "$NEW"; policy 200 none latest
PINS_FILE="$WORK/pins-two" run
[ "$(report .outcome)" = current ] || fail 'on the newest pin: current' current "$(report .outcome): $(report .detail)"

# ── builds pruned once one is verified (a review on #1080) ──────────────────
# The new build and the one that ran stay; an older unlinked build, copies set
# aside, and a stopped run's download go; one a process runs from stays.
reset; installed "$OLD"; policy 200 none "$NEW"
for d in 2026.09.01-1111111 ".$OLD.replaced-99" ".$OLD.rejected-98" .tmp-termag-2026.09.30-aaaaaaa-97 2026.09.02-2222222; do mkdir -p "$VERSIONS/$d"; done
: > "$VERSIONS/.tmp-termag-2026.09.30-aaaaaaa-97.tgz"
cp "$(command -v sleep)" "$VERSIONS/2026.09.02-2222222/node"; busy_pid=$( { "$VERSIONS/2026.09.02-2222222/node" 30 </dev/null >/dev/null 2>&1 & echo "$!"; } )
run; got=$?
kill "$busy_pid" 2>/dev/null
[ "$got" = 0 ] || fail 'prune: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ -d "$VERSIONS/$NEW" ] && [ -d "$VERSIONS/$OLD" ] || fail 'prune: the new build and the one that ran stay' "$NEW $OLD" "$(ls -a "$VERSIONS")"
for d in 2026.09.01-1111111 ".$OLD.replaced-99" ".$OLD.rejected-98" .tmp-termag-2026.09.30-aaaaaaa-97 .tmp-termag-2026.09.30-aaaaaaa-97.tgz; do
  [ ! -e "$VERSIONS/$d" ] || fail "prune: $d goes" absent present
done
[ -d "$VERSIONS/2026.09.02-2222222" ] || fail 'prune: a build a process runs from stays' present absent
# The versions directory reached through a link ($HOME a symlink): /proc and
# the links name builds by their canonical paths, so the prune compares
# canonical paths. The build a process runs from and the one that ran stay.
ln -sfn "$HOME_DIR" "$WORK/home-link"
reset; installed "$OLD"; policy 200 none "$NEW"
for d in 2026.09.01-1111111 2026.09.02-2222222; do mkdir -p "$VERSIONS/$d"; done
cp "$(command -v sleep)" "$VERSIONS/2026.09.02-2222222/node"; busy_pid=$( { "$VERSIONS/2026.09.02-2222222/node" 30 </dev/null >/dev/null 2>&1 & echo "$!"; } )
run HOME="$WORK/home-link"; got=$?
kill "$busy_pid" 2>/dev/null
[ "$got" = 0 ] || fail 'prune via a symlink: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ -d "$VERSIONS/2026.09.02-2222222" ] || fail 'prune via a symlink: a build a process runs from stays' present absent
[ -d "$VERSIONS/$NEW" ] && [ -d "$VERSIONS/$OLD" ] || fail 'prune via a symlink: the new build and the one that ran stay' "$NEW $OLD" "$(ls -a "$VERSIONS")"
[ ! -e "$VERSIONS/2026.09.01-1111111" ] || fail 'prune via a symlink: an unused build still goes' absent present
# A failed install prunes nothing.
reset; installed "$OLD"; policy 200 none "$NEW"; mkdir -p "$VERSIONS/2026.09.01-1111111"; : > "$STATE/dl-fail"
run
[ -d "$VERSIONS/2026.09.01-1111111" ] || fail 'prune: a failed install removes nothing' present absent
# A signal mid-download: the download goes with the run (the lib's TU_TMP).
reset; installed "$OLD"; policy 200 none "$NEW"; : > "$STATE/dl-slow"
run & rp=$!
for _ in $(seq 1 100); do ls -d "$VERSIONS"/.tmp-termag-* >/dev/null 2>&1 && break; sleep 0.1; done
sleep 1; kill -TERM "$(pgrep -f "termag-cursor-update --run $RUN_ID" | head -n 1)"; wait "$rp"; got=$?
rm -f "$STATE/dl-slow"
[ "$got" = 143 ] || fail 'signal mid-download: exits 143' 143 "$got"
for d in "$VERSIONS"/.tmp-termag-*; do [ -e "$d" ] && fail 'signal mid-download: nothing left behind' none "$d"; done
[ "$(link cursor-agent)" = "$VERSIONS/$OLD/cursor-agent" ] || fail 'signal mid-download: the build that ran stays linked' "$OLD" "$(link cursor-agent)"

# latest: the installer's build, asked for once.
reset; installed "$OLD"; echo "$LATER" > "$STATE/latest"; policy 200 none latest
run; got=$?
[ "$got" = 0 ] || fail 'latest: exits 0' 0 "$got: $(cat "$WORK/err")"
[ "$(grep -c 'GET https://cursor.com/install' "$STATE/curl-calls")" = 1 ] || fail 'latest: asks the installer once' 1 "$(cat "$STATE/curl-calls")"
[ "$(link cursor-agent)" = "$VERSIONS/$LATER/cursor-agent" ] || fail 'latest: installs what the installer names' "$LATER" "$(link cursor-agent)"
[ "$(report .target)" = "$LATER" ] || fail 'latest: the report names the build' "$LATER" "$(report .target)"

# ── never installed, rejected, restored, quarantined ────────────────────────
# A package that says another build never goes live.
mkpkg "$NEW" 2026.10.23-1111111
reset; installed "$OLD"; policy 200 none "$NEW"
run; got=$?
[ "$(link cursor-agent)" = "$VERSIONS/$OLD/cursor-agent" ] || fail 'other package: the links stay on the build that ran' "$OLD" "$(link cursor-agent)"
[ ! -e "$VERSIONS/$NEW" ] || fail 'other package: not moved into versions' absent present
[ ! -e "$HOME_DIR/.termag/cursor-update.rejected" ] || fail 'other package: nothing live to reject, nothing recorded' absent present
[ "$(report .outcome)" = failed ] || fail 'other package: reported failed' failed "$(report .outcome)"
has 'other package: says so' "$(cat "$WORK/err")" "package says 2026.10.23-1111111; not installed"
mkpkg "$NEW"
# Linked, but what a session starts says another: rejected, links put back.
reset; installed "$OLD"; policy 200 none "$NEW"
printf '2026.10.23-2222222\n' > "$STATE/live-says"
# The old build must still verify as itself once the links go back: give it its own answer.
sed -i "s|cat \"\$STATE/live-says\"|echo $OLD|" "$VERSIONS/$OLD/cursor-agent"
run; got=$?
[ "$got" = 3 ] || fail 'live mismatch: rejected, exits 3' 3 "$got: $(tail -3 "$WORK/err")"
grep -q '^cursor ' "$HOME_DIR/.termag/cursor-update.rejected" 2>/dev/null || fail 'live mismatch: recorded' 'cursor ...' "$(cat "$HOME_DIR/.termag/cursor-update.rejected" 2>/dev/null)"
[ "$(link cursor-agent)" = "$VERSIONS/$OLD/cursor-agent" ] || fail 'live mismatch: the links are back on the build that ran' "$OLD" "$(link cursor-agent)"
has 'live mismatch: restored, verified' "$(cat "$WORK/err")" "the links are back at build $OLD, verified"
# The next run, with a package that verifies, installs it and clears the record.
rm -f "$STATE/live-says"
run; got=$?
[ "$got" = 0 ] || fail 'rejected, then verified: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ ! -e "$HOME_DIR/.termag/cursor-update.rejected" ] || fail 'rejected, then verified: the record is gone' absent present
[ "$(link agent)" = "$VERSIONS/$NEW/cursor-agent" ] || fail 'rejected, then verified: linked' "$NEW" "$(link agent)"
# The build being replaced is the one linked (a retry of the same build after
# a rejection, or one Cursor's own updater linked): if the new download fails
# its live check, that build goes back, never no CLI at all (Bugbot on #1080).
reset; installed "$NEW"; policy 200 none "$NEW"
sed -i "s|cat \"\$STATE/live-says\"|echo $NEW|" "$VERSIONS/$NEW/cursor-agent"
mkdir -p "$HOME_DIR/.termag"; printf 'cursor asked for %s; an earlier run\n' "$NEW" > "$HOME_DIR/.termag/cursor-update.rejected"
printf '2026.10.23-3333333\n' > "$STATE/live-says"
run; got=$?
[ "$got" = 3 ] || fail 'same build, live mismatch: rejected, exits 3' 3 "$got: $(tail -3 "$WORK/err")"
[ "$(link cursor-agent)" = "$VERSIONS/$NEW/cursor-agent" ] && [ "$(link agent)" = "$VERSIONS/$NEW/cursor-agent" ] || fail 'same build, live mismatch: both links still name a build' "$VERSIONS/$NEW/cursor-agent" "$(link cursor-agent) $(link agent)"
[ "$("$HOME_DIR/.local/bin/cursor-agent" --version)" = "$NEW" ] || fail 'same build, live mismatch: the build that ran is the one linked' "$NEW" "$("$HOME_DIR/.local/bin/cursor-agent" --version 2>&1)"
has 'same build, live mismatch: says it put it back' "$(cat "$WORK/err")" "build $NEW is back in place and linked, verified"
rm -f "$STATE/live-says"
# The linked build is moved aside and the new one cannot be moved in: the
# linked one goes back, so the links never dangle (Bugbot on #1080).
reset; installed "$NEW"; policy 200 none "$NEW"
mkdir -p "$HOME_DIR/.termag"; printf 'cursor asked for %s; an earlier run\n' "$NEW" > "$HOME_DIR/.termag/cursor-update.rejected"
printf '#!/bin/sh\ncase "$*" in *.tmp-termag-*) exit 1 ;; esac\nexec /bin/mv "$@"\n' > "$STUB/mv"; chmod +x "$STUB/mv"
run; got=$?
rm -f "$STUB/mv"
[ "$(link cursor-agent)" = "$VERSIONS/$NEW/cursor-agent" ] && [ -x "$VERSIONS/$NEW/cursor-agent" ] || fail 'move fails: the linked build is back where the links point' "$VERSIONS/$NEW/cursor-agent" "$(ls -a "$VERSIONS")"
has 'move fails: says so' "$(cat "$WORK/err")" "cannot move build $NEW into"
for d in "$VERSIONS"/.tmp* "$VERSIONS"/.*.replaced-*; do [ -e "$d" ] && fail 'move fails: nothing left aside' none "$d"; done
# The linked build cannot be moved aside: nothing changes.
reset; installed "$NEW"; policy 200 none "$NEW"
printf 'cursor asked for %s; an earlier run\n' "$NEW" > "$HOME_DIR/.termag/cursor-update.rejected"
printf '#!/bin/sh\ncase "$*" in *.replaced-*) exit 1 ;; esac\nexec /bin/mv "$@"\n' > "$STUB/mv"; chmod +x "$STUB/mv"
run; got=$?
rm -f "$STUB/mv"
[ "$(link cursor-agent)" = "$VERSIONS/$NEW/cursor-agent" ] && [ -x "$VERSIONS/$NEW/cursor-agent" ] || fail 'aside fails: the linked build is untouched' "$VERSIONS/$NEW" "$(ls -a "$VERSIONS" "$VERSIONS/$NEW")"
has 'aside fails: says so' "$(cat "$WORK/err")" "cannot move the linked build $NEW aside; nothing changed"
for d in "$VERSIONS"/.tmp*; do [ -e "$d" ] && fail 'aside fails: no download directory left behind' none "$d"; done
# The links cannot all be switched (the second rename fails): not a mismatch.
# Both stay on, or go back to, the build that ran; none is removed (Bugbot on #1080).
reset; installed "$OLD"; policy 200 none "$NEW"
printf '#!/bin/sh\ncase "$*" in *-Tf*/agent.tmp.*) exit 1 ;; esac\nexec /bin/mv "$@"\n' > "$STUB/mv"; chmod +x "$STUB/mv"
run; got=$?
rm -f "$STUB/mv"
for l in cursor-agent agent; do [ "$(link $l)" = "$VERSIONS/$OLD/cursor-agent" ] || fail "relink fails: $l stays on the build that ran" "$VERSIONS/$OLD/cursor-agent" "$(link $l)"; done
[ ! -e "$HOME_DIR/.termag/cursor-update.rejected" ] || fail 'relink fails: nothing rejected' absent "$(cat "$HOME_DIR/.termag/cursor-update.rejected")"
[ "$(report .outcome)" = failed ] || fail 'relink fails: reported failed' failed "$(report .outcome)"
has 'relink fails: says so' "$(cat "$WORK/err")" "could not point the links at build $NEW"
# The linked build is replaced, fails its live check, and is put back, but
# the links cannot be switched back to it: they already name its directory,
# so they stay, and the build put back is never quarantined (Bugbot on #1080).
reset; installed "$NEW"; policy 200 none "$NEW"
sed -i "s|cat \"\$STATE/live-says\"|echo $NEW|" "$VERSIONS/$NEW/cursor-agent"
printf 'cursor asked for %s; an earlier run\n' "$NEW" > "$HOME_DIR/.termag/cursor-update.rejected"
printf '2026.10.23-4444444\n' > "$STATE/live-says"; rm -f "$STATE/mv-n"
printf '#!/bin/sh\ncase "$*" in *-Tf*) n=$(( $(cat "$STATE/mv-n" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE/mv-n"; [ $n -gt 2 ] && exit 1 ;; esac\nexec /bin/mv "$@"\n' > "$STUB/mv"; chmod +x "$STUB/mv"
run; got=$?
rm -f "$STUB/mv" "$STATE/live-says" "$STATE/mv-n"
for l in cursor-agent agent; do [ "$(link $l)" = "$VERSIONS/$NEW/cursor-agent" ] || fail "restore relink fails: $l kept" "$VERSIONS/$NEW/cursor-agent" "$(link $l)"; done
[ -x "$VERSIONS/$NEW/cursor-agent" ] && [ "$("$HOME_DIR/.local/bin/cursor-agent" --version)" = "$NEW" ] || fail 'restore relink fails: the build put back still runs' "$NEW" "$(ls -l "$VERSIONS/$NEW" 2>&1)"
ls "$VERSIONS"/.*.rejected-*/cursor-agent.rejected >/dev/null 2>&1 || fail 'restore relink fails: the rejected download is quarantined' 'cursor-agent.rejected' "$(ls -a "$VERSIONS")"
# No build that ran to go back to: quarantined, the links removed.
reset; rm -rf "$VERSIONS"; rm -f "$HOME_DIR/.local/bin/cursor-agent" "$HOME_DIR/.local/bin/agent"; policy 200 none "$NEW"
printf '2026.10.23-2222222\n' > "$STATE/live-says"
run; got=$?
[ "$got" = 3 ] || fail 'quarantine: rejected, exits 3' 3 "$got"
[ ! -e "$HOME_DIR/.local/bin/cursor-agent" ] && [ ! -e "$HOME_DIR/.local/bin/agent" ] || fail 'quarantine: no link left to the rejected build' 'none' "$(ls -l "$HOME_DIR/.local/bin")"
[ -e "$VERSIONS/$NEW/cursor-agent.rejected" ] && [ ! -x "$VERSIONS/$NEW/cursor-agent.rejected" ] || fail 'quarantine: renamed, not executable' 'cursor-agent.rejected' "$(ls -l "$VERSIONS/$NEW" 2>&1)"
has 'quarantine: the summary says so' "$(cat "$WORK/err")" 'pin-mismatch,quarantined'
# A download that fails changes nothing.
reset; installed "$OLD"; : > "$STATE/dl-fail"; policy 200 none "$NEW"
run
[ "$(link cursor-agent)" = "$VERSIONS/$OLD/cursor-agent" ] || fail 'download fails: the links stay' "$OLD" "$(link cursor-agent)"
has 'download fails: says FAILED' "$(cat "$WORK/err")" "install=$OLD->FAILED"
for d in "$VERSIONS"/.tmp*; do [ -e "$d" ] && fail 'download fails: nothing left behind' none "$d"; done

# ── no policy, a run not started, the lock, usage ───────────────────────────
for case in refused unreadable null; do
  reset; installed "$OLD"
  case $case in
    refused) policy 403 force ;;
    unreadable) printf 200 > "$STATE/policy-code"; printf 'not json' > "$STATE/policy-body" ;;
    null) policy 200 force "$NEW" 5 null ;;
  esac
  run; got=$?
  lacks "no policy ($case): downloads nothing" "$(cat "$STATE/curl-calls")" 'downloads.cursor.com'
  [ "$got" = 0 ] || fail "no policy ($case): exits 0" 0 "$got"
  # Nothing installed or checked: the admin's update did not happen (Bugbot on #1080).
  [ "$case" = null ] || [ "$(report .outcome)" = failed ] || fail "no policy ($case): reported failed, never current" failed "$(report .outcome)"
done
has 'run null: says why' "$(cat "$WORK/err")" "the orchestrator did not start run $RUN_ID"
reset; installed "$OLD"; policy 403 force; run
[ "$(report 'has("target")')" = false ] || fail 'no policy: the report names no target (Bugbot on #995)' 'no target' "$(report .target)"
reset; installed "$OLD"; policy 200 none "$NEW"; mkdir -p "$HOME_DIR/.termag"
( exec 9>"$HOME_DIR/.termag/cursor-update.lock"; flock 9; sleep 4 ) & holder=$!
sleep 0.5
run; wait "$holder"
lacks 'lock held: downloads nothing' "$(cat "$STATE/curl-calls")" 'downloads.cursor.com'
[ "$(report .outcome)" = failed ] || fail 'lock held: the run did not happen, reported failed (Bugbot on #995)' failed "$(report .outcome)"
has 'lock held: the detail says why' "$(report .detail)" 'lock=held-by-another-run'
for a in '' '--run' '--run short' "--run $RUN_ID extra" '--boot'; do
  ARGS="${a:- }" run; got=$?
  [ "$got" = 2 ] || fail "usage '$a': exits 2" 2 "$got"
done

# ── the session cases ───────────────────────────────────────────────────────
if ! command -v tmux >/dev/null 2>&1; then
  echo 'skip: session cases need tmux'
elif ! sudo -n true 2>/dev/null || ! command -v unshare >/dev/null 2>&1 || ! command -v setpriv >/dev/null 2>&1; then
  echo 'skip: session cases need sudo -n, unshare and setpriv (a private PID namespace)'
else
  # shellcheck disable=SC2024 # the output file is this user's, not root's
  sudo -n unshare --pid --fork --mount-proc setpriv --reuid="$(id -u)" --regid="$(id -g)" --init-groups \
    env -i PATH=/usr/bin:/bin HOME="$WORK/ns-home" TMPDIR="${TMPDIR:-/tmp}" bash "$0" --sessions > "$WORK/sessions.out" 2>&1
  rc=$?
  cat "$WORK/sessions.out"
  [ "$rc" = 0 ] || failures=$((failures + 1))
fi

if [ "$failures" -eq 0 ]; then
  echo "ok: termag-cursor-update"
else
  echo "$failures failure(s)"
  exit 1
fi
