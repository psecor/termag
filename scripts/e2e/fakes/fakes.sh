# shellcheck shell=bash
# here, repo, ROOT, PORT, base_env, start_daemon, wait_http and port_in_use
# come from up.sh; box_front_door and the *_extra arrays go back to it.
# shellcheck disable=SC2154,SC2034,SC2153
# Opt-in fakes for the e2e stack, sourced by up.sh, which calls each fakes_*
# hook at its point in startup. Every fake is off unless its variable is set;
# docs/e2e-stack.md describes each one and what it does not cover.
#
#   E2E_FAKE_AWS=1     Floci (S3, SSM, KMS, Secrets Manager, STS, EC2, IAM, ...)
#   E2E_AWS_SEED=f     script run once Floci is up (E2E_AWS_URL set, aws.sh on PATH)
#   E2E_SPACES=1       the spaces bucket and KMS alias in Floci, under the names the
#                      backend derives (fakes/spaces.sh); needs FAKE_AWS. Turn the
#                      feature on with E2E_FLAGS='{"spaces-enabled":true,"spaces-sharing-enabled":true}'
#   E2E_CREDENTIAL_STORE=1
#                      the per-user credential store's KMS key in Floci, and its ARN
#                      in the backend env; needs FAKE_AWS
#   E2E_FAKE_CLAUDE=1  stand-in claude CLI on every box, reporting status
#   E2E_FAKE_GITHUB=1  api.github.com + github.com git stub for the backend, stand-in gh on boxes
#   E2E_TLS=1          nginx gateway from deploy/nginx; boxes connect over wss
#   E2E_BROKER_443=1   with E2E_CLAUDE_GATEWAY: relay 127.0.0.1:443 (from the box address) to
#                      the gateway's GitHub broker front and point the backend's
#                      GITHUB_BROKER_URL at https://localhost
#   E2E_FAKE_BEDROCK=1 Bedrock runtime stub (InvokeModel, streaming); checks SigV4
#   E2E_CLAUDE_GATEWAY=<gateway terraform checkout>
#                      the termag Claude gateway (Envoy) rendered from that checkout,
#                      behind a TLS front, against the Bedrock stub; needs FAKE_BEDROCK
#                      and TLS. Its GitHub broker listener has its own TLS front. Both
#                      listeners check each request through the checks ALB's stand-in
#                      (and the real :3041 nginx listener) and prove their caller to an
#                      STS stub that verifies SigV4
#   E2E_SSHD=1         an sshd per box whose logins land in that box's home
#   E2E_EC2_BOXES=N    register the first N boxes as kind=ec2 instead of external
#   E2E_EC2_LAUNCH=1   box provisioning on: a launched EC2 instance starts a box
#   E2E_TMUX_FAULTS=1  per-box tmux fault hook (scripts/e2e/ctl.sh fault)
#   E2E_PG_IAM=1       the backend and db:push connect as on RDS: IAM-token pool,
#                      `application` / `migration` from deploy/termag-rds-bootstrap.sql,
#                      additive db:push, db:guard (trust auth accepts the tokens)
#   E2E_WARM_POOL=N    with E2E_EC2_LAUNCH: keep N warm-pool boxes; pool boxes get a
#                      systemctl stand-in that runs the on-warm/on-claim units
#   E2E_FLAGS=json     flag values for the backend's TERMAG_FLAGS, e.g. '{"warm-pool-enabled":true}'
#   E2E_BACKEND_ENV=f  extra lines appended to the backend's env file
#   E2E_OVERLAP=1      the orchestrator lease on, with second-scale timings, a second
#                      backend ready to start as `ctl.sh start backend-green` on
#                      E2E_GREEN_PORT, and the box network routing like the ALB
#                     ; not with E2E_TLS

FAKE_AWS=${E2E_FAKE_AWS:-}
CREDENTIAL_STORE=${E2E_CREDENTIAL_STORE:-}
SPACES=${E2E_SPACES:-}
FAKE_CLAUDE=${E2E_FAKE_CLAUDE:-}
FAKE_GITHUB=${E2E_FAKE_GITHUB:-}
FAKE_TLS=${E2E_TLS:-}
BROKER_443=${E2E_BROKER_443:-}
FAKE_BEDROCK=${E2E_FAKE_BEDROCK:-}
BEDROCK_PORT=${E2E_BEDROCK_PORT:-4690}
CLAUDE_GATEWAY_TF=${E2E_CLAUDE_GATEWAY:+$(realpath "$E2E_CLAUDE_GATEWAY")}
CLAUDE_GW_PORT=${E2E_CLAUDE_GATEWAY_PORT:-3643}
ENVOY_PORT=${E2E_CLAUDE_GATEWAY_ENVOY_PORT:-18080}
GITHUB_GW_PORT=${E2E_GITHUB_BROKER_PORT:-3644}
STS_PORT=${E2E_STS_PORT:-4691}
# The key the harness gives Envoy, and the role the STS stub says it belongs to.
GATEWAY_KEY_ID=AKIAE2ECLAUDEGATEWAY # gitleaks:allow (a fake key the STS stub knows)
GATEWAY_ROLE=termag-claude-gateway-task
FAKE_SSHD=${E2E_SSHD:-}
TMUX_FAULTS=${E2E_TMUX_FAULTS:-}
PG_IAM=${E2E_PG_IAM:-}
EC2_BOXES=${E2E_EC2_BOXES:-0}
EC2_LAUNCH=${E2E_EC2_LAUNCH:-}
EC2_PORT=${E2E_EC2_PORT:-4567}
WARM_POOL=${E2E_WARM_POOL:-}
WARM_POOL_TICK=${E2E_WARM_POOL_TICK:-5}
FLAGS=${E2E_FLAGS:-}
AWS_PORT=${E2E_AWS_PORT:-4566}
AWS_REGION_E2E=${E2E_AWS_REGION:-us-east-2}
GITHUB_PORT=${E2E_GITHUB_PORT:-4580}
TLS_PORT=${E2E_TLS_PORT:-3443}
GATEWAY_PORT=${E2E_GATEWAY_PORT:-13040}
# The orchestrator's nginx checks listener (:3041) and the internal ALB in front of it.
CHECKS_PORT=${E2E_CHECKS_PORT:-13041}
CHECKS_ALB_PORT=${E2E_CHECKS_ALB_PORT:-3645}
SSH_PORT_BASE=${E2E_SSH_PORT_BASE:-2220}
CACHE_DIR=${E2E_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/termag-e2e}
AWS_SEED=${E2E_AWS_SEED:+$(realpath "$E2E_AWS_SEED")}
BACKEND_ENV_EXTRA=${E2E_BACKEND_ENV:+$(realpath "$E2E_BACKEND_ENV")}
OVERLAP=${E2E_OVERLAP:-}
GREEN_PORT=${E2E_GREEN_PORT:-}
fakes_dir="$here/fakes"

