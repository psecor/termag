#!/bin/sh
# Tests deploy/termag-gh-update, the box's GitHub CLI updater (a root recipe,
# docs/tool-updates.md), on deploy/termag-tool-update-lib, with apt-get,
# apt-cache, dpkg-query, getent, gh and the orchestrator (curl) stubbed on
# PATH, run as this user (TERMAG_GH_AS_USER=1, which only a run that is not
# root reads):
#
#   * --run asks for gh's policy (component=gh) with the agent token on curl's
#     stdin, never in an argument or a log line; the agent config is the agent
#     user's (by uid), and a token or URL that could break out of curl's
#     config is refused
#   * it refreshes gh's apt list alone, and installs exactly gh=<x.y.z>, the
#     version cli.github.com's index lists, only when behind it; never
#     Ubuntu's gh, never a version the repository does not list, never a tag;
#     nothing moves down
#   * accepted only when dpkg and gh --version both say it; otherwise
#     rejected (exit 3, recorded under the root state directory) and the
#     version before put back when the repository lists it
#   * no policy (refused, unreachable, unreadable, a tag gh does not have)
#     installs nothing; a 200 with run null installs nothing
#   * no sessions: the report lists none, and restart changes nothing
#   * the lock held by another run: it installs nothing and reports failed
#   * bad usage exits 2, and so does a missing agent user; as root, the
#     tests' overrides are never read
#   * termag-gh-update-start takes one run id and nothing else
#   * termag-gh-update-setup installs the recipe, its lib, the helper, the
#     unit, the env file, the sudoers rule (for the agent's uid, checked with
#     visudo) and the state directory, root's and with their modes; --check
#     reports drift and changes nothing
#
# Run: sh deploy/termag-gh-update.test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/termag-gh-update"
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

HOME_DIR="$WORK/home"
STUB="$WORK/stub"
STATE="$WORK/state"
ROOTSTATE="$WORK/var-lib-termag-gh-update"
mkdir -p "$HOME_DIR/.termag" "$STUB" "$STATE" "$WORK/bin"
LOG="$WORK/calls"
export LOG STATE HOME_DIR

