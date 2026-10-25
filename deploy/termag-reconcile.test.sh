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
#   * ~/.claude.json gets hasCompletedOnboarding, so a fresh box's Claude pane
#     does not wait on the theme picker; the trust prompt is left alone
#   * pi gets the same server in ~/.pi/agent/mcp.json, with no approvals merge
#     (pi runs tool calls without prompting, so there is nothing to allow-list)
#   * enable=enable units get their default.target.wants symlink, and that is
#     checked independently of file content -- the whole point, since a box built
#     before this script existed has the right unit files and no symlinks
#   * the termag CLI is installed through cli/install.sh only when its --check
#     reports drift, and a failed install does not fail the run
#   * the box-update service and script are installed; the service is not
#     enabled (the orchestrator starts it over the agent's box-update RPC)
#   * the retired ask sandbox: the old setup and exec scripts are removed;
#     the termag-subagent user and its root go only with sudo -n and no
#     process of the user running; --check reports them and changes nothing;
#     a box that can't remove them is not drift
#   * the guest browser setup runs through sudo -n, for this user, only on a
#     box: --check reports its drift and applies nothing; a host, a box
#     without passwordless sudo, or a checkout without the script is no drift;
#     a failed setup is reported and does not fail the run
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
# Every run writes git config under the scratch home, never the caller's.
XDG_CONFIG_HOME="$HOME_DIR/.config"; export XDG_CONFIG_HOME
# HOME alone does not isolate the runner's inherited nvm installation.
NVM_DIR="$HOME_DIR/.nvm"; export NVM_DIR
# The ask sandbox's retirement never reaches the host's real user or root.
TERMAG_ASK_SANDBOX_ROOT="$WORK/old-sandbox"; TERMAG_ASK_SANDBOX_USER=termag-test-no-such-user
TERMAG_ASK_SANDBOX_SUDO=false; export TERMAG_ASK_SANDBOX_ROOT TERMAG_ASK_SANDBOX_USER TERMAG_ASK_SANDBOX_SUDO
# Nor does the guest browser setup: no sudo, and not a box.
TERMAG_GUEST_BROWSER_SUDO=false; TERMAG_GUEST_BROWSER_BOX_MARKER="$WORK/no-box-marker"
export TERMAG_GUEST_BROWSER_SUDO TERMAG_GUEST_BROWSER_BOX_MARKER

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
seed_source termag-project-clone         'v1-project-clone'
seed_source 'termag-project-clone@.service' 'v1-project-clone-unit'
seed_source termag-hook-run              'v1-hook-run'
seed_source termag-credentials           'v1-credentials'
seed_source termag-claude-token          'v1-claude-token'

seed_source termag-metaterm-mcp          'v1-metaterm-mcp'
mkdir -p "$CHECKOUT/deploy/claude-skills/metaterm" "$CHECKOUT/deploy/pi-skills/metaterm"
seed_source claude-skills/metaterm/SKILL.md 'v1-skill'
seed_source pi-skills/metaterm/SKILL.md     'v1-pi-skill'
seed_source termag-pr-body               'v1-pr-body'
seed_source termag-pr-create             'v1-pr-create'
seed_source termag-commit-msg            '# termag-commit-msg v1'
mkdir -p "$CHECKOUT/deploy/claude-skills/termag-pr" "$CHECKOUT/deploy/pi-skills/termag-pr"
seed_source claude-skills/termag-pr/SKILL.md 'v1-pr-skill'
seed_source pi-skills/termag-pr/SKILL.md     'v1-pi-pr-skill'
mkdir -p "$CHECKOUT/deploy/claude-skills/termag-spaces" "$CHECKOUT/deploy/pi-skills/termag-spaces"
seed_source claude-skills/termag-spaces/SKILL.md 'v1-spaces-skill'
seed_source pi-skills/termag-spaces/SKILL.md     'v1-pi-spaces-skill'
mkdir -p "$CHECKOUT/deploy/claude-skills/termag-handoff" "$CHECKOUT/deploy/pi-skills/termag-handoff"
seed_source claude-skills/termag-handoff/SKILL.md 'v1-handoff-skill'
seed_source pi-skills/termag-handoff/SKILL.md     'v1-pi-handoff-skill'
mkdir -p "$CHECKOUT/deploy/claude-skills/agent-orchestrator"
seed_source claude-skills/agent-orchestrator/SKILL.md 'v1-orchestrator-skill'
seed_source termag-pi-fireworks          'v1-pi-fireworks'
seed_source termag-agent-otel            'v1-agent-otel'
seed_source termag-claude-runner         'v1-claude-runner'
seed_source termag-briefing              'v1-briefing'
mkdir -p "$CHECKOUT/deploy/pi-ext"
seed_source pi-ext/termag-status.ts      'v1-pi-ext'
seed_source pi-ext/termag-status-core.ts 'v1-pi-ext-core'
seed_source pi-ext/termag-otel.ts        'v1-pi-otel'
seed_source pi-ext/termag-otel-core.ts   'v1-pi-otel-core'
mkdir -p "$CHECKOUT/deploy/claude-runner-hooks"
seed_source claude-runner-hooks/command      'v1-hook-command'
seed_source claude-runner-hooks/post-session 'v1-hook-post-session'

