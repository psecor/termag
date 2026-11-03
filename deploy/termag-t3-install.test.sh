#!/bin/sh
# Tests deploy/termag-t3-install (and the deploy/termag-t3 launcher it installs).
#
#   * nothing pinned for this architecture, or no source for the pin: nothing
#     is written and --check is clean (an unhosted pin is not drift)
#   * an install verifies the pinned sha256, unpacks the one expected
#     directory, runs the server's --version before anything names it, then
#     points current at it, installs the launcher and writes the agent drop-in
#   * a bad digest, a wrong layout or a server that won't run names nothing
#     and leaves no temp dir
#   * a current box writes nothing; --check reports drift it could fix
#   * the launcher runs current/bin/t3 with the box's outbound defaults,
#     which a deliberate setting overrides; the server setting with no
#     variable (enableProviderUpdateChecks) is seeded only while unset
#   * an upgrade keeps the previous version and removes older ones, unless
#     a process still runs from one (Linux only: read from /proc)
#   * no writable root and no sudo: nothing happens, and that is not drift
#   * where user namespaces are restricted (Ubuntu 23.10+), the browser's
#     AppArmor profile is loaded, then installed, with sudo -n; one the parser
#     refuses is not installed, and without sudo -n it is not drift
#
# Run: sh deploy/termag-t3-install.test.sh
set -u

SCRIPT="$(cd "$(dirname "$0")" && pwd)/termag-t3-install"
WORK="$(mktemp -d)"

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}
check() {  # check DESC WANT GOT
  [ "$2" = "$3" ] || fail "$1" "$2" "$3"
}
has() {  # has DESC HAYSTACK NEEDLE
  case "$2" in *"$3"*) ;; *) fail "$1" "contains '$3'" "$2" ;; esac
}

sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

ROOT="$WORK/opt/termag-t3"
DEPLOY="$WORK/deploy"
HOME_DIR="$WORK/home"
STUB="$WORK/stub"
ART="$WORK/artifacts"
mkdir -p "$WORK/opt" "$DEPLOY" "$HOME_DIR" "$STUB" "$ART"
cp "$SCRIPT" "$DEPLOY/termag-t3-install"
cp "$(dirname "$SCRIPT")/termag-t3" "$DEPLOY/termag-t3"
cp "$(dirname "$SCRIPT")/t3-chrome-headless-shell.apparmor" "$DEPLOY/t3-chrome-headless-shell.apparmor"
# Never this host's: user namespaces are unrestricted here unless a case says so.
export TERMAG_T3_USERNS_RESTRICTION="$WORK/userns"
export TERMAG_T3_APPARMOR_PROFILE="$WORK/apparmor.d/t3-chrome-headless-shell"
export TERMAG_T3_APPARMOR_PARSER="$STUB/apparmor_parser"
chmod 755 "$DEPLOY/termag-t3-install" "$DEPLOY/termag-t3"
DROPIN="$HOME_DIR/.config/systemd/user/termag-agent.service.d/t3.conf"

cat > "$STUB/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "$WORK/systemctl.log"
EOF
chmod 755 "$STUB/systemctl"
export WORK

# make_artifact VERSION [LAYOUT]: a tarball shaped like package-box-server.sh's.
# LAYOUT: ok | wrongdir | broken (its bin/t3 exits 1)
make_artifact() {
  v=$1 layout=${2:-ok}
  stem="termag-t3-server-$v-linux-arm64"
  dir="$WORK/build/$v-$layout"
  top=$stem
  [ "$layout" = wrongdir ] && top="t3-$v-linux-arm64"
  mkdir -p "$dir/$top/bin" "$dir/$top/libexec"
  if [ "$layout" = broken ]; then
    printf '#!/bin/sh\necho "cannot execute binary file" >&2\nexit 1\n' > "$dir/$top/bin/t3"
  else
    # The fake server: --version prints its version; anything else prints
    # its arguments and the outbound settings it was started with.
    cat > "$dir/$top/bin/t3" <<EOF
#!/bin/sh
if [ "\${1:-}" = --version ]; then echo "$v"; exit 0; fi
echo "args: \$*"
env | grep -E '^(T3CODE_|T3_|TERMAG_)' | sort
EOF
  fi
  chmod 755 "$dir/$top/bin/t3"
  printf '{"version":"%s"}\n' "$v" > "$dir/$top/BUILD-INFO.json"
  tar -czf "$ART/$stem.tar.gz" -C "$dir" "$top"
  sha "$ART/$stem.tar.gz"
}

