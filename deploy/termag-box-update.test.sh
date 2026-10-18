#!/bin/sh
# Tests deploy/termag-box-update, the box-side update the orchestrator starts
# over the agent's box-update RPC (or an owner by hand): pull --ff-only,
# termag-reconcile, restart the agent when that is safe.
#
#   * the pull happens only on a clean `main` with an origin; a branch, a dirty
#     tree, a detached HEAD, a diverged main, a missing origin and an unwritable
#     checkout are each refused with a reason, and the opt-out marker stops
#     everything
#   * termag-reconcile runs (--check, apply, --check) whether or not the pull
#     did, since that is what boot does too; nothing else does on a refused
#     checkout: no npm ci, no TUI build, no restart (a developer's branch is
#     left alone, lifecycle scripts included)
#   * the agent restarts only when something it runs changed since it started
#     (a tracked agent/ file or the loaded unit newer than the process), and
#     then only on main, with KillMode=process and no live Claude runner
#     session; a deferred restart happens on the next run, and the agent's
#     tests do not count
#   * agent dependencies are checked against the installed tree (a top-level
#     package missing or off its locked version; dev and absent optional ones
#     skipped), installed in a staging copy and swapped in whole, so a failed
#     install leaves the live tree alone and blocks the restart; a successful
#     one is itself a reason to restart, since the process still has the old
#     ones loaded, and that reason is read from the tree's mtime, so a
#     restart deferred past a live runner is still due on the next run
#   * --check reports and changes nothing (exit 1 when an update would act)
#   * a previously built TUI is rebuilt; one never built is left alone
#   * --when-enabled (what the service unit runs) asks the orchestrator first, with
#     the agent token on curl's stdin, and does nothing unless the answer is a
#     200 saying enabled: no config, a no, an error and an unreadable body are
#     each a no; a run without the flag asks nobody
#
# git is real (a bare origin and a clone), and so is node (the dependency check
# is a node script); systemctl, tmux, npm, curl, the TUI installer and
# termag-reconcile are stubs that record their calls.
#
# Run: sh deploy/termag-box-update.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-box-update"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}
has() {  # has NAME HAYSTACK NEEDLE
  case "$2" in *"$3"*) : ;; *) fail "$1" "$3" "$2" ;; esac
}
lacks() {
  case "$2" in *"$3"*) fail "$1" "(no '$3')" "$2" ;; esac
}

HOME_DIR="$WORK/home"
STUB="$WORK/stub"
UPSTREAM="$WORK/upstream"
ORIGIN="$WORK/origin.git"
CHECKOUT="$WORK/checkout"
STATE="$WORK/state"
mkdir -p "$HOME_DIR/.config/systemd/user" "$STUB" "$STATE"

# A git that sees none of this machine's configuration (a box routes github.com
# through the broker with insteadOf rules; an origin that is a local path must
# stay one).
export GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
export HOME="$HOME_DIR"
# GitHub runners can export NVM_DIR independently of HOME. Never source the
# caller's nvm (which can probe npm) while exercising our isolated stubs.
export NVM_DIR="$HOME_DIR/.nvm"

OLD='2026-01-01 00:00:00 UTC'
# ExecMainStartTimestamp of the stub agent. Files from before it are "old".
AGENT_START='Mon 2026-01-05 10:00:00 UTC'

# ── stubs ───────────────────────────────────────────────────────────────────
LOG="$WORK/calls"; : > "$LOG"
export LOG STATE

cat > "$STUB/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "$LOG"
case "$*" in
  *' is-active '*) a=$(cat "$STATE/active"); echo "$a"; [ "$a" = active ] ;;
  *'-p ExecMainStartTimestamp'*) cat "$STATE/start" ;;
  *'-p KillMode'*) cat "$STATE/killmode" ;;
  *'-p FragmentPath'*) cat "$STATE/fragment" ;;
  *'-p ExecStart'*) cat "$STATE/execstart" ;;
  *' restart '*) exit "$(cat "$STATE/restart-rc" 2>/dev/null || echo 0)" ;;
  *) exit 0 ;;
esac
EOF
cat > "$STUB/tmux" <<'EOF'
#!/bin/sh
echo "tmux $*" >> "$LOG"
[ -s "$STATE/sessions" ] || exit 1
cat "$STATE/sessions"
EOF
# node is the machine's own, through a stub on PATH so the script finds it
# there; npm records its call and, on success, lays out the node_modules the
# lockfile in its working directory describes.
REAL_NODE=$(command -v node || true)
if [ -z "$REAL_NODE" ]; then
  echo 'SKIP: node is required for this test' >&2
  exit 0
fi
printf '#!/bin/sh\nexec %s "$@"\n' "$REAL_NODE" > "$STUB/node"
cat > "$STUB/npm" <<EOF
#!/bin/sh
echo "npm \$* (in \$(pwd))" >> "\$LOG"
[ "\$(cat "\$STATE/npm-rc" 2>/dev/null || echo 0)" = 0 ] || { echo 'npm ERR! boom'; exit 1; }
exec "$REAL_NODE" -e '
  const fs = require("fs"), path = require("path");
  const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
  for (const [key, pkg] of Object.entries(lock.packages)) {
    if (!key.startsWith("node_modules/") || pkg.dev) continue;
    fs.mkdirSync(key, { recursive: true });
    fs.writeFileSync(path.join(key, "package.json"), JSON.stringify({ version: pkg.version }));
  }'
