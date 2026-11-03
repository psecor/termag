#!/bin/sh
# Tests deploy/termag-aws-update, the box's AWS CLI v2 updater (a root recipe on
# the GitHub CLI's seam), on deploy/termag-tool-update-lib,
# with the orchestrator and AWS's download site (curl) and getent stubbed on
# PATH, real gpgv against a throwaway signing key, and zips holding a stand-in
# for AWS's installer, run as this user (TERMAG_AWS_AS_USER=1, which only a
# run that is not root reads):
#
#   * --run asks for aws's policy (component=aws) with the agent token on
#     curl's stdin, never in an argument or a log line
#   * an exact target downloads that version's zip and .sig, verifies the
#     signature with the pinned key before anything is unpacked, checks the
#     package's own version, and runs the installer with --update; latest is
#     the unversioned zip, verified, its version read from it, downloaded once
#   * accepted only when the aws a shell starts says the version; otherwise
#     rejected (exit 3, recorded in the root state directory) and v2/current
#     put back to the version that ran, verified
#   * a zip whose signature does not verify, or that another key in the
#     keyring signed, is never unpacked; a package naming another version,
#     an unpublished version and a failing installer change nothing
#   * nothing moves down; no policy or run null installs nothing; no sessions
#   * the agent config, policy injection, the lock and usage as for gh
#   * termag-aws-update-start takes one run id and nothing else
#   * termag-aws-update-setup installs the recipe, its lib, AWS's key as a
#     keyring, the helper, the unit, the env file, the sudoers rule and the
#     state directory, and refuses a key file that is not AWS's key
#
# Run: sh deploy/termag-aws-update.test.sh
set -u

DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$DIR/termag-aws-update"
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
for c in flock jq gpg gpgv unzip python3; do
  command -v "$c" >/dev/null 2>&1 || { echo "SKIP: $c is required for this test"; exit 0; }
done

HOME_DIR="$WORK/home"
STUB="$WORK/stub"
STATE="$WORK/state"
SRV="$WORK/srv"
PREFIX="$WORK/root"
AWSDIR="$PREFIX/usr/local/aws-cli"
BINDIR="$PREFIX/usr/local/bin"
ROOTSTATE="$WORK/var-lib-termag-aws-update"
mkdir -p "$HOME_DIR/.termag" "$STUB" "$STATE" "$SRV" "$WORK/src"
export STATE SRV
case "$(uname -m)" in x86_64|amd64) ARCH=x86_64 ;; *) ARCH=aarch64 ;; esac

# ── a throwaway signing key, and another one ────────────────────────────────
G="$WORK/gnupg"; mkdir -m 0700 "$G"
gpg --homedir "$G" --batch --passphrase '' --quick-gen-key 'termag test <aws-test@example.test>' ed25519 sign never 2>/dev/null
gpg --homedir "$G" --batch --passphrase '' --quick-gen-key 'someone else <other@example.test>' ed25519 sign never 2>/dev/null
fpr() { gpg --homedir "$G" --batch --with-colons --fingerprint "$1" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }'; }
FP=$(fpr aws-test@example.test) OTHER=$(fpr other@example.test)
gpg --homedir "$G" --batch --export "$FP" > "$WORK/keyring.gpg"
gpg --homedir "$G" --batch --export "$FP" "$OTHER" > "$WORK/both.gpg"