# pin VERSION ARM64_SHA [BASE_URL]
pin() {
  printf '# test pin\nversion=%s\nsha256_linux_arm64=%s\nsha256_linux_x64=\n\nbase_url=%s\n' "$1" "$2" "${3:-}" > "$DEPLOY/t3-server.pin"
}

run() {
  HOME="$HOME_DIR" PATH="$STUB:$PATH" TERMAG_T3_ROOT="$ROOT" TERMAG_T3_ARCH=aarch64 \
    TERMAG_T3_SUDO=false "$DEPLOY/termag-t3-install" "$@"
}

V1=0.1.1-aaaaaaaaaaaa
V2=0.1.2-bbbbbbbbbbbb
V3=0.1.3-cccccccccccc
S1=$(make_artifact "$V1")
S2=$(make_artifact "$V2")
S3=$(make_artifact "$V3")
BAD=$(make_artifact 9.9.9-badbadbadbad broken)
mv "$ART/termag-t3-server-9.9.9-badbadbadbad-linux-arm64.tar.gz" "$ART/broken.tar.gz"
WRONG=$(make_artifact 9.9.8-wrongwrongwr wrongdir)

# ── nothing pinned for this architecture ───────────────────────────────────
pin "$V1" ""
out=$(run 2>&1); rc=$?
check 'no digest for arm64: exit 0' 0 "$rc"
check 'no digest for arm64: silent' '' "$out"
check 'no digest for arm64: no root made' no "$([ -e "$ROOT" ] && echo yes || echo no)"
out=$(HOME="$HOME_DIR" TERMAG_T3_ROOT="$ROOT" TERMAG_T3_ARCH=x86_64 "$DEPLOY/termag-t3-install" --check 2>&1); rc=$?
check 'x64 with no x64 digest: --check clean' 0 "$rc"

# ── pinned, but no source (base_url unset, no override) ────────────────────
pin "$V1" "$S1"
out=$(run --check 2>&1); rc=$?
check 'no source: --check is clean (an unhosted pin is not drift)' 0 "$rc"
out=$(run 2>&1); rc=$?
check 'no source: exit 0' 0 "$rc"
check 'no source: nothing made' no "$([ -e "$ROOT" ] && echo yes || echo no)"

# ── with a source: --check reports, then the install ────────────────────────
mkdir -p "$ROOT"
pin "$V1" "$S1" "file://$ART"
out=$(run --check 2>&1); rc=$?
check 'base_url set, not installed: --check is drift' 1 "$rc"
has '--check names the missing version' "$out" "MISSING: t3 server $V1"
check '--check writes nothing' '' "$(ls -A "$ROOT")"
: > "$WORK/systemctl.log"
out=$(run 2>&1); rc=$?
check 'install: exit 0' 0 "$rc"
has 'install: reports the version' "$out" "reconciled: t3 server $V1 in $ROOT/$V1 ($V1)"
check 'install: current points at it' "$V1" "$(readlink "$ROOT/current")"
check 'install: digest recorded' "$S1" "$(cat "$ROOT/$V1/.termag-t3-sha256")"
check 'install: launcher installed' same "$(cmp -s "$DEPLOY/termag-t3" "$ROOT/bin/t3" && echo same)"
has 'install: drop-in names the launcher' "$(cat "$DROPIN")" "Environment=TERMAG_T3_COMMAND=$ROOT/bin/t3"
has 'install: daemon-reload after the drop-in' "$(cat "$WORK/systemctl.log")" 'systemctl --user daemon-reload'
SETTINGS="$HOME_DIR/.t3/userdata/settings.json"
if command -v jq >/dev/null 2>&1; then
  check 'install: provider update checks off in the server settings' false "$(jq -r .enableProviderUpdateChecks "$SETTINGS")"
  has 'install: says so' "$out" "reconciled: enableProviderUpdateChecks=false in $SETTINGS"