EOF
cat > "$STUB/reconcile" <<'EOF'
#!/bin/sh
echo "reconcile $*" >> "$LOG"
case "${1:-}" in
  --check) [ "$(cat "$STATE/drift")" = 0 ] && exit 0; echo 'DRIFT: termag-status differs'; exit 1 ;;
  '') echo 'reconciled: termag-status'; echo 0 > "$STATE/drift" ;;
esac
EOF
# termag-hooks-update records its call and the env step 2b hands it; its
# --check answers from $STATE/hooks (current|behind|broken), and an apply
# brings it current unless $STATE/hooks-apply-rc says otherwise.
cat > "$STUB/hooks-update" <<'EOF'
#!/bin/sh
echo "hooks-update ${1:-apply} checkout=$TERMAG_CHECKOUT settings=$TERMAG_CLAUDE_SETTINGS" >> "$LOG"
state=$(cat "$STATE/hooks" 2>/dev/null || echo current)
case "${1:-}" in
  --check)
    case "$state" in current) echo 'hooks already current'; exit 0 ;; broken) echo 'not valid JSON' >&2; exit 2 ;; *) echo 'hooks out of date'; exit 1 ;; esac ;;
  '')
    rc=$(cat "$STATE/hooks-apply-rc" 2>/dev/null || echo 0)
    [ "$rc" = 0 ] || { echo 'cannot write settings' >&2; exit "$rc"; }
    echo current > "$STATE/hooks"; echo 'updated settings.json (backup: x.bak)' ;;
esac
EOF
# curl records its arguments and the config it was handed on stdin (-K -), and
# answers with $STATE/policy, or fails with $STATE/policy-rc. A POST (the
# outcome report, which asks for the status code with -w) is answered with
# $STATE/report-code, 204 by default.
cat > "$STUB/curl" <<'EOF'
#!/bin/sh
cfg=$(cat)
echo "curl $* [$cfg]" >> "$LOG"
case " $* " in
  *' -X POST '*) printf '%s' "$(cat "$STATE/report-code" 2>/dev/null || echo 204)"; exit 0 ;;
esac
rc=$(cat "$STATE/policy-rc" 2>/dev/null || echo 0)
[ "$rc" = 0 ] || exit "$rc"
cat "$STATE/policy"
EOF
chmod 755 "$STUB"/*

reset_state() {
  echo active > "$STATE/active"
  echo process > "$STATE/killmode"
  echo "$AGENT_START" > "$STATE/start"
  echo "$HOME_DIR/.config/systemd/user/termag-agent.service" > "$STATE/fragment"
  echo "/bin/bash $CHECKOUT/agent/run-node.sh $CHECKOUT/agent/agent.js" > "$STATE/execstart"
  echo 0 > "$STATE/drift"
  : > "$STATE/sessions"
  rm -f "$STATE/npm-rc" "$STATE/restart-rc" "$STATE/policy-rc" "$STATE/report-code" "$STATE/hooks-apply-rc"
  echo current > "$STATE/hooks"
  printf '{"enabled":true}\n' > "$STATE/policy"
  : > "$LOG"
}

# ── repositories ────────────────────────────────────────────────────────────
git init -q -b main "$UPSTREAM"
mkdir -p "$UPSTREAM/agent" "$UPSTREAM/deploy"
cp "$(dirname "$SCRIPT")/../agent/run-node.sh" "$UPSTREAM/agent/run-node.sh"
printf 'v1\n' > "$UPSTREAM/agent/agent.js"
printf '{"name":"termag-agent"}\n' > "$UPSTREAM/agent/package.json"
# A lockfile of the real shape: two runtime packages, a dev one (never
# installed with --omit=dev) and an optional one (absent on this platform).
lockfile() {  # lockfile WS-VERSION
  printf '{"name":"termag-agent","lockfileVersion":3,"packages":{"":{"dependencies":{"ws":"^8"}},"node_modules/ws":{"version":"%s"},"node_modules/node-pty":{"version":"1.0.0"},"node_modules/typescript":{"version":"5.0.0","dev":true},"node_modules/fsevents":{"version":"2.3.3","optional":true}}}\n' "$1"
}
lockfile 8.16.0 > "$UPSTREAM/agent/package-lock.json"
printf 'test-v1\n' > "$UPSTREAM/agent/agent.test.js"
printf 'status-v1\n' > "$UPSTREAM/deploy/termag-status"
printf 'unit-v1\n' > "$UPSTREAM/deploy/termag-agent.service"
git -C "$UPSTREAM" add -A
git -C "$UPSTREAM" commit -q -m 'v1'
git clone -q --bare "$UPSTREAM" "$ORIGIN"
git -C "$UPSTREAM" remote add origin "$ORIGIN"
git clone -q "$ORIGIN" "$CHECKOUT"
# The installed tree the bake left: both runtime packages at their locked versions.
install_pkg() {  # install_pkg NAME VERSION
  mkdir -p "$CHECKOUT/agent/node_modules/$1"
  printf '{"name":"%s","version":"%s"}\n' "$1" "$2" > "$CHECKOUT/agent/node_modules/$1/package.json"
}
install_pkg ws 8.16.0
install_pkg node-pty 1.0.0
installed_version() { sed -n 's/.*"version":"\([^"]*\)".*/\1/p' "$CHECKOUT/agent/node_modules/$1/package.json" 2>/dev/null; }

