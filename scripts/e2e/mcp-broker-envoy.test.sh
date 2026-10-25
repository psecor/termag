#!/usr/bin/env bash
# The MCP broker's Envoy listener, rendered from a example-org/terraform
# checkout (modules/claude-gateway/envoy-config, as production renders it), run
# against a stub of the orchestrator's check and the MCP upstream stub. No
# backend or boxes: this pins Envoy's half of the contract:
# routing to the upstream the check names, header handling, the connect-time
# address check, path normalisation, the 401 rewrite and streaming.
#
#   scripts/e2e/mcp-broker-envoy.test.sh <terraform checkout>
#
# Needs terraform (or E2E_TERRAFORM), openssl, node, curl, jq.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
tf_repo=$(cd "${1:?usage: mcp-broker-envoy.test.sh <terraform checkout>}" && pwd)
module="$tf_repo/projects/termag/root-modules/orchestrator/modules/claude-gateway/envoy-config"
grep -q mcp_listen_port "$module/main.tf" || { echo "SKIP: $tf_repo has no MCP broker listener"; exit 0; }
terraform=${E2E_TERRAFORM:-terraform}
P=${E2E_MCP_TEST_PORT:-28080}
AUTHZ=$((P + 10)) UP=$((P + 11)) UP2=$((P + 12)) MCP=$((P + 6))
work=$(mktemp -d)
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; if [ -n "${E2E_KEEP:-}" ]; then echo "kept $work"; else rm -rf "$work"; fi; }
trap cleanup EXIT

fail=0
check() { # name want got
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want [$2] got [$3]"; fail=1; fi
}

# A CA, and a localhost / 127.0.0.2 certificate for the stubs.
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=mcp-test-ca \
  -keyout "$work/ca.key" -out "$work/ca.pem" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=localhost \
  -keyout "$work/srv.key" -out "$work/srv.csr" 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:127.0.0.2\n' >"$work/ext.cnf"
openssl x509 -req -in "$work/srv.csr" -CA "$work/ca.pem" -CAkey "$work/ca.key" -CAcreateserial -days 1 \
  -extfile "$work/ext.cnf" -out "$work/srv.pem" 2>/dev/null

cat >"$work/main.tf" <<TF
module "cfg" {
  source             = "$module"
  listen_port        = $P
  admin_port         = $((P + 1))
  github_listen_port = $((P + 2))
  caller_proof_port  = $((P + 3))
  sts_signer_port    = $((P + 4))
  mcp_listen_port    = $MCP
  orchestrator_host  = "localhost"
  orchestrator_port  = $AUTHZ
  system_ca_file     = "$work/ca.pem"
  bedrock_region     = "us-east-2"
  bedrock_host       = "127.0.0.1"
  bedrock_port       = 1
  bedrock_tls        = false
  models             = { default = { profile = "us.test-model-v1", foundation = "test-model-v1" } }
  sts                = { host = "127.0.0.1:1", port = 1, tls = false }
  # The upstream stub is on loopback; 127.0.0.2 stays denied.
  mcp_upstream_allowed_cidrs = ["127.0.0.1/32"]
}
TF
( cd "$work" && "$terraform" init -input=false >/dev/null && echo 'module.cfg.yaml' | "$terraform" console | sed '1d;$d' >"$work/envoy.yaml" ) || true
grep -q '"name": "mcp_broker"' "$work/envoy.yaml" 2>/dev/null || { echo "rendering the envoy-config module failed"; exit 1; }