# ── stubs ───────────────────────────────────────────────────────────────────
# The dpkg state is $STATE/installed (gh's version, empty: not installed).
# apt-get: `update` logs its options and fails with $STATE/update-rc;
# `install ... gh=V` installs V (or $STATE/install-other) unless it is not
# in $STATE/repo, fails with $STATE/apt-rc. apt-cache madison: $STATE/repo,
# one cli.github.com line per version, and Ubuntu's own older gh.
cat > "$STUB/apt-get" <<'EOF'
#!/bin/sh
echo "apt-get $*" >> "$LOG"
for a; do last=$a; done
case " $* " in
  *' update '*) exit "$(cat "$STATE/update-rc" 2>/dev/null || echo 0)" ;;
  *' install '*)
    rc=$(cat "$STATE/apt-rc" 2>/dev/null || echo 0)
    [ "$rc" = 0 ] || { echo 'E: boom' >&2; exit "$rc"; }
    v=${last#gh=}
    # A package file from apt's cache: its version is in its name.
    case "$last" in
      *.deb) v=${last##*/gh_}; v=${v%%_*}; echo "$v" > "$STATE/installed"; exit 0 ;;
    esac
    grep -qxF "$v" "$STATE/repo" || { echo "E: Version '$v' for 'gh' was not found" >&2; exit 100; }
    [ -s "$STATE/install-other" ] && v=$(cat "$STATE/install-other")
    [ -s "$STATE/install-other-once" ] && { v=$(cat "$STATE/install-other-once"); rm -f "$STATE/install-other-once"; }
    echo "$v" > "$STATE/installed"
    # $STATE/apt-partial-once: unpacked, then its configuration fails, once.
    [ -e "$STATE/apt-partial-once" ] && { rm -f "$STATE/apt-partial-once"; echo 'E: Sub-process /usr/bin/dpkg returned an error code (1)' >&2; exit 100; }
    exit 0 ;;
esac
exit 1
EOF
cat > "$STUB/apt-cache" <<'EOF'
#!/bin/sh
[ "$1 $2" = 'madison gh' ] || exit 1
while read -r v; do printf '        gh | %s | https://cli.github.com/packages stable/main arm64 Packages\n' "$v"; done < "$STATE/repo"
printf '        gh | 2.45.0-1ubuntu0.3 | http://ports.ubuntu.com/ubuntu-ports noble-security/universe arm64 Packages\n'
printf '        gh | 9.9.9 | http://mirror.example.test/not-github stable/main arm64 Packages\n'
EOF
cat > "$STUB/dpkg-query" <<'EOF'
#!/bin/sh
[ -s "$STATE/dpkg-says" ] && { cat "$STATE/dpkg-says"; exit 0; }
[ -s "$STATE/installed" ] || exit 1
tr -d '\n' < "$STATE/installed"
EOF
# dpkg-deb -f FILE Package|Version: from a cached gh_<version>_<arch>.deb's name.
cat > "$STUB/dpkg-deb" <<'EOF'
#!/bin/sh
[ "$1" = -f ] || exit 2
v=${2##*/gh_}; v=${v%%_*}
case "$3" in Package) echo gh ;; Version) echo "$v" ;; *) exit 1 ;; esac
EOF
cat > "$STUB/getent" <<'EOF'
#!/bin/sh
[ "$1" = passwd ] && [ "$2" = "$(id -u)" ] && { printf 'ada:x:%s:%s::%s:/bin/bash\n' "$(id -u)" "$(id -g)" "$HOME_DIR"; exit 0; }
exit 2
EOF
# gh: the installed version, as `gh version X (date)`; $STATE/broken: it does
# not run; $STATE/gh-says: another version.
cat > "$WORK/bin/gh" <<'EOF'
#!/bin/sh
[ "$1" = --version ] || exit 0
[ -e "$STATE/broken" ] && exit 1
v=$(cat "$STATE/gh-says" 2>/dev/null || cat "$STATE/installed" 2>/dev/null)
[ -n "$v" ] || exit 1
printf 'gh version %s (2026-10-26)\nhttps://github.com/cli/cli/releases/tag/v%s\n' "$v" "$v"
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
case "$url" in
  */tool-update/policy\?*)
    [ -e "$STATE/policy-down" ] && exit 7
    cat "$STATE/policy-body" > "$out"; printf '%s' "$(cat "$STATE/policy-code")" ;;
  */tool-update/report)
    printf '%s\n' "$data" > "$STATE/report-body"; : > "$out"; printf 204 ;;
  *) exit 6 ;;
esac
EOF
chmod +x "$STUB/apt-get" "$STUB/apt-cache" "$STUB/dpkg-query" "$STUB/dpkg-deb" "$STUB/getent" "$STUB/curl" "$WORK/bin/gh"
printf 'deb [arch=arm64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' > "$WORK/github-cli.list"

