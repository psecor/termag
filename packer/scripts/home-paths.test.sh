#!/bin/sh
# Tests the two halves of the first-boot path rewrite together:
#   packer/scripts/index-home-paths.sh    bake: records what to rewrite
#   packer/scripts/rewrite-home-paths.sh  boot: rewrites exactly that
# on a fixture home, through the step-2 rename (a plain mv). Then checks
# that the cloud-init templates call the boot half and that box.pkr.hcl ships
# both and runs the index last.
#
# Hermetic: no sudo, no packer, no AWS. Needs GNU find/grep/sed (the box is
# Ubuntu; so is CI).

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
INDEX=$HERE/index-home-paths.sh
REWRITE=$HERE/rewrite-home-paths.sh
PKR=$HERE/../box.pkr.hcl
TFTPL=$HERE/../../terraform/box/cloudinit.sh.tftpl

fails=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; fails=$((fails + 1)); }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

OLD=$TMP/home/termag
NEW=$TMP/home/alice
IDX=$TMP/index
SBIN=$TMP/sbin/termag-rewrite-home-paths

count_nul() { tr -cd '\000' < "$1" | wc -c | tr -d ' '; }

# ── fixture: the shapes a baked home contains ────────────────────────────────
mkdir -p "$OLD/.local/bin" "$OLD/.local/share/tool/bin" "$OLD/.nvm/versions/node/v24/bin" \
         "$OLD/.cargo/bin" "$OLD/.config/app" "$OLD/bin" "$OLD/.cache/thing"
touch "$OLD/.local/share/tool/bin/tool" "$OLD/.nvm/versions/node/v24/bin/node"

# Text files in scanned dirs that embed the home path: rewritten.
printf '#!/usr/bin/env bash\nexec "%s/.local/share/tool/bin/tool" "$@"\n' "$OLD" > "$OLD/.local/bin/tool-wrapper"
chmod 755 "$OLD/.local/bin/tool-wrapper"
printf 'root = "%s/.config/app"\n' "$OLD" > "$OLD/.config/app/settings.toml"
printf 'HOME=%s\n' "$OLD" > "$OLD/.local/bin/with space.sh"
# A binary in a scanned dir that embeds the path: grep -I skips it, so it is
# not indexed and not rewritten (ldconfig handles the one case that matters).
printf 'ELF\000\000%s\000' "$OLD" > "$OLD/.cargo/bin/binary"
# A text file outside the scanned dirs: out of scope, exactly as before.
printf 'export P=%s/bin\n' "$OLD" > "$OLD/.zshrc"
# A text file in a scanned dir with no reference: not indexed.
printf 'nothing to see\n' > "$OLD/.local/bin/plain"

# Absolute symlinks into the home, anywhere under it: rewritten.
ln -s "$OLD/.local/share/tool/bin/tool" "$OLD/.local/bin/tool"
ln -s "$OLD/.nvm/versions/node/v24/bin/node" "$OLD/bin/node"
ln -s "$OLD/.cache/thing" "$OLD/.config/app/cache-dir"
# A relative symlink and an absolute one elsewhere: left alone.
ln -s ../share/tool/bin/tool "$OLD/.local/bin/tool-rel"
ln -s /usr/bin/env "$OLD/.local/bin/env"

# ── bake half ────────────────────────────────────────────────────────────────
if SUDO='' HOME_DIR="$OLD" INDEX_DIR="$IDX" REWRITE_SRC="$REWRITE" REWRITE_DEST="$SBIN" \
     bash "$INDEX" > "$TMP/index.log" 2>&1; then
    pass "index-home-paths.sh ran"
else
    fail "index-home-paths.sh failed: $(cat "$TMP/index.log")"
fi

if [ "$(count_nul "$IDX/symlinks")" = 3 ]; then
    pass "index records the 3 absolute symlinks into the home, not the relative or foreign ones"
else
    fail "expected 3 symlinks in the index, got $(count_nul "$IDX/symlinks"): $(tr '\000' ' ' < "$IDX/symlinks")"
fi
if [ "$(count_nul "$IDX/files")" = 3 ]; then
    pass "index records the 3 text files in scanned dirs, not the binary, .zshrc, or the plain file"
else
    fail "expected 3 files in the index, got $(count_nul "$IDX/files"): $(tr '\000' ' ' < "$IDX/files")"
fi
if grep -qzx '.local/bin/tool' "$IDX/symlinks" && grep -qzx '.local/bin/with space.sh' "$IDX/files"; then
    pass "index entries are relative to the home, NUL-separated"
