#!/bin/sh
# Tests endpoint resolution in deploy/termag-status.
#
# --print-endpoint, --print-mirrors, --print-auth, --print-payload and
# --classify are exercised: they are pure, so the tests need no network, no
# tmux and no server.
#
# Run: sh deploy/termag-status.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-status"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

# Resolve with a given agent.config.json body ("" = no config file at all).
resolve() {
  cfg="$WORK/agent.config.json"
  if [ -z "$1" ]; then
    rm -f "$cfg"
    TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" HOME="$WORK/empty-home" \
      "$SCRIPT" --print-endpoint
  else
    printf '%s' "$1" > "$cfg"
    TERMAG_AGENT_CONFIG="$cfg" "$SCRIPT" --print-endpoint
  fi
}

check() {
  desc="$1"; body="$2"; want="$3"
  got="$(resolve "$body")"
  [ "$got" = "$want" ] || fail "$desc" "$want" "$got"
}

# ws:// -> http://, and /ws/agent -> /api/status
check 'remote ws' \
  '{"termag_url":"ws://ip-10-0-0-1.ec2.internal:3040/termag/ws/agent","token":"x"}' \
  'http://ip-10-0-0-1.ec2.internal:3040/termag/api/status'

# wss:// -> https:// (reverse-proxied deployment)
check 'remote wss' \
  '{"termag_url":"wss://termag.example.com/termag/ws/agent","token":"x"}' \
  'https://termag.example.com/termag/api/status'

# co-located server: the same derivation, not a special case
check 'co-located localhost' \
  '{"termag_url":"ws://localhost:3040/termag/ws/agent","token":"x"}' \
  'http://localhost:3040/termag/api/status'

# a query string on the URL must not leak into the endpoint (it can carry a token)
check 'query stripped' \
  '{"termag_url":"ws://localhost:3040/termag/ws/agent?token=secret","token":"x"}' \
  'http://localhost:3040/termag/api/status'

# a non-default BASE_PATH still resolves relative to the ws path
check 'custom base path' \
  '{"termag_url":"wss://example.com/some/base/ws/agent","token":"x"}' \
  'https://example.com/some/base/api/status'

# missing termag_url -> agent.js's fallback, not an empty or malformed URL
check 'config without termag_url' \
  '{"token":"x"}' \
  'http://127.0.0.1:3040/termag/api/status'

# unreadable/absent config -> same fallback
got="$(resolve '')"
want='http://127.0.0.1:3040/termag/api/status'
[ "$got" = "$want" ] || fail 'no config at all' "$want" "$got"

# malformed JSON must not produce a garbage endpoint
check 'malformed json' \
  'not json at all' \
  'http://127.0.0.1:3040/termag/api/status'


# ── auth ────────────────────────────────────────────────────────────────────
# Remote status writes require the agent token: the server trusts same-host
# callers (isLocalPeer) but a box reaches :3040 over the private VPC, where
# requireAuthOrAgentToken applies. Without the token a provisioned box 401s and,
# because the hooks discard output, fails silently.

auth_of() {
  cfg="$WORK/auth.json"
  printf '%s' "$1" > "$cfg"
  TERMAG_AGENT_CONFIG="$cfg" HOME="$WORK/empty-home" "$SCRIPT" --print-auth
}

got="$(auth_of '{"termag_url":"ws://h:3040/termag/ws/agent","token":"tmag_abc"}')"
[ "$got" = "token: present" ] || fail 'token present' 'token: present' "$got"

got="$(auth_of '{"termag_url":"ws://h:3040/termag/ws/agent"}')"
[ "$got" = "token: absent" ] || fail 'token absent when config has none' 'token: absent' "$got"

got="$(auth_of 'not json')"
[ "$got" = "token: absent" ] || fail 'token absent on malformed config' 'token: absent' "$got"

# --print-auth must never print the token itself.
out="$(auth_of '{"termag_url":"ws://h/termag/ws/agent","token":"tmag_SECRET"}')"
case "$out" in
  *tmag_SECRET*) fail '--print-auth leaks the token' 'presence only' "$out" ;;
esac

# The token must reach curl via `-K -` (config on stdin), never as a -H
# argument: process command lines are world-readable and this token can write
# status for any of the owner's sessions. agent.js takes the same care.
grep -q 'curl -sf -m 5 -K -' "$SCRIPT" \
  || fail 'token not passed via curl -K' 'curl -sf -m 5 -K -' 'not found'
