#!/usr/bin/env bash
# The gateway's Fireworks listener, rendered from a example-org/terraform
# checkout (modules/claude-gateway/envoy-config, as production renders it), run
# against a stub of the orchestrator's check and a Fireworks stub. No backend or
# boxes: this pins Envoy's half of the contract: which
# calls are routed, the model read from the body and handed to the check, the
# box token swapped for the shared key, streaming and the access log. Which
# models are allowed is the check's (the orchestrator's fireworks-models flag);
# the stub allows two.
#
#   scripts/e2e/fireworks-envoy.test.sh <terraform checkout>
#
# Needs terraform (or E2E_TERRAFORM), openssl, node, curl, jq.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tf_repo=$(cd "${1:?usage: fireworks-envoy.test.sh <terraform checkout>}" && pwd)
module="$tf_repo/projects/termag/root-modules/orchestrator/modules/claude-gateway/envoy-config"
grep -q fireworks_listen_port "$module/main.tf" || { echo "SKIP: $tf_repo has no Fireworks listener"; exit 0; }
terraform=${E2E_TERRAFORM:-terraform}
P=${E2E_FIREWORKS_TEST_PORT:-29080}
AUTHZ=$((P + 10)) UP=$((P + 11)) FW=$((P + 7))
work=$(mktemp -d)
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; if [ -n "${E2E_KEEP:-}" ]; then echo "kept $work"; else rm -rf "$work"; fi; }
trap cleanup EXIT

fail=0
check() { # name want got
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want [$2] got [$3]"; fail=1; fi
}

# A CA and a localhost certificate for the check stub (Envoy verifies the
# checks ALB with the system CAs; here, this CA).
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=fw-test-ca \
  -keyout "$work/ca.key" -out "$work/ca.pem" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=localhost \
  -keyout "$work/srv.key" -out "$work/srv.csr" 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' >"$work/ext.cnf"
openssl x509 -req -in "$work/srv.csr" -CA "$work/ca.pem" -CAkey "$work/ca.key" -CAcreateserial -days 1 \
  -extfile "$work/ext.cnf" -out "$work/srv.pem" 2>/dev/null

cat >"$work/main.tf" <<TF
module "cfg" {
  source                = "$module"
  listen_port           = $P
  admin_port            = $((P + 1))
  github_listen_port    = $((P + 2))
  caller_proof_port     = $((P + 3))
  sts_signer_port       = $((P + 4))
  mcp_listen_port       = $((P + 6))
  fireworks_listen_port = $FW
  orchestrator_host     = "localhost"
  orchestrator_port     = $AUTHZ
  system_ca_file        = "$work/ca.pem"
  bedrock_region        = "us-east-2"
  bedrock_host          = "127.0.0.1"
  bedrock_port          = 1
  bedrock_tls           = false
  models                = { default = { profile = "us.test-model-v1", foundation = "test-model-v1" } }
  sts                   = { host = "127.0.0.1:1", port = 1, tls = false }
  fireworks = {
    api_host = "127.0.0.1"
    port     = $UP
    tls      = false
  }
}
TF
( cd "$work" && "$terraform" init -input=false >/dev/null && echo 'module.cfg.yaml' | "$terraform" console | sed '1d;$d' >"$work/envoy.yaml" ) || true
grep -q '"name": "fireworks"' "$work/envoy.yaml" 2>/dev/null || { echo "rendering the envoy-config module failed"; exit 1; }