# Extra environment for the backend process and for each box agent.
backend_extra=()
box_extra=()
dbpush_extra=()

fakes_check() {
  case $EC2_BOXES in ''|*[!0-9]*) die "E2E_EC2_BOXES must be a number, got '$EC2_BOXES'" ;; esac
  [ "$EC2_BOXES" -le "$BOXES" ] || die "E2E_EC2_BOXES ($EC2_BOXES) is more than E2E_BOXES ($BOXES)"
  if [ -n "$AWS_SEED" ] && [ -z "$FAKE_AWS" ]; then die "E2E_AWS_SEED needs E2E_FAKE_AWS=1"; fi
  if [ -n "$CREDENTIAL_STORE" ] && [ -z "$FAKE_AWS" ]; then die "E2E_CREDENTIAL_STORE needs E2E_FAKE_AWS=1"; fi
  if [ -n "$SPACES" ] && [ -z "$FAKE_AWS" ]; then die "E2E_SPACES needs E2E_FAKE_AWS=1"; fi
  if [ -n "$EC2_LAUNCH" ] && [ -z "$FAKE_AWS" ]; then die "E2E_EC2_LAUNCH needs E2E_FAKE_AWS=1"; fi
  if [ -n "$WARM_POOL" ]; then
    case $WARM_POOL in *[!0-9]*) die "E2E_WARM_POOL must be a number, got '$WARM_POOL'" ;; esac
    [ -n "$EC2_LAUNCH" ] || die "E2E_WARM_POOL needs E2E_EC2_LAUNCH=1 (and E2E_FAKE_AWS=1)"
    case $WARM_POOL_TICK in ''|*[!0-9]*|0) die "E2E_WARM_POOL_TICK must be a positive number of seconds" ;; esac
  fi
  if [ -n "$FLAGS" ]; then
    # Single-quoted in backend.env, so the JSON must not contain a quote of its own.
    case $FLAGS in *"'"*) die "E2E_FLAGS must not contain a single quote" ;; esac
    node -e 'const v = JSON.parse(process.argv[1]); if (typeof v !== "object" || v === null || Array.isArray(v)) process.exit(1)' "$FLAGS" 2>/dev/null \
      || die "E2E_FLAGS must be a JSON object of flag key to value, got '$FLAGS'"
  fi
  if [ -n "$AWS_SEED" ] && [ ! -r "$AWS_SEED" ]; then die "E2E_AWS_SEED: cannot read $AWS_SEED"; fi
  if [ -n "$BACKEND_ENV_EXTRA" ] && [ ! -r "$BACKEND_ENV_EXTRA" ]; then die "E2E_BACKEND_ENV: cannot read $BACKEND_ENV_EXTRA"; fi
  if [ -n "$BROKER_443" ]; then
    [ -n "$CLAUDE_GATEWAY_TF" ] && [ -n "$FAKE_GITHUB" ] || die "E2E_BROKER_443 needs E2E_CLAUDE_GATEWAY and E2E_FAKE_GITHUB=1: the broker is the gateway's"
    # gh takes the broker as a GitHub Enterprise host, which cannot carry a port.
    [ "$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)" -le 443 ] \
      || die "E2E_BROKER_443 binds 127.0.0.1:443: run 'sudo sysctl -w net.ipv4.ip_unprivileged_port_start=443' first"
  fi
  if [ -n "$CLAUDE_GATEWAY_TF" ]; then
    [ -n "$FAKE_BEDROCK" ] && [ -n "$FAKE_TLS" ] \
      || die "E2E_CLAUDE_GATEWAY needs E2E_FAKE_BEDROCK=1 and E2E_TLS=1"
    [ -f "$CLAUDE_GATEWAY_TF/projects/termag/root-modules/orchestrator/claude-models.json" ] \
      || die "E2E_CLAUDE_GATEWAY: $CLAUDE_GATEWAY_TF has no termag Claude gateway (claude-models.json)"
  fi
  local ports=()
  [ -n "$BROKER_443" ] && ports+=(443)
  [ -n "$FAKE_BEDROCK" ] && ports+=("$BEDROCK_PORT")
  [ -n "$CLAUDE_GATEWAY_TF" ] && ports+=("$CLAUDE_GW_PORT" "$GITHUB_GW_PORT" "$STS_PORT" "$ENVOY_PORT" \
    $((ENVOY_PORT + 1)) $((ENVOY_PORT + 2)) $((ENVOY_PORT + 3)) $((ENVOY_PORT + 4)) $((ENVOY_PORT + 5)))
  [ -n "$FAKE_AWS" ] && ports+=("$AWS_PORT")
  [ -n "$EC2_LAUNCH" ] && ports+=("$EC2_PORT")
  [ -n "$FAKE_GITHUB" ] && ports+=("$GITHUB_PORT")
  if [ -n "$FAKE_TLS" ]; then
    ports+=("$TLS_PORT" "$GATEWAY_PORT" "$CHECKS_PORT" "$CHECKS_ALB_PORT")
    [ -x /usr/sbin/nginx ] || die "E2E_TLS=1 needs nginx (see .cursor/install.sh)"
    command -v openssl >/dev/null || die "E2E_TLS=1 needs openssl"
  fi
  if [ -n "$FAKE_SSHD" ]; then
    local i
    for i in $(seq 1 "$BOXES"); do ports+=("$((SSH_PORT_BASE + i))"); done
    [ -x /usr/sbin/sshd ] || die "E2E_SSHD=1 needs openssh-server (see .cursor/install.sh)"
  fi
  local p
  for p in "${ports[@]}"; do
    if port_in_use "$p"; then die "port $p (an opt-in fake) is in use; see the E2E_*_PORT variables in docs/e2e-stack.md"; fi
  done
}

