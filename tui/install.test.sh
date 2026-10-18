#!/bin/sh
# Tests tui/install.sh against a copy of tui/ with a clean HOME and a PATH that
# holds only the system tools and the Node under test (22+).
#
# Needs network the first time (npm ci).
#
# Run: sh tui/install.test.sh
set -u

SRC="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)" || { echo "FAIL: node is not on PATH"; exit 1; }
NPM="$(command -v npm)" || { echo "FAIL: npm is not on PATH"; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

TUI="$WORK/it's a checkout/tui"
NODE_DIR="$WORK/node-bin"
mkdir -p "$TUI" "$WORK/home" "$NODE_DIR"
(cd "$SRC" && tar cf - --exclude=node_modules --exclude=dist --exclude=.dist-build .) | (cd "$TUI" && tar xf -)
ln -s "$NODE" "$NODE_DIR/node"
ln -s "$NPM" "$NODE_DIR/npm"
P="$NODE_DIR:/usr/bin:/bin"
install_tui() { env -i HOME="$WORK/home" PATH="$P" sh "$TUI/install.sh" "$@"; }

# ── first build ─────────────────────────────────────────────────────────────
out="$(install_tui 2>&1)"
got=$?
[ "$got" = 0 ] || fail 'first build exits 0' 0 "$got: $out"
[ -f "$TUI/dist/index.js" ] || fail 'builds dist/' 'dist/index.js' 'absent'
case "$out" in
  *'installing dependencies'*'building'*'termag tui'*) : ;;
  *) fail 'says what it did and what to run next' 'installing ... building ... termag tui' "$out" ;;
esac
got="$(env -i HOME="$WORK/home" PATH="$P" node "$TUI/bin/termag-tui.js" --help 2>&1 | head -1)"
[ -n "$got" ] || fail 'the built TUI runs' '(help text)' '(nothing)'

# The launcher must run React's production build: the development build adds a
# performance measure per render, which Node never drops (the lobby ran out of
# heap). A preload reports which React builds ran (react, its JSX runtime,
# react-reconciler, scheduler), and NODE_ENV as
# the TUI itself sees it, which must be back to what the caller had.
cat >"$WORK/react-build-probe.mjs" <<'PROBE'
import { createRequire } from 'node:module';
const cache = createRequire(import.meta.url).cache;
process.on('exit', () => {
  const builds = new Set(Object.keys(cache)
    // Executed modules only: importing CommonJS from ESM pre-parses both
    // branches of React's index.js and caches them unrun.
    .filter(k => cache[k].loaded && /react[\\/]cjs[\\/]|react-reconciler[\\/]cjs[\\/]|scheduler[\\/]cjs[\\/]/.test(k))
    .map(k => (/[.]development[.]/.test(k) ? 'development' : 'production')));
  process.stderr.write(`PROBE ${[...builds].join(',') || 'none'} NODE_ENV=${process.env.NODE_ENV ?? 'unset'}\n`);
});
PROBE
probe() { env -i HOME="$WORK/home" PATH="$P" "$@" node --import "$WORK/react-build-probe.mjs" "$TUI/bin/termag-tui.js" --help 2>&1 >/dev/null | grep '^PROBE'; }
got="$(probe)"
[ "$got" = 'PROBE production NODE_ENV=unset' ] || fail 'runs the production React build, NODE_ENV left unset' 'PROBE production NODE_ENV=unset' "$got"
got="$(probe NODE_ENV=)"
[ "$got" = 'PROBE production NODE_ENV=' ] || fail 'an empty NODE_ENV counts as unset' 'PROBE production NODE_ENV=' "$got"
got="$(probe NODE_ENV=development)"
[ "$got" = 'PROBE development NODE_ENV=development' ] || fail 'a chosen NODE_ENV is respected' 'PROBE development NODE_ENV=development' "$got"

