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
if [ -e "$WORK/not-set-up" ]; then echo 'termag-credentials: Fireworks is not set up on this box: not enabled for you' >&2; exit 1; fi
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

# ── Fireworks not set up here: the reason, exit 1, no pi ────────────────────
touch "$WORK/not-set-up"
out="$(run --model "$KIMI" 2>&1)"; got=$?
[ "$got" = 1 ] || fail 'not set up: exit 1' 1 "$got"
case "$out" in
  *'not set up on this box: not enabled for you'*'termag-credentials status'*) : ;;
  *) fail 'not set up: names the reason and the status command' 'not set up ... termag-credentials status' "$out" ;;
esac
case "$out" in *TERMAG_PI_AGENT*) fail 'not set up: pi is not started' 'no pi' "$out" ;; esac
rm -f "$WORK/not-set-up"

# ── no model: the orchestrator always names one ─────────────────────────────
run --continue >/dev/null 2>&1; got=$?
[ "$got" = 2 ] || fail 'without --model: exit 2' 2 "$got"

# ── no pi: 127 ──────────────────────────────────────────────────────────────
rm -f "$BIN/pi"
run --model "$KIMI" >/dev/null 2>&1; got=$?
[ "$got" = 127 ] || fail 'without pi: exit 127' 127 "$got"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: termag-pi-fireworks'
  exit 0
fi
echo "$failures failure(s)"
exit 1