if grep -E "\-H ['\"]?Authorization" "$SCRIPT" >/dev/null 2>&1; then
  fail 'Authorization passed on the command line' 'no -H Authorization' 'found one'
fi

# ── payloads (--print-payload: pure, POSTs nothing) ─────────────────────────
# TERMAG_STATUS_SESSION stands in for `tmux display-message -p '#S'`.
payload() {
  TERMAG_STATUS_SESSION=psecor-x-agent TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" \
    HOME="$WORK/empty-home" "$SCRIPT" "$@" --print-payload
}

# The Claude hooks' payload must stay byte-identical: no `source` key, because
# the server attributes a source-less status to Claude.
got="$(payload working)"
want='{"session":"psecor-x-agent","status":"working"}'
[ "$got" = "$want" ] || fail 'plain working payload unchanged' "$want" "$got"

got="$(payload idle --source pi-ext:pi)"
want='{"session":"psecor-x-agent","status":"idle","source":"pi-ext:pi"}'
[ "$got" = "$want" ] || fail '--source is added when given' "$want" "$got"

got="$(payload waiting --source pi-ext:pi --reason user_input --notify --message 'Continue?' --rate-limited 'pi: HTTP 502')"
want='{"session":"psecor-x-agent","status":"waiting","source":"pi-ext:pi","waitingReason":"user_input","message":"Continue?","notify":true,"rateLimited":"pi: HTTP 502"}'
[ "$got" = "$want" ] || fail 'waiting with reason/notify/message/rateLimited' "$want" "$got"

long="$(printf 'x%.0s' $(seq 1 250))"
got="$(payload waiting --message "$long" | jq -r '.message | length')"
[ "$got" = 200 ] || fail '--message is trimmed to 200 chars' 200 "$got"

got="$(payload meta --source pi-ext:pi --context-tokens 1234)"
want='{"session":"psecor-x-agent","source":"pi-ext:pi","contextTokens":1234}'
[ "$got" = "$want" ] || fail 'meta contextTokens (no status key)' "$want" "$got"

got="$(payload meta --rate-limited null)"
want='{"session":"psecor-x-agent","rateLimited":null}'
[ "$got" = "$want" ] || fail 'meta --rate-limited null clears' "$want" "$got"

got="$(payload meta --context-tokens notanumber)"
want=''
[ "$got" = "$want" ] || fail 'non-numeric --context-tokens is dropped (nothing to send)' "$want" "$got"

got="$(payload meta)"
[ -z "$got" ] || fail 'meta with nothing to send prints nothing' '' "$got"

got="$(payload working --bogus-flag yes --source s)"
want='{"session":"psecor-x-agent","status":"working","source":"s"}'
[ "$got" = "$want" ] || fail 'unknown options are ignored' "$want" "$got"


# --- --classify: PostToolUse payload → milestone --------------------------------
# Pure (no tmux, no network): what `post-tool` would additionally POST.
classify() { printf '%s' "$1" | HOME="$WORK/empty-home" "$SCRIPT" --classify; }

got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr create --title x --body y"},"tool_response":"Creating pull request...\nhttps://github.com/org/repo/pull/171\n"}')"
[ "$got" = "pr_created https://github.com/org/repo/pull/171" ] || fail 'classify gh pr create with url' 'pr_created <url>' "$got"

got="$(classify '{"tool_name":"Bash","tool_input":{"command":"cd repo && gh pr merge 171 --squash"},"tool_response":{"stdout":"✓ Merged pull request #171 (https://github.com/org/repo/pull/171)"}}')"
[ "$got" = "pr_merged https://github.com/org/repo/pull/171" ] || fail 'classify gh pr merge after && with object response' 'pr_merged <url>' "$got"

# No URL in the output = the command did not succeed (gh prints the PR URL on
# success); a failed `gh pr create` must not announce a PR that doesn't exist.
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr create -f"},"tool_response":"error: no commits between main and feat/x"}')"
[ -z "$got" ] || fail 'failed gh pr create (no url) is not a milestone' '' "$got"

got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr view 171"},"tool_response":"https://github.com/org/repo/pull/171"}')"
[ -z "$got" ] || fail 'gh pr view is not a milestone' '' "$got"

got="$(classify '{"tool_name":"Bash","tool_input":{"command":"echo \"run gh pr create later\""},"tool_response":"run gh pr create later"}')"
[ -z "$got" ] || fail 'gh pr create inside a string is not a milestone' '' "$got"

