#!/bin/sh
# Tests deploy/termag-python-update, the box's Python updater,
# on deploy/termag-tool-update-lib, with uv,
# pyenv, the interpreters and the orchestrator (curl) stubbed:
#
#   * an update to a newer patch: latest is the newest CPython of the installed
#     minor uv lists for the platform (not an rc, not a free-threaded build),
#     installed by uv into a hidden staging directory with --no-config and none
#     of uv's environment, verified, moved into uv's directory with its
#     sysconfig on the final path, then pyenv's global and uv's minor link
#     switched; an older patch pruned, its pyenv name moved to the new one;
#     the one that ran kept; the report
#   * already current: nothing installed, current
#   * a verify failure (the stdlib, pip, the user's site-packages, a uv tool's
#     entry points or --version, the sysconfig prefix after the move) and a
#     switch that fails halfway: the old version stays the default, uv's
#     minor link stays, nothing staged is left
#   * an unpinned or unavailable target: another minor, a patch uv does not
#     list, a list that does not resolve, uv's install failing (its checksum)
#   * a process left on the old version: counted (left_on_old_python), and an
#     older patch a process runs from is kept
#   * pruning through a symlinked path: the home reached through a link, a
#     patch a live process runs from kept, an unused one removed
#   * no policy, run null, no uv, a pyenv global that is not uv's (named:
#     pyenv-built, missing), usage
#   * the old image (baked before 2026-09-30): pyenv global 3.13 on a
#     pyenv-built 3.13.15, an x.y.z on it, and system: named, the version that
#     runs reported, nothing installed or switched
#
# Run: sh deploy/termag-python-update.test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/termag-python-update"
WORK="$(mktemp -d)"
PIDS=''
cleanup() { for p in $PIDS; do kill "$p" 2>/dev/null; done; rm -rf "$WORK"; }
trap cleanup EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}
has() { case "$2" in *"$3"*) : ;; *) fail "$1" "$3" "$2" ;; esac; }
lacks() { case "$2" in *"$3"*) fail "$1" "(no '$3')" "$2" ;; esac; }
for c in flock jq; do
  command -v "$c" >/dev/null 2>&1 || { echo "SKIP: $c is required for this test"; exit 0; }
done

REAL_HOME="$WORK/home"
HOME_DIR=$REAL_HOME
STUB="$WORK/stub"
STATE="$WORK/state"
LOG="$WORK/calls"
PLAT=linux-test-gnu
OLD=3.13.16 NEW=3.13.18 OLDER=3.13.15 OLDEST=3.13.14
mkdir -p "$STUB" "$STATE"
export STATE LOG

# ── a fake CPython ──────────────────────────────────────────────────────────
# mkpy PREFIX VERSION: bin/python3.13 (python3 a link to it) that says Python
# VERSION, and answers the recipe's checks: check.py's modes (stdlib, prefix
# from its own sysconfig data, usersite and entrypoints from $STATE), -m pip,
# and a script's --version. $STATE/py-<V>-fail-<what> makes one fail;
# $STATE/py-<V>-usersite and -ep replace what that version imports.
mkpy() {
  p=$1 v=$2
  mkdir -p "$p/bin" "$p/lib/python3.13"
  printf "build_time_vars = {'prefix': '%s'}\n" "$p" > "$p/lib/python3.13/_sysconfigdata__test.py"
  cat > "$p/bin/python3.13" <<EOF
#!/bin/sh
V=$v
EOF
  cat >> "$p/bin/python3.13" <<'EOF'
me=$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)
[ "$1" = --version ] && { [ -e "$STATE/py-$V-fail-version" ] && { echo "Python 3.13.0"; exit 0; }; echo "Python $V"; exit 0; }
while :; do case "${1:-}" in -E|-P|-I|-s) shift ;; *) break ;; esac; done
echo "py[$V] $*" >> "$LOG"
case "${1:-}" in
  */check.py)
    [ -e "$STATE/py-$V-fail-$2" ] && exit 1
    case "$2" in
      stdlib) echo "ok OpenSSL_test sqlite 3.53" ;;
      prefix) sed -n "s/.*'prefix': '\([^']*\)'.*/\1/p" "$me/lib/python3.13/_sysconfigdata__test.py" ;;
      usersite) if [ -e "$STATE/py-$V-usersite" ]; then cat "$STATE/py-$V-usersite"; else printf 'ok six\nok yaml\n'; fi ;;
      entrypoints) if [ -e "$STATE/py-$V-ep" ]; then cat "$STATE/py-$V-ep"; else echo "ok poetry"; fi ;;
    esac ;;
  -m) [ "$2" = pip ] && [ -e "$STATE/py-$V-fail-pip" ] && exit 1; exit 0 ;;
  -c) exit 0 ;;
  *) [ -e "$STATE/py-$V-fail-script" ] && exit 1; exit 0 ;;
esac
EOF
  chmod +x "$p/bin/python3.13"; ln -sfn python3.13 "$p/bin/python3"
  # A binary of its own a process can run from (its /proc exe in the prefix).
  cp "$(command -v sleep)" "$p/bin/sleep-$v"
}

# ── stubs ───────────────────────────────────────────────────────────────────
# uv: --version, python dir, python list (from $STATE/uv-list.json), python
# install KEY (into UV_PYTHON_INSTALL_DIR, the install path in its sysconfig
# data, as uv writes it; fails while $STATE/uv-install-fails exists).
# mkuv DIR VERSION: that uv (and uvx) in DIR, whose list is
# $STATE/uv-list-<VERSION>.json when there is one, else $STATE/uv-list.json.
mkuv() {
  mkdir -p "$1"
  printf '#!/bin/sh\nUV_V=%s\n' "$2" > "$1/uv"
  cat "$STATE/uv-stub-body" >> "$1/uv"
  printf '#!/bin/sh\n[ "$1" = --version ] && echo "uvx %s (test)"\nexit 0\n' "$2" > "$1/uvx"
  chmod +x "$1/uv" "$1/uvx"
}
cat > "$STATE/uv-stub-body" <<'EOF'
echo "uv[$UV_V] $*" >> "$LOG"
env | grep '^UV_' | sort | sed 's/^/uv-env /' >> "$LOG"
case "$*" in *--no-config*) ;; *) echo "uv without --no-config" >> "$LOG" ;; esac
case "$1 $2" in
  '--version '*|'--version') echo "uv $UV_V (test)" ;;
  'python dir') echo "$HOME/.local/share/uv/python" ;;
  'python list') [ -e "$STATE/uv-list-fails" ] && exit 2; if [ -e "$STATE/uv-list-$UV_V.json" ]; then cat "$STATE/uv-list-$UV_V.json"; else cat "$STATE/uv-list.json"; fi ;;
  'python install')
    [ -e "$STATE/uv-install-fails" ] && { echo "error: Hash mismatch for cpython" >&2; exit 1; }
    for a in "$@"; do case "$a" in cpython-*) key=$a ;; esac; done
    d=${UV_PYTHON_INSTALL_DIR:?}/$key
    v=${key#cpython-}; v=${v%%-*}
    . "$STATE/mkpy.sh"; mkpy "$d" "$v"
    ln -sfn "$d" "$UV_PYTHON_INSTALL_DIR/cpython-3.13-${key#cpython-"$v"-}"
    echo "Installed Python $v" >&2 ;;
esac
EOF
# mkpy, for the uv stub.
{ echo 'STATE=${STATE:?}'; sed -n '/^mkpy() {/,/^}/p' "$0"; } > "$STATE/mkpy.sh"
mkuv "$STUB" 0.13.6
cat > "$STUB/curl" <<'EOF'
#!/bin/sh
out=/dev/stdout data= method=GET url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    --data-binary) data=$2; shift ;;
    -X) method=$2; shift ;;
    -K) [ "$2" = - ] && cat > "$STATE/curl-config"; shift ;;
    -m|-w|-H|--proto|--proto-redir) echo "curl-arg $1 $2" >> "$STATE/curl-args"; shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
