#!/bin/sh
# Tests deploy/termag-claude-runner, the box-side launcher for one Claude Code
# cloud session, with a stub `claude`:
#
#   * it tightens the work order to 0600, seeds a per-order checkout from the
#     canonical clone with origin pointed back at the real remote, starts
#     `claude self-hosted-runner` with --capacity 1 and that base dir, exports
#     the slot as DEV_INSTANCE, and removes checkout and work order on exit
#   * without a canonical clone it starts anyway and the runner clones cold
#   * the webapp runner install's wrapper and hooks are passed only when
#     they exist
#   * Bedrock env never reaches the runner, and its host config is a copy
#     with the Claude gateway keys termag-credentials merged into the owner's
#     settings taken out (and the owner's own kept), never ~/.claude itself
#   * a bad order id, a bad slot, a missing work order and a claude without
#     the subcommand exit 2 before anything is started
#   * a hangup (tmux kill-session) reaches the runner, the script exits 129
#     instead of carrying on, and the work order and checkout are removed
#   * a launch owns its work order (moved to <order>.work-order.<pid>) and its
#     checkout (.launcher marker): a relaunch of the same order while the first
#     still winds down takes a directory of its own and leaves the first one's
#     checkout to it; a cleanup that finds another pid in the marker leaves
#     that directory alone
#   * day-old work orders and checkouts and week-old logs are swept on start,
#     except a checkout that a live process still runs from
#   * ~/.local/bin is first on the runner's PATH and SHELL is set (no login
#     shell starts it); goenv, pyenv, cargo and nvm's node are on PATH when the
#     box has them, since the session's tool shells never read ~/.zshrc
#   * a seeded checkout's dev-stack/.env.override names the session's slot
#     (DEV_INSTANCE=<slot>), so a make in a tmux pane stays on the slot; a
#     cold clone's target is left absent
#   * CLAUDE_RUNNER_REPO names the repository the checkout lives under and
#     seeds from
#   * STACK_AWS_PROFILE is exported, empty unless the caller set it (dev-up
#     then pulls through the default credential chain instead of skipping)
#   * a checkout whose work is not on origin (no push, push that failed, origin
#     unreachable, uncommitted changes) moves to ~/ccr/kept and is swept after
#     a week; pushed work (to origin or by URL) and a clean tree are removed
#   * with --otel-project and --otel-endpoint the session gets its OpenTelemetry
#     destination (OTLP/HTTP to that endpoint, resource attributes naming the
#     project, service, box and slot, plus the owner's and box's ids with
#     --user-key and --box-key) and never the content gates; the owner's
#     exporter credentials, per-signal settings and settings-file OTEL keys,
#     telemetry switch and header helper never reach it; the slot may be omitted before the
#     flags; one flag, a malformed id or a non-https endpoint turns it off and
#     says so
#   * with termag's runner hooks installed (TERMAG_CLAUDE_RUNNER_HOOKS), the
#     runner gets that --hooks-dir and no --exec-path even when webapp's
#     wrapper exists (the command hook execs it); the order and state dir are
#     exported for the hooks (with the launch pid); an exit reason the
#     post-session hook left for THIS launch is the end report's exitReason and
#     the file is removed, another launch's is left alone; without the termag
#     hooks the webapp shape is kept
#   * a checkout's bazel output base (output user root / md5 of the checkout
#     path) goes with the checkout, moved aside at once and deleted in the
#     background (a leftover moved-aside copy is swept at start), when DO_NOT_BUILD_HERE
#     names the checkout and no bazel server is live in it; a kept checkout's
#     base goes too (the move changes the path Bazel keys on); the start-up
#     sweep removes a base whose workspace is gone and leaves one with a live
#     server alone
#   * on exit, once the checkout is removed or kept, the end is reported to the
#     orchestrator's event route with the agent config's token (stdin, not
#     argv) and the runner's exit status, a
#     signal exit as exitReason=signal; a 404 or an unreachable server only
#     logs, and without an agent config nothing is posted; a launch that ends
#     while a newer launch of its order runs on the box reports nothing (the
#     newer one does)
#
# Run: sh deploy/termag-claude-runner.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/termag-claude-runner"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

command -v git >/dev/null 2>&1 || { echo "SKIP: git not installed"; exit 0; }
BASH_BIN="$(command -v bash)"
HOME_DIR="$WORK/home"
mkdir -p "$HOME_DIR/.termag/claude-runner" "$WORK/bin"

# Stub claude: `self-hosted-runner --help` succeeds; a real run records argv,
# env, the work order's mode and what the base dir held while it ran.
cat > "$WORK/bin/claude" <<'EOF'
#!/bin/sh
if [ "$1" = self-hosted-runner ] && [ "$2" = --help ]; then exit 0; fi
printf '%s\n' "$@" > "$RECORD.argv"
env > "$RECORD.env"
# STUB_BYTES: what the post-session hook would have measured (S5).
[ -n "${STUB_BYTES:-}" ] && printf '%s\n' "$STUB_BYTES" > "$TERMAG_CLAUDE_RUNNER_DIR/$TERMAG_CLAUDE_RUNNER_ORDER.checkout-bytes.$TERMAG_CLAUDE_RUNNER_LAUNCH"
f=$(printf '%s\n' "$@" | awk '/^--environment-secret-file$/{getline; print; exit}')
stat -c '%a' "$f" > "$RECORD.mode" 2>/dev/null || stat -f '%Lp' "$f" > "$RECORD.mode"
b=$(printf '%s\n' "$@" | awk '/^--base-dir$/{getline; print; exit}')
co="$b/${CLAUDE_RUNNER_REPO:-example-org/webapp}"
if [ -e "$co" ]; then printf 'exists\n' > "$RECORD.coexists"; else printf 'absent\n' > "$RECORD.coexists"; fi
if [ -d "$co/.git" ]; then
  git -C "$co" remote get-url origin > "$RECORD.origin"
  git -C "$co" rev-parse HEAD > "$RECORD.head"
else
  printf 'no-checkout\n' > "$RECORD.origin"
fi
h=$SELF_HOSTED_RUNNER_HOST_CONFIG_DIR
if [ -n "$h" ]; then printf '%s\n' "$h" > "$RECORD.hostdir"; ls -A "$h" > "$RECORD.hostls"; fi
[ -f "$h/settings.json" ] && cp "$h/settings.json" "$RECORD.hostsettings"
if [ -f "$co/dev-stack/.env.override" ]; then
  cp "$co/dev-stack/.env.override" "$RECORD.override"
fi
# STUB_GIT: what the session leaves behind. Every mode first checks the tree out.
if [ -n "${STUB_GIT:-}" ]; then
  g() { git -C "$co" -c user.name=t -c user.email=t@example.com "$@"; }
  g reset -q --hard
  case "$STUB_GIT" in
    clean) ;;
    dirty) printf 'x\n' > "$co/uncommitted.txt" ;;
    *) g checkout -q -b outcome; g commit -q --allow-empty -m work
       case "$STUB_GIT" in
         push) g push -q origin outcome ;;
         pushurl) g push -q "$(g remote get-url origin)" outcome ;;
         pushurl-then-unreachable) g push -q "$(g remote get-url origin)" outcome; mv "$(g remote get-url origin)" "$(g remote get-url origin).gone" ;;
       esac ;;
  esac
fi
# STUB_REASON: what the post-session hook would leave for the exit trap.
if [ -n "${STUB_REASON:-}" ]; then printf '%s\n' "$STUB_REASON" > "$TERMAG_CLAUDE_RUNNER_DIR/$TERMAG_CLAUDE_RUNNER_ORDER.exit-reason.$TERMAG_CLAUDE_RUNNER_LAUNCH"; fi
if [ -n "${STUB_SLEEP:-}" ]; then
  trap 'printf term > "$RECORD.term"; exit 143' TERM
  while :; do sleep 0.1; done
fi
exit "${STUB_EXIT:-0}"
EOF
chmod +x "$WORK/bin/claude"

# Stub curl: records the command line, the config fed on stdin (-K -) and the
# -d body; answers the status STUB_CURL_CODE (default 204), never the network.
cat > "$WORK/bin/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" > "$RECORD.curl.argv"
body=; cfg=
while [ $# -gt 0 ]; do
  case "$1" in
    -d) body=$2; shift ;;
    -K) [ "$2" = - ] && cfg=$(cat); shift ;;
  esac
  shift
done
printf '%s\n' "$body" > "$RECORD.curl.body"
printf '%s\n' "$cfg" > "$RECORD.curl.stdin"
# Whether the session directory is still there when the report is posted.
if [ -n "${STUB_CHECK_DIR:-}" ]; then
  if [ -e "$STUB_CHECK_DIR" ]; then printf 'present\n' > "$RECORD.curl.dirstate"; else printf 'absent\n' > "$RECORD.curl.dirstate"; fi
fi
printf '%s' "${STUB_CURL_CODE:-204}"
EOF
chmod +x "$WORK/bin/curl"

# Canonical clone with one commit and a GitHub-shaped origin.
CANON="$HOME_DIR/ccr/example-org/webapp"
mkdir -p "$CANON"
git -C "$CANON" init -q
# webapp ignores the file the wrapper writes into every seeded checkout, so a
# session that changed nothing still reads as clean to the keep-or-remove check.
printf 'dev-stack/.env.override\n' > "$CANON/.gitignore"
git -C "$CANON" add .gitignore
git -C "$CANON" -c user.name=t -c user.email=t@example.com commit -q -m seed
git -C "$CANON" remote add origin ssh://git@github.com/example-org/webapp.git
CANON_HEAD="$(git -C "$CANON" rev-parse HEAD)"

