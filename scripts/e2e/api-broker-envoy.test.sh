#!/usr/bin/env bash
# The API broker through the MCP
# broker's real Envoy listener, rendered from a example-org/terraform checkout
# as production renders it, with no change to it. The check is the backend's
# own decision (services/apiBroker.ts decideApiRequest) with an owner who has
# a Google connector and a Slack MCP connector; Google and Slack are stubs on
# loopback that record what reached them.
#
#   scripts/e2e/api-broker-envoy.test.sh <terraform checkout>
#
# Needs terraform (or E2E_TERRAFORM), openssl, node, curl, jq, and backend's
# node_modules (npm ci in backend/).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
tf_repo=$(cd "${1:?usage: api-broker-envoy.test.sh <terraform checkout>}" && pwd)
module="$tf_repo/projects/termag/root-modules/orchestrator/modules/claude-gateway/envoy-config"
grep -q mcp_listen_port "$module/main.tf" || { echo "SKIP: $tf_repo has no MCP broker listener"; exit 0; }
terraform=${E2E_TERRAFORM:-terraform}
P=${E2E_API_TEST_PORT:-29080}
AUTHZ=$((P + 10)) GOOGLE=$((P + 11)) SLACK=$((P + 12)) MCP=$((P + 6))
work=$(mktemp -d)
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; if [ -n "${E2E_KEEP:-}" ]; then echo "kept $work"; else rm -rf "$work"; fi; }
trap cleanup EXIT

fail=0
check() { # name want got
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want [$2] got [$3]"; fail=1; fi
}

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=api-test-ca \
  -keyout "$work/ca.key" -out "$work/ca.pem" 2>/dev/null
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=localhost \
  -keyout "$work/srv.key" -out "$work/srv.csr" 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' >"$work/ext.cnf"
openssl x509 -req -in "$work/srv.csr" -CA "$work/ca.pem" -CAkey "$work/ca.key" -CAcreateserial -days 1 \
  -extfile "$work/ext.cnf" -out "$work/srv.pem" 2>/dev/null

cat >"$work/main.tf" <<TF
module "cfg" {
  source              = "$module"
  listen_port         = $P
  admin_port          = $((P + 1))
  github_listen_port  = $((P + 2))
  caller_proof_port   = $((P + 3))
  sts_signer_port     = $((P + 4))
  mcp_listen_port     = $MCP
  orchestrator_host   = "localhost"
  orchestrator_port   = $AUTHZ
  system_ca_file      = "$work/ca.pem"
  bedrock_region      = "us-east-2"
  bedrock_host        = "127.0.0.1"
  bedrock_port        = 1
  bedrock_tls         = false
  models              = { default = { profile = "us.test-model-v1", foundation = "test-model-v1" } }
  sts                 = { host = "127.0.0.1:1", port = 1, tls = false }
  mcp_upstream_allowed_cidrs = ["127.0.0.1/32"]
}
TF
( cd "$work" && "$terraform" init -input=false >/dev/null && echo 'module.cfg.yaml' | "$terraform" console | sed '1d;$d' >"$work/envoy.yaml" ) || true
grep -q '"name": "mcp_broker"' "$work/envoy.yaml" 2>/dev/null || { echo "rendering the envoy-config module failed"; exit 1; }