# ── the zips ────────────────────────────────────────────────────────────────
# mkzip VERSION [SAYS] [NAME]: a zip as AWS publishes it (aws/install,
# aws/dist/aws), signed with the test key, served as NAME (default the
# versioned name). Its aws says SAYS (default VERSION). The installer stands
# in for AWS's: v2/<its version>, v2/current and the bin links, --update
# required over an install, a version already there skipped; it fails with
# $STATE/install-rc, and the installed aws says $STATE/live-says if set.
mkzip() {
  v=$1 says=${2:-$1} name=${3:-awscli-exe-linux-$ARCH-$1}
  s="$WORK/src/$v"; rm -rf "$s"; mkdir -p "$s/aws/dist"
  printf '#!/bin/sh\n[ "$1" = --version ] && echo "aws-cli/%s Python/3.14.8 Linux/6.8.0 exe/%s.ubuntu.24"\nexit 0\n' "$says" "$ARCH" > "$s/aws/dist/aws"
  cat > "$s/aws/install" <<'EOF'
#!/bin/sh
echo "install $*" >> "$STATE/install-calls"
[ -s "$STATE/install-rc" ] && exit "$(cat "$STATE/install-rc")"
here=$(cd "$(dirname "$0")" && pwd) up=no
while [ $# -gt 0 ]; do case "$1" in -i|--install-dir) idir=$2; shift ;; -b|--bin-dir) bdir=$2; shift ;; -u|--update) up=yes ;; esac; shift; done
v=$("$here/dist/aws" --version | cut -d ' ' -f 1 | cut -d / -f 2)
[ -L "$idir/v2/current" ] && [ "$up" = no ] && { echo 'Found preexisting AWS CLI installation' >&2; exit 1; }
[ -d "$idir/v2/$v" ] && { echo "Found same AWS CLI version: $idir/v2/$v. Skipping install."; exit 0; }
[ -e "$STATE/install-slow" ] && { mkdir -p "$idir/v2/$v"; ln -snf "$idir/v2/$v" "$idir/v2/current"; sleep 8; }
mkdir -p "$idir/v2/$v/bin" && cp -r "$here/dist" "$idir/v2/$v/dist"
if [ -s "$STATE/live-says" ]; then printf '#!/bin/sh\necho "aws-cli/%s Python/3.14.8"\n' "$(cat "$STATE/live-says")" > "$idir/v2/$v/bin/aws"
else printf '#!/bin/sh\nexec "%s" "$@"\n' "$idir/v2/$v/dist/aws" > "$idir/v2/$v/bin/aws"; fi
chmod +x "$idir/v2/$v/bin/aws"
ln -snf "$idir/v2/$v" "$idir/v2/current"
mkdir -p "$bdir" && ln -sf "$idir/v2/current/bin/aws" "$bdir/aws"
echo "You can now run: $bdir/aws --version"
EOF
  chmod +x "$s/aws/install" "$s/aws/dist/aws"
  python3 -I - "$s" "$SRV/$name.zip" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w') as z:
    for root, _, files in os.walk(src):
        for f in files:
            p = os.path.join(root, f); a = os.path.relpath(p, src)
            i = zipfile.ZipInfo(a); i.external_attr = (os.stat(p).st_mode & 0o777 | 0o100000) << 16
            z.writestr(i, open(p, 'rb').read())
PY
  gpg --homedir "$G" --batch --yes --local-user "${SIGNER:-$FP}" --detach-sign -o "$SRV/$name.zip.sig" "$SRV/$name.zip" 2>/dev/null
}
OLD=2.38.5 NEW=2.39.2 LATER=2.40.0
for v in "$OLD" "$NEW" "$LATER"; do mkzip "$v"; done
mkzip "$NEW" "$NEW" "awscli-exe-linux-$ARCH"
# installed VERSION: that version laid down by its own installer.
installed() {
  rm -rf "$AWSDIR" "$BINDIR" "$WORK/inst"; mkdir -p "$WORK/inst"
  unzip -q "$SRV/awscli-exe-linux-$ARCH-$1.zip" -d "$WORK/inst" && "$WORK/inst/aws/install" -i "$AWSDIR" -b "$BINDIR" >/dev/null
  : > "$STATE/install-calls"
}

# ── stubs ───────────────────────────────────────────────────────────────────
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
    -m|-w|-H|--proto) shift ;;
    -*) ;;
    *) url=$1 ;;
  esac
  shift
done
echo "$method $url" >> "$STATE/curl-calls"
case "$url" in
  https://awscli.example.test/*)
    f="$SRV/${url##*/}"; [ -f "$f" ] || exit 22
    cp "$f" "$out" ;;
  */tool-update/policy\?*)
    [ -e "$STATE/policy-down" ] && exit 7
    cat "$STATE/policy-body" > "$out"; printf '%s' "$(cat "$STATE/policy-code")" ;;
  */tool-update/report)
    printf '%s\n' "$data" > "$STATE/report-body"; : > "$out"; printf 204 ;;
  *) exit 6 ;;
esac
EOF
cat > "$STUB/getent" <<'EOF'
#!/bin/sh
[ "$1" = passwd ] && [ "$2" = "$(id -u)" ] && { printf 'ada:x:%s:%s::%s:/bin/bash\n' "$(id -u)" "$(id -g)" "$HOME_DIR"; exit 0; }
exit 2
EOF
chmod +x "$STUB/curl" "$STUB/getent"

RUN_ID=cmvtrun0000000000000000007
config() { printf '{"token":"%s","termag_url":"%s"}\n' "${1:-tmag_box_token}" "${2:-wss://orch.example.test/termag/ws/agent}" > "$HOME_DIR/.termag/agent.config.json"; }
policy() {  # policy CODE [RESTART [TARGET [DRAIN [RUN [FLOOR]]]]]
  printf '%s' "$1" > "$STATE/policy-code"
  printf '{"floor":"%s","target":"%s","restart":"%s","drainSec":%s,"run":%s}' \
    "${6:-2.35.3}" "${3:-$NEW}" "${2:-none}" "${4:-5}" "${5:-{\"id\":\"$RUN_ID\",\"component\":\"aws\"\}}" > "$STATE/policy-body"
}
reset() {
  rm -f "$STATE/install-rc" "$STATE/install-slow" "$STATE/live-says" "$STATE/install-calls" "$STATE/curl-calls" "$STATE/curl-args" "$STATE/curl-config" \
    "$STATE/report-body" "$STATE/policy-down" "$ROOTSTATE/aws-update.rejected"
  config
}
# shellcheck disable=SC2120 # extra env for one run, when a case needs it
run() {
  env -i PATH="$STUB:/usr/bin:/bin" HOME=/nonexistent STATE="$STATE" SRV="$SRV" HOME_DIR="$HOME_DIR" \
    TERMAG_AWS_AS_USER=1 TERMAG_AWS_AGENT_UID="${AGENT_UID-$(id -u)}" TERMAG_AWS_ROOT="$PREFIX" TERMAG_AWS_STATE_DIR="$ROOTSTATE" \
    TERMAG_AWS_KEYRING="${KEYRING:-$WORK/keyring.gpg}" TERMAG_AWS_FINGERPRINT="$FP" TERMAG_AWS_DOWNLOAD_URL=https://awscli.example.test \
    TERMAG_AWS_LOCK_WAIT=1 TERMAG_POLICY_TIMEOUT=5 "$@" \
    bash "$SCRIPT" ${ARGS:---run $RUN_ID} 2>"${ERRF:-$WORK/err}"
}
report() { jq -r "$1" "$STATE/report-body" 2>/dev/null; }
cur() { readlink "$AWSDIR/v2/current" 2>/dev/null | sed 's#.*/##'; }
calls() { cat "$STATE/curl-calls" 2>/dev/null; }

