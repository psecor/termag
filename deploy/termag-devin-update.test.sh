#!/bin/sh
# Tests deploy/termag-devin-update, the box's Devin CLI updater,
# on deploy/termag-tool-update-lib, with curl (the
# release manifests, the bundles and the orchestrator) stubbed on PATH and the
# CLI laid out as its installer lays it out (_versions/<version>, `current`,
# ~/.local/bin/devin):
#
#   * --run asks for the Devin CLI's policy (component=devin) with the agent
#     token on curl's stdin, never in an argument or a log line
#   * an exact target is read from its own manifest, downloaded for this
#     machine, checked against the manifest's SHA-256 and by its own
#     devin --version, moved into _versions/<version> with the installer's
#     distribution marker, and `current` pointed at it; the report says devin,
#     the versions before and after; at the target nothing is downloaded, and
#     nothing moves down
#   * latest is current/manifest.json's version, asked for once
#   * a bundle whose digest does not match, or that says another version, or
#     a manifest that does not name the version asked for, is never installed
#   * a version that, once current, is not what a session starts is rejected
#     (exit 3, recorded), and `current` goes back to the version that ran,
#     verified (the one it pointed at moved back if the same version was being
#     replaced), or, with none, the new one is quarantined and the links
#     removed; a later verified install clears the record
#   * a download that fails changes nothing
#   * no policy, or a run the orchestrator did not start, installs nothing
#   * the lock held by another run: it installs nothing; bad usage exits 2
#   * the sessions, in a private PID namespace (sudo -n unshare; skipped
#     without it or tmux), with fake Devin CLIs (copies of bash as a version's
#     bin/devin) in real tmux panes and a real session store (sessions.db):
#     force stops every pane's own session and cuts the one in a turn; a pane
#     with a session active since it started gets `devin --resume <id>` typed;
#     an agent pane is listed with its session id and never typed into; a -p
#     turn, the acp subcommand, one another agent runs and one outside tmux
#     are left alone; idle waits until the pane
#     is out of its turn, and cuts one still in a turn at drainSec
#
# Run: sh deploy/termag-devin-update.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-devin-update"
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
VERSIONS="$HOME_DIR/.local/share/devin/cli/_versions"
PKGS="$WORK/pkgs"
mkdir -p "$HOME_DIR/.local/bin" "$STUB" "$STATE" "$VERSIONS" "$PKGS"
export STATE PKGS
case "$(uname -m)" in x86_64|amd64) T=x86_64-unknown-linux ;; *) T=aarch64-unknown-linux ;; esac
export T

OLD=3000.11.92
NEW=3000.11.234
LATER=3000.11.240

# A bundle as Devin publishes it: bin/devin and share/. Its devin says VERSION,
# or SAYS: from its download directory (_<v>.termag-*.tmp) always SAYS, once
# moved $STATE/live-says when that exists. `--resume` stays up.
mkpkg() {  # mkpkg VERSION [SAYS]
  d="$WORK/pkgsrc/$1"; rm -rf "$d"; mkdir -p "$d/bin" "$d/share/man/man1"
  cat > "$d/bin/devin" <<EOF
#!/bin/sh
[ "\$1" = --resume ] && exec sleep 300
[ "\$1" = --version ] || exit 0
case "\$(readlink -f "\$0")" in
  *.termag-*.tmp/*) echo "devin ${2:-$1} (0123456789ab)" ;;
  *) if [ -s "\$STATE/live-says" ]; then echo "devin \$(cat "\$STATE/live-says") (0123456789ab)"; else echo "devin ${2:-$1} (0123456789ab)"; fi ;;
esac
EOF
  chmod +x "$d/bin/devin"
  tar -czf "$PKGS/$1.tgz" -C "$d" bin share
}
# installed VERSION: that version laid out and current, as the installer leaves it.
installed() {
  rm -rf "$VERSIONS"; mkdir -p "$VERSIONS/$1"
  tar -xzf "$PKGS/$1.tgz" -C "$VERSIONS/$1"; echo curl-bash > "$VERSIONS/$1/distribution"
  ln -sfn "$1" "$VERSIONS/current"
  ln -sfn "$VERSIONS/current/bin/devin" "$HOME_DIR/.local/bin/devin"
}
mkpkg "$OLD"; mkpkg "$NEW"; mkpkg "$LATER"

# curl: a version's manifest names its bundle and the bundle's digest
# ($STATE/bad-sha: a wrong one; $STATE/bad-manifest: another version);
# current/manifest.json is $STATE/latest's; a bundle download copies it (fails
# while $STATE/dl-fail exists); the orchestrator as in the other updaters' tests.
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
manifest() {
  [ -f "$PKGS/$1.tgz" ] || exit 22
  sum=$(sha256sum "$PKGS/$1.tgz" | cut -d' ' -f1)
  [ -e "$STATE/bad-sha" ] && sum=0000000000000000000000000000000000000000000000000000000000000000
  v=$1; [ -e "$STATE/bad-manifest" ] && v=1.2.3
  printf '{"version":"%s","platforms":{"%s":{"url":"https://static.devin.ai/cli/%s/devin-%s-%s.tar.gz","sha256":"%s"}}}' "$v" "$T" "$1" "$1" "$T" "$sum" > "$out"
}
case "$url" in
  https://static.devin.ai/cli/current/manifest.json) manifest "$(cat "$STATE/latest")" ;;
  https://static.devin.ai/cli/*/manifest.json) v=${url#https://static.devin.ai/cli/}; manifest "${v%%/*}" ;;
  https://static.devin.ai/cli/*/devin-*.tar.gz)
    [ -e "$STATE/dl-fail" ] && exit 22
    # $STATE/dl-slow: a partial download, then a slow one.
    [ -e "$STATE/dl-slow" ] && { echo partial > "$out"; sleep 6; }
    v=${url#https://static.devin.ai/cli/}; v=${v%%/*}
    [ -f "$PKGS/$v.tgz" ] || exit 22
    cp "$PKGS/$v.tgz" "$out" ;;
  */tool-update/policy\?*)
    [ -e "$STATE/policy-down" ] && exit 7
    cat "$STATE/policy-body" > "$out"; printf '%s' "$(cat "$STATE/policy-code")" ;;
  */tool-update/report)
    printf '%s\n' "$data" > "$STATE/report-body"; : > "$out"; printf 204 ;;
  *) exit 6 ;;
