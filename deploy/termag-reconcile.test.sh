#!/bin/sh
# Tests deploy/termag-reconcile.
#
# Scope is the properties that make it safe to run on every boot, since that is
# what makes it different from a bake step:
#
#   * it writes only on a real difference (a reconciled boot must be silent)
#   * it installs with the right mode, and units are distinguished from binaries
#     because only a unit change warrants a daemon-reload
#   * it never touches claude-settings.json, which box owners edit
#   * an artifact missing from an older checkout is skipped, not an error
#   * --check reports without changing anything
#   * MetaTerm's Claude Code config is merged in additively: its own
#     ~/.claude.json key and three settings.json approvals, nothing else
#   * enable=enable units get their default.target.wants symlink, and that is
#     checked independently of file content -- the whole point, since a box built
#     before this script existed has the right unit files and no symlinks
#   * the termag CLI is installed through cli/install.sh only when its --check
#     reports drift, and a failed install does not fail the run
#   * the box-update service and script are installed; the service is not
#     enabled (the orchestrator starts it over the agent's box-update RPC)
#
# `systemctl` is stubbed: the real one would reach this user's actual manager.
#
# Run: sh deploy/termag-reconcile.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-reconcile"
unset DOCKER_CONFIG
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

HOME_DIR="$WORK/home"
CHECKOUT="$WORK/checkout"
STUB="$WORK/stub"
mkdir -p "$HOME_DIR" "$CHECKOUT/deploy" "$STUB"

# Record daemon-reload calls instead of issuing them.
cat > "$STUB/systemctl" <<'STUBEOF'
#!/bin/sh
echo "$*" >> "$RELOAD_LOG"
exit 0
STUBEOF
chmod 755 "$STUB/systemctl"
RELOAD_LOG="$WORK/reloads"; export RELOAD_LOG
: > "$RELOAD_LOG"

run() {
  HOME="$HOME_DIR" TERMAG_CHECKOUT="$CHECKOUT" PATH="$STUB:$PATH" "$SCRIPT" "$@"
}

seed_source() { printf '%s\n' "$2" > "$CHECKOUT/deploy/$1"; }

# A minimal but realistic checkout.
seed_source termag-agent.service         'v1-unit'
seed_source termag-reconcile.service     'v1-reconcile-unit'
seed_source termag-on-warm.service       'v1-on-warm-unit'
seed_source termag-on-claim.service      'v1-on-claim-unit'
seed_source termag-status                'v1-status'
seed_source termag-hooks-update          'v1-hooks-update'
seed_source termag-reconcile             'v1-reconcile'
seed_source termag-box-update            'v1-box-update'
seed_source termag-box-update.service    'v1-box-update-unit'
seed_source termag-hook-run              'v1-hook-run'
seed_source termag-credentials           'v1-credentials'
seed_source termag-claude-token          'v1-claude-token'

seed_source termag-metaterm-mcp          'v1-metaterm-mcp'
mkdir -p "$CHECKOUT/deploy/claude-skills/metaterm"
seed_source claude-skills/metaterm/SKILL.md 'v1-skill'
seed_source termag-claude-runner         'v1-claude-runner'
mkdir -p "$CHECKOUT/deploy/pi-ext"
seed_source pi-ext/termag-status.ts      'v1-pi-ext'
seed_source pi-ext/termag-status-core.ts 'v1-pi-ext-core'
mkdir -p "$CHECKOUT/deploy/claude-runner-hooks"
seed_source claude-runner-hooks/command      'v1-hook-command'
seed_source claude-runner-hooks/post-session 'v1-hook-post-session'

# ── --list ──────────────────────────────────────────────────────────────────
got="$(run --list | wc -l | tr -d ' ')"
[ "$got" = 19 ] || fail '--list prints every artifact' 19 "$got"

# ── no checkout is not an error ─────────────────────────────────────────────
out="$(HOME="$HOME_DIR" TERMAG_CHECKOUT="$WORK/absent" PATH="$STUB:$PATH" "$SCRIPT" 2>&1)"
got=$?
[ "$got" = 0 ] || fail 'a missing checkout exits 0' 0 "$got"
case "$out" in
  *'nothing to reconcile'*) : ;;
  *) fail 'a missing checkout says so' 'nothing to reconcile' "$out" ;;
esac

