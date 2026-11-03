#!/usr/bin/env bash
# The stack's isolation (docs/e2e-stack.md, "Isolation"): no tmux server, pane
# or hook of a stand-in box may run with the caller's own HOME, so no
# termag-status in one reaches the caller's real orchestrator. Reproduces the
# incident this guards against: a box's tmux server started from your own
# shell, before the box's server was up, gave its panes your HOME, and the
# status hook in them posted to production with your real box's token.
#
# "You" here is a stand-in too, and this whole script runs as it: a HOME under
# the test's temp dir with an agent config, Claude settings and termag-status
# as a real box has them, whose orchestrator is a local listener that records
# every request it gets, plus the termag and gh variables a real shell may
# hold. Nothing here ever sees your real HOME, even against a tree without the
# fix. Each case starts a tmux session for box-1 the wrong way, runs the status
# hook in it, and the listener must get nothing. Runs on its own ports and
# TMPDIR, beside a stack that is already up.
#
# Run: bash scripts/e2e/isolation.test.sh   (or make e2e-test)
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-4310} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-6336} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55809} E2E_BOXES=1
REAL_PORT=${E2E_TEST_REAL_PORT:-4319}
# Your own ~/.local/bin holds the termag-status of your real box: keep it off
# every PATH here, the stack's included.
PATH=$(printf '%s' "$PATH" | tr ':' '\n' | grep -vxF -e "$HOME/.local/bin" -e "$HOME/bin" | paste -sd: -)
export PATH
# shellcheck disable=SC2046
unset $(compgen -v | grep -E '^(TERMAG_|GH_|GITHUB_TOKEN$|TMUX)') XDG_CONFIG_HOME
listener=
trap 'bash "$here/down.sh" >/dev/null 2>&1; [ -n "$listener" ] && kill "$listener" 2>/dev/null; chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

# The real orchestrator: answers everything 200 and logs one line per request.
HITS="$WORK/real-orchestrator-hits.log"
: >"$HITS"
node -e '
  const fs = require("fs");
  require("http").createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      fs.appendFileSync(process.argv[2], `${req.method} ${req.url} auth=${req.headers.authorization ? "yes" : "no"} ${body}\n`);
      res.end("{}");
    });
  }).listen(Number(process.argv[1]), "127.0.0.1");
' "$REAL_PORT" "$HITS" &
listener=$!

# Your HOME, as on a real box: the agent config the hook resolves, Claude's
# hooks, and termag-status in ~/.local/bin.
YOU="$WORK/you"
mkdir -p "$YOU/.termag" "$YOU/.claude" "$YOU/.local/bin" "$YOU/.config/termag"
jq -n --arg u "ws://127.0.0.1:$REAL_PORT/termag/ws/agent" '{termag_url: $u, token: "real-box-token"}' >"$YOU/.termag/agent.config.json"
install -m 0644 "$repo/deploy/claude-settings.json" "$YOU/.claude/settings.json"
install -m 0755 "$repo/deploy/termag-status" "$YOU/.local/bin/termag-status"
for cli in claude termag; do printf '#!/bin/sh\necho "your real %s"\n' "$cli" >"$YOU/.local/bin/$cli"; chmod 0755 "$YOU/.local/bin/$cli"; done
# Your shell, from here on: that HOME, ~/.local/bin first on PATH, and the
# variables a real shell may hold for termag and gh.
export HOME=$YOU PATH="$YOU/.local/bin:$PATH" SHELL=/bin/bash TERM=xterm-256color
export TERMAG_URL="http://127.0.0.1:$REAL_PORT/termag" TERMAG_TOKEN=real-cli-token GH_TOKEN=real-gh-token

for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$REAL_PORT/" && break; sleep 0.25; done
: >"$HITS"
check "the real orchestrator stand-in answers" 200 "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$REAL_PORT/")"
: >"$HITS"

if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"
  echo "FAIL: up.sh"
  exit 1
