#!/bin/bash
# Live, read-only: `termag events` from Node and Go side by side against the real orchestrator.
# Usage: cli-go/tools/events-side-by-side.sh <go binary> <seconds> [--json]   (Node: cli/bin/termag.js of this checkout)
set -u
GO=$1; SECS=$2; shift 2
N="$(cd "$(dirname "$0")/../.." && pwd)/cli/bin/termag.js"; [ -n "${TERMAG_NODE_CLI:-}" ] && N=$TERMAG_NODE_CLI
D=$(mktemp -d)
export TERMAG_TELEMETRY=0
node "$N" events "$@" >"$D/n.out" 2>"$D/n.err" & np=$!
"$GO" events "$@" >"$D/g.out" 2>"$D/g.err" & gp=$!
sleep "$SECS"
kill -INT $np $gp
wait $np; echo "node exit $?"
wait $gp; echo "go exit $?"
norm() { sed -E 's/^[0-9T:.-]+Z /<at> /; s/"at":"[^"]*"/"at":"<at>"/' "$1"; }
norm "$D/n.out" >"$D/n.norm"; norm "$D/g.out" >"$D/g.norm"
echo "lines: node $(wc -l <"$D/n.out"), go $(wc -l <"$D/g.out")"
if diff "$D/n.norm" "$D/g.norm" && diff "$D/n.err" "$D/g.err"; then echo "SAME (timestamps masked)"; else echo DIFF; fi
head -3 "$D/g.out"
grep -m2 session "$D/g.out"
rm -rf "$D"
