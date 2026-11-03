#!/bin/sh
# Tests deploy/termag-terminfo-setup against a scratch root, with this
# machine's tic:
#
#   * a box without the entries gets xterm-ghostty and ghostty in /etc/terminfo,
#     and infocmp then finds both there
#   * a second run, and --check after it, change nothing and say nothing
#   * --check reports a missing entry and writes nothing (exit 1)
#   * a source that does not match its pinned sha256 is never installed (exit 1)
#   * the vendored source is the pinned one
#   * both bakes and termag-reconcile run it
#
# Run: sh deploy/termag-terminfo-setup.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/termag-terminfo-setup"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

if ! command -v tic >/dev/null 2>&1 || ! command -v infocmp >/dev/null 2>&1; then
  echo 'SKIP: no tic/infocmp here'
  exit 0
fi

ROOT="$WORK/root"
run() { TERMAG_TERMINFO_SETUP_ROOT="$ROOT" bash "$SCRIPT" "$@"; }
found() { TERMINFO="$ROOT/etc/terminfo" TERMINFO_DIRS='' infocmp -x "$1" >/dev/null 2>&1; }

# ── --check on a bare box ────────────────────────────────────────────────────
out="$(run --check 2>&1)"; got=$?
[ "$got" = 1 ] || fail '--check on a bare box exits 1' 1 "$got"
case "$out" in *'DRIFT: terminfo xterm-ghostty ghostty is missing'*) ;; *) fail '--check names both entries' 'DRIFT: terminfo xterm-ghostty ghostty …' "$out" ;; esac
[ -e "$ROOT/etc/terminfo" ] && fail '--check writes nothing' 'no /etc/terminfo' "$(ls -R "$ROOT")"

# ── apply ────────────────────────────────────────────────────────────────────
out="$(run 2>&1)"; got=$?
[ "$got" = 0 ] || fail 'installs' 0 "$got: $out"
case "$out" in "installed: terminfo xterm-ghostty ghostty in $ROOT/etc/terminfo") ;; *) fail 'says what it installed' 'installed: terminfo xterm-ghostty ghostty in …' "$out" ;; esac
found xterm-ghostty || fail 'infocmp finds xterm-ghostty' found missing
found ghostty || fail 'infocmp finds ghostty' found missing
cols=$(TERMINFO="$ROOT/etc/terminfo" TERM=xterm-ghostty tput colors 2>/dev/null)
[ "$cols" = 256 ] || fail 'xterm-ghostty has 256 colours' 256 "$cols"

# ── a current box writes nothing ─────────────────────────────────────────────
before=$(ls -lR --time-style=full-iso "$ROOT")
out="$(run 2>&1)"; got=$?
[ "$got:$out" = '0:' ] || fail 'a second run is silent' '0:' "$got:$out"
[ "$(ls -lR --time-style=full-iso "$ROOT")" = "$before" ] || fail 'a second run writes nothing' 'same tree' 'changed'
out="$(run --check 2>&1)"; got=$?
[ "$got:$out" = '0:' ] || fail '--check on a current box' '0:' "$got:$out"

# ── a lost alias is drift ────────────────────────────────────────────────────
rm -f "$ROOT/etc/terminfo/g/ghostty"
out="$(run --check 2>&1)"
case "$out" in *'DRIFT: terminfo ghostty is missing'*) ;; *) fail '--check names only the missing alias' 'DRIFT: terminfo ghostty …' "$out" ;; esac
run >/dev/null 2>&1
found ghostty || fail 'the alias comes back' found missing

# ── the pin ──────────────────────────────────────────────────────────────────
mkdir -p "$WORK/deploy/terminfo"
sed 's/cols#80/cols#81/' "$HERE/terminfo/ghostty.terminfo" > "$WORK/deploy/terminfo/ghostty.terminfo"
out="$(TERMAG_TERMINFO_SETUP_DEPLOY="$WORK/deploy" TERMAG_TERMINFO_SETUP_ROOT="$WORK/other" bash "$SCRIPT" 2>&1)"; got=$?
[ "$got" = 1 ] || fail 'an edited source fails the run' 1 "$got"
case "$out" in *'does not match its pinned sha256'*) ;; *) fail 'says why' 'does not match its pinned sha256' "$out" ;; esac
[ -e "$WORK/other" ] && fail 'an edited source is never installed' 'nothing written' "$(ls -R "$WORK/other")"

pinned=$(sed -n 's/^SOURCES=.terminfo\/ghostty.terminfo:\([0-9a-f]*\):.*/\1/p' "$SCRIPT")
actual=$(sha256sum "$HERE/terminfo/ghostty.terminfo" | cut -d' ' -f1)
[ -n "$pinned" ] && [ "$pinned" = "$actual" ] || fail 'the vendored source is the pinned one' "$pinned" "$actual"
grep -qF "$actual" "$HERE/terminfo/README.md" || fail 'terminfo/README.md names the pinned sha256' "$actual" 'not in README.md'

# ── the bake and reconcile wire it ───────────────────────────────────────────
PACKER="$HERE/../packer/scripts"
grep -qF 'sudo bash /home/termag/src/termag/deploy/termag-terminfo-setup' "$PACKER/box-lib.sh" \
  || fail 'box-lib.sh runs the setup from the checkout' 'install_terminfo' missing
# Both bakes, full and incremental, after the checkout is cloned.
for f in setup.sh refresh-box.sh; do
  grep -qx 'install_terminfo' "$PACKER/$f" || fail "$f installs the terminfo" install_terminfo missing
done
grep -q 'kitty-terminfo' "$PACKER/setup.sh" || fail 'the full bake installs kitty-terminfo' kitty-terminfo missing
grep -qx 'reconcile_terminfo' "$HERE/termag-reconcile" || fail 'termag-reconcile runs it' reconcile_terminfo missing

if [ "$failures" -eq 0 ]; then
  echo 'PASS: install, idempotence, --check, alias drift, sha256 pin, bake and reconcile wiring'
  exit 0
fi
echo "$failures failure(s)"
exit 1
