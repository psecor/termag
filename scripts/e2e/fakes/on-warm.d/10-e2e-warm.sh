#!/usr/bin/env bash
# The e2e stack's stand-in for deploy/on-warm.d on a warm-pool box: the real
# scripts run first-boot setup and pull the dev stack's images,
# neither of which a stand-in box can do. This one takes E2E_WARM_SECONDS
# (default 2) so the pool visibly goes warming -> warm, and exits
# E2E_WARM_EXIT (default 0) so a failing warm run can be tried too. Both are
# read from <box home>/.termag/e2e-warm.env if present.
set -euo pipefail
env_file="$HOME/.termag/e2e-warm.env"
# shellcheck disable=SC1090
[ -f "$env_file" ] && . "$env_file"
echo "e2e warm-up: ${E2E_WARM_SECONDS:-2}s on $(hostname) as $(id -un), HOME=$HOME"
sleep "${E2E_WARM_SECONDS:-2}"
exit "${E2E_WARM_EXIT:-0}"