esac
EOF
chmod +x "$STUB/curl"

RUN_ID=cmvtrun0000000000000000004
printf '{"token":"tmag_box_token","termag_url":"wss://orch.example.test/termag/ws/agent"}\n' > "$WORK/agent.config.json"
policy() {  # policy CODE [RESTART [TARGET [DRAIN [RUN]]]]
  printf '%s' "$1" > "$STATE/policy-code"
  printf '{"floor":"3000.11.92","target":"%s","restart":"%s","drainSec":%s,"run":%s}' \
    "${3:-$NEW}" "${2:-none}" "${4:-5}" "${5:-{\"id\":\"$RUN_ID\",\"component\":\"devin\"\}}" > "$STATE/policy-body"
}
reset() {
  rm -f "$STATE/curl-calls" "$STATE/curl-args" "$STATE/curl-config" "$STATE/report-body" "$STATE/policy-down" "$STATE/dl-fail" \
    "$STATE/live-says" "$STATE/bad-sha" "$STATE/bad-manifest" "$STATE/dl-slow" "$HOME_DIR/.termag/devin-update.rejected"
  echo "$NEW" > "$STATE/latest"
}
run() {
  env -i PATH="$STUB:/usr/bin:/bin" HOME="$HOME_DIR" STATE="$STATE" PKGS="$PKGS" T="$T" \
    TERMAG_DEVIN_LOCK_WAIT=1 TERMAG_AGENT_CONFIG="$WORK/agent.config.json" "$@" bash "$SCRIPT" ${ARGS:---run $RUN_ID} 2>"${ERRF:-$WORK/err}"
}
report() { jq -r "$1" "$STATE/report-body" 2>/dev/null; }
cur() { readlink "$VERSIONS/current" 2>/dev/null; }

# ── the sessions, in a private PID namespace ────────────────────────────────
sessions_cases() {
  [ "$$" = 1 ] || { echo 'FAIL: the session cases run only as PID 1 of their own PID namespace'; exit 1; }
  command -v python3 >/dev/null 2>&1 || { echo 'skip: the session cases need python3 (the session store)'; return 0; }
  S="$WORK/tmux.sock"
  # fake-devin.sh, run by a copy of bash as the old version's bin/devin:
  # BUSY_UNTIL (a file: a tool line until it exists, then the prompt),
  # STUBBORN=1 (ignores SIGTERM).
  mkdir -p "$WORK/fake"
  # BUSY_AS: what the turn shows (tool: a tool line; compose: a composing
  # line; long: a tool line scrolled far up a long transcript; ask: the select prompt;
  # scope: the newer approval list, whose first line starts with the ❭ glyph;
  # wrapped: that list on a narrow pane, cursor on Deny, its footer split over lines).
  cat > "$WORK/fake/fake-devin.sh" <<'EOF'
if [ -n "${STUBBORN:-}" ]; then trap '' TERM; else trap 'exit 0' TERM; fi
shown=
busy_screen() {
  printf '\033[2J\033[H'
  case "${BUSY_AS:-tool}" in
    tool) printf '\342\217\272 Running npm test\n' ;;
    compose) printf "  Let me look at the failing test first.\n" ;;
    guide) printf '  \342\217\272 Ran npm test\n\n\342\235\255 Guide Devin while it works\n' ;;
    long) printf '\342\217\272 Ran npm test\n'; i=0; while [ $i -lt 30 ]; do echo "  test $i ... ok"; i=$((i + 1)); done ;;
    ask) printf 'Run rm -rf build?\n  1 Yes\n  2 No\n \342\206\221\342\206\223 select \302\267 \342\206\265 confirm\n' ;;
    scope) printf '\342\227\217 Running command\n\342\235\255 Allow  Once  Exec(rm)\n  Deny\n\342\206\221\342\206\223 select \302\267 \342\206\224 scope \302\267 e edit \302\267 \342\206\265 confirm \302\267 esc cancel\n' ;;
    wrapped) printf '\342\227\217 Running command\n  Allow  Once  Exec(rm)\n\342\235\255 Deny\n\342\206\221\342\206\223 select \302\267 \342\206\224\nscope \302\267 e edit \302\267 \342\206\265\nconfirm \302\267 esc cancel\n' ;;
  esac
}
while :; do
  if [ -n "${BUSY_UNTIL:-}" ] && [ ! -e "$BUSY_UNTIL" ]; then
    [ "$shown" = busy ] || { busy_screen; shown=busy; }
  else
    if [ "$shown" != idle ]; then
      printf '\033[2J\033[H'
      # QUOTED=1: a diff line quoting the approval footer above the idle prompt.
      [ -n "${QUOTED:-}" ] && printf '\342\224\202 +  footer: \342\206\221\342\206\223 select \302\267 \342\206\224 scope \302\267 \342\206\265 confirm\n'
      printf '\n\342\235\255 \n'; shown=idle
    fi
  fi
  sleep 0.2
