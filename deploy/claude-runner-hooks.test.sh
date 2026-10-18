#!/bin/sh
# Tests deploy/claude-runner-hooks/{command,post-session}, the termag runner's
# lifecycle hooks, with stub
# curl and claude binaries:
#
#   * command posts {event: started, orderId, sessionId, at, clientPlatform} to the
#     event route derived from the agent config's termag_url, token on curl's
#     stdin and never on argv, then execs the runner's binary with the child's
#     argv and with stdin and fd 3 intact; the platform is left out when unset
#   * command execs webapp's session wrapper when the box has it
#   * without an order or a session id nothing is posted and the child still runs
#   * post-session writes the runner's exit reason 0600 to <dir>/<order>.exit-reason.<launch>,
#     refuses a reason that is not a token, and exits 0 whatever happens
#
# Run: sh deploy/claude-runner-hooks.test.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
CMD="$HERE/claude-runner-hooks/command"
POST="$HERE/claude-runner-hooks/post-session"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
failures=0
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }
command -v jq >/dev/null 2>&1 || { echo "SKIP: jq not installed"; exit 0; }
BASH_BIN="$(command -v bash)"
HOME_DIR="$WORK/home"; mkdir -p "$HOME_DIR/.termag" "$WORK/bin"
printf '{"token":"tmag_box_token","termag_url":"wss://orch.example.test/termag/ws/agent?token=x"}\n' > "$HOME_DIR/.termag/agent.config.json"

# Stub claude: records argv, whether stdin and fd 3 are open, then exits 0.
cat > "$WORK/bin/claude" <<'EOS'
#!/bin/sh
printf '%s\n' "$@" > "$RECORD.child.argv"
{ : <&3; } 2>/dev/null && echo fd3-open > "$RECORD.child.fd3" || echo fd3-closed > "$RECORD.child.fd3"
cat <&0 > "$RECORD.child.stdin" 2>/dev/null
exit 0
EOS
chmod +x "$WORK/bin/claude"
# Stub curl: records argv, the -K - config and the -d body; answers STUB_CURL_CODE.
cat > "$WORK/bin/curl" <<'EOS'
#!/bin/sh
printf '%s\n' "$@" > "$RECORD.curl.argv"
body=; cfg=
while [ $# -gt 0 ]; do case "$1" in -d) body=$2; shift ;; -K) [ "$2" = - ] && cfg=$(cat); shift ;; esac; shift; done
printf '%s\n' "$body" > "$RECORD.curl.body"; printf '%s\n' "$cfg" > "$RECORD.curl.stdin"
printf '%s' "${STUB_CURL_CODE:-204}"
EOS
chmod +x "$WORK/bin/curl"

run_cmd() {  # extra env, then the child's argv after --
  rm -f "$WORK"/record.*
  envs=; while [ $# -gt 0 ] && [ "$1" != -- ]; do envs="$envs $1"; shift; done; [ $# -gt 0 ] && shift
  # shellcheck disable=SC2086
  printf 'hello-stdin' | env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$HOME_DIR" RECORD="$WORK/record" \
    CLAUDE_RUNNER_CLAUDE_BIN="$WORK/bin/claude" $envs "$BASH_BIN" "$CMD" "$@" 3<"$CMD" 2>"$WORK/err"
}
wait_curl() { i=0; while [ ! -f "$WORK/record.curl.body" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done; }

# ── command: the started report and the exec ───────────────────────────────
run_cmd TERMAG_CLAUDE_RUNNER_ORDER=ord-1 CLAUDE_CODE_REMOTE_SESSION_ID=cse_01A CLAUDE_RUNNER_CLIENT_PLATFORM=web_claude_ai -- --print --sdk-url https://api.example.test/s; got=$?
[ "$got" = 0 ] || fail 'command: exits with the child status' 0 "$got"
wait_curl
body="$(cat "$WORK/record.curl.body" 2>/dev/null)"
case "$body" in
  '{"event":"started","orderId":"ord-1","sessionId":"cse_01A","at":"'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'","clientPlatform":"web_claude_ai"}') ;;
  *) fail 'command: posts started with order, session, time and platform' '{"event":"started","orderId":"ord-1","sessionId":"cse_01A","at":"<utc>","clientPlatform":"web_claude_ai"}' "$body" ;;
esac
grep -qx 'https://orch.example.test/termag/api/claude-runner/event' "$WORK/record.curl.argv" 2>/dev/null || fail 'command: posts to the event route from termag_url' 'https://orch.example.test/termag/api/claude-runner/event' "$(tr '\n' ' ' <"$WORK/record.curl.argv" 2>/dev/null)"
grep -qx 'header = "Authorization: Bearer tmag_box_token"' "$WORK/record.curl.stdin" 2>/dev/null || fail 'command: token on stdin' 'header = ... tmag_box_token' "$(cat "$WORK/record.curl.stdin" 2>/dev/null)"
grep -q tmag_box_token "$WORK/record.curl.argv" 2>/dev/null && fail 'command: token not on argv' absent present
[ "$(tr '\n' ' ' <"$WORK/record.child.argv" 2>/dev/null)" = '--print --sdk-url https://api.example.test/s ' ] || fail "command: execs the runner's binary with the child's argv" '--print --sdk-url https://api.example.test/s' "$(tr '\n' ' ' <"$WORK/record.child.argv" 2>/dev/null)"
[ "$(cat "$WORK/record.child.fd3" 2>/dev/null)" = fd3-open ] || fail 'command: fd 3 reaches the child' fd3-open "$(cat "$WORK/record.child.fd3" 2>/dev/null)"
[ "$(cat "$WORK/record.child.stdin" 2>/dev/null)" = hello-stdin ] || fail 'command: stdin reaches the child' hello-stdin "$(cat "$WORK/record.child.stdin" 2>/dev/null)"
grep -q 'started reported (session cse_01A, web_claude_ai)' "$WORK/err" || { sleep 0.3; grep -q 'started reported' "$WORK/err" || fail 'command: logs the report' 'started reported' "$(cat "$WORK/err")"; }

run_cmd TERMAG_CLAUDE_RUNNER_ORDER=ord-2 CLAUDE_CODE_REMOTE_SESSION_ID=cse_01B -- --print; wait_curl
case "$(cat "$WORK/record.curl.body" 2>/dev/null)" in *clientPlatform*) fail 'command: no platform key when unset' '(no clientPlatform)' "$(cat "$WORK/record.curl.body")" ;; esac