# upstream_change PATH CONTENT MESSAGE: a commit on origin's main.
upstream_change() {
  mkdir -p "$(dirname "$UPSTREAM/$1")"
  printf '%s\n' "$2" > "$UPSTREAM/$1"
  git -C "$UPSTREAM" add -A
  git -C "$UPSTREAM" commit -q -m "$3"
  git -C "$UPSTREAM" push -q origin main
}

# Everything the agent could run predates its start, node_modules included.
age_all() {
  find "$CHECKOUT" -path "$CHECKOUT/.git" -prune -o -exec touch -d "$OLD" {} +
  printf 'unit-v1\n' > "$HOME_DIR/.config/systemd/user/termag-agent.service"
  touch -d "$OLD" "$HOME_DIR/.config/systemd/user/termag-agent.service"
}
age_all

head_of() { git -C "$CHECKOUT" rev-parse HEAD; }

run() {
  HOME="$HOME_DIR" TERMAG_CHECKOUT="$CHECKOUT" TERMAG_STATE_DIR="$HOME_DIR/.termag" \
    TERMAG_RECONCILE="$STUB/reconcile" TERMAG_HOOKS_UPDATE="$STUB/hooks-update" PATH="$STUB:$PATH" "$SCRIPT" "$@" 2>&1
}

# ── a current box: nothing to do ────────────────────────────────────────────
reset_state
out="$(run)"
rc=$?
[ "$rc" = 0 ] || fail 'a current box exits 0' 0 "$rc"
has 'says the checkout is current' "$out" 'pull: current at'
has 'reconcile --check runs first' "$(cat "$LOG")" 'reconcile --check'
got="$(grep -c '^reconcile $' "$LOG")"
[ "$got" = 0 ] || fail 'no reconcile apply when --check is clean' 0 "$got"
has 'says nothing the agent runs changed' "$out" 'nothing it runs changed since it started'
lacks 'no restart on a current box' "$(cat "$LOG")" 'restart'
lacks 'no npm on a current box' "$(cat "$LOG")" 'npm'
lacks 'a dev package is not expected in the tree' "$out" 'typescript'
lacks 'an absent optional package is not stale' "$out" 'fsevents'

# ── opt-out marker ──────────────────────────────────────────────────────────
reset_state
mkdir -p "$HOME_DIR/.config/termag"; touch "$HOME_DIR/.config/termag/no-auto-update"
out="$(run)"
has 'the marker opts the box out' "$out" 'opted out'
[ ! -s "$LOG" ] || fail 'nothing runs when opted out' '(no calls)' "$(cat "$LOG")"
rm -f "$HOME_DIR/.config/termag/no-auto-update"

# ── --when-enabled: the orchestrator's say ──────────────────────────────────
# What the service unit runs. Nobody to ask: a no.
reset_state
out="$(run --when-enabled)"
rc=$?
[ "$rc" = 0 ] || fail 'a gated run with no config exits 0' 0 "$rc"
has 'no agent config is a no' "$out" 'not enabled for this box: no agent config; cannot ask the orchestrator; nothing done'
[ ! -s "$LOG" ] || fail 'nothing runs without a yes' '(no calls)' "$(cat "$LOG")"

AGENT_CONFIG="$HOME_DIR/.termag/agent.config.json"
mkdir -p "$HOME_DIR/.termag"
printf '{"termag_url":"wss://orch.example.test/termag/ws/agent?token=x","token":"tmag_test"}\n' > "$AGENT_CONFIG"
POLICY_URL='https://orch.example.test/termag/api/box-update/policy'
REPORT_URL='https://orch.example.test/termag/api/box-update/report'

# The orchestrator says no: one ask, nothing else.
reset_state
printf '{"enabled":false,"reason":"flag-off"}\n' > "$STATE/policy"
out="$(run --when-enabled)"
has 'a no is reported with its reason' "$out" 'not enabled for this box: the orchestrator says no (flag-off); nothing done'
has 'asks the policy endpoint derived from termag_url, token on stdin' "$(cat "$LOG")" "curl -sf -m 20 -K - $POLICY_URL [header = \"Authorization: Bearer tmag_test\"]"
got="$(grep -vc '^curl' "$LOG")"
[ "$got" = 0 ] || fail 'only curl runs on a no' 0 "$(cat "$LOG")"
lacks 'a no posts no report' "$(cat "$LOG")" 'box-update/report'
[ "$(head_of)" = "$(git -C "$ORIGIN" rev-parse main)" ] || fail 'the checkout is untouched on a no' "$(git -C "$ORIGIN" rev-parse main)" "$(head_of)"

# No answer (an unreachable or older orchestrator, a refused token): a no.
reset_state
echo 22 > "$STATE/policy-rc"
out="$(run --when-enabled)"
has 'a failed ask is a no' "$out" "not enabled for this box: could not ask $POLICY_URL (curl exit 22); nothing done"
got="$(grep -vc '^curl' "$LOG")"
[ "$got" = 0 ] || fail 'only curl runs when the ask fails' 0 "$(cat "$LOG")"

