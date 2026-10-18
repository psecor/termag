#!/bin/sh
# Tests deploy/termag-briefing, the box-side one-shot that composes a daily
# briefing, with stub `curl` and `claude`:
#
#   * it reads the job with the agent config's token (on curl's stdin, never
#     argv) from the base derived from termag_url, runs claude with the job's
#     prompt, allowed tools, turn cap and model, from ~/.termag/briefing
#   * claude sees no TMUX/TMUX_PANE, METATERM_SEND_KEYS=off, and the inherited
#     ANTHROPIC_API_KEY untouched
#   * the result body carries claude's .result, exit status, is_error, usage
#     and model; it exits with claude's status
#   * a claude that fails without JSON posts an error result naming its last
#     stderr line; a missing claude posts "claude not found"
#   * a job that cannot be read runs nothing and posts nothing; a bad id exits 2
#   * TERMAG_URL overrides the server
#
# Run: sh deploy/termag-briefing.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/termag-briefing"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "  want: $2"
  echo "  got:  $3"
  failures=$((failures + 1))
}

STUB="$WORK/stub"
REC="$WORK/rec"
mkdir -p "$STUB" "$REC"

# curl stub: records argv and the stdin config, serves the job, saves POST bodies.
cat > "$STUB/curl" <<'EOF'
#!/bin/sh
out=/dev/null url= method=GET data=
printf '%s\n' "$*" >> "$REC/curl.argv"
while [ $# -gt 0 ]; do
  case $1 in
    -K) [ "$2" = - ] && cat >> "$REC/curl.stdin"; shift ;;
    -o) out=$2; shift ;;
    -X) method=$2; shift ;;
    --data-binary) data=${2#@}; shift ;;
    -w|-m|-H) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
printf '%s %s\n' "$method" "$url" >> "$REC/curl.calls"
case "$method $url" in
  "GET "*/job)
    if [ -n "${JOB_CODE:-}" ] && [ "$JOB_CODE" != 200 ]; then printf '%s' "$JOB_CODE"; exit 0; fi
    cat "$REC/job.json" > "$out"; printf 200 ;;
  "POST "*/result) cp "$data" "$REC/body.json"; printf 204 ;;
  *) printf 404 ;;
esac
EOF

# claude stub: records env and argv; CLAUDE_MODE picks ok | fail.
cat > "$STUB/claude" <<'EOF'
#!/bin/sh
{
  echo "TMUX=${TMUX-unset}"
  echo "TMUX_PANE=${TMUX_PANE-unset}"
  echo "SEND_KEYS=${METATERM_SEND_KEYS-unset}"
  echo "API_KEY=${ANTHROPIC_API_KEY-unset}"
  echo "PWD=$(pwd)"
} > "$REC/claude.env"
for a in "$@"; do printf '%s\n' "$a"; done > "$REC/claude.argv"
if [ "${CLAUDE_MODE:-ok}" = fail ]; then
  echo 'Error: gateway refused the token' >&2
  exit 3
fi
printf '%s\n' '{"type":"result","is_error":false,"result":"{\"summary\":\"s\"}","usage":{"input_tokens":10,"output_tokens":5},"modelUsage":{"claude-haiku":{}}}'
EOF
chmod +x "$STUB/curl" "$STUB/claude"

HOME_DIR="$WORK/home"
mkdir -p "$HOME_DIR/.termag"
printf '%s\n' '{"token":"tmag_secret","termag_url":"wss://orch.example/termag/ws/agent?x=1"}' \
  > "$HOME_DIR/.termag/agent.config.json"
printf '%s\n' '{"id":"b1","prompt":"Review it","allowedTools":["mcp__metaterm__activity_ledger","mcp__metaterm__list_sessions"],"maxTurns":12,"model":"haiku"}' \
  > "$REC/job.json"

run() {
  env -u TERMAG_URL HOME="$HOME_DIR" PATH="$STUB:/usr/bin:/bin" REC="$REC" \
    TMUX=/tmp/tmux-1/default,1,0 TMUX_PANE=%3 ANTHROPIC_API_KEY=keep \
    CLAUDE_BIN="$STUB/claude" "$@"
}
reset() { rm -f "$REC"/curl.* "$REC"/claude.* "$REC/body.json"; }

