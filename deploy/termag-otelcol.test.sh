#!/bin/sh
# Tests the orchestrator's log shipper: deploy/termag-otelcol-env (the
# per-instance config it renders from the backend .env), the unit and how the
# orchestrator image installs them, and deploy/termag-otelcol.yaml itself.
#
# The config part needs a real collector: TERMAG_OTELCOL_BIN=<otelcol-contrib>.
# It merges the shipped config with the rendered one and a test override that
# reads fixture files instead of the journal and writes to a file instead of
# the collector, runs it, and checks what would have been sent: the redaction,
# the journal-entry reshaping and the resource attributes. Without the binary
# that part prints SKIP, or fails with TERMAG_OTELCOL_REQUIRE=1 (CI). With
# TERMAG_OTELCOL_JOURNAL=1 (root, systemd as PID 1) it also runs the real
# journald receiver against a transient termag.service.
#
# Run: sh deploy/termag-otelcol.test.sh
#      TERMAG_OTELCOL_BIN=/path/to/otelcol-contrib TERMAG_OTELCOL_REQUIRE=1 sh deploy/termag-otelcol.test.sh
#      sudo TERMAG_OTELCOL_BIN=... TERMAG_OTELCOL_REQUIRE=1 TERMAG_OTELCOL_JOURNAL=1 sh deploy/termag-otelcol.test.sh
set -u

