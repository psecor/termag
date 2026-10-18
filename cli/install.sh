#!/bin/sh
# Install the termag CLI from this checkout: build cli/ and put a `termag`
# launcher on PATH. There is no registry, tap or release; a termag clone is the
# distribution, and `git pull` followed by a re-run (or `termag update`) is the
# update.
#
# Idempotent and content-compared: with the build current and the launcher
# already right it changes nothing, so termag-reconcile can run it on every
# boot. `npm ci` runs only when package-lock.json changed and tsc only when the
# sources did; the build goes to a scratch directory and replaces dist/ only
# once it succeeds, so a failed rebuild leaves the previous one working.
#
# The launcher is a small sh script rather than a symlink so it can pin the
# Node it was installed with (a version manager may not be on PATH where
# `termag` runs: a systemd unit, an SSH ProxyCommand, a non-login shell) and
# fall back to `node` on PATH if that one is later removed.
#
# Usage: cli/install.sh [--bin-dir DIR] [--node PATH] [--force] [--quiet] [--check]
#   --bin-dir DIR  where the launcher goes. Default: ~/.local/bin if it is on
#                  PATH, else /usr/local/bin if that is on PATH and writable,
#                  else ~/.local/bin with a hint for adding it to PATH.
#   --node PATH    the Node to build with and pin (default: `node` on PATH).
#   --force        replace a `termag` in DIR that this script did not write.
#   --quiet        print only problems (termag-reconcile runs it like this).
#   --check        report what would change and exit 1 if anything would;
#                  change nothing.
#
# Env: TERMAG_BIN_DIR and TERMAG_NODE are the defaults for --bin-dir and --node.
set -eu

MIN_NODE_MAJOR=20
MARKER='# termag-cli-launcher'

CLI_DIR=$(cd "$(dirname "$0")" && pwd -P)
CHECKOUT=$(dirname "$CLI_DIR")

bin_dir=${TERMAG_BIN_DIR:-}
node=${TERMAG_NODE:-}
force=0
quiet=0
check=0
while [ $# -gt 0 ]; do
  case "$1" in
    --bin-dir) [ $# -ge 2 ] || { echo "install.sh: --bin-dir needs a directory" >&2; exit 2; }; bin_dir=$2; shift ;;
    --bin-dir=*) bin_dir=${1#*=} ;;
    --node) [ $# -ge 2 ] || { echo "install.sh: --node needs a path" >&2; exit 2; }; node=$2; shift ;;
    --node=*) node=${1#*=} ;;
    --force) force=1 ;;
    --quiet) quiet=1 ;;
    --check) check=1 ;;
    -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown argument: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

say() { [ "$quiet" = 1 ] || printf '%s\n' "$*"; }
die() { printf 'termag install: %s\n' "$*" >&2; exit 1; }

on_path() {
  case ":${PATH:-}:" in *":$1:"*) return 0 ;; esac
  return 1
}

# ── Node ────────────────────────────────────────────────────────────────────
if [ -z "$node" ]; then
  node=$(command -v node 2>/dev/null || true)
  [ -n "$node" ] || die "Node.js $MIN_NODE_MAJOR or newer is required and \`node\` is not on PATH (install it, e.g. \`nvm install 22\`, or pass --node)"