fi
pass "up.sh brought the stack up"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
BOX="$ROOT/boxes/box-1"
SOCK="$BOX/tmux/sock"
[ -S "$SOCK" ] || SOCK="$BOX/tmux.sock"   # before the socket got its own directory
check "make e2e-status: isolation ok" "isolation ok" "$(bash "$here/status.sh" | grep -o '^isolation ok')"

# The hook a pane runs, as Claude Code's UserPromptSubmit/Stop hooks call it,
# then what the pane saw: its HOME and termag variables, the endpoint the hook
# resolves, and a marker that it ran.
hook_cmd() {
  local out="$WORK/pane-$1"
  printf '%s' "termag-status working; termag-status --print-endpoint >'$out.endpoint'; env | grep -E '^(HOME|TERMAG_URL|TERMAG_TOKEN|GH_TOKEN)=' | sort >'$out.env'; { command -v termag-status; command -v claude; } >'$out.which'; touch '$out.done'; sleep 600"
}
wait_pane() {
  for _ in $(seq 1 40); do [ -f "$WORK/pane-$1.done" ] && { sleep 1; return 0; }; sleep 0.25; done
  return 1
}
hits() { wc -l <"$HITS" | tr -d ' '; }
real_server_up() { tmux -S "$SOCK" list-sessions >/dev/null 2>&1; }

# 1. The incident: box-1's server is not running (a stopped box, a fresh one,
#    every session closed) and your shell starts a session through the box's
#    own bin/tmux. The wrapper must start the server with the box's
#    environment, not yours.
"$BOX/bin/tmux" kill-server 2>/dev/null
"$BOX/bin/tmux" new-session -d -s iso-wrapper "$(hook_cmd wrapper)"
wait_pane wrapper || fail "the bin/tmux pane ran its hook" "a pane" "none"
check "bin/tmux from your shell: the pane's HOME is the box's" "HOME=$BOX/home" "$(cat "$WORK/pane-wrapper.env" 2>/dev/null)"
check "bin/tmux from your shell: the hook targets the stack" "http://127.0.0.1:$((E2E_PORT + 1))/termag/api/status" \
  "$(cat "$WORK/pane-wrapper.endpoint" 2>/dev/null)"
check "bin/tmux from your shell: nothing reached the real orchestrator" 0 "$(hits)"
check "a box pane's PATH has the box's termag-status and none of your CLIs" "$BOX/bin/termag-status" \
  "$(cat "$WORK/pane-wrapper.which" 2>/dev/null)"

# 1b. Project panes are login shells, and a login shell runs the system
#     profile (/etc/profile and its profile.d, macOS's path_helper,
#     /etc/zsh/zshenv), which puts /usr/local/bin, Homebrew or /snap/bin back
#     on PATH: where real CLIs live. A box's own profile must end on the
#     box's allow-list PATH: exactly box_path, and only the box's
#     termag-status found.
box_allow=$(box_path "$BOX" "$ROOT")
login_probe() { printf '%s' "{ printf '%s\\n' \"\$PATH\"; command -v claude termag termag-status; } >'$WORK/login-$1' 2>&1; touch '$WORK/login-$1.done'"; }
"$BOX/bin/tmux" new-session -d -s iso-login
"$BOX/bin/tmux" send-keys -t '=iso-login:' "$(login_probe bash)" Enter
for _ in $(seq 1 40); do [ -f "$WORK/login-bash.done" ] && break; sleep 0.25; done
check "a login-shell pane (bash -l) keeps the box's PATH and finds none of your CLIs" \
  "$box_allow|$BOX/bin/termag-status" "$(paste -sd'|' "$WORK/login-bash" 2>/dev/null)"
if command -v zsh >/dev/null 2>&1; then
  "$BOX/bin/tmux" send-keys -t '=iso-login:' "zsh -l -c \"$(login_probe zsh | sed 's/["$\\]/\\&/g')\"" Enter
  for _ in $(seq 1 40); do [ -f "$WORK/login-zsh.done" ] && break; sleep 0.25; done
  check "zsh -l on a box keeps the box's PATH and finds none of your CLIs" \
    "$box_allow|$BOX/bin/termag-status" "$(paste -sd'|' "$WORK/login-zsh" 2>/dev/null)"
