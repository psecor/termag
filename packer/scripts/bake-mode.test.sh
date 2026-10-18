#!/bin/sh
# Checks for the incremental bake and the scratch volume: box.pkr.hcl, the
# scratch and refresh scripts, and setup.sh's mode gate and pins. Hermetic: no
# AWS, no packer, no sudo.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PKR=$HERE/../box.pkr.hcl
SETUP=$HERE/setup.sh
REFRESH=$HERE/refresh-box.sh
PREPARE=$HERE/prepare-scratch.sh
DETACH=$HERE/detach-scratch.sh
LIB=$HERE/box-lib.sh

fails=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; fails=$((fails + 1)); }
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
prov_line() { grep -n -F "/scripts/$1\"" "$PKR" | head -1 | cut -d: -f1; }

if grep -q 'dynamic "source_ami_filter"' "$PKR" \
   && grep -q 'for_each = var.bake_mode == "full"' "$PKR"; then
    pass "the Ubuntu source_ami_filter is only in effect for a full bake"
else
    fail "box.pkr.hcl: source_ami_filter is not a dynamic block gated on bake_mode == full"
fi
if grep -q 'source_ami = var.bake_mode == "incremental" ? var.source_ami : ""' "$PKR"; then
    pass "source_ami is only set for an incremental bake"
else
    fail "box.pkr.hcl: source_ami is not gated on bake_mode == incremental"
fi

scratch_block=$(awk '
    /^  launch_block_device_mappings/ { blk = ""; inblk = 1 }
    inblk { blk = blk "\n" $0 }
    inblk && /^  }/ { inblk = 0; if (blk ~ /scratch_volume_size/) print blk }
' "$PKR")
scratch_dev=$(printf '%s\n' "$scratch_block" | grep -oE 'device_name *= *"[^"]+"' | grep -oE '"[^"]+"' | tr -d '"')
if [ -n "$scratch_dev" ]; then
    pass "the scratch volume is a launch block device ($scratch_dev)"
else
    fail "box.pkr.hcl: no launch_block_device_mappings block sized by scratch_volume_size"
fi
ami_block=$(awk -v dev="$scratch_dev" '
    /^  ami_block_device_mappings/ { blk = ""; inblk = 1 }
    inblk { blk = blk "\n" $0 }
    inblk && /^  }/ { inblk = 0; if (index(blk, "\"" dev "\"")) print blk }
' "$PKR")
if [ -n "$ami_block" ] && printf '%s\n' "$ami_block" | grep -q 'no_device *= *true'; then
    pass "the AMI excludes the scratch device ($scratch_dev has no_device = true)"
else
    fail "box.pkr.hcl: no ami_block_device_mappings block with device_name $scratch_dev and no_device = true; the scratch volume would be snapshotted into the AMI"
fi
if printf '%s\n' "$scratch_block" | grep -q 'delete_on_termination *= *true'; then
    pass "the scratch volume dies with the builder"
else
    fail "box.pkr.hcl: the scratch mapping is not delete_on_termination"
fi

prepare_l=$(prov_line prepare-scratch.sh)
lib_l=$(prov_line box-lib.sh)
refresh_l=$(prov_line refresh-box.sh)
setup_l=$(prov_line setup.sh)
detach_l=$(prov_line detach-scratch.sh)
index_l=$(prov_line index-home-paths.sh)
for v in prepare_l lib_l refresh_l setup_l detach_l index_l; do
    eval "val=\$$v"
    [ -n "$val" ] || fail "box.pkr.hcl does not ship the script for $v"
done
if [ -n "$prepare_l" ] && [ -n "$refresh_l" ] && [ "$prepare_l" -lt "$refresh_l" ]; then
    pass "the scratch volume is prepared before the first bake step"
else
    fail "prepare-scratch.sh (line $prepare_l) must run before refresh-box.sh (line $refresh_l)"
fi
if [ -n "$refresh_l" ] && [ -n "$setup_l" ] && [ "$refresh_l" -lt "$setup_l" ]; then
    pass "refresh-box.sh runs before setup.sh"
