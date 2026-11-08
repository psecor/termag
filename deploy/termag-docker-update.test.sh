#!/bin/sh
# Tests deploy/termag-docker-update, Docker's updater at the box's start (a
# root recipe),
# on deploy/termag-tool-update-lib, with apt-get, apt-cache, dpkg-query,
# systemctl, pgrep, getent, docker, dockerd and the orchestrator (curl)
# stubbed on PATH, run as this user (TERMAG_DOCKER_AS_USER=1):
#
#   * a box running containerd, dockerd or a container shim is never touched:
#     exit 2, no orchestrator call, no apt
#   * --boot asks for the run queued for this start (atStart=1); none queued,
#     or the orchestrator unreachable, and Docker starts as it is: no apt, no
#     report
#   * with a run: its policy by id, Docker's apt list alone refreshed, the five
#     packages to exact versions from download.docker.com (docker-ce and its
#     cli to the target, the others to the newest), only those behind, and
#     with a policy-rc.d holding every service start for the install alone
#   * accepted only when dpkg, dockerd --version and docker --version agree;
#     otherwise rejected (exit 3) and the versions before put back
#   * an exact target the repository does not list installs nothing
#   * the report: component docker, the run, the outcome and versions
#   * termag-docker-update-setup installs the recipe, its lib, the unit
#     (enabled), the env file and the state directory; --check reports drift;
#     a box whose Docker is not from download.docker.com gets nothing
#   * the unit is ordered before containerd and docker and never requires them
#
# Run: sh deploy/termag-docker-update.test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/termag-docker-update"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}
has() { case "$2" in *"$3"*) : ;; *) fail "$1" "$3" "$2" ;; esac; }
lacks() { case "$2" in *"$3"*) fail "$1" "(no '$3')" "$2" ;; esac; }
command -v flock >/dev/null 2>&1 || { echo 'SKIP: flock is required for this test'; exit 0; }
command -v jq >/dev/null 2>&1 || { echo 'SKIP: jq is required for this test'; exit 0; }
command -v dpkg >/dev/null 2>&1 || { echo 'SKIP: dpkg (for --compare-versions) is required for this test'; exit 0; }

HOME_DIR="$WORK/home"
STUB="$WORK/stub"
STATE="$WORK/state"
ROOTSTATE="$WORK/var-lib-termag-docker-update"
POLICY_RC="$WORK/policy-rc.d"
mkdir -p "$HOME_DIR/.termag" "$STUB" "$STATE" "$WORK/bin" "$WORK/archives"
LOG="$WORK/calls"
export LOG STATE HOME_DIR POLICY_RC

