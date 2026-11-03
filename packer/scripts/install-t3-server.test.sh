#!/bin/sh
# Tests the box bake's t3 server steps: scripts/stage-t3-server.sh (on the
# packer host) and where box.pkr.hcl runs them. The install itself is
# deploy/termag-t3-install, covered by deploy/termag-t3-install.test.sh.
#
#   * the stage step always leaves a file to upload: the given tarball, or an
#     empty file when there is none
#   * it refuses a missing tarball and anything not named like a linux-arm64
#     termag-t3-server tarball (box images are arm64)
#   * box.pkr.hcl uploads after setup.sh and refresh-box.sh (both wipe /tmp),
#     installs right after, and stays ahead of the home-path index
#
# Run: sh packer/scripts/install-t3-server.test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
PKR="$DIR/../box.pkr.hcl"
STAGE_SCRIPT="$DIR/stage-t3-server.sh"
WORK="$(mktemp -d)"
failed=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1"; failed=$((failed + 1)); }

# ── stage-t3-server.sh ──────────────────────────────────────────────────────
STAGE="$WORK/t3-server.tar.gz"
if STAGE="$STAGE" ARTIFACT='' bash "$STAGE_SCRIPT" >/dev/null && [ -f "$STAGE" ] && [ ! -s "$STAGE" ]; then
    pass "no artifact: an empty file to upload"
else
    fail "no artifact should stage an empty file"
fi

good="$WORK/termag-t3-server-0.1.1-abcdefabcdef-linux-arm64.tar.gz"
printf 'tarball' > "$good"
if STAGE="$STAGE" ARTIFACT="$good" bash "$STAGE_SCRIPT" >/dev/null && cmp -s "$good" "$STAGE"; then
    pass "an artifact is staged as given"
else
    fail "an artifact should be copied to STAGE"
fi

if STAGE="$STAGE" ARTIFACT="$WORK/missing.tar.gz" bash "$STAGE_SCRIPT" >/dev/null 2>&1; then
    fail "a missing artifact should fail the bake"
else
    pass "a missing artifact fails"
fi

x64="$WORK/termag-t3-server-0.1.1-abcdefabcdef-linux-x64.tar.gz"
printf 'tarball' > "$x64"
if STAGE="$STAGE" ARTIFACT="$x64" bash "$STAGE_SCRIPT" >/dev/null 2>&1; then
    fail "an x64 artifact should be refused for the arm64 image"
else
    pass "an x64 artifact is refused"
fi

# ── box.pkr.hcl wiring ──────────────────────────────────────────────────────
line_of() { grep -n "$1" "$PKR" | head -1 | cut -d: -f1; }
setup_line=$(line_of 'scripts/setup.sh"')
refresh_line=$(line_of 'scripts/refresh-box.sh"')
stage_line=$(line_of 'scripts/stage-t3-server.sh')
upload_line=$(line_of 'destination = "/tmp/t3-server.tar.gz"')
install_line=$(line_of 'scripts/install-t3-server.sh')
index_line=$(line_of 'scripts/index-home-paths.sh')
if [ -n "$setup_line" ] && [ -n "$refresh_line" ] && [ -n "$stage_line" ] && [ -n "$upload_line" ] &&
   [ -n "$install_line" ] && [ -n "$index_line" ]; then
    pass "box.pkr.hcl has every step"
else
    fail "box.pkr.hcl is missing a step (setup=$setup_line refresh=$refresh_line stage=$stage_line upload=$upload_line install=$install_line index=$index_line)"
fi
if [ "${upload_line:-0}" -gt "${setup_line:-0}" ] && [ "${upload_line:-0}" -gt "${refresh_line:-0}" ]; then
    pass "the tarball is uploaded after setup.sh and refresh-box.sh, which wipe /tmp"
else
    fail "the t3 server upload must come after setup.sh and refresh-box.sh"
fi
if [ "${stage_line:-0}" -lt "${upload_line:-0}" ] && [ "${upload_line:-0}" -lt "${install_line:-0}" ]; then
    pass "staged, uploaded, then installed"
else
    fail "stage-t3-server.sh, the upload and install-t3-server.sh are out of order"
fi
if [ "${install_line:-0}" -lt "${index_line:-0}" ]; then
    pass "installed before the home-path index"
else
    fail "install-t3-server.sh must run before index-home-paths.sh"
fi
if grep -q 'ARTIFACT=${var.t3_server_artifact}' "$PKR"; then
    pass "the stage step follows var.t3_server_artifact"
else
    fail "ARTIFACT is not passed from var.t3_server_artifact"
fi

case "$WORK" in
    /tmp/* | /var/folders/* | /private/var/folders/*) rm -rf -- "$WORK" ;;
esac

if [ "$failed" -gt 0 ]; then
    echo "$failed check(s) failed"
    exit 1
fi
echo "all install-t3-server checks passed"
