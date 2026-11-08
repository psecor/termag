#!/usr/bin/env bash
# A review queue for the Reviews page (its filters):
# twelve review requests across four repositories, with every review state, two
# bot authors, a draft and a failing CI run (review-queue.json), served by the
# GitHub stub, and a stub token stored for the signed-in e2e user so GET /api/prs
# reads them. The stub's own #4242 is in the queue too.
# Needs a stack up with E2E_FAKE_GITHUB=1 E2E_FAKE_AWS=1 E2E_CREDENTIAL_STORE=1
# and the flags simple-ui-chrome-refresh-enabled and simple-ui-reviews-enabled;
# see docs/e2e-stack.md, "Setting up a scene".
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/e2e/lib.sh
. "$here/../lib.sh"
ROOT=$(e2e_root) || { echo "no e2e stack is up" >&2; exit 1; }
API="http://127.0.0.1:${E2E_PORT:-3040}/termag"
mkdir -p "$ROOT/github"
cp "$here/review-queue.json" "$ROOT/github/review-prs.json"
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT
curl -sf -o /dev/null -c "$jar" "$API/auth/login"
token=gho_e2eReviewQueue0123456789abcdefABCDEF # gitleaks:allow (a fake token only the GitHub stub knows)
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" -X PUT -H 'content-type: application/json' -d "{\"token\":\"$token\"}" "$API/api/credentials/github")
[ "$code" = 200 ] || { echo "storing the stub GitHub token answered $code" >&2; exit 1; }
echo "review queue seeded: $(jq length "$here/review-queue.json") PRs in $ROOT/github/review-prs.json"