else
  echo "SKIP: no jq; the settings seed is not exercised"
fi
check 'install: no temp dir left' '' "$(cd "$ROOT" && ls -d .incoming.* 2>/dev/null)"

# The launcher, as the agent runs it.
out=$("$ROOT/bin/t3" --version)
check 'launcher: --version through current' "$V1" "$out"
out=$(env -u T3CODE_TELEMETRY_ENABLED -u T3CODE_OTEL_SDK_DISABLED "$ROOT/bin/t3" serve --port 1)
has 'launcher: passes the arguments' "$out" 'args: serve --port 1'
has 'launcher: analytics off by default' "$out" 'T3CODE_TELEMETRY_ENABLED=false'
has "launcher: the server's own OTLP export off" "$out" 'T3CODE_OTEL_SDK_DISABLED=true'
out=$(T3CODE_TELEMETRY_ENABLED=true "$ROOT/bin/t3" serve)
has 'launcher: a deliberate setting wins' "$out" 'T3CODE_TELEMETRY_ENABLED=true'
ln -s "$ROOT/bin/t3" "$WORK/t3-link"
check 'launcher: works through a symlink' "$V1" "$("$WORK/t3-link" --version)"

# ── a current box: silent, clean ────────────────────────────────────────────
out=$(run 2>&1); rc=$?
check 'current: exit 0' 0 "$rc"
check 'current: writes nothing' '' "$out"
out=$(run --check 2>&1); rc=$?
check 'current: --check clean' 0 "$rc"
# Even with no source left: an installed server is not drift.
pin "$V1" "$S1"
out=$(run --check 2>&1); rc=$?
check 'current, base_url unset: --check clean' 0 "$rc"

# An owner's own choice stays, and other keys survive.
if command -v jq >/dev/null 2>&1; then
  printf '{"enableProviderUpdateChecks":true,"theme":"dark"}\n' > "$SETTINGS"
  out=$(run --check 2>&1); rc=$?
  check "an owner's enableProviderUpdateChecks=true is not drift" 0 "$rc"
  printf '{"theme":"dark","providerInstances":{"claudeAgent":{"driver":"claudeAgent"}}}\n' > "$SETTINGS"
  out=$(run --check 2>&1); rc=$?
  check 'settings without the key: drift' 1 "$rc"
  has 'settings drift is named' "$out" "DRIFT: enableProviderUpdateChecks is unset in $SETTINGS"
  out=$(run 2>&1)
  check 'settings repair: key added' false "$(jq -r .enableProviderUpdateChecks "$SETTINGS")"
  check 'settings repair: other keys kept' 'dark claudeAgent' "$(jq -r '"\(.theme) \(.providerInstances.claudeAgent.driver)"' "$SETTINGS")"
  printf 'not json' > "$SETTINGS"
  out=$(run --check 2>&1); rc=$?
  check 'unreadable settings are left alone, not drift' 0 "$rc"
  check 'unreadable settings: untouched' 'not json' "$(cat "$SETTINGS")"
  printf '{"enableProviderUpdateChecks":false}\n' > "$SETTINGS"
fi

