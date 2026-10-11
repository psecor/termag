#!/usr/bin/env bash
# End-to-end check of `termag ssh`, `termag attach` and `termag ssh-config`
# (cli/src/connect) against a real local stack with E2E_SSHD=1. Real ssh, a
# real sshd per box, the real orchestrator; only SSM is a stand-in: an `aws` on
# PATH whose `ssm start-session --target i-e2e000N` pipes to box-N's sshd, and a
# no-op `session-manager-plugin`. box-1 is marked as an EC2 box in the database
# so the CLI will address it; box-2 stays `external`. The laptop key reaches
# the box through the SSH-keys settings, as it does in production.
#
# Not covered, because it needs real AWS: the TermagSSH document, IAM, the
# Session Manager plugin and AWS SSO itself (see the PR for #179's notes).
#
# Run: bash scripts/e2e/cli-connect.test.sh   (or make e2e-test-cli-connect)
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/../.." && pwd)
WORK=$(mktemp -d)
chmod 700 "$WORK" # sshd's StrictModes wants no group/world-writable parents
export TMPDIR=$WORK
export E2E_PORT=${E2E_TEST_PORT:-3960} E2E_FRONTEND_PORT=${E2E_TEST_FRONTEND_PORT:-5994} E2E_PG_PORT=${E2E_TEST_PG_PORT:-55459}
export E2E_BOXES=2 E2E_SSHD=1 E2E_SSH_PORT_BASE=${E2E_TEST_SSH_PORT_BASE:-2420}
trap 'jobs -p | xargs -r kill 2>/dev/null; bash "$here/down.sh" >/dev/null 2>&1; rm -rf "$WORK"' EXIT

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
pass "up.sh brought the stack up with an sshd per box"

# shellcheck source-path=SCRIPTDIR
. "$here/lib.sh"
ROOT=$(e2e_root) || { echo "FAIL: no stack root after up.sh"; exit 1; }
U=$(id -un)
API="http://127.0.0.1:$E2E_PORT/termag"
DB="postgresql://termag@127.0.0.1:$E2E_PG_PORT/termag"
JAR="$WORK/browser-cookies"
LAPTOP="$WORK/laptop"
STATE="$WORK/aws-state"
mkdir -p "$LAPTOP/.ssh" "$WORK/bin" "$STATE"
chmod 700 "$LAPTOP/.ssh"

# The browser `termag login` opens (as in cli.test.sh).
cat >"$WORK/bin/xdg-open" <<EOF
#!/usr/bin/env bash
url=\$1
curl -s -o /dev/null -c "$JAR" -b "$JAR" "$API/auth/login"
curl -s -o /dev/null -c "$JAR" -b "$JAR" "\$url"
curl -s -o /dev/null -c "$JAR" -b "$JAR" -D "$WORK/approve.headers" \\
  -H "Origin: http://127.0.0.1:$E2E_PORT" --data "\${url#*\\?}&decision=approve" "$API/auth/cli/authorize"
curl -s -o /dev/null "\$(grep -i '^location:' "$WORK/approve.headers" | tr -d '\r' | cut -d' ' -f2)"
EOF

