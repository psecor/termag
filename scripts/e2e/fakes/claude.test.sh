#!/bin/bash
# The interactive claude stub resumes a session when --resume is not argv[1].
# Open in full UI execs `claude --permission-mode … --resume <id>`.
set -u

STUB="$(cd "$(dirname "$0")" && pwd)/claude"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK/home"
mkdir -p "$HOME"
cd "$WORK"

failures=0
fail() {
  echo "FAIL: $1"
  failures=$((failures + 1))
}

run() { "$STUB" "$@" </dev/null; }

out="$(run 'hello from the pane')"
id="$(printf '%s\n' "$out" | sed -n 's/^claude (stub): new conversation \([^ ]*\) in .*/\1/p')"
[ -n "$id" ] || fail "a prompt did not start a conversation: $out"
printf '%s\n' "$out" | grep -q 'starting on a 1-line prompt' || fail "a positional prompt was not kept"
printf '%s\n' "$out" | grep -q '  > hello from the pane' || fail "the prompt text was not echoed"

out="$(run --permission-mode bypassPermissions --resume "$id")"
printf '%s\n' "$out" | grep -q "resumed conversation $id" || fail "flagged resume did not reopen $id: $out"
printf '%s\n' "$out" | grep -q 'new conversation' && fail "flagged resume started a new conversation: $out"
printf '%s\n' "$out" | grep -q 'starting on' && fail "a flag value was taken as a prompt: $out"
printf '%s\n' "$out" | grep -q '  > hello from the pane' || fail "flagged resume did not print the earlier line"

out="$(run --resume "$id")"
printf '%s\n' "$out" | grep -q "resumed conversation $id" || fail "a leading --resume did not reopen $id: $out"

out="$(run --permission-mode dontAsk --tools Read,Grep,Glob --strict-mcp-config \
  --mcp-config '{}' --setting-sources user --settings '{"disableAllHooks":true}' --resume "$id")"
printf '%s\n' "$out" | grep -q "resumed conversation $id" || fail "a confined launcher argv did not resume: $out"
printf '%s\n' "$out" | grep -q 'starting on' && fail "confined flag values were taken as a prompt: $out"

missing='11111111-1111-1111-1111-111111111111'
out="$(run --permission-mode bypassPermissions --resume "$missing")"
printf '%s\n' "$out" | grep -q "NO conversation $missing" || fail "a missing session was not reported: $out"
printf '%s\n' "$out" | grep -q 'new conversation' && fail "a missing session started a new conversation: $out"

out="$(run --permission-mode bypassPermissions --continue)"
printf '%s\n' "$out" | grep -q "continuing $id" || fail "--continue after flags did not find $id: $out"

# The Agent SDK's mode (claude-sdk.mjs): the version probe, the initialize
# handshake, a turn, and a tool call that asks the SDK first. `claude auth` is
# claude-auth.mjs's.
[ "$(run --version)" = "2.1.307 (Claude Code)" ] || fail "--version: $(run --version)"
sdk() { E2E_STUB_DELAY_MS=0 "$STUB" --output-format stream-json --verbose --input-format stream-json "$@"; }
out=$(printf '%s\n' \
  '{"type":"control_request","request_id":"r1","request":{"subtype":"initialize"}}' \
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}' | sdk --permission-mode default --include-partial-messages)
# -s and any: jq 1.6's -e takes the last input's result, which select() empties.
printf '%s\n' "$out" | jq -se 'any(.[]; .type == "control_response" and .response.request_id == "r1" and .response.subtype == "success" and (.response.response.account.email | type) == "string")' >/dev/null \
  || fail "initialize was not answered with an account: $out"
printf '%s\n' "$out" | jq -se 'any(.[]; .type == "stream_event" and .event.type == "content_block_delta")' >/dev/null || fail "no partial messages: $out"
[ "$(printf '%s\n' "$out" | jq -r 'select(.type == "result") | .subtype')" = success ] || fail "the turn did not end in a success result: $out"
# A tool call in default mode: the stub asks with can_use_tool and waits for the answer.
coproc SDK { sdk --permission-mode default; }
printf '%s\n' '{"type":"user","message":{"role":"user","content":"run something"}}' >&"${SDK[1]}"
asked=
while IFS= read -r -t 10 line <&"${SDK[0]}"; do
  if [ "$(jq -r 'select(.type == "control_request") | .request.subtype' <<<"$line")" = can_use_tool ]; then asked=$(jq -r .request_id <<<"$line"); break; fi
done
[ -n "$asked" ] || fail "a Bash call in default mode did not ask the SDK"
printf '%s\n' "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"$asked\",\"response\":{\"behavior\":\"deny\",\"message\":\"no thanks\"}}}" >&"${SDK[1]}"
denied=
while IFS= read -r -t 10 line <&"${SDK[0]}"; do
  [ "$(jq -r 'select(.type == "user") | .message.content[0].content' <<<"$line")" = "no thanks" ] && denied=yes
  [ "$(jq -r .type <<<"$line")" = result ] && break
done
# shellcheck disable=SC1083,SC2093 # bash's {varname} form: close the coprocess's stdin
exec {SDK[1]}>&-
[ "$denied" = yes ] || fail "a denied Bash call did not come back as a refused tool result"

