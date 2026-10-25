#!/usr/bin/env bash
# Report whether the local e2e stack is up, the state of each process, and for
# each box agent its open fds, /dev/ptmx fds, tmux clients and child processes.
# `watch -n1 make e2e-status` gives a live view.
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"

root=$(e2e_root) || { log "no e2e stack is up"; exit 1; }
# shellcheck disable=SC1091
. "$root/stack.env"

echo "root      $root"
echo "UI        http://localhost:$FRONTEND_PORT/termag/"
[ -n "${FAKES:-}" ] && echo "fakes     $FAKES"
rc=0
for f in "$root"/pids/*.pid; do
  name=$(basename "$f" .pid)
  pid=$(cat "$f")
  if kill -0 "$pid" 2>/dev/null; then state=running
  # A box unit the systemctl stand-in ran (<box>.<unit>.pid) is a oneshot.
  elif [[ $name == *.service ]]; then state=exited
  else state=DEAD; rc=1; fi
  extra=
  box="$root/boxes/$name"
  if [ "$state" = running ] && [ -d "$box" ]; then
    fds=$(find "/proc/$pid/fd" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l)
    ptmx=$(find "/proc/$pid/fd" -mindepth 1 -maxdepth 1 -lname /dev/ptmx 2>/dev/null | wc -l)
    clients=$("$box/bin/tmux" list-clients 2>/dev/null | wc -l)
    kids=$(pgrep -P "$pid" | wc -l)
    fault=$(cat "$box/tmux-fault" 2>/dev/null)
    extra=$(printf 'fds %-4s ptmx %-3s tmux-clients %-3s children %-3s%s' "$fds" "$ptmx" "$clients" "$kids" "${fault:+ fault: $fault}")
  fi
  printf '%-12s %-8s %-20s %s\n' "$name" "$state" "logs/$name.log" "$extra"
done
if "$PG_BIN/pg_isready" -q -h 127.0.0.1 -p "$PG_PORT"; then
  printf '%-12s %-8s %s\n' postgres running logs/postgres.log
else
  printf '%-12s %-8s %s\n' postgres DEAD logs/postgres.log; rc=1
fi
if curl -sf "http://127.0.0.1:$PORT/termag/health" >/dev/null; then echo "health    ok"; else echo "health    FAILING"; rc=1; fi
exit $rc