echo "$method $url" >> "$STATE/curl-calls"
case "$url" in
  https://uv.example.test/*) f="$UVSRV/${url#https://uv.example.test/}"; [ -f "$f" ] || exit 22; cat "$f" > "$out" ;;
  */tool-update/policy\?*) cat "$STATE/policy-body" > "$out"; printf '%s' "$(cat "$STATE/policy-code")" ;;
  */tool-update/report) printf '%s\n' "$data" > "$STATE/report-body"; : > "$out"; printf 204 ;;
  *) exit 6 ;;
esac
EOF
chmod +x "$STUB/curl"

# uv's list: three patches of 3.13 for this platform, one for another, a
# free-threaded build and an rc above them, which latest never takes.
cat > "$STATE/uv-list.json" <<EOF
[{"key":"cpython-3.13.19-$PLAT-freethreaded","version":"3.13.19","implementation":"cpython","variant":"freethreaded","url":"https://example.test/ft.tar.gz"},
 {"key":"cpython-3.13.19rc1-$PLAT","version":"3.13.19rc1","implementation":"cpython","variant":"default","url":"https://example.test/rc.tar.gz"},
 {"key":"cpython-3.13.19-linux-other-gnu","version":"3.13.19","implementation":"cpython","variant":"default","url":"https://example.test/other.tar.gz"},
 {"key":"cpython-$NEW-$PLAT","version":"$NEW","implementation":"cpython","variant":"default","url":"https://example.test/$NEW.tar.gz"},
 {"key":"cpython-3.13.17-$PLAT","version":"3.13.17","implementation":"cpython","variant":"default","url":"https://example.test/3.13.17.tar.gz"},
 {"key":"cpython-$OLD-$PLAT","version":"$OLD","implementation":"cpython","variant":"default","url":"https://example.test/$OLD.tar.gz"},
 {"key":"pypy-3.13.99-$PLAT","version":"3.13.99","implementation":"pypy","variant":"default","url":"https://example.test/pypy.tar.gz"}]
EOF

# ── uv's release, pinned ────────────────────────────────────────────────────
# A release tarball as astral-sh/uv lays it out (uv-<arch>-unknown-linux-gnu/
# uv and uvx), for this box's arch, at uv.example.test/releases/<v>/, pinned
# by its sha256 as the recipe pins the real ones.
case "$(uname -m)" in x86_64|amd64) UVARCH=x86_64 ;; *) UVARCH=aarch64 ;; esac
UVSRV="$WORK/uvsrv"
mkuvrel() {  # mkuvrel VERSION: the release's tarball
  r="$WORK/uvrel/uv-$UVARCH-unknown-linux-gnu"; rm -rf "$WORK/uvrel"; mkuv "$r" "$1"
  mkdir -p "$UVSRV/releases/$1"
  tar -czf "$UVSRV/releases/$1/uv-$UVARCH-unknown-linux-gnu.tar.gz" -C "$WORK/uvrel" "uv-$UVARCH-unknown-linux-gnu"
}
mkuvrel 0.13.6
UVSUM=$(sha256sum "$UVSRV/releases/0.13.6/uv-$UVARCH-unknown-linux-gnu.tar.gz" | cut -c1-64)
OTHERARCH=x86_64; [ "$UVARCH" = x86_64 ] && OTHERARCH=aarch64
UV_PINS_TEST="0.13.6 $UVARCH $UVSUM
0.13.6 $OTHERARCH 0000000000000000000000000000000000000000000000000000000000000000
0.13.2 $UVARCH 1111111111111111111111111111111111111111111111111111111111111111"
export UVSRV UV_PINS_TEST
# uv 0.13.1's list: up to 3.13.16, as on the boxes that failed (2026-11-03).
old_uv() {
  mkuv "$REAL_HOME/.local/bin" 0.13.1
  jq '[.[] | select(.version != "3.13.18" and .version != "3.13.17")]' "$STATE/uv-list.json" > "$STATE/uv-list-0.13.1.json"
}
uv_left() { for f in "$REAL_HOME"/.local/bin/.uv*termag*; do [ -e "$f" ] && printf '%s ' "${f##*/}"; done; }
uv_at() { "$REAL_HOME/.local/bin/$1" --version 2>/dev/null | awk '{ print $2 }'; }

RUN_ID=cmvtrun0000000000000000009
printf '{"token":"tmag_box_token","termag_url":"wss://orch.example.test/termag/ws/agent"}\n' > "$WORK/agent.config.json"
policy() {  # policy CODE [TARGET [RUN]]
  printf '%s' "$1" > "$STATE/policy-code"
  printf '{"floor":"3.13.10","target":"%s","restart":"none","drainSec":0,"run":%s}' "${2:-latest}" "${3:-{\"id\":\"$RUN_ID\",\"component\":\"python\"\}}" > "$STATE/policy-body"
}

# The box: pyenv's global OLD, a link to uv's install of it, uv's minor link on
# it, an older patch with a pyenv name of its own, and a uv tool on the minor link.
box() {
  for p in $PIDS; do kill "$p" 2>/dev/null; done; PIDS=''
  rm -rf "$REAL_HOME"; mkdir -p "$REAL_HOME/.termag" "$REAL_HOME/.pyenv/bin" "$REAL_HOME/.pyenv/shims" "$REAL_HOME/.pyenv/versions" "$REAL_HOME/.local/share/uv/python" "$REAL_HOME/.local/bin"
  PYD=$REAL_HOME/.local/share/uv/python
  for v in "$OLD" "$OLDER" "$OLDEST"; do mkpy "$PYD/cpython-$v-$PLAT" "$v"; done
  ln -s "$PYD/cpython-$OLD-$PLAT" "$REAL_HOME/.pyenv/versions/$OLD"
  ln -s "$PYD/cpython-$OLDER-$PLAT" "$REAL_HOME/.pyenv/versions/$OLDER"
  ln -s "$PYD/cpython-$OLD-$PLAT" "$PYD/cpython-3.13-$PLAT"
  ln -s "$PYD/cpython-3.13-$PLAT/bin/python3.13" "$REAL_HOME/.local/bin/python3.13"
  echo "$OLD" > "$REAL_HOME/.pyenv/version"
  cat > "$REAL_HOME/.pyenv/bin/pyenv" <<'EOF'
#!/bin/sh
case "$1" in
  global)
    if [ -n "${2:-}" ]; then
      [ -e "$STATE/pyenv-global-fails-$2" ] && exit 1
      [ -e "$PYENV_ROOT/versions/$2" ] || { echo "pyenv: version '$2' not installed" >&2; exit 1; }
      echo "$2" > "$PYENV_ROOT/version"
    else cat "$PYENV_ROOT/version" 2>/dev/null || echo system; fi ;;
  rehash) echo "pyenv rehash" >> "$LOG" ;;
  # As pyenv's: a name that is no directory of its own resolves to the newest
  # version it prefixes (the old image's 3.13 -> 3.13.15).
  prefix)
    [ -d "$PYENV_ROOT/versions/${2:-}" ] && { echo "$PYENV_ROOT/versions/$2"; exit 0; }
    v=$(ls "$PYENV_ROOT/versions" | grep -F "${2:-none}." | sort -V | tail -n 1)
    [ -n "$v" ] || { echo "pyenv: version '${2:-}' not installed" >&2; exit 1; }
    echo "$PYENV_ROOT/versions/$v" ;;
