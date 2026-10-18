#!/usr/bin/env bash
# A box for the ask: box-1's agent makes a box with
# the CLI on its own credentials, starts a project there from box-1/sample's
# repository, and asks it. The run is the real termag-subagent-run with a
# stub systemd-run and claude, so this covers, against a real stack:
#
#   * project create --new-box --from <box>/<project> on a box credential: the
#     repository comes from the project's checkout origin, the new box records
#     box-1 as its parent, box set takes the lifecycle defaults;
#   * an ask refused while the project clones, and one to the stopped box held
#     until the orchestrator has started it;
#   * the ask runs in the same sandbox as on any box (the run's settings, the
#     systemd-run network cut) and a follow-up resumes it;
#   * only the parent box's credentials may remove the box.
#
# Runs on its own ports and TMPDIR, so it can run beside a stack that is up.
#
# Run: bash scripts/e2e/ask-box.test.sh   (or make e2e-test-ask-box)
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-4110} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-6136} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55609} \
  E2E_AWS_PORT=${E2E_TEST_AWS_PORT:-4766} E2E_EC2_PORT=${E2E_TEST_EC2_PORT:-4767} E2E_GITHUB_PORT=${E2E_TEST_GITHUB_PORT:-4780} \
  E2E_BOXES=1 E2E_FAKE_AWS=1 E2E_EC2_LAUNCH=1 E2E_FAKE_GITHUB=1
trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

fails=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }
yes_if() { if "$@"; then echo yes; else echo no; fi; }

if [ ! -x "$repo/cli/node_modules/.bin/tsc" ]; then
  (cd "$repo/cli" && npm ci --no-audit --no-fund >"$WORK/cli-install.log" 2>&1) || { cat "$WORK/cli-install.log"; echo "FAIL: cli npm ci"; exit 1; }
fi
(cd "$repo/cli" && npm run build >"$WORK/cli-build.log" 2>&1) || { cat "$WORK/cli-build.log"; echo "FAIL: cli build"; exit 1; }
pass "cli builds"

# A Claude gateway, as production has, so a box's connect delivers its
# gateway settings rather than removing them. Nothing here calls it: the
# claude below is a stub.
cat >"$WORK/backend.env" <<'ENV'
CLAUDE_GATEWAY_URL=https://127.0.0.1:9/bedrock
CLAUDE_BEDROCK_REGION=us-east-1
CLAUDE_BEDROCK_MODELS=opus=e2e-opus,sonnet=e2e-sonnet,haiku=e2e-haiku
ENV
export E2E_BACKEND_ENV=$WORK/backend.env

if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"; echo "FAIL: up.sh"; exit 1
fi
pass "up.sh brought the stack up"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
PSQL=(psql -tA "postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag")
BOX1_HOME=$ROOT/boxes/box-1/home
ASK_HOME=$ROOT/boxes/askbox/home
on_box1() { HOME="$BOX1_HOME" timeout 400 node "$repo/cli/bin/termag.js" "$@"; }
on_askbox() { HOME="$ASK_HOME" timeout 60 node "$repo/cli/bin/termag.js" "$@"; }
box_status() { "${PSQL[@]}" -c "select status from instances where name = '$1' order by \"createdAt\" desc limit 1"; }
wait_status() { # <box> <status>: up to 90 s, for the 10 s power sweep
  for _ in $(seq 1 90); do [ "$(box_status "$1")" = "$2" ] && break; sleep 1; done
  box_status "$1"
}
setup_status() { "${PSQL[@]}" -c "select p.\"setupStatus\" from projects p join instances i on i.id = p.\"instanceId\" where i.name = 'askbox' and p.name = 'sample' and not p.archived"; }

# box-1/sample is a checkout of e2e-org/sample (public on the stub, so the
# new box's clone needs no GitHub credential). Its origin is the ssh form: the
# stub's insteadOf rewrites only https://github.com/, and `git remote get-url`
# expands it.
touch "$ROOT/github/e2e-org/sample.git/termag-e2e-public"
SAMPLE_DIR=$(find "$BOX1_HOME" -maxdepth 4 -type d -path '*/projects/sample' -print -quit)
check "box-1 has the seeded sample checkout" yes "$(yes_if test -d "$SAMPLE_DIR/.git")"
git -C "$SAMPLE_DIR" remote add origin git@github.com:e2e-org/sample.git 2>/dev/null \
  || git -C "$SAMPLE_DIR" remote set-url origin git@github.com:e2e-org/sample.git