done
EOF
  cp "$WORK/fake/fake-devin.sh" "$WORK/fake/acp"
  ON_OLD="$VERSIONS/$OLD/bin/devin"
  sid() { printf '%08d-1111-4222-8333-444444444444' "$1"; }
  pane() {  # pane NAME [ENV...]: a tmux session whose shell runs a fake Devin CLI on the old version
    n=$1; shift
    mkdir -p "$WORK/cwd/$n"
    tmux -S "$S" -f /dev/null new-session -d -s "$n" -c "$WORK/cwd/$n" -x 200 -y 50 "env PATH=$HOME_DIR/.local/bin:/usr/bin:/bin HOME=$HOME_DIR STATE=$STATE bash --norc --noprofile"
    tmux -S "$S" send-keys -t "$n" -l -- "env $* ${BIN:-$ON_OLD} ${SCRIPT_ARG:-$WORK/fake/fake-devin.sh} ${PARGS:-}"
    tmux -S "$S" send-keys -t "$n" Enter
  }
  # session NAME ID [AGE]: a row in the CLI's session store for that pane's directory.
  session() {
    python3 -I - "$HOME_DIR/.local/share/devin/cli/sessions.db" "$WORK/cwd/$1" "$2" "${3:-0}" <<'PY'
import sqlite3, sys, time
db, cwd, sid, age = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
c = sqlite3.connect(db)
c.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL, model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT)")
now = int(time.time() * 1000) - age * 1000
c.execute("INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at) VALUES (?,?,?,?,?,?,?)", (sid, cwd, 'local', 'm', 'normal', now, now))
c.commit()
PY
  }
  pid_in() { for _ in $(seq 1 50); do p=$(tmux -S "$S" list-panes -t "$1" -F '#{pane_pid}' 2>/dev/null); c=$(pgrep -P "$p" 2>/dev/null | head -n 1); [ -n "$c" ] && { echo "$c"; return; }; sleep 0.1; done; }
  is_running() { kill -0 "$1" 2>/dev/null && [ "$(sed -E 's/^.*\) ([A-Za-z]) .*$/\1/' "/proc/$1/stat")" != Z ]; }
  pane_text() { tmux -S "$S" capture-pane -p -t "$1" 2>/dev/null; }
  pane_cmd() { tmux -S "$S" display -p -t "$1" '#{pane_current_command}' 2>/dev/null; }
  # The old version's bin/devin is a copy of bash (a process to stop); the new one the bundle's.
  setup() { rm -rf "$HOME_DIR/.local/share/devin/cli/sessions.db" "$WORK/cwd"; tmux -S "$S" kill-server 2>/dev/null; reset; installed "$OLD"; cp "$(command -v bash)" "$ON_OLD"; }
  teardown() { tmux -S "$S" kill-server 2>/dev/null; for p in $(pgrep -f "$WORK/fake/"); do kill -KILL "$p" 2>/dev/null; done; sleep 0.3; }
  runs() { run TERMAG_DEVIN_KILL_AFTER=2 TERMAG_DEVIN_RESUME_WAIT=2 TERMAG_POLICY_TIMEOUT=5; }

  # force: every pane's own session at once.
  setup
  pane work
  pane busy BUSY_UNTIL="$WORK/never"
  pane scratch
  pane stubborn STUBBORN=1
  pane alice-proj-agent
  PARGS='-p a-turn' pane print-turn
  mkdir -p "$WORK/cwd/acp-pane"
  tmux -S "$S" -f /dev/null new-session -d -s acp-pane -c "$WORK/fake" "env PATH=/usr/bin:/bin bash --norc --noprofile"
  tmux -S "$S" send-keys -t acp-pane -l -- "$ON_OLD acp"; tmux -S "$S" send-keys -t acp-pane Enter
  mkdir -p "$WORK/pi-old"; cp "$(command -v bash)" "$WORK/pi-old/pi"
  tmux -S "$S" -f /dev/null new-session -d -s pi-tool -c "$WORK/cwd" "env PATH=/usr/bin:/bin bash --norc --noprofile"
  tmux -S "$S" send-keys -t pi-tool -l -- "$WORK/pi-old/pi -c '$ON_OLD $WORK/fake/fake-devin.sh; :'"; tmux -S "$S" send-keys -t pi-tool Enter
  outside=$( ( "$ON_OLD" "$WORK/fake/fake-devin.sh" </dev/null >/dev/null 2>&1 & echo "$!" ) )
  sleep 2
  # Sessions active since each started, and more than 10 s ago by the run.
  session work "$(sid 1)"; session busy "$(sid 2)"; session alice-proj-agent "$(sid 3)"
  session scratch "$(sid 4)" 7200   # from before scratch started: not its
  sleep 11
  stub_pid=$(pid_in stubborn) print_pid=$(pid_in print-turn) acp_pid=$(pid_in acp-pane)
  tool_pid=$(pgrep -f "^$ON_OLD $WORK/fake/fake-devin.sh\$" | while read -r p; do pp=$(ps -o ppid= -p "$p" | tr -d ' '); [ "$(readlink "/proc/$pp/exe")" = "$WORK/pi-old/pi" ] && echo "$p"; done | head -n 1)
  policy 200 force "$NEW" 30
  runs; got=$?
  [ "$got" = 0 ] || fail 'force: exits 0' 0 "$got: $(tail -5 "$WORK/err")"
  got=$(report '[.sessions.stopped, .sessions.cut, .sessions.typed, .sessions.resumed, .sessions.fresh, .sessions.other] | join(" ")')
  [ "$got" = '5 1 2 2 2 4' ] || fail 'force: stopped cut typed resumed fresh other' '5 1 2 2 2 4' "$got; $(report .detail)"
  got=$(report '[.panes[] | "\(.session):\(.role):\(.hadConversation):\(.sessionId // "-")"] | sort | join(" ")')
  want="alice-proj-agent:agent:true:$(sid 3) busy:other:true:$(sid 2) scratch:other:false:- stubborn:other:false:- work:other:true:$(sid 1)"
  [ "$got" = "$want" ] || fail 'force: every stopped pane listed, with its session' "$want" "$got"
  has 'force: a pane with a session gets devin --resume typed' "$(pane_text work)" "devin --resume $(sid 1)"
  [ "$(pane_cmd work)" = sleep ] || fail 'force: the typed resume took (the new version runs it)' sleep "$(pane_cmd work)"
  for n in scratch stubborn alice-proj-agent; do
    lacks "force: nothing typed into $n" "$(pane_text "$n")" 'devin --resume'
    [ "$(pane_cmd "$n")" = bash ] || fail "force: $n is left at its shell" bash "$(pane_cmd "$n")"
  done
  is_running "$stub_pid" && fail 'force: a session that ignores SIGTERM is SIGKILLed' killed alive
  [ -n "$print_pid" ] && is_running "$print_pid" || fail 'force: a -p turn in a pane is left alone' alive "gone ($print_pid)"
  [ -n "$acp_pid" ] && is_running "$acp_pid" || fail 'force: the acp subcommand is left alone' alive "gone ($acp_pid)"
  [ -n "$tool_pid" ] && is_running "$tool_pid" || fail 'force: one another agent (pi) runs is left alone' alive "gone ($tool_pid)"
  is_running "$outside" || fail 'force: one outside tmux is left alone' alive gone
  [ "$(cur)" = "$NEW" ] || fail 'force: current is the new version' "$NEW" "$(cur)"
  kill -KILL "$outside" 2>/dev/null
  teardown

  # A signal while a stopped pane is still going (Bugbot on #995): the report lists it.
  setup
  pane alice-proj-agent STUBBORN=1
  sleep 2; session alice-proj-agent "$(sid 51)"; sleep 11
  policy 200 force "$NEW" 0
  run TERMAG_DEVIN_KILL_AFTER=30 TERMAG_POLICY_TIMEOUT=5 & rp=$!
  sleep 5
  kill -TERM "$(pgrep -f "termag-devin-update --run $RUN_ID")"; wait "$rp"; got=$?
  [ "$got" = 143 ] || fail 'signal: exits 143' 143 "$got"
  got=$(report '[.panes[] | "\(.session):\(.role):\(.sessionId // "-")"] | join(" ")')
  [ "$got" = "alice-proj-agent:agent:$(sid 51)" ] || fail 'signal: the pane it had stopped is listed' "alice-proj-agent:agent:$(sid 51)" "$got"
  teardown

  # A bundle refused before it went live (its digest): nothing installed, so
  # restart=force stops no session (Bugbot on #1087).
  setup
  # The installed build answers its version (at the floor); the pane runs an
  # older build's devin.
  installed "$OLD"; mkdir -p "$VERSIONS/3000.10.1/bin"; cp "$(command -v bash)" "$VERSIONS/3000.10.1/bin/devin"
  BIN="$VERSIONS/3000.10.1/bin/devin" pane kept
  sleep 1; kept_pid=$(pid_in kept)
  : > "$STATE/bad-sha"; policy 200 force "$NEW" 0
  runs
  rm -f "$STATE/bad-sha"
  is_running "$kept_pid" || fail 'refused bundle: no session is stopped' alive stopped
  has 'refused bundle: says why' "$(report .detail)" 'restart=none(nothing installed)'
  teardown

  # A pane that resumed a session by id, or continued the newest, and has been
  # idle since: its session was last active before the process started, and
  # is still the pane's (Bugbot on #1087).
  setup
  PARGS="--resume $(sid 71)" pane resumed
  PARGS='-c' pane continued
  mkdir -p "$WORK/cwd/elsewhere"
  session elsewhere "$(sid 71)" 7200; session continued "$(sid 72)" 7200
  sleep 2
  policy 200 force "$NEW" 0
  runs
  got=$(report '[.panes[] | "\(.session):\(.hadConversation):\(.sessionId // "-")"] | sort | join(" ")')
  want="continued:true:$(sid 72) resumed:true:$(sid 71)"
  [ "$got" = "$want" ] || fail 'resumed: the session it resumed or continued is the pane'"'"'s' "$want" "$got"
  has 'resumed: its session gets devin --resume typed' "$(pane_text resumed)" "devin --resume $(sid 71)"
  has 'continued: its session gets devin --resume typed' "$(pane_text continued)" "devin --resume $(sid 72)"
  teardown

  # Two Devin TUIs in one directory, no --resume: the directory's newest
  # session is no more one's than the other's, so neither is listed with it
  # (Bugbot on #1087).
  setup
  pane twin-a
  tmux -S "$S" -f /dev/null new-session -d -s twin-b -c "$WORK/cwd/twin-a" -x 200 -y 50 "env PATH=$HOME_DIR/.local/bin:/usr/bin:/bin HOME=$HOME_DIR STATE=$STATE bash --norc --noprofile"
  tmux -S "$S" send-keys -t twin-b -l -- "$ON_OLD $WORK/fake/fake-devin.sh"; tmux -S "$S" send-keys -t twin-b Enter
  sleep 2; session twin-a "$(sid 81)"; sleep 11
  policy 200 force "$NEW" 0
  runs
  got=$(report '[.panes[] | "\(.session):\(.sessionId // "-")"] | sort | join(" ")')
  [ "$got" = "twin-a:- twin-b:-" ] || fail 'shared directory: neither pane takes the guessed session' "twin-a:- twin-b:-" "$got"
  teardown

  # An old Devin and a current one in one directory: the newest session
  # there may be the current one's, so the old pane is not resumed in it
  # (Devin on #1087). The current one is a real binary (built here), so its
  # exe is the current version's bin/devin and it answers --version.
  if command -v cc >/dev/null 2>&1; then
    setup
    printf '%s\n' '#include <stdio.h>' '#include <string.h>' '#include <unistd.h>' \
      "int main(int c, char **v) { if (c > 1 && !strcmp(v[1], \"--version\")) { puts(\"devin $NEW (0123456789ab)\"); return 0; } for (;;) pause(); }" > "$WORK/devin.c"
    installed "$NEW"; cc -o "$VERSIONS/$NEW/bin/devin" "$WORK/devin.c"
    mkdir -p "$VERSIONS/$OLD/bin"; cp "$(command -v bash)" "$ON_OLD"
    pane old-twin
    cur_twin=$(cd "$WORK/cwd/old-twin" && { "$VERSIONS/$NEW/bin/devin" </dev/null >/dev/null 2>&1 & echo "$!"; })
    sleep 2; session old-twin "$(sid 82)"; sleep 11
    policy 200 force "$NEW" 0
    runs
    got=$(report '[.panes[] | "\(.session):\(.hadConversation):\(.sessionId // "-")"] | sort | join(" ")')
    [ "$got" = "old-twin:false:-" ] || fail 'old and current in one directory: the old pane takes no guessed session' "old-twin:false:-" "$got; $(report .detail)"
    lacks 'old and current in one directory: nothing typed' "$(pane_text old-twin)" 'devin --resume'
    is_running "$cur_twin" || fail 'old and current in one directory: the current one is left alone' alive gone
    kill -KILL "$cur_twin" 2>/dev/null
    teardown
  else
    echo 'skip: old and current Devin in one directory (no cc)'
  fi

  # idle: a composing line, a long tool transcript and a pending question are
  # each a turn in progress (Bugbot on #1082): none is stopped before drainSec.
  setup
  pane composing BUSY_UNTIL="$WORK/never" BUSY_AS=compose
  pane long BUSY_UNTIL="$WORK/never" BUSY_AS=long
  pane asking BUSY_UNTIL="$WORK/never" BUSY_AS=ask
  pane guided BUSY_UNTIL="$WORK/never" BUSY_AS=guide
  pane scoped BUSY_UNTIL="$WORK/never" BUSY_AS=scope
  pane wrapped BUSY_UNTIL="$WORK/never" BUSY_AS=wrapped
  sleep 1; c_pid=$(pid_in composing) l_pid=$(pid_in long) a_pid=$(pid_in asking) g_pid=$(pid_in guided) s_pid=$(pid_in scoped) w_pid=$(pid_in wrapped)
  policy 200 idle "$NEW" 6
  runs & rp=$!
  sleep 4
  is_running "$c_pid" || fail 'idle: a composing line is a turn in progress' alive stopped
  is_running "$l_pid" || fail 'idle: a tool line far up a long transcript is a turn in progress' alive stopped
  is_running "$a_pid" || fail 'idle: a pending question is a turn in progress' alive stopped
  is_running "$g_pid" || fail 'idle: the ❭ prompt reading "Guide Devin while it works" is a turn in progress' alive stopped
  is_running "$s_pid" || fail 'idle: the newer approval list (❭ Allow … ↔ scope … ↵ confirm) is a turn in progress' alive stopped
  is_running "$w_pid" || fail 'idle: the list with a wrapped footer and the cursor on Deny is a turn in progress' alive stopped
  wait "$rp"
  [ "$(report '.sessions.cut')" = 6 ] || fail 'idle: all six cut at drainSec' 6 "$(report .detail)"
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

  # idle: a diff quoting the approval footer is not a question; the pane is idle and stopped, not cut.
  setup
  pane quoted QUOTED=1
  sleep 1; q_pid=$(pid_in quoted)
  policy 200 idle "$NEW" 6
  runs
  is_running "$q_pid" && fail 'idle: a quoted approval footer over the idle prompt is idle' stopped alive
  [ "$(report '.sessions.cut')" = 0 ] || fail 'idle: the quoted-footer pane is not cut' 0 "$(report .detail)"
  teardown
}
if [ "${1:-}" = --sessions ]; then
  sessions_cases
  if [ "$failures" -eq 0 ]; then echo 'ok: termag-devin-update --run sessions (PID namespace)'; exit 0; fi
  echo "$failures failure(s) in the session cases"; exit 1