# ── older versions removed once the new one is verified (a review on #1110) ─
# Every v2/<version> but the new one and the one that ran goes; anything that
# is not a version directory stays.
reset; installed "$OLD"; policy 200 none "$NEW"
mkdir -p "$AWSDIR/v2/2.30.0/dist" "$AWSDIR/v2/notes"; : > "$AWSDIR/v2/2.30.0/dist/aws"
run; got=$?
[ "$got" = 0 ] || fail 'prune: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ ! -e "$AWSDIR/v2/2.30.0" ] || fail 'prune: an older version goes' absent present
[ -d "$AWSDIR/v2/$OLD" ] && [ -d "$AWSDIR/v2/$NEW" ] || fail 'prune: the new one and the one that ran stay' "$OLD $NEW" "$(ls "$AWSDIR/v2")"
[ -d "$AWSDIR/v2/notes" ] || fail 'prune: what is not a version stays' present absent
[ "$(cur)" = "$NEW" ] || fail 'prune: v2/current names the new one' "$NEW" "$(cur)"
has 'prune: says so' "$(cat "$WORK/err")" 'removed the older AWS CLI 2.30.0'
# A failed install removes nothing.
reset; installed "$OLD"; policy 200 none "$NEW"; mkdir -p "$AWSDIR/v2/2.30.0"; echo 1 > "$STATE/install-rc"
run
[ -d "$AWSDIR/v2/2.30.0" ] || fail 'prune: a failed install removes nothing' present absent

# ── an exact target: its signed zip, verified, installed with --update ──────
reset; installed "$OLD"; policy 200 idle "$NEW"
run; got=$?
[ "$got" = 0 ] || fail 'target: exits 0' 0 "$got: $(cat "$WORK/err")"
has 'target: asks for aws'"'"'s policy for its run' "$(calls)" "GET https://orch.example.test/termag/api/tool-update/policy?component=aws&run=$RUN_ID"
has 'target: the token goes on curl'"'"'s stdin' "$(cat "$STATE/curl-config")" 'Authorization: Bearer tmag_box_token'
lacks 'target: never in an argument' "$(cat "$STATE/curl-args")" 'tmag_box_token'
lacks 'target: never in a log line' "$(cat "$WORK/err")" 'tmag_box_token'
has 'target: downloads that version'"'"'s zip' "$(calls)" "GET https://awscli.example.test/awscli-exe-linux-$ARCH-$NEW.zip"
has 'target: and its signature' "$(calls)" "GET https://awscli.example.test/awscli-exe-linux-$ARCH-$NEW.zip.sig"
lacks 'target: never the unversioned zip' "$(calls)" "awscli-exe-linux-$ARCH.zip"
has 'target: https only' "$(cat "$STATE/curl-args")" "--proto =https"
has 'target: AWS'"'"'s installer, with --update' "$(cat "$STATE/install-calls")" "--install-dir $AWSDIR --bin-dir $BINDIR --update"
[ "$(cur)" = "$NEW" ] || fail 'target: v2/current is the new version' "$NEW" "$(cur)"
[ -d "$AWSDIR/v2/$OLD" ] || fail 'target: the old version'"'"'s directory is left' present absent
# Every user runs it: the install is not root-only, though the recipe's umask is 077.
[ "$(stat -c %a "$AWSDIR/v2/$NEW")" = 755 ] && [ "$(stat -c %a "$AWSDIR/v2/$NEW/dist/aws")" = 755 ] || fail 'target: the new version is readable and runnable by every user' '755 755' "$(stat -c %a "$AWSDIR/v2/$NEW" "$AWSDIR/v2/$NEW/dist/aws" | tr '\n' ' ')"
has 'target: verified' "$(cat "$WORK/err")" "aws is now $NEW, verified (its signature, its package and the aws a shell starts)"
got=$(report '[.component, .trigger, .run, .outcome, .target, .fromVersion, .toVersion, (.sessions | [.stopped, .resumed, .fresh, .cut, .typed, .other, .runnersLeft] | join(",")), (.panes | length)] | join(" ")')
[ "$got" = "aws manual $RUN_ID updated $NEW $OLD $NEW 0,0,0,0,0,0,0 0" ] || fail 'target: the report body' "aws manual $RUN_ID updated $NEW $OLD $NEW 0,0,0,0,0,0,0 0" "$got"
has 'target: no sessions to restart' "$(report .detail)" 'restart=idle(nothing on an old binary)'
[ "$(stat -c %a "$ROOTSTATE")" = 700 ] || fail 'target: the state directory is 0700' 700 "$(stat -c %a "$ROOTSTATE")"
[ -z "$(find "$ROOTSTATE" -name 'work.*' 2>/dev/null)" ] || fail 'target: the downloads are cleaned up' none "$(find "$ROOTSTATE" -name 'work.*')"