# An answer that is not JSON, or JSON without enabled === true: a no.
reset_state
printf 'Service Unavailable\n' > "$STATE/policy"
out="$(run --when-enabled)"
has 'an unreadable answer is a no' "$out" "not enabled for this box: unreadable answer from $POLICY_URL; nothing done"
reset_state
printf '{"enabled":"true"}\n' > "$STATE/policy"
out="$(run --when-enabled)"
has 'a string true is a no' "$out" 'not enabled for this box: the orchestrator says no; nothing done'

# A yes: the run proceeds (the opt-out marker still wins, checked earlier).
reset_state
out="$(run --when-enabled)"
has 'a yes is logged' "$out" 'enabled: the orchestrator says automatic updates are on for this box'
has 'the run goes on after a yes' "$(cat "$LOG")" 'reconcile --check'
has 'the yes was asked for' "$(cat "$LOG")" "curl -sf -m 20 -K - $POLICY_URL"

# --check --when-enabled on a no: nothing to report, exit 0.
reset_state
printf '{"enabled":false,"reason":"flag-off"}\n' > "$STATE/policy"
out="$(run --check --when-enabled)"
rc=$?
[ "$rc" = 0 ] || fail '--check on a no exits 0' 0 "$rc"
lacks '--check posts no report' "$(cat "$LOG")" 'box-update/report'
has '--check on a no says so' "$out" 'not enabled for this box: the orchestrator says no (flag-off); nothing done'

# A run by hand asks nobody.
reset_state
printf '{"enabled":false,"reason":"flag-off"}\n' > "$STATE/policy"
out="$(run)"
lacks 'a hand run does not ask' "$(cat "$LOG")" 'box-update/policy'
has 'a hand run proceeds' "$(cat "$LOG")" 'reconcile --check'
# ...but it reports its outcome like any update: nothing changed, so `current`.
has 'a hand run reports its outcome' "$(cat "$LOG")" "curl -s -m 5 -K - -o /dev/null -w %{http_code} -X POST $REPORT_URL"
has 'a current box reports current' "$(cat "$LOG")" '"outcome":"current"'
has 'the report carries each step' "$(cat "$LOG")" '"pull":"current","reconcile":"clean","deps":"unchanged","agent":"unchanged"'
has 'the report puts the token on stdin' "$(cat "$LOG")" '[header = "Authorization: Bearer tmag_test"]'

# ── a deploy/-only change: pull + reconcile, no restart ─────────────────────
reset_state
echo 1 > "$STATE/drift"
before=$(head_of)
upstream_change deploy/termag-status 'status-v2' 'status v2'
out="$(run)"
[ "$(head_of)" = "$(git -C "$ORIGIN" rev-parse main)" ] || fail 'fast-forwards to origin/main' "$(git -C "$ORIGIN" rev-parse main)" "$(head_of)"
has 'logs the pull range' "$out" "pull: $(printf '%s' "$before" | cut -c1-12)..$(head_of | cut -c1-12) (1 commits)"
has 'reconcile reports the drift' "$out" 'DRIFT: termag-status'
has 'reconcile applies' "$out" 'reconciled: termag-status'
has 'reconcile is checked again' "$out" 'reconcile: clean'
got="$(grep -c '^reconcile' "$LOG")"
[ "$got" = 3 ] || fail 'reconcile: --check, apply, --check' 3 "$got"
lacks 'a deploy-only change does not restart the agent' "$(cat "$LOG")" 'restart'
has 'says why not' "$out" 'nothing it runs changed'

# ── an agent change: restart, with KillMode=process and no runner ───────────
reset_state
before_restart=$(head_of)
upstream_change agent/agent.js 'v2' 'agent v2'
out="$(run)"
has 'restarts the agent' "$(cat "$LOG")" 'systemctl --user restart termag-agent.service'
has 'names the changed file' "$out" 'restarted termag-agent.service (agent/agent.js changed since it started'
got="$(grep -c 'systemctl --user restart' "$LOG")"
[ "$got" = 1 ] || fail 'one restart' 1 "$got"
has 'an update that restarted reports updated' "$(cat "$LOG")" '"outcome":"updated"'
has 'the report names the pull and the restart' "$(cat "$LOG")" '"pull":"pulled:1","reconcile":"clean","deps":"unchanged","agent":"restarted"'
has 'the report carries the commits' "$(cat "$LOG")" "\"from\":\"$before_restart\",\"to\":\"$(head_of)\""
has 'the report is logged' "$out" 'report: posted (updated)'
reset_state
echo 404 > "$STATE/report-code"
out="$(run)"
has 'an orchestrator without the report route is named, and the run is unchanged' "$out" 'report: not posted: '"$REPORT_URL"' answered 404 (the orchestrator predates the report)'

# The restarted agent is "newer" than the change now.
reset_state
date -u -d '+1 hour' '+%a %Y-%m-%d %H:%M:%S UTC' > "$STATE/start"
out="$(run)"
lacks 'no second restart once the agent is newer than the change' "$(cat "$LOG")" 'restart'
touch -d "$OLD" "$CHECKOUT/agent/agent.js"

# ── a test-only agent change does not restart ───────────────────────────────
reset_state
upstream_change agent/agent.test.js 'test-v2' 'agent test v2'
out="$(run)"
lacks 'agent tests do not restart the agent' "$(cat "$LOG")" 'restart'
touch -d "$OLD" "$CHECKOUT/agent/agent.test.js"