# ── --list ──────────────────────────────────────────────────────────────────
got="$(run --list | wc -l | tr -d ' ')"
[ "$got" = 40 ] || fail '--list prints every artifact' 40 "$got"

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
         "$HOME_DIR/.config/systemd/user/termag-project-clone@.service" \
         "$HOME_DIR/.local/bin/termag-box-update" \
         "$HOME_DIR/.local/bin/termag-project-clone" \
         "$HOME_DIR/.local/bin/termag-status" \
         "$HOME_DIR/.local/bin/termag-hooks-update" \
         "$HOME_DIR/.local/bin/termag-pi-fireworks" \
         "$HOME_DIR/.local/bin/termag-claude-runner" \
         "$HOME_DIR/.local/share/termag/pi-ext/termag-status.ts" \
         "$HOME_DIR/.local/share/termag/pi-ext/termag-status-core.ts" \
         "$HOME_DIR/.local/share/termag/pi-ext/termag-otel.ts" \
         "$HOME_DIR/.local/share/termag/pi-ext/termag-otel-core.ts" \
         "$HOME_DIR/.local/bin/termag-agent-otel" \
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
rm -f "$HOME_DIR/.claude/settings.json"
run >/dev/null 2>&1

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
if [ -e "$WANTS/termag-project-clone@.service" ]; then
  fail 'does not enable termag-project-clone@.service' '(no symlink)' 'symlink present'
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
jq -e '.mcpServers.metaterm' "$HOME_DIR/.claude.json" >/dev/null 2>&1 \
  && fail 'no MetaTerm registration without the server' 'absent' 'present'
[ -e "$HOME_DIR/.pi/agent/mcp.json" ] && fail 'no pi MetaTerm registration without the server' 'absent' 'present'
got="$(stat -c %a "$HOME_DIR/.claude/skills/metaterm/SKILL.md" 2>/dev/null)"
[ "$got" = 644 ] || fail 'skill installed 644' 644 "$got"
got="$(stat -c %a "$HOME_DIR/.pi/agent/skills/metaterm/SKILL.md" 2>/dev/null)"
[ "$got" = 644 ] || fail 'pi skill installed 644' 644 "$got"
got="$(stat -c %a "$HOME_DIR/.local/bin/termag-pr-body" 2>/dev/null)"
[ "$got" = 755 ] || fail 'termag-pr-body installed 755' 755 "$got"
got="$(stat -c %a "$HOME_DIR/.local/bin/termag-pr-create" 2>/dev/null)"
[ "$got" = 755 ] || fail 'termag-pr-create installed 755' 755 "$got"
got="$(cat "$HOME_DIR/.claude/skills/termag-pr/SKILL.md" "$HOME_DIR/.pi/agent/skills/termag-pr/SKILL.md" 2>/dev/null | tr '\n' ' ')"
[ "$got" = 'v1-pr-skill v1-pi-pr-skill ' ] || fail 'PR skills installed' 'v1-pr-skill v1-pi-pr-skill' "$got"
got="$(cat "$HOME_DIR/.claude/skills/termag-spaces/SKILL.md" "$HOME_DIR/.pi/agent/skills/termag-spaces/SKILL.md" 2>/dev/null | tr '\n' ' ')"
[ "$got" = 'v1-spaces-skill v1-pi-spaces-skill ' ] || fail 'spaces skills installed' 'v1-spaces-skill v1-pi-spaces-skill' "$got"
got="$(cat "$HOME_DIR/.claude/skills/termag-handoff/SKILL.md" "$HOME_DIR/.pi/agent/skills/termag-handoff/SKILL.md" 2>/dev/null | tr '\n' ' ')"
[ "$got" = 'v1-handoff-skill v1-pi-handoff-skill ' ] || fail 'handoff skills installed' 'v1-handoff-skill v1-pi-handoff-skill' "$got"
got="$(cat "$HOME_DIR/.claude/skills/agent-orchestrator/SKILL.md" 2>/dev/null)"
[ "$got" = 'v1-orchestrator-skill' ] || fail 'orchestrator skill installed for Claude Code' 'v1-orchestrator-skill' "$got"
got="$(stat -c %a "$HOME_DIR/.claude/skills/agent-orchestrator/SKILL.md" 2>/dev/null)"
[ "$got" = 644 ] || fail 'orchestrator skill installed 644' 644 "$got"

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
  *'DRIFT: MetaTerm MCP server missing'*'DRIFT: MetaTerm read-tool approvals'*'would create with MetaTerm MCP server (pi)'*) : ;;
  *) fail '--check reports all three MetaTerm merges' 'DRIFT x3' "$out" ;;