RUN_ID=cmvtrun0000000000000000006
config() { printf '{"token":"%s","termag_url":"%s"}\n' "${1:-tmag_box_token}" "${2:-wss://orch.example.test/termag/ws/agent}" > "$HOME_DIR/.termag/agent.config.json"; }
policy() {  # policy CODE [RESTART [TARGET [DRAIN [RUN [FLOOR]]]]]
  printf '%s' "$1" > "$STATE/policy-code"
  printf '{"floor":"%s","target":"%s","restart":"%s","drainSec":%s,"run":%s}' \
    "${6:-2.102.0}" "${3:-2.103.3}" "${2:-none}" "${4:-5}" "${5:-{\"id\":\"$RUN_ID\",\"component\":\"gh\"\}}" > "$STATE/policy-body"
}
at() { echo "$1" > "$STATE/installed"; }
reset() {
  : > "$LOG"
  rm -f "$STATE/apt-rc" "$STATE/update-rc" "$STATE/broken" "$STATE/gh-says" "$STATE/dpkg-says" "$STATE/install-other" "$STATE/install-other-once" \
    "$STATE/curl-calls" "$STATE/curl-args" "$STATE/curl-config" "$STATE/report-body" "$STATE/policy-down" "$ROOTSTATE/gh-update.rejected"
  printf '2.103.3\n' > "$STATE/repo"
  config
}
# shellcheck disable=SC2120 # extra env for one run, when a case needs it
run() {
  env -i PATH="$STUB:/usr/bin:/bin" HOME=/nonexistent LOG="$LOG" STATE="$STATE" HOME_DIR="$HOME_DIR" \
    TERMAG_GH_AS_USER=1 TERMAG_GH_AGENT_UID="${AGENT_UID-$(id -u)}" GH_BIN="$WORK/bin/gh" TERMAG_GH_STATE_DIR="$ROOTSTATE" \
    TERMAG_GH_SOURCES="${SOURCES:-$WORK/github-cli.list}" TERMAG_GH_APT_ARCHIVES="$WORK/archives" TERMAG_GH_LOCK_WAIT=1 TERMAG_POLICY_TIMEOUT=5 "$@" \
    bash "$SCRIPT" ${ARGS:---run $RUN_ID} 2>"${ERRF:-$WORK/err}"
}
report() { jq -r "$1" "$STATE/report-body" 2>/dev/null; }

# ── the exact target from cli.github.com, reported ──────────────────────────
reset; at 2.96.0; policy 200 idle 2.103.3
run; got=$?
[ "$got" = 0 ] || fail 'target: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'target: asks for gh'"'"'s policy for its run' "$(cat "$STATE/curl-calls")" "GET https://orch.example.test/termag/api/tool-update/policy?component=gh&run=$RUN_ID"
has 'target: the token goes on curl'"'"'s stdin' "$(cat "$STATE/curl-config")" 'Authorization: Bearer tmag_box_token'
lacks 'target: never in an argument' "$(cat "$STATE/curl-args")" 'tmag_box_token'
lacks 'target: never in a log line' "$(cat "$WORK/err")" 'tmag_box_token'
has 'target: refreshes gh'"'"'s list alone' "$(grep 'update$' "$LOG")" "-o Dir::Etc::sourcelist=$WORK/github-cli.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 -qq update"
has 'target: installs exactly gh=<version>' "$(grep ' install ' "$LOG")" 'install -y --no-install-recommends gh=2.103.3'
lacks 'target: never a downgrade flag forward' "$(grep ' install ' "$LOG")" 'allow-downgrades'
has 'target: verified by dpkg and gh --version' "$(cat "$WORK/err")" 'gh is now 2.103.3, verified (dpkg and gh --version)'
got=$(report '[.component, .trigger, .run, .outcome, .target, .fromVersion, .toVersion, (.sessions | [.stopped, .resumed, .fresh, .cut, .typed, .other, .runnersLeft] | join(",")), (.panes | length)] | join(" ")')
[ "$got" = "gh manual $RUN_ID updated 2.103.3 2.96.0 2.103.3 0,0,0,0,0,0,0 0" ] || fail 'target: the report body' "gh manual $RUN_ID updated 2.103.3 2.96.0 2.103.3 0,0,0,0,0,0,0 0" "$got"
has 'target: no sessions to restart' "$(report .detail)" 'restart=idle(nothing on an old binary)'
[ -f "$ROOTSTATE/gh-update.lock" ] || fail 'target: the lock is in the root state directory' present absent
[ "$(stat -c %a "$ROOTSTATE")" = 700 ] || fail 'target: the state directory is 0700' 700 "$(stat -c %a "$ROOTSTATE")"
for f in "$HOME_DIR/.termag"/* "$HOME_DIR/.termag"/.[!.]*; do
  case "$f" in */agent.config.json|*'/*'|*'/.[!.]*') ;; *) fail 'target: nothing written to the user'"'"'s home' none "$f" ;; esac
done