got="$(classify '{"tool_name":"Edit","tool_input":{"file_path":"x"},"tool_response":"ok"}')"
[ -z "$got" ] || fail 'non-Bash tools are ignored' '' "$got"

# A heredoc BODY that documents the command (and even prints a PR URL) is not a
# milestone: grep's ^ is line-anchored, so the body is stripped before matching.
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"cat > NOTES.md <<'"'"'EOF'"'"'\nTo ship:\ngh pr create --fill\nsee https://github.com/o/r/pull/9\nEOF\ncat NOTES.md"},"tool_response":"To ship:\ngh pr create --fill\nsee https://github.com/o/r/pull/9\n"}')"
[ -z "$got" ] || fail 'gh pr create inside a heredoc body is not a milestone' '' "$got"

# ...but a real create that FEEDS a heredoc (the << line itself) still counts.
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr create --title t --body-file - <<'"'"'EOF'"'"'\nSummary\nEOF"},"tool_response":"https://github.com/o/r/pull/10\n"}')"
[ "$got" = "pr_created https://github.com/o/r/pull/10" ] || fail 'gh pr create with a heredoc body is a milestone' 'pr_created <url>' "$got"

# <<- with an indented terminator, followed by a real command.
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"cat <<-DOC\n\tgh pr create\n\tDOC\ngh pr merge 11 --squash"},"tool_response":"✓ Merged pull request #11 (https://github.com/o/r/pull/11)"}')"
[ "$got" = "pr_merged https://github.com/o/r/pull/11" ] || fail 'command after an indented <<- heredoc still classifies' 'pr_merged <url>' "$got"

got="$(classify 'not json')"
[ -z "$got" ] || fail 'malformed payload is ignored' '' "$got"

# The classification must never echo the command text (only kind + url leave the box).
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr create --body SECRETBODY"},"tool_response":"https://github.com/o/r/pull/1"}')"
case "$got" in *SECRETBODY*) fail 'classify leaks command text' 'kind + url only' "$got" ;; esac


# --- mirrors -----------------------------------------------------------------
# One agent config per line in the mirrors file; each resolves like the
# primary; the primary's own endpoint and duplicates are dropped; comments,
# blanks and unreadable paths are ignored; no file means no mirrors.
mdir="$WORK/mirrors"; mkdir -p "$mdir"
printf '%s' '{"termag_url":"ws://prod.internal:3040/termag/ws/agent","token":"p"}' >"$mdir/primary.json"
printf '%s' '{"termag_url":"ws://127.0.0.1:3071/termag/ws/agent","token":"s"}'    >"$mdir/stage.json"
printf '%s' '{"termag_url":"wss://other.example.com/termag/ws/agent","token":"o"}' >"$mdir/other.json"
printf '%s' '{"termag_url":"ws://prod.internal:3040/termag/ws/agent","token":"p2"}' >"$mdir/same-as-primary.json"
mirrors() { TERMAG_AGENT_CONFIG="$mdir/primary.json" TERMAG_STATUS_MIRRORS="$1" HOME="$mdir" "$SCRIPT" --print-mirrors; }

cat >"$mdir/list" <<LIST
# staging stack
$mdir/stage.json
$mdir/same-as-primary.json

$mdir/other.json   # comment after the path
$mdir/stage.json
$mdir/missing.json
LIST
got="$(mirrors "$mdir/list")"
want="$(printf '%s\n%s' 'http://127.0.0.1:3071/termag/api/status' 'https://other.example.com/termag/api/status')"
[ "$got" = "$want" ] || fail 'mirrors: resolved, deduped, primary dropped, junk ignored' "$want" "$got"

got="$(mirrors "$mdir/does-not-exist")"
[ -z "$got" ] || fail 'mirrors: no file means none' '' "$got"

# shellcheck disable=SC2088  # the literal "~/" is the input under test
printf '~/stage.json\n' >"$mdir/tilde-list"
got="$(mirrors "$mdir/tilde-list")"
want='http://127.0.0.1:3071/termag/api/status'
[ "$got" = "$want" ] || fail 'mirrors: ~/ expands to HOME' "$want" "$got"