DEPLOY="$(cd "$(dirname "$0")" && pwd)"
ENVSCRIPT="$DEPLOY/termag-otelcol-env"
CONFIG="$DEPLOY/termag-otelcol.yaml"
UNIT="$DEPLOY/termag-otelcol.service"
SETUP="$DEPLOY/../packer/scripts/orchestrator-setup.sh"
WORK="$(mktemp -d)"
COLLECTOR_PID=""
cleanup() {
  [ -n "$COLLECTOR_PID" ] && kill "$COLLECTOR_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

# render <env file contents>: runs the script on it; sets rc and out.
render() {
  printf '%s\n' "$1" >"$WORK/env"
  rm -f "$WORK/destination.yaml"
  TERMAG_OTELCOL_BACKEND_ENV="$WORK/env" TERMAG_OTELCOL_OUT="$WORK/destination.yaml" sh "$ENVSCRIPT" 2>"$WORK/stderr"
  rc=$?
  out="$(cat "$WORK/destination.yaml" 2>/dev/null || true)"
}

# ── termag-otelcol-env ────────────────────────────────────────────────────────
render 'NODE_ENV=production
OBSERVABILITY_PROJECT=termag-prod
OBSERVABILITY_OTLP_ENDPOINT=https://otel.example.test'
[ "$rc" = 0 ] || fail "env: a configured .env renders" "exit 0" "exit $rc: $(cat "$WORK/stderr")"
printf '%s\n' "$out" | grep -qxF '        value: "termag-prod"' \
  || fail "env: the project becomes telemetry.project_id" 'value: "termag-prod"' "$out"
printf '%s\n' "$out" | grep -qxF '    endpoint: "https://otel.example.test"' \
  || fail "env: the endpoint is passed through" 'endpoint: "https://otel.example.test"' "$out"

render 'OBSERVABILITY_PROJECT="termag-prod"
OBSERVABILITY_OTLP_ENDPOINT=https://otel.example.test:4318/'
printf '%s\n' "$out" | grep -qxF '    endpoint: "https://otel.example.test:4318"' \
  || fail "env: trailing slash dropped" 'endpoint: "https://otel.example.test:4318"' "$out"
printf '%s\n' "$out" | grep -qxF '        value: "termag-prod"' \
  || fail "env: quotes around a value are dropped" 'value: "termag-prod"' "$out"

render 'OBSERVABILITY_PROJECT=old
OBSERVABILITY_OTLP_ENDPOINT=https://otel.example.test
OBSERVABILITY_PROJECT=new'
printf '%s\n' "$out" | grep -qxF '        value: "new"' || fail "env: the last line wins, as when sourced" 'value: "new"' "$out"

render 'OBSERVABILITY_OTLP_ENDPOINT=https://otel.example.test'
[ "$rc" = 78 ] && [ -z "$out" ] || fail "env: no project refuses, writes nothing" "exit 78, no file" "exit $rc, $out"

render 'OBSERVABILITY_PROJECT=termag-prod'
[ "$rc" = 78 ] && [ -z "$out" ] || fail "env: no endpoint refuses rather than guess" "exit 78, no file" "exit $rc, $out"

render 'OBSERVABILITY_OTLP_ENDPOINT=https://otel.example.test
OBSERVABILITY_PROJECT=abc"
injected: true'
[ "$rc" = 78 ] && [ -z "$out" ] || fail "env: a project that isn't a routing key refuses" "exit 78" "exit $rc, $out"

render 'OBSERVABILITY_PROJECT=termag-prod
OBSERVABILITY_OTLP_ENDPOINT=http://plain.example.test'
[ "$rc" = 78 ] && [ -z "$out" ] || fail "env: a non-https endpoint refuses" "exit 78" "exit $rc, $out"

render 'OBSERVABILITY_PROJECT=termag-prod
OBSERVABILITY_OTLP_ENDPOINT=https://x.example.test" injected'
[ "$rc" = 78 ] || fail "env: an endpoint with more than a host and port refuses" "exit 78" "exit $rc"

rm -f "$WORK/env"
TERMAG_OTELCOL_BACKEND_ENV="$WORK/env" TERMAG_OTELCOL_OUT="$WORK/destination.yaml" sh "$ENVSCRIPT" 2>/dev/null
rc=$?
[ "$rc" = 1 ] || fail "env: no .env yet exits 1, so the unit retries" "exit 1" "exit $rc"

# ── the unit and the image wiring ─────────────────────────────────────────────
for want in \
  'ExecStartPre=+/usr/local/lib/termag/termag-otelcol-env' \
  'ExecStart=/usr/local/lib/termag/otelcol/otelcol-contrib --config=/usr/local/lib/termag/otelcol/termag-otelcol.yaml --config=/run/termag-otelcol/destination.yaml' \
  'User=termag-otelcol' \
  'SupplementaryGroups=systemd-journal adm' \
  'StateDirectory=termag-otelcol' \
  'RuntimeDirectory=termag-otelcol' \
  'Restart=always' \
  'RestartMaxDelaySec=10min' \
  'StartLimitIntervalSec=0' \
  'WantedBy=multi-user.target'; do
  grep -qxF -- "$want" "$UNIT" || fail "unit: has line" "$want" "missing"
done
for want in \
  'install -m 0755 -o root -g root /opt/termag/deploy/termag-otelcol-env /usr/local/lib/termag/termag-otelcol-env' \
  'install -m 0644 -o root -g root /opt/termag/deploy/termag-otelcol.yaml /usr/local/lib/termag/otelcol/termag-otelcol.yaml' \
  'install -m 0644 -o root -g root /opt/termag/deploy/termag-otelcol.service /etc/systemd/system/termag-otelcol.service' \
  'systemctl enable termag-otelcol.service' \
  'sha256sum -c -'; do
  grep -qF -- "$want" "$SETUP" || fail "orchestrator-setup.sh: has" "$want" "missing"
done
# Enabled, not started: the .env it reads doesn't exist on the builder.
grep -q 'enable --now termag-otelcol' "$SETUP" && fail "orchestrator-setup.sh: doesn't start the shipper at bake" "enable" "enable --now"
# Waiting for the .env would hold multi-user.target, and cloud-final (which
# writes it) runs after that target.
grep -qE '^[^#]*\b(sleep|while)\b' "$ENVSCRIPT" && fail "env: fails fast instead of waiting for the .env" "no sleep/while loop" "$(grep -nE '^[^#]*\b(sleep|while)\b' "$ENVSCRIPT")"

# ── what the config ships ─────────────────────────────────────────────────────
# The runner orchestrator's unit and its metrics endpoint: the unit
# list and the scrape target are the lines a rewrite is most likely to lose.
for want in \
  '      - _SYSTEMD_UNIT: claude-runner-orchestrator.service' \
  '      - _SYSTEMD_UNIT: termag-data-attach.service' \
  '  prometheus/claude-runner-orchestrator:' \
  "            - targets: ['127.0.0.1:18081']" \
  '    metrics:' \
  '      receivers: [prometheus/claude-runner-orchestrator, otlp/termag]' \
  '      receivers: [journald, filelog/cloud-init, filelog/nginx, otlp/termag]' \
  '  otlp/termag:' \
  '        endpoint: 127.0.0.1:4318' \
  '  filter/noise:' \
  '        - filter/noise'; do
  grep -qxF -- "$want" "$CONFIG" || fail "config: has line" "$want" "missing"
done
# The noise filter runs on the string body, so after transform/journald and
# before the redaction (which it must not short-circuit).
order="$(grep -nE '^\s+- (transform/journald|filter/noise|transform/redact)$' "$CONFIG" | head -3 | sed 's/^[0-9]*:\s*- //' | tr '\n' ' ')"
[ "$order" = 'transform/journald filter/noise transform/redact ' ] || fail "config: filter/noise sits between transform/journald and transform/redact" 'transform/journald filter/noise transform/redact' "$order"

# The backend's OTLP receiver must never listen beyond loopback.
grep -nE '^\s+endpoint: ' "$CONFIG" | grep -vE 'endpoint: 127\.0\.0\.1:' \
  && fail "config: every receiver endpoint is loopback" "127.0.0.1 only" "$(grep -nE '^\s+endpoint: ' "$CONFIG")"

# ── the collector config, run for real ────────────────────────────────────────
BIN="${TERMAG_OTELCOL_BIN:-}"
if [ -z "$BIN" ] || [ ! -x "$BIN" ]; then
  if [ "${TERMAG_OTELCOL_REQUIRE:-}" = 1 ]; then
    fail "collector: binary" "TERMAG_OTELCOL_BIN set to an executable" "${BIN:-unset}"
  else
    echo "SKIP: collector run (set TERMAG_OTELCOL_BIN to an otelcol-contrib binary)"
  fi
else
  mkdir -p "$WORK/log/nginx" "$WORK/state"
  render 'OBSERVABILITY_PROJECT=termag-prod
OBSERVABILITY_OTLP_ENDPOINT=https://otel.example.test'
  # Assembled here so the repo's secret scanner doesn't take the fixtures for real ones.
  TOKEN="tmag_""0123456789abcdefABCDEF_xyz"
  AWS_KEY_ID="AKIA""ABCDEFGHIJKLMNOP"
  # A work-order JWT, should the runner orchestrator ever echo one.
  JWT_FIX="eyJ""hbGciOiJIUzI1NiJ9.eyJ""zdWIiOiJvcmRlciJ9.c2lnbmF0dXJlX2ZpeHR1cmU"
  cat >"$WORK/log/nginx/access.log" <<EOF
10.0.1.5 - - [06/Oct/2026:21:00:00 +0000] "GET /termag/ws/agent?token=$TOKEN HTTP/1.1" 101 0 "-" "node"
10.0.1.6 - - [06/Oct/2026:21:00:01 +0000] "GET /termag/auth/oidc/callback?code=s3cr3tc0de&state=st4te HTTP/1.1" 302 0 "-" "Mozilla"
EOF
  cat >"$WORK/log/nginx/error.log" <<EOF
2026/10/06 21:00:02 [error] 7#7: *1 upstream timed out, request: "GET /termag/ws/agent?token=$TOKEN HTTP/1.1", upstream: "http://127.0.0.1:3100/termag/ws/agent?token=$TOKEN"
EOF
  cat >"$WORK/log/cloudinit-termag.log" <<EOF
=== termag orchestrator cloud-init starting ===
DATABASE_URL=postgresql://termag:hunter2pass@localhost:5432/termag
Authorization: Bearer abcdefghijklmnop.qrstuv
slack xoxb-1234567890-abcdefghij and sdk-12345678-1234-1234-1234-123456789abc and $AWS_KEY_ID
EOF
  # What the journald receiver hands the pipeline: one map per entry, as
  # `journalctl -o json` prints it. Read here through a JSON parser.
  cat >"$WORK/log/journal.json" <<'EOF'
{"MESSAGE":"[AGENT] Connected to termag","PRIORITY":"6","_SYSTEMD_USER_UNIT":"termag-agent-host.service","_UID":"1001","_PID":"4242","_CMDLINE":"node /usr/local/lib/termag/agent/agent.js --token tmag_cmdline_secret"}
{"MESSAGE":"[BOX] create failed: boom","PRIORITY":"3","_SYSTEMD_UNIT":"termag.service","_PID":"99"}
{"MESSAGE":"[orchestrator] claimed spawn hint ord.42 (pool ccpool_fixture)","PRIORITY":"6","_SYSTEMD_UNIT":"claude-runner-orchestrator.service","_PID":"4343"}
{"MESSAGE":"spawn-runner[ord.42]: retryable (HTTP 503): every box of the session owner (1) already runs 3 cloud sessions; it is retried when one ends","PRIORITY":"6","_SYSTEMD_UNIT":"claude-runner-orchestrator.service","_PID":"4344"}
{"MESSAGE":"claude-runner-orchestrator.service: Scheduled restart job, restart counter is at 1.","PRIORITY":"6","UNIT":"claude-runner-orchestrator.service","_SYSTEMD_UNIT":"init.scope","_PID":"1","_UID":"0"}
{"MESSAGE":"Started termag-agent-host.service - termag agent host.","PRIORITY":"6","USER_UNIT":"termag-agent-host.service","_SYSTEMD_UNIT":"user@1003.service","_UID":"1003","_PID":"1778"}
{"MESSAGE":"[STATUS] Push ada-webapp-agent to 3 clients","PRIORITY":"6","_SYSTEMD_UNIT":"termag.service","_PID":"99"}
{"MESSAGE":"[STATUS] POST session=ada-webapp-agent status=working notify=false source=hook waitingReason=null message=undefined","PRIORITY":"6","_SYSTEMD_UNIT":"termag.service","_PID":"99"}
{"MESSAGE":"[GH-AUTHZ] ada box b1 GET /repos/example-org/webapp/pulls allowed","PRIORITY":"6","_SYSTEMD_UNIT":"termag.service","_PID":"99"}
{"MESSAGE":"[GH-AUTHZ] GET /repos/x -> 403 ada box b1 cannot push","PRIORITY":"6","_SYSTEMD_UNIT":"termag.service","_PID":"99"}
{"MESSAGE":"[STATUS] POSTed a repair for ada-webapp-agent","PRIORITY":"6","_SYSTEMD_UNIT":"termag.service","_PID":"99"}
EOF
  printf '%s\n' "{\"MESSAGE\":\"work order $JWT_FIX refused\",\"PRIORITY\":\"4\",\"_SYSTEMD_UNIT\":\"claude-runner-orchestrator.service\",\"_PID\":\"4345\"}" >>"$WORK/log/journal.json"
  cat >"$WORK/test.yaml" <<EOF
extensions:
  file_storage:
    directory: $WORK/state
receivers:
  filelog/cloud-init:
    include: [$WORK/log/cloudinit-termag.log]
  filelog/nginx:
    include: [$WORK/log/nginx/*.log]
  filelog/journal-fixture:
    include: [$WORK/log/journal.json]
    start_at: beginning
    operators:
      - type: json_parser
        parse_to: body
  # The backend's receiver, on a test port so a real collector on this host is
  # not in the way.
  otlp/termag:
    protocols:
      http:
        endpoint: 127.0.0.1:${TERMAG_OTELCOL_TEST_OTLP_PORT:-14318}
  # Nothing listens here, so the scrape fails at once: the pipeline still
  # exports \`up\` = 0 for the job, which is what shows the wiring works.
  prometheus/claude-runner-orchestrator:
    config:
      scrape_configs:
        - job_name: claude-runner-orchestrator
          scrape_interval: 1s
          static_configs:
            - targets: ['127.0.0.1:18081']
processors:
  resourcedetection:
    detectors: [system]
exporters:
  file/test:
    path: $WORK/out.json
    flush_interval: 100ms
service:
  pipelines:
    logs:
      receivers: [filelog/cloud-init, filelog/nginx, filelog/journal-fixture, otlp/termag]
      exporters: [file/test]
    metrics:
      exporters: [file/test]
EOF
  if ! "$BIN" validate --config="$CONFIG" --config="$WORK/destination.yaml" --config="$WORK/test.yaml" >"$WORK/validate.log" 2>&1; then
    fail "collector: config validates" "valid" "$(cat "$WORK/validate.log")"
  else
    "$BIN" --config="$CONFIG" --config="$WORK/destination.yaml" --config="$WORK/test.yaml" >"$WORK/collector.log" 2>&1 &
    COLLECTOR_PID=$!
    # What the backend pushes (backend/src/services/spawnMetrics.ts): one log
    # record and one gauge over OTLP/HTTP JSON. The log carries a token, so the
    # redaction is shown to cover the backend's records too.
    OTLP="http://127.0.0.1:${TERMAG_OTELCOL_TEST_OTLP_PORT:-14318}"
    OTLP_LOG='{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"termag-orchestrator"}}]},"scopeLogs":[{"scope":{"name":"termag.spawn"},"logRecords":[{"timeUnixNano":"1760000000000000000","observedTimeUnixNano":"1760000000000000000","eventName":"termag.spawn.refused","body":{"stringValue":"spawn refused (box_busy) ws/agent?token='"$TOKEN"'"},"attributes":[{"key":"termag.spawn.reason","value":{"stringValue":"box_busy"}}]}]}]}]}'
    OTLP_METRIC='{"resourceMetrics":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"termag-orchestrator"}}]},"scopeMetrics":[{"scope":{"name":"termag.spawn"},"metrics":[{"name":"termag.box.hot","gauge":{"dataPoints":[{"timeUnixNano":"1760000000000000000","asInt":"1","attributes":[{"key":"termag.box","value":{"stringValue":"b1"}}]}]}}]}]}]}'
    pushed=0 i=0
    while [ "$i" -lt 50 ] && [ "$pushed" = 0 ]; do
      if curl -fsS -o /dev/null -H 'Content-Type: application/json' -d "$OTLP_LOG" "$OTLP/v1/logs" 2>/dev/null \
        && curl -fsS -o /dev/null -H 'Content-Type: application/json' -d "$OTLP_METRIC" "$OTLP/v1/metrics" 2>/dev/null; then pushed=1; fi
      i=$((i + 1))
      [ "$pushed" = 1 ] || sleep 0.2
    done
    [ "$pushed" = 1 ] || fail "collector: the backend's OTLP receiver accepts logs and metrics" "HTTP 200" "no answer on $OTLP"
    # 15 lines plus the two noise-fixture lines that are kept (the GH-AUTHZ
    # refusal and the near-miss STATUS line); the three dropped ones never count.
    want_records=17
    # The first scrape comes a few seconds in and the batch processor holds
    # it for up to five more, so the metrics side needs the longer wait.
    i=0
    while [ "$i" -lt 150 ]; do
      n=$(grep -o '"observedTimeUnixNano"' "$WORK/out.json" 2>/dev/null | wc -l)
      if [ "${n:-0}" -ge "$want_records" ] && grep -q '"name":"up"' "$WORK/out.json" 2>/dev/null \
        && grep -q '"name":"termag.box.hot"' "$WORK/out.json" 2>/dev/null; then break; fi
      i=$((i + 1))
      sleep 0.2
    done
    kill "$COLLECTOR_PID" 2>/dev/null
    wait "$COLLECTOR_PID" 2>/dev/null
    COLLECTOR_PID=""
    sent="$(cat "$WORK/out.json" 2>/dev/null)"
    [ "${n:-0}" -ge "$want_records" ] || fail "collector: every fixture line is exported" "$want_records records" "${n:-0}: $(tail -20 "$WORK/collector.log")"
    case "$sent" in *'"name":"up"'*) ;; *) fail "collector: the metrics pipeline scrapes the runner orchestrator" "an up series" "none: $(tail -5 "$WORK/collector.log")" ;; esac
    case "$sent" in *'"name":"termag.box.hot"'*) ;; *) fail "collector: the backend's metrics are exported" "termag.box.hot" "none" ;; esac
    case "$sent" in *'termag.spawn.refused'*) ;; *) fail "collector: the backend's log records are exported" "termag.spawn.refused" "none" ;; esac
    # filter/noise: the per-request chatter is dropped, its neighbours kept.
    for noise in '[STATUS] Push ada-webapp-agent to 3 clients' '[STATUS] POST session=ada-webapp-agent' '/pulls allowed'; do
      case "$sent" in *"$noise"*) fail "collector: drops the noise line" "no '$noise'" "present" ;; esac
    done
    for kept in '"body":{"stringValue":"[GH-AUTHZ] GET /repos/x -> 403 ada box b1 cannot push"}' '"body":{"stringValue":"[STATUS] POSTed a repair for ada-webapp-agent"}'; do
      case "$sent" in *"$kept"*) ;; *) fail "collector: keeps the line next to the noise" "$kept" "missing" ;; esac
    done
    case "$sent" in *'spawn refused (box_busy) ws/agent?token=REDACTED'*) ;; *) fail "collector: the backend's log records are redacted" "token=REDACTED" "$(grep -o 'spawn refused[^"]*' "$WORK/out.json" | head -1)" ;; esac

    for secret in "$TOKEN" tmag_cmdline_secret s3cr3tc0de st4te hunter2pass abcdefghijklmnop.qrstuv \
      xoxb-1234567890-abcdefghij sdk-12345678-1234-1234-1234-123456789abc "$AWS_KEY_ID" "$JWT_FIX"; do
      case "$sent" in *"$secret"*) fail "collector: masks $secret" "absent" "present" ;; esac
    done
    for want in \
      'ws/agent?token=REDACTED HTTP/1.1' \
      'upstream: \"http://127.0.0.1:3100/termag/ws/agent?token=REDACTED\"' \
      'callback?code=REDACTED&state=REDACTED' \
      'postgresql://termag:REDACTED@localhost' \
      'Authorization: REDACTED' \
      'REDACTED_SLACK_TOKEN' 'REDACTED_SDK_KEY' 'REDACTED_AWS_KEY_ID' \
      '"key":"telemetry.project_id","value":{"stringValue":"termag-prod"}' \
      '"key":"service.name","value":{"stringValue":"termag-orchestrator"}' \
      '"key":"service.name","value":{"stringValue":"claude-runner-orchestrator"}' \
      '"key":"host.name"' \
      '"key":"log.source","value":{"stringValue":"nginx"}' \
      '"key":"log.source","value":{"stringValue":"cloud-init"}' \
      '"key":"log.source","value":{"stringValue":"journald"}' \
      '"body":{"stringValue":"[AGENT] Connected to termag"}' \
      '"key":"systemd.user_unit","value":{"stringValue":"termag-agent-host.service"}' \
      '"key":"user.id","value":{"stringValue":"1001"}' \
      '"key":"systemd.unit","value":{"stringValue":"termag.service"}' \
      '"severityNumber":17,"body":{"stringValue":"[BOX] create failed: boom"}' \
      '"key":"systemd.unit","value":{"stringValue":"claude-runner-orchestrator.service"}' \
      '"body":{"stringValue":"spawn-runner[ord.42]: retryable (HTTP 503): every box of the session owner (1) already runs 3 cloud sessions; it is retried when one ends"}' \
      '"body":{"stringValue":"work order REDACTED_JWT refused"}' \
      '"body":{"stringValue":"claude-runner-orchestrator.service: Scheduled restart job, restart counter is at 1."}' \
      '"body":{"stringValue":"Started termag-agent-host.service - termag agent host."}' \
      '"key":"user.id","value":{"stringValue":"1003"}'; do
      case "$sent" in *"$want"*) ;; *) fail "collector: exports" "$want" "missing" ;; esac
    done
    # PID 1's and the user manager's lines are filed under the unit they
    # describe, never under init.scope.
    case "$sent" in *'"key":"systemd.unit","value":{"stringValue":"init.scope"}'*) fail "collector: files systemd's lines under the unit they name" "no systemd.unit=init.scope" "present" ;; esac
    # The journal entry's other fields stay on the host.
    case "$sent" in *_CMDLINE*|*'"_PID"'*) fail "collector: drops unlisted journal fields" "no _CMDLINE/_PID" "present" ;; esac
  fi

  # The real journald receiver, against a transient termag.service. Needs root
  # and systemd as PID 1 (the CI runner): TERMAG_OTELCOL_JOURNAL=1.
  if [ "${TERMAG_OTELCOL_JOURNAL:-}" = 1 ]; then
    marker="termag-otelcol-test-$$"
    systemd-run --unit=termag --collect --wait --quiet \
      sh -c "echo '$marker GET /termag/ws/agent?token=tmag_journal_secret'; echo '$marker on stderr' >&2" \
      || fail "journal: transient termag.service ran" "exit 0" "systemd-run failed"
    systemd-run --unit="termag-otelcol-unrelated-$$" --collect --wait --quiet sh -c "echo '$marker unrelated'" || true
    cat >"$WORK/journal.yaml" <<EOF
extensions:
  file_storage:
    directory: $WORK/state-journal
exporters:
  file/journal:
    path: $WORK/journal-out.json
    flush_interval: 100ms
processors:
  resourcedetection:
    detectors: [system]
service:
  pipelines:
    logs:
      receivers: [journald]
      exporters: [file/journal]
EOF
    mkdir -p "$WORK/state-journal"
    "$BIN" --config="$CONFIG" --config="$WORK/destination.yaml" --config="$WORK/journal.yaml" >"$WORK/collector-journal.log" 2>&1 &
    COLLECTOR_PID=$!
    i=0
    while [ "$i" -lt 100 ]; do
      [ "$(grep -o "$marker" "$WORK/journal-out.json" 2>/dev/null | wc -l)" -ge 2 ] && break
      i=$((i + 1))
      sleep 0.2
    done
    sleep 1
    kill "$COLLECTOR_PID" 2>/dev/null
    wait "$COLLECTOR_PID" 2>/dev/null
    COLLECTOR_PID=""
    sent="$(cat "$WORK/journal-out.json" 2>/dev/null)"
    for want in \
      "\"body\":{\"stringValue\":\"$marker GET /termag/ws/agent?token=REDACTED\"}" \
      "\"body\":{\"stringValue\":\"$marker on stderr\"}" \
      '"key":"systemd.unit","value":{"stringValue":"termag.service"}' \
      '"body":{"stringValue":"Started termag.service' \
      '"key":"log.source","value":{"stringValue":"journald"}'; do
      case "$sent" in *"$want"*) ;; *) fail "journal: exports" "$want" "missing: $(tail -5 "$WORK/collector-journal.log")" ;; esac
    done
    case "$sent" in *tmag_journal_secret*) fail "journal: masks the token" "absent" "present" ;; esac
    case "$sent" in *"$marker unrelated"*) fail "journal: only the listed units ship" "no unrelated unit" "present" ;; esac
    case "$sent" in *_CMDLINE*|*_BOOT_ID*) fail "journal: drops unlisted journal fields" "no _CMDLINE/_BOOT_ID" "present" ;; esac
  fi
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "termag-otelcol: all tests passed"