# ── the browser's AppArmor profile ─────────────────────────────────────────
cat > "$STUB/apparmor_parser" <<'EOF'
#!/bin/sh
echo "apparmor_parser $*" >> "$WORK/apparmor.log"
[ -z "${APPARMOR_FAIL:-}" ]
EOF
chmod 755 "$STUB/apparmor_parser"
mkdir -p "$WORK/apparmor.d"
PROFILE="$TERMAG_T3_APPARMOR_PROFILE"
# With sudo -n: `env` runs each command as this user.
with_sudo() {
  HOME="$HOME_DIR" PATH="$STUB:$PATH" TERMAG_T3_ROOT="$ROOT" TERMAG_T3_ARCH=aarch64 \
    TERMAG_T3_SUDO=env "$DEPLOY/termag-t3-install" "$@"
}
out=$(with_sudo --check 2>&1); rc=$?
check 'user namespaces unrestricted: no profile is not drift' 0 "$rc"
echo 0 > "$WORK/userns"
out=$(with_sudo 2>&1); rc=$?
check 'restriction off: writes nothing' '' "$out"
check 'restriction off: no profile' no "$([ -e "$PROFILE" ] && echo yes || echo no)"
echo 1 > "$WORK/userns"
out=$(run --check 2>&1); rc=$?
check 'restricted, no sudo -n: not drift' 0 "$rc"
out=$(with_sudo --check 2>&1); rc=$?
check 'restricted, no profile: drift' 1 "$rc"
has 'the profile drift is named' "$out" "DRIFT: $PROFILE is not installed"
out=$(APPARMOR_FAIL=1 with_sudo 2>&1); rc=$?
check 'a profile the parser refuses: exit 0' 0 "$rc"
has 'a refused profile: says so' "$out" "could not install $PROFILE"
check 'a refused profile: not installed' no "$([ -e "$PROFILE" ] && echo yes || echo no)"
: > "$WORK/apparmor.log"
out=$(with_sudo 2>&1); rc=$?
check 'profile install: exit 0' 0 "$rc"
has 'profile install: reported' "$out" "reconciled: $PROFILE"
# The installer names its own directory resolved (macOS: /var is /private/var).
check 'profile install: loaded from the checkout' "apparmor_parser -r $(cd -P "$DEPLOY" && pwd)/t3-chrome-headless-shell.apparmor" "$(cat "$WORK/apparmor.log")"
check 'profile install: in place' same "$(cmp -s "$DEPLOY/t3-chrome-headless-shell.apparmor" "$PROFILE" && echo same)"
: > "$WORK/apparmor.log"
out=$(with_sudo 2>&1); rc=$?
check 'profile current: writes nothing' '' "$out"
check 'profile current: not loaded again' '' "$(cat "$WORK/apparmor.log")"
out=$(with_sudo --check 2>&1); rc=$?
check 'profile current: --check clean' 0 "$rc"
rm -f "$WORK/userns"

# ── repairs that need no download ──────────────────────────────────────────
printf '#!/bin/sh\necho old\n' > "$ROOT/bin/t3"
rm -f "$DROPIN"
out=$(run --check 2>&1); rc=$?
check 'launcher + drop-in drift: --check exit 1' 1 "$rc"
has '--check names the launcher' "$out" "DRIFT: $ROOT/bin/t3 differs"
has '--check names the drop-in' "$out" "DRIFT: $DROPIN is not current"
out=$(run 2>&1); rc=$?
check 'repair with no source: exit 0' 0 "$rc"
check 'repair: launcher back' same "$(cmp -s "$DEPLOY/termag-t3" "$ROOT/bin/t3" && echo same)"
has 'repair: drop-in back' "$(cat "$DROPIN" 2>/dev/null)" "TERMAG_T3_COMMAND=$ROOT/bin/t3"

# ── failures name nothing ──────────────────────────────────────────────────
pin "$V2" "$S1" "file://$ART"   # V2's tarball, V1's digest
out=$(run 2>&1); rc=$?
check 'digest mismatch: exit 3' 3 "$rc"
has 'digest mismatch: says so' "$out" "not the pinned $S1"
check 'digest mismatch: current unchanged' "$V1" "$(readlink "$ROOT/current")"
check 'digest mismatch: no version dir' no "$([ -e "$ROOT/$V2" ] && echo yes || echo no)"
check 'digest mismatch: no temp dir left' '' "$(cd "$ROOT" && ls -d .incoming.* 2>/dev/null)"

