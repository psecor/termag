#!/bin/sh
# Tests deploy/termag-pi-fireworks, the launcher of the pi harness's fireworks
# backend. Claude Code needs none: it starts as `claude`
# with `termag-credentials launch-settings` (termag-credentials.test.sh).
#
# Pure: pi and termag-credentials are stubbed on a sandboxed PATH.
#
# Run: sh deploy/termag-pi-fireworks.test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
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
BIN="$HOME_DIR/.local/bin"
EXT_DIR="$HOME_DIR/.local/share/termag/pi-ext"
mkdir -p "$BIN" "$EXT_DIR"
run() { HOME="$HOME_DIR" PATH="$BIN:/usr/bin:/bin" "$DIR/termag-pi-fireworks" "$@"; }
KIMI=accounts/fireworks/models/kimi-k3

printf '#!/bin/sh\necho "TERMAG_PI_AGENT=$TERMAG_PI_AGENT"\nprintf "%%s\\n" "$@"\n' > "$BIN/pi"
# termag-credentials pi-model: records its arguments; fails with a reason while "$WORK/not-set-up" exists.
cat > "$BIN/termag-credentials" <<STUB
#!/bin/sh
echo "\$*" > "$WORK/creds.args"
if [ -e "$WORK/not-set-up" ]; then echo 'termag-credentials: Fireworks is not set up on this box: the orchestrator has no Fireworks gateway' >&2; exit 1; fi
STUB
chmod 755 "$BIN/pi" "$BIN/termag-credentials"
printf '// ext\n' > "$EXT_DIR/termag-status.ts"
printf '// otel\n' > "$EXT_DIR/termag-otel.ts"

# ── the launch's model: into pi's provider, then pi on it, with both extensions ─
got="$(run --model "$KIMI" --context 1048576 --continue 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
want="TERMAG_PI_AGENT=fireworks --provider termag-fireworks --model $KIMI -e $EXT_DIR/termag-otel.ts -e $EXT_DIR/termag-status.ts --continue"
[ "$got" = "$want" ] || fail 'pi starts on the Fireworks provider and the launch model, with both extensions, then the caller args' "$want" "$got"
[ "$(cat "$WORK/creds.args")" = "pi-model --model $KIMI --context 1048576" ] || fail 'the model and window go to termag-credentials pi-model' "pi-model --model $KIMI --context 1048576" "$(cat "$WORK/creds.args")"
run --model "$KIMI" >/dev/null 2>&1
[ "$(cat "$WORK/creds.args")" = "pi-model --model $KIMI" ] || fail 'no --context without a window' "pi-model --model $KIMI" "$(cat "$WORK/creds.args")"

# ── --models: the flag's list goes to pi-model, never to pi ─────────────────
LIST=W3siaWQiOiJhY2NvdW50cy9maXJld29ya3MvbW9kZWxzL2tpbWktazMiLCJsYWJlbCI6IktpbWkgSzMifV0=
got="$(run --model "$KIMI" --context 1048576 --models "$LIST" --continue 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
want="TERMAG_PI_AGENT=fireworks --provider termag-fireworks --model $KIMI -e $EXT_DIR/termag-otel.ts -e $EXT_DIR/termag-status.ts --continue"
[ "$got" = "$want" ] || fail 'pi gets no --models, and starts on the launch model' "$want" "$got"
[ "$(cat "$WORK/creds.args")" = "pi-model --model $KIMI --context 1048576 --models $LIST" ] \
  || fail 'the list goes to termag-credentials pi-model' "pi-model --model $KIMI --context 1048576 --models $LIST" "$(cat "$WORK/creds.args")"
grep -q 'termag-pi-fireworks: fireworks-pi-menu-v1' "$DIR/termag-pi-fireworks" || fail 'the launcher carries the marker agent/credentials.js reads' marker missing

# ── Fireworks not set up here: the reason, exit 1, no pi ────────────────────
touch "$WORK/not-set-up"
out="$(run --model "$KIMI" 2>&1)"; got=$?
[ "$got" = 1 ] || fail 'not set up: exit 1' 1 "$got"
case "$out" in
  *'not set up on this box: the orchestrator has no Fireworks gateway'*'termag-credentials status'*) : ;;
  *) fail 'not set up: names the reason and the status command' 'not set up ... termag-credentials status' "$out" ;;
esac
case "$out" in *TERMAG_PI_AGENT*) fail 'not set up: pi is not started' 'no pi' "$out" ;; esac
rm -f "$WORK/not-set-up"

# ── no model: the orchestrator always names one ─────────────────────────────
run --continue >/dev/null 2>&1; got=$?
[ "$got" = 2 ] || fail 'without --model: exit 2' 2 "$got"

# ── pi's own updater is termag's refusal, whatever the caller's env said ────
printf '#!/bin/sh\necho "self-update:$PI_SELF_UPDATE_COMMAND skip-check:$PI_SKIP_VERSION_CHECK"\n' > "$BIN/pi"
got="$(PI_SELF_UPDATE_COMMAND='npm install -g {installSpec}' PI_SKIP_VERSION_CHECK='' run --model "$KIMI" 2>/dev/null)"
want='self-update:termag-pi-update --self-update {version} skip-check:1'
[ "$got" = "$want" ] || fail "pi's updater is termag's" "$want" "$got"

# ── no pi: 127, and the verified install as the remedy ──────────────────────
rm -f "$BIN/pi"
out="$(run --model "$KIMI" 2>&1)"; got=$?
[ "$got" = 127 ] || fail 'without pi: exit 127' 127 "$got"
case "$out" in *'termag-pi-update --install-pinned'*) : ;; *) fail 'without pi: the verified install remedy' 'termag-pi-update --install-pinned' "$out" ;; esac

if [ "$failures" -eq 0 ]; then
  echo 'PASS: termag-pi-fireworks'
  exit 0
fi
echo "$failures failure(s)"
exit 1