esac
got="$(jq -c '.mcpServers | keys' "$HOME_DIR/.claude.json")"
[ "$got" = '["mine"]' ] || fail '--check does not merge' '["mine"]' "$got"
[ -e "$HOME_DIR/.pi/agent/mcp.json" ] && fail '--check does not write the pi config' 'absent' 'present'
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
want='["Bash(ls)","mcp__metaterm__capture_pane","mcp__metaterm__list_sessions","mcp__metaterm__search_sessions","mcp__metaterm__session_status","mcp__metaterm__activity_ledger","mcp__metaterm__latest_briefing","mcp__metaterm__list_spawns","mcp__metaterm__report_back","mcp__metaterm__slack_inbox","mcp__metaterm__spawn_budget"]'
[ "$got" = "$want" ] || fail 'appends only the missing approvals, in place' "$want" "$got"
got="$(jq -c '[.hooks.Stop, .permissions.deny]' "$HOME_DIR/.claude/settings.json")"
[ "$got" = '[[],["Bash(rm)"]]' ] || fail 'keeps hooks and deny rules' '[[],["Bash(rm)"]]' "$got"
jq -e '.permissions.allow | index("mcp__metaterm__send_keys")' "$HOME_DIR/.claude/settings.json" >/dev/null \
  && fail 'never pre-approves send_keys' 'absent' 'present'
jq -e '.permissions.allow | index("mcp__metaterm__draft_slack_message")' "$HOME_DIR/.claude/settings.json" >/dev/null \
  && fail 'never pre-approves draft_slack_message' 'absent' 'present'

out="$(run 2>&1)"
[ -z "$out" ] || fail 'a merged config is silent next boot' '(no output)' "$out"

# A new box with neither file gets both, the registry file private.
rm -f "$HOME_DIR/.claude.json" "$HOME_DIR/.claude/settings.json"
run >/dev/null 2>&1
got="$(stat -c %a "$HOME_DIR/.claude.json" 2>/dev/null)"
[ "$got" = 600 ] || fail 'creates ~/.claude.json 0600' 600 "$got"
got="$(jq -c '.permissions.allow | length' "$HOME_DIR/.claude/settings.json" 2>/dev/null)"
[ "$got" = 10 ] || fail 'creates settings.json with the approvals' 10 "$got"

# Unparseable config is the owner's problem, not ours to replace.
printf 'not json\n' > "$HOME_DIR/.claude.json"
out="$(run 2>&1)"
case "$out" in
  *'not valid JSON'*) : ;;
  *) fail 'says why it skipped unparseable JSON' 'not valid JSON' "$out" ;;
esac
got="$(cat "$HOME_DIR/.claude.json")"
[ "$got" = 'not json' ] || fail 'leaves unparseable JSON alone' 'not json' "$got"

# ── Claude Code's first-run onboarding ─────────────────────────────────────
# A fresh box's pane has nobody to answer the theme picker, so the flag is set;
# nothing else in ~/.claude.json changes, and the trust prompt is not answered.
printf '%s\n' '{"numStartups":0,"projects":{"/p":{"hasTrustDialogAccepted":false}}}' > "$HOME_DIR/.claude.json"
out="$(run --check 2>&1)"
case "$out" in
  *'DRIFT: Claude Code onboarding done missing'*) : ;;
  *) fail '--check reports the missing onboarding flag' 'DRIFT: Claude Code onboarding done' "$out" ;;
esac
got="$(jq -c '.hasCompletedOnboarding' "$HOME_DIR/.claude.json")"
[ "$got" = null ] || fail '--check does not set the onboarding flag' null "$got"
run >/dev/null 2>&1
got="$(jq -c '[.hasCompletedOnboarding, .numStartups, .projects["/p"].hasTrustDialogAccepted]' "$HOME_DIR/.claude.json")"
[ "$got" = '[true,0,false]' ] || fail 'sets onboarding only, trust untouched' '[true,0,false]' "$got"
out="$(run 2>&1)"
[ -z "$out" ] || fail 'an onboarded config is silent next boot' '(no output)' "$out"
# termag-credentials holds its ~/.claude.json lock: reconcile waits for it,
# and gives up without writing when it is held too long.
if command -v flock >/dev/null 2>&1; then
  printf '%s\n' '{"numStartups":0}' > "$HOME_DIR/.claude.json"
  mkdir -p "$HOME_DIR/.config/termag"
  flock "$HOME_DIR/.config/termag/claude-json.lock" sleep 3 &
  holder=$!
  sleep 0.5
  out="$(TERMAG_CLAUDE_JSON_LOCK_WAIT=1 run 2>&1)"
  case "$out" in
    *'held its lock too long; not adding Claude Code onboarding done'*) : ;;
    *) fail 'reconcile gives up on a held ~/.claude.json lock' 'held its lock too long' "$out" ;;
  esac
  got="$(jq -c '.hasCompletedOnboarding' "$HOME_DIR/.claude.json")"
  [ "$got" = null ] || fail 'reconcile writes nothing while the lock is held' null "$got"
  run >/dev/null 2>&1
  got="$(jq -c '.hasCompletedOnboarding' "$HOME_DIR/.claude.json")"
  [ "$got" = true ] || fail 'reconcile waits for the lock, then sets onboarding' true "$got"
  wait "$holder"
else
  echo 'SKIP: flock is not installed; the ~/.claude.json lock test needs it'
fi

# ── the SessionStart PATH hook ──────────────────────────────────────────────
# Claude Code's Bash tool reads no startup file, so ~/.local/bin reaches it only
# through this hook; boxes seeded before it get it here.
SETTINGS="$HOME_DIR/.claude/settings.json"
got="$(jq -r '.hooks.SessionStart[0].hooks[0].command' "$SETTINGS")"
case "$got" in
  *'termag-status" session-start'*) : ;;
  *) fail 'a new settings.json gets the SessionStart hook' 'termag-status" session-start' "$got" ;;
