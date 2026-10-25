#!/usr/bin/env bash
# Fetch a snapshot of the production orchestrator's database for the staging
# stack (docs/stage.md, "Production data"). Called by `stage.sh refresh`.
#
#   prod-snapshot.sh <out-file>
#
# Nothing here needs network access to the database, or IAM rights on it:
#
#   1. SSM Run Command runs pg_dump as root on the orchestrator, which already
#      holds the host role's rds-db:connect and the CA bundle. The dump leaves
#      out the rows of the tables in STAGE_PROD_EXCLUDE_DATA (their schema
#      stays). It is written 0600 under a fresh /var/tmp directory.
#   2. The same command starts a one-shot server on 127.0.0.1 there, which
#      serves the file once, only under a random path, and deletes it after
#      the transfer or after 15 minutes. The orchestrator is a shared host, so
#      the random path is what keeps other accounts on it from reading it.
#   3. This box pulls the file through an SSM port forward to that port,
#      checks its sha256 against the one the dump step reported, and asks the
#      orchestrator to clean up again, in case the server is still up.
#
# Env:
#   STAGE_PROD_PROFILE        AWS profile with ssm:SendCommand and StartSession
#                             on the orchestrator (an SSO profile; run
#                             `aws sso login --profile <it>` when it expires)
#   STAGE_PROD_REGION         default us-east-2
#   STAGE_PROD_INSTANCE_NAME  Name tag of the orchestrator, default termag-orchestrator*
#   STAGE_PROD_PORT           port used on both ends of the forward, default 18432
#   STAGE_PROD_EXCLUDE_DATA   space-separated tables whose rows are not copied
set -euo pipefail

out=${1:-}
[ -n "$out" ] || { echo "usage: prod-snapshot.sh <out-file>" >&2; exit 2; }
: "${STAGE_PROD_PROFILE:?set STAGE_PROD_PROFILE to the AWS profile for the orchestrator account}"
export AWS_PROFILE=$STAGE_PROD_PROFILE AWS_REGION=${STAGE_PROD_REGION:-us-east-2}
NAME=${STAGE_PROD_INSTANCE_NAME:-termag-orchestrator*}
PORT=${STAGE_PROD_PORT:-18432}
# Rows that must not leave production, or that staging's sweeps would act on:
#   session, cli_sessions           live browser session ids and CLI sign-ins
#   user_credentials                sealed with production's KMS key; unreadable here
#   agent_tokens                    box tokens; staging mints its own for this box
#   orchestrator_leases             production's blue/green lease
#   project_invites, space_invites  invite codes
#   agent_spawns, agent_handoffs, spawn_events, collab_requests,
#   collab_responses, agent_threads, agent_messages
#                                   queues staging's sweeps would deliver again,
#                                   typing into this box's real panes
EXCLUDE=${STAGE_PROD_EXCLUDE_DATA:-session cli_sessions user_credentials agent_tokens orchestrator_leases project_invites space_invites agent_spawns agent_handoffs spawn_events collab_requests collab_responses agent_threads agent_messages}

log() { printf '[prod-snapshot] %s\n' "$*" >&2; }
die() { printf '[prod-snapshot] error: %s\n' "$*" >&2; exit 1; }

for c in aws jq curl sha256sum session-manager-plugin; do
  command -v "$c" >/dev/null 2>&1 || die "missing '$c'"
done
aws sts get-caller-identity >/dev/null 2>&1 || die "no AWS session for profile $STAGE_PROD_PROFILE (aws sso login --profile $STAGE_PROD_PROFILE)"

iid=$(aws ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" Name=instance-state-name,Values=running \
  --query 'sort_by(Reservations[].Instances[], &LaunchTime)[-1].InstanceId' --output text)
case $iid in i-*) ;; *) die "no running instance tagged Name=$NAME" ;; esac
log "orchestrator $iid"

# Run a script as root on the orchestrator; print its stdout; fail with its stderr.
ssm_run() {
  local script=$1 timeout=${2:-900} b64 params cid st
  b64=$(printf '%s' "$script" | base64 -w0)
  params=$(jq -nc --arg c "echo $b64 | base64 -d > /root/.stage-ssm.sh && bash /root/.stage-ssm.sh; rc=\$?; rm -f /root/.stage-ssm.sh; exit \$rc" \
    --arg t "$timeout" '{commands:[$c], executionTimeout:[$t]}')
  cid=$(aws ssm send-command --instance-ids "$iid" --document-name AWS-RunShellScript \
    --parameters "$params" --query Command.CommandId --output text)
  st=Pending
  for _ in $(seq 1 $((timeout / 2 + 30))); do
    st=$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$iid" --query Status --output text 2>/dev/null || echo Pending)
    case $st in Success|Failed|Cancelled|TimedOut) break ;; esac
    sleep 2
  done
  if [ "$st" != Success ]; then
    aws ssm get-command-invocation --command-id "$cid" --instance-id "$iid" --query StandardErrorContent --output text >&2 || true
    die "remote step ended $st"
  fi
  aws ssm get-command-invocation --command-id "$cid" --instance-id "$iid" --query StandardOutputContent --output text
}

key=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
excludes=""
for t in $EXCLUDE; do excludes="$excludes --exclude-table-data=public.$t"; done
pg_tools_b64=$(base64 -w0 "$(dirname "${BASH_SOURCE[0]}")/pg-tools.sh")