# ── the loaded unit changing counts too ─────────────────────────────────────
reset_state
printf 'unit-v2\n' > "$HOME_DIR/.config/systemd/user/termag-agent.service"
out="$(run)"
has 'a newer unit file restarts the agent' "$out" "restarted termag-agent.service ($HOME_DIR/.config/systemd/user/termag-agent.service changed"
touch -d "$OLD" "$HOME_DIR/.config/systemd/user/termag-agent.service"

# ── KillMode other than process: deferred to the next boot ──────────────────
reset_state
echo control-group > "$STATE/killmode"
upstream_change agent/agent.js 'v3' 'agent v3'
out="$(run)"
lacks 'no restart without KillMode=process' "$(cat "$LOG")" 'restart'
has 'says the restart waits for the next boot' "$out" 'KillMode=control-group, so a restart would kill the tmux server'

# ── a live Claude runner session defers the restart; the next run does it ───
reset_state
printf '%s\n' 'alice-webapp-agent' 'alice-webapp-ctrl' 'alice-claude-runner-s3-ord_1-r' > "$STATE/sessions"
out="$(run)"
lacks 'no restart while a runner session is live' "$(cat "$LOG")" 'restart'
has 'names the live session' "$out" 'deferring the restart while a Claude Code cloud session is live (alice-claude-runner-s3-ord_1-r'
reset_state
printf '%s\n' 'alice-webapp-agent' 'alice-webapp-ctrl' > "$STATE/sessions"
out="$(run)"
has 'the deferred restart happens on the next run, with no new pull' "$out" 'restarted termag-agent.service (agent/agent.js changed'
has 'that run pulled nothing' "$out" 'pull: current at'
touch -d "$OLD" "$CHECKOUT/agent/agent.js"

# ── a simple-UI chat turn is its own tmux session and outlives the restart ──
# (agent/chat-runner.js): it must not defer the restart as a runner does.
reset_state
printf '%s\n' 'alice-webapp-agent' 'alice-chat-mva9ab-x1y2-r' > "$STATE/sessions"
upstream_change agent/agent.js 'v4' 'agent v4'
out="$(run)"
lacks 'a chat turn defers nothing' "$out" 'deferring the restart'
has 'the restart happens with a chat turn live' "$out" 'restarted termag-agent.service (agent/agent.js changed'
touch -d "$OLD" "$CHECKOUT/agent/agent.js"

# ── an agent that is not running is not started ─────────────────────────────
reset_state
echo inactive > "$STATE/active"
upstream_change agent/agent.js 'v4' 'agent v4'
out="$(run)"
lacks 'an inactive agent is not restarted' "$(cat "$LOG")" 'restart'
has 'says the agent is inactive' "$out" 'termag-agent.service is inactive; nothing to restart'
touch -d "$OLD" "$CHECKOUT/agent/agent.js"

# ── stale dependencies: checked against the tree, installed beside it ───────
# The lockfile moves ws on; the tree still has the old one. A failed npm ci
# leaves that tree exactly as it was and blocks the restart; a successful one
# is swapped in whole, and the restart follows.
reset_state
echo 1 > "$STATE/npm-rc"
upstream_change agent/package-lock.json "$(lockfile 8.17.0)" 'deps v2'
out="$(run)"
has 'reports what is stale' "$out" 'ws: 8.16.0 installed, 8.17.0 locked'
has 'npm ci runs in a staging copy, not in agent/' "$(cat "$LOG")" "npm ci --omit=dev --no-audit --no-fund --loglevel=error (in $HOME_DIR/.termag/box-update/agent-deps."
has 'a failed install is reported' "$out" 'npm ci failed'
has 'a failed install makes the run failed, not deferred' "$(cat "$LOG")" '"outcome":"failed"'
has 'and the report says which step' "$(cat "$LOG")" '"deps":"failed","agent":"blocked:deps"'
[ "$(installed_version ws)" = 8.16.0 ] || fail 'a failed install leaves the live tree alone' 8.16.0 "$(installed_version ws)"
[ ! -e "$CHECKOUT/agent/node_modules.prev" ] || fail 'no leftover tree after a failed install' 'absent' 'node_modules.prev'
lacks 'a failed install blocks the restart' "$(cat "$LOG")" 'restart'
has 'and says so' "$out" 'dependencies did not install; not restarting'
reset_state
out="$(run)"
has 'the install is retried next run' "$(cat "$LOG")" 'npm ci'
has 'then reported' "$out" 'deps: agent dependencies installed'
[ "$(installed_version ws)" = 8.17.0 ] || fail 'the new tree is in place' 8.17.0 "$(installed_version ws)"
[ "$(installed_version node-pty)" = 1.0.0 ] || fail 'the rest of the tree came with it' 1.0.0 "$(installed_version node-pty)"
[ ! -e "$CHECKOUT/agent/node_modules.prev" ] || fail 'the previous tree is gone' 'absent' 'node_modules.prev'
[ -z "$(ls -d "$HOME_DIR"/.termag/box-update/agent-deps.* 2>/dev/null)" ] || fail 'the staging directory is removed' 'none' "$(ls -d "$HOME_DIR"/.termag/box-update/agent-deps.*)"
has 'and the restart follows' "$(cat "$LOG")" 'systemctl --user restart'
reset_state
out="$(run)"
lacks 'no npm when the tree matches the lockfile' "$(cat "$LOG")" 'npm'
touch -d "$OLD" "$CHECKOUT/agent/package-lock.json"

