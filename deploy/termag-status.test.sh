#!/bin/sh
# Tests endpoint resolution in deploy/termag-status.
#
# --print-endpoint, --print-mirrors, --print-auth, --print-payload and
# --classify are exercised: they are pure, so the tests need no network and no
# server. The session tests start a private tmux server, and are skipped where
# tmux is not installed.
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

# gh's real merge output (gh 2.x, "%s %s pull request %s#%d (%s)" on stderr):
# no URL, so the URL is built from owner/repo#N. Object responses carry it in
# .stderr; string responses have stdout and stderr together.
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"cd repo && gh pr merge 171 --squash"},"tool_response":{"stdout":"","stderr":"✓ Squashed and merged pull request org/repo#171 (feat: lanes)\n✓ Deleted local branch feat/lanes"}}')"
[ "$got" = "pr_merged https://github.com/org/repo/pull/171" ] || fail 'classify gh pr merge from its real stderr line' 'pr_merged <url>' "$got"

got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 12 --rebase --repo o/r"},"tool_response":"✓ Rebased and merged pull request o/r#12 (fix: x)"}')"
[ "$got" = "pr_merged https://github.com/o/r/pull/12" ] || fail 'classify a rebase merge' 'pr_merged <url>' "$got"

got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 13 --merge"},"tool_response":"✓ Merged pull request o/r#13 (Merge the thing)"}')"
[ "$got" = "pr_merged https://github.com/o/r/pull/13" ] || fail 'classify a merge commit' 'pr_merged <url>' "$got"

# Not merges: auto-merge only queues it, and an already-merged PR was not merged by this call.
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 14 --auto --squash"},"tool_response":"✓ Pull request o/r#14 will be automatically merged via squash when all requirements are met"}')"
[ -z "$got" ] || fail 'gh pr merge --auto is not a milestone' '' "$got"

got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 15 --squash"},"tool_response":"! Pull request o/r#15 was already merged"}')"
[ -z "$got" ] || fail 'an already-merged PR is not a milestone' '' "$got"

got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 16 --squash"},"tool_response":"X Pull request o/r#16 is not mergeable: the merge commit cannot be cleanly created."}')"
[ -z "$got" ] || fail 'a failed merge is not a milestone' '' "$got"

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

# The termag-pr skill opens PRs through termag-pr-create, which runs gh pr create itself.
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"termag-pr-create /tmp/termag-pr/title.txt /tmp/termag-pr/body.md --draft"},"tool_response":{"stdout":"https://github.com/org/repo/pull/172\n","stderr":""}}')"
[ "$got" = "pr_created https://github.com/org/repo/pull/172" ] || fail 'classify termag-pr-create' 'pr_created <url>' "$got"

got="$(classify '{"tool_name":"Bash","tool_input":{"command":"cd repo && ~/.local/bin/termag-pr-create t.txt b.md"},"tool_response":"https://github.com/org/repo/pull/173\n"}')"
[ "$got" = "pr_created https://github.com/org/repo/pull/173" ] || fail 'classify termag-pr-create by path' 'pr_created <url>' "$got"

got="$(classify '{"tool_name":"Bash","tool_input":{"command":"cat deploy/termag-pr-create"},"tool_response":"https://github.com/org/repo/pull/174"}')"
[ -z "$got" ] || fail 'reading termag-pr-create is not a milestone' '' "$got"

# A heredoc BODY that documents the command (and even prints a PR URL) is not a
# milestone: grep's ^ is line-anchored, so the body is stripped before matching.
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"cat > NOTES.md <<'"'"'EOF'"'"'\nTo ship:\ngh pr create --fill\nsee https://github.com/o/r/pull/9\nEOF\ncat NOTES.md"},"tool_response":"To ship:\ngh pr create --fill\nsee https://github.com/o/r/pull/9\n"}')"
[ -z "$got" ] || fail 'gh pr create inside a heredoc body is not a milestone' '' "$got"