# At the target: nothing downloaded. Above it: nothing moves down.
reset; installed "$NEW"; policy 200 none "$NEW"
run; got=$?
[ "$got" = 0 ] || fail 'current: exits 0' 0 "$got"
lacks 'current: downloads nothing' "$(calls)" 'awscli.example.test'
[ "$(report .outcome)" = current ] || fail 'current: outcome current' current "$(report .outcome)"
reset; installed "$LATER"; policy 200 none "$NEW"
run
lacks 'no downgrade: downloads nothing' "$(calls)" 'awscli.example.test'
has 'no downgrade: says so' "$(cat "$WORK/err")" "installer=$LATER(no-downgrade)"

# ── latest: the unversioned zip, verified, its version read from it, once ───
reset; installed "$OLD"; policy 200 none latest
run; got=$?
[ "$got" = 0 ] || fail 'latest: exits 0' 0 "$got: $(cat "$WORK/err")"
[ "$(calls | grep -c "awscli-exe-linux-$ARCH.zip\$")" = 1 ] || fail 'latest: the unversioned zip, once' 1 "$(calls)"
lacks 'latest: no second download of the same version' "$(calls)" "awscli-exe-linux-$ARCH-$NEW.zip"
[ "$(cur)" = "$NEW" ] || fail 'latest: installs what the zip holds' "$NEW" "$(cur)"
[ "$(report .target)" = "$NEW" ] || fail 'latest: the report names the version' "$NEW" "$(report .target)"

# latest, and its zip cannot be downloaded: above the floor, the run did not
# reach its target, so it is failed, never current (Bugbot on #1110).
reset; installed "$OLD"; policy 200 idle latest; mv "$SRV/awscli-exe-linux-$ARCH.zip" "$WORK/latest.aside"
run
mv "$WORK/latest.aside" "$SRV/awscli-exe-linux-$ARCH.zip"
[ "$(cur)" = "$OLD" ] || fail 'latest not downloaded: nothing changed' "$OLD" "$(cur)"
[ "$(report .outcome)" = failed ] || fail 'latest not downloaded: reported failed, never current' failed "$(report .outcome)"

# ── never unpacked, never installed ─────────────────────────────────────────
# A zip that does not match its signature.
reset; installed "$OLD"; policy 200 none "$NEW"
cp "$SRV/awscli-exe-linux-$ARCH-$NEW.zip" "$WORK/good.zip"; printf 'x' >> "$SRV/awscli-exe-linux-$ARCH-$NEW.zip"
run; got=$?
cp "$WORK/good.zip" "$SRV/awscli-exe-linux-$ARCH-$NEW.zip"
has 'bad signature: says so' "$(cat "$WORK/err")" 'the signature does not verify with AWS'"'"'s key; not unpacked'
[ -z "$(cat "$STATE/install-calls" 2>/dev/null)" ] || fail 'bad signature: the installer never runs' none "$(cat "$STATE/install-calls")"
[ "$(cur)" = "$OLD" ] || fail 'bad signature: nothing changed' "$OLD" "$(cur)"
[ "$(report .outcome)" = failed ] || fail 'bad signature: reported failed' failed "$(report .outcome)"
# Signed by another key the keyring holds: not AWS's, pinned by fingerprint.
reset; installed "$OLD"; policy 200 none "$NEW"
SIGNER=$OTHER mkzip "$NEW"
KEYRING="$WORK/both.gpg" run; got=$?
mkzip "$NEW"
has 'another key: says so' "$(cat "$WORK/err")" "signed, but not by AWS's key $FP; not unpacked"
[ -z "$(cat "$STATE/install-calls" 2>/dev/null)" ] || fail 'another key: the installer never runs' none "$(cat "$STATE/install-calls")"
# No signature published: nothing.
reset; installed "$OLD"; policy 200 none "$NEW"; mv "$SRV/awscli-exe-linux-$ARCH-$NEW.zip.sig" "$WORK/sig.aside"
run
mv "$WORK/sig.aside" "$SRV/awscli-exe-linux-$ARCH-$NEW.zip.sig"
has 'no signature: says so' "$(cat "$WORK/err")" "could not download awscli-exe-linux-$ARCH-$NEW.zip.sig"
[ "$(cur)" = "$OLD" ] || fail 'no signature: nothing changed' "$OLD" "$(cur)"
# A package whose aws names another version.
reset; installed "$OLD"; policy 200 none "$NEW"; mkzip "$NEW" 2.39.9
run
mkzip "$NEW"
has 'other package: says so' "$(cat "$WORK/err")" "AWS CLI $NEW's package says 2.39.9; not installed, nothing changed"
[ "$(cur)" = "$OLD" ] || fail 'other package: nothing changed' "$OLD" "$(cur)"
# A version AWS never published.
reset; installed "$OLD"; policy 200 none 2.39.7
run
has 'unpublished: says so' "$(cat "$WORK/err")" "could not download awscli-exe-linux-$ARCH-2.39.7.zip"
[ "$(report .outcome)" = failed ] || fail 'unpublished: reported failed' failed "$(report .outcome)"
# The installer fails.
reset; installed "$OLD"; policy 200 none "$NEW"; echo 1 > "$STATE/install-rc"
run
has 'installer fails: says so' "$(cat "$WORK/err")" "AWS's installer failed; aws is $OLD as before"
[ "$(cur)" = "$OLD" ] || fail 'installer fails: nothing changed' "$OLD" "$(cur)"
[ ! -e "$ROOTSTATE/aws-update.rejected" ] || fail 'installer fails: nothing rejected' absent present