# ── a re-run with nothing changed does nothing ──────────────────────────────
touch "$TUI/dist/.sentinel" "$TUI/node_modules/.sentinel"
out="$(install_tui --quiet 2>&1)"
got=$?
[ "$got" = 0 ] || fail 'quiet re-run exits 0' 0 "$got"
[ -z "$out" ] || fail 'quiet re-run is silent' '(no output)' "$out"
[ -f "$TUI/dist/.sentinel" ] || fail 'a re-run does not rebuild' 'dist kept' 'dist replaced'
out="$(install_tui 2>&1)"
case "$out" in
  *'already built'*) : ;;
  *) fail 'a re-run says it is already built' 'already built' "$out" ;;
esac
out="$(install_tui --check 2>&1)"
got=$?
[ "$got" = 0 ] && [ -z "$out" ] || fail '--check is silent and 0 when current' '0, (no output)' "$got: $out"

# ── a source change (what `git pull` brings) is rebuilt, without npm ci ─────
printf '\n' >> "$TUI/src/index.tsx"
out="$(install_tui --check 2>&1)"
got=$?
[ "$got" = 1 ] || fail '--check exits 1 on stale sources' 1 "$got"
case "$out" in
  *STALE*dist*) : ;;
  *) fail '--check names the stale build' 'STALE ... dist' "$out" ;;
esac
out="$(install_tui 2>&1)"
case "$out" in
  *'installing dependencies'*) fail 'a source change skips npm ci' 'building only' "$out" ;;
  *building*) : ;;
  *) fail 'a source change rebuilds' 'building' "$out" ;;
esac
[ -f "$TUI/dist/.sentinel" ] && fail 'a rebuild replaces dist/' 'fresh dist' 'old dist'
[ -f "$TUI/node_modules/.sentinel" ] || fail 'a source change keeps node_modules' 'kept' 'reinstalled'

# ── a failed build leaves the previous one ──────────────────────────────────
cp "$TUI/src/index.tsx" "$WORK/index.tsx"
printf 'const broken: number = "x";\n' >> "$TUI/src/index.tsx"
out="$(install_tui 2>&1)"
got=$?
[ "$got" = 1 ] || fail 'a failed build exits 1' 1 "$got"
[ -f "$TUI/dist/index.js" ] || fail 'the previous build survives' 'dist/index.js' 'absent'
[ -e "$TUI/.dist-build" ] && fail 'no scratch build left behind' 'absent' 'present'
cp "$WORK/index.tsx" "$TUI/src/index.tsx"

# ── Node older than 22 is refused, clearly ──────────────────────────────────
mkdir -p "$WORK/old-node"
printf '#!/bin/sh\necho 20.11.1\n' > "$WORK/old-node/node"
chmod 755 "$WORK/old-node/node"
out="$(env -i HOME="$WORK/home" PATH="$WORK/old-node:/usr/bin:/bin" sh "$TUI/install.sh" 2>&1)"
got=$?
[ "$got" = 1 ] || fail 'Node 20 exits 1' 1 "$got"
case "$out" in
  *'needs Node.js 22 or newer'*'v20.11.1'*) : ;;
  *) fail 'names the floor and the Node it found' 'needs Node.js 22 or newer ... v20.11.1' "$out" ;;
esac
out="$(env -i HOME="$WORK/home" PATH="/usr/bin:/bin" sh "$TUI/install.sh" 2>&1)"
[ $? = 1 ] || fail 'no node exits 1' 1 0
if [ ! -e /usr/bin/node ] && [ ! -e /bin/node ]; then
  case "$out" in
    *'not on PATH'*) : ;;
    *) fail 'says node is missing' 'not on PATH' "$out" ;;
  esac
fi

install_tui --nope >/dev/null 2>&1
[ $? = 2 ] || fail 'an unknown argument exits 2' 2 "$?"

if [ "$failures" -eq 0 ]; then
  echo 'PASS: build, no-op re-run, --check, rebuild without npm ci, failed build, Node floor'
  exit 0
fi
echo "$failures failure(s)"
exit 1