# ...but a real create that FEEDS a heredoc (the << line itself) still counts.
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr create --title t --body-file - <<'"'"'EOF'"'"'\nSummary\nEOF"},"tool_response":"https://github.com/o/r/pull/10\n"}')"
[ "$got" = "pr_created https://github.com/o/r/pull/10" ] || fail 'gh pr create with a heredoc body is a milestone' 'pr_created <url>' "$got"

# <<- with an indented terminator, followed by a real command.
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"cat <<-DOC\n\tgh pr create\n\tDOC\ngh pr merge 11 --squash"},"tool_response":"✓ Squashed and merged pull request o/r#11 (t)"}')"
[ "$got" = "pr_merged https://github.com/o/r/pull/11" ] || fail 'command after an indented <<- heredoc still classifies' 'pr_merged <url>' "$got"

# A merged PR's title can carry another PR's URL (backports, reverts): the
# ref on gh's merge line wins over it.
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr merge 5 --squash"},"tool_response":{"stdout":"","stderr":"✓ Squashed and merged pull request o/r#5 (backports https://github.com/o/r/pull/4)"}}')"
[ "$got" = "pr_merged https://github.com/o/r/pull/5" ] || fail 'merge line ref beats a URL in the title' 'pr_merged .../pull/5' "$got"

# A create that fails because the branch already has a PR prints that PR's
# URL on stderr and exits non-zero: not a PR anybody just opened.
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr create --fill"},"tool_response":{"stdout":"","stderr":"a pull request for branch \"feat/x\" into branch \"main\" already exists:\nhttps://github.com/o/r/pull/8\n"}}')"
[ -z "$got" ] || fail 'a create refused for an existing PR is no milestone' '(nothing)' "$got"
got="$(classify '{"tool_name":"Bash","tool_input":{"command":"gh pr create --fill"},"tool_response":{"stdout":"https://github.com/o/r/pull/9\n","stderr":"Creating pull request for feat/y into main in o/r\n"}}')"
[ "$got" = "pr_created https://github.com/o/r/pull/9" ] || fail 'create reads its URL from stdout' 'pr_created .../pull/9' "$got"

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

# ── session-start: ~/.local/bin for Claude Code's Bash tool ────────────────
# Claude sources $CLAUDE_ENV_FILE before every Bash command, after its PATH
# snapshot, so this is the one place a PATH change reaches that shell.
SS_HOME="$WORK/ss-home"; mkdir -p "$SS_HOME/.local/bin"
printf '#!/bin/sh\necho termag-cli\n' > "$SS_HOME/.local/bin/termag"; chmod 755 "$SS_HOME/.local/bin/termag"
ENVF="$WORK/claude-env.sh"; : > "$ENVF"
env -u TMUX HOME="$SS_HOME" CLAUDE_ENV_FILE="$ENVF" "$SCRIPT" session-start </dev/null
got=$?
[ "$got" = 0 ] || fail 'session-start exits 0 outside tmux' 0 "$got"
env -u TMUX HOME="$SS_HOME" CLAUDE_ENV_FILE="$ENVF" "$SCRIPT" session-start </dev/null
got="$(grep -c 'local/bin' "$ENVF")"
[ "$got" = 1 ] || fail 'session-start writes the PATH line once' 1 "$got"
for sh in sh bash; do
  got="$(HOME="$SS_HOME" PATH=/usr/bin:/bin "$sh" -c ". '$ENVF'; . '$ENVF'; termag; printf '%s' \"\$PATH\" | tr : '\n' | grep -c local/bin")"
  [ "$got" = "termag-cli
1" ] || fail "$sh: the env file puts ~/.local/bin on PATH once" 'termag-cli + 1' "$got"
done
if command -v zsh >/dev/null 2>&1; then
  got="$(HOME="$SS_HOME" PATH=/usr/bin:/bin zsh -f -c ". '$ENVF'; termag")"
  [ "$got" = termag-cli ] || fail 'zsh: the env file puts ~/.local/bin on PATH' termag-cli "$got"
fi
got="$(HOME="$WORK/empty-home" PATH=/usr/bin:/bin sh -c ". '$ENVF'; echo \"\$PATH\"")"
[ "$got" = /usr/bin:/bin ] || fail 'no ~/.local/bin leaves PATH alone' /usr/bin:/bin "$got"
env -u CLAUDE_ENV_FILE -u TMUX HOME="$SS_HOME" "$SCRIPT" session-start </dev/null
got=$?
[ "$got" = 0 ] || fail 'session-start without CLAUDE_ENV_FILE exits 0' 0 "$got"

