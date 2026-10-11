#!/bin/sh
# Tests cli/install.sh against a copy of cli/ in a temp checkout, with a clean
# HOME and a PATH that holds only the system tools and the Node under test. The
# copy's path has a space and a quote in it, which the launcher must survive.
#
# Needs network the first time (npm ci of cli/'s dev dependencies).
#
# Run: sh cli/install.test.sh
set -u

SRC="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)" || { echo "FAIL: node is not on PATH"; exit 1; }
WORK="$(mktemp -d)"
trap 'chmod -R u+w "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

CHECKOUT="$WORK/it's a checkout"
HOME_DIR="$WORK/home"
NODE_DIR="$WORK/node-bin"
mkdir -p "$CHECKOUT/cli" "$HOME_DIR" "$NODE_DIR"
(cd "$SRC" && tar cf - --exclude=node_modules --exclude=dist --exclude=.dist-build .) | (cd "$CHECKOUT/cli" && tar xf -)
# The Node under test, alone in its directory so PATH can include or omit it.
ln -s "$NODE" "$NODE_DIR/node"
NPM="$(command -v npm)" || { echo "FAIL: npm is not on PATH"; exit 1; }
ln -s "$NPM" "$NODE_DIR/npm"

SYS_PATH=/usr/bin:/bin
LOCAL_BIN="$HOME_DIR/.local/bin"
install_cli() { env -i HOME="$HOME_DIR" PATH="$P" sh "$CHECKOUT/cli/install.sh" "$@"; }
termag() { env -i HOME="$HOME_DIR" PATH="$P" "$LOCAL_BIN/termag" "$@"; }

# ── first install ───────────────────────────────────────────────────────────
P="$NODE_DIR:$LOCAL_BIN:$SYS_PATH"
out="$(install_cli 2>&1)"
got=$?
[ "$got" = 0 ] || fail 'first install exits 0' 0 "$got: $out"
[ -x "$LOCAL_BIN/termag" ] || fail 'writes ~/.local/bin/termag when it is on PATH' 'executable' 'absent'
[ -f "$CHECKOUT/cli/dist/main.js" ] || fail 'builds dist/' 'dist/main.js' 'absent'
case "$out" in
  *'termag 0.1.0 from'*) : ;;
  *) fail 'reports the installed version' 'termag 0.1.0 from ...' "$out" ;;
esac
case "$out" in
  *'not on PATH'*) fail 'no PATH hint when the directory is on PATH' '(no hint)' "$out" ;;
esac
got="$(termag --version 2>&1)"
[ "$got" = 'termag 0.1.0' ] || fail 'the launcher runs the CLI' 'termag 0.1.0' "$got"

# ── it pins the Node it was built with ──────────────────────────────────────
P="$LOCAL_BIN:$SYS_PATH"
got="$(termag --version 2>&1)"
[ "$got" = 'termag 0.1.0' ] || fail 'runs with no node on PATH' 'termag 0.1.0' "$got"

# ── a re-run with nothing changed does nothing ──────────────────────────────
P="$NODE_DIR:$LOCAL_BIN:$SYS_PATH"
touch "$CHECKOUT/cli/dist/.sentinel"
before="$(cat "$LOCAL_BIN/termag")"
out="$(install_cli --quiet 2>&1)"
got=$?
[ "$got" = 0 ] || fail 'quiet re-run exits 0' 0 "$got"
[ -z "$out" ] || fail 'quiet re-run is silent' '(no output)' "$out"
[ -f "$CHECKOUT/cli/dist/.sentinel" ] || fail 'a re-run does not rebuild' 'dist kept' 'dist replaced'
[ "$(cat "$LOCAL_BIN/termag")" = "$before" ] || fail 'a re-run keeps the launcher' "$before" "$(cat "$LOCAL_BIN/termag")"
out="$(install_cli --check 2>&1)"
got=$?
[ "$got" = 0 ] || fail '--check exits 0 when current' 0 "$got: $out"
[ -z "$out" ] || fail '--check is silent when current' '(no output)' "$out"

# ── a source change (what `git pull` brings) is rebuilt ─────────────────────
printf "export const VERSION = '0.1.1';\n" > "$CHECKOUT/cli/src/version.ts"
out="$(install_cli --check 2>&1)"
got=$?
[ "$got" = 1 ] || fail '--check exits 1 on stale sources' 1 "$got"
case "$out" in
  *STALE*dist*) : ;;
  *) fail '--check names the stale build' 'STALE ... dist' "$out" ;;