esac
EOF
  # ($STATE/shim-stale: the shim still runs the old version, as a stale one would.)
  printf '#!/bin/sh\n[ -e "$STATE/shim-stale" ] && exec "$PYENV_ROOT/versions/%s/bin/python3" "$@"\nv=$(head -n 1 "$PYENV_ROOT/version")\nexec "$PYENV_ROOT/versions/$v/bin/python3" "$@"\n' "$OLD" > "$REAL_HOME/.pyenv/shims/python3"
  chmod +x "$REAL_HOME/.pyenv/bin/pyenv" "$REAL_HOME/.pyenv/shims/python3"
  T=$REAL_HOME/.local/share/uv/tools/poetry
  mkdir -p "$T/bin" "$T/lib/python3.13/site-packages"
  printf 'home = %s/bin\nimplementation = CPython\nversion_info = %s\n' "$PYD/cpython-3.13-$PLAT" "$OLD" > "$T/pyvenv.cfg"
  ln -s "$PYD/cpython-3.13-$PLAT/bin/python3.13" "$T/bin/python"
  printf '#!%s/bin/python\n' "$T" > "$T/bin/poetry"
  rm -f "$STATE"/py-* "$STATE"/pyenv-global-fails-* "$STATE/shim-stale" "$STATE/uv-install-fails" "$STATE/uv-list-fails" "$STATE/report-body" "$STATE/curl-calls" "$STATE/curl-config" "$STATE/curl-args" "$STATE/uv-list-0.13.1.json"
  : > "$LOG"
  policy 200
}
# shellcheck disable=SC2120  # callers pass env assignments only when they need them
run() {
  env -i PATH="${RUNPATH:-$STUB}:/usr/bin:/bin" HOME="$HOME_DIR" STATE="$STATE" LOG="$LOG" UVSRV="$UVSRV" \
    TERMAG_PYTHON_UV_DIST_URL=https://uv.example.test/releases TERMAG_PYTHON_UV_PINS="$UV_PINS_TEST" \
    UV_PYTHON_INSTALL_MIRROR=https://evil.example.test UV_PYTHON_DOWNLOADS_JSON_URL=https://evil.example.test/list.json \
    TERMAG_PYTHON_LOCK_WAIT=1 TERMAG_AGENT_CONFIG="$WORK/agent.config.json" TERMAG_POLICY_TIMEOUT=5 "$@" \
    bash "$SCRIPT" ${ARGS:---run $RUN_ID} 2>"$WORK/err"
}
report() { jq -r "$1" "$STATE/report-body" 2>/dev/null; }
global() { cat "$REAL_HOME/.pyenv/version"; }
minor_link() { readlink "$REAL_HOME/.local/share/uv/python/cpython-3.13-$PLAT"; }
hidden() { for d in "$REAL_HOME"/.local/share/uv/python/.termag-*; do [ -e "$d" ] && printf '%s ' "${d##*/}"; done; }
unchanged() {  # unchanged NAME: pyenv's global, uv's minor link, nothing new
  [ "$(global)" = "$OLD" ] || fail "$1: pyenv's global stays $OLD" "$OLD" "$(global)"
  [ "$(minor_link)" = "$PYD/cpython-$OLD-$PLAT" ] || fail "$1: uv's minor link stays on $OLD" "$PYD/cpython-$OLD-$PLAT" "$(minor_link)"
  [ ! -e "$PYD/cpython-$NEW-$PLAT" ] || fail "$1: no cpython-$NEW in uv's directory" absent present
  [ ! -e "$REAL_HOME/.pyenv/versions/$NEW" ] || fail "$1: no pyenv version $NEW" absent present
  case "$(hidden)" in *stage*) fail "$1: no staging directory left" none "$(hidden)" ;; esac
  [ -d "$PYD/cpython-$OLDER-$PLAT" ] || fail "$1: nothing pruned" "cpython-$OLDER kept" missing
}
old_proc() {  # old_proc VERSION: a live process running from that patch
  "$PYD/cpython-$1-$PLAT/bin/sleep-$1" 120 & PIDS="$PIDS $!"
}

# ── an update to a newer patch ──────────────────────────────────────────────
box
run; rc=$?; err=$(cat "$WORK/err")
[ "$rc" = 0 ] || fail 'update: exit 0' 0 "$rc ($err)"
has 'update: asks for python'"'"'s policy for this run' "$(cat "$STATE/curl-calls")" "tool-update/policy?component=python&run=$RUN_ID"
has 'update: the token on curl'"'"'s stdin' "$(cat "$STATE/curl-config" 2>/dev/null)" 'Bearer tmag_box_token'
has 'update: latest is the newest plain patch of the minor for the platform' "$err" "the policy's target latest is $NEW"
has 'update: uv installs exactly that build' "$(cat "$LOG")" "uv[0.13.6] python install --no-bin --no-registry --no-progress cpython-$NEW-$PLAT --no-config"
lacks 'update: every uv call takes --no-config' "$(cat "$LOG")" 'uv without --no-config'
lacks 'update: none of uv'"'"'s environment reaches it (no mirror, no downloads list)' "$(cat "$LOG")" 'uv-env UV_PYTHON_INSTALL_MIRROR'
lacks 'update: no downloads list' "$(cat "$LOG")" 'UV_PYTHON_DOWNLOADS_JSON_URL'
has 'update: the install goes to a hidden staging directory' "$(cat "$LOG")" "uv-env UV_PYTHON_INSTALL_DIR=$PYD/.termag-stage-"
[ "$(global)" = "$NEW" ] || fail "update: pyenv's global is $NEW" "$NEW" "$(global)"
[ "$(readlink "$REAL_HOME/.pyenv/versions/$NEW")" = "$PYD/cpython-$NEW-$PLAT" ] || fail "update: pyenv's $NEW is uv's install" "$PYD/cpython-$NEW-$PLAT" "$(readlink "$REAL_HOME/.pyenv/versions/$NEW")"
[ "$(minor_link)" = "$PYD/cpython-$NEW-$PLAT" ] || fail "update: uv's minor link is on $NEW" "$PYD/cpython-$NEW-$PLAT" "$(minor_link)"
has 'update: the sysconfig prefix is the final path' "$(cat "$PYD/cpython-$NEW-$PLAT/lib/python3.13/_sysconfigdata__test.py")" "'prefix': '$PYD/cpython-$NEW-$PLAT'"
[ -z "$(hidden)" ] || fail 'update: no staging directory left' none "$(hidden)"
for c in 'check.py stdlib' '-m pip --version' 'check.py usersite' 'check.py entrypoints'; do
  has "update: the new interpreter is checked ($c)" "$(grep "^py\[$NEW\]" "$LOG")" "$c"
done
has 'update: the user'"'"'s site-packages are compared with the old one'"'"'s' "$(grep "^py\[$OLD\]" "$LOG")" 'check.py usersite'
has 'update: the uv tool runs on the new interpreter' "$err" "tool poetry: entry points load on Python $NEW (poetry); --version runs: poetry"
[ -d "$PYD/cpython-$OLD-$PLAT" ] || fail 'update: the version that ran stays' present missing
[ ! -e "$PYD/cpython-$OLDER-$PLAT" ] || fail "update: an older patch nothing runs is pruned" absent present
[ ! -e "$PYD/cpython-$OLDEST-$PLAT" ] || fail "update: the oldest patch is pruned too" absent present
[ "$(readlink -f "$REAL_HOME/.pyenv/versions/$OLDER")" = "$PYD/cpython-$NEW-$PLAT" ] || fail "update: pyenv's $OLDER now runs $NEW (its venvs keep working)" "$PYD/cpython-$NEW-$PLAT" "$(readlink -f "$REAL_HOME/.pyenv/versions/$OLDER")"
[ "$(report .outcome)" = updated ] || fail 'update: the report says updated' updated "$(report .outcome)"
[ "$(report .component)/$(report .fromVersion)->$(report .toVersion)/$(report .target)" = "python/$OLD->$NEW/$NEW" ] || fail 'update: the report'"'"'s versions' "python/$OLD->$NEW/$NEW" "$(report .component)/$(report .fromVersion)->$(report .toVersion)/$(report .target)"
has 'update: the report says what switched' "$(report .detail)" "python=$OLD->$NEW verify=ok switch=pyenv=$NEW,uv-minor-link tools=1"
has 'update: the report counts what is left on the old Python' "$(report .detail)" 'left_on_old_python=0'
has 'update: no sessions' "$(report .detail)" 'restart=none'
[ "$(report '.panes | length')" = 0 ] || fail 'update: no panes' 0 "$(report '.panes | length')"

