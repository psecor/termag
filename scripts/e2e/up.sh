#!/usr/bin/env bash
# Start the local end-to-end stack: a private Postgres, the backend (schema
# synced with the production db:push step), the Vite frontend, and N stand-in
# boxes. Each box is agent/agent.js with its own temp HOME and tmux server,
# registered through the real "external box" API. All state lives under one
# `mktemp -d` root; scripts/e2e/down.sh removes it. Guide: docs/e2e-stack.md.
#
# Env: E2E_BOXES (2), E2E_PORT (3040; the box network takes E2E_PORT+1),
#      E2E_FRONTEND_PORT (5174),
#      E2E_PG_PORT (55432), E2E_EMAIL (e2e@termag.local), E2E_PG_BIN, and the
#      opt-in fakes listed in scripts/e2e/fakes/fakes.sh.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"

BOXES=${E2E_BOXES:-2}
PORT=${E2E_PORT:-3040}
BOX_NET_PORT=$((PORT + 1))
FRONTEND_PORT=${E2E_FRONTEND_PORT:-5174}
PG_PORT=${E2E_PG_PORT:-55432}
EMAIL=${E2E_EMAIL:-e2e@termag.local}
USER_NAME=$(id -un)
# shellcheck source-path=SCRIPTDIR
. "$here/fakes/fakes.sh"

case $BOXES in ''|*[!0-9]*|0) die "E2E_BOXES must be a positive integer, got '$BOXES'" ;; esac

if existing=$(e2e_root); then
  die "a stack is already up at $existing; run 'make e2e-down' first"
fi
rm -f "$E2E_POINTER"

for c in node npm tmux jq curl git setsid; do
  command -v "$c" >/dev/null 2>&1 || die "missing '$c' (see .cursor/install.sh for the package list)"
done
PG_BIN=$(pg_bindir)
[ -x "$PG_BIN/initdb" ] || die "no PostgreSQL server binaries found; install postgresql or set E2E_PG_BIN"
REAL_TMUX=$(command -v tmux)

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for p in "$PORT" "$BOX_NET_PORT" "$FRONTEND_PORT" "$PG_PORT"; do
  if port_in_use "$p"; then die "port $p is in use; set E2E_PORT (which also takes the next port) / E2E_FRONTEND_PORT / E2E_PG_PORT"; fi
done
fakes_check

for d in backend frontend agent; do
  if [ ! -d "$repo/$d/node_modules" ]; then
    log "installing $d dependencies"
    npm --prefix "$repo/$d" ci --no-audit --no-fund
  fi
done
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/termag-e2e.XXXXXX")
mkdir -p "$ROOT"/{logs,pids,cmds,tmp,boxes,pg,orchestrator-home}
printf '%s\n' "$ROOT" > "$ROOT/.termag-e2e"
printf '%s\n' "$ROOT" > "$E2E_POINTER"

