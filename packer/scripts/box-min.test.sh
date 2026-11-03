#!/bin/sh
# Wires, not behaviour — hermetic checks on the box-min bake:
#   packer/box-min.pkr.hcl            the lean Component=box-min template
#   packer/scripts/box-min-setup.sh   its one design provisioner
# The full bake's provisioners (packer/scripts/setup.sh and friends) test
# themselves elsewhere; this checks that box-min.pkr.hcl ships exactly the
# contract, that none of the full bake's toolchain war leaked in, and that the
# provisioners keep the order home-paths.test.sh already enforces on the full
# template: the home-path index runs LAST.
#
# Hermetic: no packer, no AWS. Needs grep, sed and awk (CI is Ubuntu; so is
# the bake it gates).
#
# What a regression here looks like on a live box: a --minimal launch paying
# the full bake's disk, or a snapshot carrying toolchains no bootstrap needs.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
PKR="$HERE/../box-min.pkr.hcl"
SETUP="$HERE/box-min-setup.sh"

fails=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; fails=$((fails + 1)); }

check_absent() { # file label pattern...
    f=$1 label=$2
    shift 2
    # The absence rules scan the named file's CODE — its non-comment lines —
    # because comments may name excluded things while describing them (the
    # box-min template's header lists what it deliberately leaves out).
    case "$f" in
        "$SETUP") doc=$CODE ;;
        "$PKR")   doc=$TPL ;;
        *)        doc=$(strip_comments "$f") ;;
    esac
    for pat in "$@"; do
        if printf '%s\n' "$doc" | grep -qE -- "$pat"; then
            fail "$label references $pat — the lean bake must not ship it"
        else
            pass "$label: none of $pat"
        fi
    done
}

check_present() { # file label pattern...
    f=$1 label=$2
    shift 2
    for pat in "$@"; do
        if grep -qE -- "$pat" "$f"; then
            pass "$label has $pat"
        else
            fail "$label is missing $pat"
        fi
    done
}

[ -f "$PKR" ]   || { echo "FAIL: $PKR not found" >&2; exit 1; }
[ -f "$SETUP" ] || { echo "FAIL: $SETUP not found" >&2; exit 1; }

# The template only ever names scripts it provisions with, so scan the
# provisioner-assignment lines rather than the whole file: those are the
# shipping surface, and comments that *list* the excluded full-bake steps are
# welcome context. Same for the setup script — its exclusion list lives in
# comments.
provisioner_paths() { grep -oE '[$][{]path[.]root}/scripts/[a-z0-9-]+[.]sh' "$1" | sort -u; }
PROV=$(provisioner_paths "$PKR")
# Code, not comments: the shipping surface of each scanned file. The
# template's comments (// or #) welcome naming what is left out; a token
# outside a comment is what fails.
strip_comments() { grep -vE '^[[:space:]]*(#|//)' "$1"; }
CODE=$(strip_comments "$SETUP")
TPL=$(strip_comments "$PKR")

FORBIDDEN='setup\.sh bake-webapp-fetch\.sh bake-webapp\.sh prepare-scratch\.sh detach-scratch\.sh refresh-box\.sh enable-hibernation\.sh'
# shellcheck disable=SC2086
for p in $FORBIDDEN; do
    if printf '%s\n' "$PROV" | grep -qE "scripts/$p"; then
        fail "box-min.pkr.hcl provisions the full bake's $p — the lean image must not run it"
    else
        pass "box-min.pkr.hcl does not provision $p"
    fi
done
if printf '%s\n' "$PROV" | grep -q 'rewrite-home-paths'; then
    pass 'box-min.pkr.hcl ships rewrite-home-paths.sh for the index'
else
    fail 'box-min.pkr.hcl must ship rewrite-home-paths.sh for the index'
fi
# The required pieces: NitroTPM re-register, the bundle and the home-path
# index.
check_present "$PKR" box-min.pkr.hcl \
    'enable-nitrotpm\.sh' \
    'bundle-source\.sh' \
    'index-home-paths\.sh' \
    'rewrite-home-paths\.sh'