# A lockfile pulled by hand before the unit ever ran (the documented catch-up)
# is caught the same way, since nothing is inferred from the pull.
reset_state
upstream_change agent/package-lock.json "$(lockfile 8.18.0)" 'deps v3'
git -C "$CHECKOUT" pull -q --ff-only origin main
touch -d "$OLD" "$CHECKOUT/agent/package-lock.json"
out="$(run)"
has 'a hand-pulled lockfile is installed on the next run' "$(cat "$LOG")" 'npm ci'
[ "$(installed_version ws)" = 8.18.0 ] || fail 'and the tree follows it' 8.18.0 "$(installed_version ws)"
has 'the pull itself had nothing to do' "$out" 'pull: current at'
# Nothing tracked is newer than the agent here, but the process still has the
# old modules loaded: the install is a reason to restart by itself.
has 'a fresh install restarts the agent even with no newer tracked file' "$out" 'restarted termag-agent.service (agent/node_modules changed since it started'
has 'and the restart was issued' "$(cat "$LOG")" 'systemctl --user restart termag-agent.service'

# The same, with the restart deferred past a live runner: the next run finds
# the tree matching the lockfile and still restarts, because the installed
# directory is newer than the process.
reset_state
touch -d "$OLD" "$CHECKOUT/agent/node_modules"
upstream_change agent/package-lock.json "$(lockfile 8.19.0)" 'deps v4'
git -C "$CHECKOUT" pull -q --ff-only origin main
touch -d "$OLD" "$CHECKOUT/agent/package-lock.json"
printf '%s\n' 'alice-claude-runner-s2-ord_9-r' > "$STATE/sessions"
out="$(run)"
has 'deps installed while a runner is live' "$out" 'deps: agent dependencies installed'
has 'but the restart is deferred' "$out" 'deferring the restart while a Claude Code cloud session is live'
lacks 'no restart yet' "$(cat "$LOG")" 'restart'
reset_state
out="$(run)"
lacks 'the next run installs nothing' "$(cat "$LOG")" 'npm'
has 'and still restarts for the installed tree' "$out" 'restarted termag-agent.service (agent/node_modules changed since it started'

# A tree that is missing altogether is stale too.
reset_state
rm -rf "$CHECKOUT/agent/node_modules"
out="$(run)"
has 'a missing tree is reported' "$out" 'ws: missing, 8.19.0 locked'
[ "$(installed_version ws)" = 8.19.0 ] || fail 'and installed' 8.19.0 "$(installed_version ws)"

# ── --check reports and changes nothing ─────────────────────────────────────
reset_state
echo 1 > "$STATE/drift"
before=$(head_of)
upstream_change agent/agent.js 'v5' 'agent v5'
install_pkg ws 8.17.0
out="$(run --check)"
rc=$?
[ "$rc" = 1 ] || fail '--check exits 1 when an update would act' 1 "$rc"
has '--check says it would pull' "$out" 'pull: would fast-forward'
has '--check reports stale dependencies' "$out" 'ws: 8.17.0 installed, 8.19.0 locked'
has '--check would install them' "$out" 'deps: would install them'
has '--check counts the install as a reason to restart' "$out" 'would restart termag-agent.service (agent/node_modules changed since it started'
lacks '--check installs nothing' "$(cat "$LOG")" 'npm'
[ "$(installed_version ws)" = 8.17.0 ] || fail '--check leaves the tree alone' 8.17.0 "$(installed_version ws)"
[ "$(head_of)" = "$before" ] || fail '--check does not pull' "$before" "$(head_of)"
got="$(grep -c '^reconcile' "$LOG")"
[ "$got" = 1 ] || fail '--check runs only reconcile --check' 1 "$got"
lacks '--check restarts nothing' "$(cat "$LOG")" 'restart'
out="$(run)"
touch -d "$OLD" "$CHECKOUT/agent/agent.js" "$CHECKOUT/agent/package-lock.json" "$CHECKOUT/agent/node_modules"
out="$(run --check)"
rc=$?
[ "$rc" = 0 ] || fail '--check exits 0 on a current box' 0 "$out"
touch -d "$OLD" "$CHECKOUT/agent/agent.js"

# ── a developer's checkout is left alone ────────────────────────────────────
reset_state
git -C "$CHECKOUT" checkout -q -b feature
upstream_change agent/agent.js 'v6' 'agent v6'
out="$(run)"
has 'a branch refuses the pull' "$out" "pull: skipped: on branch 'feature', not main"
has 'reconcile still runs' "$(cat "$LOG")" 'reconcile --check'
# The developer edits the agent on their branch, lockfile included: newer than
# the running agent, but theirs to install and restart. Nothing from a
# checkout the script would not pull runs here, lifecycle scripts included.
printf 'dev\n' > "$CHECKOUT/agent/agent.js"
lockfile 9.0.0 > "$CHECKOUT/agent/package-lock.json"
git -C "$CHECKOUT" commit -q -am 'dev edit'
reset_state
tree_before=$(installed_version ws)
out="$(run)"
lacks 'a branch never restarts the agent' "$(cat "$LOG")" 'restart'
has 'and says the owner decides' "$out" 'leaving the restart to the owner'
lacks 'a branch never gets npm ci' "$(cat "$LOG")" 'npm'
has 'and says the dependencies are left alone' "$out" "deps: left alone: on branch 'feature'"
[ "$(installed_version ws)" = "$tree_before" ] || fail 'the tree is untouched on a branch' "$tree_before" "$(installed_version ws)"
git -C "$CHECKOUT" checkout -q main
git -C "$CHECKOUT" branch -q -D feature
age_all