seed_order() {
  printf 'a.b.c\n' > "$HOME_DIR/.termag/claude-runner/$1.work-order"
  chmod 644 "$HOME_DIR/.termag/claude-runner/$1.work-order"
}

run() {
  # $1 = order id, $2 = slot ('' for the default), rest = extra env
  o=$1; sl=$2; shift 2
  env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$HOME_DIR" RECORD="$WORK/record" \
    CLAUDE_CODE_USE_BEDROCK=1 ANTHROPIC_BEDROCK_BASE_URL=https://gw.example \
    "$@" "$BASH_BIN" "$SCRIPT" "$o" $sl 2>"$WORK/err"
}
# Like run, with the script's own flags after order and slot; the owner's shell
# carries telemetry content gates, which must never reach the session.
run_flags() {
  o=$1; sl=$2; shift 2
  env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$HOME_DIR" RECORD="$WORK/record" \
    OTEL_LOG_USER_PROMPTS=1 OTEL_LOG_TOOL_DETAILS=1 OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer owner' \
    OTEL_EXPORTER_OTLP_METRICS_HEADERS='x-api-key=owner' OTEL_EXPORTER_OTLP_CLIENT_KEY=/owner/key OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://owner.example.test \
    "$BASH_BIN" "$SCRIPT" "$o" "$sl" "$@" 2>"$WORK/err"
}
argv_has() { grep -qx -- "$1" "$WORK/record.argv"; }
# Files in the runner state dir whose name starts with $1 (SC2010: not ls | grep).
leftovers() { find "$HOME_DIR/.termag/claude-runner" -maxdepth 1 -name "$1*" 2>/dev/null; }

# ── plain run, slot 3 ───────────────────────────────────────────────────────
rm -f "$WORK"/record.*
seed_order ord-1
run ord-1 3; got=$?
[ "$got" = 0 ] || fail 'runner exit code is passed through' 0 "$got"
mode="$(cat "$WORK/record.mode" 2>/dev/null)"
[ "$mode" = 600 ] || fail 'work order is 0600 before the runner reads it' 600 "$mode"
[ ! -e "$HOME_DIR/.termag/claude-runner/ord-1.work-order" ] || fail 'work order removed after the runner exits' '(gone)' 'present'
argv_has '--capacity' && argv_has '1' || fail 'capacity 1' '--capacity 1' "$(tr '\n' ' ' <"$WORK/record.argv")"
grep -qE "^$HOME_DIR/.termag/claude-runner/ord-1\.work-order\.[0-9]+$" "$WORK/record.argv" || fail 'the environment secret file is the per-launch copy of the work order' 'ord-1.work-order.<pid> in argv' "$(tr '\n' ' ' <"$WORK/record.argv")"
[ -z "$(leftovers ord-1.work-order)" ] || fail 'no copy of the work order is left after the runner exits' '(none)' "$(leftovers ord-1.work-order)"
argv_has '--remove-session-state' || fail 'per-session state is removed' '--remove-session-state' "$(tr '\n' ' ' <"$WORK/record.argv")"
argv_has '--drain-grace-sec' || fail 'one-shot exit is explicit (--drain-grace-sec 0)' '--drain-grace-sec 0' "$(tr '\n' ' ' <"$WORK/record.argv")"
argv_has "$HOME_DIR/ccr/sessions/ord-1" || fail 'base dir is per order under ~/ccr/sessions' "$HOME_DIR/ccr/sessions/ord-1" "$(tr '\n' ' ' <"$WORK/record.argv")"
origin="$(cat "$WORK/record.origin" 2>/dev/null)"
[ "$origin" = 'ssh://git@github.com/example-org/webapp.git' ] || fail 'checkout seeded with origin pointed at GitHub, not the canonical path' 'ssh://git@github.com/example-org/webapp.git' "$origin"
head="$(cat "$WORK/record.head" 2>/dev/null)"
[ "$head" = "$CANON_HEAD" ] || fail 'seeded checkout has the canonical history' "$CANON_HEAD" "$head"
[ ! -e "$HOME_DIR/ccr/sessions/ord-1" ] || fail 'per-order checkout removed after the runner exits' '(gone)' 'present'
[ -d "$CANON/.git" ] || fail 'canonical clone untouched' 'present' 'gone'
grep -q '^DEV_INSTANCE=3$' "$WORK/record.env" || fail 'slot exported as DEV_INSTANCE' 'DEV_INSTANCE=3' "$(grep DEV_INSTANCE "$WORK/record.env")"
grep -q '^WEBAPP_RUNNER_DEV_INSTANCE=3$' "$WORK/record.env" || fail 'slot exported for the webapp wrapper' 'WEBAPP_RUNNER_DEV_INSTANCE=3' "$(grep RUNNER_DEV "$WORK/record.env")"
grep -qx 'STACK_AWS_PROFILE=' "$WORK/record.env" || fail 'STACK_AWS_PROFILE exported empty (ECR pull through the default credential chain)' 'STACK_AWS_PROFILE=' "$(grep STACK_AWS "$WORK/record.env")"
grep -q -- '-s3$' "$WORK/record.argv" || fail 'client label carries the slot' '...-s3' "$(grep -- '-s' "$WORK/record.argv" | head -1)"
argv_has '--exec-path' && fail 'no wrapper without the webapp install' '(absent)' '--exec-path'
argv_has '--hooks-dir' && fail 'no hooks dir without the webapp install' '(absent)' '--hooks-dir'
grep -q '^CLAUDE_CODE_USE_BEDROCK=' "$WORK/record.env" && fail 'Bedrock env is unset for the runner' '(absent)' 'CLAUDE_CODE_USE_BEDROCK set'
grep -q '^ANTHROPIC_BEDROCK_BASE_URL=' "$WORK/record.env" && fail 'Bedrock URL is unset for the runner' '(absent)' 'set'
grep -q '^DISABLE_AUTOUPDATER=1' "$WORK/record.env" || fail 'autoupdater off' 'DISABLE_AUTOUPDATER=1' "$(grep AUTOUPDATER "$WORK/record.env")"
grep -q '^WEBAPP_CLOUD_ENV=termag' "$WORK/record.env" || fail 'WEBAPP_CLOUD_ENV=termag' 'set' "$(grep WEBAPP_CLOUD "$WORK/record.env")"
grep -q '^CLAUDE_CODE_ENABLE_TELEMETRY=' "$WORK/record.env" && fail 'no session telemetry without the flags' '(absent)' 'CLAUDE_CODE_ENABLE_TELEMETRY set'
grep -q "^PATH=$HOME_DIR/.local/bin:" "$WORK/record.env" || fail 'the user bin dir is first on PATH' "PATH=$HOME_DIR/.local/bin:..." "$(grep '^PATH=' "$WORK/record.env")"
grep -q '^SHELL=/' "$WORK/record.env" || fail 'SHELL is set for the Bash tool snapshot (env -i cleared it)' 'SHELL=/...' "$(grep '^SHELL=' "$WORK/record.env")"

# ── version managers on PATH (a box with goenv, pyenv, cargo and nvm) ──────
mkdir -p "$HOME_DIR/.goenv/bin" "$HOME_DIR/.goenv/shims" "$HOME_DIR/.pyenv/bin" "$HOME_DIR/.pyenv/shims" "$HOME_DIR/.cargo/bin" "$HOME_DIR/.nvm"
printf 'export PATH="$HOME/.nvm/versions/node/fake/bin:$PATH"\n' > "$HOME_DIR/.nvm/nvm.sh"
rm -f "$WORK"/record.*
seed_order ord-vm
run ord-vm 2; got=$?
[ "$got" = 0 ] || fail 'runs with version managers present' 0 "$got"
vm_path="$(grep '^PATH=' "$WORK/record.env")"
case "$vm_path" in *"$HOME_DIR/.goenv/bin:$HOME_DIR/.goenv/shims:"*) ;; *) fail 'goenv bin and shims are on the session PATH' "$HOME_DIR/.goenv/bin:$HOME_DIR/.goenv/shims" "$vm_path" ;; esac
case "$vm_path" in *"$HOME_DIR/.pyenv/bin:$HOME_DIR/.pyenv/shims:"*) ;; *) fail 'pyenv bin and shims are on the session PATH' "$HOME_DIR/.pyenv/bin:$HOME_DIR/.pyenv/shims" "$vm_path" ;; esac
case "$vm_path" in *"$HOME_DIR/.cargo/bin:"*) ;; *) fail 'cargo bin is on the session PATH' "$HOME_DIR/.cargo/bin" "$vm_path" ;; esac
case "$vm_path" in *"$HOME_DIR/.nvm/versions/node/fake/bin:"*) ;; *) fail 'nvm is sourced so node is on the session PATH' "$HOME_DIR/.nvm/versions/node/fake/bin" "$vm_path" ;; esac
case "$vm_path" in *"$HOME_DIR/.local/bin:"*) ;; *) fail 'the user bin dir stays on PATH' "$HOME_DIR/.local/bin" "$vm_path" ;; esac
grep -q "^GOENV_ROOT=$HOME_DIR/.goenv$" "$WORK/record.env" || fail 'GOENV_ROOT exported' "GOENV_ROOT=$HOME_DIR/.goenv" "$(grep GOENV_ROOT "$WORK/record.env")"
grep -q "^PYENV_ROOT=$HOME_DIR/.pyenv$" "$WORK/record.env" || fail 'PYENV_ROOT exported' "PYENV_ROOT=$HOME_DIR/.pyenv" "$(grep PYENV_ROOT "$WORK/record.env")"
rm -rf "$HOME_DIR/.goenv" "$HOME_DIR/.pyenv" "$HOME_DIR/.cargo" "$HOME_DIR/.nvm"