# ── which session: tmux panes, the t3 server, no tmux at all ─────────────────
# A private tmux server under $WORK stands in for a box's: a project with a
# workstream, its ctrl pane, a session started in the home directory, and the
# t3 server's own `termag-t3` (agent/t3-bridge.js). TMUX_TMPDIR keeps even the
# "default" server inside $WORK. Skipped without tmux.
if command -v tmux >/dev/null 2>&1; then
  # Its own TMUX_TMPDIR: the next section starts another server while this
  # one may still be going away.
  TT="$WORK/tmux-t3"; mkdir -p "$TT"
  H="$WORK/t3home"; P="$H/termag/projects/x"
  mkdir -p "$P/src/deep" "$P/.worktrees/feat/lib" "$P/.worktrees/gone" "$H/scratch" "$H/elsewhere"
  ln -s "$P" "$H/x-link"
  # The default server's socket under TMUX_TMPDIR, so the no-$TMUX cases reach it too.
  mkdir -p "$TT/tmux-$(id -u)"; chmod 700 "$TT/tmux-$(id -u)"
  SOCK="$TT/tmux-$(id -u)/default"
  tm() { TMUX_TMPDIR="$TT" tmux -S "$SOCK" "$@"; }
  tm new-session -d -s psecor-x-agent -c "$P" 'sleep 600'
  tm new-session -d -s psecor-x-ctrl -c "$P" 'sleep 600'
  tm new-session -d -s psecor-x-feat-agent -c "$P/.worktrees/feat" 'sleep 600'
  tm new-session -d -s psecor-home-agent -c "$H" 'sleep 600'
  tm new-session -d -s termag-t3 -c "$H" 'sleep 600'
  SPID=$(tm display-message -p -t '=termag-t3' '#{pid}')
  T3PANE=$(tm list-panes -t '=termag-t3' -F '#{pane_id}')
  XPANE=$(tm list-panes -t '=psecor-x-agent' -F '#{pane_id}')
  # As a hook runs: env, cwd and stdin from Claude Code; never posts (--print-payload).
  hook() {  # hook <dir> <TERMAG_T3> <TMUX_PANE> <mode> [stdin]
    (cd "$1" && printf '%s' "${5:-}" | env -u TERMAG_STATUS_SESSION -u CLAUDE_PROJECT_DIR HOME="$H" TMUX_TMPDIR="$TT" \
      TMUX="$SOCK,$SPID,0" TMUX_PANE="$3" ${2:+TERMAG_T3=$2} TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" \
      "$SCRIPT" "$4" --print-payload)
  }
  t3hook() {  # t3hook <CLAUDE_PROJECT_DIR> <mode> [stdin]: inside the t3 server
    (cd "$H" && printf '%s' "${3:-}" | env -u TERMAG_STATUS_SESSION HOME="$H" TMUX_TMPDIR="$TT" \
      TMUX="$SOCK,$SPID,0" TMUX_PANE="$T3PANE" TERMAG_T3=1 CLAUDE_PROJECT_DIR="$1" \
      TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" "$SCRIPT" "$2" --print-payload)
  }

  got="$(hook "$P" '' "$XPANE" working)"
  want='{"session":"psecor-x-agent","status":"working"}'
  [ "$got" = "$want" ] || fail 'a project pane: its own session, payload unchanged' "$want" "$got"

  got="$(t3hook "$P" working | jq -r .session)"
  [ "$got" = psecor-x-agent ] || fail 'a desktop thread in the checkout: the project agent session' psecor-x-agent "$got"
  got="$(t3hook "$P/src/deep" working | jq -r .session)"
  [ "$got" = psecor-x-agent ] || fail 'a thread in a subdirectory of the checkout' psecor-x-agent "$got"
  got="$(t3hook "$H/x-link" working | jq -r .session)"
  [ "$got" = psecor-x-agent ] || fail 'a thread in a symlink to the checkout' psecor-x-agent "$got"
  got="$(t3hook "$P/.worktrees/feat/lib" working | jq -r .session)"
  [ "$got" = psecor-x-feat-agent ] || fail "a thread in a workstream's worktree: that workstream's session" psecor-x-feat-agent "$got"
  got="$(t3hook "$P/.worktrees/gone" working | jq -r .session)"
  [ "$got" = termag-t3 ] || fail 'a worktree with no session of its own is not filed under main' termag-t3 "$got"
  got="$(t3hook "$H/scratch" working | jq -r .session)"
  [ "$got" = termag-t3 ] || fail 'a thread outside every checkout: the t3 server session (a home-dir session never claims it)' termag-t3 "$got"
  # A renamed workstream: the worktree moved and the session renamed, its
  # session_path left behind; the pane's process moved with the directory.
  mkdir -p "$P/.worktrees/before"
  tm new-session -d -s psecor-x-before-agent -c "$P/.worktrees/before" 'sleep 600'
  mv "$P/.worktrees/before" "$P/.worktrees/after"
  tm rename-session -t '=psecor-x-before-agent' psecor-x-after-agent
  got="$(t3hook "$P/.worktrees/after" working | jq -r .session)"
  [ "$got" = psecor-x-after-agent ] || fail 'a renamed workstream (stale session_path): where its pane is now' psecor-x-after-agent "$got"
  got="$(t3hook "$WORK/no-such-dir" working | jq -r .session)"
  [ "$got" = termag-t3 ] || fail 'a directory that is not there: the t3 server session' termag-t3 "$got"

  got="$(t3hook "$P" working)"
  want='{"session":"psecor-x-agent","status":"working","source":"t3:claude"}'
  [ "$got" = "$want" ] || fail 'a desktop post carries source t3:claude (PreToolUse: no stdin, no thread)' "$want" "$got"
  got="$(t3hook "$P" prompt-submit '{"session_id":"8f1c2d3e-0000-4000-8000-000000000001","prompt":"hi"}')"
  want='{"session":"psecor-x-agent","status":"working","source":"t3:claude","threadId":"8f1c2d3e-0000-4000-8000-000000000001"}'
  [ "$got" = "$want" ] || fail "UserPromptSubmit names the thread by the hook's session_id" "$want" "$got"
  got="$(t3hook "$P" stop '{"session_id":"8f1c2d3e-0000-4000-8000-000000000001","stop_hook_active":false}')"
  want='{"session":"psecor-x-agent","status":"idle","source":"t3:claude","threadId":"8f1c2d3e-0000-4000-8000-000000000001"}'
  [ "$got" = "$want" ] || fail 'Stop names the thread too' "$want" "$got"
  got="$(t3hook "$P" stop '{"session_id":"no spaces or $hell allowed"}' | jq -c 'has("threadId")')"
  [ "$got" = false ] || fail 'an odd session_id is left out' false "$got"

  # A t3 server an older agent started has no TERMAG_T3: its own pane says so.
  got="$(hook "$P" '' "$T3PANE" working)"
  want='{"session":"psecor-x-agent","status":"working","source":"t3:claude"}'
  [ "$got" = "$want" ] || fail 'inside the termag-t3 pane without TERMAG_T3' "$want" "$got"

  # No $TMUX and not the t3 server: no context, nothing posted, even though
  # display-message would name the default server's newest session.
  got="$(cd "$P" && env -u TMUX -u TMUX_PANE -u TERMAG_T3 -u TERMAG_STATUS_SESSION HOME="$H" TMUX_TMPDIR="$TT" \
    TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" "$SCRIPT" working --print-payload)"
  [ -z "$got" ] || fail 'no $TMUX: posts nothing (an ask run, the briefing)' '' "$got"
  # ...while the t3 path still finds the checkout's session on the default server.
  got="$(cd "$P" && env -u TMUX -u TMUX_PANE -u TERMAG_STATUS_SESSION -u CLAUDE_PROJECT_DIR HOME="$H" TMUX_TMPDIR="$TT" \
    TERMAG_T3=1 TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" "$SCRIPT" working --print-payload | jq -r .session)"
  [ "$got" = psecor-x-agent ] || fail 'a t3 terminal (no $TMUX): the working directory, on the default server' psecor-x-agent "$got"

  tm kill-server 2>/dev/null
