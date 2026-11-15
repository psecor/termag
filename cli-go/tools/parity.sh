#!/bin/sh
# Runs read-only command lines with the Node CLI and the Go binary, side by side, and compares
# stdout, stderr and the exit code byte for byte. Read-only commands only: never put a write here.
#
# Usage: cli-go/tools/parity.sh [<go binary>]   (default cli-go/dist/termag; the Node CLI is
#        cli/bin/termag.js of the same checkout, built with `make install-cli` or `node cli/build.mjs`)
# One command line per line on stdin, as sh words, e.g.
#   printf '%s\n' 'whoami' 'box list --json' | cli-go/tools/parity.sh
# Prints SAME or DIFF per line (and the diff); exits 1 if any differ.
set -u
here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(dirname "$here")
go_bin=${1:-$here/dist/termag}
node_cli="$repo/cli/bin/termag.js"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# No usage reports from the comparison runs.
TERMAG_TELEMETRY=0
export TERMAG_TELEMETRY
status=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  eval "set -- $line"
  node "$node_cli" "$@" >"$tmp/n.out" 2>"$tmp/n.err" </dev/null; echo "exit $?" >>"$tmp/n.err"
  "$go_bin" "$@" >"$tmp/g.out" 2>"$tmp/g.err" </dev/null; echo "exit $?" >>"$tmp/g.err"
  if cmp -s "$tmp/n.out" "$tmp/g.out" && cmp -s "$tmp/n.err" "$tmp/g.err"; then
    printf 'SAME  termag %s  (%s, stdout %s bytes)\n' "$line" "$(tail -1 "$tmp/g.err")" "$(wc -c <"$tmp/g.out" | tr -d ' ')"
  else
    printf 'DIFF  termag %s\n' "$line"
    diff "$tmp/n.out" "$tmp/g.out" | sed 's/^/      stdout /'
    diff "$tmp/n.err" "$tmp/g.err" | sed 's/^/      stderr /'
    status=1
  fi
done
exit $status