# ── dotted order id: runs with the raw id ───────────────────────────────────
rm -f "$WORK"/record.*
seed_order ord.7
run ord.7 2; got=$?
[ "$got" = 0 ] || fail 'dotted order id runs' 0 "$got"
grep -qE "^$HOME_DIR/.termag/claude-runner/ord\.7\.work-order\.[0-9]+$" "$WORK/record.argv" || fail 'dotted order id keeps its work order name' 'ord.7.work-order.<pid>' "$(tr '\n' ' ' <"$WORK/record.argv")"

# ── default slot is 2 ───────────────────────────────────────────────────────
rm -f "$WORK"/record.*
seed_order ord-1b
run ord-1b ''; got=$?
grep -q '^DEV_INSTANCE=2$' "$WORK/record.env" || fail 'slot defaults to 2' 'DEV_INSTANCE=2' "$(grep '^DEV_INSTANCE' "$WORK/record.env")"

# ── no ~/ccr canonical: falls back to the image's ~/src/webapp ────────────
SRC="$HOME_DIR/src/webapp"
mkdir -p "$SRC"
git -C "$SRC" init -q
git -C "$SRC" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m image
git -C "$SRC" remote add origin https://github.com/example-org/webapp
SRC_HEAD="$(git -C "$SRC" rev-parse HEAD)"
rm -f "$WORK"/record.*
seed_order ord-2a
run ord-2a 2 CLAUDE_RUNNER_ROOT="$WORK/empty-root"; got=$?
[ "$got" = 0 ] || fail 'starts from the image checkout when ~/ccr has no clone' 0 "$got"
[ "$(cat "$WORK/record.head" 2>/dev/null)" = "$SRC_HEAD" ] || fail 'seeded from ~/src/webapp when ~/ccr has no clone' "$SRC_HEAD" "$(cat "$WORK/record.head" 2>/dev/null)"
[ "$(cat "$WORK/record.origin")" = 'https://github.com/example-org/webapp' ] || fail 'origin follows the seed source remote' 'https://github.com/example-org/webapp' "$(cat "$WORK/record.origin")"
rm -rf "$SRC"


# ── host config: the owner's settings, without the Claude gateway keys ──────
mkdir -p "$HOME_DIR/.claude/skills/s" "$HOME_DIR/.claude/projects/p" "$HOME_DIR/.config/termag"
printf '%s' '{"hooks":{"Stop":[]},"apiKeyHelper":"\u0027/h/.local/bin/termag-claude-token\u0027 \u0027/h/cfg\u0027","env":{"CLAUDE_CODE_USE_BEDROCK":"1","ANTHROPIC_MODEL":"mine","BASH_DEFAULT_TIMEOUT_MS":"1","OTEL_LOG_USER_PROMPTS":"1"}}' > "$HOME_DIR/.claude/settings.json"
printf '%s' '{"apiKeyHelper":"\u0027/h/.local/bin/termag-claude-token\u0027 \u0027/h/cfg\u0027","env":{"CLAUDE_CODE_USE_BEDROCK":"1","ANTHROPIC_MODEL":"us.anthropic.claude-opus-5-5"}}' > "$HOME_DIR/.config/termag/claude-gateway.json"
rm -f "$WORK"/record.*
seed_order ord-hc
run ord-hc 2
got="$(cat "$WORK/record.hostdir" 2>/dev/null)"
[ "$got" = "$HOME_DIR/ccr/sessions/ord-hc/host-config" ] || fail 'host config is a per-launch copy, never ~/.claude' "$HOME_DIR/ccr/sessions/ord-hc/host-config" "$got"
got="$(jq -c . "$WORK/record.hostsettings" 2>&1)"
[ "$got" = '{"hooks":{"Stop":[]},"env":{"ANTHROPIC_MODEL":"mine","BASH_DEFAULT_TIMEOUT_MS":"1"}}' ] \
  || fail "the host config drops the gateway keys and the telemetry content gates, and keeps the owner's own" '{"hooks":..,"env":{"ANTHROPIC_MODEL":"mine",..}}' "$got"
got="$(sort "$WORK/record.hostls" | tr '\n' ' ')"
[ "$got" = 'settings.json skills ' ] || fail "from ~/.claude only settings, CLAUDE.md, agents, skills, commands are copied" 'settings.json skills ' "$got"
jq -e '.env.CLAUDE_CODE_USE_BEDROCK == "1"' "$HOME_DIR/.claude/settings.json" >/dev/null || fail "the owner's own settings.json is untouched" 'gateway keys still there' "$(cat "$HOME_DIR/.claude/settings.json")"
# Without a record (an older termag-credentials), our token helper still goes.
rm -f "$HOME_DIR/.config/termag/claude-gateway.json" "$WORK"/record.*
seed_order ord-hc2
run ord-hc2 2
got="$(jq -r '.apiKeyHelper // "absent"' "$WORK/record.hostsettings" 2>&1)"
[ "$got" = absent ] || fail "termag's token helper never reaches the host config" absent "$got"

# ── host config: termag's hooks merged in, whichever source was copied (S4) ──
# termag-hooks-update (the real script) and its canonical file, as a box has
# them; webapp's runner config carries a stale Stop hook and one of the
# owner's own, which stays.
mkdir -p "$HOME_DIR/.local/bin" "$HOME_DIR/src/termag/deploy" "$HOME_DIR/.claude-runner/config"
cp "$HERE/termag-hooks-update" "$HOME_DIR/.local/bin/termag-hooks-update"; chmod +x "$HOME_DIR/.local/bin/termag-hooks-update"
cp "$HERE/claude-settings.json" "$HOME_DIR/src/termag/deploy/claude-settings.json"
printf '%s' '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"\"$HOME/.local/bin/termag-status\" idle >/dev/null 2>&1 &"}]},{"hooks":[{"type":"command","command":"echo mine"}]}]},"env":{"ANTHROPIC_MODEL":"mine"}}' > "$HOME_DIR/.claude-runner/config/settings.json"
rm -f "$WORK"/record.*
seed_order ord-hooks
run ord-hooks 2
got="$(jq -r '[.hooks.Stop[].hooks[].command] | join(" || ")' "$WORK/record.hostsettings" 2>&1)"
case "$got" in
  'echo mine || '*'termag-status" stop'*) ;;
  *) fail "termag's canonical hooks replace the copied termag-status entries and keep the owner's" 'echo mine || ...termag-status stop...' "$got" ;;
esac
[ "$(jq -r '.hooks.UserPromptSubmit | length' "$WORK/record.hostsettings")" = 1 ] || fail 'events the copied config lacked are added' 1 "$(jq -c '.hooks | keys' "$WORK/record.hostsettings")"
[ "$(jq -r '.env.ANTHROPIC_MODEL' "$WORK/record.hostsettings")" = mine ] || fail "the owner's env survives the merge" mine "$(jq -c .env "$WORK/record.hostsettings")"
[ -z "$(find "$HOME_DIR/ccr/sessions/ord-hooks/host-config" -name 'settings.json.bak.*' 2>/dev/null)" ] || fail 'no backup file is left in the host config' none "$(ls "$HOME_DIR/ccr/sessions/ord-hooks/host-config")"
grep -q "^TERMAG_CLAUDE_RUNNER_BASE_DIR=$HOME_DIR/ccr/sessions/ord-hooks$" "$WORK/record.env" || fail 'the base dir reaches the hooks' "TERMAG_CLAUDE_RUNNER_BASE_DIR=.../ord-hooks" "$(grep '^TERMAG_CLAUDE_RUNNER_BASE_DIR=' "$WORK/record.env")"
rm -rf "$HOME_DIR/.claude-runner" "$HOME_DIR/.local/bin/termag-hooks-update" "$HOME_DIR/src/termag"

rm -rf "$HOME_DIR/.claude" "$HOME_DIR/.config/termag"

# ── no canonical clone anywhere: still starts, runner clones cold ───────────
rm -f "$WORK"/record.*
seed_order ord-2
run ord-2 2 CLAUDE_RUNNER_CANONICAL="$WORK/nowhere"; got=$?
[ "$got" = 0 ] || fail 'starts without a canonical clone' 0 "$got"
[ "$(cat "$WORK/record.origin")" = 'no-checkout' ] || fail 'no seeded checkout without a canonical clone' 'no-checkout' "$(cat "$WORK/record.origin")"
grep -q 'clone cold' "$WORK/err" || fail 'says the runner will clone cold' 'clone cold' "$(cat "$WORK/err")"