# no incremental-mode machinery, no scratch volume to keep track of
check_absent "$PKR" box-min.pkr.hcl \
    '[Vv]ariable "bake_mode"' '[Vv]ariable "source_ami"' 'variable "scratch_volume' \
    'bake_mode' 'scratch_volume_size'

# The discovery contract.
check_present "$PKR" box-min.pkr.hcl \
    'Hibernation = "unsupported"' \
    'volume_size           = var\.root_volume_gb'
grep -A2 'variable "final_component_tag"' "$PKR" | grep -q 'default     = "box-min"$' \
    && pass 'final_component_tag defaults to box-min (discovery tag)' \
    || fail 'final_component_tag default is not box-min'
grep -A2 'variable "root_volume_gb"' "$PKR" | grep -q 'default[[:space:]]*=[[:space:]]*60$' \
    && pass 'root_volume_gb defaults to 60' \
    || fail 'root_volume_gb does not default to 60'

# The contract resident itself, then the launch bits it feeds.
check_present "$PKR" box-min.pkr.hcl \
    'deploy/termag-agent\.service' \
    'deploy/termag-reconcile\.service' \
    'deploy/termag-hook-run' \
    'deploy/termag-on-warm\.service' \
    'script = "\$\{path\.root\}/scripts/box-min-setup\.sh"'

# ── ordering: index-home-paths runs LAST on the baked home ───────────────────
# Anything that writes under /home/termag after the index is not rewritten at
# the boot rename (home-paths.test.sh states the same rule for box.pkr.hcl).
last=$(sed 's/\r$//' "$PKR" | awk '/script[ ]*=/ {line=$0} END {print line}')
case "$last" in
    *index-home-paths.sh*) pass "the last provisioner's script is index-home-paths.sh" ;;
    *) fail "the last script provisioner is not index-home-paths.sh: $last" ;;
esac

# ── the setup script installs the contract and nothing heavy ─────────────────
check_present "$SETUP" box-min-setup.sh \
    'apt_get install -y' \
    'git \\$' \
    'gh \\$' \
    'tmux \\$' \
    'zsh \\$' \
    'tpm2-tools' \
    'githubcli-archive-keyring' \
    'nvm install "\$NODE_VERSION"' \
    'not the pinned v\$NODE_VERSION' \
    'npm install --omit=dev' \
    'cli/install\.sh' \
    'install_deploy_artifacts' \
    'install_box_marker' \
    'install_guest_browser' \
    'install_gh_updater' \
    '90-termag-box' \
    '10-termag-keys-only' \
    'enable-linger' \
    'TERMAG_BAKED_SHA' \
    'truncate -s 0 /etc/machine-id' \
    'visudo -cf' \
    'snap list amazon-ssm-agent'

# The toolchains, the war cache and the devbench extras the full bake stands
# up are precisely what this script must never type. Docker and the agent
# CLIs are contract now (the user's bring-up runs compose stacks in panes;
# the agent CLIs are what agent panes run), so they are asserted below — the
# war-cache half of docker (pre-pulled images) stays out.
check_absent "$SETUP" box-min-setup.sh \
    'goenv' 'rustup' 'pyenv' 'corepack' \
    'snap install chromium' '[Pp]laywright' \
    'browser-harness' \
    'bazelisk' 'qemu-user-static|musl' \
    'aws/install' \
    'oh-my-zsh|Oh My Zsh' \
    '\buv\b' \
    'webapp|example-org/dev' \
    'prepare-scratch|bazel-disk'

# Docker is contract now: engine + buildx + compose + the ECR credential
# helper, and the docker group for the box user.
check_present "$SETUP" box-min-setup.sh \
    'docker-ce' 'containerd\.io' 'docker-buildx-plugin' 'docker-compose-plugin' \
    'amazon-ecr-credential-helper' \
    'aG docker'

