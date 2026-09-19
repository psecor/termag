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
#   * enable=enable units get their default.target.wants symlink, and that is
#     checked independently of file content -- the whole point, since a box built
#     before this script existed has the right unit files and no symlinks
#
# `systemctl` is stubbed: the real one would reach this user's actual manager.
#
# Run: sh deploy/termag-reconcile.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-reconcile"
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
seed_source termag-status                'v1-status'
seed_source termag-reconcile             'v1-reconcile'

# ── --list ──────────────────────────────────────────────────────────────────
got="$(run --list | wc -l | tr -d ' ')"
[ "$got" = 4 ] || fail '--list prints every artifact' 4 "$got"

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
         "$HOME_DIR/.local/bin/termag-status" \
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
rm -f "$CHECKOUT/deploy/termag-status" "$HOME_DIR/.local/bin/termag-status"
out="$(run 2>&1)"
got=$?
[ "$got" = 0 ] || fail 'a source missing from the checkout exits 0' 0 "$got"
case "$out" in
  *termag-status*) fail 'a missing source is silent' '(no mention)' "$out" ;;
esac

# ── missing destination is reported as MISSING, not DRIFT ───────────────────
seed_source termag-status 'v1-status'
out="$(run --check 2>&1)"
case "$out" in
  *MISSING*termag-status*) : ;;
  *) fail 'an uninstalled artifact reports MISSING' 'MISSING ... termag-status' "$out" ;;
esac

# ── unit enablement ─────────────────────────────────────────────────────────
WANTS="$HOME_DIR/.config/systemd/user/default.target.wants"

# The enable=enable unit must be linked; the noenable one must not.
for u in termag-reconcile.service; do
  got="$(readlink "$WANTS/$u" 2>/dev/null)"
  [ "$got" = "../$u" ] || fail "enables $u" "../$u" "${got:-(no symlink)}"
done
if [ -e "$WANTS/termag-agent.service" ]; then
  fail 'does not enable termag-agent.service' '(no symlink)' 'symlink present'
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

# ── argument handling ───────────────────────────────────────────────────────
run --not-a-flag >/dev/null 2>&1
got=$?
[ "$got" = 2 ] || fail 'unknown flag exits 2' 2 "$got"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: content-compare, modes, reload gating, settings exclusion, unit enablement'
  exit 0
fi
echo "$failures failure(s)"
exit 1