fi

# ── an exact target, installed and reported ─────────────────────────────────
reset; installed "$OLD"; policy 200 none "$NEW"
run; got=$?
[ "$got" = 0 ] || fail 'target: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'target: asks for the Devin CLI'"'"'s policy for its run' "$(cat "$STATE/curl-calls")" "GET https://orch.example.test/termag/api/tool-update/policy?component=devin&run=$RUN_ID"
has 'target: the token goes on curl'"'"'s stdin' "$(cat "$STATE/curl-config")" 'Authorization: Bearer tmag_box_token'
lacks 'target: never in an argument' "$(cat "$STATE/curl-args")" 'tmag_box_token'
lacks 'target: never in a log line' "$(cat "$WORK/err")" 'tmag_box_token'
has 'target: reads that version'"'"'s manifest' "$(cat "$STATE/curl-calls")" "GET https://static.devin.ai/cli/$NEW/manifest.json"
has 'target: downloads its bundle for this machine' "$(cat "$STATE/curl-calls")" "GET https://static.devin.ai/cli/$NEW/devin-$NEW-$T.tar.gz"
[ "$(cur)" = "$NEW" ] || fail 'target: current is the new version' "$NEW" "$(cur)"
[ "$(readlink "$HOME_DIR/.local/bin/devin")" = "$VERSIONS/current/bin/devin" ] || fail 'target: the bin link still goes through current' "$VERSIONS/current/bin/devin" "$(readlink "$HOME_DIR/.local/bin/devin")"
[ "$(cat "$VERSIONS/$NEW/distribution" 2>/dev/null)" = curl-bash ] || fail 'target: the installer'"'"'s distribution marker' curl-bash "$(cat "$VERSIONS/$NEW/distribution" 2>&1)"
[ -d "$VERSIONS/$OLD" ] || fail 'target: the old version is left for sessions still on it' present absent
for d in "$VERSIONS"/_*.tmp "$VERSIONS"/_download/termag-*; do [ -e "$d" ] && fail 'target: nothing left behind' none "$d"; done
has 'target: verified' "$(cat "$WORK/err")" "devin is now $NEW, verified (its manifest's SHA-256"
got=$(report '[.component, .outcome, .target, .fromVersion, .toVersion] | join(" ")')
[ "$got" = "devin updated $NEW $OLD $NEW" ] || fail 'target: the report' "devin updated $NEW $OLD $NEW" "$got"