fakes_record() {
  cat >>"$ROOT/stack.env" <<EOF
FAKES="${PG_IAM:+pg-iam }${FAKE_AWS:+aws }${CREDENTIAL_STORE:+credential-store }${SPACES:+spaces }${FAKE_BEDROCK:+bedrock }${CLAUDE_GATEWAY_TF:+claude-gateway }${EC2_LAUNCH:+ec2-launch }${WARM_POOL:+warm-pool }${FLAGS:+flags }${FAKE_CLAUDE:+claude }${FAKE_GITHUB:+github }${FAKE_TLS:+tls }${FAKE_SSHD:+sshd }${TMUX_FAULTS:+tmux-faults }"
EC2_BOXES=$EC2_BOXES
AWS_URL=${FAKE_AWS:+http://127.0.0.1:$AWS_PORT}
EC2_URL=${EC2_LAUNCH:+http://127.0.0.1:$EC2_PORT}
AWS_REGION=${FAKE_AWS:+$AWS_REGION_E2E}
GITHUB_URL=${FAKE_GITHUB:+http://127.0.0.1:$GITHUB_PORT}
TLS_URL=${FAKE_TLS:+https://localhost:$TLS_PORT/termag}
GITHUB_BROKER_FRONT=${CLAUDE_GATEWAY_TF:+https://localhost:$GITHUB_GW_PORT}
STS_URL=${CLAUDE_GATEWAY_TF:+http://127.0.0.1:$STS_PORT}
GATEWAY_URL=${FAKE_TLS:+http://127.0.0.1:$GATEWAY_PORT/termag}
SSH_PORT_BASE=${FAKE_SSHD:+$SSH_PORT_BASE}
EOF
}

# Before the backend starts: services it must reach, and its env.
fakes_before_backend() {
  if [ -n "$OVERLAP" ]; then
    [ -z "$FAKE_TLS" ] || die "E2E_OVERLAP does not run with E2E_TLS"
    printf '%s\n' ORCHESTRATOR_LEASE=true ORCHESTRATOR_LEASE_HEARTBEAT_MS=1000 \
      ORCHESTRATOR_LEASE_STALE_MS=5000 ORCHESTRATOR_DRAIN_GRACE_MS=4000 ORCHESTRATOR_DRAIN_BROWSER_DELAY_MS=1500 >>"$ROOT/backend.env"
  fi
  if [ -n "$PG_IAM" ]; then
    # What the orchestrator's RDS .env looks like (the terraform cloud-init), against
    # the local cluster. rds_iam is a plain role here, and trust auth accepts the
    # token each new connection presents.
    log "pg-iam: bootstrapping the application and migration roles"
    env -i "${base_env[@]}" "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$PG_PORT" -U termag -d termag \
      -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rds_iam') THEN CREATE ROLE rds_iam NOLOGIN; END IF; END \$\$" \
      -f "$repo/deploy/termag-rds-bootstrap.sql" >"$ROOT/logs/pg-iam-bootstrap.log" 2>&1 \
      || die "the role bootstrap failed (logs/pg-iam-bootstrap.log)"
    mkdir -p "$ROOT/data"
    touch "$ROOT/data/ALLOW_EMPTY_DATABASE"
    sed -i '/^DATABASE_URL=/d' "$ROOT/backend.env"
    cat >>"$ROOT/backend.env" <<EOF
PG_IAM_AUTH=true
PG_HOST=127.0.0.1
PG_PORT=$PG_PORT
PG_DATABASE=termag
PG_USERNAME=application
PG_SSLMODE=disable
TERMAG_DATA_DIR=$ROOT/data
EOF
    if [ -z "$FAKE_AWS" ]; then
      # The signer presigns locally and only needs well-formed credentials.
      printf 'AWS_REGION=%s\nAWS_ACCESS_KEY_ID=AKIAE2EPGIAM\nAWS_SECRET_ACCESS_KEY=e2e\n' "$AWS_REGION_E2E" >>"$ROOT/backend.env"
    fi
    dbpush_extra=("PG_USERNAME=migration" "DB_PUSH_MODE=additive")
  fi

  if [ -n "$FAKE_AWS" ]; then
    local floci
    floci=$(E2E_CACHE_DIR=$CACHE_DIR bash "$fakes_dir/floci.sh" fetch) || die "could not fetch Floci"
    mkdir -p "$ROOT/floci"
    log "starting floci (fake AWS) on 127.0.0.1:$AWS_PORT"
    # ec2.mock keeps the EC2 API but runs no Docker-backed instances and no
    # metadata server, which would otherwise listen on *:9169.
    start_daemon floci "$ROOT/floci" env -i "${base_env[@]}" "FLOCI_STORAGE_PERSISTENT_PATH=$ROOT/floci/data" \
      "$floci" -Dquarkus.http.host=127.0.0.1 "-Dquarkus.http.port=$AWS_PORT" \
      "-Dfloci.default-region=$AWS_REGION_E2E" "-Djava.io.tmpdir=$ROOT/tmp" \
      -Dfloci.services.ec2.mock=true
    wait_http "http://127.0.0.1:$AWS_PORT/_floci/health" floci
    if [ -n "$AWS_SEED" ]; then
      log "seeding floci with $AWS_SEED"
      env -i "${base_env[@]}" "PATH=$fakes_dir:$PATH" "E2E_AWS_URL=http://127.0.0.1:$AWS_PORT" \
        bash "$AWS_SEED" >"$ROOT/logs/aws-seed.log" 2>&1 || die "E2E_AWS_SEED failed (logs/aws-seed.log)"
    fi
    if [ -n "$SPACES" ]; then
      log "creating the spaces bucket and KMS alias in floci"
      env -i "${base_env[@]}" "E2E_AWS_URL=http://127.0.0.1:$AWS_PORT" "E2E_AWS_REGION=$AWS_REGION_E2E" \
        bash "$fakes_dir/spaces.sh" seed "http://127.0.0.1:$FRONTEND_PORT" "http://localhost:$FRONTEND_PORT" \
        >>"$ROOT/logs/aws-seed.log" 2>&1 || die "could not seed the spaces bucket (logs/aws-seed.log)"
    fi
    if [ -n "$CREDENTIAL_STORE" ]; then
      log "creating the credential store's KMS key in floci"
      env -i "${base_env[@]}" "E2E_AWS_URL=http://127.0.0.1:$AWS_PORT" bash "$fakes_dir/credential-store.sh" seed-aws \
        >>"$ROOT/backend.env" 2>>"$ROOT/logs/aws-seed.log" || die "could not seed the credential store key (logs/aws-seed.log)"
    fi
    cat >>"$ROOT/backend.env" <<EOF
AWS_REGION=$AWS_REGION_E2E
AWS_ACCESS_KEY_ID=e2e
AWS_SECRET_ACCESS_KEY=e2e
AWS_ENDPOINT_URL=http://127.0.0.1:$AWS_PORT
EOF
  fi

  if [ -n "$FAKE_BEDROCK" ]; then
    log "starting the Bedrock runtime stub on 127.0.0.1:$BEDROCK_PORT"
    start_daemon bedrock "$fakes_dir" env -i "${base_env[@]}" "E2E_BEDROCK_PORT=$BEDROCK_PORT" \
      "E2E_BEDROCK_INVOCATION_LOG=$ROOT/logs/bedrock-invocations.jsonl" node bedrock-stub.mjs
    wait_http "http://127.0.0.1:$BEDROCK_PORT/_e2e/calls" bedrock
  fi

  if [ -n "$CLAUDE_GATEWAY_TF" ]; then
    log "rendering the Claude gateway from $CLAUDE_GATEWAY_TF"
    bash "$fakes_dir/claude-gateway.sh" render "$CLAUDE_GATEWAY_TF" "$ROOT/claude-gateway" \
      "$ENVOY_PORT" "$CHECKS_ALB_PORT" "$BEDROCK_PORT" "$GITHUB_PORT" "$STS_PORT" "$ROOT/tls/ca.pem" \
      >"$ROOT/logs/claude-gateway-render.log" 2>&1 \
      || die "could not render the Claude gateway (logs/claude-gateway-render.log)"
    log "starting the STS stub (the gateway's caller proof) on 127.0.0.1:$STS_PORT"
    start_daemon sts "$fakes_dir" env -i "${base_env[@]}" "E2E_STS_PORT=$STS_PORT" \
      "E2E_STS_KEYS=$GATEWAY_KEY_ID=e2e-fake-secret=$GATEWAY_ROLE" node sts-stub.mjs
    wait_http "http://127.0.0.1:$STS_PORT/_e2e/calls" sts
    { cat "$ROOT/claude-gateway/backend.env"
      echo "CLAUDE_GATEWAY_URL=https://localhost:$CLAUDE_GW_PORT"
      # What terraform gives the backend: the gateway's task role is the one
      # caller of the gateway's checks (Claude and GitHub).
      echo "GATEWAY_AUTHZ_ALLOWED_CALLER_ARNS=arn:aws:iam::000000000000:role/$GATEWAY_ROLE"
      echo "GATEWAY_AUTHZ_STS_URL=http://127.0.0.1:$STS_PORT"
      # Where boxes reach the broker: the gateway's GitHub front on 443, which
      # gh needs, through the relay fakes_after_backend starts.
      [ -n "$BROKER_443" ] && echo "GITHUB_BROKER_URL=https://localhost"
    } >>"$ROOT/backend.env"
  fi

  if [ -n "$EC2_LAUNCH" ]; then
    local launch_env=("${base_env[@]}" "E2E_FLOCI_URL=http://127.0.0.1:$AWS_PORT" "E2E_EC2_PORT=$EC2_PORT" "AWS_REGION=$AWS_REGION_E2E")
    log "registering a box image and turning box provisioning on"
    env -i "${launch_env[@]}" node "$fakes_dir/ec2-launcher.mjs" setup "$ROOT" >>"$ROOT/backend.env" \
      || die "the EC2 launch fake's setup failed"
    log "starting the EC2 launch fake on 127.0.0.1:$EC2_PORT"
    start_daemon ec2-launch "$fakes_dir" env -i "${launch_env[@]}" node ec2-launcher.mjs serve "$ROOT"
    for _ in $(seq 1 40); do port_in_use "$EC2_PORT" && break; sleep 0.25; done
    port_in_use "$EC2_PORT" || die "the EC2 launch fake did not listen on $EC2_PORT (logs/ec2-launch.log)"
  fi

  if [ -n "$FAKE_GITHUB" ]; then
    log "starting the api.github.com stub on 127.0.0.1:$GITHUB_PORT"
    start_daemon github "$fakes_dir" env -i "${base_env[@]}" "E2E_GITHUB_PORT=$GITHUB_PORT" "E2E_GITHUB_ROOT=$ROOT/github" node github-stub.mjs
    wait_http "http://127.0.0.1:$GITHUB_PORT/meta" github
    # NODE_OPTIONS has to be in the process env: dotenv runs after preloads.
    backend_extra+=("NODE_OPTIONS=--require $fakes_dir/github-redirect.cjs" "E2E_GITHUB_URL=http://127.0.0.1:$GITHUB_PORT"
      "ASK_GITHUB_GIT_URL=http://127.0.0.1:$GITHUB_PORT/_github.com")
    # The box gh stub hands anything not aimed at github.com to the real gh, so
    # gh can be driven through an orchestrator-side broker.
    real_gh=$(command -v gh || true)
    [ -n "$real_gh" ] && box_extra+=("E2E_REAL_GH=$real_gh")
  fi

  if [ -n "$WARM_POOL" ]; then
    printf 'WARM_POOL_TARGET_SIZE=%s\nWARM_POOL_RECONCILE_SECONDS=%s\n' "$WARM_POOL" "$WARM_POOL_TICK" >>"$ROOT/backend.env"
  fi
  if [ -n "$FLAGS" ]; then printf "TERMAG_FLAGS='%s'\n" "$FLAGS" >>"$ROOT/backend.env"; fi

  if [ -n "$BACKEND_ENV_EXTRA" ]; then
    { echo "# appended from E2E_BACKEND_ENV=$BACKEND_ENV_EXTRA"; cat "$BACKEND_ENV_EXTRA"; echo; } >>"$ROOT/backend.env"
  fi
}

# After the schema sync, before the backend: the start-up guard cloud-init runs.
fakes_after_schema() {
  [ -n "$PG_IAM" ] || return 0
  (cd "$repo/backend" && env -i "${backend_env[@]}" node_modules/.bin/tsx src/scripts/dbGuard.ts) >"$ROOT/logs/db-guard.log" 2>&1 \
    || die "db:guard refused (logs/db-guard.log)"
}

# After the backend is up: the nginx pair in front of it.
fakes_after_backend() {
  box_front_door="ws 127.0.0.1 $PORT"
  if [ -n "$OVERLAP" ]; then
    # The same command as the backend's, on another port; ctl.sh starts it.
    local argv green=${GREEN_PORT:-$((PORT + 3))}
    mapfile -d '' argv <"$ROOT/cmds/backend"
    printf '%s\0' "${argv[@]:0:3}" "PORT=$green" "${argv[@]:3}" >"$ROOT/cmds/backend-green"
    box_front_door="ws 127.0.0.1 $PORT,$green"
  fi
  if [ -n "$PG_IAM" ]; then
    local who
    who=$(env -i "${base_env[@]}" "$PG_BIN/psql" -X -At -h 127.0.0.1 -p "$PG_PORT" -U termag -d termag \
      -c "SELECT string_agg(DISTINCT usename, ',') FROM pg_stat_activity WHERE datname = 'termag' AND usename <> 'termag'")
    [ "$who" = application ] || die "pg-iam: expected the backend's connections as application, saw '$who'"
  fi
  [ -n "$FAKE_TLS" ] || return 0

  local t="$ROOT/tls" n="$ROOT/nginx"
  mkdir -p "$t" "$n/tmp"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2 -subj /CN=termag-e2e-ca \
    -keyout "$t/ca.key" -out "$t/ca.pem" 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj /CN=localhost \
    -keyout "$t/server.key" -out "$t/server.csr" 2>/dev/null
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' >"$t/ext.cnf"
  openssl x509 -req -in "$t/server.csr" -CA "$t/ca.pem" -CAkey "$t/ca.key" -CAcreateserial -days 2 \
    -extfile "$t/ext.cnf" -out "$t/server.pem" 2>/dev/null
  chmod 600 "$t/ca.key" "$t/server.key"

  # The real gateway and proxy snippet, re-pointed at the e2e ports. Each
  # substitution must match, so an edit to deploy/nginx fails here loudly.
  cp "$repo/deploy/nginx/termag-proxy.conf" "$n/termag-proxy.conf"
  sed -e "s#listen 3040 default_server#listen 127.0.0.1:$GATEWAY_PORT default_server#" \
      -e "s#listen 3040;#listen 127.0.0.1:$GATEWAY_PORT;#" \
      -e "s#/etc/nginx/snippets/termag-proxy.conf#$n/termag-proxy.conf#" \
      -e "s#include /srv/termag/apps/\*/nginx.conf;##" \
      -e "s#127.0.0.1:3100#127.0.0.1:$PORT#" \
      -e "s#/var/log/nginx/#$ROOT/logs/nginx-#" \
      "$repo/deploy/nginx/termag-gateway.conf" >"$n/gateway.conf"
  if ! grep -q "listen 127.0.0.1:$GATEWAY_PORT" "$n/gateway.conf" || ! grep -q "127.0.0.1:$PORT;" "$n/gateway.conf" \
     || ! grep -q "$n/termag-proxy.conf" "$n/gateway.conf" || grep -q 'include /srv/termag' "$n/gateway.conf" \
     || grep -q '/var/log/nginx' "$n/gateway.conf" || grep -qE '^[^#]*listen 3040' "$n/gateway.conf"; then
    die "deploy/nginx/termag-gateway.conf no longer matches what scripts/e2e/fakes/fakes.sh rewrites"
  fi
  sed -e "s#listen 3041;#listen 127.0.0.1:$CHECKS_PORT;#" \
      -e "s#/etc/nginx/snippets/termag-proxy.conf#$n/termag-proxy.conf#" \
      -e "s#127.0.0.1:3100#127.0.0.1:$PORT#" \
      "$repo/deploy/nginx/termag-checks.conf" >"$n/checks.conf"
  if ! grep -q "listen 127.0.0.1:$CHECKS_PORT;" "$n/checks.conf" || [ "$(grep -c "127.0.0.1:$PORT;" "$n/checks.conf")" != 2 ] \
     || grep -q '/etc/nginx/snippets' "$n/checks.conf"; then
    die "deploy/nginx/termag-checks.conf no longer matches what scripts/e2e/fakes/fakes.sh rewrites"
  fi
  # Two TLS fronts. The first stands in for the ALB boxes dial wss:// through
  # (terraform#27627), which lands on :3040 and so never serves the check
  # routes; like the ALB's own access log, its log is not the gateway's. The
  # second is terraform's internal checks ALB: only /termag/internal/* goes to
  # the real :3041 listener, anything else is the ALB's fixed 404.
  cat >"$n/tls.conf" <<EOF
server {
    listen 127.0.0.1:$TLS_PORT ssl;
    server_name localhost;
    access_log $ROOT/logs/nginx-alb-access.log;
    ssl_certificate $t/server.pem;
    ssl_certificate_key $t/server.key;
    client_max_body_size 200m;
    proxy_headers_hash_bucket_size 128;
    location ^~ /termag/internal/ {
        return 404;
    }
    location /termag {
        proxy_pass http://127.0.0.1:$PORT;
        include $n/termag-proxy.conf;
    }
}
server {
    listen 127.0.0.1:$CHECKS_ALB_PORT ssl;
    server_name localhost;
    ssl_certificate $t/server.pem;
    ssl_certificate_key $t/server.key;
    client_max_body_size 8m;
    location /termag/internal/ {
        proxy_pass http://127.0.0.1:$CHECKS_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
    }
    location / {
        default_type application/json;
        return 404 '{"message":"Not a termag check route"}';
    }
}
EOF
  if [ -n "$CLAUDE_GATEWAY_TF" ]; then
    # The gateway's internal ALB: TLS in front of Envoy.
    cat >>"$n/tls.conf" <<EOF
server {
    listen 127.0.0.1:$CLAUDE_GW_PORT ssl;
    server_name localhost;
    ssl_certificate $t/server.pem;
    ssl_certificate_key $t/server.key;
    location / {
        proxy_pass http://127.0.0.1:$ENVOY_PORT;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_read_timeout 900s;
    }
}
# The same ALB's host rule for the GitHub broker: streams both ways, as the
# ALB does, so a large push or clone is not held here.
server {
    listen 127.0.0.1:$GITHUB_GW_PORT ssl;
    server_name localhost;
    ssl_certificate $t/server.pem;
    ssl_certificate_key $t/server.key;
    client_max_body_size 0;
    location / {
        proxy_pass http://127.0.0.1:$((ENVOY_PORT + 2));
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 900s;
    }
}
EOF
  fi
  cat >"$n/nginx.conf" <<EOF
daemon off;
worker_processes 1;
pid $n/nginx.pid;
error_log $ROOT/logs/nginx-error.log;
events {}
http {
    access_log $ROOT/logs/nginx-access.log;
    client_body_temp_path $n/tmp/body;
    proxy_temp_path $n/tmp/proxy;
    fastcgi_temp_path $n/tmp/fastcgi;
    uwsgi_temp_path $n/tmp/uwsgi;
    scgi_temp_path $n/tmp/scgi;
    include $n/gateway.conf;
    include $n/checks.conf;
    include $n/tls.conf;
}
EOF
  log "starting nginx: gateway on 127.0.0.1:$GATEWAY_PORT, checks listener on 127.0.0.1:$CHECKS_PORT, box TLS front on localhost:$TLS_PORT, checks ALB on localhost:$CHECKS_ALB_PORT"
  start_daemon nginx "$n" env -i "${base_env[@]}" /usr/sbin/nginx -p "$n" -c "$n/nginx.conf" -e "$ROOT/logs/nginx-error.log"
  wait_http "http://127.0.0.1:$GATEWAY_PORT/termag/health" nginx
  curl -sf --cacert "$t/ca.pem" -o /dev/null "https://localhost:$TLS_PORT/termag/health" \
    || die "the TLS listener does not answer (logs/nginx-error.log)"
  box_front_door="wss localhost $TLS_PORT"
  if [ -n "$CLAUDE_GATEWAY_TF" ]; then
    local envoy
    envoy=$(E2E_CACHE_DIR=$CACHE_DIR bash "$fakes_dir/envoy.sh" fetch) || die "could not fetch Envoy"
    log "starting the Claude gateway (Envoy) on 127.0.0.1:$ENVOY_PORT, TLS front on localhost:$CLAUDE_GW_PORT"
    # The task role's credentials in production; any key signs for the stub.
    start_daemon claude-gateway "$ROOT/claude-gateway" env -i "${base_env[@]}" \
      AWS_ACCESS_KEY_ID=AKIAE2ECLAUDEGATEWAY AWS_SECRET_ACCESS_KEY=e2e-fake-secret AWS_EC2_METADATA_DISABLED=true \
      "$envoy" -c envoy.yaml --disable-hot-restart --log-level warn
    wait_http "http://127.0.0.1:$ENVOY_PORT/healthz" claude-gateway
    wait_http "http://127.0.0.1:$((ENVOY_PORT + 2))/healthz" claude-gateway
  fi
  if [ -n "$BROKER_443" ]; then
    log "starting the GitHub broker relay on 127.0.0.1:443 -> the gateway's GitHub front (from 127.0.0.2)"
    start_daemon broker-relay "$here" env -i "${base_env[@]}" node box-network.mjs 443 "$GITHUB_GW_PORT"
    for _ in $(seq 1 40); do port_in_use 443 && break; sleep 0.25; done
    port_in_use 443 || die "the broker relay did not listen on 443 (logs/broker-relay.log)"
  fi
  # git (libcurl) and gh (Go) ignore CURL_CA_BUNDLE.
  box_extra+=("NODE_EXTRA_CA_CERTS=$t/ca.pem" "CURL_CA_BUNDLE=$t/ca.pem" "GIT_SSL_CAINFO=$t/ca.pem" "SSL_CERT_FILE=$t/ca.pem")
}

# Per box, before its agent starts. $1 = box name, $2 = box dir.
fakes_box() {
  local name=$1 box=$2
  if [ -n "$TMUX_FAULTS" ]; then
    : >"$box/tmux-fault"
    # Modes match the agent's attach sequence: it sets set-clipboard right
    # before each `tmux attach-session`, and polls with capture-pane.
    cat >"$box/bin/tmux" <<EOF
#!/bin/sh
mode=\$(cat '$box/tmux-fault' 2>/dev/null)
case "\$mode:\$1 \$2 \$3" in
  attach-delay=*:"set-option -g set-clipboard") sleep "\${mode#attach-delay=}" ;;
  hang:capture-pane*|hang:display-message*) exec sleep 100000 ;;
esac
exec '$REAL_TMUX' -S '$box/tmux.sock' "\$@"
EOF
    chmod 0755 "$box/bin/tmux"
  fi
  [ -n "$FAKE_CLAUDE" ] && install -m 0755 "$fakes_dir/claude" "$box/bin/claude" \
    && install -m 0644 "$fakes_dir/claude-bedrock.mjs" "$box/bin/claude-bedrock.mjs" \
    && install -m 0644 "$fakes_dir/claude-stream.mjs" "$box/bin/claude-stream.mjs"
  if [ -n "$FAKE_GITHUB" ]; then
    install -m 0755 "$fakes_dir/gh" "$box/bin/gh"
    git config -f "$box/etc/gitconfig" "url.http://127.0.0.1:$GITHUB_PORT/_github.com/.insteadOf" https://github.com/
  fi
  if grep -q '"warm": true' "$box/home/.termag/agent.config.json"; then fakes_warm_box "$name" "$box"; fi
  return 0
}

# A warm-pool box (the launch fake saw buildWarmCloudInit's user data): what a
# baked box image gives it and a stand-in has not. The on-warm and on-claim
# units run through a systemctl stand-in, from a checkout at ~/src/termag whose
# deploy/ is the repo's but whose on-warm.d is the e2e one (the real scripts
# pull images). With the GitHub stub, github.com is the
# stub for its git, so a claim can clone e2e-org/dotfiles.
fakes_warm_box() {
  local name=$1 box=$2 real_sc co
  real_sc=$(command -v systemctl || echo /usr/bin/systemctl)
  case $real_sc in "$box"/*) real_sc=/usr/bin/systemctl ;; esac
  {
    echo '#!/usr/bin/env bash'
    printf 'E2E_UNIT_DIR=%q E2E_UNIT_STATE=%q E2E_UNIT_PIDS=%q E2E_BOX=%q E2E_REAL_SYSTEMCTL=%q exec bash %q "$@"\n' \
      "$repo/deploy" "$box/home/.termag/.e2e-systemctl" "$ROOT/pids" "$name" "$real_sc" "$fakes_dir/systemctl"
  } >"$box/bin/systemctl"
  chmod 0755 "$box/bin/systemctl"
  co="$box/home/src/termag/deploy"
  mkdir -p "$co/on-warm.d"
  ln -sfn "$repo/deploy/termag-hook-run" "$co/termag-hook-run"
  install -m 0755 "$fakes_dir/on-warm.d/"*.sh "$co/on-warm.d/"
}

# OpenSSH's StrictModes refuses a path with a group/world-writable directory
# or one owned by someone else anywhere above it, which /tmp is.
strict_modes_ok() {
  local d=$1 uid
  uid=$(id -u)
  while [ "$d" != / ]; do
    local owner mode
    owner=$(stat -c %u "$d"); mode=$(stat -c %a "$d")
    { [ "$owner" = 0 ] || [ "$owner" = "$uid" ]; } || return 1
    (( (8#$mode & 8#022) == 0 )) || return 1
    d=$(dirname "$d")
  done
}

# After the boxes up.sh starts are running: wait for the launched ones, then
# one sshd per box.
fakes_after_boxes() {
  local b
  if [ -n "$EC2_LAUNCH" ]; then
    for b in $(seq 1 "$EC2_BOXES"); do
      for _ in $(seq 1 120); do [ -f "$ROOT/pids/box-$b.pid" ] && break; sleep 0.25; done
      [ -f "$ROOT/pids/box-$b.pid" ] || die "box-$b was not launched (logs/ec2-launch.log, logs/backend.log)"
    done
  fi
  [ -n "$FAKE_SSHD" ] || return 0
  local s="$ROOT/sshd" i
  mkdir -p "$s"
  ssh-keygen -q -t ed25519 -N '' -f "$s/host_key"
  for i in $(seq 1 "$BOXES"); do
    local name="box-$i" box="$ROOT/boxes/box-$i" port=$((SSH_PORT_BASE + i)) strict=yes
    mkdir -m 700 "$box/home/.ssh"
    touch "$box/home/.ssh/authorized_keys"; chmod 600 "$box/home/.ssh/authorized_keys"
    if ! strict_modes_ok "$box/home/.ssh"; then
      strict=no
      [ "$i" = 1 ] && log "sshd: StrictModes off, the root's parents are group/world-writable (use a 0700 TMPDIR to turn it on)"
    fi
    # Logins land on the box, not the machine: its HOME, PATH and tmux server.
    # shellcheck disable=SC2016
    printf '#!/bin/sh\ncd %q\nexport HOME=%q PATH=%q SHELL=/bin/bash TERMAG_E2E_ROOT=%q\n[ -n "$SSH_ORIGINAL_COMMAND" ] && exec /bin/bash -c "$SSH_ORIGINAL_COMMAND"\nexec /bin/bash -l\n' \
      "$box/home" "$box/home" "$box/bin:$PATH" "$ROOT" >"$s/$name-login"
    chmod 0755 "$s/$name-login"
    cat >"$s/$name.conf" <<EOF
Port $port
ListenAddress 127.0.0.1
HostKey $s/host_key
PidFile $s/$name.pid
AuthorizedKeysFile $box/home/.ssh/authorized_keys
StrictModes $strict
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
ForceCommand $s/$name-login
EOF
    start_daemon "sshd-$name" "$s" env -i "${base_env[@]}" /usr/sbin/sshd -D -e -f "$s/$name.conf"
  done
  for i in $(seq 1 "$BOXES"); do
    local port=$((SSH_PORT_BASE + i)) ok=
    for _ in $(seq 1 40); do port_in_use "$port" && { ok=1; break; }; sleep 0.25; done
    [ -n "$ok" ] || die "sshd for box-$i did not listen on $port (logs/sshd-box-$i.log)"
  done
}

fakes_summary() {
  [ -n "$FAKE_AWS" ] && echo "  aws       http://127.0.0.1:$AWS_PORT  (Floci, region $AWS_REGION_E2E; scripts/e2e/fakes/aws.sh)"
  [ -n "$FAKE_GITHUB" ] && echo "  github    http://127.0.0.1:$GITHUB_PORT  (api.github.com stub; backend fetches are redirected)"
  [ -n "$FAKE_TLS" ] && echo "  tls       wss://localhost:$TLS_PORT (boxes, through the box network), gateway http://127.0.0.1:$GATEWAY_PORT, CA $ROOT/tls/ca.pem"
  [ -n "$FAKE_SSHD" ] && echo "  sshd      box-N on 127.0.0.1:$((SSH_PORT_BASE + 1))..$((SSH_PORT_BASE + BOXES))"
  [ -n "$FAKE_CLAUDE" ] && echo "  claude    stand-in CLI on every box (claude -p: one Bedrock turn through the gateway settings)"
  [ -n "$FAKE_BEDROCK" ] && echo "  bedrock   http://127.0.0.1:$BEDROCK_PORT  (Bedrock runtime stub; invocation log logs/bedrock-invocations.jsonl)"
  [ -n "$CLAUDE_GATEWAY_TF" ] && echo "  claude-gw https://localhost:$CLAUDE_GW_PORT -> Envoy 127.0.0.1:$ENVOY_PORT (from $CLAUDE_GATEWAY_TF; access log logs/claude-gateway.log)"
  [ "$EC2_BOXES" -gt 0 ] && echo "  ec2 boxes box-1..box-$EC2_BOXES registered as kind=ec2${EC2_LAUNCH:+, started by the launch fake}"
  [ -n "$EC2_LAUNCH" ] && echo "  ec2       launch fake on 127.0.0.1:$EC2_PORT, so Add box works; scripts/e2e/ctl.sh ec2 bake|clear|no-agent|agent"
  [ -n "$WARM_POOL" ] && echo "  warm pool $WARM_POOL box(es), reconciled every ${WARM_POOL_TICK}s${FAKE_GITHUB:+; public dotfiles repo https://github.com/e2e-org/dotfiles}"
  [ -n "$FLAGS" ] && echo "  flags     $FLAGS (TERMAG_FLAGS)"
  [ -n "$TMUX_FAULTS" ] && echo "  faults    scripts/e2e/ctl.sh fault box-N hang|attach-delay=S|off"
  [ -n "$PG_IAM" ] && echo "  pg-iam    backend as application, db:push as migration, through the IAM-token path (logs/db-push.log, logs/db-guard.log)"
  return 0
}