# The stand-in AWS CLI: the profiles in the laptop's ~/.aws/config, an SSO
# session that `sso login` starts and "$STATE/sso-expired" expires, and an SSM
# session that is a plain TCP pipe to the box's sshd.
cat >"$WORK/bin/aws" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$STATE/calls"
case "\$1 \$2" in
  "configure list-profiles") echo default; grep -qx '\[profile termag-boxes\]' "\$HOME/.aws/config" 2>/dev/null && echo termag-boxes; true ;;
  "--version ") echo 'aws-cli/2.15.30 Python/3.11.8 Linux/6.1 exe/aarch64' ;;
  "sts get-caller-identity")
    if [ ! -f "$STATE/signed-in" ]; then echo 'Error loading SSO Token: Token for termag does not exist' >&2; exit 255; fi
    if [ -f "$STATE/sso-expired" ]; then echo 'Error when retrieving token from sso: Token has expired and refresh failed' >&2; exit 255; fi
    echo '{"Account":"000000000000"}' ;;
  "sso login") rm -f "$STATE/sso-expired"; touch "$STATE/signed-in"; echo 'Successfully logged into Start URL: https://example.awsapps.com/start' ;;
  "ssm start-session")
    target=; while [ \$# -gt 0 ]; do [ "\$1" = --target ] && target=\$2; shift; done
    case "\$target" in i-e2e000[1-9]) ;; *) echo "An error occurred (TargetNotConnected): \$target is not connected." >&2; exit 254 ;; esac
    exec node -e 'const s=require("net").connect(+process.argv[1],"127.0.0.1");process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",e=>{console.error(e.message);process.exit(1)});s.on("close",()=>process.exit(0))' \$(( $E2E_SSH_PORT_BASE + \${target#i-e2e000} )) ;;
  *) echo "stand-in aws: unexpected \$*" >&2; exit 2 ;;
esac
EOF
printf '#!/bin/sh\nexit 0\n' >"$WORK/bin/session-manager-plugin"
printf '#!/bin/sh\nexec node %q "$@"\n' "$repo/cli/bin/termag.js" >"$WORK/bin/termag"
KEY="$LAPTOP/.ssh/id_ed25519"
# ssh reads ~/.ssh from the passwd entry, not $HOME, so an ssh first on PATH
# points every connection (attach and the ssh-config route included) at the
# laptop's key and known_hosts rather than this machine user's.
printf '#!/bin/sh\nexec %q -i %q -o IdentitiesOnly=yes -o UserKnownHostsFile=%q "$@"\n' \
  "$(command -v ssh)" "$KEY" "$LAPTOP/.ssh/known_hosts" >"$WORK/bin/ssh"
chmod +x "$WORK"/bin/*

export HOME="$LAPTOP" PATH="$WORK/bin:$PATH" TERMAG_URL="$API" TERMAG_TOOL_FALLBACK_DIRS=
# Passed through `termag ssh` to ssh, so they also exercise option passthrough.
SSH_OPTS=(-o LogLevel=ERROR -o ConnectTimeout=20)
tssh() { local target=$1; shift; termag ssh "$target" "${SSH_OPTS[@]}" "$@"; }
# A terminal for the commands that want one.
in_tty() { TERM=xterm-256color script -qec "$(printf '%q ' "$@")" /dev/null; }

in_tty termag login --device e2e-laptop >"$WORK/login.out" 2>&1
check "login" 0 $?

psql -q "$DB" -c "update instances set kind = 'ec2', \"ec2InstanceId\" = 'i-e2e0001', region = 'us-east-2' where name = 'box-1'"

ssh-keygen -q -t ed25519 -N '' -C e2e-laptop -f "$KEY"
check "the laptop key is registered through the SSH-keys settings" 201 \
  "$(curl -s -o "$WORK/key.json" -w '%{http_code}' -b "$JAR" -H 'Content-Type: application/json' \
      --data "$(jq -n --arg k "$(cat "$KEY.pub")" '{publicKey: $k}')" "$API/api/ssh-keys")"
for _ in $(seq 1 40); do grep -qF "$(cut -d' ' -f2 "$KEY.pub")" "$ROOT/boxes/box-1/home/.ssh/authorized_keys" && break; sleep 0.25; done
check "and lands in box-1's authorized_keys" yes \
  "$(grep -qF "$(cut -d' ' -f2 "$KEY.pub")" "$ROOT/boxes/box-1/home/.ssh/authorized_keys" && echo yes || echo no)"

projects=$(termag project list --json)
check "project list carries the project directory" "$ROOT/boxes/box-1/home/termag/projects/sample" \
  "$(jq -r '.projects[] | select(.ref == "box-1/sample") | .directory' <<<"$projects")"
check "and its tmux sessions" "$U-sample-agent $U-sample-ctrl" \
  "$(jq -r '.projects[] | select(.ref == "box-1/sample") | "\(.sessions.agent) \(.sessions.ctrl)"' <<<"$projects")"

# First connect on a laptop with no termag-boxes profile: termag writes
# the [sso-session] one, and the one sign-in it needs happens at a terminal.
tssh box-1 -- true </dev/null >/dev/null 2>"$WORK/first.err"
check "first connect without a terminal writes the profile, then exits 4 for the sign-in" "4 yes yes" \
  "$? $(grep -qx '\[sso-session termag\]' "$LAPTOP/.aws/config" && echo yes || echo no) $(grep -q 'has no AWS SSO session yet; run `aws sso login --profile termag-boxes`' "$WORK/first.err" && echo yes || echo no)"
check "the profile uses that session" "sso_session = termag" \
  "$(sed -n '/^\[profile termag-boxes\]/,/^#/p' "$LAPTOP/.aws/config" | grep '^sso_session')"
in_tty termag ssh box-1 "${SSH_OPTS[@]}" -- echo first-connect >"$WORK/first-tty.out" 2>&1
check "at a terminal it signs in once and connects" "0 yes yes" \
  "$? $(grep -q '^sso login --profile termag-boxes' "$STATE/calls" && echo yes || echo no) $(grep -q first-connect "$WORK/first-tty.out" && echo yes || echo no)"
profile_sum=$(sha256sum "$LAPTOP/.aws/config")
: >"$STATE/calls"

# shellcheck disable=SC2016
check "ssh <box> -- cmd lands in the box's home" "$ROOT/boxes/box-1/home" "$(tssh box-1 -- 'echo $HOME' 2>"$WORK/ssh.err")"
check "through SSM's TermagSSH with the termag-boxes profile" \
  "ssm start-session --target i-e2e0001 --document-name TermagSSH --parameters portNumber=22 --region us-east-2 --profile termag-boxes" \
  "$(grep '^ssm ' "$STATE/calls" | tail -n1)"
check "after checking the profile and the SSO session" "configure list-profiles|sts get-caller-identity --profile termag-boxes --output json" \
  "$(grep -v '^ssm ' "$STATE/calls" | head -n2 | paste -sd'|')"
check "ssh <box>/<project> -- cmd runs in the project directory" "$ROOT/boxes/box-1/home/termag/projects/sample" \
  "$(tssh box-1/sample -- pwd 2>>"$WORK/ssh.err")"
# shellcheck disable=SC2016
check "several command words arrive intact" "a b|it's|\$HOME|" \
  "$(tssh box-1/sample -- printf '%s|' 'a b' "it's" '$HOME' 2>>"$WORK/ssh.err")"
check "one command word is a shell command line" "2" "$(tssh box-1 -- 'printf "x\ny\n" | wc -l' 2>>"$WORK/ssh.err" | tr -d ' ')"
tssh box-1 -- 'exit 3' 2>>"$WORK/ssh.err"
check "the remote exit status comes back" 3 $?
check "the project's agent session is visible over ssh" "$U-sample-agent" \
  "$(tssh box-1/sample -- tmux ls -F '#S' 2>>"$WORK/ssh.err" | grep -x "$U-sample-agent")"

tssh box-2 -- true >/dev/null 2>"$WORK/external.err"
check "an external box is refused (exit 1)" "1 yes" "$? $(grep -q 'not an EC2 box' "$WORK/external.err" && echo yes || echo no)"
tssh box-1/nope -- true >/dev/null 2>&1
check "an unknown project exits 3" 3 $?

: >"$STATE/calls"; touch "$STATE/sso-expired"
tssh box-1 -- true </dev/null >/dev/null 2>"$WORK/sso.err"
check "without a terminal, an expired SSO session exits 4" 4 $?
check "and names the fix" yes "$(grep -q 'aws sso login --profile termag-boxes' "$WORK/sso.err" && echo yes || echo no)"
check "without running aws sso login" no "$(grep -q '^sso login' "$STATE/calls" && echo yes || echo no)"
in_tty termag ssh box-1 "${SSH_OPTS[@]}" -- echo renewed >"$WORK/sso-tty.out" 2>&1
check "at a terminal it runs aws sso login and connects" "0 yes yes" \
  "$? $(grep -q '^sso login --profile termag-boxes' "$STATE/calls" && echo yes || echo no) $(grep -q renewed "$WORK/sso-tty.out" && echo yes || echo no)"

# attach: hold the ctrl session from a terminal, see the client on the box, detach it.
in_tty termag attach box-1/sample --ctrl >"$WORK/attach.out" 2>&1 &
attach_pid=$!
clients=
for _ in $(seq 1 40); do
  clients=$(tssh box-1 -- "tmux list-clients -t $U-sample-ctrl -F '#{session_name}'" 2>/dev/null)
  [ -n "$clients" ] && break; sleep 0.25
done
check "attach --ctrl attaches a client to the ctrl session" "$U-sample-ctrl" "$clients"
tssh box-1 -- "tmux detach-client -s $U-sample-ctrl" 2>/dev/null
wait "$attach_pid"
check "and exits 0 once detached" 0 $?
termag attach box-1/sample </dev/null >/dev/null 2>&1
check "attach without a terminal exits 1" 1 $?

# ssh-config: the user's own entries survive, a re-install changes nothing, and
# plain ssh then reaches the box through `termag ssh-proxy`.
printf 'Host github.com\n  User git\n' >"$LAPTOP/.ssh/config"
termag ssh-config --install >"$WORK/install.out"
check "ssh-config --install" 0 $?
check "keeps the user's entries" yes "$(grep -qx 'Host github.com' "$LAPTOP/.ssh/config" && grep -qx '  User git' "$LAPTOP/.ssh/config" && echo yes || echo no)"
check "the entry routes through termag ssh-proxy" "  ProxyCommand $WORK/bin/termag --host $API ssh-proxy %h %p" \
  "$(grep 'ProxyCommand' "$LAPTOP/.ssh/config")"
before=$(sha256sum "$LAPTOP/.ssh/config")
check "a second --install changes nothing" "unchanged $before" \
  "$(termag ssh-config --install --json | jq -r .action) $(sha256sum "$LAPTOP/.ssh/config")"
check "plain ssh termag-box-1 works through the entry" "via-config $ROOT/boxes/box-1/home" \
  "$(ssh -F "$LAPTOP/.ssh/config" -o LogLevel=ERROR termag-box-1 'echo via-config $HOME' 2>"$WORK/plain-ssh.err")"
check "with port 22 on TermagSSH" "portNumber=22" "$(grep '^ssm ' "$STATE/calls" | tail -n1 | grep -o 'portNumber=[0-9]*')"
check "no later connection rewrote the AWS profile" "$profile_sum" "$(sha256sum "$LAPTOP/.aws/config")"

# Another tool (dev/bin/update-aws-config) appends its own legacy-form profile of
# the same name: the AWS CLI rejects a repeated section, so termag drops its own.
printf '\n[profile termag-boxes]\nsso_start_url = https://your-org.awsapps.com/start/\nsso_role_name = TermagUser\n' >>"$LAPTOP/.aws/config"
tssh box-1 -- true </dev/null >/dev/null 2>"$WORK/shadowed.err"
check "a second termag-boxes profile makes termag remove its own and connect" "0 1 no" \
  "$? $(grep -cx '\[profile termag-boxes\]' "$LAPTOP/.aws/config") $(grep -q 'termag aws-config' "$LAPTOP/.aws/config" && echo yes || echo no)"

if [ "$failures" -gt 0 ]; then
  for f in first.err first-tty.out shadowed.err ssh.err plain-ssh.err attach.out sso-tty.out; do [ -s "$WORK/$f" ] && { echo "--- $f"; cat "$WORK/$f"; }; done
  echo "$failures check(s) failed"
  exit 1
fi
echo "all CLI connect e2e checks passed"