esac
[ "$(termag --version)" = 'termag 0.1.0' ] || fail '--check changes nothing' 'termag 0.1.0' "$(termag --version)"
install_cli --quiet >/dev/null 2>&1
got="$(termag --version 2>&1)"
[ "$got" = 'termag 0.1.1' ] || fail 'a re-run picks up changed sources' 'termag 0.1.1' "$got"
[ -f "$CHECKOUT/cli/dist/.sentinel" ] && fail 'a rebuild replaces dist/' 'fresh dist' 'old dist'
# A test-only change is not a reason to rebuild.
touch "$CHECKOUT/cli/dist/.sentinel"
printf '\n' >> "$CHECKOUT/cli/src/cli.test.ts"
install_cli --quiet >/dev/null 2>&1
[ -f "$CHECKOUT/cli/dist/.sentinel" ] || fail 'a test-only change does not rebuild' 'dist kept' 'dist replaced'

# ── a failed build leaves the previous one working ──────────────────────────
cp "$CHECKOUT/cli/src/version.ts" "$WORK/version.ts"
printf 'export const VERSION: number = "broken";\n' > "$CHECKOUT/cli/src/version.ts"
out="$(install_cli 2>&1)"
got=$?
[ "$got" = 1 ] || fail 'a failed build exits 1' 1 "$got"
case "$out" in
  *'previous build'*) : ;;
  *) fail 'a failed build says the old one is kept' 'previous build ... unchanged' "$out" ;;
esac
[ "$(termag --version 2>&1)" = 'termag 0.1.1' ] || fail 'the previous build still runs' 'termag 0.1.1' "$(termag --version 2>&1)"
[ -e "$CHECKOUT/cli/.dist-build" ] && fail 'no scratch build left behind' 'absent' 'present'
cp "$WORK/version.ts" "$CHECKOUT/cli/src/version.ts"

# ── a read-only checkout keeps its build and still links ────────────────────
printf "export const VERSION = '0.1.2';\n" > "$CHECKOUT/cli/src/version.ts"
rm -f "$LOCAL_BIN/termag"
chmod a-w "$CHECKOUT/cli"
out="$(install_cli --quiet 2>&1)"
got=$?
chmod u+w "$CHECKOUT/cli"
[ "$got" = 1 ] || fail 'a stale read-only checkout exits 1' 1 "$got"
case "$out" in
  *'not writable'*) : ;;
  *) fail 'says the checkout is read-only' 'not writable' "$out" ;;
esac
[ "$(termag --version 2>&1)" = 'termag 0.1.1' ] || fail 'links the existing build' 'termag 0.1.1' "$(termag --version 2>&1)"
install_cli --quiet >/dev/null 2>&1

# ── PATH hint, and --bin-dir ────────────────────────────────────────────────
P="$NODE_DIR:$SYS_PATH"
out="$(install_cli 2>&1)"
case "$out" in
  *"$LOCAL_BIN is not on PATH"*'export PATH='*) : ;;
  *) fail 'hints at PATH when ~/.local/bin is not on it' "$LOCAL_BIN is not on PATH ... export PATH=" "$out" ;;
esac
out="$(install_cli --bin-dir "$WORK/my bin" 2>&1)"
got=$?
[ "$got" = 0 ] || fail '--bin-dir exits 0' 0 "$got: $out"
got="$(env -i HOME="$HOME_DIR" PATH="$SYS_PATH" "$WORK/my bin/termag" --version 2>&1)"
[ "$got" = 'termag 0.1.2' ] || fail '--bin-dir writes a working launcher' 'termag 0.1.2' "$got"
grep -q "TERMAG_CLI_BIN='$WORK/my bin/termag'" "$WORK/my bin/termag" \
  || fail 'the launcher records where it is' "TERMAG_CLI_BIN='$WORK/my bin/termag'" "$(cat "$WORK/my bin/termag")"

# ── a `termag` this script did not write is left alone without --force ──────
P="$NODE_DIR:$LOCAL_BIN:$SYS_PATH"
printf '#!/bin/sh\necho mine\n' > "$LOCAL_BIN/termag"
out="$(install_cli 2>&1)"
got=$?
[ "$got" = 1 ] || fail 'a foreign termag exits 1' 1 "$got"
case "$out" in
  *'not written by this installer'*'--force'*) : ;;
  *) fail 'explains the foreign termag' 'not written by this installer ... --force' "$out" ;;