# ── first run installs ──────────────────────────────────────────────────────
run >/dev/null 2>&1
for f in "$HOME_DIR/.config/systemd/user/termag-agent.service" \
         "$HOME_DIR/.config/systemd/user/termag-box-update.service" \
         "$HOME_DIR/.local/bin/termag-box-update" \
         "$HOME_DIR/.local/bin/termag-status" \
         "$HOME_DIR/.local/bin/termag-hooks-update" \
         "$HOME_DIR/.local/bin/termag-claude-runner" \
         "$HOME_DIR/.local/share/termag/pi-ext/termag-status.ts" \
         "$HOME_DIR/.local/share/termag/pi-ext/termag-status-core.ts" \
         "$HOME_DIR/.local/lib/termag/claude-runner-hooks/command" \
         "$HOME_DIR/.local/lib/termag/claude-runner-hooks/post-session" \
         "$HOME_DIR/.local/bin/termag-reconcile"; do
  [ -f "$f" ] || fail "installs $(basename "$f")" 'present' 'absent'
done

# Modes: units are not executable, scripts are.
got="$(stat -c %a "$HOME_DIR/.config/systemd/user/termag-agent.service" 2>/dev/null)"
[ "$got" = 644 ] || fail 'unit installed 644' 644 "$got"
got="$(stat -c %a "$HOME_DIR/.local/bin/termag-status" 2>/dev/null)"
[ "$got" = 755 ] || fail 'script installed 755' 755 "$got"

# A unit changed, so exactly one daemon-reload should have been issued.
got="$(grep -c 'daemon-reload' "$RELOAD_LOG" 2>/dev/null)"
[ "$got" = 1 ] || fail 'a unit change triggers one daemon-reload' 1 "$got"

# Reconcile never starts a unit: a start mid-reconcile would run against a
# half-installed tree, and the box-update service in particular is the
# orchestrator's to start.
got="$(grep -c -- ' start ' "$RELOAD_LOG" 2>/dev/null)"
[ "$got" = 0 ] || fail 'nothing is started by reconcile' 0 "$(cat "$RELOAD_LOG")"

# ── second run is silent and reloads nothing ────────────────────────────────
: > "$RELOAD_LOG"
out="$(run 2>&1)"
[ -z "$out" ] || fail 'a reconciled boot is silent' '(no output)' "$out"
got="$(wc -l < "$RELOAD_LOG" | tr -d ' ')"
[ "$got" = 0 ] || fail 'no daemon-reload when nothing changed' 0 "$got"

# ── --check reports drift without changing anything ─────────────────────────
seed_source termag-status 'v2-status'
out="$(run --check 2>&1)"
got=$?
[ "$got" = 1 ] || fail '--check exits 1 on drift' 1 "$got"
case "$out" in
  *DRIFT*termag-status*) : ;;
  *) fail '--check names the drifted file' 'DRIFT ... termag-status' "$out" ;;
esac
got="$(cat "$HOME_DIR/.local/bin/termag-status")"
[ "$got" = 'v1-status' ] || fail '--check changes nothing' 'v1-status' "$got"

# ── a script-only change must not trigger a daemon-reload ───────────────────
: > "$RELOAD_LOG"
run >/dev/null 2>&1
got="$(cat "$HOME_DIR/.local/bin/termag-status")"
[ "$got" = 'v2-status' ] || fail 'reconciles a changed script' 'v2-status' "$got"
got="$(wc -l < "$RELOAD_LOG" | tr -d ' ')"
[ "$got" = 0 ] || fail 'a script-only change issues no daemon-reload' 0 "$got"

# ── claude-settings.json is never touched ───────────────────────────────────
# Box owners add their own hooks to it; reconciling it every boot would discard
# that silently. It must not appear in the table, and a source copy must be
# ignored even when one exists.
run --list | grep -q 'claude-settings' \
  && fail 'claude-settings.json is excluded from the table' 'absent' 'present'
mkdir -p "$HOME_DIR/.claude"
printf 'my-own-hooks\n' > "$HOME_DIR/.claude/settings.json"
seed_source claude-settings.json 'upstream-defaults'
run >/dev/null 2>&1
got="$(cat "$HOME_DIR/.claude/settings.json")"
[ "$got" = 'my-own-hooks' ] || fail 'user claude settings survive' 'my-own-hooks' "$got"

# ── an artifact absent from an older checkout is skipped, not an error ──────
rm -f "$CHECKOUT/deploy/termag-hooks-update" "$HOME_DIR/.local/bin/termag-hooks-update"
out="$(run 2>&1)"
got=$?
[ "$got" = 0 ] || fail 'a source missing from the checkout exits 0' 0 "$got"
case "$out" in
  *termag-hooks-update*) fail 'a missing source is silent' '(no mention)' "$out" ;;
esac

# ── missing destination is reported as MISSING, not DRIFT ───────────────────
seed_source termag-hooks-update 'v1-hooks-update'
out="$(run --check 2>&1)"
case "$out" in
  *MISSING*termag-hooks-update*) : ;;
  *) fail 'an uninstalled artifact reports MISSING' 'MISSING ... termag-hooks-update' "$out" ;;