echo "--- box-1 makes a box for the ask with its own credentials"
on_box1 project create askbox/sample --new-box --from box-1/sample --agent claude --if-not-exists --timeout 300 --json \
  >"$WORK/create.json" 2>"$WORK/create.err"
rc=$?
check "project create --new-box --from box-1/sample exits 0" 0 "$rc"
[ "$rc" = 0 ] || sed 's/^/      /' "$WORK/create.err"
check "it made the box and the project from box-1/sample's repository" "true running askbox/sample https://github.com/e2e-org/sample" \
  "$(jq -r '"\(.boxCreated) \(.box.state) \(.project.ref) \(.repoUrl)"' "$WORK/create.json" 2>/dev/null)"
check "the new box records box-1 as its parent" box-1 \
  "$("${PSQL[@]}" -c "select p.name from instances c join instances p on p.id = c.\"parentInstanceId\" where c.name = 'askbox' and c.status <> 'terminated'")"
check "box-1 itself has no parent" "" "$("${PSQL[@]}" -c "select coalesce(\"parentInstanceId\", '') from instances where name = 'box-1'")"

on_box1 box set askbox --auto-park 1h --terminate-after 1d >/dev/null 2>&1 || on_box1 box set askbox --auto-park 1h >"$WORK/set.out" 2>&1
check "box set takes the lifecycle defaults (falling back to --auto-park alone)" 1 \
  "$("${PSQL[@]}" -c "select \"idleHibernateHours\" from instances where name = 'askbox' and status <> 'terminated'")"

for _ in $(seq 1 120); do case $(setup_status) in ready|none|failed) break ;; esac; sleep 1; done
# A stand-in box clones in the pane (setupStatus none); a box image's agent clones durably (ready).
check "the project's clone finished" yes "$(case $(setup_status) in ready|none) echo yes ;; *) setup_status ;; esac)"

# The runner a box image carries. A stand-in box has no root, so the sandbox's
# sudo and setup are no-ops and systemd-run is a stub that records its
# arguments and runs the command as this user; claude is a stub that reports
# where and with which settings it ran.
SUB_ROOT=$ASK_HOME/subagent-root
mkdir -p "$ASK_HOME/.local/bin" "$ASK_HOME/.local/lib/termag" "$ASK_HOME/.config/termag" "$SUB_ROOT/bin"
install -m 0755 "$repo/deploy/termag-subagent-run" "$ASK_HOME/.local/lib/termag/termag-subagent-run"
install -m 0755 "$repo/deploy/termag-subagent-exec" "$SUB_ROOT/bin/termag-subagent-exec"
cat >"$SUB_ROOT/bin/termag-subagent-token" <<'EOF'
#!/bin/sh
exec cat "$CREDENTIALS_DIRECTORY/token"
EOF
cat >"$SUB_ROOT/bin/systemd-run" <<'EOF'
#!/bin/sh
echo "systemd-run $*" >>"$TERMAG_E2E_SUB_ROOT/systemd-run.log"
envs=""; wd=.; cmd=""
for a in "$@"; do
  case $a in
    --setenv=*) envs="$envs
${a#--setenv=}" ;;
    --working-directory=*) wd=${a#--working-directory=} ;;
    LoadCredential=token:*) mkdir -p "$TERMAG_E2E_SUB_ROOT/creds"; cp "${a#LoadCredential=token:}" "$TERMAG_E2E_SUB_ROOT/creds/token" ;;
    -*|*=*) ;;
    *) cmd=$a ;;
  esac
done
cd "$wd" || exit 1
printf '%s\n' "$envs" | sed '/^$/d' >"$TERMAG_E2E_SUB_ROOT/run-env"
set --
while IFS= read -r kv; do set -- "$@" "$kv"; done <"$TERMAG_E2E_SUB_ROOT/run-env"
exec env -i CREDENTIALS_DIRECTORY="$TERMAG_E2E_SUB_ROOT/creds" "$@" "$cmd"
EOF
cat >"$SUB_ROOT/bin/claude" <<'EOF'
#!/usr/bin/env bash
settings= resume=
while [ $# -gt 0 ]; do
  case $1 in --settings) settings=$2; shift ;; --resume) resume=$2; shift ;; esac
  shift