# ── rejected, restored ──────────────────────────────────────────────────────
reset; installed "$OLD"; policy 200 none "$NEW"; echo 2.39.8 > "$STATE/live-says"
run; got=$?
rm -f "$STATE/live-says"
[ "$got" = 3 ] || fail 'live mismatch: rejected, exits 3' 3 "$got: $(tail -3 "$WORK/err")"
grep -q '^aws ' "$ROOTSTATE/aws-update.rejected" 2>/dev/null || fail 'live mismatch: recorded, in the root state directory' 'aws ...' "$(cat "$ROOTSTATE/aws-update.rejected" 2>/dev/null)"
[ "$(cur)" = "$OLD" ] || fail 'live mismatch: v2/current is back at the version that ran' "$OLD" "$(cur)"
[ "$("$BINDIR/aws" --version | cut -d ' ' -f 1)" = "aws-cli/$OLD" ] || fail 'live mismatch: aws runs the version that ran' "aws-cli/$OLD" "$("$BINDIR/aws" --version 2>&1)"
has 'live mismatch: says so' "$(cat "$WORK/err")" "v2/current is back at $OLD, verified"
[ "$(report .outcome)" = failed ] || fail 'live mismatch: reported failed' failed "$(report .outcome)"
# The next run: the version's directory is there, the installer skips it, and
# current is still pointed at it; verified, the record goes.
rm -rf "$AWSDIR/v2/$NEW"; installed "$OLD"; printf 'aws asked for %s; an earlier run\n' "$NEW" > "$ROOTSTATE/aws-update.rejected"
rm -f "$STATE/report-body" "$STATE/curl-calls"
run; got=$?
[ "$got" = 0 ] || fail 'rejected, then verified: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ "$(cur)" = "$NEW" ] || fail 'rejected, then verified: current' "$NEW" "$(cur)"
[ ! -e "$ROOTSTATE/aws-update.rejected" ] || fail 'rejected, then verified: the record is gone' absent present

# A v2/<version> left half-written (or by a rejected run): AWS's installer
# would skip it; it is moved aside, and the verified package lands (Bugbot on #1110).
reset; installed "$OLD"; policy 200 none "$NEW"; mkdir -p "$AWSDIR/v2/$NEW/bin"; printf '#!/bin/sh\necho broken\n' > "$AWSDIR/v2/$NEW/bin/aws"; chmod +x "$AWSDIR/v2/$NEW/bin/aws"
run; got=$?
[ "$got" = 0 ] || fail 'leftover version dir: exits 0' 0 "$got: $(tail -3 "$WORK/err")"
[ "$("$BINDIR/aws" --version | cut -d ' ' -f 1)" = "aws-cli/$NEW" ] || fail 'leftover version dir: the verified package is what runs' "aws-cli/$NEW" "$("$BINDIR/aws" --version 2>&1)"
has 'leftover version dir: says so' "$(cat "$WORK/err")" "moved the $NEW already in $AWSDIR/v2 aside"
[ -z "$(find "$AWSDIR/v2" -maxdepth 1 -name '.termag-replaced-*' 2>/dev/null)" ] || fail 'leftover version dir: the copy moved aside is removed once the package landed' none "$(ls -a "$AWSDIR/v2")"
# The installer fails after the leftover was moved aside: it comes back, and
# v2/current names the version that ran.
reset; installed "$OLD"; policy 200 none "$NEW"; mkdir -p "$AWSDIR/v2/$NEW/bin"; echo leftover > "$AWSDIR/v2/$NEW/marker"; echo 1 > "$STATE/install-rc"
run
[ "$(cat "$AWSDIR/v2/$NEW/marker" 2>/dev/null)" = leftover ] || fail 'installer fails over a leftover: the leftover is back' leftover "$(ls -a "$AWSDIR/v2/$NEW" 2>&1)"
[ "$(cur)" = "$OLD" ] || fail 'installer fails over a leftover: v2/current names the version that ran' "$OLD" "$(cur)"
[ -z "$(find "$AWSDIR/v2" -maxdepth 1 -name '.termag-replaced-*' 2>/dev/null)" ] || fail 'installer fails over a leftover: no copy left aside' none "$(ls -a "$AWSDIR/v2")"