esac
[ "$(termag)" = mine ] || fail 'leaves the foreign termag' mine "$(termag)"
install_cli --check >/dev/null 2>&1
[ $? = 1 ] || fail '--check exits 1 on a foreign termag' 1 0
install_cli --force --quiet >/dev/null 2>&1
[ "$(termag --version 2>&1)" = 'termag 0.1.2' ] || fail '--force replaces it' 'termag 0.1.2' "$(termag --version 2>&1)"

# ── the pinned Node gone: falls back to node on PATH ────────────────────────
mkdir -p "$WORK/node-pinned"
ln -s "$NODE" "$WORK/node-pinned/node"
install_cli --quiet --node "$WORK/node-pinned/node" >/dev/null 2>&1
rm -f "$WORK/node-pinned/node"
got="$(termag --version 2>&1)"
[ "$got" = 'termag 0.1.2' ] || fail 'falls back to node on PATH' 'termag 0.1.2' "$got"
install_cli --quiet >/dev/null 2>&1

# ── Node older than 20 is refused ───────────────────────────────────────────
mkdir -p "$WORK/old-node"
printf '#!/bin/sh\necho 18.19.0\n' > "$WORK/old-node/node"
chmod 755 "$WORK/old-node/node"
out="$(env -i HOME="$HOME_DIR" PATH="$WORK/old-node:$SYS_PATH" sh "$CHECKOUT/cli/install.sh" 2>&1)"
got=$?
[ "$got" = 1 ] || fail 'Node 18 exits 1' 1 "$got"
case "$out" in
  *'Node.js 20 or newer is required'*'v18.19.0'*) : ;;
  *) fail 'names the Node it found' 'Node.js 20 or newer ... v18.19.0' "$out" ;;
esac
out="$(env -i HOME="$HOME_DIR" PATH="$SYS_PATH" sh "$CHECKOUT/cli/install.sh" 2>&1)"
[ $? = 1 ] || fail 'no node at all exits 1' 1 0
case "$out" in
  *'not on PATH'*) : ;;
  *) fail 'says node is missing' 'not on PATH' "$out" ;;
esac

# ── termag update --no-pull reinstalls through the same launcher ────────────
printf "export const VERSION = '0.1.3';\n" > "$CHECKOUT/cli/src/version.ts"
out="$(termag update --no-pull --json 2>/dev/null)"
got=$?
[ "$got" = 0 ] || fail 'termag update exits 0' 0 "$got"
case "$out" in
  *'"updated":true'*'"pulled":false'*) : ;;
  *) fail 'termag update --json reports' '{"updated":true,...,"pulled":false}' "$out" ;;
esac
[ "$(termag --version 2>&1)" = 'termag 0.1.3' ] || fail 'termag update rebuilds' 'termag 0.1.3' "$(termag --version 2>&1)"

# ── termag update pulls the clone's own branch, and warns off main ──────────
# The checkout becomes a clone of a bare remote; a second clone pushes to it.
g() { git -c user.name=test -c user.email=test@example.com -c init.defaultBranch=main "$@"; }
printf 'node_modules/\ndist/\n.dist-build/\n' > "$CHECKOUT/.gitignore"
g -C "$CHECKOUT" init -q
g -C "$CHECKOUT" add -A
g -C "$CHECKOUT" commit -qm base
g init -q --bare "$WORK/remote.git"
g -C "$CHECKOUT" remote add origin "$WORK/remote.git"
g -C "$CHECKOUT" push -q -u origin main
g -C "$CHECKOUT" checkout -qb feature
g -C "$CHECKOUT" push -q -u origin feature
g clone -q "$WORK/remote.git" "$WORK/other"
push_version() {
  g -C "$WORK/other" checkout -q "$1"
  g -C "$WORK/other" pull -q --ff-only
  printf "export const VERSION = '%s';\n" "$2" > "$WORK/other/cli/src/version.ts"
  g -C "$WORK/other" commit -qam "v$2"
  g -C "$WORK/other" push -q origin "$1"
}

push_version feature 0.2.0
# The launcher records the physical path (macOS: /var is /private/var).
CHECKOUT_P="$(cd "$CHECKOUT" && pwd -P)"
err="$(termag update 2>&1 >/dev/null)"
got=$?
[ "$got" = 0 ] || fail 'termag update on a branch exits 0' 0 "$got: $err"
case "$err" in
  *"warning: $CHECKOUT_P is on branch \`feature\`, not \`main\`; pulling \`feature\`"*) : ;;
  *) fail 'warns that the clone is not on main, naming the branch' "warning: ... on branch \`feature\`, not \`main\`" "$err" ;;
