#!/usr/bin/env bash
# Stop the local e2e stack started by up.sh and delete its temp root. Safe to
# run when nothing is up. Fails if any stack process survives.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"

if ! root=$(e2e_root); then
  if [ -e "$E2E_POINTER" ]; then
    log "removing stale pointer $E2E_POINTER"
    rm -f "$E2E_POINTER"
  fi
  log "no e2e stack is up"
  exit 0
fi
log "stopping the stack at $root"

# Boxes first, so their agents don't reconnect-loop against a dying backend.
for f in "$root"/pids/box-*.pid "$root"/pids/*.pid; do
  [ -f "$f" ] || continue
  kill -TERM -- "-$(cat "$f")" 2>/dev/null || true
done

# Floci in Docker (E2E_FLOCI=docker): its docker CLI got the TERM above and
# passes it on, but a container outlives a killed CLI. Only the container this
# root recorded, by its exact name and only when its label names this root.
if [ -f "$root/floci/container" ]; then
  bash "$here/fakes/floci.sh" docker-rm "$root" || log "warning: the Floci container in $root/floci/container may still be running"
fi

# A box whose socket path would be too long keeps it under <root>/tmux (box.sh).
for sock in "$root"/boxes/*/tmux.sock "$root"/tmux/*; do
  [ -S "$sock" ] && { tmux -S "$sock" kill-server 2>/dev/null || true; }
done

if [ -f "$root/pg/data/postmaster.pid" ]; then
  # shellcheck disable=SC1091
  PG_BIN=$(. "$root/stack.env" && printf '%s' "$PG_BIN")
  "$PG_BIN/pg_ctl" -D "$root/pg/data" -m fast -w stop >/dev/null 2>&1 || true
fi

survivors() { e2e_pids "$root" | grep -vx -e "$$" -e "${BASHPID:-$$}" || true; }
for _ in $(seq 1 20); do
  [ -z "$(survivors)" ] && break
  sleep 0.5
done
left=$(survivors)
if [ -n "$left" ]; then
  log "force-killing leftover processes: $(echo "$left" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill -KILL $left 2>/dev/null || true
  sleep 0.5
  left=$(survivors)
  [ -z "$left" ] || die "processes still running after teardown: $left"
fi

rm -rf -- "$root"
rm -f "$E2E_POINTER"
log "stopped; removed $root"
