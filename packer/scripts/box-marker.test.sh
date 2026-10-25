#!/bin/sh
# install_box_marker (box-lib.sh), run for real against a scratch /etc: the
# TERMAG_BOX marker and the ~/.local/bin PATH line land in /etc/zsh/zshenv once
# each, an image that already has only the marker gets the PATH line, and a
# non-interactive shell that reads the file finds a command in ~/.local/bin.
# Hermetic: sudo is a function that maps /etc/ to the scratch dir.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB=$HERE/box-lib.sh

fails=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; fails=$((fails + 1)); }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# run_marker ROOT: install_box_marker with /etc/ rewritten to ROOT/etc/.
run_marker() {
    mkdir -p "$1/etc/profile.d" "$1/etc/zsh"
    FAKE_ROOT=$1 bash -c '
        set -eu
        sudo() { local a args=(); for a in "$@"; do args+=("${a//\/etc\//$FAKE_ROOT/etc/}"); done; "${args[@]}"; }
        . "$0"
        install_box_marker
    ' "$LIB"
}
count() { grep -cxF "$1" "$2" || true; }

line=$(bash -c '. "$0"; printf %s "$ZSHENV_LOCAL_BIN"' "$LIB")

# A fresh image, baked twice.
R=$TMP/fresh
run_marker "$R"
run_marker "$R"
if [ "$(count 'export TERMAG_BOX=1' "$R/etc/zsh/zshenv")" = 1 ] && [ "$(count "$line" "$R/etc/zsh/zshenv")" = 1 ]; then
    pass "zshenv carries the marker and the ~/.local/bin line once each after two bakes"
else
    fail "zshenv after two bakes: $(cat "$R/etc/zsh/zshenv")"
fi
if [ "$(cat "$R/etc/profile.d/termag-box.sh")" = 'export TERMAG_BOX=1' ]; then
    pass "profile.d still gets only the marker"
else
    fail "profile.d/termag-box.sh: $(cat "$R/etc/profile.d/termag-box.sh")"
fi

# An image refreshed from a source that already had the marker but not the PATH line.
R=$TMP/older
mkdir -p "$R/etc/zsh"
printf '# package guard\n\n# termag box marker (packer/scripts/box-lib.sh, install_box_marker)\nexport TERMAG_BOX=1\n' > "$R/etc/zsh/zshenv"
run_marker "$R"
if [ "$(count 'export TERMAG_BOX=1' "$R/etc/zsh/zshenv")" = 1 ] && [ "$(count "$line" "$R/etc/zsh/zshenv")" = 1 ] \
   && head -1 "$R/etc/zsh/zshenv" | grep -qxF '# package guard'; then
    pass "an older image's zshenv gains the ~/.local/bin line and keeps what it had"
else
    fail "older image zshenv: $(cat "$R/etc/zsh/zshenv")"
fi

# What a non-interactive shell sees after reading the file.
ZSHENV=$TMP/fresh/etc/zsh/zshenv
H=$TMP/home
mkdir -p "$H/.local/bin"
printf '#!/bin/sh\necho launcher\n' > "$H/.local/bin/termag"
chmod 755 "$H/.local/bin/termag"
for sh in sh zsh; do
    command -v "$sh" >/dev/null 2>&1 || { echo "SKIP: $sh not installed"; continue; }
    flag=; [ "$sh" = zsh ] && flag=-f
    got=$(env -i HOME="$H" PATH=/usr/bin:/bin "$sh" $flag -c '. "$1"; termag' _ "$ZSHENV" 2>&1 || true)
    if [ "$got" = launcher ]; then
        pass "$sh -c finds ~/.local/bin/termag after reading zshenv"
    else
        fail "$sh -c did not find ~/.local/bin/termag: $got"
    fi
    got=$(env -i HOME="$H" PATH=/usr/bin:/bin "$sh" $flag -c '. "$1"; . "$1"; printf %s "$PATH"' _ "$ZSHENV")
    if [ "$got" = "$H/.local/bin:/usr/bin:/bin" ]; then
        pass "$sh: reading zshenv twice adds ~/.local/bin once"
    else
        fail "$sh: PATH after reading zshenv twice: $got"
    fi
    got=$(env -i HOME="$TMP/no-local-bin" PATH=/usr/bin:/bin "$sh" $flag -c '. "$1"; echo "$?:$PATH"' _ "$ZSHENV")
    if [ "$got" = "0:/usr/bin:/bin" ]; then
        pass "$sh: without ~/.local/bin, PATH is unchanged and zshenv ends with status 0"
    else
        fail "$sh: without ~/.local/bin: $got"
    fi
done

if [ "$fails" -eq 0 ]; then
    echo "all checks passed"
else
    echo "$fails check(s) failed" >&2
    exit 1
fi