reset_state
printf 'local edit\n' >> "$CHECKOUT/deploy/termag-status"
out="$(run)"
has 'a dirty tree refuses the pull' "$out" 'pull: skipped: the working tree has local changes'
git -C "$CHECKOUT" checkout -q -- deploy/termag-status

reset_state
git -C "$CHECKOUT" checkout -q --detach
out="$(run)"
has 'a detached HEAD refuses the pull' "$out" 'pull: skipped: detached HEAD'
git -C "$CHECKOUT" checkout -q main

reset_state
git -C "$CHECKOUT" commit -q --allow-empty -m 'local commit on main'
out="$(run)"
has 'a diverged main is not pulled' "$out" 'main has diverged from origin/main'
git -C "$CHECKOUT" reset -q --hard HEAD~1
age_all
# origin/main moved on (agent v6) while the box was refusing; a plain run catches up.
reset_state
out="$(run)"
has 'catches up once main is clean again' "$out" '(1 commits)'
[ "$(head_of)" = "$(git -C "$ORIGIN" rev-parse main)" ] || fail 'is current afterwards' "$(git -C "$ORIGIN" rev-parse main)" "$(head_of)"
touch -d "$OLD" "$CHECKOUT/agent/agent.js"

reset_state
git -C "$CHECKOUT" remote rename origin upstream
out="$(run)"
has 'no origin refuses the pull' "$out" 'pull: skipped: no origin remote'
git -C "$CHECKOUT" remote rename upstream origin

reset_state
chmod 555 "$CHECKOUT/.git"
out="$(run)"
chmod 755 "$CHECKOUT/.git"
if [ "$(id -u)" != 0 ]; then
  has 'an unwritable checkout refuses the pull' "$out" 'is not writable by'
fi

# ── Claude Code hooks (step 2b) ─────────────────────────────────────────────
SETTINGS="$HOME_DIR/.claude/settings.json"
reset_state
rm -f "$SETTINGS"
out="$(run)"
has 'no settings file: nothing to update' "$out" 'hooks: no '"$SETTINGS"'; nothing to update'
lacks 'and the updater is not asked' "$(cat "$LOG")" 'hooks-update'
has 'and the report says absent' "$(cat "$LOG")" '"hooks":"absent"'

mkdir -p "$HOME_DIR/.claude"; printf '{"hooks":{}}\n' > "$SETTINGS"
reset_state
out="$(run)"
has 'current hooks are checked' "$(cat "$LOG")" "hooks-update --check checkout=$CHECKOUT settings=$SETTINGS"
lacks 'and not applied' "$(cat "$LOG")" 'hooks-update apply'
has 'and say so' "$out" 'hooks: Claude Code hooks are current'
has 'and the report says current' "$(cat "$LOG")" '"hooks":"current"'

reset_state
echo behind > "$STATE/hooks"
out="$(run --check)"
rc=$?
[ "$rc" = 1 ] || fail '--check exits 1 when the hooks are behind' 1 "$rc"
lacks '--check does not apply the hooks' "$(cat "$LOG")" 'hooks-update apply'
has 'and says the hooks are behind (--check posts no report)' "$out" 'hooks: behind the checkout'

reset_state
mv "$STUB/hooks-update" "$STUB/hooks-update.off"
out="$(run)"
has 'no updater installed is reported' "$out" 'hooks: no termag-hooks-update at'
has 'and the report says missing' "$(cat "$LOG")" '"hooks":"missing"'
mv "$STUB/hooks-update.off" "$STUB/hooks-update"

reset_state
echo behind > "$STATE/hooks"
out="$(run)"
has 'behind hooks are applied with the checkout' "$(cat "$LOG")" "hooks-update apply checkout=$CHECKOUT settings=$SETTINGS"
has 'and the updater output is shown' "$out" 'updated settings.json'
has 'and the report says updated' "$(cat "$LOG")" '"hooks":"updated"'
has 'and the outcome stays current (no restart)' "$(cat "$LOG")" '"outcome":"current"'

reset_state
echo behind > "$STATE/hooks"; echo 1 > "$STATE/hooks-apply-rc"
out="$(run)"
has 'a failed apply is reported' "$out" 'hooks: termag-hooks-update exited 1'
has 'and fails the outcome' "$(cat "$LOG")" '"outcome":"failed"'
has 'naming the step' "$(cat "$LOG")" '"hooks":"failed"'

reset_state
echo broken > "$STATE/hooks"
out="$(run)"
has 'a settings file the updater refuses is a failure' "$out" 'hooks: termag-hooks-update --check exited 2'
lacks 'and nothing is applied' "$(cat "$LOG")" 'hooks-update apply'

reset_state
echo behind > "$STATE/hooks"
git -C "$CHECKOUT" checkout -q -b hooks-branch
out="$(run)"
lacks 'a developer checkout never touches the hooks' "$(cat "$LOG")" 'hooks-update'
has 'and the report says skipped' "$(cat "$LOG")" '"hooks":"skipped"'
git -C "$CHECKOUT" checkout -q main
git -C "$CHECKOUT" branch -q -D hooks-branch
rm -f "$SETTINGS"