else
    fail "index entries are not the relative paths expected: $(tr '\000' ' ' < "$IDX/symlinks") / $(tr '\000' ' ' < "$IDX/files")"
fi
if grep -q '^symlinks=3$' "$IDX/meta" && grep -q '^files=3$' "$IDX/meta" && grep -q "^home=$OLD\$" "$IDX/meta"; then
    pass "meta records the home and the counts"
else
    fail "meta is off: $(tr '\n' ' ' < "$IDX/meta")"
fi
if [ -x "$SBIN" ]; then
    pass "index step installs the rewrite script"
else
    fail "rewrite script was not installed at $SBIN"
fi

# ── boot half: rename, then rewrite ──────────────────────────────────────────
mv "$OLD" "$NEW"
if INDEX_DIR="$IDX" "$SBIN" "$OLD" "$NEW" > "$TMP/rewrite.log" 2>&1; then
    pass "rewrite ran after the rename"
else
    fail "rewrite failed: $(cat "$TMP/rewrite.log")"
fi
if grep -q 'rewrote 3 symlink target(s) and 3 text file(s)' "$TMP/rewrite.log"; then
    pass "rewrite reports what it touched"
else
    fail "unexpected rewrite summary: $(cat "$TMP/rewrite.log")"
fi

if [ "$(readlink "$NEW/.local/bin/tool")" = "$NEW/.local/share/tool/bin/tool" ] \
   && [ "$(readlink "$NEW/bin/node")" = "$NEW/.nvm/versions/node/v24/bin/node" ]; then
    pass "absolute symlink targets follow the home"
else
    fail "symlink targets not rewritten: $(readlink "$NEW/.local/bin/tool") / $(readlink "$NEW/bin/node")"
fi
if [ "$(readlink "$NEW/.config/app/cache-dir")" = "$NEW/.cache/thing" ] && [ -d "$NEW/.config/app/cache-dir/" ]; then
    pass "a symlink to a directory is replaced, not written into"
else
    fail "directory symlink mishandled: $(readlink "$NEW/.config/app/cache-dir")"
fi
if [ "$(readlink "$NEW/.local/bin/tool-rel")" = ../share/tool/bin/tool ] && [ "$(readlink "$NEW/.local/bin/env")" = /usr/bin/env ]; then
    pass "relative and foreign symlinks are left alone"
else
    fail "unrelated symlinks were touched"
fi

if grep -qF "exec \"$NEW/.local/share/tool/bin/tool\"" "$NEW/.local/bin/tool-wrapper" \
   && ! grep -qF "$OLD" "$NEW/.local/bin/tool-wrapper" \
   && grep -qF "root = \"$NEW/.config/app\"" "$NEW/.config/app/settings.toml" \
   && grep -qF "HOME=$NEW" "$NEW/.local/bin/with space.sh"; then
    pass "text files carry the new home, including a name with a space"
else
    fail "text files not rewritten: $(cat "$NEW/.local/bin/tool-wrapper" "$NEW/.config/app/settings.toml" "$NEW/.local/bin/with space.sh")"
fi
if [ -x "$NEW/.local/bin/tool-wrapper" ]; then
    pass "rewriting keeps the executable bit"
else
    fail "tool-wrapper lost its executable bit"
fi
if grep -qaF "$OLD" "$NEW/.cargo/bin/binary"; then
    pass "binaries are not rewritten"
else
    fail "the binary was modified"
fi
if grep -qF "$OLD" "$NEW/.zshrc"; then
    pass "files outside the scanned dirs are out of scope, as before"
else
    fail ".zshrc was rewritten although it is outside SCAN_DIRS"
fi

if INDEX_DIR="$IDX" "$SBIN" "$OLD" "$NEW" > "$TMP/rewrite2.log" 2>&1 \
   && grep -q 'rewrote 0 symlink target(s) and 0 text file(s)' "$TMP/rewrite2.log"; then
    pass "a second run is a no-op"
else
    fail "second run was not a no-op: $(cat "$TMP/rewrite2.log")"
fi

rc=0
INDEX_DIR="$TMP/nowhere" "$SBIN" "$OLD" "$NEW" > "$TMP/noidx.log" 2>&1 || rc=$?
if [ "$rc" = 2 ] && grep -q '^WARNING: no home-path index' "$TMP/noidx.log"; then
    pass "a missing index exits 2 with a WARNING instead of failing silently"