# The orchestrator's check, for fixed
# connectors: c1 (static header, the right secret), cbad (a wrong secret, so
# the upstream answers 401), cdeny (an upstream on a denied address), cnoup (an
# allow without an upstream), anything else 404.
cat >"$work/authz.mjs" <<'JS'
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
const [cert, key, port, up, up2] = process.argv.slice(2);
const seen = [];
createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  if (req.url === '/_calls') { res.end(JSON.stringify(seen)); return; }
  const m = /^\/termag\/internal\/mcp-authz\/c\/([^/?]+)/.exec(req.url);
  seen.push({ path: req.url, caller: Boolean(req.headers['x-termag-caller-authorization']) });
  if (req.headers.authorization !== 'Bearer tmag_good') { res.writeHead(403, { 'content-type': 'application/json' }).end('{"message":"not a box token"}'); return; }
  const meta = (id) => ({ 'x-termag-user': 'u1', 'x-termag-instance': 'i1', 'x-termag-mcp-connector': id,
    'x-termag-mcp-relink': `MCP server "${id}" is not linked. Link it at https://orchestrator.example/termag/settings/mcp?server=${id}` });
  const id = m?.[1];
  const allow = { c1: [`https://localhost:${up}/mcp`, 'Bearer up-secret'], cbad: [`https://localhost:${up}/mcp`, 'Bearer wrong'],
    cdeny: [`https://127.0.0.2:${up2}/mcp`, 'Bearer up-secret'], cnoup: [null, 'Bearer up-secret'] }[id];
  if (!allow) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"no such MCP connector"}'); return; }
  res.writeHead(200, { ...meta(id), ...(allow[0] ? { 'x-termag-mcp-upstream': allow[0] } : {}), 'x-termag-mcp-h-authorization': allow[1], 'x-termag-mcp-h-x-extra': 'static-extra' }).end();
}).listen(Number(port), '127.0.0.1');
JS
node "$work/authz.mjs" "$work/srv.pem" "$work/srv.key" "$AUTHZ" "$UP" "$UP2" >"$work/authz.log" 2>&1 & pids+=($!)
E2E_MCP_PORT=$UP E2E_MCP_CERT=$work/srv.pem E2E_MCP_KEY=$work/srv.key E2E_MCP_REQUIRE='authorization=Bearer up-secret' E2E_MCP_SLOW_MS=2000 \
  node "$here/fakes/mcp-upstream.mjs" >"$work/up.log" 2>&1 & pids+=($!)
E2E_MCP_PORT=$UP2 E2E_MCP_HOST=127.0.0.2 E2E_MCP_CERT=$work/srv.pem E2E_MCP_KEY=$work/srv.key \
  node "$here/fakes/mcp-upstream.mjs" >"$work/up2.log" 2>&1 & pids+=($!)
envoy=$(bash "$here/fakes/envoy.sh" fetch)
AWS_ACCESS_KEY_ID=AKIATEST AWS_SECRET_ACCESS_KEY=test AWS_EC2_METADATA_DISABLED=true \
  "$envoy" -c "$work/envoy.yaml" --disable-hot-restart --log-level warn >"$work/envoy.log" 2>&1 & pids+=($!)
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$MCP/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$MCP/healthz" >/dev/null || { cat "$work/envoy.log"; echo "Envoy did not start"; exit 1; }

B="http://127.0.0.1:$MCP"
TOK=(-H 'Authorization: Bearer tmag_good')
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
upcalls() { curl -s "http://127.0.0.1:$UP/_e2e/calls" --cacert "$work/ca.pem" -k 2>/dev/null || curl -sk "https://localhost:$UP/_e2e/calls"; }

echo "--- routing and headers"
out=$(curl -s -D "$work/h1" "${TOK[@]}" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'x-termag-mcp-h-authorization: Bearer box-injected' -H 'x-termag-mcp-upstream: https://127.0.0.2:1/x' \
  -d "$init" "$B/c/c1")
check "initialize through the broker" e2e-mcp-upstream "$(jq -r .result.serverInfo.name <<<"$out")"
check "the session id comes back" yes "$(grep -qi '^mcp-session-id: sess-' "$work/h1" && echo yes || echo no)"
calls=$(curl -sk "https://localhost:$UP/_e2e/calls")
check "the upstream saw /mcp with the check's credential" "POST /mcp true" "$(jq -r '[.[] | select(.rpc=="initialize")][0] | "\(.method) \(.path) \(.authed)"' <<<"$calls")"
check "no box token reached the upstream" false "$(jq '[.[] | .boxToken] | any' <<<"$calls")"
check "Host is the upstream's" "localhost:$UP" "$(jq -r '[.[] | select(.rpc=="initialize")][0].host' <<<"$calls")"
check "tools/list" '["echo","slow"]' "$(curl -s "${TOK[@]}" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' "$B/c/c1" | jq -c '[.result.tools[].name]')"
code "${TOK[@]}" "$B/c/c1/extra?x=1" >/dev/null
check "a sub-path and query map under the base" "/mcp/extra ?x=1" "$(curl -sk "https://localhost:$UP/_e2e/calls" | jq -r '.[-1] | "\(.path) \(.query)"')"

