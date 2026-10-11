#!/usr/bin/env bash
# End-to-end check of `termag doctor` (cli/) against a real local stack with
# the credential store (Floci KMS) and the GitHub stub: report-only without a
# terminal, `login` running doctor and applying its fixes at a terminal (GitHub
# token through the credential store, AWS profile, aws sso login), the SSH key
# left to the web UI (no CLI credential can add one), the box credential
# refused for writes, and the token never printed. The
# laptop's gh, aws and session-manager-plugin are stand-ins in $WORK/bin.
# Runs on its own ports and TMPDIR, so it can run beside a stack that is up.
#
# Run: bash scripts/e2e/cli-doctor.test.sh   (or make e2e-test-cli-doctor)
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-3960} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-5994} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55459}
export E2E_AWS_PORT=${E2E_TEST_AWS_PORT:-4596} E2E_GITHUB_PORT=${E2E_TEST_GITHUB_PORT:-4590}
export E2E_BOXES=1 E2E_FAKE_AWS=1 E2E_CREDENTIAL_STORE=1 E2E_FAKE_GITHUB=1
trap 'bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

failures=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

if [ ! -x "$repo/cli/node_modules/.bin/tsc" ]; then
  (cd "$repo/cli" && npm ci --no-audit --no-fund >"$WORK/cli-install.log" 2>&1) || { cat "$WORK/cli-install.log"; echo "FAIL: cli npm ci"; exit 1; }
fi
(cd "$repo/cli" && npm run build >"$WORK/cli-build.log" 2>&1) || { cat "$WORK/cli-build.log"; echo "FAIL: cli build"; exit 1; }
pass "cli builds"

if ! bash "$here/up.sh" >"$WORK/up.log" 2>&1; then
  cat "$WORK/up.log"
  echo "FAIL: up.sh"
  exit 1
fi
pass "up.sh brought the stack up with the credential store and the GitHub stub"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
API="http://127.0.0.1:$E2E_PORT/termag"
DB="postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag"
JAR="$WORK/browser-cookies"
LAPTOP="$WORK/laptop"
BIN="$WORK/bin"
mkdir -p "$LAPTOP/.ssh" "$BIN"
chmod 700 "$LAPTOP/.ssh"
# Never contains _bad or _noscope, which the GitHub stub refuses.
GH_TOKEN=gho_e2eLaptopToken0123456789abcdefABCD
TOKEN_FP=$(printf '%s' "$GH_TOKEN" | sha256sum | cut -c1-8)

# The "browser" `termag login` opens, as in cli.test.sh.
cat >"$BIN/xdg-open" <<EOF
#!/usr/bin/env bash
url=\$1
curl -s -o /dev/null -c "$JAR" -b "$JAR" "$API/auth/login"
curl -s -o /dev/null -c "$JAR" -b "$JAR" "\$url"
curl -s -o /dev/null -c "$JAR" -b "$JAR" -D "$WORK/approve.headers" \\
  -H "Origin: http://127.0.0.1:$E2E_PORT" --data "\${url#*\\?}&decision=approve" "$API/auth/cli/authorize"
loc=\$(grep -i '^location:' "$WORK/approve.headers" | tr -d '\r' | cut -d' ' -f2)
curl -s -o /dev/null "\$loc"
EOF

# The laptop's gh: signed in as the stub's user; example-labs needs SSO
# until $LAPTOP/.labs-sso exists.
cat >"$BIN/gh" <<EOF
#!/usr/bin/env bash
case "\$*" in
  'auth token') echo "$GH_TOKEN" ;;
  'api user --jq .login') echo e2e-octocat ;;
  'api --include user/memberships/orgs/example-org') printf 'HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"state":"active"}\n' ;;
  'api --include user/memberships/orgs/example-labs')
    if [ -f "$LAPTOP/.labs-sso" ]; then printf 'HTTP/2.0 200 OK\r\n\r\n{"state":"active"}\n'; exit 0; fi
    printf 'HTTP/2.0 403 Forbidden\r\nX-Github-Sso: required; url=https://github.com/orgs/example-labs/sso?authorization_request=e2e\r\n\r\n{}\n'
    echo 'gh: Resource protected by organization SAML enforcement. (HTTP 403)' >&2; exit 1 ;;
  *) echo "gh stub: \$*" >&2; exit 1 ;;
esac
EOF