# ── already current ─────────────────────────────────────────────────────────
: > "$LOG"; rm -f "$STATE/report-body"
run; rc=$?; err=$(cat "$WORK/err")
[ "$rc" = 0 ] || fail 'current: exit 0' 0 "$rc"
[ "$(report .outcome)" = current ] || fail 'current: the report says current' current "$(report .outcome)"
lacks 'current: nothing installed' "$(cat "$LOG")" 'python install'
[ "$(global)" = "$NEW" ] || fail 'current: pyenv stays' "$NEW" "$(global)"

# ── a verify failure leaves the old version the default ─────────────────────
for what in stdlib pip version usersite entrypoints script; do
  box
  case "$what" in
    usersite) printf 'ok six\nfail yaml ImportError\n' > "$STATE/py-$NEW-usersite"; want='FAILED:user-site' ;;
    entrypoints) printf 'fail poetry ImportError\n' > "$STATE/py-$NEW-ep"; want='FAILED:tool:poetry' ;;
    script) : > "$STATE/py-$NEW-fail-script"; want='FAILED:tool:poetry' ;;
    *) : > "$STATE/py-$NEW-fail-$what"; want="FAILED:$what" ;;
  esac
  run; rc=$?; err=$(cat "$WORK/err")
  unchanged "verify ($what)"
  [ "$(report .outcome)" = failed ] || fail "verify ($what): the report says failed" failed "$(report .outcome)"
  has "verify ($what): the report says which check" "$(report .detail)" "python=$OLD->FAILED:verify verify=$want"
  [ "$rc" = 0 ] || fail "verify ($what): exit 0 (the old version is current enough, nothing rejected)" 0 "$rc"
  [ ! -e "$REAL_HOME/.termag/python-update.rejected" ] || fail "verify ($what): nothing rejected" absent present
done
# A module that did not import on the old Python either is no regression.
box
printf 'ok six\nfail broken ImportError\n' > "$STATE/py-$OLD-usersite"; printf 'ok six\nfail broken ImportError\n' > "$STATE/py-$NEW-usersite"
run; [ "$(report .outcome)" = updated ] || fail 'verify: a module broken on both is not a regression' updated "$(report .outcome) $(cat "$WORK/err")"
# The sysconfig prefix after the move: an install path that is not rewritten.
box
cat > "$WORK/sed" <<'EOF'
#!/bin/sh
case "$1" in -i) exit 0 ;; esac
exec /bin/sed "$@"
EOF
chmod +x "$WORK/sed"; mkdir -p "$WORK/sedpath"; cp "$WORK/sed" "$WORK/sedpath/sed"
RUNPATH="$WORK/sedpath:$STUB" run; err=$(cat "$WORK/err")
[ "$(global)" = "$OLD" ] || fail "prefix: pyenv's global stays $OLD" "$OLD" "$(global)"
[ "$(minor_link)" = "$PYD/cpython-$OLD-$PLAT" ] || fail 'prefix: the minor link stays' "$PYD/cpython-$OLD-$PLAT" "$(minor_link)"
[ ! -e "$PYD/cpython-$NEW-$PLAT" ] || fail 'prefix: the new version is moved aside' absent present
has 'prefix: set aside for a retry' "$(hidden)" ".termag-rejected-cpython-$NEW-$PLAT-"
has 'prefix: the report says why' "$(report .detail)" 'verify=FAILED:prefix'
# A switch that fails halfway (pyenv refuses the new global) is put back.
box
: > "$STATE/pyenv-global-fails-$NEW"
run; rc=$?; err=$(cat "$WORK/err")
unchanged 'switch'
has 'switch: put back' "$(report .detail)" "switch=FAILED:pyenv-global,restored:$OLD"
[ "$(report .outcome)" = failed ] || fail 'switch: failed' failed "$(report .outcome)"
[ ! -e "$REAL_HOME/.termag/python-update.rejected" ] || fail 'switch: restored, so nothing rejected' absent present

# uv's python3.13 in ~/.local/bin linked to a patch directly (as uv leaves it
# after an older patch's install): switched to the minor link, and put back
# when the switch fails.
box
ln -sfn "$PYD/cpython-$OLDER-$PLAT/bin/python3.13" "$REAL_HOME/.local/bin/python3.13"
run; err=$(cat "$WORK/err")
[ "$(readlink "$REAL_HOME/.local/bin/python3.13")" = "$PYD/cpython-3.13-$PLAT/bin/python3.13" ] || fail 'bin link: python3.13 follows the minor link' "$PYD/cpython-3.13-$PLAT/bin/python3.13" "$(readlink "$REAL_HOME/.local/bin/python3.13")"
has 'bin link: the switch says so' "$(report .detail)" "switch=pyenv=$NEW,uv-minor-link,bin-link"
[ ! -e "$PYD/cpython-$OLDER-$PLAT" ] || fail 'bin link: the patch it named is pruned once nothing names it' absent present
box
ln -sfn "$PYD/cpython-$OLDER-$PLAT/bin/python3.13" "$REAL_HOME/.local/bin/python3.13"
: > "$STATE/shim-stale"
run
unchanged 'shim check'
has 'shim check: the whole switch put back' "$(report .detail)" "switch=FAILED:check,restored:$OLD"
[ "$(readlink "$REAL_HOME/.local/bin/python3.13")" = "$PYD/cpython-$OLDER-$PLAT/bin/python3.13" ] || fail 'bin link: put back with the rest' "$PYD/cpython-$OLDER-$PLAT/bin/python3.13" "$(readlink "$REAL_HOME/.local/bin/python3.13")"

# A patch newer than the target (an owner's own uv install) stays, and so do
# uv's minor link and its pyenv name (Devin on #1219).
box
mkpy "$PYD/cpython-3.13.20-$PLAT" 3.13.20
ln -s "$PYD/cpython-3.13.20-$PLAT" "$REAL_HOME/.pyenv/versions/3.13.20"
ln -sfn "$PYD/cpython-3.13.20-$PLAT" "$PYD/cpython-3.13-$PLAT"
policy 200 "$NEW"
run; err=$(cat "$WORK/err")
[ "$(global)" = "$NEW" ] || fail 'newer: pyenv moves to the target' "$NEW" "$(global) ($err)"
[ -d "$PYD/cpython-3.13.20-$PLAT" ] || fail 'newer: a patch newer than the target is never pruned' present missing
[ "$(readlink "$REAL_HOME/.pyenv/versions/3.13.20")" = "$PYD/cpython-3.13.20-$PLAT" ] || fail 'newer: its pyenv name stays its own' "$PYD/cpython-3.13.20-$PLAT" "$(readlink "$REAL_HOME/.pyenv/versions/3.13.20")"
[ "$(minor_link)" = "$PYD/cpython-3.13.20-$PLAT" ] || fail 'newer: uv'"'"'s minor link is never moved down' "$PYD/cpython-3.13.20-$PLAT" "$(minor_link)"
[ ! -e "$PYD/cpython-$OLDER-$PLAT" ] || fail 'newer: an older patch still goes' absent present

# ...and kept by its version alone, when no link names it.
box
mkpy "$PYD/cpython-3.13.20-$PLAT" 3.13.20
policy 200 "$NEW"
run
[ -d "$PYD/cpython-3.13.20-$PLAT" ] || fail 'newer, unlinked: still never pruned' present missing

