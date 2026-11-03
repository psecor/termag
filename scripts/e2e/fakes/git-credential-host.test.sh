#!/usr/bin/env bash
# Tests fakes/git-credential-host, the credential helper E2E_REAL_GITHUB gives
# every box's git, and the git config fakes.sh gives a box for GitHub, without
# the network and without your credentials: "your" git is a temp HOME whose
# only helper answers a fake token, and every git command goes through a
# loopback proxy that answers each CONNECT itself, with a self-signed TLS
# endpoint that asks for credentials (401) and takes the fake token (200), so
# git asks its helpers, and sends them `store`, as github.com would make it,
# and nothing reaches github.com.
#
# Run: bash scripts/e2e/fakes/git-credential-host.test.sh
# here, ROOT, GITHUB_PORT and REAL_GITHUB are read by fakes.sh's functions.
# shellcheck disable=SC2034
set -uo pipefail

fakes=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# fakes.sh as up.sh sources it, for real_github_helper and
# fakes_box_github_gitconfig.
here=$(dirname "$fakes")
# shellcheck source=fakes.sh
. "$fakes/fakes.sh"
WORK=$(mktemp -d)
proxy_pid=
trap '[ -n "$proxy_pid" ] && kill "$proxy_pid" 2>/dev/null; rm -rf "$WORK"' EXIT

openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj /CN=github.com \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" >/dev/null 2>&1
cat >"$WORK/proxy.cjs" <<'EOF'
const http = require('http'), tls = require('tls'), fs = require('fs');
const [key, cert, portFile] = process.argv.slice(2);
const srv = http.createServer((_q, r) => { r.writeHead(400); r.end(); });
srv.on('connect', (_req, sock) => {
  sock.write('HTTP/1.1 200 Connection established\r\n\r\n');
  const t = new tls.TLSSocket(sock, { isServer: true, key: fs.readFileSync(key), cert: fs.readFileSync(cert) });
  let buf = '';
  const token = 'Basic ' + Buffer.from('x-access-token:fake-host-token').toString('base64');
  t.on('data', (d) => {
    buf += d;
    if (!buf.includes('\r\n\r\n')) return;
    // The fake token is taken, so git sends `store` to its helpers; the empty
    // body is not a ref advertisement, so the command still fails after that.
    if (buf.toLowerCase().includes(`\r\nauthorization: ${token.toLowerCase()}\r\n`)) {
      t.end('HTTP/1.1 200 OK\r\nContent-Type: application/x-git-upload-pack-advertisement\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    t.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="GitHub"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  t.on('error', () => {});
  sock.on('error', () => {});
});
srv.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, String(srv.address().port)));
EOF
node "$WORK/proxy.cjs" "$WORK/key.pem" "$WORK/cert.pem" "$WORK/proxy.port" &
proxy_pid=$!
for _ in $(seq 1 40); do [ -s "$WORK/proxy.port" ] && break; sleep 0.1; done
PROXY="http://127.0.0.1:$(cat "$WORK/proxy.port")"

failures=0
pass() { echo "ok:   $1"; }
fail() { echo "FAIL: $1"; echo "      want: $2"; echo "      got:  $3"; failures=$((failures + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "$2" "$3"; fi; }

# "Your" git: no system helper (the empty value resets the list), then one that
# answers get with a fake token and records every other action it is sent.
host="$WORK/host"
mkdir -p "$host"
cat >"$WORK/host-helper" <<EOF
#!/bin/sh
cat >/dev/null
[ "\$1" = get ] || { echo "\$1" >>"$WORK/host-actions"; exit 0; }
echo username=x-access-token
echo password=fake-host-token
EOF
chmod 0755 "$WORK/host-helper"
git config -f "$host/.gitconfig" --add credential.helper ''
git config -f "$host/.gitconfig" --add credential.helper "$WORK/host-helper"

# A box's GitHub git config, run twice each time (box.sh runs it on every
# start of a box), and once over the other mode's.
ROOT="$WORK/root" GITHUB_PORT=4580
stub="url.http://127.0.0.1:4580/_github.com/."
shape() { git config -f "$1" --get-regexp '^(url|credential)\.' | LC_ALL=C sort; }
REAL_GITHUB=
fakes_box_github_gitconfig "$WORK/stub.gitconfig"
fakes_box_github_gitconfig "$WORK/stub.gitconfig"
check "without E2E_REAL_GITHUB a box's git goes to the stub" \
  "$(printf '%s\n' "${stub}insteadof https://github.com/" "${stub}pushinsteadof git@github.com:" "${stub}pushinsteadof ssh://git@github.com/")" \
  "$(shape "$WORK/stub.gitconfig")"
REAL_GITHUB=1
real_shape=$(printf '%s\n' "${stub}pushinsteadof git@github.com:" "${stub}pushinsteadof https://github.com/" "${stub}pushinsteadof ssh://git@github.com/")
fakes_box_github_gitconfig "$WORK/real.gitconfig"
fakes_box_github_gitconfig "$WORK/real.gitconfig"
check "with it a box's git fetches from github.com and pushes, every way, to the stub" \
  "$real_shape" "$(shape "$WORK/real.gitconfig")"
fakes_box_github_gitconfig "$WORK/stub.gitconfig"
check "and a stub-mode config is rewritten, not added to" "$real_shape" "$(shape "$WORK/stub.gitconfig")"

# The helper as fakes.sh writes it, with "your" HOME, and the environment it
# gives every box agent.
box_extra=()
HOME="$host" real_github_helper
helper="$ROOT/real-github/git-credential"
check "the box's environment gives its git that helper alone" \
  "$(printf '%s\n' GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \
    GIT_CONFIG_KEY_1=credential.https://github.com.helper "GIT_CONFIG_VALUE_1=!'$helper'")" \
  "$(printf '%s\n' "${box_extra[@]}")"

# The helper, wrapped where fakes.sh put it to record whether it handed out a
# token.
mv "$helper" "$helper.real"
cat >"$helper" <<EOF
#!/usr/bin/env bash
out=\$("$helper.real" "\$@")
if grep -q '^password=fake-host-token$' <<<"\$out"; then echo "\$1 gave" >>"$WORK/asks"; else echo "\$1 none" >>"$WORK/asks"; fi
printf '%s\n' "\$out"
EOF
chmod 0755 "$helper"

# The box's HOME has a dotfiles .gitconfig with helpers of its own: git's
# credential-store, and one that records anything it is sent.
box="$WORK/box"
mkdir -p "$box"
cat >"$WORK/dotfiles-helper" <<EOF
#!/bin/sh
cat >/dev/null
echo "\$1" >>"$WORK/dotfiles-actions"
EOF
chmod 0755 "$WORK/dotfiles-helper"
git config -f "$box/.gitconfig" --add credential.helper store
git config -f "$box/.gitconfig" --add credential.helper "$WORK/dotfiles-helper"
check "the box's git reads the dotfiles helpers (without the environment they would be asked)" \
  "store $WORK/dotfiles-helper" \
  "$(env -i HOME="$box" PATH="$PATH" git config --global --get-all credential.helper | tr '\n' ' ' | sed 's/ $//')"
# No system gitconfig: the push below has to reach the helper, not be sent to
# the stub by pushInsteadOf.
box_git() {
  env -i HOME="$box" PATH="$PATH" GIT_CONFIG_SYSTEM=/dev/null "${box_extra[@]}" \
    GIT_TERMINAL_PROMPT=0 git -c "http.proxy=$PROXY" -c http.sslVerify=false "$@" >/dev/null 2>&1
}
asked() { local a; a=$(cat "$WORK/asks" 2>/dev/null); : >"$WORK/asks"; printf '%s' "$a" | tr '\n' ' ' | sed 's/ $//'; }

# The endpoint takes the token, so git sends it to every helper's `store`:
# that reaches the helper, which keeps nothing (checked at the end).
box_git ls-remote https://github.com/example-org/webapp
check "a git ls-remote of github.com gets your credential" "get gave store none" "$(asked)"

git init -q "$WORK/repo"
(cd "$WORK/repo" && box_git fetch https://github.com/example-org/webapp)
check "so does a git fetch" "get gave store none" "$(asked)"

box_git clone https://github.com/example-org/webapp "$WORK/clone"
check "and a git clone" "get gave store none" "$(asked)"

git -C "$WORK/repo" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m one
(cd "$WORK/repo" && box_git push https://github.com/example-org/webapp HEAD:refs/heads/e2e-never)
check "a git push gets nothing" "get none" "$(asked)"

out=$(printf 'protocol=https\nhost=github.com\nusername=x\n\n' | env -i HOME="$box" PATH="$PATH" \
  GIT_CONFIG_SYSTEM=/dev/null "${box_extra[@]}" GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null)
check "a bare git credential fill gets nothing" "get none no-password" \
  "$(asked) $(grep -q '^password=' <<<"$out" && echo password || echo no-password)"

check "another host gets nothing" "" \
  "$(printf 'protocol=https\nhost=example.com\n\n' | "$helper.real" get)"
check "plain http gets nothing" "" \
  "$(printf 'protocol=http\nhost=github.com\n\n' | "$helper.real" get)"

printf 'protocol=https\nhost=github.com\nusername=x\npassword=p\n\n' | "$helper.real" store
printf 'protocol=https\nhost=github.com\nusername=x\npassword=p\n\n' | "$helper.real" erase
check "store and erase (git's own, and these) never reach your git's helpers" "" "$(cat "$WORK/host-actions" 2>/dev/null)"
check "nor the box's dotfiles helpers, which are never asked either" "" \
  "$(cat "$WORK/dotfiles-actions" 2>/dev/null)$([ -e "$box/.git-credentials" ] && echo '.git-credentials written')"

if [ "$failures" -gt 0 ]; then
  echo "git-credential-host.test.sh: $failures failure(s)"
  exit 1
fi
echo "git-credential-host.test.sh: all checks passed"
