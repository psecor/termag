#!/bin/sh
# install_chromium (box-lib.sh) against a stand-in snap store: a box image
# never ships without the browser pane's Chromium. It installs once and is a
# no-op on an image that has it, retries a store that can't be reached, and
# fails the bake when the store stays down or the snap leaves no binary. And
# both bakes call it: setup.sh (the full bake, with no `|| true` left) and
# refresh-box.sh (the incremental one, which skips setup.sh), while the
# minimal image keeps it out.
#
# Hermetic: snap and sudo are scripts on PATH, the binary is a temp path, and
# nothing waits (CHROMIUM_INSTALL_WAIT=0).

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB=$HERE/box-lib.sh

fails=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; fails=$((fails + 1)); }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# The stand-in store: `snap list chromium` succeeds once installed; `snap
# install chromium` fails while $STORE/down-for holds a count above zero
# (counting it down), and otherwise installs, making $STORE/bin/chromium
# unless $STORE/no-binary exists. Every install is logged to $STORE/installs.
mkdir -p "$TMP/path"
cat > "$TMP/path/snap" <<'SNAP'
#!/bin/sh
case "$1 $2" in
  "list chromium") [ -e "$STORE/installed" ] ;;
  "install chromium")
    echo install >> "$STORE/installs"
    left=$(cat "$STORE/down-for" 2>/dev/null || echo 0)
    if [ "$left" -gt 0 ]; then
      echo $((left - 1)) > "$STORE/down-for"
      echo "error: unable to contact snap store" >&2
      exit 1
    fi
    : > "$STORE/installed"
    [ -e "$STORE/no-binary" ] || { mkdir -p "$STORE/bin"; printf '#!/bin/sh\n' > "$STORE/bin/chromium"; chmod +x "$STORE/bin/chromium"; }
    echo "chromium 157.0.8103.38 from Canonical** installed" ;;
  *) echo "unexpected: snap $*" >&2; exit 2 ;;
esac
SNAP
printf '#!/bin/sh\nexec "$@"\n' > "$TMP/path/sudo"
chmod +x "$TMP/path/snap" "$TMP/path/sudo"

# run_install NAME: install_chromium against a fresh store, whose dir is set
# up by the caller through $STORE before the call. Prints the exit code.
run_install() {
    STORE=$TMP/$1 PATH="$TMP/path:$PATH" CHROMIUM_BIN="$TMP/$1/bin/chromium" \
        CHROMIUM_INSTALL_TRIES=3 CHROMIUM_INSTALL_WAIT=0 \
        bash -c '. "$0"; install_chromium "[test]"' "$LIB" > "$TMP/$1.out" 2>&1 && echo 0 || echo $?
}
installs() { [ -e "$TMP/$1/installs" ] && wc -l < "$TMP/$1/installs" | tr -d ' ' || echo 0; }

# A fresh image: one install.
mkdir -p "$TMP/fresh"
code=$(run_install fresh)
if [ "$code" = 0 ] && [ "$(installs fresh)" = 1 ] && [ -x "$TMP/fresh/bin/chromium" ]; then
    pass "a fresh image gets Chromium in one install"
else
    fail "fresh image: exit $code, $(installs fresh) installs: $(cat "$TMP/fresh.out")"
fi

# An image that has it (an incremental bake's source): nothing to do.
code=$(run_install fresh)
if [ "$code" = 0 ] && [ "$(installs fresh)" = 1 ] && grep -q 'chromium is installed' "$TMP/fresh.out"; then
    pass "an image that has Chromium is left alone"
else
    fail "installed image: exit $code, $(installs fresh) installs: $(cat "$TMP/fresh.out")"
fi

# The store is out for two tries, then answers.
mkdir -p "$TMP/flaky"; echo 2 > "$TMP/flaky/down-for"
code=$(run_install flaky)
if [ "$code" = 0 ] && [ "$(installs flaky)" = 3 ] && grep -q 'try 2 of 3' "$TMP/flaky.out"; then
    pass "a store that can't be reached is retried until it answers"
else
    fail "flaky store: exit $code, $(installs flaky) installs: $(cat "$TMP/flaky.out")"
fi

# The store stays down (2026-11-11): the bake fails, where `|| true` published.
mkdir -p "$TMP/down"; echo 99 > "$TMP/down/down-for"
code=$(run_install down)
if [ "$code" != 0 ] && [ "$(installs down)" = 3 ] && grep -q 'failed 3 times; failing the bake' "$TMP/down.out"; then
    pass "a store that stays down fails the bake"
else
    fail "store down: exit $code, $(installs down) installs: $(cat "$TMP/down.out")"
fi

# The snap installs but leaves no binary where the agent looks.
mkdir -p "$TMP/nobin"; : > "$TMP/nobin/no-binary"
code=$(run_install nobin)
if [ "$code" != 0 ] && grep -q 'is missing; failing the bake' "$TMP/nobin.out"; then
    pass "a snap with no /snap/bin/chromium fails the bake"
else
    fail "no binary: exit $code: $(cat "$TMP/nobin.out")"
fi

# Wiring: both bakes call it, nothing swallows a failed install, and the
# minimal image (packer/scripts/box-min.test.sh keeps Chromium out) doesn't.
if grep -qx 'install_chromium' "$HERE/setup.sh" && ! grep -q 'snap install chromium' "$HERE/setup.sh"; then
    pass "the full bake installs Chromium through install_chromium"
else
    fail "setup.sh must call install_chromium and run no snap install chromium of its own"
fi
if grep -qx 'install_chromium "\[packer/refresh\]"' "$HERE/refresh-box.sh"; then
    pass "the incremental bake checks its source image for Chromium"
else
    fail "refresh-box.sh must call install_chromium \"[packer/refresh]\""
fi
if ! grep -q 'install_chromium' "$HERE/box-min-setup.sh"; then
    pass "the minimal image doesn't install Chromium"
else
    fail "box-min-setup.sh calls install_chromium; the minimal image leaves Chromium out"
fi

[ "$fails" = 0 ] || { echo "$fails failure(s)" >&2; exit 1; }
echo "all passed"