else
    fail "refresh-box.sh (line $refresh_l) must run before setup.sh (line $setup_l)"
fi
if [ -n "$setup_l" ] && [ -n "$detach_l" ] && [ -n "$index_l" ] \
   && [ "$setup_l" -lt "$detach_l" ] && [ "$detach_l" -lt "$index_l" ]; then
    pass "the scratch volume is detached after setup.sh and before the home-path index"
else
    fail "detach-scratch.sh (line $detach_l) must run after setup.sh (line $setup_l) and before index-home-paths.sh (line $index_l)"
fi

n_mode=$(grep -c '"BAKE_MODE=${var.bake_mode}"' "$PKR" || true)
if [ "$n_mode" -ge 2 ]; then
    pass "the template hands bake_mode to the provisioners (BAKE_MODE set $n_mode times)"
else
    fail "box.pkr.hcl passes BAKE_MODE to $n_mode provisioner(s); refresh-box.sh and setup.sh both need it"
fi
for tag in BakeMode BaseTermagSha BaseBakedAt SourceAmi; do
    if grep -q "^    $tag *=" "$PKR"; then
        pass "the image is tagged $tag"
    else
        fail "box.pkr.hcl does not tag the image with $tag"
    fi
done

if grep -q '"${BAKE_MODE:-full}" = incremental' "$SETUP" && grep -q '^    exit 0$' "$SETUP"; then
    pass "setup.sh exits at once on an incremental bake"
else
    fail "setup.sh does not gate on BAKE_MODE=incremental"
fi
if grep -q '"$BAKE_MODE" != incremental' "$REFRESH"; then
    pass "refresh-box.sh is a no-op unless the bake is incremental"
else
    fail "refresh-box.sh does not gate on BAKE_MODE"
fi

dests=$(grep -oE 'destination *= *"/tmp/[^"]+"' "$PKR" | grep -oE '/tmp/[^"]+' | grep -v -E 'rewrite-home-paths|box-lib|termag.bundle' | sort -u)
missing=""
for d in $dests; do
    grep -qF -- "$d" "$LIB" || missing="$missing $d"
done
if [ -z "$missing" ]; then
    pass "box-lib.sh installs every shipped deploy/ file: $(printf '%s ' $dests)"
else
    fail "box-lib.sh does not install:$missing"
fi
for f in "$SETUP" "$REFRESH"; do
    if grep -q '^\. /var/lib/termag-bake/box-lib.sh$' "$f" && grep -q '^install_deploy_artifacts$' "$f"; then
        pass "$(basename "$f") installs the deploy/ artifacts through box-lib.sh"
    else
        fail "$(basename "$f") does not source box-lib.sh and call install_deploy_artifacts"
    fi
done
# setup.sh and refresh-box.sh wipe /tmp at their end, so the library is copied
# out of /tmp by an inline step right after it ships, and sourced from there.
if grep -q '"sudo install -m 644 /tmp/box-lib.sh /var/lib/termag-bake/box-lib.sh"' "$PKR" \
   && ! grep -q '^\. /tmp/box-lib.sh$' "$SETUP" "$REFRESH"; then
    pass "box-lib.sh is copied out of /tmp before anything can wipe it, and nothing sources the /tmp copy"
else
    fail "box.pkr.hcl does not install box-lib.sh to /var/lib/termag-bake, or a script sources /tmp/box-lib.sh (wiped by setup.sh/refresh-box.sh)"
fi
if [ -n "$lib_l" ] && [ -n "$refresh_l" ] && [ "$lib_l" -lt "$refresh_l" ]; then
    pass "box-lib.sh is shipped before the first script that sources it"
else
    fail "box-lib.sh (line $lib_l) must be shipped before refresh-box.sh (line $refresh_l)"
fi