esac
printf '%s\n' '{"hooks":{"SessionStart":[{"matcher":"startup","hooks":[{"type":"command","command":"echo mine"}]}],"Stop":[{"hooks":[{"type":"command","command":"x"}]}]}}' > "$SETTINGS"
out="$(run --check 2>&1)"
case "$out" in
  *'DRIFT: SessionStart PATH hook missing'*) : ;;
  *) fail '--check reports the missing hook' 'DRIFT: SessionStart PATH hook' "$out" ;;
esac
run >/dev/null 2>&1
got="$(jq -c '[.hooks.SessionStart[].hooks[].command | sub("termag-status.*"; "termag")], .hooks.Stop[0].hooks[0].command' "$SETTINGS" | tr '\n' ' ')"
[ "$got" = '["echo mine","\"$HOME/.local/bin/termag"] "x" ' ] \
  || fail "appends the hook after the owner's, keeps the rest" '["echo mine","…termag"] "x"' "$got"
out="$(run 2>&1)"
case "$out" in
  *SessionStart*) fail 'the hook is added once' '(no SessionStart output)' "$out" ;;
esac
got="$(jq -c '.hooks.SessionStart | length' "$SETTINGS")"
[ "$got" = 2 ] || fail 'the hook is not appended twice' 2 "$got"
# Entries without a command (a prompt hook, a bare matcher) don't stop the merge.
printf '%s\n' '{"hooks":{"SessionStart":[{"hooks":[{"type":"prompt","prompt":"p"}]},{"matcher":"m"}]}}' > "$SETTINGS"
out="$(run 2>&1)"
case "$out" in
  *'settings.json is not valid JSON'*) fail 'a hook without a command is not invalid JSON' '(merged)' "$out" ;;
esac
got="$(jq -c '.hooks.SessionStart | length' "$SETTINGS")"
[ "$got" = 3 ] || fail 'appends next to command-less entries' 3 "$got"
# An owner's own variant of the line counts as present.
printf '%s\n' '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"~/.local/bin/termag-status session-start"}]}]}}' > "$SETTINGS"
run >/dev/null 2>&1
got="$(jq -c '.hooks.SessionStart | length' "$SETTINGS")"
[ "$got" = 1 ] || fail "an owner's session-start entry is not duplicated" 1 "$got"

# ── the termag CLI ──────────────────────────────────────────────────────────
# cli/install.sh is stubbed: it records its arguments and reports drift while
# $CLI_STATE says so. cli/install.test.sh covers the real installer.
rm -f "$HOME_DIR/.claude.json"
run >/dev/null 2>&1
mkdir -p "$CHECKOUT/cli" "$WORK/nodebin"
mkdir -p "$CHECKOUT/agent"
cp "$(dirname "$SCRIPT")/../agent/run-node.sh" "$CHECKOUT/agent/run-node.sh"
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

# A stale default must not leave the box without its CLI while the agent works.
mkdir -p "$HOME_DIR/.nvm/versions/node/v24.21.0/bin"
printf '#!/bin/sh\nexit 0\n' > "$HOME_DIR/.nvm/versions/node/v24.21.0/bin/node"
chmod 755 "$HOME_DIR/.nvm/versions/node/v24.21.0/bin/node"
printf 'nvm() { return 3; }\n' > "$HOME_DIR/.nvm/nvm.sh"
echo stale > "$CLI_STATE"; : > "$CLI_LOG"
out="$(cli_run 2>&1)"
want="--quiet --node $HOME_DIR/.nvm/versions/node/v24.21.0/bin/node --bin-dir $HOME_DIR/.local/bin"
grep -qxF -- "$want" "$CLI_LOG" || fail 'CLI uses the installed fallback like the agent' "$want" "$(cat "$CLI_LOG")"
rm -rf "$HOME_DIR/.nvm"

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

# ── MetaTerm's pi config ──────────────────────────────────────────────────
# Merged by the same runs that did the Claude config above.
got="$(jq -c '.mcpServers.metaterm' "$HOME_DIR/.pi/agent/mcp.json")"
case "$got" in
  *'"command":"~/.local/bin/termag-metaterm-mcp"'*'"METATERM_SEND_KEYS_DEFAULT":"off"'*'"METATERM_SEND_KEYS_PROJECT":"off"'*'"METATERM_SPAWN_DEFAULT":"off"'*'"METATERM_HANDOFF_DEFAULT":"off"'*) : ;;
  *) fail 'registers the server for pi, send_keys doubly off' 'env keys off' "$got" ;;
esac
grep -q "$HOME_DIR" "$HOME_DIR/.pi/agent/mcp.json" \
  && fail 'the pi registration holds no absolute home path' 'none' "$(cat "$HOME_DIR/.pi/agent/mcp.json")"
got="$(stat -c %a "$HOME_DIR/.pi/agent/mcp.json")"
[ "$got" = 600 ] || fail 'creates ~/.pi/agent/mcp.json 0600' 600 "$got"

