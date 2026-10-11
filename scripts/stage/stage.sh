#!/usr/bin/env bash
# A persistent staging termag on this box, mirroring the per-user agent that
# already runs here. Guide: docs/stage.md.
#
#   stage.sh up                  start (or refresh) the stack from this checkout
#   stage.sh sync [branch...]    reset the checkout to the base, merge branches, restart
#   stage.sh add <branch>...     merge more branches without resetting
#   stage.sh restart [unit...]   backend frontend agent (default), relay, postgres
#   stage.sh seed                create the projects and workstreams this box's
#                                tmux sessions belong to (idempotent)
#   stage.sh status | logs [unit] [-f] | down | reset-db | uninstall [--purge]
#
# Env (read on `up`, kept in $STAGE_ROOT/stage.env afterwards):
#   STAGE_ROOT          state root (default ~/.termag-stage)
#   STAGE_PORT          backend port (default 3070); the relay takes the next port
#   STAGE_FRONTEND_PORT Vite port, the one to forward to your laptop (default 5190)
#   STAGE_PG_PORT       private Postgres port (default 55470)
#   STAGE_EMAIL         the sign-in identity (default stage@termag.local); the
#                       unix half of ALLOWED_USERS is always $(id -un)
#   STAGE_BOX_NAME      how this box is named in staging (default hostname -s)
#   STAGE_BASE          what `sync` resets to (default origin/main)
#   STAGE_HOOKS=0       do not feed status events to staging (no mirror line in
#                       ~/.config/termag/status-mirrors, no hook entries)
#   STAGE_PG_BIN        PostgreSQL server binaries, if not found automatically
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
ROOT=${STAGE_ROOT:-$HOME/.termag-stage}
UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
UNITS=(postgres backend relay frontend agent)
PREFIX=termag-stage

log() { printf '[stage] %s\n' "$*"; }
die() { printf '[stage] error: %s\n' "$*" >&2; exit 1; }

# systemctl --user needs the user bus; an SSM or cron shell may lack both.
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}
sc() { systemctl --user "$@"; }
unit() { printf '%s-%s.service' "$PREFIX" "$1"; }
unit_active() { sc is-active --quiet "$(unit "$1")"; }

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

pg_bindir() {
  if [ -n "${STAGE_PG_BIN:-}" ]; then printf '%s\n' "$STAGE_PG_BIN"; return; fi
  if command -v pg_config >/dev/null 2>&1 && [ -x "$(pg_config --bindir)/initdb" ]; then
    pg_config --bindir; return
  fi
  find /usr/lib/postgresql -maxdepth 2 -name bin -type d 2>/dev/null | sort -V | tail -n1
}

# ── configuration ────────────────────────────────────────────────────────────
# stage.env is written by `up` and sourced by every other command, so they work
# from any directory and keep working after the checkout path changes.
load_env() {
  [ -f "$ROOT/stage.env" ] || die "no staging stack under $ROOT; run 'make stage-up' first"
  # shellcheck disable=SC1091
  . "$ROOT/stage.env"
}

write_env() {
  cat >"$ROOT/stage.env" <<EOT
REPO=$REPO
BRANCH=$BRANCH
PORT=$PORT
RELAY_PORT=$RELAY_PORT
FRONTEND_PORT=$FRONTEND_PORT
PG_PORT=$PG_PORT
EMAIL=$EMAIL
BOX_NAME=$BOX_NAME
BASE=$BASE
PG_BIN=$PG_BIN
NODE=$NODE
EOT
}

api_url() { printf 'http://127.0.0.1:%s/termag' "$PORT"; }

# Sign in through the loopback-only local login and run one API call. The
# session cookie lives in a 0600 file under the root for the call's duration.
api() {
  local method=$1 path=$2 body=${3:-} jar code rc=0
  jar=$(mktemp "$ROOT/tmp/cookie.XXXXXX")
  code=$(curl -s -o /dev/null -w '%{http_code}' -c "$jar" "$(api_url)/auth/login") || code=
  if [ "$code" != 302 ]; then rm -f "$jar"; die "local sign-in failed (HTTP ${code:-none}); is the backend up?"; fi
  if [ -n "$body" ]; then
    curl -sf -b "$jar" -X "$method" -H 'content-type: application/json' -d "$body" "$(api_url)/api$path" || rc=$?
  else
    curl -sf -b "$jar" -X "$method" "$(api_url)/api$path" || rc=$?
  fi
  rm -f "$jar"
  return $rc
}