# the default path is ~/.config/termag/status-mirrors
mkdir -p "$mdir/.config/termag"; printf '%s\n' "$mdir/other.json" >"$mdir/.config/termag/status-mirrors"
got="$(TERMAG_AGENT_CONFIG="$mdir/primary.json" HOME="$mdir" "$SCRIPT" --print-mirrors)"
want='https://other.example.com/termag/api/status'
[ "$got" = "$want" ] || fail 'mirrors: default file under ~/.config/termag' "$want" "$got"

# --print-endpoint is unaffected by mirrors
got="$(TERMAG_AGENT_CONFIG="$mdir/primary.json" HOME="$mdir" "$SCRIPT" --print-endpoint)"
want='http://prod.internal:3040/termag/api/status'
[ "$got" = "$want" ] || fail 'mirrors: primary endpoint unchanged' "$want" "$got"

# ── prompt-submit: working, plus the title once inside a cloud session ─────
# (--print-payload: pure; the title line is printed after the status payload.)
RUNDIR="$WORK/runner-state"; mkdir -p "$RUNDIR"
prompt_payload() {  # extra env, then the hook JSON on stdin
  TERMAG_STATUS_SESSION=termag-claude-runner-s2-ord_d1-r TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" HOME="$WORK/empty-home" \
    env "$@" "$SCRIPT" prompt-submit --print-payload
}
got="$(printf '{"prompt":"Fix the auth bug\\nin login.ts"}' | prompt_payload TERMAG_CLAUDE_RUNNER_ORDER=ord.1 TERMAG_CLAUDE_RUNNER_DIR="$RUNDIR" CLAUDE_CODE_REMOTE_SESSION_ID=cse_01A)"
want='{"session":"termag-claude-runner-s2-ord_d1-r","status":"working"}
{"event":"title","orderId":"ord.1","title":"Fix the auth bug"}'
[ "$got" = "$want" ] || fail 'prompt-submit in a cloud session: working plus the first line as the title' "$want" "$got"
got="$(printf '{"prompt":"Fix the auth bug"}' | prompt_payload)"
want='{"session":"termag-claude-runner-s2-ord_d1-r","status":"working"}'
[ "$got" = "$want" ] || fail 'prompt-submit outside a cloud session: working only' "$want" "$got"
# The marker is claimed before anything is posted (or printed), so a second
# prompt whose hook overlaps the first finds it taken.
[ -e "$RUNDIR/ord.1.titled" ] || fail 'prompt-submit: the once-marker is claimed before posting' 'marker present' 'absent'
got="$(printf '{"prompt":"Second prompt"}' | prompt_payload TERMAG_CLAUDE_RUNNER_ORDER=ord.1 TERMAG_CLAUDE_RUNNER_DIR="$RUNDIR" CLAUDE_CODE_REMOTE_SESSION_ID=cse_01A)"
[ "$got" = "$want" ] || fail 'prompt-submit once titled: working only' "$want" "$got"
got="$(printf '{"prompt":"  \\n\\n"}' | prompt_payload TERMAG_CLAUDE_RUNNER_ORDER=ord.2 TERMAG_CLAUDE_RUNNER_DIR="$RUNDIR" CLAUDE_CODE_REMOTE_SESSION_ID=cse_01A)"
[ "$got" = "$want" ] || fail 'prompt-submit with an empty prompt: no title' "$want" "$got"
[ ! -e "$RUNDIR/ord.2.titled" ] || fail 'prompt-submit: an empty prompt does not spend the claim' 'no marker' 'marker present'
: > "$RUNDIR/ord.3.titled"
got="$(printf '{"prompt":"Hello"}' | prompt_payload TERMAG_CLAUDE_RUNNER_ORDER=ord.3 TERMAG_CLAUDE_RUNNER_DIR="$RUNDIR" CLAUDE_CODE_REMOTE_SESSION_ID=cse_01A)"
[ "$got" = "$want" ] || fail 'prompt-submit with a pre-existing marker: working only' "$want" "$got"

