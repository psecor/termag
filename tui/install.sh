#!/bin/sh
# Build the termag TUI in this checkout, for `termag tui` (which finds it beside
# cli/). Kept apart from cli/install.sh because the TUI needs a newer Node and
# has runtime dependencies; the mechanics are the same.
#
# Idempotent and content-compared: `npm ci` runs only when package-lock.json
# changed and tsc only when the sources did. The build goes to a scratch
# directory and replaces dist/ only once it succeeds, so a failed rebuild
# leaves the previous one working. Re-run it after `git pull`.
#
# Usage: tui/install.sh [--node PATH] [--quiet] [--check]
#   --node PATH  the Node to build with (default: `node` on PATH)
#   --quiet      print only problems
#   --check      report whether a build is due and exit 1 if so; change nothing
#
# Env: TERMAG_NODE is the default for --node.
set -eu

MIN_NODE_MAJOR=22

TUI_DIR=$(cd "$(dirname "$0")" && pwd -P)

node=${TERMAG_NODE:-}
quiet=0
check=0
while [ $# -gt 0 ]; do
  case "$1" in
    --node) [ $# -ge 2 ] || { echo "install.sh: --node needs a path" >&2; exit 2; }; node=$2; shift ;;
    --node=*) node=${1#*=} ;;
    --quiet) quiet=1 ;;
    --check) check=1 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$quiet" = 1 ] || printf '%s\n' "$*"; }
die() { printf 'termag tui install: %s\n' "$*" >&2; exit 1; }

if [ -z "$node" ]; then
  node=$(command -v node 2>/dev/null || true)
  [ -n "$node" ] || die "the TUI needs Node.js $MIN_NODE_MAJOR or newer and \`node\` is not on PATH (install it, e.g. \`nvm install 22\`, or pass --node)"
fi
case "$node" in
  /*) ;;
  *) node=$(command -v "$node" 2>/dev/null || true); [ -n "$node" ] || die "--node: not found" ;;
esac
[ -x "$node" ] || die "$node is not executable"
node_version=$("$node" -p 'process.versions.node' 2>/dev/null) || die "$node did not run"
node_major=${node_version%%.*}
[ "$node_major" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null \
  || die "the TUI needs Node.js $MIN_NODE_MAJOR or newer; $node is v$node_version (e.g. \`nvm install 22\`, then re-run)"
node_bin_dir=$(dirname "$node")

stamp_of() {
  "$node" -e '
    const fs = require("fs"), path = require("path"), crypto = require("crypto");
    const dir = process.argv[1], h = crypto.createHash("sha256");
    const files = ["package.json", "package-lock.json", "tsconfig.json"];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const r = path.join(rel, e.name);
        if (e.isDirectory()) walk(r);
        else if (!/\.test\.tsx?$/.test(e.name)) files.push(r);
      }
    };
    walk("src");
    for (const f of files) {
      h.update(f + "\0");
      try { h.update(fs.readFileSync(path.join(dir, f))); } catch { h.update("missing"); }
      h.update("\0");
    }
    process.stdout.write(h.digest("hex"));
  ' "$1"
}
lock_of() {
  "$node" -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1/package-lock.json"
}

want_stamp=$(stamp_of "$TUI_DIR")
have_stamp=$(cat "$TUI_DIR/dist/.install-stamp" 2>/dev/null || true)
want_lock=$(lock_of "$TUI_DIR")
have_lock=$(cat "$TUI_DIR/node_modules/.install-lock" 2>/dev/null || true)

deps_current=0
[ "$want_lock" = "$have_lock" ] && [ -f "$TUI_DIR/node_modules/typescript/bin/tsc" ] && deps_current=1
build_current=0
[ "$want_stamp" = "$have_stamp" ] && [ -f "$TUI_DIR/dist/index.js" ] && build_current=1

if [ "$check" = 1 ]; then
  [ "$deps_current" = 1 ] || printf 'STALE: %s/node_modules (package-lock.json changed)\n' "$TUI_DIR"
  [ "$build_current" = 1 ] || printf 'STALE: %s/dist (sources changed since the last build)\n' "$TUI_DIR"
  [ "$deps_current" = 1 ] && [ "$build_current" = 1 ]
  exit
fi

if [ "$deps_current" = 1 ] && [ "$build_current" = 1 ]; then
  say "termag tui install: already built in $TUI_DIR"
  exit 0
fi
[ -w "$TUI_DIR" ] || die "$TUI_DIR is not writable"

log=$(mktemp)
trap 'rm -f "$log"; rm -rf "$TUI_DIR/.dist-build"' EXIT
if [ "$deps_current" = 0 ]; then
  say "termag tui install: installing dependencies (npm ci)"
  npm="$node_bin_dir/npm"
  [ -x "$npm" ] || npm=$(command -v npm 2>/dev/null) || die "npm not found next to $node or on PATH"
  if ! (cd "$TUI_DIR" && PATH="$node_bin_dir:$PATH" "$npm" ci --no-audit --no-fund --loglevel=error) >"$log" 2>&1; then
    cat "$log" >&2
    die "npm ci failed in $TUI_DIR"
  fi
  printf '%s\n' "$want_lock" > "$TUI_DIR/node_modules/.install-lock"
fi
if [ "$build_current" = 0 ] || [ "$deps_current" = 0 ]; then
  say "termag tui install: building $TUI_DIR"
  rm -rf "$TUI_DIR/.dist-build"
  if ! (cd "$TUI_DIR" && "$node" node_modules/typescript/bin/tsc -p tsconfig.json --outDir .dist-build) >"$log" 2>&1; then
    cat "$log" >&2
    die "the build failed; the previous build (if any) is unchanged"
  fi
  printf '%s\n' "$want_stamp" > "$TUI_DIR/.dist-build/.install-stamp"
  rm -rf "$TUI_DIR/dist"
  mv "$TUI_DIR/.dist-build" "$TUI_DIR/dist"
fi
say "termag tui install: built $TUI_DIR (Node v$node_version); run \`termag tui\`"