# At the target: nothing installed, current.
reset; at 2.103.3; policy 200 none 2.103.3
run; got=$?
[ "$got" = 0 ] || fail 'current: exits 0' 0 "$got"
lacks 'current: installs nothing' "$(cat "$LOG")" ' install '
[ "$(report .outcome)" = current ] || fail 'current: outcome current' current "$(report .outcome)"
# Above the target (a newer box): nothing moves down.
reset; at 2.104.0; printf '2.103.3\n2.104.0\n' > "$STATE/repo"; policy 200 none 2.103.3
run
lacks 'no downgrade: installs nothing' "$(cat "$LOG")" ' install '
has 'no downgrade: says so' "$(cat "$WORK/err")" 'apt=2.104.0(no-downgrade)'

# ── latest: what cli.github.com lists, never another origin ─────────────────
reset; at 2.96.0; printf '2.103.3\n2.101.0\n' > "$STATE/repo"; policy 200 none latest
run; got=$?
[ "$got" = 0 ] || fail 'latest: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'latest: the newest the repository lists' "$(grep ' install ' "$LOG")" 'gh=2.103.3'
lacks 'latest: never another origin'"'"'s newer version' "$(cat "$LOG")" 'gh=9.9.9'
lacks 'latest: never Ubuntu'"'"'s gh' "$(cat "$LOG")" '2.45.0'
lacks 'latest: never the tag' "$(cat "$LOG")" 'gh=latest'
[ "$(report .target)" = 2.103.3 ] || fail 'latest: the report names the version' 2.103.3 "$(report .target)"

# An exact target the repository does not list: nothing (only exact versions from the repository).
reset; at 2.96.0; policy 200 none 2.102.5
run; got=$?
lacks 'not in the repository: installs nothing' "$(cat "$LOG")" ' install '
has 'not in the repository: says so' "$(cat "$WORK/err")" 'cli.github.com does not list gh 2.102.5'
[ "$(report .outcome)" = failed ] || fail 'not in the repository: reported failed' failed "$(report .outcome)"
# Above the floor too: the target was not reached, so never current (Bugbot on #1102).
reset; at 2.103.1; policy 200 none 2.103.2
run; got=$?
[ "$got" = 0 ] || fail 'not in the repository, above the floor: exits 0' 0 "$got"
[ "$(report .outcome)" = failed ] || fail 'not in the repository, above the floor: reported failed, not current' failed "$(report .outcome)"
has 'not in the repository, above the floor: the note says why' "$(report .detail)" 'apt=2.103.1->FAILED:not-in-repo:2.103.2'
# A gh list that is not cli.github.com's: nothing.
reset; at 2.96.0; policy 200 none 2.103.3
printf 'deb http://mirror.example.test/gh stable main\n' > "$WORK/other.list"
SOURCES="$WORK/other.list" run
lacks 'another list: installs nothing' "$(cat "$LOG")" 'apt-get'
has 'another list: says so' "$(cat "$WORK/err")" "is not cli.github.com's"
# The refresh fails: nothing.
reset; at 2.96.0; policy 200 none 2.103.3; echo 100 > "$STATE/update-rc"
run
lacks 'refresh fails: installs nothing' "$(cat "$LOG")" ' install '
[ "$(report .outcome)" = failed ] || fail 'refresh fails: reported failed' failed "$(report .outcome)"