# ── usage: the cloud session's token summary ──
# Two JSONL lines share a requestId and message.id (Claude Code writes one per
# content block): counted once. A line without usage, a user line and a
# truncated line are skipped. The model is the one most responses came from.
TR="$WORK/transcripts"; mkdir -p "$TR"
cat > "$TR/a.jsonl" <<'EOS'
{"type":"user","uuid":"u1","timestamp":"2026-10-09T10:00:00Z","message":{"role":"user","content":"hi"}}
{"type":"assistant","uuid":"a1","requestId":"req_1","timestamp":"2026-10-09T10:00:05Z","message":{"id":"msg_1","model":"claude-opus-5-5","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":1000,"cache_creation_input_tokens":50}}}
{"type":"assistant","uuid":"a2","requestId":"req_1","timestamp":"2026-10-09T10:00:05Z","message":{"id":"msg_1","model":"claude-opus-5-5","usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":1000,"cache_creation_input_tokens":50}}}
{"type":"assistant","uuid":"a3","requestId":"req_2","timestamp":"2026-10-09T10:01:00Z","message":{"id":"msg_2","model":"claude-haiku-5-5","usage":{"input_tokens":7,"output_tokens":3}}}
{"type":"assistant","uuid":"a4","timestamp":"2026-10-09T10:02:00Z","message":{"id":"msg_3","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":1}}}
{"truncated
EOS
printf '{"type":"assistant","uuid":"b1","requestId":"req_9","timestamp":"2026-10-09T11:00:00Z","message":{"id":"msg_9","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":10,"cache_read_input_tokens":5,"cache_creation_input_tokens":0}}}\n' > "$TR/b.jsonl"
usage_payload() {  # extra env, then the script args
  TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" HOME="$WORK/empty-home" env "$@" --print-payload
}
got="$(usage_payload TERMAG_CLAUDE_RUNNER_ORDER=ord.7 "$SCRIPT" usage --transcript "$TR/a.jsonl" --transcript "$TR/b.jsonl")"
want_prefix='{"event":"usage","orderId":"ord.7","input":118,"output":34,"cacheRead":1005,"cacheCreate":50,"calls":4,"model":"claude-opus-5-5","at":"'
case "$got" in "$want_prefix"*) ;; *) fail 'usage: sums the transcripts once per response, model by majority' "$want_prefix..." "$got" ;; esac
got="$(printf '{"transcript_path":"%s"}' "$TR/b.jsonl" | usage_payload TERMAG_CLAUDE_RUNNER_ORDER=ord.7 "$SCRIPT" usage)"
case "$got" in '{"event":"usage","orderId":"ord.7","input":10,"output":10,"cacheRead":5,"cacheCreate":0,"calls":1,"model":"claude-opus-5-5","at":"'*) ;; *) fail 'usage: reads the transcript the hook payload names' 'input 10 ...' "$got" ;; esac
got="$(usage_payload "$SCRIPT" usage --transcript "$TR/a.jsonl")"
[ -z "$got" ] || fail 'usage: nothing without an order' '' "$got"
got="$(usage_payload TERMAG_CLAUDE_RUNNER_ORDER=ord.7 "$SCRIPT" usage --transcript "$TR/missing.jsonl")"
[ -z "$got" ] || fail 'usage: nothing without a readable transcript' '' "$got"
printf '{"type":"user","uuid":"u1","message":{"role":"user","content":"hi"}}\n' > "$TR/empty.jsonl"
got="$(usage_payload TERMAG_CLAUDE_RUNNER_ORDER=ord.7 "$SCRIPT" usage --transcript "$TR/empty.jsonl")"
[ -z "$got" ] || fail 'usage: nothing when no response carries usage' '' "$got"

# ── stop: idle, plus the usage inside a cloud session ──────────────────────
stop_payload() {
  TERMAG_STATUS_SESSION=termag-claude-runner-s2-ord_d1-r TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" HOME="$WORK/empty-home" \
    env "$@" "$SCRIPT" stop --print-payload
}
got="$(printf '{"transcript_path":"%s","hook_event_name":"Stop"}' "$TR/b.jsonl" | stop_payload TERMAG_CLAUDE_RUNNER_ORDER=ord.8 CLAUDE_CODE_REMOTE_SESSION_ID=cse_01A)"
case "$got" in '{"session":"termag-claude-runner-s2-ord_d1-r","status":"idle"}
{"event":"usage","orderId":"ord.8","input":10,'*) ;; *) fail 'stop in a cloud session: idle, then the usage from the named transcript' 'idle + usage' "$got" ;; esac
got="$(printf '{"transcript_path":"%s"}' "$TR/b.jsonl" | stop_payload)"
[ "$got" = '{"session":"termag-claude-runner-s2-ord_d1-r","status":"idle"}' ] || fail 'stop outside a cloud session: idle only' 'idle' "$got"

if [ "$failures" -eq 0 ]; then
  echo "PASS: endpoint resolution + auth handling + payloads + milestone classification"
  exit 0
fi
echo "$failures failure(s)"
exit 1
