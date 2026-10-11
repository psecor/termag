#!/bin/sh
# Checks for the orchestrator bake (orchestrator-setup.sh). Hermetic: no AWS,
# no packer, no sudo.

set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
SETUP=$HERE/orchestrator-setup.sh
UNIT=$HERE/../../deploy/claude-runner-orchestrator.service

fails=0
pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; fails=$((fails + 1)); }

# The runner orchestrator runs the claude that
# terraform's cloud-init installs from npm for every user on the host. The bake
# must not download or install a second, orchestrator-only copy.
if grep -v '^[[:space:]]*#' "$SETUP" | grep -qE 'downloads\.claude\.ai|claude-code-releases|/usr/local/lib/termag/claude([^-]|$)'; then
    fail "orchestrator-setup.sh installs a claude of its own"
else
    pass "the bake installs no claude of its own"
fi
if grep -qE '^ExecStart=/usr/bin/claude self-hosted-runner orchestrator ' "$UNIT"; then
    pass "the orchestrator unit runs the host's /usr/bin/claude"
else
    fail "claude-runner-orchestrator.service does not run /usr/bin/claude"
fi

# Host storage handoff. The attach unit waits
# for the previous orchestrator to release the volume, which happens only after
# this host serves, so it must never be a oneshot: its start job would hold
# multi-user.target and cloud-final, which starts the backend.
ATTACH_UNIT=$HERE/../../deploy/termag-data-attach.service
if grep -qx 'sudo install -m 0755 -o root -g root /opt/termag/deploy/termag-data-attach /usr/local/sbin/termag-data-attach' "$SETUP" &&
    grep -qx 'sudo install -m 0644 -o root -g root /opt/termag/deploy/termag-data-attach.service /etc/systemd/system/termag-data-attach.service' "$SETUP"; then
    pass "the bake installs termag-data-attach root-owned"
else
    fail "orchestrator-setup.sh does not install termag-data-attach and its unit"
fi
if grep -qx 'sudo systemctl enable termag-data-attach.service' "$SETUP"; then
    pass "the bake enables termag-data-attach without starting it"
else
    fail "orchestrator-setup.sh does not enable termag-data-attach.service (without --now)"
fi
if grep -qx 'Type=simple' "$ATTACH_UNIT" && ! grep -q 'Type=oneshot' "$ATTACH_UNIT"; then
    pass "termag-data-attach.service is Type=simple"
else
    fail "termag-data-attach.service must be Type=simple"
fi
if grep -qx 'ExecStart=/usr/local/sbin/termag-data-attach' "$ATTACH_UNIT" &&
    grep -qx 'Restart=on-failure' "$ATTACH_UNIT" &&
    grep -qx 'RestartPreventExitStatus=2' "$ATTACH_UNIT"; then
    pass "termag-data-attach.service restarts on failure, not on a config error"
else
    fail "termag-data-attach.service: ExecStart, Restart=on-failure or RestartPreventExitStatus=2 missing"
fi

# The drain's runner stop (backend/src/services/claudeRunnerUnit.ts) needs a
# sudoers rule for exactly that unit's stop and start, installed 0440 and
# checked by visudo at bake time.
SUDOERS=$HERE/../../deploy/claude-runner-orchestrator.sudoers
if grep -qE '^sudo install -m 0440 -o root -g root /opt/termag/deploy/claude-runner-orchestrator\.sudoers /etc/sudoers\.d/92-termag-claude-runner$' "$SETUP" &&
    grep -qE '^sudo visudo -cf /etc/sudoers\.d/92-termag-claude-runner$' "$SETUP"; then
    pass "the bake installs the runner sudoers rule 0440 and checks it with visudo"
else
    fail "orchestrator-setup.sh does not install and visudo-check the runner sudoers rule"
fi
rules=$(grep -v '^[[:space:]]*#' "$SUDOERS" | grep -v '^[[:space:]]*$')
want='termag ALL=(root) NOPASSWD: /usr/bin/systemctl stop claude-runner-orchestrator.service, /usr/bin/systemctl start claude-runner-orchestrator.service'
if [ "$rules" = "$want" ]; then
    pass "the runner sudoers rule allows only stop and start of claude-runner-orchestrator.service"
else
    fail "deploy/claude-runner-orchestrator.sudoers is not exactly the one stop/start rule: $rules"
fi
VISUDO=$(command -v visudo || ls /usr/sbin/visudo 2>/dev/null || true)
if [ -n "$VISUDO" ]; then
    if "$VISUDO" -cf "$SUDOERS" >/dev/null 2>&1; then
        pass "visudo accepts the runner sudoers rule"
    else
        fail "visudo rejects deploy/claude-runner-orchestrator.sudoers"
    fi
else
    echo "SKIP: no visudo here"
fi

[ "$fails" -eq 0 ] || { echo "$fails check(s) failed" >&2; exit 1; }
echo "all checks passed"