on_exit() {
  local code=$?
  [ "$code" -eq 0 ] && return
  log "startup failed; last lines of each log:"
  for f in "$ROOT"/logs/*.log; do
    [ -f "$f" ] && { echo "--- $f"; tail -n 20 "$f"; }
  done
  if [ -z "${E2E_KEEP_ON_FAILURE:-}" ]; then
    log "tearing down (set E2E_KEEP_ON_FAILURE=1 to keep $ROOT)"
    bash "$here/down.sh" || true
  fi
}
trap on_exit EXIT

# Children start from an empty environment so nothing from the caller's shell
# (AWS, Slack, box-provisioning config) reaches the stack.
base_env=(
  "HOME=$ROOT/orchestrator-home" "USER=$USER_NAME" "LOGNAME=$USER_NAME"
  "PATH=$PATH" "LANG=${LANG:-C.UTF-8}" "TMPDIR=$ROOT/tmp" "TERMAG_E2E_ROOT=$ROOT"
)

wait_http() {
  local url=$1 name=$2 i
  for i in $(seq 1 120); do
    curl -sf -o /dev/null "$url" && return 0
    kill -0 "$(cat "$ROOT/pids/$name.pid")" 2>/dev/null || die "$name exited during startup (logs/$name.log)"
    sleep 0.5
  done
  die "$name did not answer $url within 60s"
}

cat >"$ROOT/stack.env" <<EOF
PG_BIN=$PG_BIN
PORT=$PORT
BOX_NET_PORT=$BOX_NET_PORT
FRONTEND_PORT=$FRONTEND_PORT
PG_PORT=$PG_PORT
BOXES=$BOXES
EOF
fakes_record

log "generating the Prisma client"
(cd "$repo/backend" && env -i "${base_env[@]}" CHECKPOINT_DISABLE=1 node_modules/.bin/prisma generate) >"$ROOT/logs/prisma-generate.log" 2>&1 \
  || die "prisma generate failed (logs/prisma-generate.log)"

log "starting postgres on 127.0.0.1:$PG_PORT"
env -i "${base_env[@]}" "$PG_BIN/initdb" -D "$ROOT/pg/data" -U termag --auth=trust -E UTF8 >"$ROOT/logs/initdb.log"
env -i "${base_env[@]}" "$PG_BIN/pg_ctl" -D "$ROOT/pg/data" -l "$ROOT/logs/postgres.log" -w \
  -o "-p $PG_PORT -k $ROOT/pg -c listen_addresses=127.0.0.1" start >/dev/null
env -i "${base_env[@]}" "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U termag termag

umask 077
cat >"$ROOT/backend.env" <<EOF
NODE_ENV=development
PORT=$PORT
BIND_HOST=127.0.0.1
BASE_PATH=/termag
FRONTEND_URL=http://localhost:$FRONTEND_PORT
DATABASE_URL=postgresql://termag@127.0.0.1:$PG_PORT/termag
SESSION_SECRET=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
AUTH_MODE=local
ALLOWED_USERS=$EMAIL:$USER_NAME
LOCAL_SESSIONS_ENABLED=false
AGENT_WS_URL=ws://127.0.0.1:$PORT/termag/ws/agent
TMUX_POLLER_USAGE_FILE=$ROOT/tmux-poller-usage.json
CHECKPOINT_DISABLE=1
EOF
umask 022
fakes_before_backend
backend_env=("${base_env[@]}" "DOTENV_CONFIG_PATH=$ROOT/backend.env")

log "syncing the schema (npm run db:push equivalent)"
(cd "$repo/backend" && env -i "${backend_env[@]}" "${dbpush_extra[@]}" node_modules/.bin/tsx src/scripts/dbPush.ts) >"$ROOT/logs/db-push.log" 2>&1 \
  || die "schema sync failed (logs/db-push.log)"
fakes_after_schema

log "starting the backend on 127.0.0.1:$PORT"
start_daemon backend "$repo/backend" env -i "${backend_env[@]}" "${backend_extra[@]}" node_modules/.bin/tsx src/index.ts
wait_http "http://127.0.0.1:$PORT/termag/health" backend
fakes_after_backend

# Boxes reach the stack through box-network.mjs, so the backend sees them
# from another address, as it sees real boxes (docs/e2e-stack.md).
read -r box_scheme box_host box_upstream <<<"$box_front_door"
log "starting the box network on 127.0.0.1:$BOX_NET_PORT (boxes appear as 127.0.0.2)"
start_daemon box-network "$here" env -i "${base_env[@]}" node box-network.mjs "$BOX_NET_PORT" "$box_upstream"
for _ in $(seq 1 40); do port_in_use "$BOX_NET_PORT" && break; sleep 0.25; done
port_in_use "$BOX_NET_PORT" || die "the box network did not listen on $BOX_NET_PORT (logs/box-network.log)"
agent_ws_url="$box_scheme://$box_host:$BOX_NET_PORT/termag/ws/agent"

log "starting the frontend on localhost:$FRONTEND_PORT"
start_daemon frontend "$repo/frontend" env -i "${base_env[@]}" \
  "E2E_BACKEND_URL=http://127.0.0.1:$PORT" "E2E_VITE_CACHE_DIR=$ROOT/vite-cache" \
  node_modules/.bin/vite --config vite.e2e.config.ts --port "$FRONTEND_PORT" --strictPort
wait_http "http://localhost:$FRONTEND_PORT/termag/" frontend

# Everything box.sh needs to start a box later, including one the EC2 launch
# fake starts after up.sh has exited.
{
  declare -p ROOT REAL_TMUX EMAIL agent_ws_url base_env box_extra
  declare -p FAKE_CLAUDE FAKE_GITHUB GITHUB_PORT TMUX_FAULTS
} >"$ROOT/box.env"

api_env=("${base_env[@]}" "E2E_API_URL=http://127.0.0.1:$PORT/termag" "E2E_AGENT_WS_URL=$agent_ws_url"
  "E2E_EC2_BOXES=$EC2_BOXES" "E2E_EC2_LAUNCH=$EC2_LAUNCH")
env -i "${api_env[@]}" node "$here/seed.mjs" boxes "$ROOT" "$BOXES"

# With E2E_EC2_LAUNCH the ec2 boxes are started by the launch fake instead.
first_box=1
[ -z "$EC2_LAUNCH" ] || first_box=$((EC2_BOXES + 1))
for i in $(seq "$first_box" "$BOXES"); do
  bash "$here/box.sh" "$ROOT" "box-$i"
done
fakes_after_boxes

env -i "${api_env[@]}" node "$here/seed.mjs" project "$ROOT"

trap - EXIT
cat <<EOF

[e2e] stack is up
  UI        http://localhost:$FRONTEND_PORT/termag/   (click "Sign in": signs in as $EMAIL)
  backend   http://127.0.0.1:$PORT/termag
  postgres  postgresql://termag@127.0.0.1:$PG_PORT/termag
  boxes     $BOXES under $ROOT/boxes (logs/box-N.log), reaching the stack from 127.0.0.2 via 127.0.0.1:$BOX_NET_PORT
  root      $ROOT
EOF
fakes_summary
echo "  status    make e2e-status        teardown  make e2e-down"
