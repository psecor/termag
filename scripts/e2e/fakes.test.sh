#!/usr/bin/env bash
# End-to-end check of the opt-in fakes (scripts/e2e/fakes/fakes.sh): one stack
# with every fake on, then each fake through the surface a feature would use,
# then down.sh leaving no process, port or file behind. Runs on its own ports,
# TMPDIR and download cache, so it can run beside a stack that is already up.
#
# Run: bash scripts/e2e/fakes.test.sh   (make e2e-test runs it after e2e.test.sh)
#   E2E_TEST_PORT_SHIFT=N      add N to every port, beside a stack already on these
#   E2E_TEST_CLAUDE_GATEWAY=<example-org/terraform checkout>
#                              also run the Claude gateway through Envoy; needs a
#                              backend with the gateway and terraform
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_CACHE_DIR=${E2E_TEST_CACHE_DIR:-$WORK/cache}
S=${E2E_TEST_PORT_SHIFT:-0}
export E2E_PORT=$((3950 + S)) E2E_FRONTEND_PORT=$((5984 + S)) E2E_PG_PORT=$((55449 + S)) E2E_BOXES=2 \
  E2E_AWS_PORT=$((4666 + S)) E2E_EC2_PORT=$((4667 + S)) E2E_GITHUB_PORT=$((4680 + S)) E2E_TLS_PORT=$((3543 + S)) \
  E2E_CHECKS_PORT=$((13141 + S)) E2E_CHECKS_ALB_PORT=$((3645 + S)) \
  E2E_GATEWAY_PORT=$((13140 + S)) E2E_SSH_PORT_BASE=$((2320 + S)) E2E_BEDROCK_PORT=$((4690 + S)) \
  E2E_FAKE_AWS=1 E2E_FAKE_CLAUDE=1 E2E_FAKE_GITHUB=1 E2E_TLS=1 E2E_SSHD=1 E2E_EC2_BOXES=1 E2E_EC2_LAUNCH=1 E2E_TMUX_FAULTS=1 \
  E2E_FAKE_BEDROCK=1 E2E_CREDENTIAL_STORE=1
if [ -n "${E2E_TEST_CLAUDE_GATEWAY:-}" ]; then
  export E2E_CLAUDE_GATEWAY=$E2E_TEST_CLAUDE_GATEWAY \
    E2E_CLAUDE_GATEWAY_PORT=$((3643 + S)) E2E_CLAUDE_GATEWAY_ENVOY_PORT=$((18080 + S)) \
    E2E_GITHUB_BROKER_PORT=$((3644 + S)) E2E_STS_PORT=$((4691 + S))
  # The MCP broker, when the checkout's gateway has its listener.
  if grep -q 'variable "mcp_listen_port"' "$E2E_TEST_CLAUDE_GATEWAY/projects/termag/root-modules/orchestrator/modules/claude-gateway/envoy-config/main.tf" 2>/dev/null; then
    E2E_FLAGS=$(jq -c '. + {"mcp-broker-enabled": true}' <<<"${E2E_FLAGS:-{\}}") || { echo 'E2E_FLAGS is not a JSON object' >&2; exit 1; }
    export E2E_FAKE_MCP=1 E2E_MCP_PORT=$((4693 + S)) E2E_MCP_BROKER_PORT=$((3646 + S)) E2E_FLAGS
  fi
fi
trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }
b64sha() { printf '%s' "$1" | openssl dgst -sha256 -binary | base64; }

cat >"$WORK/seed.sh" <<'SEED'
set -e
aws.sh mb seeded-by-hook
SEED
printf 'E2E_MARKER=from-backend-env-file\nBOX_START_TIMEOUT_SECONDS=3\nBOX_STOP_TIMEOUT_SECONDS=3\n' >"$WORK/extra.env"
export E2E_AWS_SEED=$WORK/seed.sh E2E_BACKEND_ENV=$WORK/extra.env

touch "$WORK/.started"
sleep 1
if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"; echo "FAIL: up.sh with every fake"; exit 1
fi
pass "up.sh brought the stack up with every fake"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
U=$(id -un)
API="http://127.0.0.1:$E2E_PORT/termag"
JAR="$WORK/cookies"
curl -s -o /dev/null -c "$JAR" "$API/auth/login"
T1="$ROOT/boxes/box-1/bin/tmux"
status_of() { e2e_box_status "$ROOT" box-1 "$API" "$1"; }
wait_status() {
  local s
  for _ in $(seq 1 40); do s=$(status_of "$1"); [ "$s" = "$2" ] && break; sleep 0.25; done
  printf '%s' "$s"
}

echo "--- E2E_FAKE_AWS (Floci)"
AWS="http://127.0.0.1:$E2E_AWS_PORT"
check "floci answers on loopback" 200 "$(curl -s -o /dev/null -w '%{http_code}' "$AWS/_floci/health")"
check "floci listens only on its loopback port" "127.0.0.1:$E2E_AWS_PORT" \
  "$(lsof -a -p "$(cat "$ROOT/pids/floci.pid")" -iTCP -sTCP:LISTEN -nP 2>/dev/null | awk 'NR>1{print $9}' | sort -u | tr '\n' ' ' | sed 's/ $//')"
check "E2E_AWS_SEED ran (bucket it made exists)" 200 "$(curl -s -o /dev/null -w '%{http_code}' -I "$AWS/seeded-by-hook")"
bash "$here/fakes/aws.sh" mb e2e-test
check "S3 put with a matching x-amz-checksum-sha256" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary good -H "x-amz-checksum-sha256: $(b64sha good)" "$AWS/e2e-test/k")"
check "S3 rejects a body that doesn't match x-amz-checksum-sha256" 400 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary evil -H "x-amz-checksum-sha256: $(b64sha good)" "$AWS/e2e-test/k2")"
upload=$(curl -s -X POST "$AWS/e2e-test/big?uploads" -H 'x-amz-checksum-algorithm: SHA256' | sed -n 's:.*<UploadId>\(.*\)</UploadId>.*:\1:p')
check "S3 part upload rejects a tampered part" 400 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT --data-binary evil -H "x-amz-checksum-sha256: $(b64sha good)" "$AWS/e2e-test/big?partNumber=1&uploadId=$upload")"
key=$(bash "$here/fakes/aws.sh" call TrentService.CreateKey '{}' | jq -r .KeyMetadata.KeyId)
blob=$(bash "$here/fakes/aws.sh" call TrentService.Encrypt "{\"KeyId\":\"$key\",\"Plaintext\":\"$(printf hi | base64)\"}" | jq -r .CiphertextBlob)
check "KMS encrypt/decrypt round trip" hi \
  "$(bash "$here/fakes/aws.sh" call TrentService.Decrypt "{\"CiphertextBlob\":\"$blob\"}" | jq -r .Plaintext | base64 -d)"
bash "$here/fakes/aws.sh" call AmazonSSM.PutParameter "{\"Name\":\"/termag/e2e\",\"Value\":\"s3cret\",\"Type\":\"SecureString\",\"KeyId\":\"$key\"}" >/dev/null
check "SSM SecureString read back decrypted" s3cret \
  "$(bash "$here/fakes/aws.sh" call AmazonSSM.GetParameter '{"Name":"/termag/e2e","WithDecryption":true}' | jq -r .Parameter.Value)"
bash "$here/fakes/aws.sh" call secretsmanager.CreateSecret '{"Name":"termag/e2e","SecretString":"v1"}' >/dev/null
check "Secrets Manager read back" v1 \
  "$(bash "$here/fakes/aws.sh" call secretsmanager.GetSecretValue '{"SecretId":"termag/e2e"}' | jq -r .SecretString)"