esac

# ── unit enablement ─────────────────────────────────────────────────────────
WANTS="$HOME_DIR/.config/systemd/user/default.target.wants"

# The enable=enable units must be linked; the noenable ones must not.
for u in termag-reconcile.service; do
  got="$(readlink "$WANTS/$u" 2>/dev/null)"
  [ "$got" = "../$u" ] || fail "enables $u" "../$u" "${got:-(no symlink)}"
done
if [ -e "$WANTS/termag-agent.service" ]; then
  fail 'does not enable termag-agent.service' '(no symlink)' 'symlink present'
fi
# Nothing on the box starts the update service on its own: the orchestrator
# does, over the agent's box-update RPC; enabling it would run an update at
# every login.
if [ -e "$WANTS/termag-box-update.service" ]; then
  fail 'does not enable termag-box-update.service' '(no symlink)' 'symlink present'
fi
# Enabling this one would be wrong rather than merely surprising: the backend
# starts it through the agent so the on-claim credential is minted immediately
# before use, and a boot-time start would run it with no credential.
if [ -e "$WANTS/termag-on-warm.service" ]; then
  fail 'does not enable termag-on-warm.service' '(no symlink)' 'symlink present'
fi
if [ -e "$WANTS/termag-on-claim.service" ]; then
  fail 'does not enable termag-on-claim.service' '(no symlink)' 'symlink present'
fi

# This is the property the whole mechanism turns on: a box can have byte-identical
# unit files and still no symlinks, because only the AMI bake ever created them.
# Enablement must therefore be detected with the content already matching.
rm -f "$WANTS/termag-reconcile.service"
out="$(run --check 2>&1)"
got=$?
[ "$got" = 1 ] || fail '--check exits 1 on a missing symlink alone' 1 "$got"
case "$out" in
  *NOT-ENABLED*termag-reconcile.service*) : ;;
  *) fail '--check reports an un-enabled unit whose content matches' \
       'NOT-ENABLED termag-reconcile.service' "$out" ;;
esac
case "$out" in
  *DRIFT*termag-reconcile.service*) fail '--check must not call it drift' 'NOT-ENABLED only' "$out" ;;
esac
[ -e "$WANTS/termag-reconcile.service" ] && fail '--check does not enable' '(no symlink)' 'created one'

# ...and reconciling then creates it, with a daemon-reload, without rewriting the file.
: > "$RELOAD_LOG"
before="$(cat "$HOME_DIR/.config/systemd/user/termag-reconcile.service")"
out="$(run 2>&1)"
case "$out" in
  *'enabled: termag-reconcile.service'*) : ;;
  *) fail 'reconcile enables the unit' 'enabled: termag-reconcile.service' "$out" ;;
esac
got="$(readlink "$WANTS/termag-reconcile.service" 2>/dev/null)"
[ "$got" = '../termag-reconcile.service' ] || fail 'symlink target is relative' '../termag-reconcile.service' "$got"
got="$(grep -c 'daemon-reload' "$RELOAD_LOG" 2>/dev/null)"
[ "$got" = 1 ] || fail 'enabling triggers a daemon-reload' 1 "$got"
got="$(cat "$HOME_DIR/.config/systemd/user/termag-reconcile.service")"
[ "$got" = "$before" ] || fail 'enabling does not rewrite the unit file' "$before" "$got"

# Idempotent: a second pass reports nothing and reloads nothing.
: > "$RELOAD_LOG"
out="$(run 2>&1)"
[ -z "$out" ] || fail 'enablement is idempotent' '(no output)' "$out"
got="$(wc -l < "$RELOAD_LOG" | tr -d ' ')"
[ "$got" = 0 ] || fail 'no reload when already enabled' 0 "$got"

# A symlink pointing somewhere else is repaired rather than left wrong.
ln -sfn /dev/null "$WANTS/termag-reconcile.service"
run >/dev/null 2>&1
got="$(readlink "$WANTS/termag-reconcile.service" 2>/dev/null)"
[ "$got" = '../termag-reconcile.service' ] || fail 'repairs a wrong symlink target' '../termag-reconcile.service' "$got"

# ── MetaTerm's Claude Code config ───────────────────────────────────────────
# Only once the checkout carries the server: an older checkout registers nothing.
[ -e "$HOME_DIR/.claude.json" ] && fail 'no MetaTerm registration without the server' 'absent' 'present'
got="$(stat -c %a "$HOME_DIR/.claude/skills/metaterm/SKILL.md" 2>/dev/null)"
[ "$got" = 644 ] || fail 'skill installed 644' 644 "$got"