# An owner's own pi config survives, apart from the added server, mode kept.
# Unrelated top-level pi keys (autoEnableCodemode) survive too.
printf '%s\n' '{"autoEnableCodemode":false,"mcpServers":{"mine":{"url":"https://example.com/mcp"}}}' > "$HOME_DIR/.pi/agent/mcp.json"
chmod 640 "$HOME_DIR/.pi/agent/mcp.json"
run >/dev/null 2>&1
got="$(jq -c '[.autoEnableCodemode, .mcpServers.mine.url, .mcpServers.metaterm.type]' "$HOME_DIR/.pi/agent/mcp.json")"
[ "$got" = '[false,"https://example.com/mcp","stdio"]' ] || fail "keeps the owner's own pi mcp.json" 'top-level keys + mine + metaterm' "$got"
got="$(stat -c %a "$HOME_DIR/.pi/agent/mcp.json")"
[ "$got" = 640 ] || fail 'keeps the pi mcp.json mode' 640 "$got"

# Owner-tunable knobs on the pi entry survive a reconcile: enabled (the only
# durable off-switch), exposure, toolExposure, timeout, cwd. The rest of the
# entry is rewritten to the canonical value.
jq '.mcpServers.metaterm += {"enabled":false,"exposure":"direct","timeout":30,"command":"/stale/path"}' \
  "$HOME_DIR/.pi/agent/mcp.json" > "$HOME_DIR/.pi/agent/mcp.json.tmp" && mv "$HOME_DIR/.pi/agent/mcp.json.tmp" "$HOME_DIR/.pi/agent/mcp.json"
run >/dev/null 2>&1
got="$(jq -c '[.mcpServers.metaterm.enabled, .mcpServers.metaterm.exposure, .mcpServers.metaterm.timeout, .mcpServers.metaterm.command]' "$HOME_DIR/.pi/agent/mcp.json")"
[ "$got" = '[false,"direct",30,"~/.local/bin/termag-metaterm-mcp"]' ] || fail 'keeps owner knobs, rewrites the rest' '[false,direct,30,canonical command]' "$got"

# Drift on the pi entry is reported: a changed canonical field is a DRIFT
# line, and --check leaves the file as it found it.
jq '.mcpServers.metaterm.env.METATERM_SEND_KEYS_DEFAULT = "on"' \
  "$HOME_DIR/.pi/agent/mcp.json" > "$HOME_DIR/.pi/agent/mcp.json.tmp" && mv "$HOME_DIR/.pi/agent/mcp.json.tmp" "$HOME_DIR/.pi/agent/mcp.json"
out="$(run --check 2>&1)"
got=$?
[ "$got" = 1 ] || fail '--check exits 1 on pi drift' 1 "$got"
case "$out" in
  *'DRIFT: MetaTerm MCP server (pi)'*) : ;;
  *) fail '--check reports pi drift' 'DRIFT (pi)' "$out" ;;
esac
got="$(jq -c '.mcpServers.metaterm.env.METATERM_SEND_KEYS_DEFAULT' "$HOME_DIR/.pi/agent/mcp.json")"
[ "$got" = '"on"' ] || fail '--check does not rewrite pi drift' 'unchanged' "$got"

# Unparseable pi config is skipped, not replaced.
printf 'not json\n' > "$HOME_DIR/.pi/agent/mcp.json"
out="$(run 2>&1)"
case "$out" in
  *'not valid JSON'*) : ;;
  *) fail 'says why it skipped unparseable pi JSON' 'not valid JSON' "$out" ;;
esac
got="$(cat "$HOME_DIR/.pi/agent/mcp.json")"
[ "$got" = 'not json' ] || fail 'leaves unparseable pi JSON alone' 'not json' "$got"

# A scalar .mcpServers.metaterm is malformed, not unparseable: heal it to the
# canonical entry instead of failing on it forever. The owner's own servers
# and the file mode survive.
printf '%s\n' '{"mcpServers":{"metaterm":"oops","mine":{"url":"https://example.com/mcp"}}}' > "$HOME_DIR/.pi/agent/mcp.json"
chmod 640 "$HOME_DIR/.pi/agent/mcp.json"
out="$(run 2>&1)"
case "$out" in
  *'not valid JSON'*) fail 'heals a scalar metaterm entry' 'no error' "$out" ;;
esac
got="$(jq -c '[.mcpServers.metaterm.type, .mcpServers.metaterm.env.METATERM_SEND_KEYS_PROJECT, .mcpServers.mine.url]' "$HOME_DIR/.pi/agent/mcp.json")"
[ "$got" = '["stdio","off","https://example.com/mcp"]' ] || fail 'heals a scalar metaterm entry' 'canonical' "$got"
got="$(stat -c %a "$HOME_DIR/.pi/agent/mcp.json")"
[ "$got" = 640 ] || fail 'keeps the pi mcp.json mode across a heal' 640 "$got"