else
  echo "skip: zsh -l (no zsh)"
fi
"$BOX/bin/tmux" kill-session -t '=iso-login' 2>/dev/null

# 2. The same, bypassing the wrapper: a plain `tmux -S <box socket>` from your
#    shell while the box's server is down. No server may start there.
"$BOX/bin/tmux" kill-server 2>/dev/null
tmux -S "$SOCK" new-session -d -s iso-direct "$(hook_cmd direct)" 2>"$WORK/direct.err"
sleep 2
check "tmux -S from your shell, server down: no server starts on the box's socket" "no server" \
  "$(real_server_up && tmux -S "$SOCK" show-environment -g HOME || echo 'no server')"
check "tmux -S from your shell, server down: nothing reached the real orchestrator" 0 "$(hits)"

# 3. Bypassing the wrapper while the server is up: the session gets the
#    server's environment, the box's.
"$BOX/bin/tmux" start-server
tmux -S "$SOCK" new-session -d -s iso-attach "$(hook_cmd attach)"
wait_pane attach || fail "the tmux -S pane ran its hook" "a pane" "none"
check "tmux -S from your shell, server up: the pane's HOME is the box's" "HOME=$BOX/home" "$(cat "$WORK/pane-attach.env" 2>/dev/null)"
check "tmux -S from your shell, server up: nothing reached the real orchestrator" 0 "$(hits)"
check "make e2e-status: still isolation ok" "isolation ok" "$(bash "$here/status.sh" | grep -o '^isolation ok')"

# 4. A server of your own under the stack's root (another socket; or as root,
#    whom no directory mode stops). The status check must name it, and the
#    hook must refuse to post anywhere but the stack.
STRAY="$BOX/stray.sock"
tmux -S "$STRAY" new-session -d -s iso-stray "$(hook_cmd stray)"
wait_pane stray || fail "the stray server's pane ran its hook" "a pane" "none"
stray_pid=$(tmux -S "$STRAY" display-message -p '#{pid}' 2>/dev/null)
status_out=$(bash "$here/status.sh"); status_rc=$?
check "make e2e-status flags the stray server and fails" "boxes/box-1/stray.sock: HOME=$YOU, not a box's home|1" \
  "$(printf '%s\n' "$status_out" | sed -n 's/^ISOLATION //p' | head -n1)|$status_rc"
if grep -q 'e2e_allows' "$repo/deploy/termag-status"; then
  check "a stray server's hook: nothing reached the real orchestrator" 0 "$(hits)"
  check "a stray server's hook: the refusal is logged" \
    "termag-status: refusing to post to http://127.0.0.1:$REAL_PORT: this hook runs on a stand-in box of the e2e stack at $ROOT, which posts only to" \
    "$(head -n1 "$ROOT/logs/status-refused.log" 2>/dev/null | sed 's/ which posts only to .*/ which posts only to/')"
  sed -n 's/^/      /;1p' "$ROOT/logs/status-refused.log" 2>/dev/null
else
  echo "skip: a stray server's hook (deploy/termag-status has no e2e guard; it is on pr/e2e-isolation-deploy). Hits: $(hits)"
fi

if [ "$(hits)" != 0 ]; then echo "the real orchestrator got:"; sed 's/^/      /' "$HITS"; fi

bash "$here/down.sh" >"$WORK/down.log" 2>&1
check "down.sh stops the stray server too" "gone" "$([ -n "$stray_pid" ] && kill -0 "$stray_pid" 2>/dev/null && echo running || echo gone)"
check "down.sh removes the root" "gone" "$([ -e "$ROOT" ] && echo present || echo gone)"

if [ "$failures" -eq 0 ]; then echo "PASS"; else echo "$failures failure(s)"; exit 1; fi