# ── rejected, restored ──────────────────────────────────────────────────────
# apt installs another version than asked: rejected; the one before is put
# back when the repository lists it.
reset; at 2.101.0; printf '2.103.3\n2.101.0\n' > "$STATE/repo"; echo 2.100.0 > "$STATE/install-other-once"; policy 200 none 2.103.3
run; got=$?
[ "$got" = 3 ] || fail 'other version: rejected, exits 3' 3 "$got: $(tail -3 "$WORK/err")"
has 'other version: says what it got' "$(cat "$WORK/err")" 'asked for 2.103.3; dpkg says 2.100.0, gh --version says 2.100.0'
has 'restore: reinstalls the version that ran' "$(grep ' install ' "$LOG" | tail -n 1)" '--allow-downgrades gh=2.101.0'
has 'restore: verified' "$(cat "$WORK/err")" 'gh 2.101.0 is back, verified'
grep -q '^gh ' "$ROOTSTATE/gh-update.rejected" 2>/dev/null || fail 'restore: the record stays, in the root state directory' 'gh ...' "$(cat "$ROOTSTATE/gh-update.rejected" 2>/dev/null)"
[ "$(report .outcome)" = failed ] || fail 'restore: reported failed' failed "$(report .outcome)"
# The next run reinstalls (the same version too) and verifies, and clears the record.
: > "$LOG"; rm -f "$STATE/report-body"; at 2.103.3
run; got=$?
[ "$got" = 0 ] || fail 'rejected, then verified: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'rejected, then verified: reinstalled' "$(grep ' install ' "$LOG")" '--reinstall gh=2.103.3'
[ ! -e "$ROOTSTATE/gh-update.rejected" ] || fail 'rejected, then verified: the record is gone' absent present
# The version before is not in the repository: rejected, nothing renamed (dpkg's file).
reset; at 2.96.0; echo 2.103.3 > "$STATE/dpkg-says"; echo 2.100.0 > "$STATE/gh-says"; policy 200 none 2.103.3
run; got=$?
[ "$got" = 3 ] || fail 'mismatch, nothing to restore: rejected' 3 "$got"
[ -x "$WORK/bin/gh" ] || fail 'mismatch, nothing to restore: gh is never renamed' executable gone
# The version before is not in the repository (it lists only its newest) but
# its package is in apt's cache: put back from there, verified (a review on #1102).
reset; at 2.101.0; mkdir -p "$WORK/archives"; : > "$WORK/archives/gh_2.101.0_arm64.deb"; echo 2.100.0 > "$STATE/install-other-once"; policy 200 none 2.103.3
run; got=$?
rm -rf "$WORK/archives"
[ "$got" = 3 ] || fail 'restore from the cache: still rejected, exits 3' 3 "$got"
has 'restore from the cache: installs the cached package' "$(grep ' install ' "$LOG" | tail -n 1)" "--allow-downgrades $WORK/archives/gh_2.101.0_arm64.deb"
has 'restore from the cache: verified' "$(cat "$WORK/err")" "gh 2.101.0 is back, verified (from apt's cache"
has 'restore from the cache: the note' "$(report .detail)" 'apt=2.101.0->pin-mismatch,restored:2.101.0'
# Neither in the repository nor in the cache: the new gh stays, and says why.
reset; at 2.101.0; echo 2.100.0 > "$STATE/install-other-once"; policy 200 none 2.103.3
run; got=$?
[ "$got" = 3 ] || fail 'nothing to restore from: rejected, exits 3' 3 "$got"
has 'nothing to restore from: says so' "$(cat "$WORK/err")" "gh 2.101.0 is neither in cli.github.com's index nor in apt's cache"
lacks 'nothing to restore from: not restored' "$(report .detail)" 'restored:'
# An exact target the repository no longer lists, on a box already at it or
# above: current, the repository not asked (a review on #1102).
for at_v in 2.102.0 2.103.3; do
  reset; at "$at_v"; policy 200 none 2.102.0
  run; got=$?
  [ "$got" = 0 ] && [ "$(report .outcome)" = current ] || fail "exact target not listed, box at $at_v: current" "0 current" "$got $(report .outcome): $(report .detail)"
  lacks "exact target not listed, box at $at_v: says nothing of the repository" "$(cat "$WORK/err")" 'does not list'
done
# apt fails: failed, nothing rejected.
reset; at 2.96.0; echo 100 > "$STATE/apt-rc"; policy 200 none 2.103.3
run; got=$?
[ "$got" = 1 ] || fail 'apt fails: below the floor, exits 1' 1 "$got"
has 'apt fails: says FAILED' "$(cat "$WORK/err")" 'apt=2.96.0->FAILED'
[ ! -e "$ROOTSTATE/gh-update.rejected" ] || fail 'apt fails: nothing recorded' absent present
# apt fails part way, after unpacking the new gh: rejected, and the version
# before put back (Devin on #1102).
reset; at 2.101.0; printf '2.103.3\n2.101.0\n' > "$STATE/repo"; : > "$STATE/apt-partial-once"; policy 200 none 2.103.3
run; got=$?
[ "$got" = 3 ] || fail 'apt fails part way: rejected, exits 3' 3 "$got: $(tail -3 "$WORK/err")"
[ -s "$ROOTSTATE/gh-update.rejected" ] || fail 'apt fails part way: recorded' present absent
has 'apt fails part way: says so' "$(cat "$WORK/err")" 'apt-get failed part way through gh=2.103.3'
has 'apt fails part way: the version before is back' "$(cat "$WORK/err")" 'apt=2.101.0->pin-mismatch,restored:2.101.0'
[ "$(cat "$STATE/installed")" = 2.101.0 ] || fail 'apt fails part way: dpkg has the version before' 2.101.0 "$(cat "$STATE/installed")"

