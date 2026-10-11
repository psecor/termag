#!/usr/bin/env bash
# Box teardown retry end to end on its own stack: launch a box through the EC2
# fake, terminate it, restart the backend while terminateBox is still waiting
# for EC2, and check that the provisioning sweep finishes the teardown the
# restart cut short (Instance.cleanedUpAt, the security group, the role and
# its instance profile, all checked in Floci). Runs on its own ports, TMPDIR
# and download cache, beside a stack that is already up.
#
# Run: bash scripts/e2e/box-teardown.test.sh
#   E2E_TEST_PORT_SHIFT=N        add N to every port
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_CACHE_DIR=${E2E_TEST_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/termag-e2e}
S=${E2E_TEST_PORT_SHIFT:-0}
export E2E_PORT=$((3970 + S)) E2E_FRONTEND_PORT=$((5996 + S)) E2E_PG_PORT=$((55469 + S)) E2E_BOXES=1 \
  E2E_AWS_PORT=$((4876 + S)) E2E_EC2_PORT=$((4877 + S)) \
  E2E_FAKE_AWS=1 E2E_EC2_LAUNCH=1 E2E_BACKEND_ENV=$WORK/backend-extra.env
# Seconds rather than the production 5 and 10 minutes.
RETRY_SECONDS=6
printf 'BOX_PROVISIONING_SWEEP_SECONDS=1\nBOX_TEARDOWN_RETRY_SECONDS=%s\n' "$RETRY_SECONDS" >"$E2E_BACKEND_ENV"
trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

fails=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"; echo "FAIL: up.sh with E2E_EC2_LAUNCH"; exit 1
fi
pass "up.sh brought the stack up with E2E_EC2_LAUNCH=1"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
API="http://127.0.0.1:$E2E_PORT/termag"
PG="postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag"
CTL="bash $here/ctl.sh"
JAR="$WORK/cookies"
curl -s -o /dev/null -c "$JAR" "$API/auth/login"