else
  echo "skip: tmux not installed (session tests)"
fi

# ── which session: only inside tmux ─────────────────────────────────────────
# A private tmux server under $WORK stands in for a box's. TMUX_TMPDIR keeps
# even its default socket there, so a hook run without $TMUX reaches it, as
# one run by termag-subagent-run or termag-briefing would. Skipped without tmux.
if command -v tmux >/dev/null 2>&1; then
  TT="$WORK/tmux"
  mkdir -p "$TT/tmux-$(id -u)"; chmod 700 "$TT/tmux-$(id -u)"
  SOCK="$TT/tmux-$(id -u)/default"
  tm() { TMUX_TMPDIR="$TT" tmux -S "$SOCK" "$@"; }
  tm new-session -d -s psecor-x-agent 'sleep 600'
  tm new-session -d -s psecor-y-agent 'sleep 600'
  SPID=$(tm display-message -p -t '=psecor-x-agent' '#{pid}')
  XPANE=$(tm list-panes -t '=psecor-x-agent' -F '#{pane_id}')

  got="$(env -u TERMAG_STATUS_SESSION HOME="$WORK/empty-home" TMUX_TMPDIR="$TT" TMUX="$SOCK,$SPID,0" TMUX_PANE="$XPANE" \
    TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" "$SCRIPT" working --print-payload)"
  want='{"session":"psecor-x-agent","status":"working"}'
  [ "$got" = "$want" ] || fail 'inside a tmux pane: the session of that pane' "$want" "$got"

  # Without $TMUX, display-message still names a session of the default server...
  got="$(env -u TMUX -u TMUX_PANE TMUX_TMPDIR="$TT" tmux display-message -p '#S' 2>/dev/null)"
  [ -n "$got" ] || fail 'precondition: display-message answers without $TMUX' '(a session name)' "$got"
  # ...but it is not this hook's, so nothing is posted.
  got="$(env -u TMUX -u TMUX_PANE -u TERMAG_STATUS_SESSION HOME="$WORK/empty-home" TMUX_TMPDIR="$TT" \
    TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" "$SCRIPT" working --print-payload)"
  [ -z "$got" ] || fail 'outside tmux: posts nothing' '' "$got"
  got="$(printf '{"hook_event_name":"Stop"}' | env -u TMUX -u TMUX_PANE -u TERMAG_STATUS_SESSION HOME="$WORK/empty-home" \
    TMUX_TMPDIR="$TT" TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" "$SCRIPT" stop --print-payload)"
  [ -z "$got" ] || fail 'outside tmux: a Stop hook posts nothing' '' "$got"
  # TERMAG_STATUS_SESSION still names the session outside tmux.
  got="$(env -u TMUX -u TMUX_PANE TERMAG_STATUS_SESSION=psecor-z-agent HOME="$WORK/empty-home" TMUX_TMPDIR="$TT" \
    TERMAG_AGENT_CONFIG="$WORK/does-not-exist.json" "$SCRIPT" working --print-payload)"
  want='{"session":"psecor-z-agent","status":"working"}'
  [ "$got" = "$want" ] || fail 'outside tmux, TERMAG_STATUS_SESSION still names the session' "$want" "$got"

  tm kill-server 2>/dev/null
else
  echo "skip: tmux not installed (session tests)"
fi

if [ "$failures" -eq 0 ]; then
  echo "PASS: endpoint resolution + auth handling + payloads + milestone classification"
  exit 0
fi
echo "$failures failure(s)"
exit 1