# The orchestrator's check: a Bearer or
# x-api-key of tmag_good is a managed box with Fireworks on; tmag_off is one
# with it off; anything else is unknown. Its fireworks-models list is the two
# ALLOWED; auth-check carries no model.
cat >"$work/authz.mjs" <<'JS'
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
const [cert, key, port] = process.argv.slice(2);
const seen = [];
createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  if (req.url === '/_calls') { res.end(JSON.stringify(seen)); return; }
  const model = req.headers['x-termag-fireworks-model'] ?? null;
  seen.push({ path: req.url, caller: Boolean(req.headers['x-termag-caller-authorization']), model });
  const tok = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] ?? req.headers['x-api-key'];
  const ALLOWED = ['accounts/fireworks/models/kimi-k3', 'accounts/fireworks/routers/kimi-k3-fast'];
  if (tok === 'tmag_good' && !req.url.endsWith('/auth-check') && !ALLOWED.includes(model)) {
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ message: `The termag Fireworks gateway does not allow this model for you. Allowed: ${ALLOWED.join(', ')}` }));
    return;
  }
  if (tok === 'tmag_good') { res.writeHead(200, { 'x-termag-user': 'u1', 'x-termag-instance': 'i1', 'x-termag-email': 'a@example.com' }).end(); return; }
  if (tok === 'tmag_off') { res.writeHead(403, { 'content-type': 'application/json' }).end('{"message":"Fireworks through termag is not enabled for you"}'); return; }
  res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="termag Fireworks gateway"' }).end('{"message":"Unknown or revoked box token"}');
}).listen(Number(port), '127.0.0.1');
JS