pin 9.9.8-wrongwrongwr "$WRONG" "file://$ART"
out=$(run 2>&1); rc=$?
check 'wrong layout: exit 3' 3 "$rc"
has 'wrong layout: says so' "$out" 'does not hold exactly termag-t3-server-9.9.8-wrongwrongwr-linux-arm64/'

pin 9.9.9-badbadbadbad "$BAD"
out=$(TERMAG_T3_SERVER_SOURCE="$ART/broken.tar.gz" run 2>&1); rc=$?
check 'a server that will not run: exit 3' 3 "$rc"
has 'a server that will not run: its output' "$out" 'cannot execute binary file'
check 'a server that will not run: current unchanged' "$V1" "$(readlink "$ROOT/current")"
check 'a server that will not run: drop-in unchanged' "Environment=TERMAG_T3_COMMAND=$ROOT/bin/t3" "$(grep '^Environment=' "$DROPIN")"
check 'failures: no temp dir left' '' "$(cd "$ROOT" && ls -d .incoming.* 2>/dev/null)"

# A leftover from an interrupted run is removed by the next install.
mkdir -p "$ROOT/.incoming.stale1/unpacked"
pin "$V2" "$S2"
out=$(TERMAG_T3_SERVER_SOURCE="$ART/termag-t3-server-$V2-linux-arm64.tar.gz" run 2>&1); rc=$?
check 'override source (a path): exit 0' 0 "$rc"
check 'upgrade: current is V2' "$V2" "$(readlink "$ROOT/current")"
has 'upgrade: says what it was' "$out" "current -> $V2 (was $V1)"
check 'upgrade: previous kept' yes "$([ -d "$ROOT/$V1" ] && echo yes || echo no)"
check 'upgrade: stale temp dir removed' no "$([ -e "$ROOT/.incoming.stale1" ] && echo yes || echo no)"
check 'upgrade: launcher runs V2' "$V2" "$("$ROOT/bin/t3" --version)"

# ── the next upgrade removes the version before the previous one ───────────
# Old trees go at install time only; one a process still runs from (a t3
# server that has not restarted since) is kept until a later install.
pin "$V3" "$S3" "file://$ART"
if [ -d /proc/self ] && [ -x /bin/sleep ]; then
  cp /bin/sleep "$ROOT/$V1/libexec/sleeper"
  "$ROOT/$V1/libexec/sleeper" 30 &
  holder=$!
  out=$(run 2>&1); rc=$?
  check 'upgrade with V1 in use: exit 0' 0 "$rc"
  has 'upgrade with V1 in use: keeps it' "$out" "keeping $ROOT/$V1 (a process still runs from it)"
  kill "$holder" 2>/dev/null
  wait "$holder" 2>/dev/null
  check 'upgrade with V1 in use: V1 still there' yes "$([ -d "$ROOT/$V1" ] && echo yes || echo no)"
  removed_by='rollback'
else
  echo "SKIP: no /proc here; the in-use check is not exercised"
  out=$(run 2>&1); rc=$?
  check 'upgrade to V3: exit 0' 0 "$rc"
  has 'upgrade to V3: removes V1' "$out" "reconciled: removed $ROOT/$V1"
  removed_by='upgrade'
fi
check 'after V3: V2 kept' yes "$([ -d "$ROOT/$V2" ] && echo yes || echo no)"
check 'after V3: current is V3' "$V3" "$(readlink "$ROOT/current")"