sdk=$(cd "$repo/backend" && node -e '
  require("dotenv").config({ path: process.argv[1] });
  const { EC2Client, DescribeVpcsCommand } = require("@aws-sdk/client-ec2");
  new EC2Client({}).send(new DescribeVpcsCommand({})).then(r => console.log(r.Vpcs[0].VpcId), e => console.log("ERR " + e.message));
' "$ROOT/backend.env")
check "the backend's env sends its AWS SDK to Floci (EC2 DescribeVpcs)" vpc-default-us-east-2 "$sdk"

echo "--- E2E_EC2_BOXES and E2E_BACKEND_ENV"
check "box-1 is kind=ec2 and ready, box-2 external and ready" "box-1 ec2 ready,box-2 external ready" \
  "$(curl -s -b "$JAR" "$API/api/instances" | jq -r 'sort_by(.name) | map("\(.name) \(.kind) \(.status)") | join(",")')"
check "E2E_BACKEND_ENV reached the backend env file" 1 "$(grep -c '^E2E_MARKER=from-backend-env-file$' "$ROOT/backend.env")"

echo "--- E2E_EC2_LAUNCH (Add box starts a box, terminate stops it)"
box_field() { curl -s -b "$JAR" "$API/api/instances/$1" | jq -r ".$2"; }
wait_box() {
  local s
  for _ in $(seq 1 60); do s=$(box_field "$1" status); [ "$s" = "$2" ] && break; sleep 0.25; done
  printf '%s' "$s"
}
add_box() { curl -s -b "$JAR" -H 'content-type: application/json' -d "{\"name\":\"$1\"}" "$API/api/instances" | jq -r .instance.id; }
ec2_state() {
  (cd "$repo/backend" && node -e '
    require("dotenv").config({ path: process.argv[1] });
    const { EC2Client, DescribeInstancesCommand } = require("@aws-sdk/client-ec2");
    new EC2Client({}).send(new DescribeInstancesCommand({ InstanceIds: [process.argv[2]] }))
      .then(r => console.log(r.Reservations[0].Instances[0].State.Name), e => console.log("ERR " + e.message));
  ' "$ROOT/backend.env" "$1")
}
box1=$(curl -s -b "$JAR" "$API/api/instances" | jq -r '.[] | select(.name=="box-1") | .id')
check "seeded box-1 went through RunInstances" yes "$([[ $(box_field "$box1" ec2InstanceId) == i-* ]] && echo yes || echo no)"
check "the provisioner's user data carried no token into the launch log" 0 "$(grep -c tmag_ "$ROOT/logs/ec2-launch.log")"
nb=$(add_box launched-1)
check "Add box: a launched box comes up ready" ready "$(wait_box "$nb" ready)"
check "its agent runs from boxes/launched-1" yes "$([ -f "$ROOT/pids/launched-1.pid" ] && kill -0 "$(cat "$ROOT/pids/launched-1.pid")" && echo yes || echo no)"
nb_ec2=$(box_field "$nb" ec2InstanceId)
nb_pid=$(cat "$ROOT/pids/launched-1.pid")
curl -s -b "$JAR" -X DELETE "$API/api/instances/$nb" >/dev/null
for _ in $(seq 1 40); do kill -0 "$nb_pid" 2>/dev/null || break; sleep 0.25; done
check "terminate stops the launched box's agent" gone "$(kill -0 "$nb_pid" 2>/dev/null && echo running || echo gone)"
check "and Floci has the instance terminated" terminated "$(ec2_state "$nb_ec2")"
bash "$here/ctl.sh" ec2 clear >/dev/null
nb=$(add_box launched-2)
check "ctl.sh ec2 clear: the next launch fails with no image" "failed No box AMI found" \
  "$(wait_box "$nb" failed) $(box_field "$nb" provisioningError | grep -o 'No box AMI found')"
bash "$here/ctl.sh" ec2 bake >/dev/null
bash "$here/ctl.sh" ec2 no-agent >/dev/null
nb=$(add_box launched-3)
sleep 2
check "ctl.sh ec2 no-agent: the instance runs, the box never connects" "provisioning running" \
  "$(box_field "$nb" status) $(ec2_state "$(box_field "$nb" ec2InstanceId)")"
bash "$here/ctl.sh" ec2 agent >/dev/null
curl -s -b "$JAR" -X DELETE "$API/api/instances/$nb" >/dev/null
nb=$(add_box launched-1)
check "ctl.sh ec2 bake + agent: launches work again, reusing a terminated box's name" "ready launched-1.2" \
  "$(wait_box "$nb" ready) $(basename "$(dirname "$(box_field "$nb" hostHome)")")"
curl -s -b "$JAR" -X DELETE "$API/api/instances/$nb" >/dev/null
for _ in $(seq 1 40); do [ -f "$ROOT/pids/launched-1.2.pid" ] || break; sleep 0.25; done
# Straight to the launch fake: terminate while box.sh is still starting the box.
race=$(cd "$repo/backend" && node -e '
  require("dotenv").config({ path: process.argv[1] });
  const ec2 = require("@aws-sdk/client-ec2");
  const c = new ec2.EC2Client({});
  const userData = Buffer.from(`cat <<'"'"'JSON'"'"'\n{"termag_url":"ws://127.0.0.1:1","token":"t_race"}\nJSON\n`).toString("base64");
  (async () => {
    const { Images } = await c.send(new ec2.DescribeImagesCommand({ Owners: ["self"] }));
    const r = await c.send(new ec2.RunInstancesCommand({ ImageId: Images[0].ImageId, InstanceType: "t4g.medium", MinCount: 1, MaxCount: 1, UserData: userData,
      TagSpecifications: [{ ResourceType: "instance", Tags: [{ Key: "BoxName", Value: "race" }] }] }));
    const id = r.Instances[0].InstanceId;
    await c.send(new ec2.TerminateInstancesCommand({ InstanceIds: [id] }));
    console.log(id);
  })().catch(e => console.log("ERR " + e.message));
' "$ROOT/backend.env")
for _ in $(seq 1 40); do [ -f "$ROOT/ec2/$race.terminated" ] && break; sleep 0.25; done
sleep 1
check "a terminate that races the launch leaves no box agent running" "terminated, no agent" \
  "$([ -f "$ROOT/ec2/$race.terminated" ] && echo terminated || echo "not terminated ($race)"), $( \
    [ -f "$ROOT/pids/race.pid" ] && kill -0 "$(cat "$ROOT/pids/race.pid")" 2>/dev/null && echo "agent running" || echo "no agent")"

echo "--- E2E_EC2_LAUNCH image tags (Floci drops them; the launch fake puts them back)"
ec2_images() {
  (cd "$repo/backend" && node -e '
    require("dotenv").config({ path: process.argv[1] });
    const { EC2Client, DescribeImagesCommand } = require("@aws-sdk/client-ec2");
    const Filters = process.argv.slice(2).map(f => { const [k, v] = f.split("="); return { Name: `tag:${k}`, Values: [v] }; });
    new EC2Client({}).send(new DescribeImagesCommand({ Owners: ["self"], Filters }))
      .then(r => console.log(r.Images.map(i => `${i.ImageId}:${(i.Tags ?? []).find(t => t.Key === "Component")?.Value ?? "-"}`).sort().join(" ")),
            e => console.log("ERR " + e.message));
  ' "$ROOT/backend.env" "$@")
}
ec2_tag() {
  (cd "$repo/backend" && node -e '
    require("dotenv").config({ path: process.argv[1] });
    const { EC2Client, CreateTagsCommand } = require("@aws-sdk/client-ec2");
    const [k, v] = process.argv[3].split("=");
    new EC2Client({}).send(new CreateTagsCommand({ Resources: [process.argv[2]], Tags: [{ Key: k, Value: v }] }))
      .then(() => console.log("ok"), e => console.log("ERR " + e.message));
  ' "$ROOT/backend.env" "$1" "$2")
}
ec2_image_of() {
  (cd "$repo/backend" && node -e '
    require("dotenv").config({ path: process.argv[1] });
    const { EC2Client, DescribeInstancesCommand } = require("@aws-sdk/client-ec2");
    new EC2Client({}).send(new DescribeInstancesCommand({ InstanceIds: [process.argv[2]] }))
      .then(r => console.log(r.Reservations[0].Instances[0].ImageId), e => console.log("ERR " + e.message));
  ' "$ROOT/backend.env" "$1")
}
bake_tagged() { bash "$here/ctl.sh" ec2 bake "$@" 2>&1 | grep -o 'ami-[0-9a-f]*' | head -n1; }
bash "$here/ctl.sh" ec2 clear >/dev/null
published=$(bake_tagged)
candidate=$(bake_tagged Component=box-candidate)
check "DescribeImages through the launch fake carries each image's tags" \
  "$(printf '%s\n' "$published:box" "$candidate:box-candidate" | sort | tr '\n' ' ' | sed 's/ $//')" "$(ec2_images)"
check "and honours tag: filters, which Floci ignores" "$published:box" "$(ec2_images Component=box)"
check "a tag: filter that matches nothing returns nothing" "" "$(ec2_images Component=nope)"
nb=$(add_box tagged-1)
check "Add box launches the Component=box image, not the newer candidate" "ready $published" \
  "$(wait_box "$nb" ready) $(ec2_image_of "$(box_field "$nb" ec2InstanceId)")"
curl -s -b "$JAR" -X DELETE "$API/api/instances/$nb" >/dev/null
bash "$here/ctl.sh" ec2 clear >/dev/null
candidate=$(bake_tagged Component=box-candidate)
nb=$(add_box tagged-2)
check "with only a candidate image, the launch fails: discovery cannot see it" "failed No box AMI found" \
  "$(wait_box "$nb" failed) $(box_field "$nb" provisioningError | grep -o 'No box AMI found')"
check "CreateTags Component=box (the rollout's promotion) goes through" ok "$(ec2_tag "$candidate" Component=box)"
nb=$(add_box tagged-3)
check "and the promoted image is what the next Add box launches" "ready $candidate" \
  "$(wait_box "$nb" ready) $(ec2_image_of "$(box_field "$nb" ec2InstanceId)")"
curl -s -b "$JAR" -X DELETE "$API/api/instances/$nb" >/dev/null
bash "$here/ctl.sh" ec2 bake Component=box-candidate Owner=e2e >/dev/null
check "ctl.sh ec2 bake takes several Key=Value tags" 1 "$(ec2_images Owner=e2e Component=box-candidate | wc -w | tr -d ' ')"

echo "--- E2E_EC2_LAUNCH stop/start (Stop box powers the box off, Start box boots it)"
power() { curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X POST "$API/api/instances/$1/$2"; }
wait_box_long() {
  local s
  for _ in $(seq 1 60); do s=$(box_field "$1" status); [ "$s" = "$2" ] && break; sleep 1; done
  printf '%s' "$s"
}
pb=$(add_box power-1)
check "a box to stop comes up ready" ready "$(wait_box "$pb" ready)"
pb_ec2=$(box_field "$pb" ec2InstanceId)
pb_pid=$(cat "$ROOT/pids/power-1.pid")
check "Stop box answers 202" 202 "$(power "$pb" stop)"
check "the box settles to stopped once EC2 reports stopped" "stopped stopped" "$(wait_box_long "$pb" stopped) $(ec2_state "$pb_ec2")"
check "and its agent is gone" gone "$(kill -0 "$pb_pid" 2>/dev/null && echo running || echo gone)"
check "Stop box on a stopped box answers 409" 409 "$(power "$pb" stop)"
check "creating a project on a stopped box answers 409 with a clear error" "409 This box is stopped. Start it from the Boxes list first." \
  "$(curl -s -o "$WORK/p.json" -w '%{http_code}' -b "$JAR" -H 'content-type: application/json' \
      -d "{\"name\":\"on-stopped\",\"instanceId\":\"$pb\"}" "$API/api/projects") $(jq -r .error "$WORK/p.json")"
check "Start box answers 202" 202 "$(power "$pb" start)"
check "the box is ready again once its agent redials" "ready running" "$(wait_box_long "$pb" ready) $(ec2_state "$pb_ec2")"
bash "$here/ctl.sh" ec2 no-agent >/dev/null
power "$pb" stop >/dev/null; wait_box_long "$pb" stopped >/dev/null
power "$pb" start >/dev/null
for _ in $(seq 1 40); do [ "$(box_field "$pb" provisioningError)" != null ] && break; sleep 1; done
check "ec2 no-agent: a start whose agent never connects stays starting, with the reason" \
  "starting The box is running but its agent has not connected after 3 seconds." \
  "$(box_field "$pb" status) $(box_field "$pb" provisioningError | cut -d. -f1)."
check "and it can be stopped again" "202 stopped" "$(power "$pb" stop) $(wait_box_long "$pb" stopped)"
bash "$here/ctl.sh" ec2 agent >/dev/null
bash "$here/ctl.sh" ec2 ignore-stop >/dev/null
power "$pb" start >/dev/null; wait_box_long "$pb" ready >/dev/null
check "ec2 ignore-stop: a stop EC2 never carries out goes back to ready, with the reason" \
  "202 ready Stop did not complete: EC2 still reports the instance running after 3 seconds" \
  "$(power "$pb" stop) $(wait_box_long "$pb" ready) $(box_field "$pb" provisioningError)"
bash "$here/ctl.sh" ec2 honor-stop >/dev/null
power "$pb" stop >/dev/null; wait_box_long "$pb" stopped >/dev/null
# Straight to the launch fake: a stop that lands while the start is still booting the box.
offs() { grep -c "$pb_ec2: stopped, powered box power-1 off" "$ROOT/logs/ec2-launch.log"; }
offs_before=$(offs)
(cd "$repo/backend" && node -e '
  require("dotenv").config({ path: process.argv[1] });
  const ec2 = require("@aws-sdk/client-ec2");
  const c = new ec2.EC2Client({});
  const InstanceIds = [process.argv[2]];
  (async () => {
    await c.send(new ec2.StartInstancesCommand({ InstanceIds }));
    await c.send(new ec2.StopInstancesCommand({ InstanceIds }));
  })().catch(e => console.log("ERR " + e.message));
' "$ROOT/backend.env" "$pb_ec2")
for _ in $(seq 1 40); do [ "$(offs)" -gt "$offs_before" ] && break; sleep 0.25; done
sleep 1
check "a stop that races the start leaves no box agent running" "no agent" \
  "$([ -f "$ROOT/pids/power-1.pid" ] && kill -0 "$(cat "$ROOT/pids/power-1.pid")" 2>/dev/null && echo "agent running" || echo "no agent")"
curl -s -b "$JAR" -X DELETE "$API/api/instances/$pb" >/dev/null

echo "--- E2E_TLS (nginx from deploy/nginx, boxes over wss)"
check "gateway proxies to the backend" 200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$E2E_GATEWAY_PORT/termag/health")"
check "TLS listener serves the stack CA's cert" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' --cacert "$ROOT/tls/ca.pem" "https://localhost:$E2E_TLS_PORT/termag/health")"
check "TLS listener fails verification without the CA" 60 \
  "$(curl -s -o /dev/null "https://localhost:$E2E_TLS_PORT/termag/health"; echo $?)"
check "both boxes dialed wss://" 2 "$(grep -l 'Connecting to wss://localhost' "$ROOT"/logs/box-*.log | wc -l | tr -d ' ')"
check "box agents' websockets reach nginx from the box network's 127.0.0.2" yes \
  "$([ "$(ss -Htn state established src 127.0.0.2 dport = :"$E2E_TLS_PORT" | wc -l)" -ge 2 ] && echo yes || echo no)"

echo "--- E2E_FAKE_CLAUDE (status through termag-status, over TLS)"
check "the agent pane runs the claude stub" claude "$("$T1" display -p -t "$U-sample-agent" '#{pane_current_command}')"
check "stub reports idle at its prompt" idle "$(wait_status "$U-sample-agent" idle)"
"$T1" send-keys -t "$U-sample-agent" 'long task' Enter
check "stub reports working on a long prompt" working "$(wait_status "$U-sample-agent" working)"
check "status writes went through the TLS listener, from 127.0.0.2" yes \
  "$(grep -q '^127\.0\.0\.2 .*POST /termag/api/status' "$ROOT/logs/nginx-alb-access.log" && echo yes || echo no)"
"$T1" send-keys -t "$U-sample-agent" C-c
"$T1" send-keys -t "$U-sample-agent" 'claude --continue' Enter
sleep 1
check "claude --continue finds the conversation" 1 \
  "$("$T1" capture-pane -p -t "$U-sample-agent" | grep -c 'continuing [0-9a-f-]\{36\}')"

echo "--- E2E_FAKE_GITHUB"
GH="http://127.0.0.1:$E2E_GITHUB_PORT"
# The stub keys its answers on a word in the token; none of these is real.
ghcurl() { local tok=$1; shift; curl -s -H "authorization: token $tok" "$@"; }
check "stub: /user with a good token" e2e-octocat "$(ghcurl t_good "$GH/user" | jq -r .login)"
check "stub: /user with a _bad token" 401 "$(ghcurl t_bad -o /dev/null -w '%{http_code}' "$GH/user")"
check "stub: _noscope token lacks admin:public_key" "repo, read:org" \
  "$(ghcurl t_noscope -D - -o /dev/null "$GH/user" | tr -d '\r' | sed -n 's/^x-oauth-scopes: //p')"
bpid=$(pgrep -g "$(cat "$ROOT/pids/backend.pid")" -f 'src/index.ts' | tail -n1)
check "the backend process carries the redirect preload" 1 \
  "$(tr '\0' '\n' </proc/"$bpid"/environ | grep -c 'NODE_OPTIONS=--require .*github-redirect.cjs')"
mapfile -t genv < <(tr '\0' '\n' </proc/"$bpid"/environ | grep -E '^(NODE_OPTIONS|E2E_GITHUB_URL)=')
redirected=$(cd "$repo/backend" && env -i PATH="$PATH" "${genv[@]}" \
  node -e 'fetch("https://api.github.com/user", { headers: { authorization: "token t_good" } }).then(r => r.json()).then(j => console.log(j.login), e => console.log("ERR " + e.message))')
check "with the backend's env, fetch(api.github.com) reaches the stub" e2e-octocat "$redirected"
check "stub: github.com git smart-HTTP serves e2e-org/sample" 40 \
  "$(git -c credential.helper= ls-remote "http://x-access-token:t_good@127.0.0.1:$E2E_GITHUB_PORT/_github.com/e2e-org/sample.git" HEAD | cut -f1 | tr -d '\n' | wc -c)"
check "stub: git without a token gets 401" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' "$GH/_github.com/e2e-org/sample.git/info/refs?service=git-upload-pack")"
check "stub: git with a _bad token in Basic auth gets 401" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -u x-access-token:t_bad "$GH/_github.com/e2e-org/sample.git/info/refs?service=git-upload-pack")"
check "stub: git ls-remote with a _bad token fails" failed \
  "$(git -c credential.helper= ls-remote "http://x-access-token:t_bad@127.0.0.1:$E2E_GITHUB_PORT/_github.com/e2e-org/sample.git" HEAD >/dev/null 2>&1 && echo listed || echo failed)"
check "stub: the API reads _bad out of Basic auth too" 401 \
  "$(curl -s -o /dev/null -w '%{http_code}' -u x:t_bad "$GH/user")"
redirected=$(cd "$repo/backend" && env -i PATH="$PATH" "${genv[@]}" \
  node -e 'fetch("https://github.com/e2e-org/sample.git/info/refs?service=git-upload-pack", { headers: { authorization: "Basic " + Buffer.from("x:t_good").toString("base64") } }).then(r => console.log(r.status), e => console.log("ERR " + e.message))')
check "with the backend's env, fetch(github.com) reaches the stub's git" 200 "$redirected"
if command -v gh >/dev/null; then
  "$T1" send-keys -t "$U-sample-ctrl" 'clear; GH_HOST=broker.invalid gh --version | head -n1' Enter
  sleep 1
  check "the box gh stub hands other hosts to the real gh" 1 \
    "$("$T1" capture-pane -p -t "$U-sample-ctrl" | grep -c '^gh version')"
fi
"$T1" send-keys -t "$U-sample-ctrl" 'echo tok_e2e | gh auth login --with-token && gh auth status' Enter
sleep 1
check "gh stub on the box keeps the token" "github.com: logged in (stub)" \
  "$("$T1" capture-pane -p -t "$U-sample-ctrl" | grep -o 'github.com: logged in (stub)' | head -n1)"

echo "--- E2E_CREDENTIAL_STORE (KMS envelope encryption in Postgres)"
cred_arn=$(bash "$here/fakes/aws.sh" call TrentService.DescribeKey '{"KeyId":"alias/termag-user-credentials"}' | jq -r .KeyMetadata.Arn)
check "the backend env holds the ARN of alias/termag-user-credentials" "CREDENTIAL_STORE_KMS_KEY_ID=$cred_arn" \
  "$(grep '^CREDENTIAL_STORE_KMS_KEY_ID=' "$ROOT/backend.env")"
check "seeding again keeps the alias on its key" "CREDENTIAL_STORE_KMS_KEY_ID=$cred_arn" \
  "$(E2E_AWS_URL=$AWS bash "$here/fakes/credential-store.sh" seed-aws 2>/dev/null)"
dk=$(bash "$here/fakes/aws.sh" call TrentService.GenerateDataKey \
  '{"KeyId":"alias/termag-user-credentials","KeySpec":"AES_256","EncryptionContext":{"purpose":"termag-user-credential","userId":"a"}}' | jq -r .CiphertextBlob)
check "Floci's KMS decrypts a data key with its encryption context" "$cred_arn" \
  "$(bash "$here/fakes/aws.sh" call TrentService.Decrypt "{\"CiphertextBlob\":\"$dk\",\"EncryptionContext\":{\"purpose\":\"termag-user-credential\",\"userId\":\"a\"}}" | jq -r .KeyId)"
check "and refuses it with another user's" refused \
  "$(bash "$here/fakes/aws.sh" call TrentService.Decrypt "{\"CiphertextBlob\":\"$dk\",\"EncryptionContext\":{\"purpose\":\"termag-user-credential\",\"userId\":\"b\"}}" >/dev/null 2>&1 && echo decrypted || echo refused)"
cred_token=gho_e2eFakesTestToken0123456789abcdef
check "connecting GitHub stores the credential" '"@e2e-octocat"' \
  "$(curl -s -b "$JAR" -X PUT -H 'content-type: application/json' -d "{\"token\":\"$cred_token\"}" "$API/api/credentials/github" | jq .label)"
row() {
  (cd "$repo/backend" && node -e '
    const { Client } = require("pg");
    const c = new Client({ connectionString: process.argv[1] });
    c.connect().then(() => c.query("select label, ciphertext from user_credentials where provider = $1", ["github"]))
      .then(r => { const x = r.rows[0]; console.log(x ? `${x.label} ${x.ciphertext.length} ${x.ciphertext.includes(Buffer.from(process.argv[2])) ? "plaintext" : "ciphertext-only"}` : "none"); return c.end(); });
  ' "postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag" "$cred_token")
}
check "the row holds the label and ciphertext, not the token" "@e2e-octocat ciphertext-only" "$(row | sed -E 's/ [0-9]+ / /')"
check "the Credentials page lists it without a KMS call" '"@e2e-octocat"' \
  "$(curl -s -b "$JAR" "$API/api/credentials" | jq .github.connected.label)"
check "disconnecting deletes the row" "204 none" \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X DELETE "$API/api/credentials/github") $(row)"

echo "--- E2E_FAKE_BEDROCK"
BR="http://127.0.0.1:$E2E_BEDROCK_PORT"
check "stub: an unsigned invoke gets 403" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BR/model/us.anthropic.claude-opus-5-5/invoke" -d '{}')"
sigv4="AWS4-HMAC-SHA256 Credential=AKIATEST/20260101/us-east-2/bedrock/aws4_request, SignedHeaders=host, Signature=$(printf '0%.0s' $(seq 64))"
check "stub: a SigV4-signed invoke gets a reply naming the model" "(fake Bedrock) us.anthropic.claude-opus-5-5" \
  "$(curl -s -H "Authorization: $sigv4" -X POST "$BR/model/us.anthropic.claude-opus-5-5/invoke" \
    -d '{"messages":[{"role":"user","content":"hi"}]}' | jq -r '.content[0].text' | cut -d' ' -f1-3)"
check "stub: SigV4 for another service gets 403" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: ${sigv4/\/bedrock\//\/s3\/}" -X POST "$BR/model/x/invoke" -d '{}')"
check "stub: the invocation log has the token counts" 1 \
  "$(tail -n1 "$ROOT/logs/bedrock-invocations.jsonl" | jq -r 'select(.input.inputTokenCount > 0 and .output.outputTokenCount > 0) | 1')"

if [ -n "${E2E_CLAUDE_GATEWAY:-}" ]; then
  echo "--- E2E_CLAUDE_GATEWAY (Envoy from $E2E_CLAUDE_GATEWAY)"
  inbox() { # inbox <box> <command>: run as the box does, with its agent's env
    local env_lines; mapfile -t env_lines < <(tr '\0' '\n' </proc/"$(cat "$ROOT/pids/$1.pid")"/environ)
    (cd "$ROOT/boxes/$1/home" && env -i "${env_lines[@]}" PATH="$repo/deploy:$(printf '%s\n' "${env_lines[@]}" | sed -n 's/^PATH=//p')" bash -c "$2" 2>&1)
  }
  settings=$ROOT/boxes/box-1/home/.claude/settings.json
  for _ in $(seq 1 80); do [ -s "$settings" ] && break; sleep 0.25; done
  default=$(jq -r .default "$E2E_CLAUDE_GATEWAY/projects/termag/root-modules/orchestrator/claude-models.json")
  profile=$(jq -r --arg t "$default" '.models[$t].profile' "$E2E_CLAUDE_GATEWAY/projects/termag/root-modules/orchestrator/claude-models.json")
  check "box-1 gets the gateway settings with the default model from claude-models.json" "$profile" "$(jq -r .env.ANTHROPIC_MODEL "$settings" 2>&1)"
  check "claude -p on box-1 reaches Bedrock through the gateway" "(fake Bedrock) $profile" \
    "$(inbox box-1 'claude -p hello' | grep -o '^(fake Bedrock) [^ ]*')"
  check "Bedrock got SigV4 from the gateway, and neither the box token nor the check's headers" \
    "/us-east-2/bedrock bearer=absent termag-headers=absent" \
    "$(curl -s "$BR/_e2e/calls" | jq -r '.[-1]' | grep -o '/us-east-2/bedrock bearer=absent termag-headers=absent')"
  check "the gateway settings hold no token: apiKeyHelper reads the box's own agent config" \
    "$ROOT/boxes/box-1/home/.termag/agent.config.json" \
    "$(jq -r .apiKeyHelper "$settings" | grep -o "'[^']*agent.config.json'" | tr -d "'")"
  me=$(curl -s -b "$JAR" "$API/auth/me")
  box1_id=$(curl -s -b "$JAR" "$API/api/instances" | jq -r '.[] | select(.name == "box-1") | .id')
  access=
  for _ in $(seq 1 60); do # Envoy flushes its access log about every 10 s
    access=$(grep '"kind":"claude-gateway-request"' "$ROOT/logs/claude-gateway.log" | jq -c 'select(.status == 200 and (.path | startswith("/model/")))' 2>/dev/null | tail -n1)
    [ -n "$access" ] && break; sleep 0.5
  done
  check "Envoy's access log names the user, box and email the orchestrator's check returned" \
    "$(jq -r '"\(.id) \(.email)"' <<<"$me") $box1_id" \
    "$(jq -r '"\(.user) \(.email) \(.instance)"' <<<"$access" 2>&1)"
  check "a model outside claude-models.json gets 403 from the gateway" "HTTP 403" \
    "$(inbox box-1 'claude -p --model global.anthropic.claude-sonnet-5-5 hi' | grep -o 'HTTP 403')"
  CGW="https://localhost:$E2E_CLAUDE_GATEWAY_PORT"
  gwc() { curl -s --cacert "$ROOT/tls/ca.pem" -w '%{http_code}' -X POST "$CGW/model/$profile/invoke" -d '{}' "$@"; }
  gw() { gwc -o /dev/null "$@"; }
  gw_tok() { printf 'Authorization: Bearer %s' "$(jq -r .token "$ROOT/boxes/$1/home/.termag/agent.config.json")"; }
  check "the gateway refuses a call with no token" 401 "$(gw)"
  check "and an unknown box token" 401 "$(gw -H 'Authorization: Bearer tmag_not_a_real_box_token')" # gitleaks:allow (fake)
  check "and box-2's (external) own valid token" 403 "$(gw -H "$(gw_tok box-2)")"
  check "the auth probe answers 204 for box-1's token, with no model call" "204 $(curl -s "$BR/_e2e/calls" | jq length)" \
    "$(curl -s --cacert "$ROOT/tls/ca.pem" -o /dev/null -w '%{http_code}' -H "$(gw_tok box-1)" "$CGW/termag/auth-check") $(curl -s "$BR/_e2e/calls" | jq length)"
  check "termag-credentials status on box-1 says the gateway accepts its token" "claude-gateway: on" \
    "$(inbox box-1 'termag-credentials status' | grep -o '^claude-gateway: on')"
  cauthz="https://localhost:$E2E_CHECKS_ALB_PORT/termag/internal/claude-authz/model/$profile/invoke"
  check "the Claude check endpoint refuses a box calling it directly with its own token" 403 \
    "$(curl -s --cacert "$ROOT/tls/ca.pem" -o /dev/null -w '%{http_code}' -H "$(gw_tok box-1)" "$cauthz")"
  set_gateway() { curl -s -o /dev/null -b "$JAR" -X PUT -H 'content-type: application/json' -d "{\"enabled\":$1}" "$API/api/credentials/claude-gateway"; }
  set_gateway false
  sleep 15 # the backend's allow TTL (ALLOW_TTL_MS)
  check "turning the gateway off refuses box-1's calls once its cached allow expires (15 s)" \
    "403 Claude through the termag gateway is turned off on the Credentials page" \
    "$(gwc -o "$WORK/off.json" -H "$(gw_tok box-1)") $(jq -r .message "$WORK/off.json")"
  set_gateway true
  check "and turning it back on lets it through" 200 "$(gw -H "$(gw_tok box-1)")"
  bash "$here/ctl.sh" stop backend >/dev/null
  check "with the orchestrator down the gateway fails closed, with a 5xx Claude Code retries" 5xx \
    "$(gw -H "$(gw_tok box-1)" | sed 's/^5[0-9][0-9]$/5xx/')"
  bash "$here/ctl.sh" start backend >/dev/null
  for _ in $(seq 1 60); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/health")" = 200 ] && break; sleep 0.5; done
  check "and serves again once it is back" 200 "$(gw -H "$(gw_tok box-1)")"
  check "box-2 (external) gets no gateway settings" absent \
    "$(jq -e .apiKeyHelper "$ROOT/boxes/box-2/home/.claude/settings.json" >/dev/null 2>&1 && echo present || echo absent)"

  echo "--- E2E_CLAUDE_GATEWAY GitHub broker (Envoy ext_authz -> orchestrator, caller proof -> STS stub)"
  GHF="https://localhost:$E2E_GITHUB_BROKER_PORT"
  box_tok() { jq -r .token "$ROOT/boxes/$1/home/.termag/agent.config.json"; }
  # What the box's credential helper sends: its token as the Basic password.
  box_auth() { printf 'Authorization: Basic %s' "$(printf 'termag-box:%s' "$(box_tok "$1")" | base64 -w0)"; }
  fp() { printf '%s' "$1" | sha256sum | cut -c1-8; }
  ghf() { curl -s --cacert "$ROOT/tls/ca.pem" "$@"; }
  owner=gho_e2eBrokerTestToken0123456789abcdef
  curl -s -o /dev/null -b "$JAR" -X PUT -H 'content-type: application/json' -d "{\"token\":\"$owner\"}" "$API/api/credentials/github"
  check "the broker front answers its health check without a token" ok "$(ghf "$GHF/healthz")"
  check "box-1's token gets the owner's GitHub through Envoy" e2e-octocat \
    "$(ghf -H "$(box_auth box-1)" "$GHF/api/v3/user" | jq -r .login)"
  check "and GitHub saw the owner's token, not the box's" "token=$(fp "$owner")" \
    "$(curl -s "$GH/_e2e/calls" | jq -r '.[-1]' | grep -o 'token=[0-9a-f]*')"
  check "no token gets 401 with a Basic challenge" "401 Basic" \
    "$(ghf -o /dev/null -D - "$GHF/api/v3/user" | tr -d '\r' | awk 'NR==1{c=$2} tolower($1)=="www-authenticate:"{print c, $2}')"
  check "box-2 (external) gets 403 with its own valid token" 403 \
    "$(ghf -o /dev/null -w '%{http_code}' -H "$(box_auth box-2)" "$GHF/api/v3/user")"
  check "the blocklist refuses minting a key" "Blocked by the termag GitHub broker: credential or admin endpoint" \
    "$(ghf -H "$(box_auth box-1)" -X POST -d '{}' "$GHF/api/v3/user/keys" | jq -r .message)"
  check "and a GraphQL key mutation, from the body Envoy forwards to the check" "Blocked by the termag GitHub broker: graphql addDeployKey" \
    "$(ghf -H "$(box_auth box-1)" -X POST -d '{"query":"mutation { addDeployKey(input:{}) { x } }"}' "$GHF/api/graphql" | jq -r .message)"
  check "GraphQL under /api/v3, which would skip the body check, gets 404 from Envoy" 404 \
    "$(ghf -o /dev/null -w '%{http_code}' -H "$(box_auth box-1)" -X POST -d '{"query":"mutation { addDeployKey(input:{}) { x } }"}' "$GHF/api/v3/graphql")"
  check "a doubled slash is merged onto the checked route, and its visibility change refused" \
    "Blocked by the termag GitHub broker: repository visibility change" \
    "$(ghf -H "$(box_auth box-1)" -X PATCH -d '{"visibility":"public"}' "$GHF/api/v3/repos/e2e-org//sample" | jq -r .message)"
  check "an encoded spelling of the repository still takes the checked route, and is refused" \
    "Blocked by the termag GitHub broker: repository visibility change" \
    "$(ghf -H "$(box_auth box-1)" -X PATCH -d '{"visibility":"public"}' "$GHF/api/v3/repos/e2e-org/sample%2F" | jq -r .message)"
  check "a path the broker does not forward gets 404 from Envoy, with no check" 404 \
    "$(ghf -o /dev/null -w '%{http_code}' "$GHF/login/oauth/access_token")"
  gitf() { GIT_SSL_CAINFO="$ROOT/tls/ca.pem" git -c credential.helper= -c "http.$GHF/.extraHeader=$(box_auth box-1)" "$@"; }
  check "git ls-remote through the broker" 40 "$(gitf ls-remote "$GHF/e2e-org/sample.git" HEAD | cut -f1 | tr -d '\n' | wc -c)"
  rm -rf "$WORK/big" && gitf clone -q "$GHF/e2e-org/sample.git" "$WORK/big" 2>/dev/null
  head -c 24000000 /dev/urandom >"$WORK/big/blob.bin"
  git -C "$WORK/big" add blob.bin && git -C "$WORK/big" -c user.email=e2e@x -c user.name=e2e commit -qm 'a 24 MB push'
  check "a 24 MB push streams through ext_authz (Envoy's buffer is 1 MiB)" 0 \
    "$(gitf -C "$WORK/big" push -q origin HEAD:refs/heads/e2e-big >/dev/null 2>&1; echo $?)"
  # The orchestrator pausing mid-check (GC, a slow query) must delay the push,
  # not fail it: with a retry_policy on the check, a 3 s pause came back as a 503.
  backend_pids="$(cat "$ROOT/pids/backend.pid") $(pgrep -P "$(cat "$ROOT/pids/backend.pid")" | tr '\n' ' ')"
  head -c 24000000 /dev/urandom >"$WORK/big/blob2.bin"
  git -C "$WORK/big" add blob2.bin && git -C "$WORK/big" -c user.email=e2e@x -c user.name=e2e commit -qm 'a push with a slow check'
  ( sleep 0.3; kill -STOP $backend_pids; sleep 3; kill -CONT $backend_pids ) & pause_pid=$!
  check "a push whose check the orchestrator answers 3 s late still goes through" 0 \
    "$(timeout 60 bash -c "$(declare -f gitf box_auth box_tok); $(declare -p GHF ROOT); gitf -C '$WORK/big' push -q origin HEAD:refs/heads/e2e-slow-check" >/dev/null 2>&1; echo $?)"
  wait "$pause_pid"
  authz="https://localhost:$E2E_CHECKS_ALB_PORT/termag/internal/github-authz/api/v3/user"
  gw_key=$(tr '\0' '\n' </proc/"$(cat "$ROOT/pids/claude-gateway.pid")"/environ | sed -n 's/^AWS_ACCESS_KEY_ID=//p')
  check "the check endpoint refuses a box calling it directly with its own token" 403 \
    "$(curl -s --cacert "$ROOT/tls/ca.pem" -o /dev/null -w '%{http_code}' -H "$(box_auth box-1)" "$authz")"
  check "and a forged caller proof, which the STS stub refuses" "403 SignatureDoesNotMatch" \
    "$(curl -s --cacert "$ROOT/tls/ca.pem" -o /dev/null -w '%{http_code}' -H "$(box_auth box-1)" \
        -H "x-termag-caller-authorization: AWS4-HMAC-SHA256 Credential=$gw_key/$(date -u +%Y%m%d)/us-east-2/sts/aws4_request, SignedHeaders=host;x-amz-date, Signature=$(printf '0%.0s' $(seq 64))" \
        -H "x-termag-caller-x-amz-date: $(date -u +%Y%m%dT%H%M%SZ)" "$authz") $(curl -s "http://127.0.0.1:$E2E_STS_PORT/_e2e/calls" | jq -r '.[-1]' | grep -o 'SignatureDoesNotMatch')"
  check "the STS stub verified the gateway's own proof" 1 \
    "$(curl -s "http://127.0.0.1:$E2E_STS_PORT/_e2e/calls" | jq -r '.[]' | grep -c -m1 "200 arn:aws:sts::000000000000:assumed-role/termag-claude-gateway-task/")"
  curl -s -o /dev/null -b "$JAR" -X DELETE "$API/api/credentials/github"
  check "after disconnect the broker refuses, and says why" "Connect GitHub on the termag Credentials page first" \
    "$(ghf -H "$(box_auth box-1)" "$GHF/api/v3/user" | jq -r .message)"
fi

if [ -n "${E2E_FAKE_MCP:-}" ]; then
  echo "--- E2E_FAKE_MCP (connector -> delivery -> box's Claude Code entry -> Envoy ext_authz -> MCP server)"
  MCPU="https://localhost:$E2E_MCP_PORT"
  mcpc() { curl -s --cacert "$ROOT/tls/ca.pem" "$@"; }
  conn=$(curl -s -b "$JAR" -H 'content-type: application/json' "$API/api/mcp-connectors" \
    -d "{\"name\":\"stub\",\"upstream\":\"$MCPU/mcp\",\"auth\":{\"type\":\"static\",\"headers\":{\"authorization\":\"Bearer {{secret.token}}\"}},\"secrets\":{\"token\":\"e2e-mcp-secret\"}}")
  cid=$(jq -r .id <<<"$conn")
  check "a static connector is created, with its broker URL" "https://localhost:$E2E_MCP_BROKER_PORT/c/$cid" "$(jq -r .brokerUrl <<<"$conn")"
  check "a loopback, IP or non-443 upstream is refused" "400 400 400" \
    "$(for u in https://127.0.0.2/mcp https://localhost:1/mcp https://10.0.0.1/mcp; do curl -s -o /dev/null -w '%{http_code} ' -b "$JAR" -H 'content-type: application/json' "$API/api/mcp-connectors" \
         -d "{\"name\":\"x\",\"upstream\":\"$u\",\"auth\":{\"type\":\"static\",\"headers\":{\"a\":\"b\"}}}"; done | sed 's/ $//')"
  cj="$ROOT/boxes/box-1/home/.claude.json"
  for _ in $(seq 1 40); do [ "$(jq -r '.mcpServers.stub.url // empty' "$cj" 2>/dev/null)" ] && break; sleep 0.25; done
  check "box-1 (ec2) gets a Claude Code entry pointed at the broker" "http https://localhost:$E2E_MCP_BROKER_PORT/c/$cid" \
    "$(jq -r '.mcpServers.stub | "\(.type) \(.url)"' "$cj" 2>&1)"
  check "and no box file holds the connector's secret" "" "$(grep -rlF e2e-mcp-secret "$ROOT/boxes" 2>/dev/null)"
  hdrs=$(inbox box-1 "$(jq -r .mcpServers.stub.headersHelper "$cj")")
  check "its headersHelper prints the box token as a bearer" "Bearer $(box_tok box-1)" "$(jq -r .Authorization <<<"$hdrs")"
  BU=$(jq -r .mcpServers.stub.url "$cj")
  rpc() { mcpc -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' "$@"; }
  init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}'
  check "initialize through the broker with the box token" e2e-mcp-upstream \
    "$(rpc -H "Authorization: Bearer $(box_tok box-1)" -d "$init" "$BU" | jq -r .result.serverInfo.name)"
  t0=$(date +%s%N)
  first=$(rpc -N -H "Authorization: Bearer $(box_tok box-1)" -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"slow","arguments":{}}}' "$BU" \
    | while IFS= read -r l; do case $l in data:*) echo "$(( ($(date +%s%N) - t0) / 1000000 ))"; break ;; esac; done)
  check "a streamed tool call's first event arrives before the result is ready" yes "$([ "${first:-9999}" -lt 1000 ] && echo yes || echo "no (${first}ms)")"
  check "the server saw the connector's credential and never a box token" "true false" \
    "$(mcpc "$MCPU/_e2e/calls" | jq -r '[.[] | .authed] | all | tostring' ) $(mcpc "$MCPU/_e2e/calls" | jq -r '[.[] | .boxToken] | any | tostring')"
  n=$(mcpc "$MCPU/_e2e/calls" | jq length)
  check "box-2 (external), no token and an unknown connector are refused before the server" "403 403 404 $n" \
    "$(rpc -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(box_tok box-2)" -d "$init" "$BU") $(rpc -o /dev/null -w '%{http_code}' -d "$init" "$BU") $(rpc -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(box_tok box-1)" -d "$init" "https://localhost:$E2E_MCP_BROKER_PORT/c/nosuchconnector") $(mcpc "$MCPU/_e2e/calls" | jq length)"
  check "OAuth metadata is never served to a box" "404 $n" \
    "$(rpc -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(box_tok box-1)" "https://localhost:$E2E_MCP_BROKER_PORT/.well-known/oauth-protected-resource/c/$cid") $(mcpc "$MCPU/_e2e/calls" | jq length)"
  mcpc -o /dev/null -d 'authorization=Bearer rotated' "$MCPU/_e2e/require"
  rpc -D "$WORK/mcp401.h" -o "$WORK/mcp401.b" -H "Authorization: Bearer $(box_tok box-1)" -d "$init" "$BU"
  check "an upstream 401 reaches the box without WWW-Authenticate, naming the Settings link" "no yes" \
    "$(grep -qi '^www-authenticate' "$WORK/mcp401.h" && echo yes || echo no) $(jq -r .error.message "$WORK/mcp401.b" | grep -q "settings/mcp?server=$cid" && echo yes || echo no)"
  mcpc -o /dev/null -d 'authorization=Bearer e2e-mcp-secret' "$MCPU/_e2e/require"
  curl -s -o /dev/null -b "$JAR" -X PATCH -H 'content-type: application/json' -d '{"secrets":{"token":null}}' "$API/api/mcp-connectors/$cid"
  check "with its secret unset the broker refuses, and says which" '403 MCP server "stub": secret "token" is not set. Set it on the termag Settings page' \
    "$(rpc -o "$WORK/mcp403.b" -w '%{http_code}' -H "Authorization: Bearer $(box_tok box-1)" -d "$init" "$BU") $(jq -r .message "$WORK/mcp403.b")"
  curl -s -o /dev/null -b "$JAR" -X DELETE "$API/api/mcp-connectors/$cid"
  for _ in $(seq 1 40); do [ -z "$(jq -r '.mcpServers.stub // empty' "$cj" 2>/dev/null)" ] && break; sleep 0.25; done
  check "deleting the connector drops box-1's entry" "" "$(jq -r '.mcpServers.stub // empty' "$cj" 2>&1)"
  for _ in $(seq 1 60); do # Envoy flushes its access log about every 10 s
    grep -q "\"connector\":\"$cid\"" "$ROOT/logs/claude-gateway.log" && break; sleep 0.5
  done
  check "Envoy's access log names the connector and holds no token or secret" "yes no" \
    "$(grep -q "\"connector\":\"$cid\"" "$ROOT/logs/claude-gateway.log" && echo yes || echo no) $(grep -qF -e e2e-mcp-secret -e "$(box_tok box-1)" "$ROOT/logs/claude-gateway.log" && echo yes || echo no)"

  echo "--- E2E_FAKE_MCP OAuth (discovery -> DCR -> authorize -> callback -> refresh rotation -> relink)"
  asctl() { mcpc -H 'content-type: application/json' -d "$1" "$MCPU/_e2e/as"; }
  # 30 s tokens are inside the refresh margin, so every broker request refreshes.
  asctl '{"ttl":30}' >/dev/null
  oac=$(curl -s -b "$JAR" -H 'content-type: application/json' "$API/api/mcp-connectors" -d "{\"name\":\"oa\",\"upstream\":\"$MCPU/mcp\",\"auth\":{\"type\":\"oauth\"}}")
  oid=$(jq -r .id <<<"$oac")
  check "an oauth connector is created unlinked, with its discovered issuer" "needs_link $MCPU/as" "$(jq -r '"\(.linkStatus) \(.oauth.issuer)"' <<<"$oac")"
  check "a server without PKCE S256 is refused at create" 400 \
    "$(asctl '{"s256":false}' >/dev/null; curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H 'content-type: application/json' "$API/api/mcp-connectors" -d "{\"name\":\"oa2\",\"upstream\":\"$MCPU/mcp\",\"auth\":{\"type\":\"oauth\"}}"; asctl '{"s256":true}' >/dev/null)"
  for _ in $(seq 1 40); do [ "$(jq -r '.mcpServers.oa.url // empty' "$cj" 2>/dev/null)" ] && break; sleep 0.25; done
  OU=$(jq -r .mcpServers.oa.url "$cj")
  check "before it is linked the broker refuses with the link message" "403 yes" \
    "$(rpc -o "$WORK/oa403.b" -w '%{http_code}' -H "Authorization: Bearer $(box_tok box-1)" -d "$init" "$OU") $(jq -r .message "$WORK/oa403.b" | grep -q "is not linked.*settings/mcp?server=$oid" && echo yes || echo no)"
  oauth_link() {
    local start loc q
    start=$(curl -s -b "$JAR" -X POST "$API/api/mcp-connectors/$oid/oauth/start" | jq -r .authorizeUrl)
    loc=$(mcpc -o /dev/null -w '%{redirect_url}' "$start")
    q=${loc#*\?}
    echo "$start" >"$WORK/oa-start"
    echo "$q" >"$WORK/oa-callback-query"
    curl -s -o /dev/null -w '%{http_code} %{redirect_url}' -b "$JAR" "$API/api/mcp-connectors/oauth/callback?$q"
  }
  linked=$(oauth_link)
  check "the authorize URL carries PKCE S256, state and the resource" "S256 yes $MCPU/mcp" \
    "$(python3 -c 'import sys,urllib.parse as u; q=dict(u.parse_qsl(u.urlsplit(open(sys.argv[1]).read().strip()).query)); print(q["code_challenge_method"], "yes" if q.get("state") else "no", q["resource"])' "$WORK/oa-start")"
  check "the callback links it and returns to Settings" "303 yes" "$(awk '{print $1}' <<<"$linked") $(grep -q "settings/mcp?server=$oid&linked=1" <<<"$linked" && echo yes || echo no)"
  check "a replayed callback is refused" yes \
    "$(curl -s -o /dev/null -w '%{redirect_url}' -b "$JAR" "$API/api/mcp-connectors/oauth/callback?$(cat "$WORK/oa-callback-query")" | grep -q 'error=' && echo yes || echo no)"
  check "a callback without the session is refused" 401 \
    "$(curl -s -o /dev/null -w '%{http_code}' "$API/api/mcp-connectors/oauth/callback?$(cat "$WORK/oa-callback-query")")"
  check "the connector reads linked" linked \
    "$(curl -s -b "$JAR" "$API/api/mcp-connectors" | jq -r --arg id "$oid" '.connectors[] | select(.id == $id) | .linkStatus')"
  n0=$(mcpc "$MCPU/_e2e/calls" | jq length)
  codes=$(for _ in 1 2 3; do rpc -o /dev/null -w '%{http_code} ' -H "Authorization: Bearer $(box_tok box-1)" -d "$init" "$OU"; done)
  par=$( (rpc -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(box_tok box-1)" -d "$init" "$OU" & rpc -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $(box_tok box-1)" -d "$init" "$OU"; wait) | sort | tr '\n' ' ')
  check "three requests and two concurrent ones go through, each refreshing once, never reusing a refresh token" "200 200 200 | 200 200 | 5 0" \
    "${codes% } | ${par% } | $(asctl '{}' | jq -r '"\(.stats.refreshes) \(.stats.reuse)"')"
  check "the server saw the OAuth token and never a box token" "true false" \
    "$(mcpc "$MCPU/_e2e/calls" | jq -r --argjson n "$n0" '[.[$n:][] | select(.path == "/mcp") | .authed] | all | tostring') $(mcpc "$MCPU/_e2e/calls" | jq -r --argjson n "$n0" '[.[$n:][] | .boxToken] | any | tostring')"
  check "unlink revokes at the server and the broker asks for a link again" "1 needs_link 403" \
    "$(curl -s -o /dev/null -b "$JAR" -X DELETE "$API/api/mcp-connectors/$oid/oauth"; asctl '{}' | jq -r .stats.revoked) $(curl -s -b "$JAR" "$API/api/mcp-connectors" | jq -r --arg id "$oid" '.connectors[] | select(.id == $id) | .linkStatus') $(rpc -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(box_tok box-1)" -d "$init" "$OU")"
  linked=$(oauth_link)
  check "re-linking registers a new client, since unlink forgot the old one, and works" "303 2 200" \
    "$(awk '{print $1}' <<<"$linked") $(asctl '{}' | jq -r .stats.registered) $(rpc -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(box_tok box-1)" -d "$init" "$OU")"
  asctl '{"revokeAll":true}' >/dev/null
  check "a refresh the server refuses turns into a link request, not a retry" "403 yes needs_link" \
    "$(rpc -o "$WORK/oa403.b" -w '%{http_code}' -H "Authorization: Bearer $(box_tok box-1)" -d "$init" "$OU") $(jq -r .message "$WORK/oa403.b" | grep -q 'is not linked' && echo yes || echo no) $(curl -s -b "$JAR" "$API/api/mcp-connectors" | jq -r --arg id "$oid" '.connectors[] | select(.id == $id) | .linkStatus')"
  r0=$(asctl '{}' | jq -r '.stats.refused | length')
  rpc -o /dev/null -H "Authorization: Bearer $(box_tok box-1)" -d "$init" "$OU"
  check "and the next request does not go to the token endpoint" "$r0" "$(asctl '{}' | jq -r '.stats.refused | length')"
  curl -s -o /dev/null -b "$JAR" -X DELETE "$API/api/mcp-connectors/$oid"
  for _ in $(seq 1 40); do [ -z "$(jq -r '.mcpServers.oa // empty' "$cj" 2>/dev/null)" ] && break; sleep 0.25; done
  check "deleting it drops box-1's entry" "" "$(jq -r '.mcpServers.oa // empty' "$cj" 2>&1)"
  check "no OAuth token or code reaches a box, the backend log or Envoy's log" "" \
    "$(grep -rlE '\b(at|rt|code)-[A-Za-z0-9_-]{24}\b' "$ROOT/boxes" "$ROOT/logs/backend.log" "$ROOT/logs/claude-gateway.log" 2>/dev/null)"
fi

echo "--- E2E_SSHD"
ssh-keygen -q -t ed25519 -N '' -f "$WORK/id"
sshc() { ssh -i "$WORK/id" -p "$1" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$U@127.0.0.1" "${@:2}"; }
sshc $((E2E_SSH_PORT_BASE + 1)) true 2>/dev/null
check "box-1 sshd refuses a key that isn't authorized" 255 "$?"
cat "$WORK/id.pub" >>"$ROOT/boxes/box-1/home/.ssh/authorized_keys"
# shellcheck disable=SC2016
check "an authorized key lands in box-1's home" "$ROOT/boxes/box-1/home" "$(sshc $((E2E_SSH_PORT_BASE + 1)) 'echo $HOME')"
check "and sees box-1's tmux server" "$U-sample-agent $U-sample-ctrl" \
  "$(sshc $((E2E_SSH_PORT_BASE + 1)) 'tmux ls -F "#S"' | sort | tr '\n' ' ' | sed 's/ $//')"
sshc $((E2E_SSH_PORT_BASE + 2)) true 2>/dev/null
check "box-2 sshd uses box-2's authorized_keys" 255 "$?"

echo "--- E2E_TMUX_FAULTS and ctl.sh"
bash "$here/ctl.sh" fault box-1 hang >/dev/null
timeout 3 "$T1" capture-pane -p -t "$U-sample-ctrl" >/dev/null
check "fault hang wedges capture-pane" 124 "$?"
bash "$here/ctl.sh" fault box-1 attach-delay=2 >/dev/null
s=$(date +%s%N); "$T1" set-option -g set-clipboard on; ms=$(( ($(date +%s%N) - s) / 1000000 ))
check "fault attach-delay=2 delays the pre-attach set-option" yes "$([ "$ms" -ge 1900 ] && echo yes || echo "no (${ms}ms)")"
bash "$here/ctl.sh" fault box-1 off >/dev/null
timeout 3 "$T1" capture-pane -p -t "$U-sample-ctrl" >/dev/null
check "fault off restores tmux" 0 "$?"
check "e2e-status shows box-1's agent fds" 1 "$(bash "$here/status.sh" | grep -c '^box-1 .*fds [0-9]')"
before=$(grep -c 'Connected to termag' "$ROOT/logs/box-1.log")
bash "$here/ctl.sh" restart box-1 >/dev/null
after=$before
for _ in $(seq 1 40); do after=$(grep -c 'Connected to termag' "$ROOT/logs/box-1.log"); [ "$after" -gt "$before" ] && break; sleep 0.25; done
check "ctl.sh restart box-1 reconnects the agent" $((before + 1)) "$after"
check "box-1's tmux sessions survive an agent restart" "$U-sample-agent $U-sample-ctrl" \
  "$("$T1" ls -F '#S' | sort | tr '\n' ' ' | sed 's/ $//')"
check "box agents get their own system gitconfig and profile.d" "$ROOT/boxes/box-1/etc/gitconfig $ROOT/boxes/box-1/etc/profile.d" \
  "$(tr '\0' '\n' </proc/"$(cat "$ROOT/pids/box-1.pid")"/environ | sed -n 's/^GIT_CONFIG_SYSTEM=//p; s/^TERMAG_PROFILE_D=//p' | tr '\n' ' ' | sed 's/ $//')"
check "box agents get their own managed-settings path and no sudo" "$ROOT/boxes/box-1/etc/claude-code/managed-settings.json|" \
  "$(tr '\0' '\n' </proc/"$(cat "$ROOT/pids/box-1.pid")"/environ | sed -n 's/^TERMAG_CLAUDE_MANAGED_SETTINGS=//p; s/^TERMAG_CREDENTIALS_SUDO=\(.*\)/|\1/p' | tr -d '\n')"

echo "--- E2E_TLS no transport check (a TLS header means nothing; the checks only via the checks ALB)"
check "the backend env has no agent-TLS secret or listener" "|" \
  "$(sed -n 's/^AGENT_TLS_PROXY_SECRET=//p' "$ROOT/backend.env")|$(sed -n 's/^AGENT_TLS_LISTEN=//p' "$ROOT/backend.env")"
probe() { node "$here/fakes/agent-probe.cjs" "$repo/backend/node_modules/ws" "$@" 2>&1; }
b1tok=$(jq -r .token "$ROOT/boxes/box-1/home/.termag/agent.config.json")
# Delivery doesn't depend on how an agent connected, so a header claiming TLS
# changes nothing: a probe with forged ones gets exactly the first step a plain
# one does, on the loopback port, through :3040 and over TLS (the ALB's stand-in).
plain=$(probe "ws://127.0.0.1:$E2E_PORT/termag/ws/agent" "$b1tok" -)
check "a ws:// agent on the loopback port gets its delivery, not a refusal" "credentials-" "$(printf '%s' "$plain" | cut -c1-12)"
check "a forged X-Termag-Agent-Tls and X-Forwarded-Proto change nothing" "$plain" \
  "$(probe "ws://127.0.0.1:$E2E_PORT/termag/ws/agent" "$b1tok" - "x-termag-agent-tls=$(printf 'a%.0s' $(seq 64))" x-forwarded-proto=https forwarded=proto=https)"
check "and the plain :3040 gateway and the TLS listener give the same" "$plain|$plain" \
  "$(probe "ws://127.0.0.1:$E2E_GATEWAY_PORT/termag/ws/agent" "$b1tok" -)|$(probe "wss://localhost:$E2E_TLS_PORT/termag/ws/agent" "$b1tok" "$ROOT/tls/ca.pem")"

echo "--- agent token in the Authorization header, not the URL"
check "the box agents dial with no token in the URL" 0 \
  "$(grep -h 'GET /termag/ws/agent' "$ROOT/logs/nginx-alb-access.log" | grep -c 'token=')"
check "an old-style agent (?token=) still connects through :3040" "$plain" \
  "$(AGENT_PROBE_TOKEN_IN=query probe "ws://127.0.0.1:$E2E_GATEWAY_PORT/termag/ws/agent" "$b1tok" -)"
check "the backend logs the query form, without the token" 1 \
  "$(grep -c '\[AGENT-WS\] agent for instance .* sent its token in the query string' "$ROOT/logs/backend.log")"
check "the gateway logs both forms by path, token=header and token=query" "yes yes" \
  "$(grep -q '"GET /termag/ws/agent HTTP/1.1" 101 .* token=header$' "$ROOT/logs/nginx-access.log" && echo yes || echo no) $(grep -q '"GET /termag/ws/agent HTTP/1.1" 101 .* token=query$' "$ROOT/logs/nginx-access.log" && echo yes || echo no)"
check "no backend, gateway, box or agent log holds a box token" "" \
  "$(for t in "$b1tok" "$(jq -r .token "$ROOT/boxes/box-2/home/.termag/agent.config.json")"; do grep -l -F -- "$t" "$ROOT"/logs/*.log; done)"
printf 'AGENT_WS_QUERY_TOKEN=false\nADMIN_USERS=%s\n' "$(curl -s -b "$JAR" "$API/auth/me" | jq -r .email)" >>"$ROOT/backend.env"
connects() { cat "$ROOT"/logs/box-1.log "$ROOT"/logs/box-2.log | grep -c 'Connected to termag'; }
connects_before=$(connects)
bash "$here/ctl.sh" restart backend >/dev/null
for _ in $(seq 1 60); do curl -s -o /dev/null "$API/health" && break; sleep 0.5; done
check "with AGENT_WS_QUERY_TOKEN=false the query form is refused" "closed 1008 token query parameter not accepted; send Authorization: Bearer" \
  "$(AGENT_PROBE_TOKEN_IN=query probe "ws://127.0.0.1:$E2E_GATEWAY_PORT/termag/ws/agent" "$b1tok" -)"
check "and the header form is not" "$plain" "$(probe "ws://127.0.0.1:$E2E_GATEWAY_PORT/termag/ws/agent" "$b1tok" -)"
for _ in $(seq 1 60); do [ "$(connects)" -ge $((connects_before + 2)) ] && break; sleep 0.5; done
check "both box agents reconnect with the query form refused" $((connects_before + 2)) "$(connects)"
check "the admin System page shows the switch, the refusal and no query-form agent left" "false 1 0 yes" \
  "$(curl -s -b "$JAR" "$API/api/admin/system" | jq -r '.agents.tokenForms | "\(.queryAccepted) \(.sinceStart.refusedQuery) \(.queryFormConnected | length) \(if .sinceStart.header >= 3 then "yes" else .sinceStart.header end)"')"
sed -i '/^AGENT_WS_QUERY_TOKEN=/d; /^ADMIN_USERS=/d' "$ROOT/backend.env"
bash "$here/ctl.sh" stop backend >/dev/null
node -e 'require("http").createServer((q, s) => s.end(`backend ${q.url}`)).listen(+process.argv[1], "127.0.0.1")' "$E2E_PORT" & echo_pid=$!
for _ in $(seq 1 40); do curl -s -o /dev/null "$API/health" && break; sleep 0.25; done
checks_get() { curl -s --cacert "$ROOT/tls/ca.pem" "https://localhost:$E2E_CHECKS_ALB_PORT$1"; }
check "the checks ALB forwards the gateway's GitHub broker check to the backend, through :3041" \
  "backend /termag/internal/github-authz/o/r.git/info/refs?service=git-upload-pack" \
  "$(checks_get '/termag/internal/github-authz/o/r.git/info/refs?service=git-upload-pack')"
check "and the Claude check" "backend /termag/internal/claude-authz/model/x/invoke" \
  "$(checks_get '/termag/internal/claude-authz/model/x/invoke')"
check "the checks ALB answers anything else with its fixed 404" "404 404" \
  "$(for pth in /termag/health /termag/api/projects; do curl -s --cacert "$ROOT/tls/ca.pem" -o /dev/null -w '%{http_code} ' "https://localhost:$E2E_CHECKS_ALB_PORT$pth"; done | sed 's/ $//')"
check "the :3041 listener serves its health check and the checks only" "200 404 404" \
  "$(for pth in /healthz /termag/health /termag/internal/other; do curl -s -o "$WORK/c.out" -w '%{http_code}' "http://127.0.0.1:$E2E_CHECKS_PORT$pth"
       grep -q '^backend ' "$WORK/c.out" && printf '(reached)'; printf ' '; done | sed 's/ $//')"
check "the plain :3040 gateway answers /termag/internal/ with 404 and never reaches the backend" "404 404" \
  "$(for c in github-authz/api/v3/user claude-authz/model/x/invoke; do
       curl -s -o "$WORK/internal.out" -w '%{http_code}' "http://127.0.0.1:$E2E_GATEWAY_PORT/termag/internal/$c"
       grep -q '^backend ' "$WORK/internal.out" && printf '(reached)'; printf ' '; done | sed 's/ $//')"