# ── units ────────────────────────────────────────────────────────────────────
write_units() {
  local nodedir; nodedir=$(dirname "$NODE")
  mkdir -p "$UNIT_DIR"

  cat >"$UNIT_DIR/$PREFIX.target" <<EOT
[Unit]
Description=termag staging stack (docs/stage.md)

[Install]
WantedBy=default.target
EOT

  cat >"$UNIT_DIR/$(unit postgres)" <<EOT
[Unit]
Description=termag staging: private Postgres on 127.0.0.1:$PG_PORT
PartOf=$PREFIX.target

[Service]
ExecStart=$PG_BIN/postgres -D $ROOT/pg/data -p $PG_PORT -k $ROOT/pg -c listen_addresses=127.0.0.1
StandardOutput=append:$ROOT/logs/postgres.log
StandardError=inherit
Restart=on-failure

[Install]
WantedBy=$PREFIX.target
EOT

  # HOME is a private directory so the backend never reads ~/.aws, ~/.npmrc or
  # anything else of yours; its whole configuration is backend.env.
  cat >"$UNIT_DIR/$(unit backend)" <<EOT
[Unit]
Description=termag staging: backend on 127.0.0.1:$PORT (from $REPO)
PartOf=$PREFIX.target
After=$(unit postgres)
Requires=$(unit postgres)

[Service]
WorkingDirectory=$REPO/backend
Environment=HOME=$ROOT/home
Environment=PATH=$nodedir:/usr/local/bin:/usr/bin:/bin
Environment=DOTENV_CONFIG_PATH=$ROOT/backend.env
Environment=CHECKPOINT_DISABLE=1
ExecStartPre=$ROOT/bin/backend-prestart
ExecStart=$NODE node_modules/.bin/tsx src/index.ts
StandardOutput=append:$ROOT/logs/backend.log
StandardError=inherit
Restart=on-failure
RestartSec=2

[Install]
WantedBy=$PREFIX.target
EOT

  # The agent and the Claude hooks reach the backend through this relay, which
  # dials it from 127.0.0.2: a loopback peer is "the orchestrator itself" to the
  # status route (filed under no box), another address is a box (scripts/e2e/box-network.mjs).
  cat >"$UNIT_DIR/$(unit relay)" <<EOT
[Unit]
Description=termag staging: box relay 127.0.0.1:$RELAY_PORT -> :$PORT from 127.0.0.2
PartOf=$PREFIX.target
After=$(unit backend)

[Service]
WorkingDirectory=$REPO/scripts/e2e
ExecStart=$NODE box-network.mjs $RELAY_PORT $PORT
StandardOutput=append:$ROOT/logs/relay.log
StandardError=inherit
Restart=on-failure

[Install]
WantedBy=$PREFIX.target
EOT

  cat >"$UNIT_DIR/$(unit frontend)" <<EOT
[Unit]
Description=termag staging: Vite dev server on localhost:$FRONTEND_PORT
PartOf=$PREFIX.target
After=$(unit backend)

[Service]
WorkingDirectory=$REPO/frontend
Environment=HOME=$ROOT/home
Environment=PATH=$nodedir:/usr/local/bin:/usr/bin:/bin
Environment=E2E_BACKEND_URL=http://127.0.0.1:$PORT
Environment=E2E_VITE_CACHE_DIR=$ROOT/vite-cache
ExecStart=$NODE node_modules/.bin/vite --config vite.e2e.config.ts --port $FRONTEND_PORT --strictPort
StandardOutput=append:$ROOT/logs/frontend.log
StandardError=inherit
Restart=on-failure

[Install]
WantedBy=$PREFIX.target
EOT

  # The mirror agent: your HOME, your tmux server, your ~/termag/projects, run
  # from this checkout's agent.js against the staging backend. KillMode=process
  # for the same reason as deploy/termag-agent.service: a restart must never
  # take the shared tmux server down. Credential delivery is pointed away from
  # /etc and from your own ~/.claude/settings.json, so staging can never rewrite
  # this box's real Claude settings.
  cat >"$UNIT_DIR/$(unit agent)" <<EOT
[Unit]
Description=termag staging: mirror per-user agent (from $REPO)
PartOf=$PREFIX.target
After=$(unit relay)

[Service]
WorkingDirectory=$REPO/agent
Environment=PATH=$nodedir:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=TERMAG_CLAUDE_SETTINGS=$ROOT/claude/settings.json
Environment=TERMAG_CLAUDE_MANAGED_SETTINGS=$ROOT/etc/claude-code/managed-settings.json
Environment=TERMAG_CREDENTIALS_SUDO=
ExecStart=$NODE agent.js $ROOT/agent.config.json
StandardOutput=append:$ROOT/logs/agent.log
StandardError=inherit
Restart=always
RestartSec=5
KillMode=process

[Install]
WantedBy=$PREFIX.target
EOT

  sc daemon-reload
  sc enable --quiet "$PREFIX.target"
  local u; for u in "${UNITS[@]}"; do sc enable --quiet "$(unit "$u")"; done
}