# Back to the kept version: a rollback needs no download.
pin "$V2" "$S2"
out=$(run 2>&1); rc=$?
check 'rollback to the kept version: exit 0' 0 "$rc"
check 'rollback: current is V2' "$V2" "$(readlink "$ROOT/current")"
check 'rollback: V3 kept as the previous' yes "$([ -d "$ROOT/$V3" ] && echo yes || echo no)"
[ "$removed_by" = rollback ] && has 'rollback: removes the now idle V1' "$out" "reconciled: removed $ROOT/$V1"
check "V1 gone (by the $removed_by)" no "$([ -e "$ROOT/$V1" ] && echo yes || echo no)"

# ── no writable root and no sudo ───────────────────────────────────────────
NOROOT="$WORK/ro/opt-t3"
mkdir -p "$WORK/ro"
chmod 555 "$WORK/ro"
pin "$V1" "$S1" "file://$ART"
out=$(HOME="$HOME_DIR" PATH="$STUB:$PATH" TERMAG_T3_ROOT="$NOROOT" TERMAG_T3_ARCH=arm64 TERMAG_T3_SUDO=false \
  "$DEPLOY/termag-t3-install" --check 2>&1); rc=$?
if [ -w "$WORK/ro" ]; then
  echo "SKIP: running as root, a read-only parent is still writable"
else
  check 'no writable root: --check is not drift' 0 "$rc"
  out=$(HOME="$HOME_DIR" PATH="$STUB:$PATH" TERMAG_T3_ROOT="$NOROOT" TERMAG_T3_ARCH=arm64 TERMAG_T3_SUDO=false \
    "$DEPLOY/termag-t3-install" 2>&1); rc=$?
  check 'no writable root: exit 0' 0 "$rc"
  has 'no writable root: says why' "$out" "cannot create $NOROOT"
fi
chmod 755 "$WORK/ro"

# ── gh:// (a release asset, fetched with the box owner's gh login) ─────────
# gh api [--hostname H] [-H accept] <path> [--jq filter] over $WORK/artifacts:
# a release lists every tarball there as an asset whose id is its name.
cat > "$STUB/gh" <<'GHEOF'
#!/bin/sh
echo "GH_HOST=${GH_HOST:-} gh $*" >> "$WORK/gh.log"
[ "$1" = api ] || exit 1
shift
path= octet= want=
while [ $# -gt 0 ]; do
  case $1 in
    --hostname) shift 2 ;;
    -H) [ "$2" = 'Accept: application/octet-stream' ] && octet=1; shift 2 ;;
    --jq) want=$(printf '%s' "$2" | sed -n 's/.*\.name == "\([^"]*\)".*/\1/p'); shift 2 ;;
    *) path=$1; shift ;;
  esac
done
case $path in
  repos/*/releases/tags/*) [ -f "$WORK/artifacts/$want" ] && echo "$want"; exit 0 ;;
  repos/*/releases/assets/*)
    [ -n "$octet" ] || exit 1
    f="$WORK/artifacts/${path##*/}"
    [ -f "$f" ] || { echo "HTTP 404: Not Found" >&2; exit 1; }
    cat "$f" ;;
  *) exit 1 ;;
esac
GHEOF
chmod 755 "$STUB/gh"
GHROOT="$WORK/opt-gh/termag-t3"
mkdir -p "$GHROOT"
GHFILE="$WORK/termag-github.sh"
printf 'export GH_HOST=github-broker.example.invalid\n' > "$GHFILE"
run_gh() {  # run_gh [VAR=value ...]: the installer as a systemd unit runs it, with no GH_HOST
  env -u GH_HOST HOME="$HOME_DIR" PATH="$STUB:$PATH" TERMAG_T3_ROOT="$GHROOT" TERMAG_T3_ARCH=aarch64 \
    TERMAG_T3_SUDO=false TERMAG_T3_GH_HOST_FILE="$GHFILE" "$@" "$DEPLOY/termag-t3-install"
}
pin "$V2" "$S2" "gh://example-org/termag-desktop/termag-desktop-v0.1.0"
: > "$WORK/gh.log"
out=$(run_gh 2>&1); rc=$?
check 'gh://: installs' 0 "$rc"
has 'gh://: looks the asset up on the broker termag-credentials named' "$(cat "$WORK/gh.log")" \
  "gh api --hostname github-broker.example.invalid repos/example-org/termag-desktop/releases/tags/termag-desktop-v0.1.0 --jq"