# At the target: nothing downloaded. Above it: nothing moves down.
reset; installed "$NEW"; policy 200 none "$NEW"; run
lacks 'current: downloads nothing' "$(cat "$STATE/curl-calls")" 'static.devin.ai'
[ "$(report .outcome)" = current ] || fail 'current: outcome current' current "$(report .outcome)"
reset; installed "$LATER"; policy 200 none "$NEW"; run
lacks 'no downgrade: downloads nothing' "$(cat "$STATE/curl-calls")" '.tar.gz'

# latest: current/manifest.json's version, asked for once.
reset; installed "$OLD"; echo "$LATER" > "$STATE/latest"; policy 200 none latest
run; got=$?
[ "$got" = 0 ] || fail 'latest: exits 0' 0 "$got: $(cat "$WORK/err")"
[ "$(grep -c 'GET https://static.devin.ai/cli/current/manifest.json' "$STATE/curl-calls")" = 1 ] || fail 'latest: asks once' 1 "$(cat "$STATE/curl-calls")"
[ "$(cur)" = "$LATER" ] || fail 'latest: installs what the manifest names' "$LATER" "$(cur)"

# ── never installed, rejected, restored, quarantined ────────────────────────
for case in bad-sha bad-manifest other-version; do
  reset; installed "$OLD"; policy 200 none "$NEW"
  case $case in
    bad-sha) : > "$STATE/bad-sha" ;;
    bad-manifest) : > "$STATE/bad-manifest" ;;
    other-version) mkpkg "$NEW" 3000.11.999 ;;
  esac
  run
  [ "$(cur)" = "$OLD" ] || fail "$case: current stays on the version that ran" "$OLD" "$(cur)"
  [ ! -e "$VERSIONS/$NEW" ] || fail "$case: not moved into _versions" absent present
  [ ! -e "$HOME_DIR/.termag/devin-update.rejected" ] || fail "$case: nothing live to reject, nothing recorded" absent present
  [ "$(report .outcome)" = failed ] || fail "$case: reported failed" failed "$(report .outcome)"