# The orchestrator's check: the route's own split of path and query, then the
# backend's decision. The owner u1 has linked Google (an api connector) and
# Slack's MCP server; the stubs stand in for Google's and Slack's hosts.
cat >"$work/authz.ts" <<TS
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { decideApiRequest, GOOGLE_OAUTH } from '$repo/backend/src/services/apiBroker';
const [cert, key, port, google, slack] = process.argv.slice(2);
const connectors = [
  { id: 'cgoogle', userId: 'u1', name: 'google', upstream: 'https://www.googleapis.com', authType: 'oauth', linkStatus: 'linked', oauthMetadata: GOOGLE_OAUTH },
  { id: 'cslack', userId: 'u1', name: 'slack', upstream: 'https://mcp.slack.com', authType: 'oauth', linkStatus: 'linked',
    oauthMetadata: { issuer: 'https://mcp.slack.com', resource: 'https://mcp.slack.com' } },
];
const tokens: Record<string, string> = { cgoogle: 'ya29.owner-google-token', cslack: 'xoxp-owner-slack-token' };
createServer({ cert: readFileSync(cert), key: readFileSync(key) }, async (req, res) => {
  const url = req.url ?? '';
  const q = url.indexOf('?');
  const path = (q >= 0 ? url.slice(0, q) : url).replace(/^\/termag\/internal\/mcp-authz/, '');
  const d = await decideApiRequest({ path, authorization: req.headers.authorization as string | undefined }, {
    boxForToken: async t => (t === 'tmag_box' ? { userId: 'u1', instanceId: 'i1', managed: true } : null),
    flagOn: async () => true,
    connectors: async () => connectors,
    accessToken: async c => tokens[c.id],
    termagUrl: 'https://orchestrator.example/termag',
    upstreamOf: host => \`https://localhost:\${host.endsWith('slack.com') ? slack : google}\`,
  });
  console.log(\`[MCP-AUTHZ] \${req.method} \${path} -> \${d.allow ? 200 : d.status} \${d.audit}\`);
  if (d.allow) res.writeHead(200, d.headers).end();
  else res.writeHead(d.status, { 'content-type': 'application/json' }).end(JSON.stringify({ message: d.message }));
}).listen(Number(port), '127.0.0.1');
TS
# Google's and Slack's API hosts: record each request and answer it as JSON.
cat >"$work/stub.mjs" <<'JS'
import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';
const [cert, key, port, name] = process.argv.slice(2);
const seen = [];
createServer({ cert: readFileSync(cert), key: readFileSync(key) }, (req, res) => {
  if (req.url === '/_calls') { res.end(JSON.stringify(seen)); return; }
  seen.push({ method: req.method, host: req.headers.host, url: req.url, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
  if (req.url.startsWith('/drive/v3/files/moved')) { res.writeHead(302, { location: 'https://elsewhere.example/steal' }).end(); return; }
  const body = name === 'slack' ? { ok: true, stub: name, path: req.url } : { stub: name, path: req.url, files: [{ id: 'f1', name: 'Plan' }] };
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'track=1' }).end(JSON.stringify(body));
}).listen(Number(port), '127.0.0.1');
JS
tsx="$repo/backend/node_modules/.bin/tsx"
[ -x "$tsx" ] || { echo "no $tsx: run npm ci in backend/"; exit 1; }
"$tsx" "$work/authz.ts" "$work/srv.pem" "$work/srv.key" "$AUTHZ" "$GOOGLE" "$SLACK" >"$work/authz.log" 2>&1 & pids+=($!)
node "$work/stub.mjs" "$work/srv.pem" "$work/srv.key" "$GOOGLE" google >"$work/google.log" 2>&1 & pids+=($!)
node "$work/stub.mjs" "$work/srv.pem" "$work/srv.key" "$SLACK" slack >"$work/slack.log" 2>&1 & pids+=($!)
envoy=$(bash "$here/fakes/envoy.sh" fetch)
AWS_ACCESS_KEY_ID=AKIATEST AWS_SECRET_ACCESS_KEY=test AWS_EC2_METADATA_DISABLED=true \
  "$envoy" -c "$work/envoy.yaml" --disable-hot-restart --log-level warn >"$work/envoy.log" 2>&1 & pids+=($!)
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$MCP/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$MCP/healthz" >/dev/null || { cat "$work/envoy.log"; echo "Envoy did not start"; exit 1; }
for _ in $(seq 1 40); do curl -sk "https://localhost:$AUTHZ/" >/dev/null 2>&1 && break; sleep 0.25; done

B="http://127.0.0.1:$MCP"
BOX=(-H 'Authorization: Bearer tmag_box') # gitleaks:allow
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
calls() { curl -sk "https://localhost:$1/_calls"; }
show() { echo "\$ curl -H 'Authorization: Bearer tmag_box' '$1'"; } # gitleaks:allow

echo "--- Google through the broker"
show "\$BROKER/c/google@www.googleapis.com/drive/v3/files?pageSize=1"
out=$(curl -s -D "$work/hg" "${BOX[@]}" -H 'Cookie: sid=box' "$B/c/google@www.googleapis.com/drive/v3/files?pageSize=1"); echo "$out"
check "Google answers through the broker" "Plan" "$(jq -r '.files[0].name' <<<"$out")"
c=$(calls "$GOOGLE" | jq -c '.[-1]')
check "Google saw the owner's token, not the box's" "Bearer ya29.owner-google-token" "$(jq -r .authorization <<<"$c")"
check "…the path and query as sent" "/drive/v3/files?pageSize=1" "$(jq -r .url <<<"$c")"
check "…and no cookie" null "$(jq -r .cookie <<<"$c")"
check "Set-Cookie never reaches the box" no "$(grep -qi '^set-cookie' "$work/hg" && echo yes || echo no)"
show "\$BROKER/c/google@sheets.googleapis.com/v4/spreadsheets/s1/values/A1"
check "another Google host" 200 "$(code "${BOX[@]}" "$B/c/google@sheets.googleapis.com/v4/spreadsheets/s1/values/A1")"
check "a redirect is passed back, not followed" "302 1" "$(code "${BOX[@]}" "$B/c/google@www.googleapis.com/drive/v3/files/moved") $(calls "$GOOGLE" | jq '[.[] | select(.url | startswith("/drive/v3/files/moved"))] | length')"

echo "--- Slack through the broker"
show "\$BROKER/c/slack@slack.com/api/conversations.history?channel=C1"
out=$(curl -s "${BOX[@]}" -X POST "$B/c/slack@slack.com/api/conversations.history?channel=C1"); echo "$out"
check "Slack answers through the broker" true "$(jq -r .ok <<<"$out")"
c=$(calls "$SLACK" | jq -c '.[-1]')
check "Slack saw the owner's Slack MCP token" "Bearer xoxp-owner-slack-token POST" "$(jq -r '"\(.authorization) \(.method)"' <<<"$c")"

echo "--- refusals"
before=$(( $(calls "$GOOGLE" | jq length) + $(calls "$SLACK" | jq length) ))
show "\$BROKER/c/google@evil.example/drive/v3/files"
out=$(curl -s -w ' HTTP %{http_code}' "${BOX[@]}" "$B/c/google@evil.example/drive/v3/files"); echo "$out"
check "a host the provider does not list: 403" "403" "${out##* }"
check "a Slack host is not a Google one" 403 "$(code "${BOX[@]}" "$B/c/google@slack.com/api/auth.test")"
check "a path outside the allowlist (Gmail batch)" 403 "$(code "${BOX[@]}" "$B/c/google@www.googleapis.com/batch/gmail/v1")"
check "a provider the broker does not know: 404" 404 "$(code "${BOX[@]}" "$B/c/jira@example.atlassian.net/rest/api/3/myself")"
check "no box token: 403" 403 "$(code "$B/c/slack@slack.com/api/auth.test")"
check "a traversal is normalised before the check" 403 "$(code --path-as-is "${BOX[@]}" "$B/c/slack@slack.com/api/../oauth.v2.access")"
check "nothing refused reached a stub" "$before" "$(( $(calls "$GOOGLE" | jq length) + $(calls "$SLACK" | jq length) ))"

echo "--- logs"
check "no provider token in Envoy's or the check's log" no "$(grep -qE 'ya29|xoxp' "$work/envoy.log" "$work/authz.log" && echo yes || echo no)"
grep '\[MCP-AUTHZ\]' "$work/authz.log" | sed 's/^/  /'
[ "$fail" = 0 ] && echo "PASS" || { echo "--- envoy.log"; tail -20 "$work/envoy.log"; exit 1; }