has 'gh://: then fetches it as an octet stream from the broker' "$(cat "$WORK/gh.log")" \
  "gh api --hostname github-broker.example.invalid -H Accept: application/octet-stream repos/example-org/termag-desktop/releases/assets/termag-t3-server-$V2-linux-arm64.tar.gz"
check 'gh://: current is the pinned version' "$V2" "$(readlink "$GHROOT/current")"

VP=0.1.5+build.7-eeeeeeeeeeee  # a version with a + (the pin allows it)
SP=$(make_artifact "$VP")
pin "$VP" "$SP" "gh://example-org/termag-desktop/termag-desktop-v0.1.5"
out=$(run_gh 2>&1); rc=$?
check 'gh://: a version with a + installs' 0 "$rc"
check 'gh://: current is the + version' "$VP" "$(readlink "$GHROOT/current")"
pin "$V2" "$S2" "gh://example-org/termag-desktop/termag-desktop-v0.1.0"
run_gh >/dev/null 2>&1

V4=0.1.4-dddddddddddd  # pinned, but no release asset of it
pin "$V4" "$S1" "gh://example-org/termag-desktop/termag-desktop-v0.1.0/"
out=$(run_gh 2>&1); rc=$?
check 'gh://: a missing asset fails the install' 3 "$rc"
has 'gh://: says which asset the release lacks' "$out" "release termag-desktop-v0.1.0 of example-org/termag-desktop has no asset termag-t3-server-$V4-linux-arm64.tar.gz"
check 'gh://: a failed fetch leaves current alone' "$V2" "$(readlink "$GHROOT/current")"
: > "$WORK/gh.log"
out=$(run_gh GH_HOST=env.example.invalid 2>&1)
has 'gh://: a GH_HOST in the environment wins' "$(cat "$WORK/gh.log")" "gh api --hostname env.example.invalid"
: > "$WORK/gh.log"
out=$(run_gh TERMAG_T3_GH_HOST_FILE="$WORK/no-such-file" 2>&1)
has "gh://: no broker file (a box that skips github): github.com" "$(cat "$WORK/gh.log")" "gh api --hostname github.com"
pin "$V4" "$S1" "gh://example-org/termag-desktop"
out=$(run_gh 2>&1); rc=$?
check 'gh://: no tag is refused' 3 "$rc"
has 'gh://: says what a gh:// source is' "$out" "a gh:// source is gh://<owner>/<repo>/<tag>/<asset>"
pin "$V4" "$S1" 'gh://example-org/termag-desktop/v1"; .x'
out=$(run_gh 2>&1); rc=$?
check 'gh://: a tag that is not a plain name is refused' 3 "$rc"
rm -f "$STUB/gh"
if PATH="$STUB:/usr/bin:/bin" command -v gh >/dev/null 2>&1; then
  echo "SKIP: a gh in /usr/bin or /bin"
else
  out=$(env -u GH_HOST HOME="$HOME_DIR" PATH="$STUB:/usr/bin:/bin" TERMAG_T3_ROOT="$GHROOT" TERMAG_T3_ARCH=aarch64 \
    TERMAG_T3_SUDO=false "$DEPLOY/termag-t3-install" 2>&1); rc=$?
  check 'gh://: no gh CLI fails the install' 3 "$rc"
  has 'gh://: says gh is missing' "$out" "no gh CLI for gh://"
fi

case "$WORK" in
  /tmp/* | /var/folders/* | /private/var/folders/*) rm -rf -- "$WORK" ;;
  *) echo "left $WORK" ;;
esac

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "termag-t3-install: all tests passed"