done
prompt=$(cat)
case $PWD in "$TERMAG_THREAD_DIR"/repo) where=thread ;; *) where="$PWD" ;; esac
reply="sandbox-run prompt=[$prompt] where=$where readme=[$(head -n1 README.md 2>/dev/null)] bash=$(jq -c '.permissions.allow | index("Bash") != null' "$settings") curl-denied=$(jq -c '.permissions.deny | index("Bash(curl:*)") != null' "$settings") helper=$(jq -r .apiKeyHelper "$settings" | xargs basename) resume=${resume:-none}"
jq -n --arg r "$reply" '{result: $r, session_id: "sess-e2e", num_turns: 1, is_error: false}'
EOF
cat >"$ASK_HOME/.local/bin/termag-subagent-run" <<EOF
#!/bin/sh
export TERMAG_E2E_SUB_ROOT='$SUB_ROOT' TERMAG_SUBAGENT_ROOT='$SUB_ROOT' TERMAG_SUBAGENT_USER="\$(id -un)" \\
  TERMAG_SUBAGENT_SUDO='' TERMAG_SUBAGENT_SYSTEMD_RUN='$SUB_ROOT/bin/systemd-run' TERMAG_SUBAGENT_SETUP=true \\
  TERMAG_SUBAGENT_ALLOW=localhost
exec '$ASK_HOME/.local/lib/termag/termag-subagent-run' "\$@"
EOF
chmod +x "$SUB_ROOT/bin/"* "$ASK_HOME/.local/bin/termag-subagent-run"

echo "--- asks the box can't take yet"

# Stopping and starting the box restarts its agent, which then sees the runner.
check "box stop on the parent's credentials" stopping "$(on_box1 box stop askbox --json | jq -r .box.state)"
check "the box settles to stopped" stopped "$(wait_status askbox stopped)"
# An ask to it is held and the orchestrator starts the box itself; the CLI
# leaves at once (--no-wait), as one that died would. The run is sent only
# once the connect's credential delivery has finished, so it finds the
# gateway settings (removed here first, as on a box whose gateway was off
# while it was parked) and completes; with nobody polling, its reply is dropped.
HOME="$ASK_HOME" TERMAG_CREDENTIALS_SUDO='' TERMAG_CLAUDE_MANAGED_SETTINGS="$ROOT/boxes/askbox/etc/claude-code/managed-settings.json" \
  bash "$repo/deploy/termag-credentials" remove claude-gateway </dev/null >/dev/null 2>&1
check "the stopped box has no gateway settings" no "$(yes_if test -s "$ASK_HOME/.config/termag/claude-gateway.json")"
on_box1 ask askbox/sample "while stopped" --no-wait --json >"$WORK/stopped.json" 2>"$WORK/stopped.err"
check "an ask to the stopped box is held" "0 TASK_STATE_SUBMITTED" "$? $(jq -r .status.state "$WORK/stopped.json" 2>/dev/null)"
queued_id=$(jq -r .id "$WORK/stopped.json" 2>/dev/null)
check "its prompt waits in the row" yes "$(yes_if test -n "$("${PSQL[@]}" -c "select 1 from agent_messages where id = '$queued_id' and \"queuedPrompt\" is not null")")"
check "the orchestrator starts the box for it" ready "$(wait_status askbox ready)"
sent=
for _ in $(seq 1 60); do
  sent=$("${PSQL[@]}" -c "select status from agent_messages where id = '$queued_id' and \"queuedPrompt\" is null and status <> 'submitted'")
  [ -n "$sent" ] && break; sleep 1
done
check "the held ask left the queue once the agent connected" yes "$(case $sent in working|completed|failed) echo yes ;; *) echo "${sent:-still submitted}" ;; esac)"
check "it was sent to the box" yes "$(yes_if grep -qE "message $queued_id hop [0-9]+, prompt [0-9]+B$" "$ROOT/logs/backend.log")"
done_status=
for _ in $(seq 1 60); do
  done_status=$("${PSQL[@]}" -c "select status from agent_messages where id = '$queued_id' and status in ('completed', 'failed', 'canceled')")
  [ -n "$done_status" ] && break; sleep 1
done
check "the held run completed" completed "$done_status"
if [ "$done_status" != completed ]; then
  "${PSQL[@]}" -c "select error from agent_messages where id = '$queued_id'" | sed 's/^/      /'
  grep -h 'CRED\|credential' "$ROOT/logs/backend.log" "$ROOT/logs/askbox.log" 2>/dev/null | tail -n 20 | sed 's/^/      /'