# ── no policy, or not this run's: nothing at all ────────────────────────────
for case in refused down unreadable stable; do
  reset; at 2.90.0
  case $case in
    refused) policy 403 force ;;
    down) policy 200 force; : > "$STATE/policy-down" ;;
    unreadable) printf 200 > "$STATE/policy-code"; printf 'not json' > "$STATE/policy-body" ;;
    stable) policy 200 force stable ;;
  esac
  run; got=$?
  lacks "no policy ($case): runs no apt at all" "$(cat "$LOG")" 'apt-get'
  has "no policy ($case): says why" "$(cat "$WORK/err")" 'gh has no fallback floor'
  [ "$got" = 0 ] || fail "no policy ($case): exits 0" 0 "$got"
  # Nothing installed or checked: the admin's update did not happen (Bugbot on #1080).
  [ "$case" = null ] || [ "$(report .outcome)" = failed ] || fail "no policy ($case): reported failed, never current" failed "$(report .outcome)"
done
[ "$(report 'has("target")')" = false ] || fail 'no policy: the report names no target' 'no target' "$(report .target)"
reset; at 2.96.0; policy 200 force 2.103.3 5 null
run
lacks 'run null: installs nothing' "$(cat "$LOG")" 'apt-get'
has 'run null: says why' "$(cat "$WORK/err")" "the orchestrator did not start run $RUN_ID"

# ── the agent config: the agent user's, and nothing that breaks curl's ──────
for bad in 'tok"en' 'tok en' "$(printf 'tok\nheader = "X: y"')"; do
  reset; at 2.96.0; policy 200 none 2.103.3; config "$bad"
  run
  lacks "bad token ($bad): asks nothing" "$(cat "$STATE/curl-calls" 2>/dev/null)" 'policy'
  lacks "bad token ($bad): installs nothing" "$(cat "$LOG")" 'apt-get'
done
for bad in 'https://orch.example.test/termag/ws/agent' 'wss://orch.example.test/termag/ws/agent?x=1' 'wss://a b/ws/agent' 'wss://orch.example.test/x"y/ws/agent'; do
  reset; at 2.96.0; policy 200 none 2.103.3; config tmag_box_token "$bad"
  run
  lacks "bad URL ($bad): asks nothing" "$(cat "$STATE/curl-calls" 2>/dev/null)" 'policy'
done
reset; at 2.96.0; policy 200 none 2.103.3; rm -f "$HOME_DIR/.termag/agent.config.json"
run
has 'no config: says so' "$(cat "$WORK/err")" 'no policy from the orchestrator (no-agent-config)'
# Injection through the policy: a version that is not x.y.z installs nothing.
for v in '2.103.3; id' '2.103.3 gh=1.0.0' '$(id)' '2.103'; do
  reset; at 2.96.0; printf '200' > "$STATE/policy-code"
  jq -nc --arg v "$v" --arg r "$RUN_ID" '{floor: "2.102.0", target: $v, restart: "none", drainSec: 5, run: {id: $r}}' > "$STATE/policy-body"
  run
  lacks "policy target '$v': installs nothing" "$(cat "$LOG")" 'apt-get'
done