# ── with the webapp runner install present ────────────────────────────────
mkdir -p "$HOME_DIR/.config/claude-runner/hooks" "$HOME_DIR/.claude-runner/config"
: > "$HOME_DIR/.claude-runner/config/marker"
printf '#!/bin/sh\nexec "$@"\n' > "$HOME_DIR/.config/claude-runner/session-wrapper.sh"
chmod +x "$HOME_DIR/.config/claude-runner/session-wrapper.sh"
rm -f "$WORK"/record.*
seed_order ord-3
run ord-3 2; got=$?
argv_has '--exec-path' || fail 'wrapper passed when installed' '--exec-path' "$(tr '\n' ' ' <"$WORK/record.argv")"
argv_has '--hooks-dir' || fail 'hooks dir passed when installed' '--hooks-dir' "$(tr '\n' ' ' <"$WORK/record.argv")"
got="$(cat "$WORK/record.hostls" 2>/dev/null)"
[ "$got" = marker ] || fail "the webapp install's host config is copied whole" marker "$got"

# ── runner failure propagates, work order and checkout still removed ────────
rm -f "$WORK"/record.*
seed_order ord-4
run ord-4 4 STUB_EXIT=7; got=$?
[ "$got" = 7 ] || fail 'runner failure exit code propagates' 7 "$got"
[ ! -e "$HOME_DIR/.termag/claude-runner/ord-4.work-order" ] || fail 'work order removed after a failed runner' '(gone)' 'present'
[ ! -e "$HOME_DIR/ccr/sessions/ord-4" ] || fail 'checkout removed after a failed runner' '(gone)' 'present'

# ── hangup (tmux kill-session): passed on to the runner, script stops ───────
rm -f "$WORK"/record.*
seed_order ord-hup
env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$HOME_DIR" RECORD="$WORK/record" STUB_SLEEP=1 \
  "$BASH_BIN" "$SCRIPT" ord-hup 2 2>"$WORK/err" &
pid=$!
for _ in $(seq 1 50); do [ -e "$WORK/record.argv" ] && break; sleep 0.1; done
kill -HUP "$pid"
for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$pid" 2>/dev/null; then
  fail 'a hangup stops the script' 'exited' 'still running after 5 s'
  pkill -KILL -P "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null
fi
wait "$pid"; got=$?
[ "$got" = 129 ] || fail 'a hangup ends the script with 129' 129 "$got"
[ "$(cat "$WORK/record.term" 2>/dev/null)" = term ] || fail 'the hangup reaches the runner as TERM' term "$(cat "$WORK/record.term" 2>/dev/null)"
[ -z "$(leftovers ord-hup.work-order)" ] || fail 'work order removed after a hangup' '(gone)' 'present'
[ ! -e "$HOME_DIR/ccr/sessions/ord-hup" ] || fail 'checkout removed after a hangup' '(gone)' 'present'

# ── a relaunch of the same order while the first launch still winds down ───
rm -f "$WORK"/record.* "$WORK"/record-b.*
seed_order ord-race
env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$HOME_DIR" RECORD="$WORK/record" STUB_SLEEP=1 \
  "$BASH_BIN" "$SCRIPT" ord-race 2 2>"$WORK/err" &