# ── the retired ask sandbox ─────────────────────────────────────────────────
mkdir -p "$CHECKOUT/deploy/claude-skills/agent-ask"
seed_source claude-skills/agent-ask/SKILL.md 'v1-ask-skill'
mkdir -p "$HOME_DIR/.local/lib/termag" "$TERMAG_ASK_SANDBOX_ROOT/threads/t1"
echo old > "$HOME_DIR/.local/bin/termag-subagent-setup"
echo old > "$HOME_DIR/.local/lib/termag/termag-subagent-exec"
# A sudo -n that works: it logs, runs rm and true, and only records userdel.
cat > "$STUB/fake-sudo" <<'SUDOEOF'
#!/bin/sh
echo "sudo $*" >> "$SUDO_LOG"
case $1 in userdel) exit 0 ;; esac
exec "$@"
SUDOEOF
cat > "$STUB/pgrep" <<'PGREPEOF'
#!/bin/sh
[ -f "$PGREP_FINDS" ]
PGREPEOF
chmod 755 "$STUB/fake-sudo" "$STUB/pgrep"
SUDO_LOG="$WORK/sudo-log"; PGREP_FINDS="$WORK/pgrep-finds"; export SUDO_LOG PGREP_FINDS
: > "$SUDO_LOG"
sandbox_run() { TERMAG_ASK_SANDBOX_USER="$(id -un)" TERMAG_ASK_SANDBOX_SUDO="$STUB/fake-sudo" run "$@"; }

# Without sudo: the scripts go, the user and root stay and are not drift.
out="$(run 2>&1)"
case "$out" in *"retired: $HOME_DIR/.local/bin/termag-subagent-setup"*) ;; *) fail 'retires the old setup script' 'retired: …termag-subagent-setup' "$out" ;; esac
[ -e "$HOME_DIR/.local/lib/termag/termag-subagent-exec" ] && fail 'retires the old exec script' absent present
[ -f "$HOME_DIR/.claude/skills/agent-ask/SKILL.md" ] || fail 'installs the agent-ask skill' present absent
[ -d "$TERMAG_ASK_SANDBOX_ROOT" ] || fail 'keeps the root without sudo' present absent
TERMAG_ASK_SANDBOX_USER="$(id -un)" run --check >/dev/null 2>&1
got=$?
[ "$got" = 0 ] || fail 'a sandbox nothing can remove is no drift' 0 "$got"

# An old run still going: kept for the next reconcile.
touch "$PGREP_FINDS"
sandbox_run --check >/dev/null 2>&1
got=$?
[ "$got" = 0 ] || fail 'a sandbox with a live run is left alone' 0 "$got"
rm -f "$PGREP_FINDS"

# With sudo and nothing running: --check reports and changes nothing, then a run retires both.
out="$(sandbox_run --check 2>&1)"
got=$?
[ "$got" = 1 ] || fail 'a removable sandbox is drift' 1 "$got"
case "$out" in *"STALE: user $(id -un)"*"STALE: $TERMAG_ASK_SANDBOX_ROOT"*) ;; *) fail '--check names the user and root' 'STALE: user / STALE: root' "$out" ;; esac
[ -d "$TERMAG_ASK_SANDBOX_ROOT" ] || fail '--check removes nothing' present absent
grep -q userdel "$SUDO_LOG" && fail '--check deletes no user' 'no userdel' "$(cat "$SUDO_LOG")"
out="$(sandbox_run 2>&1)"
[ -d "$TERMAG_ASK_SANDBOX_ROOT" ] && fail 'retires the sandbox root' absent present
grep -q "sudo userdel $(id -un)" "$SUDO_LOG" || fail 'deletes the sandbox user' "sudo userdel $(id -un)" "$(cat "$SUDO_LOG")"
case "$out" in *"retired: user $(id -un)"*) ;; *) fail 'says so' 'retired: user' "$out" ;; esac
rm -f "$STUB/pgrep"

# ── the guest browser setup ─────────────────────────────────────────────────
# A stand-in setup in the checkout: it logs its arguments, reports drift while
# $GUEST_DRIFT exists, and fails a real run while $GUEST_FAILS exists.
cat > "$CHECKOUT/deploy/termag-guest-browser-setup" <<'SETUPEOF'
echo "setup $*" >> "$GUEST_LOG"
case " $* " in
  *" --check "*) [ -f "$GUEST_DRIFT" ] && { echo 'DRIFT: user termag-guest is missing'; exit 1; }; exit 0 ;;
esac
[ -f "$GUEST_FAILS" ] && { echo 'termag-guest-browser-setup: could not create user termag-guest' >&2; exit 1; }
echo 'created: user termag-guest'
rm -f "$GUEST_DRIFT"
SETUPEOF
GUEST_LOG="$WORK/guest-log"; GUEST_DRIFT="$WORK/guest-drift"; GUEST_FAILS="$WORK/guest-fails"
export GUEST_LOG GUEST_DRIFT GUEST_FAILS
touch "$WORK/box-marker" "$GUEST_DRIFT"; : > "$GUEST_LOG"
guest_run() { TERMAG_GUEST_BROWSER_BOX_MARKER="$WORK/box-marker" TERMAG_GUEST_BROWSER_SUDO="$STUB/fake-sudo" run "$@"; }

# Not a box, or no sudo: never run, and no drift.
TERMAG_GUEST_BROWSER_SUDO="$STUB/fake-sudo" run --check >/dev/null 2>&1
got=$?
[ "$got" = 0 ] || fail 'the guest setup is no drift off a box' 0 "$got"
TERMAG_GUEST_BROWSER_BOX_MARKER="$WORK/box-marker" run --check >/dev/null 2>&1
got=$?
[ "$got" = 0 ] || fail 'the guest setup is no drift without sudo' 0 "$got"
[ -s "$GUEST_LOG" ] && fail 'the guest setup never runs off a box or without sudo' 'empty log' "$(cat "$GUEST_LOG")"