# The laptop's aws: an SSO session exists once `aws sso login` has run.
cat >"$BIN/aws" <<EOF
#!/usr/bin/env bash
case "\$*" in
  --version) echo 'aws-cli/2.17.0 (e2e stub)' ;;
  'sts get-caller-identity --profile termag-boxes --output json')
    [ -f "$LAPTOP/.aws-sso" ] || { echo; echo 'Error when retrieving token from sso: Token has expired and refresh failed' >&2; exit 255; }
    echo '{"Arn":"arn:aws:sts::123456789012:assumed-role/AWSReservedSSO_TermagUser_e2e/e2e@termag.local"}' ;;
  'sso login --profile termag-boxes') touch "$LAPTOP/.aws-sso"; echo 'Successfully logged into Start URL (e2e stub)' ;;
  *) echo "aws stub: \$*" >&2; exit 1 ;;
esac
EOF
printf '#!/bin/sh\necho 1.2.650.0\n' >"$BIN/session-manager-plugin"
chmod +x "$BIN"/*

termag() { HOME="$LAPTOP" PATH="$BIN:$PATH" node "$repo/cli/bin/termag.js" "$@" </dev/null; }
# A terminal (script(1)) whose keyboard is $1, one answer per line.
termag_tty() {
  local answers=$1; shift
  printf '%b' "$answers" | HOME="$LAPTOP" PATH="$BIN:$PATH" script -qec "node '$repo/cli/bin/termag.js' $*" /dev/null
}
status_of() { jq -r --arg id "$2" '.checks[] | select(.id == $id) | .status' "$1"; }

# 1. Not signed in, no terminal: report only.
termag doctor --host "$API" --json >"$WORK/doctor-1.json"
check "doctor before login exits 1" 1 $?
check "doctor before login: Login fails with the fix" "fail termag login" \
  "$(jq -r '.checks[0] | "\(.status) \(.fix)"' "$WORK/doctor-1.json")"
check "doctor before login: GitHub is skipped" "warn true" \
  "$(jq -r '.checks[] | select(.id == "github") | "\(.status) \(.skipped)"' "$WORK/doctor-1.json")"

ssh-keygen -q -t ed25519 -N '' -C e2e-laptop -f "$LAPTOP/.ssh/id_ed25519"
FP=$(ssh-keygen -lf "$LAPTOP/.ssh/id_ed25519.pub" | cut -d' ' -f2)

# 2. login at a terminal runs doctor, which asks three questions; answer yes.
termag_tty 'y\ny\ny\n' login --host "$API" --device e2e-laptop >"$WORK/login.out" 2>&1
check "login exits 0" 0 $?
check "login ran doctor" yes "$(grep -q 'Checking termag setup for' "$WORK/login.out" && echo yes || echo no)"
for q in "Store your \`gh\` login's token with termag?" \
  'Add the termag-boxes profile' 'Run `aws sso login --profile termag-boxes` now?'; do
  check "doctor asked: $q" yes "$(grep -qF "$q" "$WORK/login.out" && echo yes || echo no)"
done
check "doctor did not offer to register the SSH key" no "$(grep -qF 'Register ~/.ssh' "$WORK/login.out" && echo yes || echo no)"
check "doctor points at the web UI for the SSH key" yes \
  "$(grep -qF "add ~/.ssh/id_ed25519.pub in the web UI: $API/settings (SSH keys)" "$WORK/login.out" && echo yes || echo no)"
check "no SSH key was registered" 0 "$(psql -tA "$DB" -c "select count(*) from ssh_public_keys")"
check "the web UI adds the key" 201 \
  "$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -H 'Content-Type: application/json' \
      --data "$(jq -n --arg k "$(cat "$LAPTOP/.ssh/id_ed25519.pub")" '{publicKey: $k}')" "$API/api/ssh-keys")"
check "the SSH key is registered on the orchestrator" "$FP" \
  "$(psql -tA "$DB" -c "select fingerprint from ssh_public_keys")"
check "the GitHub token is stored, encrypted" "github @e2e-octocat 0" \
  "$(psql -tA "$DB" -c "select provider, label, position('$GH_TOKEN' in encode(ciphertext, 'escape')) from user_credentials" | tr '|' ' ')"
check "the orchestrator checked the token with GitHub" yes \
  "$(curl -s "http://127.0.0.1:$E2E_GITHUB_PORT/_e2e/calls" | grep -q "GET /user -> 200 .*token=$TOKEN_FP" && echo yes || echo no)"
check "the AWS profile was added" 123456789012 \
  "$(sed -n '/^\[profile termag-boxes\]/,/^\[/p' "$LAPTOP/.aws/config" | sed -n 's/^sso_account_id = //p')"
check "aws sso login ran" yes "$([ -f "$LAPTOP/.aws-sso" ] && echo yes || echo no)"
check "the web UI lists the key" "$FP" "$(curl -s -b "$JAR" "$API/api/ssh-keys" | jq -r '.[0].fingerprint')"
check "the web UI shows GitHub connected" @e2e-octocat "$(curl -s -b "$JAR" "$API/api/credentials" | jq -r .github.connected.label)"

# 3. After the fixes, no terminal: only warnings left, exit 0.
termag doctor --host "$API" --json >"$WORK/doctor-2.json"
check "doctor after the fixes exits 0" 0 $?
check "doctor after the fixes: no failures" 0 "$(jq -r .summary.fail "$WORK/doctor-2.json")"
check "GitHub SSO warns for example-labs with the authorize URL" \
  "warn authorize it at https://github.com/orgs/example-labs/sso?authorization_request=e2e" \
  "$(jq -r '.checks[] | select(.id == "github-sso") | "\(.status) \(.fix)"' "$WORK/doctor-2.json")"
check "SSH config warns without the termag-* entry" warn "$(status_of "$WORK/doctor-2.json" ssh-config)"
check "Claude: off on a stack without the gateway" ok "$(status_of "$WORK/doctor-2.json" claude)"

touch "$LAPTOP/.labs-sso"
printf 'Host termag-*\n  User e2e\n' >"$LAPTOP/.ssh/config"
termag doctor --host "$API" >"$WORK/doctor-3.out"
check "doctor with everything in place exits 0" 0 $?
check "doctor with everything in place: All checks passed" yes "$(grep -q '^All checks passed\.$' "$WORK/doctor-3.out" && echo yes || echo no)"

# 4. A problem without a terminal is reported, not fixed.
: >"$WORK/empty-aws-config"
AWS_CONFIG_FILE="$WORK/empty-aws-config" termag doctor --host "$API" >"$WORK/doctor-4.out"
check "doctor with a missing profile and no terminal exits 1" 1 $?
check "it says how to fix it" yes "$(grep -qF 'fix: run `termag doctor` in a terminal to add it' "$WORK/doctor-4.out" && echo yes || echo no)"
check "it did not write the AWS config" 0 "$(wc -c <"$WORK/empty-aws-config")"

# 5. The box's own token can read but not write credentials, and no CLI
# credential can add an SSH key.
box_token=$(jq -r .token "$ROOT/boxes/box-1/home/.termag/agent.config.json")
check "box token: GET /credentials" 200 \
  "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $box_token" "$API/api/cli/v1/credentials")"
creds="$LAPTOP/.config/termag/credentials.json"
device_token=$(jq -r --arg h "$API" '.hosts[$h].token' "$creds")
access_token=$(jq -r --arg h "$API" '.hosts[$h].accessToken' "$creds")
ssh-keygen -q -t ed25519 -N '' -C e2e-other -f "$WORK/other-key"
for kind in device access box; do
  case $kind in device) t=$device_token ;; access) t=$access_token ;; box) t=$box_token ;; esac
  code=$(curl -s -o "$WORK/post-$kind.json" -w '%{http_code}' -H "Authorization: Bearer $t" -H 'Content-Type: application/json' \
    --data "$(jq -n --arg k "$(cat "$WORK/other-key.pub")" '{publicKey: $k}')" "$API/api/cli/v1/ssh-keys")
  check "$kind token: POST /ssh-keys is the CLI API's 404" "404 not_found" "$code $(jq -r .code "$WORK/post-$kind.json")"
done
check "and no key was added" 1 "$(psql -tA "$DB" -c "select count(*) from ssh_public_keys")"
check "box token: PUT /github is refused" 403 \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $box_token" -H 'Content-Type: application/json' \
      --data "{\"token\":\"$GH_TOKEN\"}" "$API/api/cli/v1/github")"
HOME="$ROOT/boxes/box-1/home" node "$repo/cli/bin/termag.js" doctor --json </dev/null >"$WORK/doctor-box.json"
check "doctor on a box exits 0" 0 $?
check "doctor on a box skips the laptop checks" 7 "$(jq '[.checks[] | select(.skipped)] | length' "$WORK/doctor-box.json")"

# The gh token never reaches a terminal or a report.
check "the gh token was never printed" no \
  "$(grep -rqF "$GH_TOKEN" "$WORK"/*.out "$WORK"/*.json && echo yes || echo no)"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all CLI doctor e2e checks passed"