# ── the lock ────────────────────────────────────────────────────────────────
reset; at 2.96.0; policy 200 none 2.103.3; mkdir -p "$ROOTSTATE"
( exec 9>"$ROOTSTATE/gh-update.lock"; flock 9; sleep 4 ) & holder=$!
sleep 0.5
run; got=$?
wait "$holder"
lacks 'lock held: installs nothing' "$(cat "$LOG")" ' install '
has 'lock held: says so' "$(cat "$WORK/err")" 'another termag-gh-update held the lock'
[ "$(report .outcome)" = failed ] || fail 'lock held: reported failed' failed "$(report .outcome)"
has 'lock held: the detail says why' "$(report .detail)" 'lock=held-by-another-run'

# ── usage, and who may run it ───────────────────────────────────────────────
for a in '' '--run' '--run short' "--run $RUN_ID extra" '--ensure 2.102.0' "--run ${RUN_ID}X;id"; do
  ARGS="${a:- }" run; got=$?
  [ "$got" = 2 ] || fail "usage '$a': exits 2" 2 "$got"
done
for u in '' 0 'ada' '1000;id'; do
  reset; AGENT_UID=$u run; got=$?
  [ "$got" = 2 ] || fail "agent uid '$u': exits 2" 2 "$got"
  [ ! -e "$STATE/curl-calls" ] || fail "agent uid '$u': asks nothing" 'no call' "$(cat "$STATE/curl-calls")"
done
env -i PATH=/usr/bin:/bin bash "$SCRIPT" --run "$RUN_ID" 2>"$WORK/err"; got=$?
[ "$got" = 2 ] || fail 'not root, no TERMAG_GH_AS_USER: refuses' 2 "$got"
has 'not root: says so' "$(cat "$WORK/err")" 'run as root'
if sudo -n true 2>/dev/null; then
  # As root the tests' overrides are not read: with no agent user it stops
  # before anything, whatever GH_BIN and the state directory say.
  sudo -n env -i PATH="$STUB:/usr/bin:/bin" TERMAG_GH_AS_USER=1 GH_BIN="$WORK/bin/gh" TERMAG_GH_STATE_DIR="$WORK/root-state" \
    bash "$SCRIPT" --run "$RUN_ID" 2>"$WORK/err"; got=$?
  [ "$got" = 2 ] || fail 'as root, no agent uid: exits 2' 2 "$got"
  [ ! -e "$WORK/root-state" ] || fail 'as root: TERMAG_GH_STATE_DIR is not read' absent present
fi

# ── termag-gh-update-start: one run id, nothing else ────────────────────────
for a in '' 'short' "$RUN_ID extra" "${RUN_ID}X;id" "../$RUN_ID" "$RUN_ID.service" '--help' "-$RUN_ID"; do
  # shellcheck disable=SC2086 # word splitting is the point: one or two arguments
  bash "$DIR/termag-gh-update-start" $a >/dev/null 2>&1; got=$?
  [ "$got" = 2 ] || fail "start helper '$a': refused" 2 "$got"
done