done
mkpkg "$NEW"
has 'other version: says so' "$(cat "$WORK/err")" "the bundle for $NEW says 3000.11.999; not installed"
# `current` written absolute (Devin's own updater may): the same-version
# replace and the restore still find the version it names (Bugbot on #1082).
reset; installed "$NEW"; ln -sfn "$VERSIONS/$NEW" "$VERSIONS/current"; policy 200 none "$NEW"
sed -i "s|cat \"\$STATE/live-says\"|echo $NEW|" "$VERSIONS/$NEW/bin/devin"
mkdir -p "$HOME_DIR/.termag"; printf 'devin asked for %s; an earlier run\n' "$NEW" > "$HOME_DIR/.termag/devin-update.rejected"
printf '3000.11.995\n' > "$STATE/live-says"
run; got=$?
[ "$got" = 3 ] || fail 'absolute current: rejected, exits 3' 3 "$got"
[ "$("$HOME_DIR/.local/bin/devin" --version 2>&1)" = "devin $NEW (0123456789ab)" ] || fail 'absolute current: the version that ran still runs' "devin $NEW" "$("$HOME_DIR/.local/bin/devin" --version 2>&1)"
has 'absolute current: put back' "$(cat "$WORK/err")" "$NEW is back in place and current, verified"
rm -f "$STATE/live-says"
# Current, but what a session starts says another: rejected, current put back.
reset; installed "$OLD"; policy 200 none "$NEW"
sed -i "s|cat \"\$STATE/live-says\"|echo $OLD|" "$VERSIONS/$OLD/bin/devin"
printf '3000.11.998\n' > "$STATE/live-says"
run; got=$?
[ "$got" = 3 ] || fail 'live mismatch: rejected, exits 3' 3 "$got: $(tail -3 "$WORK/err")"
grep -q '^devin ' "$HOME_DIR/.termag/devin-update.rejected" 2>/dev/null || fail 'live mismatch: recorded' 'devin ...' "$(cat "$HOME_DIR/.termag/devin-update.rejected" 2>/dev/null)"
[ "$(cur)" = "$OLD" ] || fail 'live mismatch: current is back on the version that ran' "$OLD" "$(cur)"
has 'live mismatch: restored, verified' "$(cat "$WORK/err")" "is back at $OLD, verified"
rm -f "$STATE/live-says"
run; got=$?
[ "$got" = 0 ] || fail 'rejected, then verified: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ ! -e "$HOME_DIR/.termag/devin-update.rejected" ] || fail 'rejected, then verified: the record is gone' absent present
[ "$(cur)" = "$NEW" ] || fail 'rejected, then verified: current' "$NEW" "$(cur)"
# The version being replaced is the current one (a retry after a rejection,
# or one Devin's own updater installed): it goes back, never no CLI at all.
reset; installed "$NEW"; policy 200 none "$NEW"
sed -i "s|cat \"\$STATE/live-says\"|echo $NEW|" "$VERSIONS/$NEW/bin/devin"
mkdir -p "$HOME_DIR/.termag"; printf 'devin asked for %s; an earlier run\n' "$NEW" > "$HOME_DIR/.termag/devin-update.rejected"
printf '3000.11.997\n' > "$STATE/live-says"
run; got=$?
[ "$got" = 3 ] || fail 'same version, live mismatch: rejected, exits 3' 3 "$got"
[ "$(cur)" = "$NEW" ] && [ "$("$HOME_DIR/.local/bin/devin" --version)" = "devin $NEW (0123456789ab)" ] || fail 'same version, live mismatch: the version that ran is current' "$NEW" "$(cur) $("$HOME_DIR/.local/bin/devin" --version 2>&1)"
has 'same version, live mismatch: says it put it back' "$(cat "$WORK/err")" "$NEW is back in place and current, verified"
rm -f "$STATE/live-says"
# The current version is moved aside and the new one cannot be moved in: the
# current one goes back, so current never dangles (Bugbot on #1080).
reset; installed "$NEW"; policy 200 none "$NEW"
printf 'devin asked for %s; an earlier run\n' "$NEW" > "$HOME_DIR/.termag/devin-update.rejected"
printf '#!/bin/sh\ncase "$*" in *.termag-*.tmp*) exit 1 ;; esac\nexec /bin/mv "$@"\n' > "$STUB/mv"; chmod +x "$STUB/mv"
run; got=$?
rm -f "$STUB/mv"
[ "$(cur)" = "$NEW" ] && [ -x "$VERSIONS/$NEW/bin/devin" ] || fail 'move fails: the current version is back where current points' "$NEW" "$(ls -a "$VERSIONS")"
has 'move fails: says so' "$(cat "$WORK/err")" "cannot move $NEW into"
for d in "$VERSIONS"/_*.tmp "$VERSIONS"/*.replaced-*; do [ -e "$d" ] && fail 'move fails: nothing left aside' none "$d"; done
# The current version cannot be moved aside: nothing changes.
reset; installed "$NEW"; policy 200 none "$NEW"
printf 'devin asked for %s; an earlier run\n' "$NEW" > "$HOME_DIR/.termag/devin-update.rejected"
printf '#!/bin/sh\ncase "$*" in *.replaced-*) exit 1 ;; esac\nexec /bin/mv "$@"\n' > "$STUB/mv"; chmod +x "$STUB/mv"
run; got=$?
rm -f "$STUB/mv"
[ "$(cur)" = "$NEW" ] && [ -x "$VERSIONS/$NEW/bin/devin" ] || fail 'aside fails: the current version is untouched' "$NEW" "$(ls -a "$VERSIONS" "$VERSIONS/$NEW")"
has 'aside fails: says so' "$(cat "$WORK/err")" "cannot move the current $NEW aside; nothing changed"
for d in "$VERSIONS"/_*.tmp; do [ -e "$d" ] && fail 'aside fails: no download directory left behind' none "$d"; done
# A leftover directory of the target that current does not name (Devin's own
# updater moved on, a session may still run from it): kept aside, never
# deleted (Bugbot on #1080, the same code).
reset; installed "$OLD"; mkdir -p "$VERSIONS/$NEW"; echo in-use > "$VERSIONS/$NEW/marker"; policy 200 none "$NEW"
run; got=$?
[ "$got" = 0 ] || fail 'unlinked leftover: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ "$(cur)" = "$NEW" ] && [ -x "$VERSIONS/$NEW/bin/devin" ] || fail 'unlinked leftover: the new version is installed in its place' "$NEW" "$(ls -a "$VERSIONS")"
kept=$(ls -d "$VERSIONS/$NEW".unlinked-* 2>/dev/null | head -n 1)
[ -n "$kept" ] && [ "$(cat "$kept/marker" 2>/dev/null)" = in-use ] || fail 'unlinked leftover: kept aside, not deleted' "$NEW.unlinked-<pid>/marker" "$(ls -a "$VERSIONS")"
# current missing, and it cannot be switched: never a current that names
# itself (Bugbot on #1087).
reset; installed "$OLD"; rm -f "$VERSIONS/current"; policy 200 none "$NEW"; rm -f "$STATE/mv-n"
printf '#!/bin/sh\ncase "$*" in *-Tf*) n=$(( $(cat "$STATE/mv-n" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE/mv-n"; [ $n = 1 ] && exit 1 ;; esac\nexec /bin/mv "$@"\n' > "$STUB/mv"; chmod +x "$STUB/mv"
run
rm -f "$STUB/mv" "$STATE/mv-n"
[ "$(readlink "$VERSIONS/current" 2>/dev/null)" != current ] || fail 'current missing, point fails: never a circular current' 'not current -> current' "$(readlink "$VERSIONS/current")"
# The version that ran cannot go back into its directory after a mismatch:
# current names it where it was moved aside (Bugbot on #1080, the same code).
reset; installed "$NEW"; policy 200 none "$NEW"
sed -i "s|cat \"\$STATE/live-says\"|echo $NEW|" "$VERSIONS/$NEW/bin/devin"
printf 'devin asked for %s; an earlier run\n' "$NEW" > "$HOME_DIR/.termag/devin-update.rejected"
printf '3000.11.995\n' > "$STATE/live-says"
printf '#!/bin/sh\ncase "$*" in *.replaced-*" %s/%s") exit 1 ;; esac\nexec /bin/mv "$@"\n' "$VERSIONS" "$NEW" > "$STUB/mv"; chmod +x "$STUB/mv"
run
rm -f "$STUB/mv" "$STATE/live-says"
[ "$("$HOME_DIR/.local/bin/devin" --version 2>/dev/null)" = "devin $NEW (0123456789ab)" ] || fail 'mismatch and put-back fail: the version that ran runs from where it was moved aside' "devin $NEW" "$(readlink "$VERSIONS/current"); $("$HOME_DIR/.local/bin/devin" --version 2>&1)"
has 'mismatch and put-back fail: says so' "$(cat "$WORK/err")" 'where it was moved aside'
# current cannot be switched: not a mismatch. It stays on the version that
# ran, and nothing is rejected (Bugbot on #1080, the same code).
reset; installed "$OLD"; policy 200 none "$NEW"
printf '#!/bin/sh\ncase "$*" in *-Tf*) exit 1 ;; esac\nexec /bin/mv "$@"\n' > "$STUB/mv"; chmod +x "$STUB/mv"
run; got=$?
rm -f "$STUB/mv"
[ "$(cur)" = "$OLD" ] || fail 'point fails: current stays on the version that ran' "$OLD" "$(cur)"
[ ! -e "$HOME_DIR/.termag/devin-update.rejected" ] || fail 'point fails: nothing rejected' absent "$(cat "$HOME_DIR/.termag/devin-update.rejected")"
[ "$(report .outcome)" = failed ] || fail 'point fails: reported failed' failed "$(report .outcome)"
# The current version is replaced, fails its live check, and is put back, but
# current cannot be pointed at it again: it already names that directory, so
# it stays, and the version put back is never quarantined (Bugbot on #1087).
reset; installed "$NEW"; policy 200 none "$NEW"
sed -i "s|cat \"\$STATE/live-says\"|echo $NEW|" "$VERSIONS/$NEW/bin/devin"
printf 'devin asked for %s; an earlier run\n' "$NEW" > "$HOME_DIR/.termag/devin-update.rejected"
printf '3000.11.996\n' > "$STATE/live-says"; rm -f "$STATE/mv-n"
printf '#!/bin/sh\ncase "$*" in *-Tf*) n=$(( $(cat "$STATE/mv-n" 2>/dev/null || echo 0) + 1 )); echo $n > "$STATE/mv-n"; [ $n -gt 1 ] && exit 1 ;; esac\nexec /bin/mv "$@"\n' > "$STUB/mv"; chmod +x "$STUB/mv"
run; got=$?
rm -f "$STUB/mv" "$STATE/live-says" "$STATE/mv-n"
[ "$(cur)" = "$NEW" ] && [ -x "$VERSIONS/$NEW/bin/devin" ] || fail 'restore point fails: the version put back stays current' "$NEW" "$(cur); $(ls -l "$VERSIONS/$NEW/bin" 2>&1)"
[ "$("$HOME_DIR/.local/bin/devin" --version)" = "devin $NEW (0123456789ab)" ] || fail 'restore point fails: it still runs' "devin $NEW (0123456789ab)" "$("$HOME_DIR/.local/bin/devin" --version 2>&1)"
ls "$VERSIONS"/*.rejected-*/bin/devin.rejected >/dev/null 2>&1 || fail 'restore point fails: the rejected download is quarantined' 'devin.rejected' "$(ls -a "$VERSIONS")"
# No version that ran to go back to: quarantined, the links removed.
reset; rm -rf "$VERSIONS"; rm -f "$HOME_DIR/.local/bin/devin"; policy 200 none "$NEW"
printf '3000.11.996\n' > "$STATE/live-says"
run; got=$?
[ "$got" = 3 ] || fail 'quarantine: rejected, exits 3' 3 "$got"
[ ! -e "$VERSIONS/current" ] && [ ! -e "$HOME_DIR/.local/bin/devin" ] || fail 'quarantine: no link left to the rejected version' none "$(ls -l "$VERSIONS" "$HOME_DIR/.local/bin" 2>&1)"
[ -e "$VERSIONS/$NEW/bin/devin.rejected" ] && [ ! -x "$VERSIONS/$NEW/bin/devin.rejected" ] || fail 'quarantine: renamed, not executable' 'devin.rejected' "$(ls -l "$VERSIONS/$NEW/bin" 2>&1)"
has 'quarantine: the summary says so' "$(cat "$WORK/err")" 'pin-mismatch,quarantined'
# A download that fails changes nothing.
reset; installed "$OLD"; : > "$STATE/dl-fail"; policy 200 none "$NEW"
run
[ "$(cur)" = "$OLD" ] || fail 'download fails: current stays' "$OLD" "$(cur)"
has 'download fails: says FAILED' "$(cat "$WORK/err")" "install=$OLD->FAILED"