for f in "$PREPARE" "$DETACH"; do
    if grep -q '^MARKER=/var/lib/termag-bake/scratch$\|^MARKER=\$MARKER_DIR/scratch$' "$f" \
       && grep -q '^BAZELRC=/etc/bazel.bazelrc$' "$f" \
       && grep -q '^APT_CONF=/etc/apt/apt.conf.d/99-termag-bake-scratch$' "$f"; then
        pass "$(basename "$f") uses the shared marker and drop-in paths"
    else
        fail "$(basename "$f") disagrees on the marker or drop-in paths"
    fi
done
if grep -q -- '-lname "\$MOUNT\*"' "$DETACH"; then
    pass "detach-scratch.sh refuses symlinks into the scratch volume"
else
    fail "detach-scratch.sh has no symlink guard for the mount"
fi
if grep -qE '^RTK_VERSION=v[0-9]+\.[0-9]+\.[0-9]+$' "$SETUP" && grep -qE '^RTK_SHA256=[0-9a-f]{64}$' "$SETUP"; then
    pass "rtk is pinned to a tag and a sha256"
else
    fail "setup.sh: RTK_VERSION/RTK_SHA256 are not a vX.Y.Z tag and a 64-hex digest"
fi
if ! grep -q 'cargo install --path' "$SETUP"; then
    pass "rtk is no longer built with cargo"
else
    fail "setup.sh still cargo-builds rtk"
fi
if grep -q '^uv python install 3.13$' "$SETUP" && ! grep -qE '^pyenv install ' "$SETUP"; then
    pass "Python is a prebuilt interpreter registered with pyenv, not a pyenv compile"
else
    fail "setup.sh: expected 'uv python install 3.13' and no 'pyenv install' command"
fi
if grep -q '^uv tool install poetry$' "$SETUP" && ! grep -qE '^pip install ' "$SETUP"; then
    pass "poetry is a uv tool; pip is not aimed at the uv-managed interpreter"
else
    fail "setup.sh: poetry must be 'uv tool install poetry' (pip refuses a uv-managed CPython)"
fi
if grep -q '"$(uv python dir)"/\*/bin/python3' "$SETUP" && grep -q -- '-m compileall' "$SETUP"; then
    pass "every uv-managed stdlib is precompiled, so a later import writes no __pycache__ into the home"
else
    fail "setup.sh: the uv-managed stdlibs must be precompiled"
fi
# ── box marker: TERMAG_BOX reaches every process ──
AGENT_UNIT=$HERE/../../deploy/termag-agent.service
if grep -q '^Environment=TERMAG_BOX=1$' "$AGENT_UNIT"; then
    pass "termag-agent.service sets TERMAG_BOX for everything the agent spawns"
else
    fail "deploy/termag-agent.service: no Environment=TERMAG_BOX=1; a make dev from a project pane or a runner session is recorded as linux"
fi
if grep -q '^install_box_marker()' "$LIB" && grep -q '/etc/profile.d/termag-box.sh' "$LIB" \
   && grep -q 'export TERMAG_BOX=1' "$LIB"; then
    pass "box-lib.sh writes /etc/profile.d/termag-box.sh for bash login shells"
else
    fail "box-lib.sh: no install_box_marker writing export TERMAG_BOX=1 to /etc/profile.d/termag-box.sh"
fi
if grep -q 'tee -a /etc/zsh/zshenv' "$LIB" && grep -q "grep -qxF 'export TERMAG_BOX=1' /etc/zsh/zshenv" "$LIB"; then
    pass "box-lib.sh appends the marker to /etc/zsh/zshenv once (the box user's shell is zsh, which never reads profile.d)"
else
    fail "box-lib.sh: install_box_marker does not append export TERMAG_BOX=1 to /etc/zsh/zshenv idempotently; a zsh login over ssh would still read as linux"
fi
for f in "$SETUP" "$REFRESH"; do
    if grep -q '^install_box_marker$' "$f"; then
        pass "$(basename "$f") installs the box marker"
    else
        fail "$(basename "$f") does not call install_box_marker; a $(basename "$f" .sh) bake would ship a box without TERMAG_BOX for login shells"
    fi
done

if [ "$fails" -eq 0 ]; then
    echo "all checks passed"
else
    echo "$fails check(s) failed" >&2
    exit 1
fi
