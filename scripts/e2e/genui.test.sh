#!/usr/bin/env bash
# End-to-end check of generative UI's loop
# against a real local stack with the fake Claude: with chat-generative-ui-enabled
# on, a chat turn carries the catalog's system prompt (backend chatGenUi.ts, agent
# chat-genui-v1), the fake answers "genui plan" with a ```spec fence, the answer a
# press on its Choose button sends goes back as a chat message, and the agent
# reads it (scripts/e2e/genui-loop.mjs). Runs on its own ports and TMPDIR,
# beside any stack that is up.
#
# Run: bash scripts/e2e/genui.test.sh   (or make e2e-test-genui)
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-3970} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-6004} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55469} E2E_BOXES=1 \
  E2E_FAKE_CLAUDE=1 E2E_FLAGS='{"simple-ui-enabled":true,"chat-generative-ui-enabled":true}'
[ -n "${E2E_KEEP:-}" ] || trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"
  echo "FAIL: up.sh"
  exit 1
fi
echo "ok:   up.sh brought the stack up"

node "$here/genui-loop.mjs" "http://127.0.0.1:$E2E_PORT/termag"