remote=$(cat <<EOF
set -euo pipefail
command -v psql >/dev/null || { echo "psql is not installed on the orchestrator" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is not installed on the orchestrator" >&2; exit 1; }
set -a; . /opt/termag/backend/.env; set +a
umask 077
pkill -f '^python3 /var/tmp/termag-stage-dump\.[A-Za-z0-9]+/serve\.py' 2>/dev/null || true
rm -rf /var/tmp/termag-stage-dump.*
dir=\$(mktemp -d /var/tmp/termag-stage-dump.XXXXXX)
host=\$PG_HOST port=\${PG_PORT:-5432} user=\${PG_USERNAME:-application} db=\${PG_DATABASE:-termag}
export PGSSLMODE=verify-full PGSSLROOTCERT=\$PG_SSL_CA_FILE
export PGPASSWORD=\$(aws rds generate-db-auth-token --hostname "\$host" --port "\$port" --username "\$user" --region "$AWS_REGION")
# pg_dump refuses a server newer than itself. When the image's is older,
# unpack the server's major from PGDG into the dump directory (deleted with it).
server=\$(psql -h "\$host" -p "\$port" -U "\$user" -d "\$db" -Atc 'show server_version_num')
server_major=\$((server / 10000))
dump=pg_dump
local_major=\$( (pg_dump --version 2>/dev/null || echo 0) | awk '{print \$NF}' | cut -d. -f1)
if [ "\${local_major:-0}" -lt "\$server_major" ]; then
  echo "$pg_tools_b64" | base64 -d > "\$dir/pg-tools.sh"
  bindir=\$(bash "\$dir/pg-tools.sh" "\$server_major" "\$dir/pg")
  export "\$(bash "\$dir/pg-tools.sh" env "\$dir/pg")"
  dump=\$bindir/pg_dump
fi
"\$dump" -Fc --no-owner --no-acl $excludes -h "\$host" -p "\$port" -U "\$user" -d "\$db" -f "\$dir/dump"
dumpver=\$("\$dump" --version | awk '{print \$3}')
rm -rf "\$dir/pg" "\$dir/pg-tools.sh"
cat > "\$dir/serve.py" <<'PY'
import http.server, os, shutil, sys, time
# The key comes from a root-only file, never argv: on this shared host any
# account can read every process's command line.
path, port = sys.argv[1], int(sys.argv[3])
with open(sys.argv[2]) as f:
    key = f.read().strip()
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != "/" + key:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(os.path.getsize(path)))
        self.end_headers()
        with open(path, "rb") as f:
            shutil.copyfileobj(f, self.wfile)
        self.server.served = True
    def log_message(self, *args):
        pass
server = http.server.HTTPServer(("127.0.0.1", port), Handler)
server.served, server.timeout = False, 5
deadline = time.time() + 900
while not server.served and time.time() < deadline:
    server.handle_request()
PY
printf '%s\n' '$key' > "\$dir/key"
setsid bash -c "python3 \$dir/serve.py \$dir/dump \$dir/key $PORT; rm -rf \$dir" >/dev/null 2>&1 < /dev/null &
for _ in \$(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && break; sleep 0.2; done
printf '%s %s %s\n' "\$(sha256sum "\$dir/dump" | cut -d' ' -f1)" "\$(stat -c %s "\$dir/dump")" "\$dumpver"
EOF
)

cleanup_remote() {
  ssm_run "pkill -f '^python3 /var/tmp/termag-stage-dump\.[A-Za-z0-9]+/serve\.py' 2>/dev/null || true; rm -rf /var/tmp/termag-stage-dump.*" 120 >/dev/null 2>&1 \
    || log "warning: remote cleanup failed; the orchestrator deletes the dump within 15 minutes anyway"
}

log "dumping the database on the orchestrator"
read -r want size dumpver < <(ssm_run "$remote" 900 | grep -v '^[[:space:]]*$' | tail -n1)
[ -n "${want:-}" ] && [ -n "${size:-}" ] || { cleanup_remote; die "the dump step reported nothing"; }
log "dump ready: $((size / 1024 / 1024)) MiB, pg_dump $dumpver"

fwd_log=$(mktemp)
setsid aws ssm start-session --target "$iid" --document-name AWS-StartPortForwardingSession \
  --parameters "{\"portNumber\":[\"$PORT\"],\"localPortNumber\":[\"$PORT\"]}" >"$fwd_log" 2>&1 < /dev/null &
fwd=$!
stop_forward() { kill -- -"$fwd" 2>/dev/null || kill "$fwd" 2>/dev/null || true; rm -f "$fwd_log"; }
trap 'stop_forward' EXIT
for _ in $(seq 1 60); do grep -q "Waiting for connections" "$fwd_log" && break; sleep 0.5; done
grep -q "Waiting for connections" "$fwd_log" || { cat "$fwd_log" >&2; cleanup_remote; die "the port forward did not come up"; }

umask 077
tmp="$out.part"
log "downloading"
if ! curl -fsS --max-time 1800 -o "$tmp" "http://127.0.0.1:$PORT/$key"; then
  rm -f "$tmp"; cleanup_remote; die "download failed"
fi
got=$(sha256sum "$tmp" | cut -d' ' -f1)
if [ "$got" != "$want" ]; then rm -f "$tmp"; cleanup_remote; die "checksum mismatch: got $got, want $want"; fi
mv "$tmp" "$out"
printf '%s\n' "$dumpver" >"$out.pgversion"
cleanup_remote
log "saved $out ($((size / 1024 / 1024)) MiB, sha256 ${want:0:12}…)"