# The agent CLIs ride with the bake: claude + codex npm-global, pi pinned to
# the same --ignore-scripts 1.0.2 the full bake pins and the bootstrap
# checks; cursor and devin from their vendor installers.
check_present "$SETUP" box-min-setup.sh \
    '@anthropic-ai/claude-code @openai/codex' \
    '@earendil-works/pi-coding-agent@1\.0\.2' \
    '--ignore-scripts' \
    'pi --version 2>/dev/null.*1\.0\.2' \
    'cursor\.com/install' \
    'cli\.devin\.ai/install\.sh'

# node-pty is a runtime dep of the agent and compiles at bake; the compilers
# must be there or the bake dies before it publishes anything.
check_present "$SETUP" box-min-setup.sh 'build-essential' 'python3'

# The baked-refusal contract: the bundle HEAD must be the commit CI named.
check_present "$SETUP" box-min-setup.sh 'does not match TERMAG_BAKED_SHA'

# ── CI carries the second component everywhere the box one is special-cased ──
WF="$HERE/../../.github/workflows/publish-ami.yml"
RET="$HERE/../../.github/workflows/ami-retention.yml"
CIC="$HERE/../../.github/workflows/box-ami-ci.yml"
if [ -f "$WF" ]; then
    check_present "$WF" publish-ami.yml \
        'box-min\.pkr\.hcl' \
        'check-box-min-ami' \
        'build-box-min' \
        'BOX_MIN_COMPONENT_TAG' \
        'Component,Values=box-min'
fi
if [ -f "$RET" ]; then
    check_present "$RET" ami-retention.yml \
        "orchestrator box box-candidate box-min box-min-candidate box-min-base box-base ami-build" \
        'orchestrator \| box \| box-candidate \| box-min \| box-min-candidate \| box-min-base \| box-base \| ami-build' \
        'box-base \| box-min-base \| ami-build) keep=0'
fi
if [ -f "$CIC" ]; then
    check_present "$CIC" box-ami-ci.yml 'box-min\.pkr\.hcl'
fi

# ── the two bakes install the same pinned Node ──────────────────────────────
# Node versions must move together: a lean box whose node drifted from a full
# box's node doubles the interpreter matrix the agent's runtime selection has
# to handle. The lean setup declares Node like setup.sh does — same value,
# no --lts anywhere.
full_sh="$HERE/../scripts/setup.sh"
bmin_node=$(grep -oE '^NODE_VERSION=[0-9.]+' "$SETUP" | head -1 | cut -d= -f2)
full_node=$(grep -oE '^NODE_VERSION=[0-9.]+' "$full_sh" | head -1 | cut -d= -f2)
if [ -n "$bmin_node" ] && [ "$bmin_node" = "$full_node" ]; then
    pass "the lean bake and setup.sh pin the same Node ($bmin_node)"
else
    fail "the lean bake pins Node '$bmin_node', setup.sh pins '$full_node' — bump the two together"
fi
if grep -q "nvm install --lts\|alias default 'lts" "$SETUP"; then
    fail "box-min-setup.sh still floats the node (nvm --lts); it must pin"
else
    pass "box-min-setup.sh contains no floating-lts node"
fi

# ── the backend's minimal disk default keeps the lean image lean ────────────
DSIZE="$HERE/../../backend/src/services/boxDiskSize.ts"
PROV="$HERE/../../backend/src/services/boxProvisioner.ts"
if [ -f "$DSIZE" ]; then
    if grep -q 'minimalDefaultDiskGiB' "$DSIZE" \
        && grep -q 'root < 60' "$DSIZE" && grep -q ': 60;' "$DSIZE"; then
        pass 'boxDiskSize.ts defaults the lean disk to 60 when nothing else asks'
    else
        fail 'boxDiskSize.ts does not default the lean flavor disk to 60'
    fi
fi

if [ "$fails" -gt 0 ]; then
    echo "failed: $fails" >&2
    exit 1
fi
echo "box-min wiring OK"