pid=$!
for _ in $(seq 1 50); do [ -e "$WORK/record.argv" ] && break; sleep 0.1; done
# The backend placed the order again (a fresh work order at the canonical
# path) and started a second launcher while the first still runs.
seed_order ord-race
env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$HOME_DIR" RECORD="$WORK/record-b" "$BASH_BIN" "$SCRIPT" ord-race 2 2>"$WORK/err-b"; got=$?
[ "$got" = 0 ] || fail 'the relaunch runs' 0 "$got"
grep -qE "^$HOME_DIR/ccr/sessions/ord-race\.[0-9]+$" "$WORK/record-b.argv" || fail 'the relaunch takes a directory of its own' "$HOME_DIR/ccr/sessions/ord-race.<pid>" "$(grep -A1 -- '--base-dir' "$WORK/record-b.argv" | tail -1)"
grep -q 'still winds down' "$WORK/err-b" || fail 'the relaunch says why it took another directory' 'still winds down' "$(cat "$WORK/err-b")"
[ -d "$HOME_DIR/ccr/sessions/ord-race/example-org/webapp/.git" ] || fail "the first launch's checkout is untouched while it winds down" 'present' 'gone'
[ -z "$(find "$HOME_DIR/ccr/sessions" -maxdepth 1 -name 'ord-race.*' 2>/dev/null)" ] || fail "the relaunch's own directory is removed when its runner exits" '(none)' "$(find "$HOME_DIR/ccr/sessions" -maxdepth 1 -name 'ord-race.*')"
[ ! -e "$HOME_DIR/.termag/claude-runner/ord-race.work-order" ] || fail 'the relaunch took the fresh work order' '(gone)' 'present'
[ "$(leftovers ord-race.work-order. | wc -l | tr -d ' ')" = 1 ] || fail "only the first launch's own copy of the work order remains" '1' "$(leftovers ord-race.work-order. | wc -l | tr -d ' ')"
kill -HUP "$pid"
for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
kill -0 "$pid" 2>/dev/null && { pkill -KILL -P "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null; }
wait "$pid" 2>/dev/null
[ ! -e "$HOME_DIR/ccr/sessions/ord-race" ] || fail "the first launch removes its own checkout when it finally exits" '(gone)' 'present'
[ -z "$(leftovers ord-race.work-order)" ] || fail 'no work order copy is left once both launches are gone' '(none)' "$(leftovers ord-race.work-order)"

# ── cleanup leaves a directory whose marker names another launch ────────────
rm -f "$WORK"/record.*
seed_order ord-mark
env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$HOME_DIR" RECORD="$WORK/record" STUB_SLEEP=1 \
  "$BASH_BIN" "$SCRIPT" ord-mark 2 2>"$WORK/err" &
pid=$!
for _ in $(seq 1 50); do [ -e "$WORK/record.argv" ] && break; sleep 0.1; done
printf '999999\n' > "$HOME_DIR/ccr/sessions/ord-mark/.launcher"
kill -HUP "$pid"
for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
kill -0 "$pid" 2>/dev/null && { pkill -KILL -P "$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null; }
wait "$pid" 2>/dev/null
[ -d "$HOME_DIR/ccr/sessions/ord-mark" ] || fail 'a directory marked as another launch is left alone' 'present' 'gone'
grep -q 'newer launch of this order owns it' "$WORK/err" || fail 'the cleanup says why it left the directory' 'newer launch of this order owns it' "$(cat "$WORK/err")"
rm -rf "$HOME_DIR/ccr/sessions/ord-mark"

# ── leftovers of runners that died without cleanup are swept ────────────────
rd="$HOME_DIR/.termag/claude-runner"
printf 'x\n' > "$rd/dead.work-order"; touch -t 202001010000 "$rd/dead.work-order"
printf 'x\n' > "$rd/dead.log"; touch -t 202001010000 "$rd/dead.log"
printf 'x\n' > "$rd/recent.log"
mkdir -p "$HOME_DIR/ccr/sessions/dead/example-org"; touch -t 202001010000 "$HOME_DIR/ccr/sessions/dead"
rm -f "$WORK"/record.*
seed_order ord-sweep
run ord-sweep 2; got=$?
[ "$got" = 0 ] || fail 'runs after sweeping' 0 "$got"
[ ! -e "$rd/dead.work-order" ] || fail 'day-old work order swept' '(gone)' 'present'
[ ! -e "$rd/dead.log" ] || fail 'week-old log swept' '(gone)' 'present'
[ -e "$rd/recent.log" ] || fail 'recent log kept' 'present' 'gone'
[ ! -e "$HOME_DIR/ccr/sessions/dead" ] || fail 'day-old checkout swept' '(gone)' 'present'

# a day-old directory that a process still runs from is left alone (the check reads /proc)
if [ -d /proc/self ]; then
  mkdir -p "$HOME_DIR/ccr/sessions/busy/example-org"; touch -t 202001010000 "$HOME_DIR/ccr/sessions/busy"
  ( cd "$HOME_DIR/ccr/sessions/busy/example-org" && exec sleep 300 ) & busy_pid=$!
  rm -f "$WORK"/record.*
  seed_order ord-busy
  run ord-busy 2; got=$?
  [ "$got" = 0 ] || fail 'runs with a busy day-old directory' 0 "$got"
  [ -d "$HOME_DIR/ccr/sessions/busy" ] || fail 'day-old directory a process runs from is left alone' 'present' 'gone'
  grep -q 'left .*/ccr/sessions/busy alone' "$WORK/err" || fail 'sweep says why it left the directory' 'left ... alone' "$(tr '\n' ' ' <"$WORK/err" | cut -c1-200)"
  kill "$busy_pid" 2>/dev/null; wait "$busy_pid" 2>/dev/null
  rm -rf "$HOME_DIR/ccr/sessions/busy"

  # the same through a symlinked runner root: /proc reports canonical paths, so the check has to canonicalize the directory
  mkdir -p "$HOME_DIR/ccr/sessions/busy-link/example-org"; touch -t 202001010000 "$HOME_DIR/ccr/sessions/busy-link"
  ln -s "$HOME_DIR/ccr" "$WORK/ccr-link"
  ( cd "$HOME_DIR/ccr/sessions/busy-link/example-org" && exec sleep 300 ) & link_pid=$!
  rm -f "$WORK"/record.*
  seed_order ord-link
  run ord-link 2 CLAUDE_RUNNER_ROOT="$WORK/ccr-link"; got=$?
  [ "$got" = 0 ] || fail 'runs with a symlinked runner root' 0 "$got"
  [ -d "$HOME_DIR/ccr/sessions/busy-link" ] || fail 'busy day-old directory survives the sweep through a symlinked root' 'present' 'gone'
  kill "$link_pid" 2>/dev/null; wait "$link_pid" 2>/dev/null
  rm -rf "$HOME_DIR/ccr/sessions/busy-link" "$WORK/ccr-link"
fi

# ── the session checkout's slot file ───────────────────────────────────────
rm -f "$WORK"/record.*
seed_order ord-cf4
run ord-cf4 4 STACK_AWS_PROFILE=owner-profile; got=$?
[ "$(cat "$WORK/record.override" 2>/dev/null)" = 'DEV_INSTANCE=4' ] || fail 'the seeded checkout names its slot' 'DEV_INSTANCE=4' "$(cat "$WORK/record.override" 2>/dev/null)"
grep -qx 'STACK_AWS_PROFILE=owner-profile' "$WORK/record.env" || fail 'a STACK_AWS_PROFILE the caller set is kept' 'STACK_AWS_PROFILE=owner-profile' "$(grep STACK_AWS "$WORK/record.env")"

rm -f "$WORK"/record.*
seed_order ord-cf3
run ord-cf3 2 CLAUDE_RUNNER_CANONICAL="$WORK/nowhere"; got=$?
[ "$(cat "$WORK/record.coexists" 2>/dev/null)" = absent ] || fail "a cold clone's target is left absent for the runner" absent "$(cat "$WORK/record.coexists" 2>/dev/null)"

# CLAUDE_RUNNER_REPO picks the repository: its canonical clone seeds, and the
# checkout lives under its owner/name.
OCANON="$HOME_DIR/ccr/other-org/app"
git init -q "$OCANON"
git -C "$OCANON" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m seed
git -C "$OCANON" remote add origin https://example.invalid/other-org/app.git
rm -f "$WORK"/record.*
seed_order ord-repo
run ord-repo 2 CLAUDE_RUNNER_REPO=other-org/app; got=$?
[ "$got" = 0 ] || fail 'CLAUDE_RUNNER_REPO: runs' 0 "$got"
[ "$(cat "$WORK/record.head" 2>/dev/null)" = "$(git -C "$OCANON" rev-parse HEAD)" ] || fail 'CLAUDE_RUNNER_REPO: seeded from ~/ccr/<repo>' "$(git -C "$OCANON" rev-parse HEAD)" "$(cat "$WORK/record.head" 2>/dev/null)"
[ "$(cat "$WORK/record.origin" 2>/dev/null)" = https://example.invalid/other-org/app.git ] || fail "CLAUDE_RUNNER_REPO: origin is that repository's" https://example.invalid/other-org/app.git "$(cat "$WORK/record.origin" 2>/dev/null)"
rm -rf "$HOME_DIR/ccr/other-org"

# ── keeping a checkout whose work is not on origin ─────────────────────────
GCANON="$WORK/gcanon"
git init -q --bare "$WORK/origin.git"
git init -q "$GCANON"
printf 'dev-stack/.env.override\n' > "$GCANON/.gitignore"
git -C "$GCANON" add .gitignore
git -C "$GCANON" -c user.name=t -c user.email=t@example.com commit -q -m seed
git -C "$GCANON" remote add origin "$WORK/origin.git"
git -C "$GCANON" push -q origin HEAD 2>/dev/null
kept_for() { ls -d "$HOME_DIR/ccr/kept/$1"-* 2>/dev/null | head -1; }
for mode in clean push pushurl; do
  rm -f "$WORK"/record.*
  seed_order "ord-k-$mode"
  run "ord-k-$mode" 2 CLAUDE_RUNNER_CANONICAL="$GCANON" STUB_GIT=$mode; got=$?
  [ "$got" = 0 ] || fail "$mode: runs" 0 "$got"
  [ ! -e "$HOME_DIR/ccr/sessions/ord-k-$mode" ] || fail "$mode: checkout removed" '(gone)' 'present'
  [ -z "$(kept_for "ord-k-$mode")" ] || fail "$mode: nothing kept" '(none)' "$(kept_for "ord-k-$mode")"
  git -C "$WORK/origin.git" branch -D -q outcome 2>/dev/null
done
for mode in none dirty pushurl-then-unreachable; do
  rm -f "$WORK"/record.*
  seed_order "ord-k-$mode"
  run "ord-k-$mode" 2 CLAUDE_RUNNER_CANONICAL="$GCANON" STUB_GIT=$mode; got=$?
  [ "$got" = 0 ] || fail "$mode: runs" 0 "$got"
  [ ! -e "$HOME_DIR/ccr/sessions/ord-k-$mode" ] || fail "$mode: session dir moved away" '(gone)' 'present'
  k=$(kept_for "ord-k-$mode")
  [ -n "$k" ] && [ -d "$k/example-org/webapp/.git" ] || fail "$mode: checkout kept under ~/ccr/kept" "$HOME_DIR/ccr/kept/ord-k-$mode-*" "${k:-(none)}"
  grep -q 'not on GitHub' "$WORK/err" || fail "$mode: says why it kept the checkout" 'not on GitHub' "$(cat "$WORK/err")"
  [ "$mode" = pushurl-then-unreachable ] && mv "$WORK/origin.git.gone" "$WORK/origin.git"
  git -C "$WORK/origin.git" branch -D -q outcome 2>/dev/null
done
[ ! -e "$HOME_DIR/.termag/claude-runner/ord-k-none.work-order" ] || fail 'work order removed even when the checkout is kept' '(gone)' 'present'

# ~/ccr/kept cannot be created (a file is in the way): the work stays in place.
mv "$HOME_DIR/ccr/kept" "$WORK/kept.saved"; printf 'x\n' > "$HOME_DIR/ccr/kept"
rm -f "$WORK"/record.*
seed_order ord-k-nomove
run ord-k-nomove 2 CLAUDE_RUNNER_CANONICAL="$GCANON" STUB_GIT=none; got=$?
[ -d "$HOME_DIR/ccr/sessions/ord-k-nomove/example-org/webapp/.git" ] || fail 'a failed move keeps the checkout in place' 'present' 'gone'
grep -q 'in place' "$WORK/err" || fail 'a failed move says where the work is' 'in place' "$(cat "$WORK/err")"
rm -f "$HOME_DIR/ccr/kept"; mv "$WORK/kept.saved" "$HOME_DIR/ccr/kept"
git -C "$WORK/origin.git" branch -D -q outcome 2>/dev/null

mkdir -p "$HOME_DIR/ccr/kept/old-1" "$HOME_DIR/ccr/kept/recent-1"; touch -t 202001010000 "$HOME_DIR/ccr/kept/old-1"
rm -f "$WORK"/record.*
seed_order ord-k-sweep
run ord-k-sweep 2; got=$?
[ ! -e "$HOME_DIR/ccr/kept/old-1" ] || fail 'week-old kept checkout swept' '(gone)' 'present'
[ -e "$HOME_DIR/ccr/kept/recent-1" ] || fail 'recent kept checkout kept' 'present' 'gone'

# ── session telemetry: on with both flags, metadata only ────────────────────
rm -f "$WORK"/record.*
seed_order ord-otel
run_flags ord-otel 3 --otel-project 5f0c1e2d3a4b5c6d7e8f9a0b --otel-endpoint https://otel.example.test:4318; got=$?
[ "$got" = 0 ] || fail 'telemetry: runs' 0 "$got"
for want in 'CLAUDE_CODE_ENABLE_TELEMETRY=1' 'OTEL_METRICS_EXPORTER=otlp' 'OTEL_LOGS_EXPORTER=otlp' 'OTEL_TRACES_EXPORTER=none' \
  'OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf' 'OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.test:4318' 'OTEL_METRICS_INCLUDE_SESSION_ID=true'; do
  grep -qx -- "$want" "$WORK/record.env" || fail 'telemetry: exported to the session' "$want" "$(grep -E '^(CLAUDE_CODE_ENABLE_TELEMETRY|OTEL_)' "$WORK/record.env" | tr '\n' ' ')"
done
grep -qx "OTEL_RESOURCE_ATTRIBUTES=telemetry.project_id=5f0c1e2d3a4b5c6d7e8f9a0b,service.name=termag-claude-session,termag.box=$(hostname -s),termag.slot=3" "$WORK/record.env" \
  || fail 'telemetry: resource attributes name the project, the service, the box and the slot' "telemetry.project_id=...,service.name=termag-claude-session,termag.box=$(hostname -s),termag.slot=3" "$(grep '^OTEL_RESOURCE' "$WORK/record.env")"
grep -q '^OTEL_LOG_' "$WORK/record.env" && fail "telemetry: the owner's content gates never reach the session" '(absent)' "$(grep '^OTEL_LOG_' "$WORK/record.env" | tr '\n' ' ')"
grep -qx 'OTEL_EXPORTER_OTLP_HEADERS=' "$WORK/record.env" || fail "telemetry: the generic header is set empty, which makes Claude Code drop developer per-signal headers" 'OTEL_EXPORTER_OTLP_HEADERS=' "$(grep '^OTEL_EXPORTER_OTLP_HEADERS' "$WORK/record.env")"
grep -qE '^OTEL_EXPORTER_OTLP_(METRICS_HEADERS|CLIENT_KEY|LOGS_ENDPOINT)=' "$WORK/record.env" && fail "telemetry: the owner's per-signal headers, client key and endpoints never reach the session" '(absent)' "$(grep -E '^OTEL_EXPORTER_OTLP_(METRICS_HEADERS|CLIENT_KEY|LOGS_ENDPOINT)' "$WORK/record.env" | tr '\n' ' ')"

grep -q 'session telemetry to https://otel.example.test:4318' "$WORK/err" || fail 'telemetry: logged' 'session telemetry to https://otel.example.test:4318' "$(cat "$WORK/err")"

# With the owner's and the box's ids, the resource carries them; a bad or lone
# key drops both, never the telemetry.
rm -f "$WORK"/record.*
seed_order ord-otelkeys
run_flags ord-otelkeys 3 --otel-project 5f0c1e2d3a4b5c6d7e8f9a0b --otel-endpoint https://otel.example.test --user-key cmuser01 --box-key cm_box-02; got=$?
[ "$got" = 0 ] || fail 'telemetry keys: runs' 0 "$got"
grep -qx "OTEL_RESOURCE_ATTRIBUTES=telemetry.project_id=5f0c1e2d3a4b5c6d7e8f9a0b,service.name=termag-claude-session,termag.box=$(hostname -s),termag.slot=3,termag.user.id=cmuser01,termag.box.id=cm_box-02" "$WORK/record.env" \
  || fail 'telemetry keys: the ids join the resource' '...,termag.user.id=cmuser01,termag.box.id=cm_box-02' "$(grep '^OTEL_RESOURCE' "$WORK/record.env")"
for bad in '--user-key cmuser01' '--user-key cm,user=x --box-key b1' '--user-key u1 --box-key'; do
  rm -f "$WORK"/record.*
  seed_order ord-otelkeysbad
  # shellcheck disable=SC2086
  run_flags ord-otelkeysbad 3 --otel-project 5f0c1e2d3a4b5c6d7e8f9a0b --otel-endpoint https://otel.example.test $bad; got=$?
  [ "$got" = 0 ] || fail "telemetry keys: a bad key ($bad) still runs the session" 0 "$got"
  grep -qx "OTEL_RESOURCE_ATTRIBUTES=telemetry.project_id=5f0c1e2d3a4b5c6d7e8f9a0b,service.name=termag-claude-session,termag.box=$(hostname -s),termag.slot=3" "$WORK/record.env" \
    || fail "telemetry keys: no context keys for $bad, telemetry kept" '(no ids)' "$(grep '^OTEL_RESOURCE' "$WORK/record.env")"
  grep -q 'session telemetry without context keys' "$WORK/err" || fail "telemetry keys: says why for $bad" 'session telemetry without context keys' "$(cat "$WORK/err")"
done

# The slot may be omitted before the flags: the first flag is not a slot.
rm -f "$WORK"/record.*
seed_order ord-otelnoslot
run_flags ord-otelnoslot --otel-project 5f0c1e2d3a4b5c6d7e8f9a0b --otel-endpoint https://otel.example.test; got=$?
[ "$got" = 0 ] || fail 'telemetry: flags right after the order run on the default slot' 0 "$got"
grep -q '^DEV_INSTANCE=2$' "$WORK/record.env" || fail 'telemetry: default slot 2 with the flags' 'DEV_INSTANCE=2' "$(grep '^DEV_INSTANCE' "$WORK/record.env")"
grep -qx 'OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.test' "$WORK/record.env" || fail 'telemetry: flags parsed when the slot is omitted' 'OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example.test' "$(grep '^OTEL_EXPORTER_OTLP_ENDPOINT' "$WORK/record.env")"

# With the export pinned, the owner's settings lose every OTEL key and the
# header helper; their other keys stay. (The webapp runner config dir from
# an earlier case is the host-config source here, so the fixture goes there.)
printf '%s' '{"otelHeadersHelper":"/h/otel-headers.sh","env":{"ANTHROPIC_MODEL":"mine","CLAUDE_CODE_ENABLE_TELEMETRY":"0","OTEL_EXPORTER_OTLP_HEADERS":"Authorization=Bearer owner","OTEL_RESOURCE_ATTRIBUTES":"team=owner","OTEL_METRICS_EXPORTER":"none"}}' > "$HOME_DIR/.claude-runner/config/settings.json"
rm -f "$WORK"/record.*
seed_order ord-otelhc
run_flags ord-otelhc 2 --otel-project 5f0c1e2d3a4b5c6d7e8f9a0b --otel-endpoint https://otel.example.test; got=$?
got="$(jq -c . "$WORK/record.hostsettings" 2>&1)"
[ "$got" = '{"env":{"ANTHROPIC_MODEL":"mine"}}' ] || fail "telemetry: the owner's OTEL keys, telemetry switch and header helper are dropped from the host config, the rest kept" '{"env":{"ANTHROPIC_MODEL":"mine"}}' "$got"
rm -f "$WORK"/record.*
seed_order ord-otelhc2
run ord-otelhc2 2; got=$?
got="$(jq -c . "$WORK/record.hostsettings" 2>&1)"
[ "$got" = '{"otelHeadersHelper":"/h/otel-headers.sh","env":{"ANTHROPIC_MODEL":"mine","CLAUDE_CODE_ENABLE_TELEMETRY":"0","OTEL_EXPORTER_OTLP_HEADERS":"Authorization=Bearer owner","OTEL_RESOURCE_ATTRIBUTES":"team=owner","OTEL_METRICS_EXPORTER":"none"}}' ] \
  || fail "telemetry off: the owner's own OTEL setup stays in the host config" '(unchanged)' "$got"
rm -f "$HOME_DIR/.claude-runner/config/settings.json"

for bad in '--otel-project 5f0c1e2d3a4b5c6d7e8f9a0b --otel-endpoint http://otel.example.test' \
           '--otel-project 5f0c1e2d3a4b5c6d7e8f9a0b --otel-endpoint https://otel.example.test/v1/logs' \
           '--otel-project bad/id --otel-endpoint https://otel.example.test' \
           '--otel-endpoint https://otel.example.test'; do
  rm -f "$WORK"/record.*
  seed_order ord-otelbad
  # shellcheck disable=SC2086
  run_flags ord-otelbad 2 $bad; got=$?
  [ "$got" = 0 ] || fail "telemetry: a bad destination ($bad) still runs the session" 0 "$got"
  grep -q '^CLAUDE_CODE_ENABLE_TELEMETRY=' "$WORK/record.env" && fail "telemetry: off for $bad" '(absent)' 'CLAUDE_CODE_ENABLE_TELEMETRY set'
  grep -q 'session telemetry off' "$WORK/err" || fail "telemetry: says why it is off for $bad" 'session telemetry off' "$(cat "$WORK/err")"
  grep -q '^OTEL_LOG_' "$WORK/record.env" && fail "telemetry: content gates dropped even when off ($bad)" '(absent)' 'set'
done

# ── the end report ──────────────────────────────────────────────────────────
AGENT_CFG="$HOME_DIR/.termag/agent.config.json"
printf '{"token":"tmag_box_token","termag_url":"wss://orch.example.test/termag/ws/agent?token=x"}\n' > "$AGENT_CFG"
rm -f "$WORK"/record.*
seed_order ord-end
run ord-end 3 STUB_CHECK_DIR="$HOME_DIR/ccr/sessions/ord-end"; got=$?
[ "$got" = 0 ] || fail 'end report: the run still exits with the runner status' 0 "$got"
[ "$(cat "$WORK/record.curl.dirstate" 2>/dev/null)" = absent ] || fail 'end report: posted after the checkout is released, so the end is when the slot is free' absent "$(cat "$WORK/record.curl.dirstate" 2>/dev/null)"
grep -qx 'https://orch.example.test/termag/api/claude-runner/event' "$WORK/record.curl.argv" 2>/dev/null || fail 'end report: posts to the event route derived from termag_url' 'https://orch.example.test/termag/api/claude-runner/event' "$(tr '\n' ' ' < "$WORK/record.curl.argv" 2>/dev/null)"
grep -qx 'header = "Authorization: Bearer tmag_box_token"' "$WORK/record.curl.stdin" 2>/dev/null || fail 'end report: the token goes in on stdin' 'header = "Authorization: Bearer tmag_box_token"' "$(cat "$WORK/record.curl.stdin" 2>/dev/null)"
grep -q 'tmag_box_token' "$WORK/record.curl.argv" 2>/dev/null && fail 'end report: the token is not on the command line' 'absent' 'present'
body="$(cat "$WORK/record.curl.body" 2>/dev/null)"
case "$body" in
  '{"event":"ended","orderId":"ord-end","exitStatus":0,"endedAt":"'[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z'","kept":false}') ;;
  *) fail 'end report: body carries the order, exit 0, a UTC timestamp, no reason, and that nothing was kept' '{"event":"ended","orderId":"ord-end","exitStatus":0,"endedAt":"<utc>","kept":false}' "$body" ;;
esac
grep -q 'end reported (exit 0)' "$WORK/err" || fail 'end report: logs the report' 'end reported (exit 0)' "$(cat "$WORK/err")"

# The checkout's fate and size ride on the report (S5): kept when GitHub did
# not have its work, the size when the post-session hook measured it, and the
# size file goes with the launch.
rm -f "$WORK"/record.*
seed_order ord-end-kept
run ord-end-kept 2 CLAUDE_RUNNER_CANONICAL="$GCANON" STUB_GIT=dirty; got=$?
[ "$got" = 0 ] || fail 'end report (kept): runs' 0 "$got"
case "$(cat "$WORK/record.curl.body" 2>/dev/null)" in *'"kept":true'*) ;; *) fail 'end report: kept is true when the checkout was kept' '"kept":true' "$(cat "$WORK/record.curl.body" 2>/dev/null)" ;; esac
rm -rf "$HOME_DIR/ccr/kept"
rm -f "$WORK"/record.*
seed_order ord-end-bytes
run ord-end-bytes 2 CLAUDE_RUNNER_CANONICAL="$GCANON" STUB_GIT=clean STUB_BYTES=8000000000; got=$?
[ "$got" = 0 ] || fail 'end report (bytes): runs' 0 "$got"
case "$(cat "$WORK/record.curl.body" 2>/dev/null)" in *'"kept":false,"checkoutBytes":8000000000'*) ;; *) fail 'end report: kept is false and the measured size rides along' '"kept":false,"checkoutBytes":8000000000' "$(cat "$WORK/record.curl.body" 2>/dev/null)" ;; esac
[ -z "$(leftovers ord-end-bytes.checkout-bytes)" ] || fail 'the size file is removed with the launch' '(none)' "$(leftovers ord-end-bytes.checkout-bytes)"