# Run before every backend start: regenerate the Prisma client when the schema
# changed, then converge the database to it (prisma db push, data loss accepted:
# this is an integration branch that gets reset and re-merged).
write_prestart() {
  cat >"$ROOT/bin/backend-prestart" <<EOT
#!/usr/bin/env bash
set -euo pipefail
cd "$REPO/backend"
stamp="$ROOT/state/schema.sha256"
want=\$(sha256sum prisma/schema.prisma | cut -d' ' -f1)
if [ ! -f node_modules/.prisma/client/index.js ] || [ "\$(cat "\$stamp" 2>/dev/null)" != "\$want" ]; then
  echo "[prestart] prisma generate"
  node_modules/.bin/prisma generate >/dev/null
  printf '%s\n' "\$want" >"\$stamp"
fi
echo "[prestart] schema sync (db push)"
node_modules/.bin/tsx src/scripts/dbPush.ts
EOT
  chmod 0755 "$ROOT/bin/backend-prestart"
}

write_backend_env() {
  local secret
  secret=$(grep -s '^SESSION_SECRET=' "$ROOT/backend.env" | cut -d= -f2- || true)
  [ -n "$secret" ] || secret=$("$NODE" -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')
  umask 077
  cat >"$ROOT/backend.env" <<EOT
# Written by scripts/stage/stage.sh on every 'up'. Put your own settings in
# backend.local.env next to this file; it is appended below and never touched.
NODE_ENV=development
PORT=$PORT
BIND_HOST=127.0.0.1
BASE_PATH=/termag
FRONTEND_URL=http://localhost:$FRONTEND_PORT
DATABASE_URL=postgresql://termag@127.0.0.1:$PG_PORT/termag
SESSION_SECRET=$secret
AUTH_MODE=local
ALLOWED_USERS=$EMAIL:$(id -un)
LOCAL_SESSIONS_ENABLED=false
AGENT_WS_URL=ws://127.0.0.1:$RELAY_PORT/termag/ws/agent
TMUX_POLLER_USAGE_FILE=$ROOT/tmux-poller-usage.json
CHECKPOINT_DISABLE=1
EOT
  if [ -f "$ROOT/backend.local.env" ]; then
    printf '\n# --- backend.local.env ---\n' >>"$ROOT/backend.env"
    cat "$ROOT/backend.local.env" >>"$ROOT/backend.env"
  fi
  umask 022
}

wait_http() {
  local url=$1 name=$2 i
  for i in $(seq 1 120); do
    curl -sf -o /dev/null "$url" && return 0
    unit_active "$name" || die "$name is not running (see $ROOT/logs/$name.log)"
    sleep 0.5
  done
  die "$name did not answer $url within 60s (see $ROOT/logs/$name.log)"
}

# A package's node_modules must be a real directory. A symlink (one was once
# committed, and git replaces an ignored directory with a tracked path without
# asking) or a missing directory leaves the unit crash-looping on require(), so
# both are repaired here, on every up and restart.
install_deps() {
  local d nm
  for d in backend frontend agent; do
    nm="$REPO/$d/node_modules"
    if [ -L "$nm" ]; then
      log "$d/node_modules is a symlink ($(readlink "$nm")); replacing it with an install"
      rm -f "$nm"
    fi
    if [ ! -d "$nm" ]; then
      log "installing $d dependencies"
      npm --prefix "$REPO/$d" ci --no-audit --no-fund
    fi
  done
}

# The staged deploy/termag-status is what the staging hook entries run, so a
# change to it is exercised here too.
install_bin() {
  install -m 0755 "$REPO/deploy/termag-status" "$ROOT/bin/termag-status"
}

# ── this box, in staging ─────────────────────────────────────────────────────
# Register this host as an external box once; the token is written to
# agent.config.json (0600) and never printed. The URL is the relay's.
register_box() {
  if [ -f "$ROOT/agent.config.json" ]; then
    # Older configs: make sure the mirror agent advertises no credential capability.
    if [ "$(jq -r '.credentials' "$ROOT/agent.config.json")" != false ]; then
      umask 077; jq -c '. + {credentials:false}' "$ROOT/agent.config.json" >"$ROOT/tmp/agent.config.json" \
        && mv "$ROOT/tmp/agent.config.json" "$ROOT/agent.config.json"; umask 022
    fi
    return 0
  fi
  log "registering this box in staging as '$BOX_NAME'"
  local out
  out=$(api POST /instances "$(jq -nc --arg n "$BOX_NAME" '{name:$n, kind:"external"}')") \
    || die "POST /api/instances failed; a box named '$BOX_NAME' may already exist in staging (stage.sh reset-db starts over)"
  umask 077
  jq -c --arg url "ws://127.0.0.1:$RELAY_PORT/termag/ws/agent" \
    '{termag_url:$url, token:.token, reconnect_interval_seconds:5, path_remap:{}, credentials:false}' <<<"$out" >"$ROOT/agent.config.json"
  umask 022
  jq -c '{id:.instance.id, name:.instance.name}' <<<"$out" >"$ROOT/box.json"
}

box_status() {
  local id
  id=$(jq -r .id "$ROOT/box.json" 2>/dev/null) || return 1
  api GET /instances | jq -r --arg id "$id" '.[] | select(.id==$id) | .status'
}

wait_box_ready() {
  local i s
  for i in $(seq 1 60); do
    s=$(box_status 2>/dev/null || true)
    [ "$s" = ready ] && return 0
    sleep 0.5
  done
  log "warning: box is '${s:-unknown}' rather than ready after 30s (see $ROOT/logs/agent.log)"
}

# ── Status mirror ────────────────────────────────────────────────────────────
# The box's Claude hooks and pi's status extension both post to the prod
# orchestrator through ~/.local/bin/termag-status. That script also posts to
# every agent config listed in ~/.config/termag/status-mirrors, so one line
# naming the staging agent config gives staging a copy of every status event
# from every provider, including panes that are already running. Older
# installed copies of termag-status (before --print-mirrors) do not read the
# file; for those, the Claude-only fallback below duplicates the hook entries.
MIRRORS_FILE=$HOME/.config/termag/status-mirrors
INSTALLED_STATUS=$HOME/.local/bin/termag-status

mirrors_supported() { [ -x "$INSTALLED_STATUS" ] && grep -q -- '--print-mirrors' "$INSTALLED_STATUS"; }

install_mirror() {
  mkdir -p "$(dirname "$MIRRORS_FILE")"
  [ -f "$MIRRORS_FILE" ] || printf '# termag status mirrors: one agent config path per line (deploy/termag-status)\n' >"$MIRRORS_FILE"
  grep -qxF "$ROOT/agent.config.json" "$MIRRORS_FILE" || printf '%s\n' "$ROOT/agent.config.json" >>"$MIRRORS_FILE"
  log "status mirror: $ROOT/agent.config.json listed in $MIRRORS_FILE"
}

remove_mirror() {
  [ -f "$MIRRORS_FILE" ] || return 0
  grep -qxF "$ROOT/agent.config.json" "$MIRRORS_FILE" || return 0
  local tmp; tmp=$(mktemp "$ROOT/tmp/mirrors.XXXXXX")
  grep -vxF "$ROOT/agent.config.json" "$MIRRORS_FILE" >"$tmp" || true
  mv "$tmp" "$MIRRORS_FILE"
  log "status mirror: removed from $MIRRORS_FILE"
}

# Either the mirror line (preferred) or the hook-entry fallback, never both:
# with both, every Claude event would reach staging twice.
install_status_feed() {
  [ "${STAGE_HOOKS:-1}" = 0 ] && return 0
  if mirrors_supported; then
    install_mirror
    remove_hooks
  else
    log "installed termag-status predates status mirrors; falling back to duplicated Claude hook entries (pi status will not reach staging until ~/src/termag is pulled and termag-reconcile has run)"
    install_hooks
  fi
}

# ── Claude hooks (fallback) ──────────────────────────────────────────────────
# Staging gets Claude's events by adding a second entry per hook that runs the
# staged termag-status with the staging agent config. Entries are recognised by
# the staged binary's path, so they can be replaced or removed cleanly.
HOOK_FROM='"$HOME/.local/bin/termag-status"'
hook_to() { printf 'TERMAG_AGENT_CONFIG="%s" "%s"' "$ROOT/agent.config.json" "$ROOT/bin/termag-status"; }

hooks_strip() {  # stdin: settings json → stdout: without staging entries
  jq --arg marker "$ROOT/bin/termag-status" '
    if .hooks then
      .hooks |= with_entries(.value |= map(select((.hooks // []) | any(.command | contains($marker)) | not)))
      | .hooks |= with_entries(select(.value | length > 0))
    else . end'
}

install_hooks() {
  [ "${STAGE_HOOKS:-1}" = 0 ] && return 0
  local settings=$HOME/.claude/settings.json tmp
  mkdir -p "$HOME/.claude"
  [ -f "$settings" ] || printf '{}\n' >"$settings"
  [ -f "$ROOT/claude-settings.before-stage.json" ] || cp "$settings" "$ROOT/claude-settings.before-stage.json"
  tmp=$(mktemp "$ROOT/tmp/settings.XXXXXX")
  hooks_strip <"$settings" | jq --slurpfile tpl "$REPO/deploy/claude-settings.json" \
      --arg from "$HOOK_FROM" --arg to "$(hook_to)" '
    .hooks = ((.hooks // {}) as $mine
      | ($tpl[0].hooks | with_entries(.value |= map(.hooks |= map(.command |= (split($from) | join($to)))))) as $stage
      | reduce ($stage | keys[]) as $k ($mine; .[$k] = ((.[$k] // []) + $stage[$k])))' >"$tmp"
  jq -e .hooks "$tmp" >/dev/null || die "could not build the staging hook entries"
  mv "$tmp" "$settings"
  log "Claude hooks: staging entries installed in $settings (STAGE_HOOKS=0 to skip)"
}

remove_hooks() {
  local settings=$HOME/.claude/settings.json tmp
  [ -f "$settings" ] || return 0
  grep -qF "$ROOT/bin/termag-status" "$settings" || return 0
  tmp=$(mktemp "$ROOT/tmp/settings.XXXXXX")
  hooks_strip <"$settings" >"$tmp" && mv "$tmp" "$settings"
  log "Claude hooks: staging entries removed from $settings"
}

# ── commands ─────────────────────────────────────────────────────────────────
cmd_up() {
  for c in node npm tmux jq curl git systemctl; do
    command -v "$c" >/dev/null 2>&1 || die "missing '$c'"
  done
  sc show-environment >/dev/null 2>&1 || die "systemctl --user is not reachable; is lingering enabled for $(id -un)?"

  mkdir -p "$ROOT"/{pg,home,tmp,bin,logs,state,vite-cache,etc/claude-code}
  chmod 0700 "$ROOT"
  rm -f "$ROOT"/tmp/cookie.* "$ROOT"/tmp/settings.*
  printf '%s\n' "$ROOT" >"$ROOT/.termag-stage"
  if [ -f "$ROOT/stage.env" ]; then
    # shellcheck disable=SC1091
    . "$ROOT/stage.env"
  fi
  REPO=$repo
  BRANCH=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
  PORT=${STAGE_PORT:-${PORT:-3070}}
  RELAY_PORT=$((PORT + 1))
  FRONTEND_PORT=${STAGE_FRONTEND_PORT:-${FRONTEND_PORT:-5190}}
  PG_PORT=${STAGE_PG_PORT:-${PG_PORT:-55470}}
  EMAIL=${STAGE_EMAIL:-${EMAIL:-stage@termag.local}}
  BOX_NAME=${STAGE_BOX_NAME:-${BOX_NAME:-$(hostname -s)}}
  BASE=${STAGE_BASE:-${BASE:-origin/main}}
  PG_BIN=$(pg_bindir)
  [ -x "$PG_BIN/initdb" ] || die "no PostgreSQL server binaries found; install postgresql or set STAGE_PG_BIN"
  NODE=$(command -v node)
  [ "$BRANCH" != main ] || log "warning: this checkout is on main; 'sync' refuses to reset main, use an integration branch"

  local p u
  for p in "$PORT:backend" "$RELAY_PORT:relay" "$FRONTEND_PORT:frontend" "$PG_PORT:postgres"; do
    u=${p#*:}; p=${p%%:*}
    if port_in_use "$p" && ! unit_active "$u"; then
      die "port $p is in use by something other than $(unit "$u"); set STAGE_PORT / STAGE_FRONTEND_PORT / STAGE_PG_PORT"
    fi
  done

  install_deps
  write_env
  write_backend_env
  write_prestart
  install_bin
  write_units

  if [ ! -f "$ROOT/pg/data/PG_VERSION" ]; then
    log "initialising postgres under $ROOT/pg/data"
    "$PG_BIN/initdb" -D "$ROOT/pg/data" -U termag --auth=trust -E UTF8 >"$ROOT/logs/initdb.log"
  fi
  sc start "$(unit postgres)"
  for _ in $(seq 1 60); do "$PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$PG_PORT" && break; sleep 0.5; done
  "$PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$PG_PORT" || die "postgres did not come up (see $ROOT/logs/postgres.log)"
  if ! "$PG_BIN/psql" -h 127.0.0.1 -p "$PG_PORT" -U termag -lqtA | cut -d'|' -f1 | grep -qx termag; then
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$PG_PORT" -U termag termag
  fi

  log "starting the backend on 127.0.0.1:$PORT (schema sync first)"
  sc restart "$(unit backend)"
  wait_http "$(api_url)/health" backend
  sc restart "$(unit relay)"
  for _ in $(seq 1 40); do port_in_use "$RELAY_PORT" && break; sleep 0.25; done
  port_in_use "$RELAY_PORT" || die "the relay did not listen on $RELAY_PORT (see $ROOT/logs/relay.log)"
  log "starting the frontend on localhost:$FRONTEND_PORT"
  sc restart "$(unit frontend)"
  wait_http "http://localhost:$FRONTEND_PORT/termag/" frontend

  register_box
  log "starting the mirror agent"
  sc restart "$(unit agent)"
  wait_box_ready
  install_status_feed
  cmd_status
}

cmd_status() {
  load_env
  echo "root       $ROOT"
  echo "checkout   $REPO ($BRANCH @ $(git -C "$REPO" rev-parse --short HEAD))"
  local merged
  merged=$(git -C "$REPO" log --merges --first-parent --format='%s' "$BASE..HEAD" 2>/dev/null | sed -n 's/^stage: merge //p' | paste -sd' ' -)
  echo "merged     ${merged:-(nothing beyond $BASE)}"
  local u state rc=0
  for u in "${UNITS[@]}"; do
    state=$(sc is-active "$(unit "$u")" 2>/dev/null || true)
    [ "$state" = active ] || rc=1
    printf '%-10s %-9s logs/%s.log\n' "$u" "$state" "$u"
  done
  if curl -sf "$(api_url)/health" >/dev/null; then echo "health     ok"; else echo "health     FAILING"; rc=1; fi
  if [ -f "$ROOT/box.json" ]; then
    echo "box        $(jq -r .name "$ROOT/box.json") → $(box_status 2>/dev/null || echo unknown)"
  fi
  echo "UI         http://localhost:$FRONTEND_PORT/termag/   (Sign in = $EMAIL)"
  echo "backend    $(api_url)"
  echo "forward    laptop: forward local port $FRONTEND_PORT to this box's $FRONTEND_PORT (ssh -L or SSM), then open the UI"
  return $rc
}

cmd_restart() {
  load_env
  local units=("$@")
  [ ${#units[@]} -gt 0 ] || units=(backend frontend agent)
  local u
  for u in "${units[@]}"; do
    case " ${UNITS[*]} " in *" $u "*) ;; *) die "unknown unit '$u' (one of: ${UNITS[*]})" ;; esac
  done
  install_deps
  install_bin
  for u in "${units[@]}"; do
    log "restarting $u"
    sc restart "$(unit "$u")"
    case $u in
      backend)  wait_http "$(api_url)/health" backend ;;
      frontend) wait_http "http://localhost:$FRONTEND_PORT/termag/" frontend ;;
      agent)    wait_box_ready ;;
    esac
  done
}

lock_hashes() { { cat "$REPO"/{backend,frontend,agent}/package-lock.json 2>/dev/null || true; } | sha256sum; }

merge_one() {  # merge_one <branch>; prints nothing, returns 1 on failure (reason on stderr)
  local b=$1 ref
  if git -C "$REPO" show-ref --verify --quiet "refs/heads/$b"; then ref=$b
  elif git -C "$REPO" show-ref --verify --quiet "refs/remotes/origin/$b"; then ref=origin/$b
  else log "  $b: no such branch (local or origin)"; return 1; fi
  if git -C "$REPO" merge --no-ff --no-edit -m "stage: merge $b" "$ref" >/dev/null 2>"$ROOT/tmp/merge.err"; then
    log "  merged $b ($(git -C "$REPO" rev-parse --short "$ref"))"
  else
    git -C "$REPO" merge --abort 2>/dev/null || true
    log "  $b: CONFLICT, skipped ($(grep -m1 CONFLICT "$ROOT/tmp/merge.err" || echo see git))"
    return 1
  fi
}

after_merge() {
  local before=$1
  if [ "$(lock_hashes)" != "$before" ]; then
    log "lockfiles changed; reinstalling dependencies"
    local d
    for d in backend frontend agent; do npm --prefix "$REPO/$d" ci --no-audit --no-fund >"$ROOT/logs/npm-$d.log" 2>&1 || die "npm ci failed in $d (see logs/npm-$d.log)"; done
  fi
  cmd_restart backend frontend agent
}

check_tree() {
  local branch
  branch=$(git -C "$REPO" rev-parse --abbrev-ref HEAD)
  [ "$branch" = "$BRANCH" ] || die "checkout is on '$branch'; staging was brought up from '$BRANCH' (run 'up' again to adopt the new branch)"
  [ "$branch" != main ] || die "refusing to reset 'main'; put the staging checkout on an integration branch"
  [ -z "$(git -C "$REPO" status --porcelain)" ] || die "the staging checkout has local changes; commit or discard them first:
$(git -C "$REPO" status --short | head -20)"
}

cmd_sync() {
  load_env
  check_tree
  if [ $# -gt 0 ]; then printf '%s\n' "$@" >"$ROOT/branches"; fi
  local branches=()
  [ -f "$ROOT/branches" ] && mapfile -t branches <"$ROOT/branches"
  local before; before=$(lock_hashes)
  case $BASE in origin/*) log "fetching origin"; git -C "$REPO" fetch origin --prune --quiet ;; esac
  log "resetting $BRANCH to $BASE ($(git -C "$REPO" rev-parse --short "$BASE"))"
  git -C "$REPO" reset --hard --quiet "$BASE"
  local b failed=()
  for b in "${branches[@]}"; do
    [ -n "$b" ] || continue
    merge_one "$b" || failed+=("$b")
  done
  after_merge "$before"
  if [ ${#failed[@]} -gt 0 ]; then
    log "not merged: ${failed[*]} — resolve on the branch (or merge $BASE into it), then 'sync' again"
    return 1
  fi
}

cmd_add() {
  load_env
  check_tree
  [ $# -gt 0 ] || die "usage: stage.sh add <branch>..."
  local before; before=$(lock_hashes)
  local b failed=()
  for b in "$@"; do
    if merge_one "$b"; then
      grep -qxF "$b" "$ROOT/branches" 2>/dev/null || printf '%s\n' "$b" >>"$ROOT/branches"
    else failed+=("$b"); fi
  done
  after_merge "$before"
  [ ${#failed[@]} -eq 0 ] || { log "not merged: ${failed[*]}"; return 1; }
}

# Mirror seeding: every live `<user>-<project>[-<workstream>]-agent` session on
# this box becomes a project (and workstream) in staging, resolved against
# ~/termag/projects so a dash in a name is read the way the filesystem has it.
# Projects are created with a Claude agent workflow; the launch path probes the
# pane first, so a running agent of any provider is left as it is. Sessions a
# project does not have on this box are not created here.
cmd_seed() {
  load_env
  [ -f "$ROOT/box.json" ] || die "this box is not registered in staging yet; run 'up' first"
  local me box projects_root existing created=0 skipped=0
  me=$(id -un); box=$(jq -r .id "$ROOT/box.json"); projects_root=$HOME/termag/projects
  existing=$(api GET /projects)
  local session rest project ws dir branch pid
  while read -r session; do
    rest=${session#"$me-"}; rest=${rest%-agent}
    project=; ws=
    # Longest project directory name that prefixes the session's middle.
    for dir in "$projects_root"/*/; do
      local cand; cand=$(basename "$dir")
      if [ "$rest" = "$cand" ]; then project=$cand; ws=; break; fi
      case $rest in "$cand"-*)
        if [ -d "$projects_root/$cand/.worktrees/${rest#"$cand"-}" ] && [ ${#cand} -gt ${#project} ]; then
          project=$cand; ws=${rest#"$cand"-}
        fi ;;
      esac
    done
    if [ -z "$project" ]; then log "  $session: no matching directory under $projects_root, skipped"; skipped=$((skipped+1)); continue; fi
    pid=$(jq -r --arg n "$project" '.[] | select(.name==$n) | .id' <<<"$existing" | head -n1)
    if [ -z "$pid" ]; then
      pid=$(api POST /projects "$(jq -nc --arg n "$project" --arg i "$box" '{name:$n, instanceId:$i, initialAgent:{enabled:true, provider:"claude"}}')" | jq -r '.id // .project.id') \
        || { log "  $project: create failed"; skipped=$((skipped+1)); continue; }
      log "  project $project"; created=$((created+1))
      existing=$(api GET /projects)
    fi
    [ -n "$ws" ] || continue
    if jq -e --arg p "$pid" --arg w "$ws" '.[] | select(.id==$p) | .workstreams[]? | select(.name==$w)' <<<"$existing" >/dev/null; then continue; fi
    branch=$(git -C "$projects_root/$project/.worktrees/$ws" rev-parse --abbrev-ref HEAD 2>/dev/null || echo HEAD)
    if [ "$branch" = HEAD ]; then log "  $project/$ws: worktree is detached, skipped"; skipped=$((skipped+1)); continue; fi
    if api POST "/projects/$pid/workstreams" "$(jq -nc --arg n "$ws" --arg b "$branch" '{name:$n, branch:$b}')" >/dev/null; then
      log "  workstream $project/$ws ($branch)"; created=$((created+1))
      existing=$(api GET /projects)
    else
      log "  $project/$ws: create failed"; skipped=$((skipped+1))
    fi
  done < <(tmux list-sessions -F '#S' 2>/dev/null | grep -E "^$me-.+-agent\$" | sort)
  log "seed: $created created, $skipped skipped"
}

cmd_logs() {
  load_env
  local u=${1:-backend}; shift || true
  [ -f "$ROOT/logs/$u.log" ] || die "no log for '$u' (one of: ${UNITS[*]})"
  if [ "${1:-}" = -f ]; then tail -n 50 -f "$ROOT/logs/$u.log"; else tail -n 100 "$ROOT/logs/$u.log"; fi
}

cmd_down() {
  load_env
  log "stopping the staging stack (the database and the checkout stay)"
  sc stop "$(unit agent)" 2>/dev/null || true
  sc stop "$PREFIX.target" 2>/dev/null || true
  local u; for u in "${UNITS[@]}"; do sc stop "$(unit "$u")" 2>/dev/null || true; done
  # Nothing is listening now; stop the box's status posts from dialing it.
  # `up` puts the line back.
  remove_mirror
}

cmd_reset_db() {
  load_env
  log "dropping the staging database and this box's registration"
  sc stop "$(unit agent)" "$(unit backend)" 2>/dev/null || true
  sc start "$(unit postgres)"
  for _ in $(seq 1 60); do "$PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$PG_PORT" && break; sleep 0.5; done
  "$PG_BIN/dropdb" -h 127.0.0.1 -p "$PG_PORT" -U termag --if-exists termag
  rm -f "$ROOT/agent.config.json" "$ROOT/box.json"
  cmd_up
}

cmd_uninstall() {
  load_env
  cmd_down
  remove_hooks
  remove_mirror
  sc disable --quiet "$PREFIX.target" 2>/dev/null || true
  local u; for u in "${UNITS[@]}"; do sc disable --quiet "$(unit "$u")" 2>/dev/null || true; rm -f "$UNIT_DIR/$(unit "$u")"; done
  rm -f "$UNIT_DIR/$PREFIX.target"
  sc daemon-reload
  if [ "${1:-}" = --purge ]; then
    [ "$(head -n1 "$ROOT/.termag-stage" 2>/dev/null)" = "$ROOT" ] || die "$ROOT does not look like a staging root; not deleting it"
    rm -rf -- "$ROOT"
    log "removed $ROOT"
  else
    log "units removed; $ROOT (database, token, logs) kept — 'uninstall --purge' deletes it"
  fi
}

cmd=${1:-}; shift || true
case $cmd in
  up)        cmd_up ;;
  status)    cmd_status ;;
  restart)   cmd_restart "$@" ;;
  sync)      cmd_sync "$@" ;;
  add)       cmd_add "$@" ;;
  seed)      cmd_seed ;;
  logs)      cmd_logs "$@" ;;
  down)      cmd_down ;;
  reset-db)  cmd_reset_db ;;
  uninstall) cmd_uninstall "$@" ;;
  *) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