# A signal while the installer writes v2/<version> over a leftover: the
# partial tree goes, the leftover comes back, and v2/current names the
# version that ran (Bugbot on #1110).
reset; installed "$OLD"; policy 200 none "$NEW"; mkdir -p "$AWSDIR/v2/$NEW/bin"; echo leftover > "$AWSDIR/v2/$NEW/marker"; : > "$STATE/install-slow"
run & rp=$!
for _ in $(seq 1 100); do grep -q "installing AWS CLI $NEW" "$WORK/err" 2>/dev/null && break; sleep 0.2; done
sleep 2; kill -TERM "$(pgrep -f "termag-aws-update --run $RUN_ID" | head -n 1)"; wait "$rp"
rm -f "$STATE/install-slow"; for p in $(pgrep -f "$ROOTSTATE/work.*/aws/install"); do kill "$p" 2>/dev/null; done; sleep 1
[ "$(cat "$AWSDIR/v2/$NEW/marker" 2>/dev/null)" = leftover ] || fail 'signal mid-install: the leftover is back' leftover "$(ls -a "$AWSDIR/v2/$NEW" 2>&1)"
[ "$(cur)" = "$OLD" ] || fail 'signal mid-install: v2/current names the version that ran' "$OLD" "$(cur)"
# A TERM to the recipe alone, not to the installer (Bugbot on #1110): bash
# runs the trap only once the installer, its foreground child, has exited,
# so the rollback comes after it and nothing it writes outlives the run.
reset; installed "$OLD"; policy 200 none "$NEW"; rm -rf "$AWSDIR/v2/$NEW"; : > "$STATE/install-slow"
run & rp=$!
for _ in $(seq 1 100); do grep -q "installing AWS CLI $NEW" "$WORK/err" 2>/dev/null && break; sleep 0.2; done
sleep 2; kill -TERM "$(pgrep -f "termag-aws-update --run $RUN_ID" | head -n 1)"; wait "$rp"; got=$?
rm -f "$STATE/install-slow"
[ "$got" = 143 ] || fail 'TERM to the recipe alone: exits 143' 143 "$got"
[ -z "$(pgrep -f "$ROOTSTATE/work.*/aws/install")" ] || fail 'TERM to the recipe alone: no installer outlives the run' none "$(pgrep -af "$ROOTSTATE/work.*/aws/install")"
sleep 1
[ "$(cur)" = "$OLD" ] || fail 'TERM to the recipe alone: v2/current names the version that ran' "$OLD" "$(cur)"
[ ! -e "$AWSDIR/v2/$NEW" ] || fail 'TERM to the recipe alone: nothing of the new version is left' absent "$(ls -a "$AWSDIR/v2/$NEW" 2>&1)"
# The same with no v2/<version> there before (the usual upgrade): the partial
# tree goes, and v2/current names the version that ran (Devin on #1110).
reset; installed "$OLD"; policy 200 none "$NEW"; rm -rf "$AWSDIR/v2/$NEW"; : > "$STATE/install-slow"
run & rp=$!
for _ in $(seq 1 100); do grep -q "installing AWS CLI $NEW" "$WORK/err" 2>/dev/null && break; sleep 0.2; done
sleep 2; kill -TERM "$(pgrep -f "termag-aws-update --run $RUN_ID" | head -n 1)"; wait "$rp"
rm -f "$STATE/install-slow"; for p in $(pgrep -f "$ROOTSTATE/work.*/aws/install"); do kill "$p" 2>/dev/null; done; sleep 1
[ "$(cur)" = "$OLD" ] || fail 'signal mid-install, first upgrade: v2/current names the version that ran' "$OLD" "$(cur)"
[ ! -e "$AWSDIR/v2/$NEW" ] || fail 'signal mid-install, first upgrade: the partial tree goes' absent "$(ls -a "$AWSDIR/v2/$NEW" 2>&1)"
[ "$("$BINDIR/aws" --version | cut -d ' ' -f 1)" = "aws-cli/$OLD" ] || fail 'signal mid-install, first upgrade: aws runs the version that ran' "aws-cli/$OLD" "$("$BINDIR/aws" --version 2>&1)"