# ── the happy path ──────────────────────────────────────────────────────────
reset
run "$SCRIPT" b1 >/dev/null 2>&1
got=$?
[ "$got" = 0 ] || fail 'exits with claude status' 0 "$got"
got="$(cat "$REC/curl.calls")"
want="GET https://orch.example/termag/api/briefings/b1/job
POST https://orch.example/termag/api/briefings/b1/result"
[ "$got" = "$want" ] || fail 'reads the job, posts the result, from the agent URL' "$want" "$got"
grep -q tmag_secret "$REC/curl.argv" && fail 'token never on argv' 'absent' 'present'
grep -q 'Authorization: Bearer tmag_secret' "$REC/curl.stdin" || fail 'token on stdin' 'header' "$(cat "$REC/curl.stdin")"
got="$(tr '\n' ' ' < "$REC/claude.argv")"
want='-p Review it --output-format json --tools  --strict-mcp-config --mcp-config '"$(sed -n "s/^mcp_config='\\(.*\\)'$/\\1/p" "$SCRIPT")"' --permission-mode dontAsk --allowedTools mcp__metaterm__activity_ledger,mcp__metaterm__list_sessions --max-turns 12 --model haiku '
[ "$got" = "$want" ] || fail 'claude gets the job, with no built-in tool and no other MCP server' "$want" "$got"
mcp="$(sed -n '/^--mcp-config$/{n;p;}' "$REC/claude.argv")"
got="$(printf '%s' "$mcp" | jq -c '[(.mcpServers | keys), .mcpServers.metaterm.env.METATERM_SEND_KEYS]')"
[ "$got" = '[["metaterm"],"off"]' ] || fail 'the MCP config is metaterm only, send_keys off' '[["metaterm"],"off"]' "$got"
got="$(tr '\n' ' ' < "$REC/claude.env")"
want="TMUX=unset TMUX_PANE=unset SEND_KEYS=off API_KEY=keep PWD=$HOME_DIR/.termag/briefing "
[ "$got" = "$want" ] || fail 'claude env: no tmux, send_keys off, key kept, state dir' "$want" "$got"
got="$(jq -c . "$REC/body.json")"
want='{"result":"{\"summary\":\"s\"}","exitStatus":0,"isError":false,"usage":{"input_tokens":10,"output_tokens":5},"model":"claude-haiku"}'
[ "$got" = "$want" ] || fail 'result body' "$want" "$got"
[ -f "$HOME_DIR/.termag/briefing/b1.log" ] || fail 'logs to the state dir' 'b1.log' 'missing'
grep -q 'result posted' "$HOME_DIR/.termag/briefing/b1.log" || fail 'logs the post' 'result posted' "$(cat "$HOME_DIR/.termag/briefing/b1.log")"

# ── claude fails without a result ───────────────────────────────────────────
reset
run env CLAUDE_MODE=fail "$SCRIPT" b1 >/dev/null 2>&1
got=$?
[ "$got" = 3 ] || fail 'exits with the failing claude status' 3 "$got"
got="$(jq -c . "$REC/body.json")"
want='{"result":"claude exited 3 without a result: Error: gateway refused the token","exitStatus":3,"isError":true}'
[ "$got" = "$want" ] || fail 'error result names stderr' "$want" "$got"

# ── no claude ───────────────────────────────────────────────────────────────
reset
run env CLAUDE_BIN=/nonexistent/claude "$SCRIPT" b1 >/dev/null 2>&1
got="$(jq -r .result "$REC/body.json" 2>/dev/null)"
case "$got" in
  *'without a result'*) : ;;
  *) fail 'a missing claude still posts an error' 'without a result' "$got" ;;
esac

# ── job unreadable ──────────────────────────────────────────────────────────
reset
run env JOB_CODE=404 "$SCRIPT" b1 >/dev/null 2>&1
got=$?
[ "$got" = 1 ] || fail 'an unreadable job exits 1' 1 "$got"
[ -f "$REC/claude.argv" ] && fail 'an unreadable job runs nothing' 'no claude' 'claude ran'
[ -f "$REC/body.json" ] && fail 'an unreadable job posts nothing' 'no post' 'posted'

# ── TERMAG_URL and a bad id ─────────────────────────────────────────────────
reset
run env TERMAG_URL=http://127.0.0.1:3040/termag/ "$SCRIPT" b1 >/dev/null 2>&1
got="$(head -n 1 "$REC/curl.calls")"
[ "$got" = 'GET http://127.0.0.1:3040/termag/api/briefings/b1/job' ] || fail 'TERMAG_URL wins' 'local URL' "$got"

reset
run "$SCRIPT" '../x' >/dev/null 2>&1
got=$?
[ "$got" = 2 ] || fail 'a bad id exits 2' 2 "$got"
[ -f "$REC/curl.calls" ] && fail 'a bad id calls nothing' 'no curl' 'curl ran'

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo 'termag-briefing: all tests passed'