# On a box with sudo: --check reports and applies nothing, then a run applies, as this user.
out="$(guest_run --check 2>&1)"
got=$?
[ "$got" = 1 ] || fail 'the guest setup drift is drift' 1 "$got"
case "$out" in *'DRIFT: guest browser: user termag-guest is missing'*) ;; *) fail '--check names the guest drift' 'DRIFT: guest browser: …' "$out" ;; esac
got="$(cat "$GUEST_LOG")"
[ "$got" = "setup --agent-user $(id -un) --check" ] || fail '--check only checks, for this user' "setup --agent-user $(id -un) --check" "$got"
grep -q "sudo bash $CHECKOUT/deploy/termag-guest-browser-setup" "$SUDO_LOG" || fail 'the guest setup goes through sudo' 'sudo bash …setup' "$(cat "$SUDO_LOG")"
out="$(guest_run 2>&1)"
case "$out" in *'reconciled: guest browser: created: user termag-guest'*) ;; *) fail 'applies the guest setup' 'reconciled: guest browser: …' "$out" ;; esac
grep -qx "setup --agent-user $(id -un)" "$GUEST_LOG" || fail 'applies for this user' "setup --agent-user $(id -un)" "$(cat "$GUEST_LOG")"
guest_run --check >/dev/null 2>&1
got=$?
[ "$got" = 0 ] || fail 'a set-up guest browser is no drift' 0 "$got"

# A failed setup: said on stderr, the run still succeeds.
touch "$GUEST_DRIFT" "$GUEST_FAILS"
out="$(guest_run 2>&1)"
got=$?
[ "$got" = 0 ] || fail 'a failed guest setup does not fail the run' 0 "$got"
case "$out" in *'termag-reconcile: the guest browser setup failed'*) ;; *) fail 'says the guest setup failed' 'the guest browser setup failed' "$out" ;; esac
rm -f "$CHECKOUT/deploy/termag-guest-browser-setup" "$GUEST_DRIFT" "$GUEST_FAILS"

# ── the commit trailer hook in the git template ─────────────────────────────
if command -v git >/dev/null 2>&1; then
  TEMPLATE_HOOK="$HOME_DIR/.local/share/termag/git-template/hooks/commit-msg"
  XDG_GIT="$HOME_DIR/.config/git/config"
  got="$(stat -c %a "$TEMPLATE_HOOK" 2>/dev/null)"
  [ "$got" = 755 ] || fail 'commit-msg hook installed 755 in the template' 755 "$got"
  got="$(git config --file "$XDG_GIT" --get init.templateDir)"
  # shellcheck disable=SC2088
  [ "$got" = '~/.local/share/termag/git-template' ] || fail 'init.templateDir set in the XDG config' '~/.local/share/termag/git-template' "$got"

  # Existing termag projects: one with no hook gets ours, one with its own keeps it.
  P="$HOME_DIR/termag/projects"
  mkdir -p "$P/bare/.git/hooks" "$P/owned/.git/hooks" "$P/stale/.git/hooks"
  printf '#!/bin/sh\necho mine\n' > "$P/owned/.git/hooks/commit-msg"
  printf '# termag-commit-msg v0\n' > "$P/stale/.git/hooks/commit-msg"
  out="$(run --check 2>&1)"
  rc=$?
  [ "$rc" = 1 ] || fail '--check exits 1 on a project without the hook' 1 "$rc"
  case "$out" in *"MISSING: $P/bare/.git/hooks/commit-msg"*) : ;; *) fail '--check reports the project' 'MISSING bare' "$out" ;; esac
  run >/dev/null 2>&1
  cmp -s "$TEMPLATE_HOOK" "$P/bare/.git/hooks/commit-msg" || fail 'installs the hook into a project without one' 'copy' 'absent or different'
  cmp -s "$TEMPLATE_HOOK" "$P/stale/.git/hooks/commit-msg" || fail 'updates an older copy of ours' 'copy' "$(cat "$P/stale/.git/hooks/commit-msg")"
  got="$(sed -n 2p "$P/owned/.git/hooks/commit-msg")"
  [ "$got" = 'echo mine' ] || fail "a project's own commit-msg is kept" 'echo mine' "$got"
  out="$(run --check 2>&1)"
  [ "$?" = 0 ] || fail '--check is clean after the hook is installed' 0 "$out"

  # Other spellings of our template (absolute, ~/ with a trailing slash) still
  # count as ours, so the backfill runs.
  # shellcheck disable=SC2088
  for spelling in "$HOME_DIR/.local/share/termag/git-template" '~/.local/share/termag/git-template/'; do
    rm -f "$XDG_GIT" "$P/bare/.git/hooks/commit-msg"
    git config --file "$HOME_DIR/.gitconfig" init.templateDir "$spelling"
    run >/dev/null 2>&1
    cmp -s "$TEMPLATE_HOOK" "$P/bare/.git/hooks/commit-msg" || fail "backfills when init.templateDir is $spelling" 'copy' 'absent'
    [ ! -e "$XDG_GIT" ] || fail "no second init.templateDir for $spelling" 'no XDG config' "$(cat "$XDG_GIT")"
    out="$(run --check 2>&1)"
    [ "$?" = 0 ] || fail "--check is clean with $spelling" 0 "$out"
  done
  rm -f "$HOME_DIR/.gitconfig"

  # An owner's own init.templateDir is left alone, and no project gets a copy.
  rm -f "$XDG_GIT" "$P/bare/.git/hooks/commit-msg"
  printf '[init]\n\ttemplateDir = /opt/mine\n' > "$HOME_DIR/.gitconfig"
  run >/dev/null 2>&1
  [ ! -e "$XDG_GIT" ] || fail "an owner's init.templateDir is not overridden" 'no XDG config' "$(cat "$XDG_GIT")"
  [ ! -e "$P/bare/.git/hooks/commit-msg" ] || fail "no project copy under an owner's template" 'absent' 'present'
  out="$(run --check 2>&1)"
  [ "$?" = 0 ] || fail "--check is clean with an owner's init.templateDir" 0 "$out"
  rm -rf "$HOME_DIR/.gitconfig" "$HOME_DIR/termag"
  run >/dev/null 2>&1
