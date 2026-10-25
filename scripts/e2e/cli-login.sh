#!/usr/bin/env bash
# Sign in to a LOCAL e2e stack (AUTH_MODE=local) as a CLI device, without a
# browser, and store the result where `termag login` would:
# $XDG_CONFIG_HOME/termag/credentials.json. The desktop app's "Use CLI sign-in"
# imports it. For the local stack only: it drives the stack's local sign-in and
# the CLI approval page with curl, as scripts/e2e/t3.test.sh does.
#
#   XDG_CONFIG_HOME=/tmp/x scripts/e2e/cli-login.sh [orchestrator-url]
set -euo pipefail

# shellcheck source-path=SCRIPTDIR
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

API=${1:-http://127.0.0.1:${E2E_PORT:-3040}/termag}
: "${XDG_CONFIG_HOME:?set XDG_CONFIG_HOME so this never writes your real ~/.config}"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
jar="$work/cookies"

verifier=$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))')
challenge=$(pkce_challenge "$verifier")
state=$(node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))')
origin=$(node -e 'const u=new URL(process.argv[1]);process.stdout.write(u.origin)' "$API")
query="port=45999&state=$state&code_challenge=$challenge&code_challenge_method=S256&device_name=termag-desktop-dev"
curl -fsS -o /dev/null -c "$jar" -b "$jar" "$API/auth/login"
curl -fsS -o /dev/null -c "$jar" -b "$jar" "$API/auth/cli/authorize?$query"
curl -sS -o /dev/null -c "$jar" -b "$jar" -D "$work/headers" -H "Origin: $origin" \
  --data "$query&decision=approve" "$API/auth/cli/authorize"
code=$(grep -i '^location:' "$work/headers" | tr -d '\r' | sed -n 's/.*[?&]code=\([^&]*\).*/\1/p')
[ -n "$code" ] || { echo "cli-login: the approval page returned no code" >&2; exit 1; }
curl -fsS -H 'Content-Type: application/json' \
  -d "{\"grant_type\":\"authorization_code\",\"code\":\"$code\",\"code_verifier\":\"$verifier\"}" \
  "$API/api/cli/v1/token" >"$work/token.json"

mkdir -p "$XDG_CONFIG_HOME/termag"
node - "$work/token.json" "$XDG_CONFIG_HOME/termag/credentials.json" "$API" <<'JS'
const fs = require('fs');
const [tokenFile, out, url] = process.argv.slice(2);
const t = JSON.parse(fs.readFileSync(tokenFile, 'utf8'));
let file = { version: 1, hosts: {} };
try { file = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
file.hosts[url] = {
  token: t.token,
  accessToken: t.accessToken,
  accessTokenExpiresAt: new Date(Date.now() + (t.accessTokenExpiresIn ?? 3600) * 1000).toISOString(),
  deviceName: 'termag-desktop-dev',
  email: t.user.email,
  unixUsername: t.user.unixUsername,
  expiresAt: t.expiresAt,
  maxExpiresAt: t.maxExpiresAt,
};
fs.writeFileSync(out, JSON.stringify(file, null, 2), { mode: 0o600 });
console.log(`signed in as ${t.user.email}; stored in ${out}`);
JS