# uv's own lock held past the wait: nothing switches (Devin on #1219).
box
flock "$PYD/.lock" sleep 20 & PIDS="$PIDS $!"; sleep 0.3
run TERMAG_PYTHON_UV_LOCK_WAIT=1; err=$(cat "$WORK/err")
unchanged 'uv lock'
has 'uv lock: the run says why' "$(report .detail)" "python=$OLD->FAILED:uv-lock"
[ "$(report .outcome)" = failed ] || fail 'uv lock: failed' failed "$(report .outcome)"
has 'uv lock: the verified version is set aside for a retry' "$(hidden)" ".termag-rejected-cpython-$NEW-$PLAT-"
# ...and a later run removes what it set aside.
for p in $PIDS; do kill "$p" 2>/dev/null; done; PIDS=''; sleep 0.2
run; [ "$(global)" = "$NEW" ] || fail 'uv lock: the next run switches' "$NEW" "$(global)"
[ -z "$(hidden)" ] || fail 'uv lock: the next run removes the copy set aside' none "$(hidden)"

# pyenv's global a name an earlier prune pointed at another patch: the version
# is the uv install it resolves to, and a rollback puts the name back (Devin on #1219).
box
ln -sfn "$PYD/cpython-$OLD-$PLAT" "$REAL_HOME/.pyenv/versions/$OLDER"
echo "$OLDER" > "$REAL_HOME/.pyenv/version"
: > "$STATE/shim-stale"
run; err=$(cat "$WORK/err")
lacks 'redirected name: still uv'"'"'s' "$(report .detail)" 'not-uv-managed'
has 'redirected name: the version is the patch it runs' "$(report .detail)" "python=$OLD->FAILED:switch"
[ "$(global)" = "$OLDER" ] || fail 'redirected name: a rollback puts the name back' "$OLDER" "$(global)"
rm -f "$STATE/shim-stale"
run; err=$(cat "$WORK/err")
[ "$(global)" = "$NEW" ] || fail 'redirected name: updates' "$NEW" "$(global) ($err)"
[ "$(report .fromVersion)" = "$OLD" ] || fail 'redirected name: from the patch it ran' "$OLD" "$(report .fromVersion)"

# ── an unpinned or unavailable target ───────────────────────────────────────
box; policy 200 3.14.1
run; err=$(cat "$WORK/err")
unchanged 'other minor'
has 'other minor: never a new minor' "$(report .detail)" "python=$OLD->FAILED:other-minor:3.14.1"
[ "$(report .outcome)" = failed ] || fail 'other minor: failed' failed "$(report .outcome)"
lacks 'other minor: nothing installed' "$(cat "$LOG")" 'python install'
box; policy 200 3.13.99
run; err=$(cat "$WORK/err")
unchanged 'unavailable'
has 'unavailable: a patch uv does not list for the platform' "$(report .detail)" "python=$OLD->FAILED:not-available:3.13.99"
lacks 'unavailable: nothing installed' "$(cat "$LOG")" 'python install'
box; : > "$STATE/uv-list-fails"
run; err=$(cat "$WORK/err")
unchanged 'unresolved'
[ "$(report .outcome)" = failed ] || fail 'unresolved: latest that resolves to nothing fails' failed "$(report .outcome)"
box; : > "$STATE/uv-install-fails"
run; err=$(cat "$WORK/err")
unchanged 'uv install fails'
has 'uv install fails: its checksum, or a download that did not complete' "$(report .detail)" "python=$OLD->FAILED:install"
box; policy 200 3.13.17
run; [ "$(global)" = 3.13.17 ] || fail 'exact: an exact patch of the minor' 3.13.17 "$(global)"
box; policy 200 3.13.12
run; [ "$(global)" = "$OLD" ] || fail 'downgrade: never down' "$OLD" "$(global)"; has 'downgrade: says so' "$(report .detail)" "python=$OLD(no-downgrade)"

# ── a process left on the old version ───────────────────────────────────────
box
old_proc "$OLD"; old_proc "$OLDER"; sleep 0.3
run; err=$(cat "$WORK/err")
[ "$(global)" = "$NEW" ] || fail 'left: still switches' "$NEW" "$(global)"
has 'left: counted in the report' "$(report .detail)" 'left_on_old_python=1'
[ -d "$PYD/cpython-$OLDER-$PLAT" ] || fail 'left: an older patch a process runs from is kept' present missing
has 'left: kept, and why' "$(report .detail)" "kept=cpython-$OLDER-$PLAT(in-use)"
[ "$(readlink -f "$REAL_HOME/.pyenv/versions/$OLDER")" = "$PYD/cpython-$OLDER-$PLAT" ] || fail "left: a kept patch keeps its pyenv name" "$PYD/cpython-$OLDER-$PLAT" "$(readlink -f "$REAL_HOME/.pyenv/versions/$OLDER")"
[ ! -e "$PYD/cpython-$OLDEST-$PLAT" ] || fail 'left: an unused one goes' absent present

# ── pruning through a symlinked path ────────────────────────────────────────
box
ln -s "$REAL_HOME" "$WORK/home-link"
old_proc "$OLDER"; sleep 0.3
HOME_DIR="$WORK/home-link" run; err=$(cat "$WORK/err")
[ "$(global)" = "$NEW" ] || fail 'symlinked home: switches' "$NEW" "$(global) ($err)"
[ -d "$PYD/cpython-$OLDER-$PLAT" ] || fail 'symlinked home: a patch a process runs from is kept (canonical paths)' present missing
[ -d "$PYD/cpython-$OLD-$PLAT" ] || fail 'symlinked home: the one that ran is kept' present missing
[ -d "$PYD/cpython-$NEW-$PLAT" ] || fail 'symlinked home: the new one is kept' present missing
[ ! -e "$PYD/cpython-$OLDEST-$PLAT" ] || fail 'symlinked home: an unused one is removed' absent present
rm -f "$WORK/home-link"

# ── nothing asked of it ─────────────────────────────────────────────────────
box; policy 503
run; rc=$?
unchanged 'no policy'
[ "$(report .outcome)" = failed ] || fail 'no policy: failed, never current' failed "$(report .outcome)"
box; policy 200 latest null
run; rc=$?
unchanged 'run null'; [ "$rc" = 0 ] || fail 'run null: exit 0' 0 "$rc"
box; mkdir -p "$WORK/nouv"; cp "$STUB/curl" "$WORK/nouv/"
RUNPATH="$WORK/nouv" run
unchanged 'no uv'; has 'no uv: says so' "$(report .detail)" 'FAILED:no-uv'
box; rm -f "$REAL_HOME/.pyenv/versions/$OLD"; mkdir -p "$REAL_HOME/.pyenv/versions/$OLD/bin"; cp "$PYD/cpython-$OLD-$PLAT/bin/python3.13" "$REAL_HOME/.pyenv/versions/$OLD/bin/python3"
run
has "not uv's: a pyenv build is not this recipe's, and says so" "$(report .detail)" "python=$OLD->FAILED:not-uv-managed(pyenv-built)"
[ "$(global)" = "$OLD" ] || fail "not uv's: unchanged" "$OLD" "$(global)"
[ "$(report .fromVersion)/$(report .toVersion)/$(report .outcome)" = "$OLD/$OLD/failed" ] || fail "not uv's: reports the version that runs" "$OLD/$OLD/failed" "$(report .fromVersion)/$(report .toVersion)/$(report .outcome)"
box; rm -f "$REAL_HOME/.pyenv/versions/$OLD"; ln -s "$WORK/nowhere" "$REAL_HOME/.pyenv/versions/$OLD"
run
has "not uv's: a version that is not there" "$(report .detail)" "python=$OLD->FAILED:not-uv-managed(missing)"