check "and so does the boxes' TLS front (the ALB lands on :3040)" 404 \
  "$(curl -s --cacert "$ROOT/tls/ca.pem" -o /dev/null -w '%{http_code}' "https://localhost:$E2E_TLS_PORT/termag/internal/claude-authz/model/x/invoke")"
check "and no longer serves GitHub paths itself" 404 \
  "$(curl -s --cacert "$ROOT/tls/ca.pem" -o /dev/null -w '%{http_code}' "https://localhost:$E2E_TLS_PORT/api/v3/user")"
check "without E2E_BROKER_443 the backend gets no GitHub broker URL" "" \
  "$(sed -n 's/^GITHUB_BROKER_URL=//p' "$ROOT/backend.env")"
kill "$echo_pid"; wait "$echo_pid" 2>/dev/null
bash "$here/ctl.sh" start backend >/dev/null
code=
for _ in $(seq 1 60); do code=$(curl -s -o /dev/null -w '%{http_code}' "$API/health"); [ "$code" = 200 ] && break; sleep 0.5; done
check "ctl.sh start backend comes back" 200 "$code"

echo "--- teardown"
bash "$here/down.sh" >"$WORK/down.log" 2>&1
check "down.sh exit" 0 "$?"
check "no stack processes left" "" "$(e2e_pids "$ROOT" | tr '\n' ' ')"
for p in "$E2E_PORT" $((E2E_PORT + 1)) "$E2E_FRONTEND_PORT" "$E2E_PG_PORT" "$E2E_AWS_PORT" "$E2E_EC2_PORT" "$E2E_GITHUB_PORT" "$E2E_TLS_PORT" \
         "$E2E_GATEWAY_PORT" "$E2E_CHECKS_PORT" "$E2E_CHECKS_ALB_PORT" $((E2E_SSH_PORT_BASE + 1)) $((E2E_SSH_PORT_BASE + 2)); do
  check "port $p released" closed "$( (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null && echo open || echo closed)"
done
leaked=$(e2e_leaks "$WORK/.started" "$WORK")
check "no files written outside the temp root" "" "$leaked"

echo
if [ "$failures" -eq 0 ]; then echo "all fake checks passed"; else echo "$failures fake check(s) failed"; fi
[ "$failures" -eq 0 ]
