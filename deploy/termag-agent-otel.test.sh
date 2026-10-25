#!/bin/sh
# Tests deploy/termag-agent-otel and deploy/termag-cursor-otel-hook with the
# agents and curl stubbed: what each agent is started with, and what the hook
# sends.
#
# Run: sh deploy/termag-agent-otel.test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
WRAP="$DIR/termag-agent-otel"
HOOK="$DIR/termag-cursor-otel-hook"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

STUB="$WORK/bin"; mkdir -p "$STUB" "$WORK/codex-home"
# Each stub agent prints its argv, one per line, then its OTEL_* environment.
for a in codex devin cursor-agent pi; do
  cat > "$STUB/$a" <<'EOF'
#!/bin/sh
for x in "$@"; do printf 'arg %s\n' "$x"; done
env | grep -E '^(OTEL_|TERMAG_OTEL_)' | sort | sed 's/^/env /'
EOF
  chmod 755 "$STUB/$a"
done
# curl records its body and URL instead of sending.
cat > "$STUB/curl" <<EOF
#!/bin/sh
url=
for x in "\$@"; do case \$x in https://*) url=\$x ;; esac; done
printf '%s\n' "\$url" > "$WORK/curl.url"
cat > "$WORK/curl.body"
EOF
chmod 755 "$STUB/curl"

REC="$WORK/agent-telemetry.json"
printf '%s' '{"endpoint":"https://otel.example.test","resourceAttributes":"telemetry.project_id=abc123,termag.session.kind=interactive,termag.box=box1"}' > "$REC"
RID='huuhcqcev124emZ9urmRjjPSNXLl'
SHELL_EXPORTER='OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer shellsecret'
run() {  # env-assignments... -- wrapper args
  env PATH="$STUB:$PATH" TERMAG_AGENT_TELEMETRY="$REC" CODEX_HOME="$WORK/codex-home" \
    "$SHELL_EXPORTER" OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://shell.example.test OTEL_LOG_USER_PROMPTS=1 \
    "$WRAP" "$@"
}

# ── Devin ───────────────────────────────────────────────────────────────────
out="$(run devin --replay "$RID" -- devin --permission-mode auto)"
want="arg --permission-mode
arg auto
env OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.test
env OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
env OTEL_RESOURCE_ATTRIBUTES=telemetry.project_id=abc123,termag.session.kind=interactive,termag.box=box1,service.name=termag-devin-session,termag.agent=devin,termag.replay.id=$RID
env TERMAG_OTEL_REPLAY_ID=$RID"
[ "$out" = "$want" ] || fail "devin starts with termag's endpoint and resource, and none of the shell's exporter or content gates" "$want" "$out"

# The pane's project and workstream, from the environment the orchestrator
# sets ahead of the command; a pair that is not two ids is left out.
out="$(env PATH="$STUB:$PATH" TERMAG_AGENT_TELEMETRY="$REC" TERMAG_PROJECT=webapp TERMAG_WORKSTREAM=feature-x "$WRAP" devin --replay "$RID" -- devin)"
case $out in
  *"env OTEL_RESOURCE_ATTRIBUTES=telemetry.project_id=abc123,termag.session.kind=interactive,termag.box=box1,service.name=termag-devin-session,termag.agent=devin,termag.project=webapp,termag.workstream=feature-x,termag.replay.id=$RID"*) : ;;
  *) fail 'devin carries the project and workstream from TERMAG_PROJECT / TERMAG_WORKSTREAM, before the replay' 'termag.project=webapp,termag.workstream=feature-x' "$out" ;;
esac
for pair in 'gon falon:main' 'webapp:' ':main' 'webapp:ws,x=y'; do
  out="$(env PATH="$STUB:$PATH" TERMAG_AGENT_TELEMETRY="$REC" TERMAG_PROJECT="${pair%%:*}" TERMAG_WORKSTREAM="${pair#*:}" "$WRAP" devin -- devin)"
  case $out in *termag.project*|*termag.workstream*) fail "a project/workstream pair that is not two ids is left out ($pair)" 'no termag.project' "$out" ;; esac
  case $out in *'termag.agent=devin'*) : ;; *) fail "the telemetry stays without the pair ($pair)" 'termag.agent=devin' "$out" ;; esac
done