fi

# ── Claude Code plugins, rendered with the box's own home ───────────────────
PLUGIN_SRC="$CHECKOUT/deploy/claude-plugins/termag-mcp-refresh"
PLUGIN_DEST="$HOME_DIR/.local/share/termag/claude-plugins/termag-mcp-refresh"
mkdir -p "$PLUGIN_SRC/.claude-plugin" "$PLUGIN_SRC/hooks"
printf '{"name":"termag-mcp-refresh"}\n' > "$PLUGIN_SRC/.claude-plugin/plugin.json"
printf '{ "modules": ["./register.ts"] }\n' > "$PLUGIN_SRC/hooks/hooks.json"
printf "const VERSION_FILE = '@TERMAG_MCP_VERSION_FILE@'\n" > "$PLUGIN_SRC/hooks/register.ts"
printf 'test()\n' > "$PLUGIN_SRC/hooks/register.test.ts"
out="$(run --check 2>&1)"
[ "$?" = 1 ] || fail '--check exits 1 on a missing plugin' 1 "$out"
case "$out" in *"MISSING: $PLUGIN_DEST/hooks/register.ts"*) ;; *) fail '--check names the plugin file' 'MISSING register.ts' "$out" ;; esac
run >/dev/null 2>&1
got="$(cat "$PLUGIN_DEST/hooks/register.ts" 2>/dev/null)"
[ "$got" = "const VERSION_FILE = '$HOME_DIR/.config/termag/mcp-connectors.version'" ] || fail 'renders the version path with the home' "$HOME_DIR/.config/termag/mcp-connectors.version" "$got"
[ -f "$PLUGIN_DEST/.claude-plugin/plugin.json" ] || fail 'installs the plugin manifest' present absent
[ ! -e "$PLUGIN_DEST/hooks/register.test.ts" ] || fail 'never installs a test file' absent present
got="$(stat -c %a "$PLUGIN_DEST/hooks/hooks.json" 2>/dev/null)"
[ "$got" = 644 ] || fail 'plugin files installed 644' 644 "$got"
out="$(run --check 2>&1)"
[ "$?" = 0 ] || fail '--check is clean after the plugin is installed' 0 "$out"
printf 'local edit\n' >> "$PLUGIN_DEST/hooks/register.ts"
out="$(run --check 2>&1)"
case "$out" in *"DRIFT: $PLUGIN_DEST/hooks/register.ts"*) ;; *) fail '--check reports an edited plugin file' 'DRIFT register.ts' "$out" ;; esac
rm "$PLUGIN_SRC/hooks/hooks.json"
out="$(run --check 2>&1)"
case "$out" in *"STALE: $PLUGIN_DEST/hooks/hooks.json"*) ;; *) fail '--check reports a file gone from the checkout' 'STALE hooks.json' "$out" ;; esac
[ -e "$PLUGIN_DEST/hooks/hooks.json" ] || fail '--check removes nothing' present absent
run >/dev/null 2>&1
[ ! -e "$PLUGIN_DEST/hooks/hooks.json" ] || fail 'removes a file gone from the checkout' absent present
grep -q "$HOME_DIR/.config" "$PLUGIN_DEST/hooks/register.ts" && ! grep -q 'local edit' "$PLUGIN_DEST/hooks/register.ts" \
  || fail 'restores an edited plugin file' 'rendered copy' "$(cat "$PLUGIN_DEST/hooks/register.ts")"
out="$(run --check 2>&1)"
[ "$?" = 0 ] || fail '--check is clean after the plugin is reconciled' 0 "$out"
rm -rf "$CHECKOUT/deploy/claude-plugins"

# ── argument handling ───────────────────────────────────────────────────────
run --not-a-flag >/dev/null 2>&1
got=$?
[ "$got" = 2 ] || fail 'unknown flag exits 2' 2 "$got"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: content-compare, modes, reload gating, settings exclusion, unit enablement, box-update service, MetaTerm config, termag CLI, ask sandbox retirement, guest browser setup, commit trailer hook, Claude plugins'
  exit 0
fi
echo "$failures failure(s)"
exit 1