rm -f "$WORK"/record.*
seed_order ord-end7
run ord-end7 2 STUB_EXIT=7; got=$?
[ "$got" = 7 ] || fail 'end report: a failed runner still exits with its status' 7 "$got"
case "$(cat "$WORK/record.curl.body" 2>/dev/null)" in *'"exitStatus":7,'*) ;; *) fail 'end report: carries the runner exit status' '"exitStatus":7' "$(cat "$WORK/record.curl.body" 2>/dev/null)" ;; esac

rm -f "$WORK"/record.*
seed_order ord-end404
run ord-end404 2 STUB_CURL_CODE=404; got=$?
[ "$got" = 0 ] || fail 'end report: a 404 changes nothing about the exit' 0 "$got"
grep -q 'predates the event route' "$WORK/err" || fail 'end report: an older orchestrator is named as the reason' 'predates the event route' "$(cat "$WORK/err")"

# A hangup: the report says exit 129 and why.
rm -f "$WORK"/record.*
seed_order ord-endhup
env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$HOME_DIR" RECORD="$WORK/record" STUB_SLEEP=1 \
  "$BASH_BIN" "$SCRIPT" ord-endhup 2 2>"$WORK/err" &
pid=$!
i=0; while [ ! -f "$WORK/record.argv" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
sleep 0.3
kill -HUP "$pid" 2>/dev/null
wait "$pid"; got=$?
[ "$got" = 129 ] || fail 'end report: a hangup still ends the script with 129' 129 "$got"
case "$(cat "$WORK/record.curl.body" 2>/dev/null)" in *'"exitStatus":129,'*'"exitReason":"signal"'*) ;; *) fail 'end report: a signal exit is reported as such' '"exitStatus":129 ... "exitReason":"signal"' "$(cat "$WORK/record.curl.body" 2>/dev/null)" ;; esac