mkdir -p "$CHECKOUT/metaterm"
printf 'server\n' > "$CHECKOUT/metaterm/mcp-server.mjs"
# An owner's own config, which must survive untouched apart from our additions.
printf '%s\n' '{"numStartups":3,"mcpServers":{"mine":{"command":"x"}}}' > "$HOME_DIR/.claude.json"
chmod 640 "$HOME_DIR/.claude.json"
printf '%s\n' '{"hooks":{"Stop":[]},"permissions":{"allow":["Bash(ls)","mcp__metaterm__capture_pane"],"deny":["Bash(rm)"]}}' \
  > "$HOME_DIR/.claude/settings.json"

out="$(run --check 2>&1)"
got=$?
[ "$got" = 1 ] || fail '--check exits 1 on missing MetaTerm config' 1 "$got"
case "$out" in
  *'DRIFT: MetaTerm MCP server'*'DRIFT: MetaTerm read-tool approvals'*) : ;;
  *) fail '--check reports both MetaTerm merges' 'DRIFT x2' "$out" ;;
esac
got="$(jq -c '.mcpServers | keys' "$HOME_DIR/.claude.json")"
[ "$got" = '["mine"]' ] || fail '--check does not merge' '["mine"]' "$got"

run >/dev/null 2>&1
got="$(jq -c '.mcpServers.metaterm' "$HOME_DIR/.claude.json")"
case "$got" in
  *'"command":"sh"'*'$HOME/.local/bin/termag-metaterm-mcp'*'"METATERM_SEND_KEYS_DEFAULT":"off"'*) : ;;
  *) fail 'registers the server, read-only by default' 'sh -c ... $HOME ... off' "$got" ;;
esac
grep -q '/home/\|'"$HOME_DIR" "$HOME_DIR/.claude.json" \
  && fail 'the registration holds no absolute home path' 'none' "$(cat "$HOME_DIR/.claude.json")"
got="$(jq -c '[.numStartups, (.mcpServers.mine.command)]' "$HOME_DIR/.claude.json")"
[ "$got" = '[3,"x"]' ] || fail "keeps the owner's own ~/.claude.json" '[3,"x"]' "$got"
got="$(stat -c %a "$HOME_DIR/.claude.json")"
[ "$got" = 640 ] || fail 'keeps the ~/.claude.json mode' 640 "$got"
got="$(jq -c '.permissions.allow' "$HOME_DIR/.claude/settings.json")"
want='["Bash(ls)","mcp__metaterm__capture_pane","mcp__metaterm__list_sessions","mcp__metaterm__session_status"]'
[ "$got" = "$want" ] || fail 'appends only the missing approvals, in place' "$want" "$got"
got="$(jq -c '[.hooks, .permissions.deny]' "$HOME_DIR/.claude/settings.json")"
[ "$got" = '[{"Stop":[]},["Bash(rm)"]]' ] || fail 'keeps hooks and deny rules' '[{"Stop":[]},["Bash(rm)"]]' "$got"
jq -e '.permissions.allow | index("mcp__metaterm__send_keys")' "$HOME_DIR/.claude/settings.json" >/dev/null \
  && fail 'never pre-approves send_keys' 'absent' 'present'

out="$(run 2>&1)"
[ -z "$out" ] || fail 'a merged config is silent next boot' '(no output)' "$out"

# A new box with neither file gets both, the registry file private.
rm -f "$HOME_DIR/.claude.json" "$HOME_DIR/.claude/settings.json"
run >/dev/null 2>&1
got="$(stat -c %a "$HOME_DIR/.claude.json" 2>/dev/null)"
[ "$got" = 600 ] || fail 'creates ~/.claude.json 0600' 600 "$got"
got="$(jq -c '.permissions.allow | length' "$HOME_DIR/.claude/settings.json" 2>/dev/null)"
[ "$got" = 3 ] || fail 'creates settings.json with the approvals' 3 "$got"

# Unparseable config is the owner's problem, not ours to replace.
printf 'not json\n' > "$HOME_DIR/.claude.json"
out="$(run 2>&1)"
case "$out" in
  *'not valid JSON'*) : ;;
  *) fail 'says why it skipped unparseable JSON' 'not valid JSON' "$out" ;;
esac
got="$(cat "$HOME_DIR/.claude.json")"
[ "$got" = 'not json' ] || fail 'leaves unparseable JSON alone' 'not json' "$got"