# ── the old image ───────────────────────────────────────────────────────────
# Baked before 2026-09-30: `pyenv install 3.13` built CPython 3.13.15 into
# ~/.pyenv/versions/3.13.15 (a directory, not uv's), `pyenv global 3.13`, and
# no uv CPython at all. The run says what it found, carries the version that
# runs, and installs or switches nothing.
oldimage() {
  box
  rm -rf "$REAL_HOME/.pyenv/versions"/* "$PYD"/cpython-*
  mkpy "$REAL_HOME/.pyenv/versions/$OLDER" "$OLDER"
  echo 3.13 > "$REAL_HOME/.pyenv/version"
}
oldimage; policy 200 "$NEW"
run; rc=$?
has 'old image: names the layout' "$(report .detail)" 'python=3.13->FAILED:pyenv-global-not-a-version'
[ "$(report .outcome)" = failed ] || fail 'old image: failed' failed "$(report .outcome)"
[ "$(report .fromVersion) -> $(report .toVersion)" = "$OLDER -> $OLDER" ] || fail 'old image: the version that runs' "$OLDER -> $OLDER" "$(report .fromVersion) -> $(report .toVersion)"
[ "$(global)" = 3.13 ] || fail 'old image: pyenv global stays 3.13' 3.13 "$(global)"
lacks 'old image: nothing installed' "$(cat "$LOG")" 'python install'
[ "$(ls "$PYD")" = '' ] || fail 'old image: nothing in uv'"'"'s directory' '' "$(ls "$PYD")"
[ "$(ls "$REAL_HOME/.pyenv/versions")" = "$OLDER" ] || fail 'old image: pyenv versions untouched' "$OLDER" "$(ls "$REAL_HOME/.pyenv/versions")"
# An x.y.z global on the old image's pyenv-built CPython.
oldimage; echo "$OLDER" > "$REAL_HOME/.pyenv/version"
run
has 'old image, x.y.z: pyenv-built' "$(report .detail)" "python=$OLDER->FAILED:not-uv-managed(pyenv-built)"
[ "$(report .fromVersion) -> $(report .toVersion)" = "$OLDER -> $OLDER" ] || fail 'old image, x.y.z: the version that runs' "$OLDER -> $OLDER" "$(report .fromVersion) -> $(report .toVersion)"
lacks 'old image, x.y.z: nothing installed' "$(cat "$LOG")" 'python install'
# No version file: pyenv's global is system.
oldimage; rm -f "$REAL_HOME/.pyenv/version"
run
has 'system: not a version' "$(report .detail)" 'python=system->FAILED:pyenv-global-not-a-version'
[ "$(report .outcome)" = failed ] || fail 'system: failed' failed "$(report .outcome)"
box
ARGS='--run nope' run; rc=$?; [ "$rc" = 2 ] || fail 'usage: a bad run id' 2 "$rc"
ARGS='--bogus' run; rc=$?; [ "$rc" = 2 ] || fail 'usage: an unknown flag' 2 "$rc"

# ── uv too old to know the patch ────────────────────────────────────────────
# The box's uv lists no CPython for the patch: uv is brought to its pin (HTTPS
# only, checked against the pin before it is unpacked, the staged one checked
# before it replaces anything), then the install is tried once more.
box; old_uv; policy 200 "$NEW"
run; rc=$?; err=$(cat "$WORK/err")
[ "$rc" = 0 ] || fail 'old uv: exit 0' 0 "$rc ($err)"
[ "$(global)" = "$NEW" ] || fail "old uv: ends on $NEW" "$NEW" "$(global)"
[ "$(uv_at uv)/$(uv_at uvx)" = 0.13.6/0.13.6 ] || fail 'old uv: uv and uvx are the pinned 0.13.6' 0.13.6/0.13.6 "$(uv_at uv)/$(uv_at uvx)"
has 'old uv: the detail says uv moved' "$(report .detail)" 'uv=0.13.1->0.13.6'
has 'old uv: the newest pin for the arch, from the release' "$(cat "$STATE/curl-calls")" "GET https://uv.example.test/releases/0.13.6/uv-$UVARCH-unknown-linux-gnu.tar.gz"
has 'old uv: HTTPS only' "$(cat "$STATE/curl-args")" "curl-arg --proto =https"
has 'old uv: HTTPS only, redirects too' "$(cat "$STATE/curl-args")" "curl-arg --proto-redir =https"
has 'old uv: the new uv installs the patch' "$(cat "$LOG")" "uv[0.13.6] python install --no-bin --no-registry --no-progress cpython-$NEW-$PLAT"
lacks 'old uv: the old uv never installs it' "$(cat "$LOG")" 'uv[0.13.1] python install'
[ -z "$(uv_left)" ] || fail 'old uv: no old copy or staged one left' none "$(uv_left)"
[ "$(report .outcome)" = updated ] || fail 'old uv: updated' updated "$(report .outcome)"

# A current uv is left alone.
box; mkuv "$REAL_HOME/.local/bin" 0.13.6; policy 200 "$NEW"
run
[ "$(global)" = "$NEW" ] || fail 'current uv: updates' "$NEW" "$(global)"
lacks 'current uv: nothing downloaded for uv' "$(cat "$STATE/curl-calls")" 'uv.example.test'
has 'current uv: uv as it was' "$(report .detail)" 'uv=0.13.6 '

# A download that is not its pin is never unpacked; uv and Python stay.
box; old_uv; policy 200 "$NEW"
run TERMAG_PYTHON_UV_PINS="0.13.6 $UVARCH $(printf 'a%.0s' $(seq 64))"
unchanged 'uv digest'
has 'uv digest: fails not-available, uv untouched' "$(report .detail)" "python=$OLD->FAILED:not-available:$NEW"
has 'uv digest: says why' "$(report .detail)" 'uv=0.13.1->FAILED:digest:0.13.6'
[ "$(uv_at uv)" = 0.13.1 ] || fail 'uv digest: uv stays 0.13.1' 0.13.1 "$(uv_at uv)"
lacks 'uv digest: nothing of the download ever runs' "$(cat "$LOG")" 'uv[0.13.6]'

# A staged uv that does not say its version replaces nothing.
box; old_uv; policy 200 "$NEW"
mkdir -p "$WORK/lie/releases/0.13.6"; r="$WORK/lierel/uv-$UVARCH-unknown-linux-gnu"; rm -rf "$WORK/lierel"; mkuv "$r" 0.13.5
tar -czf "$WORK/lie/releases/0.13.6/uv-$UVARCH-unknown-linux-gnu.tar.gz" -C "$WORK/lierel" "uv-$UVARCH-unknown-linux-gnu"
run UVSRV="$WORK/lie" TERMAG_PYTHON_UV_PINS="0.13.6 $UVARCH $(sha256sum "$WORK/lie/releases/0.13.6/uv-$UVARCH-unknown-linux-gnu.tar.gz" | cut -c1-64)"
unchanged 'uv version'
has 'uv version: says why' "$(report .detail)" 'uv=0.13.1->FAILED:version:0.13.6'
[ "$(uv_at uv)" = 0.13.1 ] || fail 'uv version: uv stays 0.13.1' 0.13.1 "$(uv_at uv)"

# The pinned uv lists no build of the patch either: uv untouched, not-available as before.
box; old_uv; policy 200 3.13.17
jq '[.[] | select(.version != "3.13.17")]' "$STATE/uv-list.json" > "$STATE/uv-list-0.13.6.json"
run
rm -f "$STATE/uv-list-0.13.6.json"
unchanged 'pinned uv lacks it'
has 'pinned uv lacks it: not-available' "$(report .detail)" "python=$OLD->FAILED:not-available:3.13.17"
has 'pinned uv lacks it: says so' "$(report .detail)" 'uv=0.13.1(pinned-0.13.6-lists-no-3.13.17)'
[ "$(uv_at uv)" = 0.13.1 ] || fail 'pinned uv lacks it: uv stays 0.13.1' 0.13.1 "$(uv_at uv)"

# The new uv's Python install, or its verification, fails: uv goes back to what it was.
for what in install verify; do
  box; old_uv; policy 200 "$NEW"
  case "$what" in install) : > "$STATE/uv-install-fails" ;; verify) : > "$STATE/py-$NEW-fail-stdlib" ;; esac
  run
  unchanged "uv put back ($what)"
  [ "$(uv_at uv)/$(uv_at uvx)" = 0.13.1/0.13.1 ] || fail "uv put back ($what): uv and uvx are 0.13.1 again" 0.13.1/0.13.1 "$(uv_at uv)/$(uv_at uvx)"
  has "uv put back ($what): the detail says so" "$(report .detail)" 'uv=0.13.1->0.13.6->restored:0.13.1'
  [ -z "$(uv_left)" ] || fail "uv put back ($what): no copy left" none "$(uv_left)"
done

# A box that had no uvx gets none left behind when uv is put back (Devin on #1296).
box; old_uv; rm -f "$REAL_HOME/.local/bin/uvx"; policy 200 "$NEW"; : > "$STATE/uv-install-fails"
run
[ "$(uv_at uv)" = 0.13.1 ] || fail 'no uvx: uv put back' 0.13.1 "$(uv_at uv)"
[ ! -e "$REAL_HOME/.local/bin/uvx" ] || fail 'no uvx: the uvx this run added goes with it' absent "$(uv_at uvx)"
[ -z "$(uv_left)" ] || fail 'no uvx: no copy left' none "$(uv_left)"

# A swap that fails halfway (uv replaced, uvx not) whose put-back cannot rename
# the old uv into place keeps the saved copy for a person, through the rest of
# the run, and says so (Devin on #1296).
box; old_uv; policy 200 "$NEW"
mkdir -p "$WORK/badmv"; cp "$STUB/curl" "$STUB/uv" "$STUB/uvx" "$WORK/badmv/"
cat > "$WORK/badmv/mv" <<'BADMV'
#!/bin/sh
case "$*" in *.uv.termag-old-*|*.uvx.termag-new-*) exit 1 ;; esac
exec /usr/bin/mv "$@"
BADMV
chmod +x "$WORK/badmv/mv"
RUNPATH="$WORK/badmv" run
has 'restore fails: the detail says so' "$(report .detail)" 'uv=0.13.1->0.13.6->FAILED:restore'
has 'restore fails: the run fails, nothing installed' "$(report .detail)" "python=$OLD->FAILED:not-available:$NEW"
has 'restore fails: the saved uv is kept' "$(uv_left)" '.uv.termag-old-'
for kept in "$REAL_HOME"/.local/bin/.uv.termag-old-*; do :; done
[ "$("$kept" --version | awk '{ print $2 }')" = 0.13.1 ] || fail 'restore fails: the kept copy is the old uv' 0.13.1 "$("$kept" --version)"
lacks 'restore fails: no staged copy left' "$(uv_left)" '.termag-new-'
has 'restore fails: the log names the copy it kept' "$(cat "$WORK/err")" "kept there for a person: .uv.termag-old-"
lacks 'restore fails: the log names no copy it did not keep' "$(grep 'kept there for a person' "$WORK/err")" '.uvx.termag-old-'

# A signal while the pinned uv is laid out beside the old one, before the swap:
# nothing of it is left, and uv is as it was (Devin on #1296).
box; old_uv; policy 200 "$NEW"
mkdir -p "$WORK/slowln"; cp "$STUB/curl" "$STUB/uv" "$STUB/uvx" "$WORK/slowln/"
cat > "$WORK/slowln/ln" <<'SLOW'
#!/bin/sh
case "$*" in *.uvx.termag-old-*) : > "$STATE/ln-slow-at"; sleep 3 ;; esac
exec /usr/bin/ln "$@"
SLOW
chmod +x "$WORK/slowln/ln"; rm -f "$STATE/ln-slow-at"
RUNPATH="$WORK/slowln" run & rp=$!
for _ in $(seq 1 100); do [ -e "$STATE/ln-slow-at" ] && break; sleep 0.2; done
[ -e "$STATE/ln-slow-at" ] || fail 'signal mid-bootstrap: the run reached the swap' reached 'never'
# The recipe's own bash (bash runs the trap once the slow ln returns).
rb=$(pgrep -n -f "bash $SCRIPT --run $RUN_ID")
[ -n "$rb" ] && kill -TERM "$rb" 2>/dev/null; wait "$rp" 2>/dev/null
for _ in $(seq 1 50); do [ -n "$rb" ] && kill -0 "$rb" 2>/dev/null || break; sleep 0.2; done
for _ in $(seq 1 50); do [ -z "$(uv_left)" ] && break; sleep 0.2; done
[ -z "$(uv_left)" ] || fail 'signal mid-bootstrap: no staged or old copy left beside uv' none "$(uv_left)"
[ "$(uv_at uv)/$(uv_at uvx)" = 0.13.1/0.13.1 ] || fail 'signal mid-bootstrap: uv and uvx as they were' 0.13.1/0.13.1 "$(uv_at uv)/$(uv_at uvx)"
[ "$(report .outcome)" = failed ] || fail 'signal mid-bootstrap: reported failed' failed "$(report .outcome)"

# A uv that is not the installer's ~/.local/bin/uv is not this run's to replace.
box; policy 200 "$NEW"
mkdir -p "$WORK/olduvpath"; mkuv "$WORK/olduvpath" 0.13.1; cp "$STUB/curl" "$WORK/olduvpath/"
jq '[.[] | select(.version != "3.13.18" and .version != "3.13.17")]' "$STATE/uv-list.json" > "$STATE/uv-list-0.13.1.json"
RUNPATH="$WORK/olduvpath" run
unchanged 'not our uv'
has 'not our uv: left alone' "$(report .detail)" "uv=0.13.1(not-ours:$WORK/olduvpath/uv)"
[ "$("$WORK/olduvpath/uv" --version | awk '{ print $2 }')" = 0.13.1 ] || fail 'not our uv: untouched' 0.13.1 changed

# ── --install-uv: the image's uv (packer/scripts/setup.sh) ──────────────────
# A fresh home: the newest uv pinned for this arch, as uv and uvx, over HTTPS.
uvi() { m=${1:---install-uv}; [ $# -gt 0 ] && shift; HOME_DIR="$WORK/uvhome" ARGS=$m run "$@"; }
uvi_at() { "$WORK/uvhome/.local/bin/$1" --version 2>/dev/null | awk '{ print $2 }'; }
rm -rf "$WORK/uvhome"; mkdir -p "$WORK/uvhome"; rm -f "$STATE/curl-args" "$STATE/curl-calls"
uvi; rc=$?
[ "$rc" = 0 ] || fail 'install-uv: exits 0' 0 "$rc ($(cat "$WORK/err"))"
[ "$(uvi_at uv)/$(uvi_at uvx)" = 0.13.6/0.13.6 ] || fail 'install-uv: uv and uvx are the newest pin' 0.13.6/0.13.6 "$(uvi_at uv)/$(uvi_at uvx)"
has 'install-uv: the pinned release' "$(cat "$STATE/curl-calls")" "GET https://uv.example.test/releases/0.13.6/uv-$UVARCH-unknown-linux-gnu.tar.gz"
has 'install-uv: HTTPS only' "$(cat "$STATE/curl-args")" "curl-arg --proto =https"
has 'install-uv: HTTPS redirects only' "$(cat "$STATE/curl-args")" "curl-arg --proto-redir =https"
left=$(ls -A "$WORK/uvhome/.local/bin" | tr '\n' ' ')
[ "$left" = 'uv uvx ' ] || fail 'install-uv: nothing else left in ~/.local/bin' 'uv uvx ' "$left"
# Again: at the pin already, left as it is.
uvi; rc=$?
[ "$rc" = 0 ] || fail 'install-uv again: exits 0' 0 "$rc"
has 'install-uv again: left as it is' "$(cat "$WORK/err")" 'at or past the pinned 0.13.6; left as they are'
# An older uv there (the installer's 0.13.1) is brought to the pin.
mkuv "$WORK/uvhome/.local/bin" 0.13.1
uvi; rc=$?
[ "$rc/$(uvi_at uv)/$(uvi_at uvx)" = 0/0.13.6/0.13.6 ] || fail 'install-uv over 0.13.1: the pin' 0/0.13.6/0.13.6 "$rc/$(uvi_at uv)/$(uvi_at uvx)"
# A newer one is never moved down.
mkuv "$WORK/uvhome/.local/bin" 0.14.0
uvi; rc=$?
[ "$rc/$(uvi_at uv)" = 0/0.14.0 ] || fail 'install-uv over 0.14.0: left there' 0/0.14.0 "$rc/$(uvi_at uv)"
# uv at the pin but no uvx: both installed. A uv past the pin with no uvx is
# not moved down: exits 1, untouched (Devin on #1299).
mkuv "$WORK/uvhome/.local/bin" 0.13.6; rm -f "$WORK/uvhome/.local/bin/uvx"
uvi; rc=$?
[ "$rc/$(uvi_at uv)/$(uvi_at uvx)" = 0/0.13.6/0.13.6 ] || fail 'install-uv, uv at pin, no uvx: both' 0/0.13.6/0.13.6 "$rc/$(uvi_at uv)/$(uvi_at uvx)"
mkuv "$WORK/uvhome/.local/bin" 0.14.0; rm -f "$WORK/uvhome/.local/bin/uvx"
uvi; rc=$?
[ "$rc/$(uvi_at uv)" = 1/0.14.0 ] && [ ! -e "$WORK/uvhome/.local/bin/uvx" ] || fail 'install-uv, uv past pin, no uvx: fails untouched' 1/0.14.0/no-uvx "$rc/$(uvi_at uv)/$(uvi_at uvx)"
has 'install-uv, uv past pin, no uvx: says so' "$(cat "$WORK/err")" 'not moving uv down, nothing installed'
# uvx's rename fails after uv's: both put back, as they were (Devin on #1299).
mkdir -p "$WORK/uvibadmv"; cp "$STUB/curl" "$WORK/uvibadmv/"
cat > "$WORK/uvibadmv/mv" <<'BADMV'
#!/bin/sh
case "$*" in *.uvx.termag-new-*) exit 1 ;; esac
exec /usr/bin/mv "$@"
BADMV
chmod +x "$WORK/uvibadmv/mv"
mkuv "$WORK/uvhome/.local/bin" 0.13.1
RUNPATH="$WORK/uvibadmv" uvi; rc=$?
[ "$rc/$(uvi_at uv)/$(uvi_at uvx)" = 1/0.13.1/0.13.1 ] || fail 'install-uv, uvx rename fails: both put back' 1/0.13.1/0.13.1 "$rc/$(uvi_at uv)/$(uvi_at uvx)"
left=$(ls -A "$WORK/uvhome/.local/bin" | tr '\n' ' ')
[ "$left" = 'uv uvx ' ] || fail 'install-uv, uvx rename fails: nothing staged or saved left' 'uv uvx ' "$left"
# The same on a fresh home: neither left.
rm -rf "$WORK/uvhome"; mkdir -p "$WORK/uvhome"
RUNPATH="$WORK/uvibadmv" uvi; rc=$?
left=$(ls -A "$WORK/uvhome/.local/bin" 2>/dev/null | tr '\n' ' ')
[ "$rc/$left" = 1/ ] || fail 'install-uv, uvx rename fails, fresh: nothing left' '1/' "$rc/$left"
# The wrong checksum: exits 1, nothing unpacked or installed.
rm -rf "$WORK/uvhome"; mkdir -p "$WORK/uvhome"
uvi '' TERMAG_PYTHON_UV_PINS="0.13.6 $UVARCH 2222222222222222222222222222222222222222222222222222222222222222"; rc=$?
[ "$rc" = 1 ] || fail 'install-uv, wrong digest: exits 1' 1 "$rc"
has 'install-uv, wrong digest: says so' "$(cat "$WORK/err")" "not its pin 2222222222222222222222222222222222222222222222222222222222222222; not unpacked"
has 'install-uv, wrong digest: FAILED:digest' "$(cat "$WORK/err")" 'uv 0.13.6 not installed (FAILED:digest)'
[ ! -e "$WORK/uvhome/.local/bin/uv" ] && [ ! -e "$WORK/uvhome/.local/bin/uvx" ] || fail 'install-uv, wrong digest: no uv installed' absent "$(ls -A "$WORK/uvhome/.local/bin" 2>&1)"
# The download fails: exits 1, nothing installed.
uvi '' TERMAG_PYTHON_UV_PINS="0.13.9 $UVARCH $UVSUM"; rc=$?
[ "$rc" = 1 ] || fail 'install-uv, no download: exits 1' 1 "$rc"
has 'install-uv, no download: FAILED:download' "$(cat "$WORK/err")" 'uv 0.13.9 not installed (FAILED:download)'
[ ! -e "$WORK/uvhome/.local/bin/uv" ] || fail 'install-uv, no download: no uv installed' absent present
# No pin for this arch: exits 1.
uvi '' TERMAG_PYTHON_UV_PINS="0.13.6 $OTHERARCH $UVSUM"; rc=$?
[ "$rc" = 1 ] || fail 'install-uv, no pin: exits 1' 1 "$rc"
has 'install-uv, no pin: says so' "$(cat "$WORK/err")" "no uv is pinned for $UVARCH"
# --newest-uv-pin: what --install-uv installs here; and the recipe's own pins
# name one version for both arches the bake builds.
got=$(uvi --newest-uv-pin)
[ "$got" = 0.13.6 ] || fail 'newest-uv-pin: the newest pin for this arch' 0.13.6 "$got"
pins=$(sed -n '/^UV_PINS=/,/}"$/p' "$SCRIPT" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+ (x86_64|aarch64) [0-9a-f]{64}')
for a in x86_64 aarch64; do
  printf '%s\n' "$pins" | grep -q " $a " || fail "UV_PINS: a pin for $a" "a pin for $a" "$pins"
done
newest() { printf '%s\n' "$pins" | awk -v a="$1" '$2 == a { print $1 }' | sort -V | tail -n 1; }
[ "$(newest x86_64)" = "$(newest aarch64)" ] || fail 'UV_PINS: the same newest uv on both arches' "$(newest x86_64)" "$(newest aarch64)"
# The bake takes its uv from here, and from nowhere else (one list of pins).
uvblock=$(sed -n "/<<'UV_INSTALL'$/,/^UV_INSTALL$/p" "$DIR/../packer/scripts/setup.sh")
has 'bake: runs the recipe from its checkout' "$uvblock" 'recipe="$HOME/src/termag/deploy/termag-python-update"'
has 'bake: installs uv with --install-uv' "$uvblock" '"$recipe" --install-uv ||'
has 'bake: checks uv says the newest pin' "$uvblock" 'want=$("$recipe" --newest-uv-pin)'
has 'bake: checks uvx says it too' "$uvblock" '[ "$gotx" = "$want" ]'
lacks 'bake: not astral.sh installer' "$(cat "$DIR/../packer/scripts/setup.sh")" 'astral.sh/uv/install.sh'

if [ "$failures" -gt 0 ]; then echo "$failures failure(s)"; exit 1; fi
echo "termag-python-update: all tests passed"