# ── Codex ───────────────────────────────────────────────────────────────────
out="$(run codex -- codex app-server --listen ws://127.0.0.1:1)"
case $out in
  *'arg otel.exporter="none"'*'arg otel.trace_exporter={otlp-http={endpoint="https://otel.example.test/v1/traces",protocol="binary"}}'*'arg otel.metrics_exporter={otlp-http={endpoint="https://otel.example.test/v1/metrics",protocol="binary"}}'*'arg otel.log_user_prompt=false'*'arg app-server'*) : ;;
  *) fail 'codex gets traces and metrics as -c overrides ahead of its subcommand, and no log exporter' '-c otel.* ... app-server' "$out" ;;
esac
case $out in *shellsecret*|*shell.example.test*|*OTEL_LOG_*) fail "codex gets none of the shell's exporter or content gates" 'absent' "$out" ;; esac
case $out in *'service.name=termag-codex-session,termag.agent=codex'*) : ;; *) fail 'codex carries the resource with termag.agent' 'termag.agent=codex' "$out" ;; esac

printf '[otel]\nexporter = "none"\n' > "$WORK/codex-home/config.toml"
out="$(run codex -- codex app-server)"
want="arg app-server
env OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer shellsecret
env OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://shell.example.test
env OTEL_LOG_USER_PROMPTS=1"
[ "$out" = "$want" ] || fail "an owner's own otel table in config.toml keeps codex exactly as it was" "$want" "$out"
for own in 'otel.exporter = "none"' 'otel = { exporter = "none" }' '[otel.exporter.otlp-http]'; do
  printf '%s\n' "$own" > "$WORK/codex-home/config.toml"
  case "$(run codex -- codex app-server)" in *'arg -c'*) fail "an owner's own otel config is recognised: $own" 'no -c' 'termag -c added' ;; esac
done
printf '[otelx]\nfoo = 1\n# otel = commented\n' > "$WORK/codex-home/config.toml"
case "$(run codex -- codex app-server)" in *'arg -c'*) : ;; *) fail 'a table that only starts with otel is not an owner exporter' 'termag -c' 'none' ;; esac
rm -f "$WORK/codex-home/config.toml"

# ── Cursor and pi: the replay id only ──────────────────────────────────────
for a in cursor:cursor-agent pi:pi; do
  out="$(run "${a%%:*}" --replay "$RID" -- "${a#*:}" --continue)"
  want="arg --continue
env OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer shellsecret
env OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://shell.example.test
env OTEL_LOG_USER_PROMPTS=1
env TERMAG_OTEL_REPLAY_ID=$RID"
  [ "$out" = "$want" ] || fail "${a%%:*} is started as given, with only the replay id added" "$want" "$out"
done

# ── nothing recorded, or a bad record: exactly as given ─────────────────────
for rec in "$WORK/absent.json" "$WORK/bad.json"; do
  printf '%s' '{"endpoint":"http://otel.example.test","resourceAttributes":"telemetry.project_id=a"}' > "$WORK/bad.json"
  out="$(env PATH="$STUB:$PATH" TERMAG_AGENT_TELEMETRY="$rec" "$SHELL_EXPORTER" "$WRAP" devin --replay "$RID" -- devin)"
  want='env OTEL_EXPORTER_OTLP_HEADERS=authorization=Bearer shellsecret'
  [ "$out" = "$want" ] || fail "with no valid record devin runs untouched ($(basename "$rec"))" "$want" "$out"
done
out="$(run devin --replay 'not;an id' -- devin)"
case $out in *termag.replay.id*|*TERMAG_OTEL_REPLAY_ID*) fail 'a malformed replay id is dropped' 'no replay' "$out" ;; esac
env PATH="$STUB:$PATH" "$WRAP" nosuchagent -- devin >/dev/null 2>&1; got=$?
[ "$got" = 2 ] || fail 'an unknown agent is a usage error' 2 "$got"
env PATH="$STUB:$PATH" "$WRAP" devin >/dev/null 2>&1; got=$?
[ "$got" = 2 ] || fail 'a missing command is a usage error' 2 "$got"