# A disappeared/broken runtime must never turn an update into an outage, even
# without a lockfile (the dependency check alone is not a startup preflight).
for lock in present absent; do
  reset_state
  age_all
  touch "$CHECKOUT/agent/agent.js"
  if [ "$lock" = absent ]; then
    mv "$CHECKOUT/agent/package-lock.json" "$WORK/saved-lock"
    git -C "$CHECKOUT" update-index --assume-unchanged agent/package-lock.json
  fi
  cp "$STUB/node" "$WORK/saved-node"
  printf '#!/bin/sh\nexit 127\n' > "$STUB/node"
  out="$(run)"
  lacks "no restart with unusable Node and $lock lockfile" "$(cat "$LOG")" 'systemctl --user restart'
  has "reports blocked Node with $lock lockfile" "$(cat "$LOG")" '"agent":"blocked:node"'
  has 'Node failure needs attention now' "$(cat "$LOG")" '"outcome":"failed"'
  lacks 'unusable Node does not trigger npm' "$(cat "$LOG")" 'npm ci'
  : > "$LOG"
  out="$(run --check)"
  lacks '--check does not promise an unsafe restart' "$out" 'would restart'
  lacks '--check with no runtime never restarts' "$(cat "$LOG")" 'systemctl --user restart'
  mv "$WORK/saved-node" "$STUB/node"
  if [ "$lock" = absent ]; then
    mv "$WORK/saved-lock" "$CHECKOUT/agent/package-lock.json"
    git -C "$CHECKOUT" update-index --no-assume-unchanged agent/package-lock.json
  fi
done
reset_state
out="$(run)"
has 'restart resumes after Node is restored' "$(cat "$LOG")" 'systemctl --user restart'
age_all

# A reconciler can install the new file but fail to reload systemd. Checking
# the file on disk would miss the old ExecStart that the restart would use.
reset_state
touch "$CHECKOUT/agent/agent.js"
echo '/bin/bash -c source-nvm-and-exec-node' > "$STATE/execstart"
out="$(run)"
lacks 'old loaded launcher blocks restart' "$(cat "$LOG")" 'systemctl --user restart'
has 'old launcher failure is reported' "$(cat "$LOG")" '"agent":"blocked:launcher"'
has 'old launcher needs attention now' "$(cat "$LOG")" '"outcome":"failed"'
reset_state
out="$(run)"
has 'a successfully reloaded launcher permits the pending restart' "$(cat "$LOG")" 'systemctl --user restart'
reset_state
# systemd's property retains variables for expansion at process start.
echo 'argv[]=/bin/bash -c exec /bin/bash "$HOME/src/termag/agent/run-node.sh" "$HOME/src/termag/agent/agent.js"' > "$STATE/execstart"
out="$(run)"
has 'the shipped launcher with literal HOME is recognized' "$(cat "$LOG")" 'systemctl --user restart'
age_all

# ── the TUI ─────────────────────────────────────────────────────────────────
TUI_LOG="$WORK/tui-calls"; : > "$TUI_LOG"; export TUI_LOG
mkdir -p "$CHECKOUT/tui"
cat > "$CHECKOUT/tui/install.sh" <<'EOF'
#!/bin/sh
echo "$*" >> "$TUI_LOG"
case " $* " in *' --check '*) [ -e "$STATE/tui-current" ] && exit 0; echo 'STALE: tui/dist'; exit 1 ;; esac
touch "$STATE/tui-current"
EOF
reset_state
out="$(run)"
[ ! -s "$TUI_LOG" ] || fail 'a TUI never built is left alone' '(no calls)' "$(cat "$TUI_LOG")"
mkdir -p "$CHECKOUT/tui/dist"; : > "$CHECKOUT/tui/dist/index.js"
reset_state
out="$(run)"
has 'a built TUI is rebuilt when stale' "$(cat "$TUI_LOG")" "--quiet --node $STUB/node"
has 'and reported' "$out" 'tui: rebuilt'
: > "$TUI_LOG"
out="$(run)"
got="$(grep -c -- '--quiet' "$TUI_LOG")"
[ "$got" = 0 ] || fail 'a current TUI is only checked' 0 "$(cat "$TUI_LOG")"
# On a branch the TUI is not even checked: its installer runs npm ci too.
rm -f "$STATE/tui-current"
git -C "$CHECKOUT" checkout -q -b tui-branch
: > "$TUI_LOG"
out="$(run)"
[ ! -s "$TUI_LOG" ] || fail 'a branch never builds the TUI' '(no calls)' "$(cat "$TUI_LOG")"
has 'and says so' "$out" "tui: left alone: on branch 'tui-branch'"
git -C "$CHECKOUT" checkout -q main
git -C "$CHECKOUT" branch -q -D tui-branch

# ── argument handling ───────────────────────────────────────────────────────
run --nope >/dev/null 2>&1
rc=$?
[ "$rc" = 2 ] || fail 'unknown flag exits 2' 2 "$rc"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: pull guards, reconcile, Claude hooks, agent restart gating, deps, --check, TUI, --when-enabled'
  exit 0
fi
echo "$failures failure(s)"
exit 1