# ── the termag CLI ──────────────────────────────────────────────────────────
# cli/install.sh is stubbed: it records its arguments and reports drift while
# $CLI_STATE says so. cli/install.test.sh covers the real installer.
rm -f "$HOME_DIR/.claude.json"
run >/dev/null 2>&1
mkdir -p "$CHECKOUT/cli" "$WORK/nodebin"
CLI_LOG="$WORK/cli-calls"; CLI_STATE="$WORK/cli-state"; export CLI_LOG CLI_STATE
cat > "$CHECKOUT/cli/install.sh" <<'STUBEOF'
#!/bin/sh
echo "$*" >> "$CLI_LOG"
case " $* " in
  *' --check '*) [ "$(cat "$CLI_STATE")" = current ] && exit 0; echo "STALE: cli/dist"; exit 1 ;;
esac
[ "$(cat "$CLI_STATE")" = broken ] && { echo 'npm ci failed'; exit 1; }
echo current > "$CLI_STATE"
STUBEOF
printf '#!/bin/sh\n' > "$WORK/nodebin/node"
chmod 755 "$WORK/nodebin/node"
cli_run() { HOME="$HOME_DIR" TERMAG_CHECKOUT="$CHECKOUT" PATH="$WORK/nodebin:$STUB:$PATH" "$SCRIPT" "$@"; }

echo stale > "$CLI_STATE"; : > "$CLI_LOG"
out="$(cli_run --check 2>&1)"
got=$?
[ "$got" = 1 ] || fail '--check exits 1 on a stale CLI' 1 "$got"
case "$out" in
  *'STALE: cli/dist'*) : ;;
  *) fail '--check passes on the installer report' 'STALE: cli/dist' "$out" ;;
esac
[ "$(cat "$CLI_STATE")" = stale ] || fail '--check does not install the CLI' stale "$(cat "$CLI_STATE")"

out="$(cli_run 2>&1)"
case "$out" in
  *'reconciled: termag CLI'*) : ;;
  *) fail 'installs a stale CLI' 'reconciled: termag CLI' "$out" ;;
esac
want="--quiet --node $WORK/nodebin/node --bin-dir $HOME_DIR/.local/bin"
grep -qxF -- "$want" "$CLI_LOG" || fail 'installs with the found Node into ~/.local/bin' "$want" "$(cat "$CLI_LOG")"

: > "$CLI_LOG"
out="$(cli_run 2>&1)"
[ -z "$out" ] || fail 'a current CLI is silent' '(no output)' "$out"
got="$(grep -c -- '--quiet' "$CLI_LOG")"
[ "$got" = 0 ] || fail 'a current CLI is only checked' 0 "$got"

# A checkout carrying its own Node pins the CLI to it.
mkdir -p "$CHECKOUT/node/bin"
printf '#!/bin/sh\n' > "$CHECKOUT/node/bin/node"
chmod 755 "$CHECKOUT/node/bin/node"
: > "$CLI_LOG"
cli_run >/dev/null 2>&1
grep -qF -- "--node $CHECKOUT/node/bin/node" "$CLI_LOG" || fail "prefers the checkout's own Node" "--node $CHECKOUT/node/bin/node" "$(cat "$CLI_LOG")"
rm -rf "$CHECKOUT/node"

echo broken > "$CLI_STATE"
out="$(cli_run 2>&1)"
got=$?
[ "$got" = 0 ] || fail 'a failed CLI install does not fail the boot' 0 "$got"
case "$out" in
  *'did not install'*'npm ci failed'*) : ;;
  *) fail 'reports why the CLI did not install' 'did not install ... npm ci failed' "$out" ;;
esac

# No Node anywhere: said, and not an error. HOME has no nvm; a runner with a
# system node in /usr/bin cannot test this.
if [ ! -e /usr/bin/node ] && [ ! -e /bin/node ]; then
  echo stale > "$CLI_STATE"
  out="$(HOME="$HOME_DIR" TERMAG_CHECKOUT="$CHECKOUT" PATH="$STUB:/usr/bin:/bin" "$SCRIPT" 2>&1)"
  got=$?
  [ "$got" = 0 ] || fail 'no Node exits 0' 0 "$got"
  case "$out" in
    *'no Node.js found'*) : ;;
    *) fail 'says no Node was found' 'no Node.js found' "$out" ;;
  esac
fi
rm -rf "$CHECKOUT/cli"

# ── argument handling ───────────────────────────────────────────────────────
run --not-a-flag >/dev/null 2>&1
got=$?
[ "$got" = 2 ] || fail 'unknown flag exits 2' 2 "$got"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: content-compare, modes, reload gating, settings exclusion, unit enablement, box-update service, MetaTerm config, termag CLI'
  exit 0
fi
echo "$failures failure(s)"
exit 1