echo "--- refusals"
check "no box token: the check's 403" 403 "$(code "$B/c/c1")"
check "another connector: the check's 404" 404 "$(code "${TOK[@]}" "$B/c/someone-elses")"
check "an allow without an upstream is not routed (client header ignored)" 502 "$(code "${TOK[@]}" -H "x-termag-mcp-upstream: https://localhost:$UP/mcp" "$B/c/cnoup")"
check "a denied upstream address is refused at connect time" 403 "$(code "${TOK[@]}" -d "$init" "$B/c/cdeny")"
check "the denied upstream saw nothing" 0 "$(curl -sk "https://127.0.0.2:$UP2/_e2e/calls" | jq length)"
check "outside /c/: 404 without a check" 404 "$(code "${TOK[@]}" "$B/mcp")"

echo "--- traversal"
before=$(curl -s "https://localhost:$AUTHZ/_calls" --cacert "$work/ca.pem" | jq length)
check "/c/c1/../someone: checked as someone (404)" 404 "$(code --path-as-is "${TOK[@]}" "$B/c/c1/../someone")"
check "the check saw the normalised connector" "/termag/internal/mcp-authz/c/someone" "$(curl -s "https://localhost:$AUTHZ/_calls" --cacert "$work/ca.pem" | jq -r '.[-1].path')"
check "an encoded dot-segment is normalised too" 404 "$(code --path-as-is "${TOK[@]}" "$B/c/c1/%2e%2e/someone")"
check "an encoded slash is rejected" 400 "$(code --path-as-is "${TOK[@]}" "$B/c/c1%2F..%2Fsomeone")"
check "every check carried the caller proof" true "$(curl -s "https://localhost:$AUTHZ/_calls" --cacert "$work/ca.pem" | jq '[.[].caller] | all')"
check "an absolute-URI request still goes to the connector's upstream" 200 "$(curl -s -o /dev/null -w '%{http_code}' --request-target "http://evil.example/c/c1" "${TOK[@]}" -H 'content-type: application/json' -d "$init" "$B")"
check "…with the upstream's Host" "localhost:$UP" "$(curl -sk "https://localhost:$UP/_e2e/calls" | jq -r '.[-1].host')"
: "$before"

echo "--- OAuth metadata and 401"
check "the connector's PRM path is 404" 404 "$(code "${TOK[@]}" "$B/c/c1/.well-known/oauth-protected-resource")"
check "the root PRM path is 404" 404 "$(code "${TOK[@]}" "$B/.well-known/oauth-protected-resource/c/c1")"
check "the root AS metadata path is 404" 404 "$(code "${TOK[@]}" "$B/.well-known/oauth-authorization-server")"
body=$(curl -s -D "$work/h401" "${TOK[@]}" -H 'content-type: application/json' -d "$init" "$B/c/cbad")
check "an upstream 401 stays 401" 401 "$(awk 'NR==1{print $2}' "$work/h401")"
check "…without WWW-Authenticate" no "$(grep -qi '^www-authenticate' "$work/h401" && echo yes || echo no)"
check "…with the relink message" 'MCP server "cbad" is not linked. Link it at https://orchestrator.example/termag/settings/mcp?server=cbad' "$(jq -r .error.message <<<"$body")"

echo "--- streaming"
start=$(date +%s%N)
first=$(curl -sN "${TOK[@]}" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"slow","arguments":{}}}' "$B/c/c1" \
  | { IFS= read -r l; echo "$(( ($(date +%s%N) - start) / 1000000 )) $l"; cat >"$work/sse-rest"; })
ms=${first%% *}
check "an SSE response's first event arrives before the result (<1500 ms)" yes "$([ "$ms" -lt 1500 ] && echo yes || echo "no (${ms} ms)")"
check "…and the result follows" yes "$(grep -q 'slow: done' "$work/sse-rest" && echo yes || echo no)"
pings=$(timeout 3.5 curl -sN "${TOK[@]}" -H 'accept: text/event-stream' "$B/c/c1" | grep -c '^: ping' || true)
check "the GET stream stays open and streams (>=2 pings in 3.5 s)" yes "$([ "$pings" -ge 2 ] && echo yes || echo "no ($pings)")"

echo "--- access log"
for _ in $(seq 1 20); do grep -q '"connector":"c1"' "$work/envoy.log" && break; sleep 0.25; done
check "the access log names the connector and never the upstream credential" "c1 no" \
  "$(grep '"kind":"mcp-broker-request"' "$work/envoy.log" | grep -m1 '"connector":"c1"' | jq -r .connector) $(grep -q 'up-secret' "$work/envoy.log" && echo yes || echo no)"

[ "$fail" = 0 ] && echo "PASS" || { echo "--- envoy.log"; tail -20 "$work/envoy.log"; exit 1; }