# ── Cursor hook ─────────────────────────────────────────────────────────────
hook() {  # json
  printf '%s' "$1" | env PATH="$STUB:$PATH" TERMAG_AGENT_TELEMETRY="$REC" TERMAG_OTEL_REPLAY_ID="$RID" "$SHELL_EXPORTER" "$HOOK"
}
waitfor() { i=0; while [ ! -s "$1" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done; }
rm -f "$WORK/curl.body" "$WORK/curl.url"
out="$(hook '{"hook_event_name":"stop","conversation_id":"c1","generation_id":"g1","model":"gpt-5","status":"completed","loop_count":0,"input_tokens":1200,"output_tokens":30,"user_email":"a@example.test","text":"SECRET_RESPONSE","tool_input":{"command":"SECRET_CMD"}}')"
[ "$out" = '{}' ] || fail 'the hook answers {} at once' '{}' "$out"
waitfor "$WORK/curl.body"
got="$(cat "$WORK/curl.url" 2>/dev/null)"
[ "$got" = https://otel.example.test/v1/logs ] || fail 'the hook posts to the recorded endpoint' https://otel.example.test/v1/logs "$got"
got="$(jq -c '.resourceLogs[0].logRecords // .resourceLogs[0].scopeLogs[0].logRecords[0] | [.body.stringValue, ([.attributes[] | {(.key): (.value | to_entries[0].value)}] | add)]' "$WORK/curl.body" 2>&1)"
want='["cursor.stop",{"event.name":"cursor.stop","session.id":"c1","conversation.id":"c1","generation.id":"g1","model":"gpt-5","user.email":"a@example.test","status":"completed","loop_count":"0","input_tokens":"1200","output_tokens":"30"}]'
[ "$got" = "$want" ] || fail 'the hook sends the stop metadata and token counts' "$want" "$got"
got="$(jq -c '[.resourceLogs[0].resource.attributes[] | {(.key): .value.stringValue}] | add' "$WORK/curl.body")"
want="{\"telemetry.project_id\":\"abc123\",\"termag.session.kind\":\"interactive\",\"termag.box\":\"box1\",\"service.name\":\"termag-cursor-session\",\"termag.agent\":\"cursor\",\"termag.replay.id\":\"$RID\"}"
[ "$got" = "$want" ] || fail 'the hook carries the recorded resource, its service and the replay' "$want" "$got"
grep -q SECRET "$WORK/curl.body" && fail 'the hook sends no response text or tool input' 'no SECRET' "$(cat "$WORK/curl.body")"
grep -q shellsecret "$WORK/curl.body" "$WORK/curl.url" && fail "the hook sends nothing of the shell's exporter" 'absent' 'present'

rm -f "$WORK/curl.body"
hook '{"hook_event_name":"postToolUseFailure","conversation_id":"c1","tool_name":"Shell","tool_input":{"command":"SECRET"},"error_message":"SECRET","failure_type":"error","duration":42}' >/dev/null
waitfor "$WORK/curl.body"
got="$(jq -c '[.resourceLogs[0].scopeLogs[0].logRecords[0].attributes[] | select(.key | test("tool_name|success|failure_type|duration_ms")) | {(.key): (.value | to_entries[0].value)}] | add' "$WORK/curl.body" 2>&1)"
[ "$got" = '{"duration_ms":"42","tool_name":"Shell","success":false,"failure_type":"error"}' ] \
  || fail 'a tool failure carries its tool, outcome and duration, not its input or error text' '{"duration_ms":"42",...}' "$got"
grep -q SECRET "$WORK/curl.body" && fail 'a tool failure sends no input or error text' 'no SECRET' 'SECRET'

rm -f "$WORK/curl.body"
out="$(printf '{"hook_event_name":"stop"}' | env PATH="$STUB:$PATH" TERMAG_AGENT_TELEMETRY="$WORK/absent.json" "$HOOK")"; sleep 0.3
[ "$out" = '{}' ] && [ ! -e "$WORK/curl.body" ] || fail 'with no record the hook answers {} and sends nothing' '{} + nothing' "$out $(ls "$WORK")"
out="$(printf 'not json' | env PATH="$STUB:$PATH" TERMAG_AGENT_TELEMETRY="$REC" "$HOOK")"; got=$?; sleep 0.3
[ "$out" = '{}' ] && [ "$got" = 0 ] && [ ! -e "$WORK/curl.body" ] || fail 'a payload it cannot read sends nothing and still answers {}' '{} 0' "$out $got"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: termag-agent-otel codex/devin/cursor/pi launches + owner codex otel + no record; cursor hook metadata, resource, no content'
else
  echo "$failures failure(s)"; exit 1
fi