# ── stubs ───────────────────────────────────────────────────────────────────
# The dpkg state: $STATE/inst-<pkg>, its full version. The repository:
# $STATE/repo-<pkg>, one full version per line (download.docker.com's), and
# Ubuntu's own docker.io-era docker-ce line that must never count.
cat > "$STUB/apt-get" <<'EOF'
#!/bin/sh
echo "apt-get $*" >> "$LOG"
case " $* " in
  *' update '*) exit "$(cat "$STATE/update-rc" 2>/dev/null || echo 0)" ;;
  *' install '*)
    [ -x "$POLICY_RC" ] && { "$POLICY_RC" >/dev/null; echo "held:$?" >> "$STATE/held"; }
    rc=$(cat "$STATE/apt-rc" 2>/dev/null || echo 0)
    [ "$rc" = 0 ] || { echo 'E: boom' >&2; exit "$rc"; }
    for a; do
      case "$a" in
        docker-ce=*|docker-ce-cli=*|containerd.io=*|docker-buildx-plugin=*|docker-compose-plugin=*) p=${a%%=*} v=${a#*=}
          grep -qxF "$v" "$STATE/repo-$p" 2>/dev/null || { echo "E: Version '$v' for '$p' was not found" >&2; exit 100; }
          [ -s "$STATE/install-other-$p" ] && v=$(cat "$STATE/install-other-$p") && rm -f "$STATE/install-other-$p"
          echo "$v" > "$STATE/inst-$p"; rm -f "$STATE/docker-broken" ;;
      esac
    done
    exit 0 ;;
esac
exit 1
EOF
cat > "$STUB/apt-cache" <<'EOF'
#!/bin/sh
[ "$1" = madison ] || exit 1
while read -r v; do printf '%12s | %s | https://download.docker.com/linux/ubuntu noble/stable arm64 Packages\n' "$2" "$v"; done < "$STATE/repo-$2"
printf '%12s | 99.0.0-0ubuntu1 | http://ports.ubuntu.com/ubuntu-ports noble/universe arm64 Packages\n' "$2"
EOF
cat > "$STUB/dpkg-query" <<'EOF'
#!/bin/sh
for p; do :; done
[ -s "$STATE/inst-$p" ] || exit 1
tr -d '\n' < "$STATE/inst-$p"
EOF
# systemctl is-active: $STATE/active names the active units.
cat > "$STUB/systemctl" <<'EOF'
#!/bin/sh
echo "systemctl $*" >> "$LOG"
[ "$1" = is-active ] || exit 0
for u; do :; done
grep -qxF "$u" "$STATE/active" 2>/dev/null
EOF
# pgrep: $STATE/procs lists what runs (dockerd, containerd, containerd-shim).
cat > "$STUB/pgrep" <<'EOF'
#!/bin/sh
for a; do :; done
grep -qxF "$a" "$STATE/procs" 2>/dev/null
EOF
cat > "$STUB/getent" <<'EOF'
#!/bin/sh
[ "$1" = passwd ] && [ "$2" = "$(id -u)" ] && { printf 'ada:x:%s:%s::%s:/bin/bash\n' "$(id -u)" "$(id -g)" "$HOME_DIR"; exit 0; }
exit 2
EOF
# dockerd and docker: the upstream version of docker-ce's and docker-ce-cli's
# package, as `Docker version X, build abc`; $STATE/dockerd-says: another.
cat > "$WORK/bin/dockerd" <<'EOF'
#!/bin/sh
v=$(cat "$STATE/dockerd-says" 2>/dev/null || sed 's/^[0-9]*://; s/-.*//' "$STATE/inst-docker-ce")
printf 'Docker version %s, build 0123abc\n' "$v"
EOF
cat > "$WORK/bin/docker" <<'EOF'
#!/bin/sh
[ -e "$STATE/docker-broken" ] && exit 1
v=$(sed 's/^[0-9]*://; s/-.*//' "$STATE/inst-docker-ce-cli")
printf 'Docker version %s, build 0123abc\n' "$v"
EOF
# containerd and runc, the runtime containerd.io ships: containerd's upstream version from its package,
# runc's from $STATE/runc (1.5.2 by default).
cat > "$WORK/bin/containerd" <<'EOF'
#!/bin/sh
printf 'containerd containerd.io v%s 0123abc\n' "$(sed 's/-.*//' "$STATE/inst-containerd.io")"
EOF
cat > "$WORK/bin/runc" <<'EOF'
#!/bin/sh
printf 'runc version %s\ncommit: v0\nspec: 1.3.0\n' "$(cat "$STATE/runc" 2>/dev/null || echo 1.5.2)"
EOF
cat > "$STUB/curl" <<'EOF'
#!/bin/sh
echo "curl $*" >> "$STATE/curl-args"
out=/dev/null data= method=GET url=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift ;;
    --data-binary) data=$2; shift ;;
    -X) method=$2; shift ;;
    -K) [ "$2" = - ] && cat > "$STATE/curl-config"; shift ;;
    -m|-w|-H) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
echo "$method $url" >> "$STATE/curl-calls"
[ -e "$STATE/policy-down" ] && exit 7
case "$url" in
  *'atStart=1'*) cat "$STATE/queued-body" > "$out"; printf 200 ;;
  */tool-update/policy\?*) cat "$STATE/policy-body" > "$out"; printf 200 ;;
  */tool-update/report) printf '%s\n' "$data" > "$STATE/report-body"; : > "$out"; printf 204 ;;
  *) exit 6 ;;