run_cmd CLAUDE_CODE_REMOTE_SESSION_ID=cse_01C -- --print; got=$?
[ "$got" = 0 ] || fail 'command: without an order the child still runs' 0 "$got"
sleep 0.2; [ ! -f "$WORK/record.curl.body" ] || fail 'command: nothing posted without an order' absent "$(cat "$WORK/record.curl.body")"
grep -q 'started not reported' "$WORK/err" || fail 'command: says why nothing was posted' 'started not reported' "$(cat "$WORK/err")"

run_cmd TERMAG_CLAUDE_RUNNER_ORDER=ord-3 CLAUDE_CODE_REMOTE_SESSION_ID=cse_01D STUB_CURL_CODE=400 -- --print; wait_curl; sleep 0.2
grep -q 'predates the started event' "$WORK/err" || fail 'command: an older orchestrator is named on a 400' 'predates the started event' "$(cat "$WORK/err")"

# webapp's session wrapper, when the box has it, is what gets exec'd.
mkdir -p "$HOME_DIR/.config/claude-runner"
cat > "$HOME_DIR/.config/claude-runner/session-wrapper.sh" <<'EOS'
#!/bin/sh
printf 'wrapper %s\n' "$*" > "$RECORD.wrapper"
exec "$CLAUDE_RUNNER_CLAUDE_BIN" "$@"
EOS
chmod +x "$HOME_DIR/.config/claude-runner/session-wrapper.sh"
run_cmd TERMAG_CLAUDE_RUNNER_ORDER=ord-4 CLAUDE_CODE_REMOTE_SESSION_ID=cse_01E -- --print --x; wait_curl
[ "$(cat "$WORK/record.wrapper" 2>/dev/null)" = 'wrapper --print --x' ] || fail "command: execs webapp's wrapper when present" 'wrapper --print --x' "$(cat "$WORK/record.wrapper" 2>/dev/null)"
rm -rf "$HOME_DIR/.config/claude-runner"

# ── post-session: the exit reason file ─────────────────────────────────────
run_post() { env -i PATH="/usr/bin:/bin" HOME="$HOME_DIR" "$@" "$BASH_BIN" "$POST" 2>"$WORK/err"; }
D="$HOME_DIR/.termag/claude-runner"
run_post TERMAG_CLAUDE_RUNNER_ORDER=ord-1 TERMAG_CLAUDE_RUNNER_DIR="$D" TERMAG_CLAUDE_RUNNER_LAUNCH=4242 CLAUDE_RUNNER_EXIT_REASON=interrupted; got=$?
[ "$got" = 0 ] || fail 'post-session: exits 0' 0 "$got"
[ "$(cat "$D/ord-1.exit-reason.4242" 2>/dev/null)" = interrupted ] || fail 'post-session: writes the reason to the per-launch file' interrupted "$(cat "$D/ord-1.exit-reason.4242" 2>/dev/null)"
mode="$(stat -c '%a' "$D/ord-1.exit-reason.4242" 2>/dev/null || stat -f '%Lp' "$D/ord-1.exit-reason.4242")"
[ "$mode" = 600 ] || fail 'post-session: the file is 0600' 600 "$mode"
run_post TERMAG_CLAUDE_RUNNER_ORDER=ord-2 TERMAG_CLAUDE_RUNNER_DIR="$D" TERMAG_CLAUDE_RUNNER_LAUNCH=4242 CLAUDE_RUNNER_EXIT_REASON='Oops!'; got=$?
[ "$got" = 0 ] && [ -z "$(find "$D" -name 'ord-2.exit-reason*')" ] || fail 'post-session: a non-token reason writes nothing, exit 0' 'nothing, 0' "$got $(ls "$D" 2>/dev/null | tr '\n' ' ')"
run_post TERMAG_CLAUDE_RUNNER_DIR="$D" TERMAG_CLAUDE_RUNNER_LAUNCH=4242 CLAUDE_RUNNER_EXIT_REASON=completed; got=$?
[ "$got" = 0 ] || fail 'post-session: without an order, exit 0' 0 "$got"
grep -q 'nothing written' "$WORK/err" || fail 'post-session: says why nothing was written' 'nothing written' "$(cat "$WORK/err")"
run_post TERMAG_CLAUDE_RUNNER_ORDER=ord-3 TERMAG_CLAUDE_RUNNER_DIR="$D" CLAUDE_RUNNER_EXIT_REASON=completed; got=$?
[ "$got" = 0 ] && [ -z "$(find "$D" -name 'ord-3.exit-reason*')" ] || fail 'post-session: without a launch pid, nothing written' 'nothing' "$(ls "$D")"