# A signal mid-download: the partial download goes with the run (the lib's
# TU_TMP, a review on #1080), and the version that ran stays current.
reset; installed "$OLD"; policy 200 none "$NEW"; : > "$STATE/dl-slow"
run & rp=$!
for _ in $(seq 1 100); do ls "$VERSIONS"/_download/termag-* >/dev/null 2>&1 && break; sleep 0.1; done
sleep 1; kill -TERM "$(pgrep -f "termag-devin-update --run $RUN_ID" | head -n 1)"; wait "$rp"; got=$?
rm -f "$STATE/dl-slow"
[ "$got" = 143 ] || fail 'signal mid-download: exits 143' 143 "$got"
for d in "$VERSIONS"/_download/termag-* "$VERSIONS"/_*.termag-*.tmp; do [ -e "$d" ] && fail 'signal mid-download: nothing left behind' none "$d"; done
[ "$(cur)" = "$OLD" ] || fail 'signal mid-download: the version that ran stays current' "$OLD" "$(cur)"

# ── no policy, a run not started, the lock, usage ───────────────────────────
for case in refused unreadable null; do
  reset; installed "$OLD"
  case $case in
    refused) policy 403 force ;;
    unreadable) printf 200 > "$STATE/policy-code"; printf 'not json' > "$STATE/policy-body" ;;
    null) policy 200 force "$NEW" 5 null ;;
  esac
  run; got=$?
  lacks "no policy ($case): downloads nothing" "$(cat "$STATE/curl-calls")" 'static.devin.ai'
  [ "$got" = 0 ] || fail "no policy ($case): exits 0" 0 "$got"
  # Nothing installed or checked: the admin's update did not happen (Bugbot on #1080).
  [ "$case" = null ] || [ "$(report .outcome)" = failed ] || fail "no policy ($case): reported failed, never current" failed "$(report .outcome)"
done
reset; installed "$OLD"; policy 200 none "$NEW"; mkdir -p "$HOME_DIR/.termag"
( exec 9>"$HOME_DIR/.termag/devin-update.lock"; flock 9; sleep 4 ) & holder=$!
sleep 0.5
run; wait "$holder"
lacks 'lock held: downloads nothing' "$(cat "$STATE/curl-calls")" 'static.devin.ai'
[ "$(report .outcome)" = failed ] || fail 'lock held: the run did not happen, reported failed (Bugbot on #995)' failed "$(report .outcome)"
has 'lock held: the detail says why' "$(report .detail)" 'lock=held-by-another-run'
reset; installed "$OLD"; policy 403 force; run
[ "$(report 'has("target")')" = false ] || fail 'no policy: the report names no target (Bugbot on #995)' 'no target' "$(report .target)"
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
  echo "ok: termag-devin-update"
else
  echo "$failures failure(s)"
  exit 1
fi