# The SDK names the conversation with --session-id=<id> and continues it with
# --resume=<id>, as t3 does when its server comes back (a box stopped and
# started): one transcript, and the turns go on from it.
sid=22222222-2222-2222-2222-222222222222
say() { printf '{"type":"user","message":{"role":"user","content":"%s"}}\n' "$1"; }
answer() { jq -r 'select(.type == "result") | .result'; }
first=$( (say hello; say "run it") | sdk --permission-mode bypassPermissions "--session-id=$sid" | answer | head -n1)
[ "$first" = "Stub Claude here (turn 1, bypassPermissions). You said: hello" ] || fail "--session-id=<id>: $first"
[ -n "$(find "$HOME/.claude/projects" -name "$sid.jsonl")" ] \
  || fail "--session-id=<id> did not name the transcript: $(find "$HOME/.claude/projects" -name '*.jsonl')"
again=$(say "hello again" | sdk --permission-mode bypassPermissions "--resume=$sid" | answer)
[ "$again" = "Stub Claude here (turn 3, bypassPermissions). You said: hello again" ] \
  || fail "--resume=<id> did not go on from the transcript's two prompts (a tool result is not one): $again"
[ "$(find "$HOME/.claude/projects" -name '*.jsonl' -exec grep -l "hello again" {} + | sed 's#.*/##')" = "$sid.jsonl" ] \
  || fail "--resume=<id> wrote another transcript"

# Hooks, as Claude Code runs them under the SDK: the user settings' hooks
# (from CLAUDE_CONFIG_DIR when set), each through /bin/sh in the cwd with the
# event's JSON on stdin and CLAUDE_PROJECT_DIR set; matchers on tool events.
HOOKLOG="$WORK/hooks.log"
logcmd() { printf 'printf "%%s %%s %%s\\n" %s "$CLAUDE_PROJECT_DIR" "$(pwd -P)" >> %s; cat >> %s; echo >> %s' "$1" "$HOOKLOG" "$HOOKLOG" "$HOOKLOG"; }
mkdir -p "$HOME/.claude" "$WORK/proj"
jq -n --arg ss "$(logcmd SessionStart)" --arg up "$(logcmd UserPromptSubmit)" --arg pre "$(logcmd PreToolUse)" \
      --arg edit "$(logcmd PreToolUse-Edit)" --arg post "$(logcmd PostToolUse)" --arg stop "$(logcmd Stop)" '
  def h($c): [{hooks: [{type: "command", command: $c}]}];
  {hooks: {SessionStart: h($ss), UserPromptSubmit: h($up), Stop: h($stop),
           PreToolUse: [{matcher: ".*", hooks: [{type: "command", command: $pre}]}, {matcher: "Edit", hooks: [{type: "command", command: $edit}]}],
           PostToolUse: [{matcher: "Bash", hooks: [{type: "command", command: $post}]}]}}' >"$HOME/.claude/settings.json"
sdk_turn() { (cd "$WORK/proj" && printf '%s\n' '{"type":"user","message":{"role":"user","content":"run it"}}' | sdk "$@" >/dev/null); }
: >"$HOOKLOG"; sdk_turn --permission-mode bypassPermissions
proj=$(cd "$WORK/proj" && pwd -P)
got=$(grep -E '^[A-Za-z-]+ /' "$HOOKLOG" | cut -d' ' -f1 | tr '\n' ' ')
[ "$got" = "SessionStart UserPromptSubmit PreToolUse PostToolUse Stop " ] || fail "hook events in order (Edit's PreToolUse skipped): $got"
[ "$(grep -E '^[A-Za-z-]+ /' "$HOOKLOG" | cut -d' ' -f2,3 | sort -u)" = "$proj $proj" ] || fail "hooks run in the cwd with CLAUDE_PROJECT_DIR: $(cat "$HOOKLOG")"
prompt=$(grep '"hook_event_name":"UserPromptSubmit"' "$HOOKLOG" | jq -r '"\(.prompt) \(.session_id != null) \(.cwd == "'"$proj"'")"')
[ "$prompt" = "run it true true" ] || fail "UserPromptSubmit stdin: $prompt"
[ "$(grep '"hook_event_name":"PostToolUse"' "$HOOKLOG" | jq -r '.tool_name + " " + .tool_input.command')" = "Bash ls -1" ] || fail "PostToolUse names the Bash call"
[ "$(grep '"hook_event_name":"Stop"' "$HOOKLOG" | jq -r .stop_hook_active)" = false ] || fail "Stop stdin"
: >"$HOOKLOG"; sdk_turn --permission-mode bypassPermissions --setting-sources=
[ ! -s "$HOOKLOG" ] || fail "--setting-sources= (no sources) ran hooks: $(cat "$HOOKLOG")"
: >"$HOOKLOG"; sdk_turn --permission-mode bypassPermissions --settings '{"disableAllHooks":true}'
[ ! -s "$HOOKLOG" ] || fail "disableAllHooks ran hooks"
: >"$HOOKLOG"; mv "$HOME/.claude/settings.json" "$WORK/other.json"; mkdir -p "$WORK/cfg" && mv "$WORK/other.json" "$WORK/cfg/settings.json"
(cd "$WORK/proj" && printf '%s\n' '{"type":"user","message":{"role":"user","content":"hi"}}' | CLAUDE_CONFIG_DIR="$WORK/cfg" sdk --permission-mode bypassPermissions >/dev/null)
[ "$(grep -cE '^(UserPromptSubmit|Stop) /' "$HOOKLOG")" = 2 ] || fail "the user settings come from CLAUDE_CONFIG_DIR: $(cat "$HOOKLOG")"

if [ "$failures" -eq 0 ]; then
  echo "ok"
else
  echo "$failures failed"
  exit 1
fi
