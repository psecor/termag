#!/bin/sh
# Tests deploy/termag-metaterm-mcp, the launcher Claude Code runs as the
# MetaTerm MCP server on a box.
#
#   * it starts the checkout's server, and stdout carries only JSON-RPC --
#     even when node comes from nvm and sourcing nvm prints something
#   * the box default (METATERM_SEND_KEYS_DEFAULT=off) hides send_keys
#   * a checkout without the server fails on stderr, with stdout empty
#
# The server's own behavior is covered by metaterm/mcp-server.test.mjs.
#
# Run: sh deploy/termag-metaterm-mcp.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/termag-metaterm-mcp"
REPO="$(cd "$HERE/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

NODE="$(command -v node)" || { echo "SKIP: node not installed"; exit 0; }
BASH_BIN="$(command -v bash)"

# PATH without node; the stub nvm puts it back and is noisy on stdout, as a
# real `nvm use` can be.
mkdir -p "$WORK/home/.nvm" "$WORK/nodebin" "$WORK/empty"
ln -s "$NODE" "$WORK/nodebin/node"
cat > "$WORK/home/.nvm/nvm.sh" <<EOF
echo "Now using node from the stub nvm"
PATH="$WORK/nodebin:\$PATH"
EOF

LIST='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

out="$(printf '%s\n' "$LIST" | env -i HOME="$WORK/home" PATH="$WORK/empty" TERMAG_CHECKOUT="$REPO" \
  METATERM_SEND_KEYS_DEFAULT=off "$BASH_BIN" "$SCRIPT" 2>"$WORK/err")"
got="$(printf '%s' "$out" | "$NODE" -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try { console.log(JSON.parse(s).result.tools.map(t => t.name).join(",")); }
    catch { console.log("NOT-JSON: " + s); }
  });')"
[ "$got" = 'list_sessions,capture_pane,search_sessions,session_status,activity_ledger,latest_briefing,spawn_budget,list_spawns,report_back,draft_slack_message,slack_inbox,handoff_written,spawn_agent,handoff' ] \
  || fail 'nvm-sourced node, clean stdout, send_keys off by default' 'list_sessions,capture_pane,search_sessions,session_status,activity_ledger,latest_briefing,spawn_budget,list_spawns,report_back,draft_slack_message,slack_inbox,handoff_written,spawn_agent,handoff' "$got"
grep -q 'stub nvm' "$WORK/err" || fail "nvm's output goes to stderr" 'on stderr' "$(cat "$WORK/err")"

out="$(printf '%s\n' "$LIST" | env -i HOME="$WORK/home" PATH="$WORK/empty" TERMAG_CHECKOUT="$WORK/nowhere" \
  "$BASH_BIN" "$SCRIPT" 2>"$WORK/err")"
got=$?
[ "$got" = 1 ] || fail 'a missing server exits 1' 1 "$got"
[ -z "$out" ] || fail 'a missing server writes nothing to stdout' '(empty)' "$out"
grep -q 'no MetaTerm server' "$WORK/err" || fail 'a missing server says so' 'no MetaTerm server' "$(cat "$WORK/err")"

rm -f "$WORK/home/.nvm/nvm.sh"
env -i HOME="$WORK/home" PATH="$WORK/empty" TERMAG_CHECKOUT="$REPO" "$BASH_BIN" "$SCRIPT" </dev/null >/dev/null 2>"$WORK/err"
got=$?
[ "$got" = 1 ] || fail 'no node exits 1' 1 "$got"
grep -q 'node not found' "$WORK/err" || fail 'no node says so' 'node not found' "$(cat "$WORK/err")"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: launcher starts the checkout server with clean stdout; fails clearly without it'
  exit 0
fi
echo "$failures failure(s)"
exit 1