esac
EOF
chmod +x "$STUB"/* "$WORK/bin"/*
printf 'deb [arch=arm64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n' > "$WORK/docker.list"

RUN_ID=cmvtrun0000000000000000042
CE_OLD='5:29.8.1-1~ubuntu.24.04~noble' CE_NEW='5:29.9.3-1~ubuntu.24.04~noble' CE_NEWEST='5:29.10.0-1~ubuntu.24.04~noble'
queued() {  # queued [yes|no]: whether a run is queued for this start
  if [ "${1:-yes}" = yes ]; then printf '{"floor":"27.1.1","target":"latest","restart":"none","drainSec":600,"run":{"id":"%s","component":"docker","trigger":"manual"}}' "$RUN_ID"
  else printf '{"floor":"27.1.1","target":"latest","restart":"none","drainSec":600,"run":null}'; fi > "$STATE/queued-body"
}
policy() {  # policy TARGET
  printf '{"floor":"27.1.1","target":"%s","restart":"none","drainSec":600,"run":{"id":"%s","component":"docker","trigger":"manual"}}' "${1:-latest}" "$RUN_ID" > "$STATE/policy-body"
}
reset() {
  : > "$LOG"
  rm -f "$STATE"/inst-* "$STATE/runc" "$STATE/docker-broken" "$STATE/active" "$STATE/procs" "$STATE/held" "$STATE/apt-rc" "$STATE/update-rc" "$STATE/dockerd-says" "$STATE"/install-other-* \
    "$STATE/curl-calls" "$STATE/curl-args" "$STATE/curl-config" "$STATE/report-body" "$STATE/policy-down" "$ROOTSTATE/docker-update.rejected" "$POLICY_RC"
  printf '%s\n%s\n%s\n' "$CE_NEW" "$CE_OLD" '5:28.5.2-1~ubuntu.24.04~noble' > "$STATE/repo-docker-ce"
  cp "$STATE/repo-docker-ce" "$STATE/repo-docker-ce-cli"
  printf '2.4.2-3~ubuntu.24.04~noble\n2.4.1-2~ubuntu.24.04~noble\n' > "$STATE/repo-containerd.io"
  printf '0.30.1-1~ubuntu.24.04~noble\n0.29.1-1~ubuntu.24.04~noble\n' > "$STATE/repo-docker-buildx-plugin"
  printf '2.40.3-1~ubuntu.24.04~noble\n2.39.4-1~ubuntu.24.04~noble\n' > "$STATE/repo-docker-compose-plugin"
  echo "$CE_OLD" > "$STATE/inst-docker-ce"; echo "$CE_OLD" > "$STATE/inst-docker-ce-cli"
  echo '2.4.1-2~ubuntu.24.04~noble' > "$STATE/inst-containerd.io"
  echo '0.29.1-1~ubuntu.24.04~noble' > "$STATE/inst-docker-buildx-plugin"
  echo '2.40.3-1~ubuntu.24.04~noble' > "$STATE/inst-docker-compose-plugin"
  printf '{"token":"tmag_box_token","termag_url":"wss://orch.example.test/termag/ws/agent"}\n' > "$HOME_DIR/.termag/agent.config.json"
  queued yes; policy latest
}
# shellcheck disable=SC2120 # extra env for one run, when a case needs it
run() {
  env -i PATH="$STUB:/usr/bin:/bin" HOME=/nonexistent LOG="$LOG" STATE="$STATE" HOME_DIR="$HOME_DIR" POLICY_RC="$POLICY_RC" \
    TERMAG_DOCKER_AS_USER=1 TERMAG_DOCKER_AGENT_UID="$(id -u)" DOCKER_BIN="$WORK/bin/docker" DOCKERD_BIN="$WORK/bin/dockerd" \
    CONTAINERD_BIN="$WORK/bin/containerd" RUNC_BIN="$WORK/bin/runc" \
    TERMAG_DOCKER_STATE_DIR="$ROOTSTATE" TERMAG_DOCKER_SOURCES="${SOURCES:-$WORK/docker.list}" TERMAG_DOCKER_POLICY_RC="$POLICY_RC" \
    TERMAG_DOCKER_APT_ARCHIVES="$WORK/archives" TERMAG_POLICY_TIMEOUT=5 "$@" \
    bash "$SCRIPT" --boot 2>"$WORK/err"
}
report() { jq -r "$1" "$STATE/report-body" 2>/dev/null; }
inst() { cat "$STATE/inst-$1"; }

# ── a running box is never touched ──────────────────────────────────────────
for what in active:docker.service active:containerd.service proc:dockerd proc:containerd proc:containerd-shim; do
  reset
  case "$what" in active:*) echo "${what#active:}" > "$STATE/active" ;; proc:*) echo "${what#proc:}" > "$STATE/procs" ;; esac
  run; got=$?
  [ "$got" = 2 ] || fail "running ($what): exits 2" 2 "$got"
  [ ! -e "$STATE/curl-calls" ] || fail "running ($what): never asks the orchestrator" none "$(cat "$STATE/curl-calls")"
  lacks "running ($what): no apt" "$(cat "$LOG")" 'apt-get'
  has "running ($what): says why" "$(cat "$WORK/err")" 'Docker is only updated while the box starts'
done

# ── nothing queued: one call, nothing else ──────────────────────────────────
reset; queued no
run; got=$?
[ "$got" = 0 ] || fail 'none queued: exits 0' 0 "$got: $(cat "$WORK/err")"
[ "$(cat "$STATE/curl-calls")" = 'GET https://orch.example.test/termag/api/tool-update/policy?component=docker&atStart=1' ] \
  || fail 'none queued: one atStart fetch' 'GET …?component=docker&atStart=1' "$(cat "$STATE/curl-calls")"
has 'none queued: the token goes on curl'"'"'s stdin' "$(cat "$STATE/curl-config")" 'Authorization: Bearer tmag_box_token'
lacks 'none queued: never in an argument' "$(cat "$STATE/curl-args")" 'tmag_box_token'
lacks 'none queued: no apt' "$(cat "$LOG")" 'apt-get'
[ ! -e "$STATE/report-body" ] || fail 'none queued: no report' none "$(cat "$STATE/report-body")"
[ "$(inst docker-ce)" = "$CE_OLD" ] || fail 'none queued: docker-ce unchanged' "$CE_OLD" "$(inst docker-ce)"
# The orchestrator unreachable: the same, Docker starts as it is.
reset; : > "$STATE/policy-down"
run; got=$?
[ "$got" = 0 ] || fail 'unreachable: exits 0' 0 "$got"
lacks 'unreachable: no apt' "$(cat "$LOG")" 'apt-get'

# ── a queued run: the five packages, to exact versions, services held ───────
reset
run; got=$?
[ "$got" = 0 ] || fail 'queued: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'queued: then the run by id' "$(cat "$STATE/curl-calls")" "GET https://orch.example.test/termag/api/tool-update/policy?component=docker&run=$RUN_ID"
has 'queued: refreshes Docker'"'"'s list alone' "$(grep 'update$' "$LOG")" "-o Dir::Etc::sourcelist=$WORK/docker.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 -qq update"
line=$(grep ' install ' "$LOG")
has 'queued: docker-ce to the newest download.docker.com lists' "$line" "docker-ce=$CE_NEW"
has 'queued: docker-ce-cli with it' "$line" "docker-ce-cli=$CE_NEW"
has 'queued: containerd.io to its newest' "$line" 'containerd.io=2.4.2-3~ubuntu.24.04~noble'
has 'queued: buildx to its newest' "$line" 'docker-buildx-plugin=0.30.1-1~ubuntu.24.04~noble'
lacks 'queued: compose, already newest, is left' "$line" 'docker-compose-plugin='
lacks 'queued: never another origin' "$line" '99.0.0'
lacks 'queued: never a downgrade flag forward' "$line" 'allow-downgrades'
[ "$(cat "$STATE/held" 2>/dev/null)" = 'held:101' ] || fail 'queued: a policy-rc.d holds service starts during the install' held:101 "$(cat "$STATE/held" 2>/dev/null)"
[ ! -e "$POLICY_RC" ] || fail 'queued: the policy-rc.d is gone after' absent present
has 'queued: verified' "$(cat "$WORK/err")" 'Docker is now 29.9.3'
has 'queued: the runtime checked against its advisories' "$(report .detail)" 'runtime=containerd:2.4.2,runc:1.5.2'
got=$(report '[.component, .trigger, .run, .outcome, .fromVersion, .toVersion, (.panes | length)] | join(" ")')
[ "$got" = "docker manual $RUN_ID updated 29.8.1 29.9.3 0" ] || fail 'queued: the report' "docker manual $RUN_ID updated 29.8.1 29.9.3 0" "$got"
[ "$(stat -c %a "$ROOTSTATE")" = 700 ] || fail 'queued: the state directory is 0700' 700 "$(stat -c %a "$ROOTSTATE")"

# A runc still below the container-escape fixes (nothing newer listed): Docker updated, the run partial.
reset; echo 1.3.2 > "$STATE/runc"
run
[ "$(report .outcome)" = partial ] || fail 'old runc: partial' partial "$(report .outcome)"
has 'old runc: says so' "$(report .detail)" 'runc:1.3.2:FAILED:below-advisory-min(containerd>=2.4.2,runc>=1.3.3)'

# One an interrupted run left (power lost mid-install) is ours: removed at the next boot, even with nothing queued (Bugbot on #1305).
reset; queued no; printf '#!/bin/sh\n# termag-docker-update: no service starts while Docker is installed at boot.\nexit 101\n' > "$POLICY_RC"; chmod +x "$POLICY_RC"
run
[ ! -e "$POLICY_RC" ] || fail 'leftover policy-rc.d: removed' absent present
has 'leftover policy-rc.d: says so' "$(cat "$WORK/err")" 'an interrupted run left'

# A run installing right now holds the lock: its policy-rc.d is live, and another invocation leaves it (Devin on #1305).
reset; queued no; printf '#!/bin/sh\n# termag-docker-update: no service starts while Docker is installed at boot.\nexit 101\n' > "$POLICY_RC"; chmod +x "$POLICY_RC"
mkdir -p "$ROOTSTATE"; flock "$ROOTSTATE/docker-update.lock" sh -c 'touch "$1/held"; while [ -e "$1/held" ]; do sleep 0.1; done' _ "$WORK" &
holder=$!
while [ ! -e "$WORK/held" ]; do sleep 0.1; done
run
rm -f "$WORK/held"; wait "$holder"
[ -e "$POLICY_RC" ] || fail 'live policy-rc.d: left while another run holds the lock' present absent
has 'live policy-rc.d: says so' "$(cat "$WORK/err")" 'another run holds'

# The same with nothing to move: failed, never current, since the box stays exposed.
reset; echo 1.3.2 > "$STATE/runc"
for p in docker-ce docker-ce-cli; do echo "$CE_NEW" > "$STATE/inst-$p"; done
echo '2.4.2-3~ubuntu.24.04~noble' > "$STATE/inst-containerd.io"; echo '0.30.1-1~ubuntu.24.04~noble' > "$STATE/inst-docker-buildx-plugin"
run
lacks 'old runc, nothing to move: installs nothing' "$(cat "$LOG")" ' install '
[ "$(report .outcome)" = failed ] || fail 'old runc, nothing to move: failed, not current' failed "$(report .outcome)"

# A policy-rc.d the box already had is left as it was.
reset; printf '#!/bin/sh\nexit 0\n' > "$POLICY_RC"; chmod +x "$POLICY_RC"
run
[ -e "$POLICY_RC" ] || fail 'own policy-rc.d: left in place' present absent

# ── current: nothing installed, reported current ────────────────────────────
reset
for p in docker-ce docker-ce-cli; do echo "$CE_NEW" > "$STATE/inst-$p"; done
echo '2.4.2-3~ubuntu.24.04~noble' > "$STATE/inst-containerd.io"; echo '0.30.1-1~ubuntu.24.04~noble' > "$STATE/inst-docker-buildx-plugin"
run; got=$?
[ "$got" = 0 ] || fail 'current: exits 0' 0 "$got"
lacks 'current: installs nothing' "$(cat "$LOG")" ' install '
[ "$(report .outcome)" = current ] || fail 'current: outcome current' current "$(report .outcome)"

# ── an exact target ─────────────────────────────────────────────────────────
reset; policy 29.10.0
run
lacks 'unlisted target: installs nothing' "$(cat "$LOG")" ' install '
[ "$(report .outcome)" = failed ] || fail 'unlisted target: failed' failed "$(report .outcome)"
has 'unlisted target: says so' "$(report .detail)" 'FAILED:not-in-repo:29.10.0'
reset; printf '%s\n' "$CE_NEWEST" >> "$STATE/repo-docker-ce"; printf '%s\n' "$CE_NEWEST" >> "$STATE/repo-docker-ce-cli"; policy 29.9.3
run
has 'exact target: that version, not the newest' "$(grep ' install ' "$LOG")" "docker-ce=$CE_NEW"
# Below what the box has: the Engine never moves down, but containerd and the plugins still move (Devin on #1305).
reset; policy 28.5.2
run; got=$?
[ "$got" = 0 ] || fail 'no downgrade: exits 0' 0 "$got: $(cat "$WORK/err")"
line=$(grep ' install ' "$LOG")
lacks 'no downgrade: never docker-ce' "$line" 'docker-ce='
has 'no downgrade: containerd.io still moves' "$line" 'containerd.io=2.4.2-3~ubuntu.24.04~noble'
has 'no downgrade: says so' "$(cat "$WORK/err")" 'no-downgrade'
[ "$(inst docker-ce)" = "$CE_OLD" ] || fail 'no downgrade: docker-ce stays' "$CE_OLD" "$(inst docker-ce)"
[ "$(report .outcome)" = updated ] || fail 'no downgrade: the plugins updated' updated "$(report .outcome)"
# Above the target with the cli behind dockerd (an interrupted install): the cli goes to the Engine's version (Devin on #1305).
reset; policy 28.5.2; for p in docker-ce docker-ce-cli; do echo "$CE_NEW" > "$STATE/inst-$p"; done; echo "$CE_OLD" > "$STATE/inst-docker-ce-cli"
run
line=$(grep ' install ' "$LOG")
has 'cli behind dockerd: brought to the Engine' "$line" "docker-ce-cli=$CE_NEW"
lacks 'cli behind dockerd: the Engine itself untouched' "$line" "docker-ce=$CE_NEW"
[ "$(report .outcome)" = updated ] || fail 'cli behind dockerd: updated' updated "$(report .outcome)"
# Above the target with everything current: nothing, current.
reset; policy 28.5.2; echo '2.4.2-3~ubuntu.24.04~noble' > "$STATE/inst-containerd.io"; echo '0.30.1-1~ubuntu.24.04~noble' > "$STATE/inst-docker-buildx-plugin"
run
lacks 'no downgrade, current: installs nothing' "$(cat "$LOG")" ' install '
[ "$(report .outcome)" = current ] || fail 'no downgrade, current: current' current "$(report .outcome)"

# ── every one of the five, or none (Devin on #1305) ─────────────────────────
reset; : > "$STATE/repo-docker-buildx-plugin"
run
lacks 'a package the repository does not list: installs nothing' "$(cat "$LOG")" ' install '
has 'a package the repository does not list: says which' "$(report .detail)" 'FAILED:not-in-repo:docker-buildx-plugin'
[ "$(report .outcome)" = failed ] || fail 'a package the repository does not list: failed' failed "$(report .outcome)"

# ── current by dpkg, but a broken client: reinstalled, never reported current (Devin on #1305) ──
reset
for p in docker-ce docker-ce-cli; do echo "$CE_NEW" > "$STATE/inst-$p"; done
echo '2.4.2-3~ubuntu.24.04~noble' > "$STATE/inst-containerd.io"; echo '0.30.1-1~ubuntu.24.04~noble' > "$STATE/inst-docker-buildx-plugin"
: > "$STATE/docker-broken"
run
has 'broken client: reinstalled' "$(grep ' install ' "$LOG")" "--reinstall docker-ce=$CE_NEW"
has 'broken client: says why' "$(cat "$WORK/err")" 'docker --version says'
[ "$(report .outcome)" != current ] || fail 'broken client: never current' 'updated|failed' current

# ── a mismatch: rejected, and the versions before put back ──────────────────
reset; echo "$CE_NEWEST" > "$STATE/install-other-docker-ce"
run; got=$?
[ "$got" = 3 ] || fail 'mismatch: exits 3' 3 "$got: $(cat "$WORK/err")"
[ "$(report .outcome)" = failed ] || fail 'mismatch: failed' failed "$(report .outcome)"
grep -q '^docker ' "$ROOTSTATE/docker-update.rejected" 2>/dev/null || fail 'mismatch: recorded' 'docker …' "$(cat "$ROOTSTATE/docker-update.rejected" 2>/dev/null)"
has 'mismatch: puts docker-ce back' "$(grep ' install ' "$LOG" | tail -n 1)" "docker-ce=$CE_OLD"
[ "$(inst docker-ce)" = "$CE_OLD" ] || fail 'mismatch: docker-ce is back' "$CE_OLD" "$(inst docker-ce)"
[ "$(inst containerd.io)" = '2.4.1-2~ubuntu.24.04~noble' ] || fail 'mismatch: containerd.io is back' 2.4.1 "$(inst containerd.io)"

# ── not Docker's repository: nothing ────────────────────────────────────────
reset; printf 'deb http://ports.ubuntu.com/ubuntu-ports noble main\n' > "$WORK/other.list"
SOURCES="$WORK/other.list" run
lacks 'other list: installs nothing' "$(cat "$LOG")" ' install '
[ "$(report .outcome)" = failed ] || fail 'other list: failed' failed "$(report .outcome)"

# ── usage ───────────────────────────────────────────────────────────────────
env -i PATH="$STUB:/usr/bin:/bin" TERMAG_DOCKER_AS_USER=1 TERMAG_DOCKER_AGENT_UID="$(id -u)" bash "$SCRIPT" --run x 2>/dev/null; got=$?
[ "$got" = 2 ] || fail 'usage: --run is not a mode here' 2 "$got"
env -i PATH="$STUB:/usr/bin:/bin" bash "$SCRIPT" --boot 2>/dev/null; got=$?
[ "$got" = 2 ] || fail 'usage: not root and not a test: exits 2' 2 "$got"

# ── the unit ────────────────────────────────────────────────────────────────
unit=$(grep -v '^#' "$DIR/termag-docker-update.service")
has 'unit: before containerd and docker' "$unit" 'Before=containerd.service docker.service'
has 'unit: wanted at boot' "$unit" 'WantedBy=multi-user.target'
lacks 'unit: never requires docker' "$unit" 'Requires='
has 'unit: root'"'"'s copy' "$unit" 'ExecStart=/usr/local/libexec/termag/termag-docker-update --boot'

# ── setup ───────────────────────────────────────────────────────────────────
ROOT="$WORK/root"; mkdir -p "$ROOT/etc/apt/sources.list.d"
setup() { TERMAG_DOCKER_SETUP_ROOT="$ROOT" bash "$DIR/termag-docker-update-setup" --agent-user "$(id -un)" "$@"; }
out=$(setup --check); got=$?
[ "$got" = 0 ] || fail 'setup: no Docker list: nothing to do' 0 "$got"
has 'setup: no Docker list: says so' "$out" 'nothing to set up'
cp "$WORK/docker.list" "$ROOT/etc/apt/sources.list.d/docker.list"
setup --check >/dev/null; got=$?
[ "$got" = 1 ] || fail 'setup --check: drift on a fresh box' 1 "$got"
out=$(setup); got=$?
[ "$got" = 0 ] || fail 'setup: applies' 0 "$got: $out"
for f in usr/local/libexec/termag/termag-docker-update:755 usr/local/libexec/termag/termag-tool-update-lib:644 etc/systemd/system/termag-docker-update.service:644 etc/termag/docker-update.env:644; do
  p=${f%:*} m=${f##*:}
  [ "$(stat -c %a "$ROOT/$p" 2>/dev/null)" = "$m" ] || fail "setup: /$p is $m" "$m" "$(stat -c %a "$ROOT/$p" 2>&1)"
done
[ "$(readlink "$ROOT/etc/systemd/system/multi-user.target.wants/termag-docker-update.service")" = /etc/systemd/system/termag-docker-update.service ] \
  || fail 'setup: the unit is enabled' link "$(ls -l "$ROOT/etc/systemd/system/multi-user.target.wants" 2>&1)"
has 'setup: the env file names the agent uid' "$(cat "$ROOT/etc/termag/docker-update.env")" "TERMAG_DOCKER_AGENT_UID=$(id -u)"
[ "$(stat -c %a "$ROOT/var/lib/termag/docker-update")" = 700 ] || fail 'setup: state dir 0700' 700 "$(stat -c %a "$ROOT/var/lib/termag/docker-update")"
out=$(setup --check); got=$?
[ "$got" = 0 ] || fail 'setup --check: clean after apply' 0 "$got: $out"
[ -z "$(setup)" ] || fail 'setup: a current box writes nothing' '' "$(setup)"

if [ "$failures" -gt 0 ]; then echo "$failures failure(s)"; exit 1; fi
echo 'termag-docker-update: all tests passed'