sql() { psql "$PG" -Atc "$1"; }
row() { sql "select $2 from instances where id = '$1'"; }
wait_for() { # wait_for SECONDS COMMAND...: until COMMAND succeeds
  local n=$(($1 * 4)); shift
  for _ in $(seq 1 "$n"); do "$@" && return 0; sleep 0.25; done
  return 1
}
# What is left of a box in Floci, through the backend's own SDK env:
# "<instance state> sg=<0|1> role=<0|1> profile=<0|1>".
aws_left() { # aws_left EC2_ID SG_ID ROLE
  (cd "$repo/backend" && node -e '
    require("dotenv").config({ path: process.argv[1] });
    const ec2 = require("@aws-sdk/client-ec2"), iam = require("@aws-sdk/client-iam");
    const [, , id, sg, role] = process.argv;
    const e = new ec2.EC2Client({}), i = new iam.IAMClient({});
    const exists = p => p.then(() => 1, err => /NotFound|NoSuchEntity/.test(err.name) ? 0 : `ERR(${err.name})`);
    (async () => {
      const state = await e.send(new ec2.DescribeInstancesCommand({ InstanceIds: [id] }))
        .then(r => r.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? "gone", () => "gone");
      const sgs = await e.send(new ec2.DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-id", Values: [sg] }] }))
        .then(r => (r.SecurityGroups ?? []).filter(g => g.GroupId === sg).length, err => `ERR(${err.name})`);
      const r = await exists(i.send(new iam.GetRoleCommand({ RoleName: role })));
      const p = await exists(i.send(new iam.GetInstanceProfileCommand({ InstanceProfileName: role })));
      console.log(`${state} sg=${sgs} role=${r} profile=${p}`);
    })();
  ' "$ROOT/backend.env" "$@")
}

echo "--- launch a box through box provisioning"
BOX=$(curl -s -b "$JAR" -H 'content-type: application/json' -d '{"name":"teardown-1"}' "$API/api/instances" | jq -r .instance.id)
[ -n "$BOX" ] && [ "$BOX" != null ] || { echo "FAIL: POST /api/instances returned no instance"; exit 1; }
is_ready() { [ "$(row "$BOX" status)" = ready ]; }
wait_for 60 is_ready
check "the box's agent connected" ready "$(row "$BOX" status)"
EC2_ID=$(row "$BOX" '"ec2InstanceId"'); SG_ID=$(row "$BOX" '"securityGroupId"'); ROLE=$(row "$BOX" '"iamRoleName"')
check "launchBox recorded the instance, SG and role" "i- sg- termag-e2e-box-$BOX" "${EC2_ID:0:2} ${SG_ID:0:3} $ROLE"
check "Floci has all of them" "running sg=1 role=1 profile=1" "$(aws_left "$EC2_ID" "$SG_ID" "$ROLE")"

echo "--- terminate, then restart the backend while teardown waits for EC2"
$CTL ec2 hold-terminate >/dev/null
check "DELETE answers ok" true \
  "$(curl -s -b "$JAR" -X DELETE -H 'content-type: application/json' -d '{"confirmed":true}' "$API/api/instances/$BOX" | jq -r .ok)"
terminate_sent() { [ -f "$ROOT/ec2/$EC2_ID.terminated" ]; }
wait_for 20 terminate_sent
check "TerminateInstances reached the fake" yes "$(terminate_sent && echo yes || echo no)"
attempted() { [ -n "$(row "$BOX" '"cleanupAttemptedAt"')" ]; }
wait_for 10 attempted
FIRST_ATTEMPT=$(row "$BOX" '"cleanupAttemptedAt"')
check "the row is terminated with a teardown started but not finished" "terminated  yes" \
  "$(row "$BOX" status) $(row "$BOX" '"cleanedUpAt"') $([ -n "$FIRST_ATTEMPT" ] && echo yes)"
sleep 2
$CTL restart backend >/dev/null
backend_up() { curl -sf -o /dev/null "http://127.0.0.1:$E2E_PORT/public/status"; }
wait_for 60 backend_up
check "the backend came back" yes "$(backend_up && echo yes || echo no)"
check "the restart left the SG, role and profile behind" "shutting-down sg=1 role=1 profile=1" "$(aws_left "$EC2_ID" "$SG_ID" "$ROLE")"
check "and the row still reads uncleaned" "" "$(row "$BOX" '"cleanedUpAt"')"

echo "--- the provisioning sweep retries the teardown"
retried() { [ "$(row "$BOX" '"cleanupAttemptedAt"')" != "$FIRST_ATTEMPT" ]; }
wait_for $((RETRY_SECONDS + 20)) retried
check "the sweep claimed the row again after BOX_TEARDOWN_RETRY_SECONDS" yes "$(retried && echo yes || echo no)"
check "the backend logged the retry" 1 "$(grep -c "\[BOX\] teardown retry $BOX" "$ROOT/logs/backend.log")"
# EC2 finishes shutting the instance down; the retry's wait sees it.
$CTL ec2 release-terminate >/dev/null
cleaned() { [ -n "$(row "$BOX" '"cleanedUpAt"')" ]; }
wait_for 40 cleaned
check "the retry stamped cleanedUpAt" yes "$(cleaned && echo yes || echo no)"
check "and nothing is left in Floci" "terminated sg=0 role=0 profile=0" "$(aws_left "$EC2_ID" "$SG_ID" "$ROLE")"
sleep $((RETRY_SECONDS + 3))
check "a cleaned row is not retried again" 1 "$(grep -c "\[BOX\] teardown retry $BOX" "$ROOT/logs/backend.log")"

if [ "$fails" -eq 0 ]; then echo "all box-teardown checks passed"; exit 0; fi
echo "$fails box-teardown check(s) failed"; exit 1