# Fireworks: records each call and answers JSON, or a slow SSE stream when the
# body asks for stream.
cat >"$work/fireworks.mjs" <<'JS'
import { createServer } from 'node:http';
const [port] = process.argv.slice(2);
const seen = [];
createServer((req, res) => {
  if (req.url === '/_calls') { res.end(JSON.stringify(seen)); return; }
  let bytes = 0; let first = '';
  req.on('data', c => { bytes += c.length; if (first.length < 200) first += c.toString().slice(0, 200); });
  req.on('end', () => {
    seen.push({ method: req.method, path: req.url, host: req.headers.host, authorization: req.headers.authorization ?? null,
      apiKey: req.headers['x-api-key'] ?? null, termag: Object.keys(req.headers).filter(h => h.startsWith('x-termag-')), bytes });
    if (/"stream"\s*:\s*true/.test(first)) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => { res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'); }, 1500);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'fw-req-1' }).end('{"ok":true}');
  });
}).listen(Number(port), '127.0.0.1');
JS
node "$work/authz.mjs" "$work/srv.pem" "$work/srv.key" "$AUTHZ" >"$work/authz.log" 2>&1 & pids+=($!)
node "$work/fireworks.mjs" "$UP" >"$work/fireworks.log" 2>&1 & pids+=($!)
envoy=$(bash "$here/fakes/envoy.sh" fetch)
FIREWORKS_API_KEY=fw-test-key AWS_ACCESS_KEY_ID=AKIATEST AWS_SECRET_ACCESS_KEY=test AWS_EC2_METADATA_DISABLED=true \
  "$envoy" -c "$work/envoy.yaml" --disable-hot-restart --log-level warn >"$work/envoy.log" 2>&1 & pids+=($!)
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$FW/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$FW/healthz" >/dev/null || { cat "$work/envoy.log"; echo "Envoy did not start"; exit 1; }

B="http://127.0.0.1:$FW/fireworks/inference/v1"
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
upcalls() { curl -s "http://127.0.0.1:$UP/_calls"; }
checks() { curl -s --cacert "$work/ca.pem" "https://localhost:$AUTHZ/_calls"; }
kimi='"accounts/fireworks/models/kimi-k3"'

echo "--- routing and the key swap"
check "pi's chat completion with a Bearer box token" 200 \
  "$(code -H 'Authorization: Bearer tmag_good' -H 'content-type: application/json' -d "{\"model\":$kimi,\"messages\":[]}" "$B/chat/completions")"
last=$(upcalls | jq -c '.[-1]')
check "Fireworks saw the upstream path" "POST /inference/v1/chat/completions" "$(jq -r '"\(.method) \(.path)"' <<<"$last")"
check "Fireworks saw the shared key, not the box token" "Bearer fw-test-key" "$(jq -r .authorization <<<"$last")"
check "Host is Fireworks'" "127.0.0.1" "$(jq -r .host <<<"$last")"
check "the check was asked with the caller proof and the body's model" "/termag/internal/fireworks-authz/fireworks/inference/v1/chat/completions true accounts/fireworks/models/kimi-k3" \
  "$(checks | jq -r '.[-1] | "\(.path) \(.caller) \(.model)"')"
check "Claude Code's messages call with x-api-key and ?beta=true" 200 \
  "$(code -H 'x-api-key: tmag_good' -H 'content-type: application/json' -d "{\"model\":$kimi,\"max_tokens\":1,\"messages\":[]}" "$B/messages?beta=true")"
last=$(upcalls | jq -c '.[-1]')
check "the query survives the rewrite" "/inference/v1/messages?beta=true" "$(jq -r .path <<<"$last")"
check "x-api-key does not reach Fireworks" "null Bearer fw-test-key" "$(jq -r '"\(.apiKey) \(.authorization)"' <<<"$last")"
check "no x-termag-* header reaches Fireworks" "[]" "$(jq -c .termag <<<"$last")"
check "a box-sent x-termag-user is dropped too" 200 \
  "$(code -H 'Authorization: Bearer tmag_good' -H 'x-termag-user: someone-else' -d "{\"model\":$kimi}" "$B/chat/completions")"
check "  (and Fireworks saw none)" "[]" "$(upcalls | jq -c '.[-1].termag')"
check "a box-sent x-termag-fireworks-model cannot stand in for the body's model" "403 accounts/fireworks/models/glm-9" \
  "$(code -H 'Authorization: Bearer tmag_good' -H "x-termag-fireworks-model: accounts/fireworks/models/kimi-k3" -d '{"model":"accounts/fireworks/models/glm-9"}' "$B/chat/completions") $(checks | jq -r '.[-1].model')"

echo "--- refusals"
before=$(upcalls | jq length)
check "no token: the check's 401" 401 "$(code -d "{\"model\":$kimi}" "$B/chat/completions")"
check "Fireworks off for the owner: the check's 403" 403 "$(code -H 'Authorization: Bearer tmag_off' -d "{\"model\":$kimi}" "$B/chat/completions")"
out=$(curl -s -w ' %{http_code}' -H 'Authorization: Bearer tmag_good' -d '{"model":"accounts/fireworks/models/glm-9","messages":[]}' "$B/chat/completions")
check "a model off the allowlist: 403" 403 "${out##* }"
check "  with the check's message, naming the allowed ones" "The termag Fireworks gateway does not allow this model for you. Allowed: accounts/fireworks/models/kimi-k3, accounts/fireworks/routers/kimi-k3-fast" \
  "$(jq -r '.message' <<<"${out% *}")"
check "two top-level models: 400" 400 \
  "$(code -H 'Authorization: Bearer tmag_good' -d "{\"model\":$kimi,\"messages\":[],\"model\":\"accounts/fireworks/models/glm-9\"}" "$B/chat/completions")"
# A parser differential (the AI Security Review on terraform#28510): a JSON
# parser reads "mod\u0065l" as "model", the scan's byte compare would not, so
# any escaped top-level key is refused, and anything that is not one object.
check 'an escaped second "model" key: 400' 400 \
  "$(code -H 'Authorization: Bearer tmag_good' -d "{\"model\":$kimi,\"mod\\u0065l\":\"accounts/fireworks/models/glm-9\",\"messages\":[]}" "$B/chat/completions")"
check 'an escaped "model" key alone: 400' 400 \
  "$(code -H 'Authorization: Bearer tmag_good' -d '{"\u006dodel":"accounts/fireworks/models/glm-9","messages":[]}' "$B/chat/completions")"
check "a second object after the first: 400" 400 \
  "$(code -H 'Authorization: Bearer tmag_good' -d "{\"model\":$kimi}{\"model\":\"accounts/fireworks/models/glm-9\"}" "$B/chat/completions")"
check "a body that is not an object: 400" 400 \
  "$(code -H 'Authorization: Bearer tmag_good' -d "[{\"model\":$kimi}]" "$B/chat/completions")"
check "an allowed model only nested (a tool input), the top-level one not: 403" 403 \
  "$(code -H 'Authorization: Bearer tmag_good' -d "{\"messages\":[{\"content\":[{\"input\":{\"model\":$kimi}}]}],\"model\":\"accounts/fireworks/models/glm-9\"}" "$B/messages")"
check "a model that is not a string: 400" 400 "$(code -H 'Authorization: Bearer tmag_good' -d '{"model":{"id":"x"}}' "$B/messages")"
check "a model with characters no id has: 400" 400 "$(code -H 'Authorization: Bearer tmag_good' -d '{"model":"a b"}' "$B/messages")"
check "no model: 400" 400 "$(code -H 'Authorization: Bearer tmag_good' -d '{"messages":[]}' "$B/messages")"
check "an empty body: 400" 400 "$(code -H 'Authorization: Bearer tmag_good' -X POST "$B/messages")"
check "a GET of the models list is not routed: 404" 404 "$(code -H 'Authorization: Bearer tmag_good' "$B/models")"
check "count_tokens is not routed: 404" 404 "$(code -H 'Authorization: Bearer tmag_good' -d "{\"model\":$kimi}" "$B/messages/count_tokens")"
check "a dot-segment cannot reach another upstream path: 404" 404 \
  "$(code --path-as-is -H 'Authorization: Bearer tmag_good' -d "{\"model\":$kimi}" "$B/chat/completions/../../v1/batches")"
check "none of the refusals reached Fireworks" "$before" "$(upcalls | jq length)"

check "a router on the allowlist is routed like a model" 200 \
  "$(code -H 'Authorization: Bearer tmag_good' -d '{"model":"accounts/fireworks/routers/kimi-k3-fast","messages":[]}' "$B/chat/completions")"

echo "--- nesting the scan has to get right"
check "an escape in a string value, not a key, is fine" 200 \
  "$(code -H 'Authorization: Bearer tmag_good' -d "{\"model\":$kimi,\"messages\":[{\"content\":\"a \\\"quoted\\\" \\\\ word\"}]}" "$B/chat/completions")"
check "a nested \"model\" before the top-level one is not the model" 200 \
  "$(code -H 'Authorization: Bearer tmag_good' -d "{\"tools\":[{\"input_schema\":{\"properties\":{\"model\":{\"type\":\"string\"}}}}],\"messages\":[{\"content\":\"say \\\"model\\\": \\\"x\\\"\"}],\"model\":$kimi}" "$B/messages")"

echo "--- auth-check"
check "auth-check with a box token: 204" 204 "$(code -H 'Authorization: Bearer tmag_good' "http://127.0.0.1:$FW/fireworks/auth-check")"
check "auth-check without one: 401" 401 "$(code "http://127.0.0.1:$FW/fireworks/auth-check")"

echo "--- size and streaming"
big=$(head -c 6000000 /dev/zero | tr '\0' 'a')
printf '{"model":%s,"messages":[{"role":"user","content":"%s"}]}' "$kimi" "$big" >"$work/big.json"
check "a 6 MB body passes whole" "200 $(wc -c <"$work/big.json" | tr -d ' ')" \
  "$(code -H 'Authorization: Bearer tmag_good' --data-binary @"$work/big.json" "$B/chat/completions") $(upcalls | jq '.[-1].bytes')"
# The stub holds the stream open 1.5 s after its first event.
t=$(curl -sN -o "$work/stream.txt" -w '%{time_starttransfer} %{time_total}' -H 'Authorization: Bearer tmag_good' \
  -d "{\"model\":$kimi,\"stream\":true,\"messages\":[]}" "$B/messages")
check "a stream's first event arrives before the stream ends" "event: message_start streamed" \
  "$(head -n1 "$work/stream.txt") $(awk '{ print ($2 - $1 > 1.0) ? "streamed" : "buffered " $0 }' <<<"$t")"

echo "--- the access log"
# Envoy flushes its access log on an interval.
logline=
for _ in $(seq 1 40); do
  logline=$(grep '"kind":"fireworks-request"' "$work/envoy.log" | grep '"details":"via_upstream"' | head -n1 || true)
  [ -n "$logline" ] && break; sleep 0.25
done
check "it names the user, box, email and model" "u1 i1 a@example.com accounts/fireworks/models/kimi-k3" \
  "$(jq -r '"\(.user) \(.instance) \(.email) \(.model)"' <<<"$logline")"
check "it never holds the key or a box token" "" "$(grep -E 'fw-test-key|tmag_good' "$work/envoy.log" || true)"

exit $fail