# ── no policy, or not this run's: nothing at all ────────────────────────────
for case in refused down unreadable stable; do
  reset; installed "$OLD"
  case $case in
    refused) policy 403 force ;;
    down) policy 200 force; : > "$STATE/policy-down" ;;
    unreadable) printf 200 > "$STATE/policy-code"; printf 'not json' > "$STATE/policy-body" ;;
    stable) policy 200 force stable ;;
  esac
  run; got=$?
  lacks "no policy ($case): downloads nothing" "$(calls)" 'awscli.example.test'
  has "no policy ($case): says why" "$(cat "$WORK/err")" 'the AWS CLI has no fallback floor'
  [ "$got" = 0 ] || fail "no policy ($case): exits 0" 0 "$got"
  # Nothing installed or checked: the admin's update did not happen (Bugbot on #1080).
  [ "$case" = null ] || [ "$(report .outcome)" = failed ] || fail "no policy ($case): reported failed, never current" failed "$(report .outcome)"
done
[ "$(report 'has("target")')" = false ] || fail 'no policy: the report names no target' 'no target' "$(report .target)"
reset; installed "$OLD"; policy 200 force "$NEW" 5 null
run
lacks 'run null: downloads nothing' "$(calls)" 'awscli.example.test'
has 'run null: says why' "$(cat "$WORK/err")" "the orchestrator did not start run $RUN_ID"

# ── the agent config, and the policy ────────────────────────────────────────
for bad in 'tok"en' 'tok en' "$(printf 'tok\nheader = "X: y"')"; do
  reset; installed "$OLD"; policy 200 none "$NEW"; config "$bad"
  run
  lacks "bad token ($bad): asks nothing" "$(calls)" 'policy'
  lacks "bad token ($bad): downloads nothing" "$(calls)" 'awscli.example.test'
done
for bad in 'https://orch.example.test/termag/ws/agent' 'wss://orch.example.test/termag/ws/agent?x=1' 'wss://a b/ws/agent'; do
  reset; installed "$OLD"; policy 200 none "$NEW"; config tmag_box_token "$bad"
  run
  lacks "bad URL ($bad): asks nothing" "$(calls)" 'policy'
done
for v in "$NEW; id" "$NEW/../x" '$(id)' '2.39' "../$NEW"; do
  reset; installed "$OLD"; printf '200' > "$STATE/policy-code"
  jq -nc --arg v "$v" --arg r "$RUN_ID" '{floor: "2.35.3", target: $v, restart: "none", drainSec: 5, run: {id: $r}}' > "$STATE/policy-body"
  run
  lacks "policy target '$v': downloads nothing" "$(calls)" 'awscli.example.test'
done

# ── the lock ────────────────────────────────────────────────────────────────
reset; installed "$OLD"; policy 200 none "$NEW"; mkdir -p "$ROOTSTATE"
( exec 9>"$ROOTSTATE/aws-update.lock"; flock 9; sleep 4 ) & holder=$!
sleep 0.5
run
wait "$holder"
lacks 'lock held: downloads nothing' "$(calls)" 'awscli.example.test'
has 'lock held: says so' "$(cat "$WORK/err")" 'another termag-aws-update held the lock'
[ "$(report .outcome)" = failed ] || fail 'lock held: reported failed' failed "$(report .outcome)"
has 'lock held: the detail says why' "$(report .detail)" 'lock=held-by-another-run'

# ── usage, and who may run it ───────────────────────────────────────────────
for a in '' '--run' '--run short' "--run $RUN_ID extra" "--run ${RUN_ID}X;id"; do
  ARGS="${a:- }" run; got=$?
  [ "$got" = 2 ] || fail "usage '$a': exits 2" 2 "$got"
done
for u in '' 0 'ada' '1000;id'; do
  reset; AGENT_UID=$u run; got=$?
  [ "$got" = 2 ] || fail "agent uid '$u': exits 2" 2 "$got"
done
env -i PATH=/usr/bin:/bin bash "$SCRIPT" --run "$RUN_ID" 2>"$WORK/err"; got=$?
[ "$got" = 2 ] || fail 'not root, no TERMAG_AWS_AS_USER: refuses' 2 "$got"
if sudo -n true 2>/dev/null; then
  sudo -n env -i PATH="$STUB:/usr/bin:/bin" TERMAG_AWS_AS_USER=1 TERMAG_AWS_STATE_DIR="$WORK/root-state" TERMAG_AWS_ROOT="$WORK/root-prefix" \
    bash "$SCRIPT" --run "$RUN_ID" 2>"$WORK/err"; got=$?
  [ "$got" = 2 ] || fail 'as root, no agent uid: exits 2' 2 "$got"
  [ ! -e "$WORK/root-state" ] && [ ! -e "$WORK/root-prefix" ] || fail 'as root: the tests'"'"' overrides are not read' absent present
fi

# ── termag-aws-update-start: one run id, nothing else ───────────────────────
for a in '' 'short' "$RUN_ID extra" "${RUN_ID}X;id" "../$RUN_ID" "$RUN_ID.service" '--help'; do
  # shellcheck disable=SC2086 # word splitting is the point: one or two arguments
  bash "$DIR/termag-aws-update-start" $a >/dev/null 2>&1; got=$?
  [ "$got" = 2 ] || fail "start helper '$a': refused" 2 "$got"