else
    fail "missing index: exit $rc, output: $(cat "$TMP/noidx.log")"
fi
rc=0
"$SBIN" > /dev/null 2>&1 || rc=$?
if [ "$rc" = 64 ]; then
    pass "usage error exits 64"
else
    fail "usage error exited $rc"
fi

# ── bake as an account that cannot enter the home ────────────────────────────
# The bake runs the index as `ubuntu`, and /home/termag is 0750 termag:termag:
# only $SUDO can look inside. Images from 2026-09-25 to 2026-11-04 were baked
# with files=0 because the scan dirs were tested without it, so every uv
# tool's shebang kept /home/termag. Simulate that: the home is mode 000, and
# the SUDO stand-in opens it for the one command it runs.
GOLD=$TMP/gated/termag
GNEW=$TMP/gated/bob
GIDX=$TMP/gated-index
mkdir -p "$GOLD/.local/share/uv/tools/poetry/bin" "$GOLD/.local/bin"
printf '#!%s/.local/share/uv/tools/poetry/bin/python\nimport poetry\n' "$GOLD" > "$GOLD/.local/share/uv/tools/poetry/bin/poetry"
printf 'home = %s/.local/share/uv/python/cpython-3.13/bin\n' "$GOLD" > "$GOLD/.local/share/uv/tools/poetry/pyvenv.cfg"
ln -s "$GOLD/.local/share/uv/tools/poetry/bin/poetry" "$GOLD/.local/bin/poetry"
cat > "$TMP/gate-sudo" <<'GATE'
#!/bin/sh
chmod 700 "$GATED_HOME"
"$@"
rc=$?
chmod 000 "$GATED_HOME"
exit $rc
GATE
chmod 755 "$TMP/gate-sudo"
chmod 000 "$GOLD"
if GATED_HOME="$GOLD" SUDO="$TMP/gate-sudo" HOME_DIR="$GOLD" INDEX_DIR="$GIDX" REWRITE_SRC='' \
     bash "$INDEX" > "$TMP/gated.log" 2>&1; then
    pass "index-home-paths.sh ran on a home only SUDO can enter"
else
    fail "index-home-paths.sh failed on a gated home: $(cat "$TMP/gated.log")"
fi
chmod 755 "$GOLD"
if [ "$(count_nul "$GIDX/files")" = 2 ] && grep -qzx '.local/share/uv/tools/poetry/bin/poetry' "$GIDX/files" \
   && grep -qzx '.local/share/uv/tools/poetry/pyvenv.cfg' "$GIDX/files"; then
    pass "the text-file scan reaches a home only SUDO can enter (uv tool entry point, pyvenv.cfg)"
else
    fail "expected the uv tool's entry point and pyvenv.cfg in the index, got $(count_nul "$GIDX/files"): $(tr '\000' ' ' < "$GIDX/files")"
fi
mv "$GOLD" "$GNEW"
INDEX_DIR="$GIDX" "$SBIN" "$GOLD" "$GNEW" > /dev/null 2>&1 || true
if [ "$(head -1 "$GNEW/.local/share/uv/tools/poetry/bin/poetry")" = "#!$GNEW/.local/share/uv/tools/poetry/bin/python" ] \
   && grep -qxF "home = $GNEW/.local/share/uv/python/cpython-3.13/bin" "$GNEW/.local/share/uv/tools/poetry/pyvenv.cfg"; then
    pass "after the rename the uv tool's shebang and pyvenv.cfg name the new home"
else
    fail "uv tool not rewritten: $(head -1 "$GNEW/.local/share/uv/tools/poetry/bin/poetry") / $(cat "$GNEW/.local/share/uv/tools/poetry/pyvenv.cfg")"
fi

# ── an excluded dir is left out ────────────────────────────────────────────
# A bake may leave a dev stack's database stores under the home, here
# ~/.local/share/webapp, listed in EXCLUDE_DIRS: nothing there may be
# rewritten, so neither walk enters it. It is
# excluded by full path: a dir merely named webapp elsewhere, or one whose
# name only starts with it, is still scanned. A FIFO in a scanned dir must
# not block the walk.
XOLD=$TMP/xhome/termag
XIDX=$TMP/xindex
mkdir -p "$XOLD/.local/share/webapp/stack-bake/data/cockroachdb" "$XOLD/.local/share/webapp-tools" \
         "$XOLD/.config/webapp" "$XOLD/.local/share/tool"