# ── termag-gh-update-setup ──────────────────────────────────────────────────
R="$WORK/root"
TERMAG_GH_SETUP_ROOT="$R" bash "$DIR/termag-gh-update-setup" --agent-user "$(id -un)" > "$WORK/setup.out" 2>&1; got=$?
[ "$got" = 0 ] || fail 'setup: exits 0' 0 "$got: $(cat "$WORK/setup.out")"
for f in 'usr/local/libexec/termag/termag-gh-update 755' 'usr/local/libexec/termag/termag-tool-update-lib 644' \
         'usr/local/libexec/termag/termag-gh-update-start 755' 'etc/systemd/system/termag-gh-update@.service 644' \
         'etc/termag/gh-update.env 644' 'etc/sudoers.d/termag-gh-update 440'; do
  p=${f% *} m=${f##* }
  [ "$(stat -c %a "$R/$p" 2>/dev/null)" = "$m" ] || fail "setup: /$p installed $m" "$m" "$(stat -c %a "$R/$p" 2>&1)"
done
[ "$(stat -c %a "$R/var/lib/termag/gh-update")" = 700 ] || fail 'setup: the state directory is 0700' 700 "$(stat -c %a "$R/var/lib/termag/gh-update")"
cmp -s "$DIR/termag-tool-update-lib" "$R/usr/local/libexec/termag/termag-tool-update-lib" || fail 'setup: root'"'"'s own copy of the lib' same differs
grep -qx "TERMAG_GH_AGENT_UID=$(id -u)" "$R/etc/termag/gh-update.env" || fail 'setup: the env file names the agent uid' "$(id -u)" "$(cat "$R/etc/termag/gh-update.env")"
got=$(grep -v '^#[^0-9]' "$R/etc/sudoers.d/termag-gh-update" | grep -v '^#$' | grep -v '^$')
[ "$got" = "#$(id -u) ALL=(root) NOPASSWD: /usr/local/libexec/termag/termag-gh-update-start ^[a-z0-9]+\$" ] || fail 'setup: one sudoers line, the helper only, for the agent uid' "#$(id -u) ALL=(root) NOPASSWD: .../termag-gh-update-start ^[a-z0-9]+\$" "$got"
has 'setup: the unit takes the recipe'"'"'s reported outcomes as success (Bugbot on #1102)' "$(cat "$R/etc/systemd/system/termag-gh-update@.service")" 'SuccessExitStatus=0 1 3'
has 'setup: the unit runs the root copy' "$(cat "$R/etc/systemd/system/termag-gh-update@.service")" 'ExecStart=/usr/local/libexec/termag/termag-gh-update --run %i'
TERMAG_GH_SETUP_ROOT="$R" bash "$DIR/termag-gh-update-setup" --agent-user "$(id -un)" > "$WORK/setup.out" 2>&1
[ ! -s "$WORK/setup.out" ] || fail 'setup: a current box writes nothing' '' "$(cat "$WORK/setup.out")"
TERMAG_GH_SETUP_ROOT="$R" bash "$DIR/termag-gh-update-setup" --agent-user "$(id -un)" --check > "$WORK/setup.out" 2>&1; got=$?
[ "$got" = 0 ] || fail 'setup --check: current, exits 0' 0 "$got: $(cat "$WORK/setup.out")"
echo changed >> "$R/usr/local/libexec/termag/termag-gh-update"
TERMAG_GH_SETUP_ROOT="$R" bash "$DIR/termag-gh-update-setup" --agent-user "$(id -un)" --check > "$WORK/setup.out" 2>&1; got=$?
[ "$got" = 1 ] || fail 'setup --check: drift exits 1' 1 "$got"
has 'setup --check: names it' "$(cat "$WORK/setup.out")" 'DRIFT: /usr/local/libexec/termag/termag-gh-update differs'
grep -q '^changed$' "$R/usr/local/libexec/termag/termag-gh-update" || fail 'setup --check: changes nothing' 'left' 'rewritten'
# A sudoers file that does not parse never goes in.
if command -v visudo >/dev/null 2>&1; then
  mkdir -p "$WORK/deploy"; cp "$DIR"/termag-gh-update "$DIR"/termag-gh-update-start "$DIR"/termag-gh-update@.service "$DIR"/termag-tool-update-lib "$WORK/deploy/"
  printf '#@AGENT_UID@ ALL=(root NOPASSWD /bin/sh\n' > "$WORK/deploy/termag-gh-update.sudoers"
  TERMAG_GH_SETUP_ROOT="$WORK/root2" TERMAG_GH_SETUP_DEPLOY="$WORK/deploy" bash "$DIR/termag-gh-update-setup" --agent-user "$(id -un)" > "$WORK/setup.out" 2>&1; got=$?
  [ "$got" = 1 ] || fail 'setup: a broken sudoers file fails' 1 "$got"
  [ ! -e "$WORK/root2/etc/sudoers.d/termag-gh-update" ] || fail 'setup: a broken sudoers file never goes in' absent present
fi
bash "$DIR/termag-gh-update-setup" --agent-user nosuchuser-termag >/dev/null 2>&1; got=$?
[ "$got" = 2 ] || fail 'setup: an unknown agent user exits 2' 2 "$got"

if [ "$failures" -eq 0 ]; then
  echo "ok: termag-gh-update"
else
  echo "$failures failure(s)"
  exit 1
fi