fi
check "its prompt is gone from the row" "" "$("${PSQL[@]}" -c "select 1 from agent_messages where id = '$queued_id' and (\"queuedPrompt\" is not null or \"queuedUntil\" is not null)")"
check "box start --wait on a running box" running "$(on_box1 box start askbox --wait --timeout 300 --json 2>/dev/null | jq -r .box.state)"

echo "--- the ask runs on the box in the sandbox"
askable=
for _ in $(seq 1 60); do
  askable=$(on_box1 ask --targets --json 2>/dev/null \
    | jq -r '.agents[] | select(.name == "askbox/sample") | .capabilities.extensions[]? | select(.uri == "urn:termag:ask:v1") | .params.askable' 2>/dev/null)
  [ "$askable" = true ] && break; sleep 0.5
done
check "askbox/sample is askable" true "$askable"

set_setup() { "${PSQL[@]}" -c "update projects set \"setupStatus\" = '$1' where name = 'sample' and \"instanceId\" = (select id from instances where name = 'askbox' and status <> 'terminated')" >/dev/null; }
before=$(setup_status)
set_setup cloning
on_box1 ask askbox/sample "too early" >"$WORK/cloning.out" 2>&1
check "an ask while the project clones is rejected" "1 yes" "$? $(yes_if grep -q 'still being set up' "$WORK/cloning.out")"
set_setup "$before"

# The orchestrator delivered the gateway's settings when the agent connected;
# replace them with a stand-in helper the stub claude can name.
sleep 2
printf '#!/bin/sh\necho e2e-gateway-key\n' >"$ASK_HOME/.config/termag/api-key-helper"; chmod +x "$ASK_HOME/.config/termag/api-key-helper"
jq -n --arg h "$ASK_HOME/.config/termag/api-key-helper" '{apiKeyHelper: $h, env: {ANTHROPIC_BASE_URL: "http://127.0.0.1:9/gateway"}}' \
  >"$ASK_HOME/.config/termag/claude-gateway.json"

on_box1 ask askbox/sample "say hi" --timeout 120 >"$WORK/ask.out" 2>"$WORK/ask.err"
check "the ask exits 0" 0 $?
check "the reply came from a sandbox run in the thread's clone" yes \
  "$(yes_if grep -qF 'sandbox-run prompt=[say hi] where=thread readme=[# e2e-org/sample] bash=false curl-denied=true helper=termag-subagent-token resume=none' "$WORK/ask.out")"
thread=$(sed -nE 's/^thread: ([a-z0-9]+).*/\1/p' "$WORK/ask.out" | head -n1)
check "the reply names its thread" yes "$(yes_if test -n "$thread")"
check "the thread's clone is in the sandbox root" yes "$(yes_if test -d "$SUB_ROOT/threads/$thread/repo")"
check "the run went through systemd-run with the network cut" yes \
  "$(yes_if grep -q 'IPAddressDeny=any .*IPAddressAllow=localhost' "$SUB_ROOT/systemd-run.log")"

on_box1 ask askbox/sample "again" --thread "$thread" --timeout 120 >"$WORK/again.out" 2>"$WORK/again.err"
check "a follow-up exits 0" 0 $?
check "the follow-up resumed the session in the same clone" yes "$(yes_if grep -qF 'prompt=[again] where=thread' "$WORK/again.out" && grep -qF 'resume=sess-e2e' "$WORK/again.out")"

echo "--- only the parent removes the box"
on_askbox box rm box-1 --yes >"$WORK/rm-other.out" 2>&1
check "the box's own credentials can't remove box-1" "1 yes" "$? $(yes_if grep -q 'only terminate a box they created' "$WORK/rm-other.out")"
on_askbox box rm askbox --yes >"$WORK/rm-self.out" 2>&1
check "nor the box itself" "1 yes" "$? $(yes_if grep -q 'only terminate a box they created' "$WORK/rm-self.out")"
check "box-1 removes the box it made" 1 "$(on_box1 box rm askbox --yes --json | jq -r .archivedProjects)"
check "the box is terminated" terminated "$(box_status askbox)"

if [ "$fails" -gt 0 ]; then
  echo "$fails check(s) failed"
  for f in "$ASK_HOME"/.termag/subagent/logs/*; do [ -f "$f" ] && { echo "--- $f"; tail -n 20 "$f"; }; done
  exit 1
fi
echo "all ask-box e2e checks passed"