fi
case "$node" in
  /*) ;;
  *) node=$(command -v "$node" 2>/dev/null || true); [ -n "$node" ] || die "--node: not found" ;;
esac
[ -x "$node" ] || die "$node is not executable"
node_version=$("$node" -p 'process.versions.node' 2>/dev/null) || die "$node did not run"
node_major=${node_version%%.*}
[ "$node_major" -ge "$MIN_NODE_MAJOR" ] 2>/dev/null \
  || die "Node.js $MIN_NODE_MAJOR or newer is required; $node is v$node_version"
node_bin_dir=$(dirname "$node")

# ── Build ───────────────────────────────────────────────────────────────────
# What the build depends on, hashed by the Node we already have rather than by
# sha256sum or shasum, whichever this OS ships.
stamp_of() {
  "$node" -e '
    const fs = require("fs"), path = require("path"), crypto = require("crypto");
    const dir = process.argv[1], h = crypto.createHash("sha256");
    const files = ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json"];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
        const r = path.join(rel, e.name);
        if (e.isDirectory()) { if (r !== path.join("src", "test")) walk(r); }
        else if (!e.name.endsWith(".test.ts")) files.push(r);
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

want_stamp=$(stamp_of "$CLI_DIR")
have_stamp=$(cat "$CLI_DIR/dist/.install-stamp" 2>/dev/null || true)
want_lock=$(lock_of "$CLI_DIR")
have_lock=$(cat "$CLI_DIR/node_modules/.install-lock" 2>/dev/null || true)
build_current=0
[ "$want_stamp" = "$have_stamp" ] && [ -f "$CLI_DIR/dist/main.js" ] && build_current=1

drift=0
if [ "$check" = 1 ]; then
  if [ "$build_current" = 0 ]; then
    printf 'STALE: %s/dist (sources changed since the last install)\n' "$CLI_DIR"
    drift=1
  fi
elif [ "$build_current" = 0 ]; then
  if [ ! -w "$CLI_DIR" ]; then
    [ -f "$CLI_DIR/dist/main.js" ] || die "$CLI_DIR is not writable and has no build"
    printf 'termag install: %s is not writable; keeping its existing build\n' "$CLI_DIR" >&2
    drift=1
  else
    log=$(mktemp)
    trap 'rm -f "$log"; rm -rf "$CLI_DIR/.dist-build"' EXIT
    if [ "$want_lock" != "$have_lock" ] || [ ! -f "$CLI_DIR/node_modules/typescript/bin/tsc" ]; then
      say "termag install: installing build dependencies (npm ci)"
      npm="$node_bin_dir/npm"
      [ -x "$npm" ] || npm=$(command -v npm 2>/dev/null) || die "npm not found next to $node or on PATH"
      if ! (cd "$CLI_DIR" && PATH="$node_bin_dir:$PATH" "$npm" ci --no-audit --no-fund --loglevel=error) >"$log" 2>&1; then
        cat "$log" >&2
        die "npm ci failed in $CLI_DIR"
      fi
      printf '%s\n' "$want_lock" > "$CLI_DIR/node_modules/.install-lock"
    fi
    say "termag install: building $CLI_DIR"
    rm -rf "$CLI_DIR/.dist-build"
    if ! (cd "$CLI_DIR" && "$node" node_modules/typescript/bin/tsc -p tsconfig.build.json --outDir .dist-build) >"$log" 2>&1; then
      cat "$log" >&2
      die "the build failed; the previous build (if any) is unchanged"
    fi
    printf '%s\n' "$want_stamp" > "$CLI_DIR/.dist-build/.install-stamp"
    rm -rf "$CLI_DIR/dist"
    mv "$CLI_DIR/.dist-build" "$CLI_DIR/dist"
  fi
fi

# ── Launcher ────────────────────────────────────────────────────────────────
if [ -z "$bin_dir" ]; then
  if on_path "$HOME/.local/bin"; then
    bin_dir=$HOME/.local/bin
  elif on_path /usr/local/bin && [ -w /usr/local/bin ]; then
    bin_dir=/usr/local/bin
  else
    bin_dir=$HOME/.local/bin
  fi
fi
case "$bin_dir" in /*) ;; *) bin_dir=$(pwd -P)/$bin_dir ;; esac
dest=$bin_dir/termag

# Single-quoted for sh, with any embedded ' closed, escaped and reopened.
sq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

want=$(cat <<EOF
#!/bin/sh
$MARKER: written by $(sq "$CLI_DIR/install.sh"). Update with \`termag update\`.
TERMAG_CLI_CHECKOUT=$(sq "$CHECKOUT")
TERMAG_CLI_BIN=$(sq "$dest")
export TERMAG_CLI_CHECKOUT TERMAG_CLI_BIN
node=$(sq "$node")
[ -x "\$node" ] || node=node
exec "\$node" "\$TERMAG_CLI_CHECKOUT/cli/bin/termag.js" "\$@"
EOF
)

if [ -e "$dest" ] || [ -L "$dest" ]; then
  if [ -L "$dest" ] || ! grep -q "^$MARKER" "$dest" 2>/dev/null; then
    if [ "$force" = 0 ]; then
      if [ "$check" = 1 ]; then
        printf 'FOREIGN: %s was not written by this installer\n' "$dest"
        exit 1
      fi
      die "$dest exists and was not written by this installer; move it aside or re-run with --force"
    fi
  fi
fi

if [ "$(cat "$dest" 2>/dev/null || true)" != "$want" ] || [ ! -x "$dest" ] || [ -L "$dest" ]; then
  if [ "$check" = 1 ]; then
    if [ -e "$dest" ]; then printf 'DRIFT: %s\n' "$dest"; else printf 'MISSING: %s\n' "$dest"; fi
    drift=1
  else
    mkdir -p "$bin_dir" || die "cannot create $bin_dir"
    tmp=$(mktemp "$bin_dir/.termag.XXXXXX") || die "cannot write to $bin_dir"
    printf '%s\n' "$want" > "$tmp"
    chmod 755 "$tmp"
    mv -f "$tmp" "$dest" || { rm -f "$tmp"; die "cannot write $dest"; }
    say "termag install: wrote $dest"
  fi
fi

[ "$check" = 1 ] && exit "$drift"
[ "$quiet" = 1 ] && exit "$drift"

say "termag install: $("$dest" --version) from $CHECKOUT (Node v$node_version at $node)"

if ! on_path "$bin_dir"; then
  say "termag install: $bin_dir is not on PATH. Add it, e.g.:"
  say "  echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.zshrc && exec zsh"
else
  found=$(command -v termag 2>/dev/null || true)
  if [ -n "$found" ] && [ "$found" != "$dest" ]; then
    say "termag install: warning: \`termag\` on PATH is $found, which comes before $dest"
  fi
fi
exit "$drift"