done

# ── termag-aws-update-setup ─────────────────────────────────────────────────
R="$WORK/sroot"
TERMAG_AWS_SETUP_ROOT="$R" bash "$DIR/termag-aws-update-setup" --agent-user "$(id -un)" > "$WORK/setup.out" 2>&1; got=$?
[ "$got" = 0 ] || fail 'setup: exits 0' 0 "$got: $(cat "$WORK/setup.out")"
for f in 'usr/local/libexec/termag/termag-aws-update 755' 'usr/local/libexec/termag/termag-tool-update-lib 644' \
         'usr/local/libexec/termag/termag-aws-cli.gpg 644' 'usr/local/libexec/termag/termag-aws-update-start 755' \
         'etc/systemd/system/termag-aws-update@.service 644' 'etc/termag/aws-update.env 644' 'etc/sudoers.d/termag-aws-update 440'; do
  p=${f% *} m=${f##* }
  [ "$(stat -c %a "$R/$p" 2>/dev/null)" = "$m" ] || fail "setup: /$p installed $m" "$m" "$(stat -c %a "$R/$p" 2>&1)"
done
[ "$(stat -c %a "$R/var/lib/termag/aws-update")" = 700 ] || fail 'setup: the state directory is 0700' 700 "$(stat -c %a "$R/var/lib/termag/aws-update")"
got=$(gpg --homedir "$G" --batch --with-colons --show-keys "$R/usr/local/libexec/termag/termag-aws-cli.gpg" 2>/dev/null | awk -F: '$1 == "fpr" { print $10 }' | head -n 1)
[ "$got" = FB5DB77FD5C118B80511ADA8A6310ACC4672475C ] || fail 'setup: the keyring is AWS'"'"'s key' FB5DB77FD5C118B80511ADA8A6310ACC4672475C "$got"
grep -qx "TERMAG_AWS_AGENT_UID=$(id -u)" "$R/etc/termag/aws-update.env" || fail 'setup: the env file names the agent uid' "$(id -u)" "$(cat "$R/etc/termag/aws-update.env")"
got=$(grep -v '^#[^0-9]' "$R/etc/sudoers.d/termag-aws-update" | grep -v '^#$' | grep -v '^$')
[ "$got" = "#$(id -u) ALL=(root) NOPASSWD: /usr/local/libexec/termag/termag-aws-update-start ^[a-z0-9]+\$" ] || fail 'setup: one sudoers line, the helper only' "#$(id -u) ALL=(root) NOPASSWD: .../termag-aws-update-start ^[a-z0-9]+\$" "$got"
has 'setup: the unit takes reported outcomes as success' "$(cat "$R/etc/systemd/system/termag-aws-update@.service")" 'SuccessExitStatus=0 1 3'
has 'setup: the unit runs the root copy' "$(cat "$R/etc/systemd/system/termag-aws-update@.service")" 'ExecStart=/usr/local/libexec/termag/termag-aws-update --run %i'
TERMAG_AWS_SETUP_ROOT="$R" bash "$DIR/termag-aws-update-setup" --agent-user "$(id -un)" --check > "$WORK/setup.out" 2>&1; got=$?
[ "$got" = 0 ] || fail 'setup --check: current, exits 0' 0 "$got: $(cat "$WORK/setup.out")"
echo changed >> "$R/usr/local/libexec/termag/termag-aws-update"
TERMAG_AWS_SETUP_ROOT="$R" bash "$DIR/termag-aws-update-setup" --agent-user "$(id -un)" --check > "$WORK/setup.out" 2>&1; got=$?
[ "$got" = 1 ] || fail 'setup --check: drift exits 1' 1 "$got"
# A key file that is not AWS's key never becomes the keyring.
mkdir -p "$WORK/deploy"; cp "$DIR"/termag-aws-update "$DIR"/termag-aws-update-start "$DIR"/termag-aws-update@.service "$DIR"/termag-aws-update.sudoers "$DIR"/termag-tool-update-lib "$WORK/deploy/"
gpg --homedir "$G" --batch --armor --export "$FP" > "$WORK/deploy/termag-aws-cli.asc"
TERMAG_AWS_SETUP_ROOT="$WORK/sroot2" TERMAG_AWS_SETUP_DEPLOY="$WORK/deploy" bash "$DIR/termag-aws-update-setup" --agent-user "$(id -un)" > "$WORK/setup.out" 2>&1; got=$?
[ "$got" = 1 ] || fail 'setup: another key fails' 1 "$got"
[ ! -e "$WORK/sroot2/usr/local/libexec/termag/termag-aws-cli.gpg" ] || fail 'setup: another key never becomes the keyring' absent present
has 'setup: says so' "$(cat "$WORK/setup.out")" "is not AWS's key FB5DB77FD5C118B80511ADA8A6310ACC4672475C"

if [ "$failures" -eq 0 ]; then
  echo "ok: termag-aws-update"
else
  echo "$failures failure(s)"
  exit 1
fi