# A launch that ends while a newer launch of its order still runs here says
# nothing: the order's record is the newer launch's, which reports its own end.
rm -f "$WORK"/record.* "$WORK"/record-b.*
seed_order ord-endrace
env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$HOME_DIR" RECORD="$WORK/record" STUB_SLEEP=1 \
  "$BASH_BIN" "$SCRIPT" ord-endrace 2 2>"$WORK/err" &
pid_a=$!
for _ in $(seq 1 50); do [ -e "$WORK/record.argv" ] && break; sleep 0.1; done
seed_order ord-endrace
env -i PATH="$WORK/bin:/usr/bin:/bin" HOME="$HOME_DIR" RECORD="$WORK/record-b" STUB_SLEEP=1 \
  "$BASH_BIN" "$SCRIPT" ord-endrace 2 2>"$WORK/err-b" &
pid_b=$!
for _ in $(seq 1 50); do [ -e "$WORK/record-b.argv" ] && break; sleep 0.1; done
sleep 0.3
kill -HUP "$pid_a"; wait "$pid_a" 2>/dev/null
[ ! -e "$WORK/record.curl.argv" ] || fail 'end report: the earlier launch says nothing while a newer launch of its order runs' '(no curl call)' "$(cat "$WORK/record.curl.body" 2>/dev/null)"
grep -q 'end not reported: a newer launch of this order' "$WORK/err" || fail 'end report: the earlier launch says why it stayed quiet' 'end not reported: a newer launch of this order' "$(cat "$WORK/err")"
kill -HUP "$pid_b"; wait "$pid_b" 2>/dev/null
case "$(cat "$WORK/record-b.curl.body" 2>/dev/null)" in *'"orderId":"ord-endrace","exitStatus":129,'*) ;; *) fail 'end report: the newer launch reports its own end' '"exitStatus":129' "$(cat "$WORK/record-b.curl.body" 2>/dev/null)" ;; esac
[ -z "$(find "$HOME_DIR/ccr/sessions" -maxdepth 1 -name 'ord-endrace*' 2>/dev/null)" ] || fail 'end report race: both launch directories are removed' '(none)' "$(find "$HOME_DIR/ccr/sessions" -maxdepth 1 -name 'ord-endrace*')"

# No agent config: nothing is posted, and the log says so.
rm -f "$AGENT_CFG" "$WORK"/record.*
seed_order ord-endnocfg
run ord-endnocfg 2; got=$?
[ ! -e "$WORK/record.curl.argv" ] || fail 'end report: nothing is posted without an agent config' '(no curl call)' "$(cat "$WORK/record.curl.argv")"
grep -q 'end not reported: no agent config' "$WORK/err" || fail 'end report: says why nothing was posted' 'end not reported: no agent config' "$(cat "$WORK/err")"

# ── refusals ────────────────────────────────────────────────────────────────
rm -f "$WORK"/record.*
run '../x' 2; got=$?
[ "$got" = 2 ] || fail 'bad order id exits 2' 2 "$got"
[ ! -e "$WORK/record.argv" ] || fail 'bad order id starts nothing' '(no run)' 'ran'

seed_order ord-5
run ord-5 9; got=$?
[ "$got" = 2 ] || fail 'slot outside 2..8 exits 2' 2 "$got"
[ ! -e "$WORK/record.argv" ] || fail 'bad slot starts nothing' '(no run)' 'ran'
[ -e "$HOME_DIR/.termag/claude-runner/ord-5.work-order" ] || fail 'bad slot leaves the work order alone' 'present' 'gone'

run ord-missing 2; got=$?
[ "$got" = 2 ] || fail 'missing work order exits 2' 2 "$got"
grep -q 'no work order' "$WORK/err" || fail 'missing work order says so' 'no work order' "$(cat "$WORK/err")"

seed_order ord-6
printf '#!/bin/sh\nexit 1\n' > "$WORK/bin/claude"
run ord-6 2; got=$?
[ "$got" = 2 ] || fail 'claude without the subcommand exits 2' 2 "$got"
grep -q 'self-hosted-runner subcommand' "$WORK/err" || fail 'old claude says so' 'self-hosted-runner subcommand' "$(cat "$WORK/err")"

# ── termag's runner hooks ───────────────────────────────────────────────────
# A smaller stub from here on: argv, env, and the exit reason the post-session
# hook would leave (STUB_REASON).
cat > "$WORK/bin/claude" <<'STUB'
#!/bin/sh
if [ "$1" = self-hosted-runner ] && [ "$2" = --help ]; then exit 0; fi
printf '%s\n' "$@" > "$RECORD.argv"
env > "$RECORD.env"
if [ -n "${STUB_REASON:-}" ]; then printf '%s\n' "$STUB_REASON" > "$TERMAG_CLAUDE_RUNNER_DIR/$TERMAG_CLAUDE_RUNNER_ORDER.exit-reason.$TERMAG_CLAUDE_RUNNER_LAUNCH"; fi
# STUB_BZ: build here, as far as bazel's output base goes (DO_NOT_BUILD_HERE
# names the checkout), so the exit release and not the start sweep must remove it.
if [ -n "${STUB_BZ:-}" ]; then
  b=$(printf '%s\n' "$@" | awk '/^--base-dir$/{getline; print; exit}'); co="$b/example-org/webapp"
  ob="$STUB_BZ/$(printf '%s' "$co" | md5sum | cut -d' ' -f1)"; mkdir -p "$ob/execroot/_main/bazel-out"; printf '%s' "$co" > "$ob/DO_NOT_BUILD_HERE"
  : > "$ob/execroot/_main/bazel-out/out.a"; chmod -w "$ob/execroot/_main/bazel-out"; printf '%s\n' "$ob" > "$RECORD.ob"