# ── post-session: the final usage post ──
# A stub termag-status records how it was called; the transcripts live where
# the runner keeps them, under <base-dir>/_sessions/<id>.claude-config/projects/.
BASE="$HOME_DIR/ccr/sessions/ord-5"
mkdir -p "$BASE/_sessions/cse_01A.claude-config/projects/-home-x-webapp" "$HOME_DIR/.local/bin"
: > "$BASE/_sessions/cse_01A.claude-config/projects/-home-x-webapp/t1.jsonl"
: > "$BASE/_sessions/cse_01A.claude-config/projects/-home-x-webapp/t2.jsonl"
cat > "$HOME_DIR/.local/bin/termag-status" <<'EOS'
#!/bin/sh
printf '%s\n' "$@" > "$RECORD.status.argv"
exit 0
EOS
chmod +x "$HOME_DIR/.local/bin/termag-status"
rm -f "$WORK"/record.*
env -i PATH="/usr/bin:/bin" HOME="$HOME_DIR" RECORD="$WORK/record" TERMAG_CLAUDE_RUNNER_ORDER=ord-5 TERMAG_CLAUDE_RUNNER_DIR="$D" TERMAG_CLAUDE_RUNNER_LAUNCH=4242 \
  TERMAG_CLAUDE_RUNNER_BASE_DIR="$BASE" CLAUDE_RUNNER_EXIT_REASON=completed "$BASH_BIN" "$POST" 2>"$WORK/err"; got=$?
[ "$got" = 0 ] || fail 'post-session: exits 0 with the usage post' 0 "$got"
got="$(tr '\n' ' ' <"$WORK/record.status.argv" 2>/dev/null)"
[ "$got" = "usage --transcript $BASE/_sessions/cse_01A.claude-config/projects/-home-x-webapp/t1.jsonl --transcript $BASE/_sessions/cse_01A.claude-config/projects/-home-x-webapp/t2.jsonl " ] \
  || fail 'post-session: sums every transcript under the base dir through termag-status usage' 'usage --transcript t1 --transcript t2' "$got"
grep -q 'final usage posted from 2 transcript' "$WORK/err" || fail 'post-session: logs the usage post' 'final usage posted' "$(cat "$WORK/err")"
[ "$(cat "$D/ord-5.exit-reason.4242" 2>/dev/null)" = completed ] || fail 'post-session: the reason file is still written' completed "$(cat "$D/ord-5.exit-reason.4242" 2>/dev/null)"
# The session directory's size, in bytes, 0600, per launch (S5): the wrapper folds it into the ended report.
bytes="$(cat "$D/ord-5.checkout-bytes.4242" 2>/dev/null)"
case "$bytes" in ''|*[!0-9]*) fail 'post-session: writes the session directory size in bytes' '<digits>' "$bytes" ;; *) [ "$bytes" -gt 0 ] || fail 'post-session: a non-empty directory measures above zero' '>0' "$bytes" ;; esac
mode="$(stat -c '%a' "$D/ord-5.checkout-bytes.4242" 2>/dev/null || stat -f '%Lp' "$D/ord-5.checkout-bytes.4242")"
[ "$mode" = 600 ] || fail 'post-session: the size file is 0600' 600 "$mode"
grep -q 'size written' "$WORK/err" || fail 'post-session: logs the size' 'size written' "$(cat "$WORK/err")"
rm -f "$WORK"/record.*
env -i PATH="/usr/bin:/bin" HOME="$HOME_DIR" RECORD="$WORK/record" TERMAG_CLAUDE_RUNNER_ORDER=ord-6 TERMAG_CLAUDE_RUNNER_DIR="$D" TERMAG_CLAUDE_RUNNER_LAUNCH=4242 \
  CLAUDE_RUNNER_EXIT_REASON=completed "$BASH_BIN" "$POST" 2>"$WORK/err"
[ ! -f "$WORK/record.status.argv" ] || fail 'post-session: no base dir, no usage post' absent present
grep -q 'usage not posted' "$WORK/err" || fail 'post-session: says why the usage was not posted' 'usage not posted' "$(cat "$WORK/err")"

if [ "$failures" -eq 0 ]; then echo "PASS: claude-runner-hooks command + post-session"; exit 0; fi
echo "$failures failure(s)"; exit 1