printf 'checkout=%s/src/webapp\n' "$XOLD" > "$XOLD/.local/share/webapp/stack-bake/bake.json"
printf 'store at %s/.local/share/webapp\n' "$XOLD" > "$XOLD/.local/share/webapp/stack-bake/data/cockroachdb/000011.log"
ln -s "$XOLD/.local/share/tool" "$XOLD/.local/share/webapp/stack-bake/link"
printf 'root = "%s"\n' "$XOLD" > "$XOLD/.local/share/webapp-tools/conf"
printf 'root = "%s"\n' "$XOLD" > "$XOLD/.config/webapp/settings"
printf 'exec %s/bin/x\n' "$XOLD" > "$XOLD/.local/share/tool/run"
ln -s "$XOLD/.local/share/tool/run" "$XOLD/.local/share/tool/run-link"
mkfifo "$XOLD/.local/share/tool/fifo"
if SUDO='' HOME_DIR="$XOLD" INDEX_DIR="$XIDX" REWRITE_SRC='' EXCLUDE_DIRS=.local/share/webapp timeout 60 bash "$INDEX" > "$TMP/xindex.log" 2>&1; then
    pass "index-home-paths.sh ran on a home with baked stack data and a FIFO"
else
    fail "index-home-paths.sh failed or hung on a home with baked stack data: $(cat "$TMP/xindex.log")"
fi
if tr '\000' '\n' < "$XIDX/files" 2>/dev/null | grep -q '^\.local/share/webapp/' \
   || tr '\000' '\n' < "$XIDX/symlinks" 2>/dev/null | grep -q '^\.local/share/webapp/'; then
    fail "the dev stack's data root was indexed: $(tr '\000' ' ' < "$XIDX/files") / $(tr '\000' ' ' < "$XIDX/symlinks")"
else
    pass "nothing under .local/share/webapp is indexed, though its files embed the home path"
fi
if grep -qzx '.local/share/webapp-tools/conf' "$XIDX/files" && grep -qzx '.config/webapp/settings' "$XIDX/files" \
   && grep -qzx '.local/share/tool/run' "$XIDX/files" && grep -qzx '.local/share/tool/run-link' "$XIDX/symlinks"; then
    pass "the exclusion is by full path: webapp-tools, .config/webapp and the rest are still indexed"
else
    fail "the exclusion over-matched: $(tr '\000' ' ' < "$XIDX/files") / $(tr '\000' ' ' < "$XIDX/symlinks")"
fi
if [ "$(count_nul "$XIDX/files")" = 3 ] && [ "$(count_nul "$XIDX/symlinks")" = 1 ] \
   && grep -q '^exclude_dirs=.local/share/webapp$' "$XIDX/meta"; then
    pass "exactly 3 files and 1 symlink indexed, and meta records the exclusion"
else
    fail "expected 3 files and 1 symlink with exclude_dirs in meta: $(tr '\n' ' ' < "$XIDX/meta" 2>/dev/null)"
fi

# ── the callers ──────────────────────────────────────────────────────────────
CALL='termag-rewrite-home-paths /home/termag "/home/$UNIX_USER"'
if grep -qF "$CALL" "$TFTPL" && ! grep -q 'grep -rIl' "$TFTPL" && ! grep -q "find \"/home/\$UNIX_USER\" -type l" "$TFTPL"; then
    pass "cloudinit.sh.tftpl calls the rewrite and no longer walks the home"
else
    fail "cloudinit.sh.tftpl does not call '$CALL', or still walks the home"
fi
if grep -q 'scripts/rewrite-home-paths.sh' "$PKR" && grep -q 'scripts/index-home-paths.sh' "$PKR"; then
    pass "box.pkr.hcl ships both halves"
else
    fail "box.pkr.hcl does not ship both scripts"
fi
last_prov=$(grep -n 'provisioner "' "$PKR" | tail -1 | cut -d: -f1)
index_line=$(grep -n 'scripts/index-home-paths.sh' "$PKR" | head -1 | cut -d: -f1)
if [ -n "$index_line" ] && [ "$index_line" -gt "$last_prov" ]; then
    pass "the index step is the last provisioner, so nothing baked after it is missed"
else
    fail "index-home-paths.sh (line $index_line) is not in the last provisioner (line $last_prov)"
fi

if [ "$fails" -eq 0 ]; then
    echo "all checks passed"
else
    echo "$fails check(s) failed" >&2
    exit 1
fi