esac
[ "$(printf '%s\n' "$err" | grep -c 'warning:')" = 1 ] || fail 'warns once' 1 "$(printf '%s\n' "$err" | grep -c 'warning:')"
[ "$(termag --version 2>&1)" = 'termag 0.2.0' ] || fail 'pulls and rebuilds the branch' 'termag 0.2.0' "$(termag --version 2>&1)"
got="$(git -C "$CHECKOUT" symbolic-ref --short HEAD)"
[ "$got" = feature ] || fail 'never switches branches' feature "$got"

g -C "$CHECKOUT" checkout -q main
push_version main 0.3.0
err="$(termag update 2>&1 >/dev/null)"
got=$?
[ "$got" = 0 ] || fail 'termag update on main exits 0' 0 "$got: $err"
case "$err" in
  *warning:*) fail 'no warning on main' '(no warning)' "$err" ;;
esac
[ "$(termag --version 2>&1)" = 'termag 0.3.0' ] || fail 'pulls and rebuilds main' 'termag 0.3.0' "$(termag --version 2>&1)"

g -C "$CHECKOUT" checkout -q --detach
out="$(termag update 2>&1)"
got=$?
[ "$got" = 1 ] || fail 'a detached HEAD exits 1' 1 "$got"
case "$out" in
  *'detached HEAD'*) : ;;
  *) fail 'says it will not pull a detached HEAD' 'detached HEAD' "$out" ;;
esac
g -C "$CHECKOUT" checkout -q main

# ── termag update rebuilds a TUI that was built, and only then ──────────────
# With Node 22+ the real tui/ is built and rebuilt; under an older Node the
# update prints the hint and still succeeds. CI runs both.
mkdir -p "$CHECKOUT/tui"
(cd "$SRC/../tui" && tar cf - --exclude=node_modules --exclude=dist --exclude=.dist-build .) | (cd "$CHECKOUT/tui" && tar xf -)
err="$(termag update --no-pull 2>&1 >/dev/null)"
[ $? = 0 ] || fail 'update with an unbuilt TUI exits 0' 0 "$err"
case "$err" in
  *TUI*) fail 'an unbuilt TUI is skipped silently' '(no mention)' "$err" ;;
esac
[ -e "$CHECKOUT/tui/dist" ] && fail 'an unbuilt TUI stays unbuilt' 'no tui/dist' 'built'
if [ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
  env -i HOME="$HOME_DIR" PATH="$P" sh "$CHECKOUT/tui/install.sh" --quiet || fail 'make install-tui builds' 0 "$?"
  touch "$CHECKOUT/tui/dist/.sentinel"
  printf '\n' >> "$CHECKOUT/tui/src/index.tsx"
  out="$(termag update --no-pull --json 2>/dev/null)"
  [ $? = 0 ] || fail 'update with a built TUI exits 0' 0 "$out"
  case "$out" in
    *'"tui":"rebuilt"'*) : ;;
    *) fail 'reports the TUI rebuilt' '"tui":"rebuilt"' "$out" ;;
  esac
  [ -f "$CHECKOUT/tui/dist/index.js" ] && [ ! -e "$CHECKOUT/tui/dist/.sentinel" ] \
    || fail 'termag update rebuilds a built TUI' 'fresh tui/dist' "$(ls -a "$CHECKOUT/tui/dist" 2>&1)"
else
  mkdir -p "$CHECKOUT/tui/dist"
  : > "$CHECKOUT/tui/dist/index.js"
  err="$(termag update --no-pull 2>&1 >/dev/null)"
  [ $? = 0 ] || fail 'an old Node does not fail the update' 0 "$err"
  case "$err" in
    *'the TUI was not rebuilt'*'needs Node.js 22 or newer'*'install-cli'*) : ;;
    *) fail 'prints the Node hint for the TUI' 'the TUI was not rebuilt ... needs Node.js 22 ... install-cli' "$err" ;;
  esac
fi
rm -rf "$CHECKOUT/tui"

# ── argument handling ───────────────────────────────────────────────────────
install_cli --nope >/dev/null 2>&1
[ $? = 2 ] || fail 'an unknown argument exits 2' 2 "$?"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: install, pinned Node, no-op re-run, rebuild on change, failed build, read-only checkout, PATH hint, --bin-dir, foreign termag, Node floor, termag update (main, other branch, detached)'
  exit 0
fi
echo "$failures failure(s)"
exit 1