fi
exit "${STUB_EXIT:-0}"
STUB
chmod +x "$WORK/bin/claude"
cp "$WORK/bin/claude" "$WORK/bin/claude.small"
# The end-report cases above removed the agent config; the report is read again here.
printf '{"token":"tmag_box_token","termag_url":"wss://orch.example.test/termag/ws/agent?token=x"}\n' > "$HOME_DIR/.termag/agent.config.json"
HOOKS="$WORK/termag-hooks"; mkdir -p "$HOOKS"; printf '#!/bin/sh\nexit 0\n' > "$HOOKS/command"; chmod +x "$HOOKS/command"
# webapp's wrapper exists too: the hook execs it, so no --exec-path.
mkdir -p "$HOME_DIR/.config/claude-runner/hooks"
printf '#!/bin/sh\nexec "$@"\n' > "$HOME_DIR/.config/claude-runner/session-wrapper.sh"; chmod +x "$HOME_DIR/.config/claude-runner/session-wrapper.sh"
rm -f "$WORK"/record.*
seed_order ord-hooks
run ord-hooks 2 TERMAG_CLAUDE_RUNNER_HOOKS="$HOOKS" STUB_REASON=interrupted; got=$?
[ "$got" = 0 ] || fail 'hooks: runs' 0 "$got"
grep -qx -- "$HOOKS" "$WORK/record.argv" || fail "hooks: termag's hooks dir is passed" "$HOOKS" "$(tr '\n' ' ' <"$WORK/record.argv")"
argv_has '--exec-path' && fail "hooks: no --exec-path when termag's hooks run (the command hook execs the wrapper)" '(absent)' '--exec-path'
grep -q '^TERMAG_CLAUDE_RUNNER_ORDER=ord-hooks$' "$WORK/record.env" || fail 'hooks: the order is exported' 'TERMAG_CLAUDE_RUNNER_ORDER=ord-hooks' "$(grep TERMAG_CLAUDE_RUNNER "$WORK/record.env")"
grep -q "^TERMAG_CLAUDE_RUNNER_DIR=$HOME_DIR/.termag/claude-runner$" "$WORK/record.env" || fail 'hooks: the state dir is exported' "TERMAG_CLAUDE_RUNNER_DIR=$HOME_DIR/.termag/claude-runner" "$(grep TERMAG_CLAUDE_RUNNER_DIR "$WORK/record.env")"
case "$(cat "$WORK/record.curl.body" 2>/dev/null)" in *'"exitReason":"interrupted"'*) ;; *) fail "hooks: the post-session hook's reason is the end report's exitReason" '"exitReason":"interrupted"' "$(cat "$WORK/record.curl.body" 2>/dev/null)" ;; esac
[ -z "$(leftovers ord-hooks.exit-reason)" ] || fail 'hooks: the per-launch exit reason file is removed' '(gone)' "$(leftovers ord-hooks.exit-reason)"
grep -q '^TERMAG_CLAUDE_RUNNER_LAUNCH=[0-9][0-9]*$' "$WORK/record.env" || fail 'hooks: the launch pid is exported for the post-session hook' 'TERMAG_CLAUDE_RUNNER_LAUNCH=<pid>' "$(grep LAUNCH "$WORK/record.env")"
# Another launch's reason file is not this launch's: left alone, not reported.
printf 'completed\n' > "$HOME_DIR/.termag/claude-runner/ord-hooks2.exit-reason.999999"
rm -f "$WORK"/record.*
seed_order ord-hooks2
run ord-hooks2 2 TERMAG_CLAUDE_RUNNER_HOOKS="$HOOKS"; got=$?
case "$(cat "$WORK/record.curl.body" 2>/dev/null)" in *exitReason*) fail "hooks: another launch's exit reason is not reported" '(no exitReason)' "$(cat "$WORK/record.curl.body")" ;; esac
[ -f "$HOME_DIR/.termag/claude-runner/ord-hooks2.exit-reason.999999" ] || fail "hooks: another launch's exit reason file is left alone" present '(gone)'
rm -f "$HOME_DIR/.termag/claude-runner/ord-hooks2.exit-reason.999999"
rm -f "$WORK"/record.*
seed_order ord-nohooks
run ord-nohooks 2 TERMAG_CLAUDE_RUNNER_HOOKS="$WORK/no-such-hooks"; got=$?
argv_has '--exec-path' || fail "hooks: without termag's hooks, webapp's wrapper is passed as before" '--exec-path' "$(tr '\n' ' ' <"$WORK/record.argv")"
grep -qx -- "$HOME_DIR/.config/claude-runner/hooks" "$WORK/record.argv" || fail "hooks: without termag's hooks, webapp's hooks dir is passed as before" "$HOME_DIR/.config/claude-runner/hooks" "$(tr '\n' ' ' <"$WORK/record.argv")"
rm -rf "$HOME_DIR/.config/claude-runner"

# ── bazel output bases ──────────────────────────────────────────────────────
md5_of() { if command -v md5sum >/dev/null 2>&1; then printf '%s' "$1" | md5sum | cut -d' ' -f1; else printf '%s' "$1" | md5 -q; fi; }
BZ="$WORK/bzroot"
make_base() {  # <workspace path> [live]: a fake output base for it
  b="$BZ/$(md5_of "$1")"; mkdir -p "$b/execroot/_main/bazel-out" "$b/server"
  printf '%s' "$1" > "$b/DO_NOT_BUILD_HERE"; : > "$b/execroot/_main/bazel-out/out.a"; chmod -w "$b/execroot/_main/bazel-out"
  [ "${2:-}" = live ] && printf '%s\n' "$$" > "$b/server/server.pid.txt"
  printf '%s' "$b"
}
wait_gone() { i=0; while [ -e "$1" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done; [ ! -e "$1" ]; }
rm -rf "$BZ"; mkdir -p "$BZ"
orphan="$(make_base "$HOME_DIR/tmp/gone-worktree")"
live="$(make_base "$HOME_DIR/tmp/live-worktree" live)"
rm -f "$WORK"/record.*
seed_order ord-bz
run ord-bz 2 TERMAG_BAZEL_OUTPUT_USER_ROOT="$BZ" STUB_BZ="$BZ"; got=$?
[ "$got" = 0 ] || fail 'bazel: runs' 0 "$got"
base="$(cat "$WORK/record.ob" 2>/dev/null)"
[ -n "$base" ] || fail 'bazel: the stub built' 'an output base' '(none)'
# Moved aside before the detached delete, so the path is free for a relaunch
# the moment the run returns, whatever the delete is still doing.
[ ! -e "$base" ] || fail 'bazel: the released base is out of the way as soon as the run returns' '(gone)' present
wait_gone "$base" || fail 'bazel: the released checkout takes its output base with it' '(gone)' "$(ls "$base" 2>/dev/null | tr '\n' ' ')"
i=0; while ls -d "$base".rm.* >/dev/null 2>&1 && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
ls -d "$base".rm.* >/dev/null 2>&1 && fail 'bazel: the moved-aside copy is deleted' '(gone)' "$(ls -d "$base".rm.* 2>/dev/null)"
# A leftover moved-aside copy (a deleter that died) is picked up at start.
mkdir -p "$BZ/0123456789abcdef0123456789abcdef.rm.424242/x"
wait_gone "$orphan" || fail 'bazel: an output base whose workspace is gone is swept at start' '(gone)' present
[ -d "$live" ] || fail 'bazel: an output base with a live server is left alone' present '(gone)'
grep -q "removing bazel output base $base" "$WORK/err" || fail 'bazel: says what it removes' "removing bazel output base $base" "$(grep -i bazel "$WORK/err")"
# A kept checkout's base goes too: the move to ~/ccr/kept changes the path.
rm -f "$WORK"/record.*
cat > "$WORK/bin/claude" <<'STUB'
#!/bin/sh
if [ "$1" = self-hosted-runner ] && [ "$2" = --help ]; then exit 0; fi
b=$(printf '%s\n' "$@" | awk '/^--base-dir$/{getline; print; exit}')
co="$b/example-org/webapp"; git -C "$co" reset -q --hard; printf 'x\n' > "$co/uncommitted.txt"
ob="$STUB_BZ/$(printf '%s' "$co" | md5sum | cut -d' ' -f1)"; mkdir -p "$ob"; printf '%s' "$co" > "$ob/DO_NOT_BUILD_HERE"; printf '%s\n' "$ob" > "$RECORD.ob"
exit 0
STUB
chmod +x "$WORK/bin/claude"
seed_order ord-bzkept
run ord-bzkept 2 TERMAG_BAZEL_OUTPUT_USER_ROOT="$BZ" STUB_BZ="$BZ"; got=$?
kept_base="$(cat "$WORK/record.ob" 2>/dev/null)"
wait_gone "$kept_base" || fail "bazel: a kept checkout's output base goes too (the move changes the path)" '(gone)' present
ls -d "$HOME_DIR/ccr/kept/ord-bzkept-"* >/dev/null 2>&1 || fail 'bazel: the kept checkout itself stays' 'kept dir' '(none)'
# A base whose DO_NOT_BUILD_HERE names another workspace is never touched.
rm -f "$WORK"/record.*
CO="$HOME_DIR/ccr/sessions/ord-bzother/example-org/webapp"
other="$BZ/$(md5_of "$CO")"; mkdir -p "$other"; printf '%s' "$HOME_DIR/elsewhere" > "$other/DO_NOT_BUILD_HERE"; mkdir -p "$HOME_DIR/elsewhere"
cp "$WORK/bin/claude.small" "$WORK/bin/claude"
seed_order ord-bzother
run ord-bzother 2 TERMAG_BAZEL_OUTPUT_USER_ROOT="$BZ"; got=$?
sleep 0.3
[ -d "$other" ] || fail "bazel: a base naming another workspace is left alone" present '(gone)'
grep -q "left $other alone" "$WORK/err" || fail 'bazel: says why it left it' "left $other alone" "$(grep -i bazel "$WORK/err")"
wait_gone "$BZ/0123456789abcdef0123456789abcdef.rm.424242" || fail 'bazel: a leftover moved-aside copy is swept at start' '(gone)' present
chmod -R u+w "$BZ" 2>/dev/null

if [ "$failures" -eq 0 ]; then
  echo "ok: termag-claude-runner"
else
  echo "$failures failure(s)"
  exit 1
fi
