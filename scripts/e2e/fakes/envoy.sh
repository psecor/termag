#!/usr/bin/env bash
# Fetch Envoy (Apache-2.0, https://github.com/envoyproxy/envoy) for the
# E2E_CLAUDE_GATEWAY stand-in: the upstream release binary, pinned by digest.
#
#   envoy.sh fetch   download if missing; print the binary's path
#
# Env: E2E_CACHE_DIR (default ${XDG_CACHE_HOME:-~/.cache}/termag-e2e).
set -euo pipefail

VERSION=1.39.1
case $(uname -m) in
  x86_64)  ASSET=envoy-$VERSION-linux-x86_64;   SHA=002c6e1c69ed0fa0ea381887247cadadfaec9481375fa8d8d2b1731eeabf40b8 ;;
  aarch64) ASSET=envoy-$VERSION-linux-aarch_64; SHA=8565ad0af4b1d1d3c986e5165c027add3073579182f398dd7f4d728d25e9ec62 ;;
  *) echo "envoy: no pinned build for $(uname -m)" >&2; exit 1 ;;
esac

cache=${E2E_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/termag-e2e}
bin="$cache/envoy-$VERSION-$SHA/envoy"

[ "${1:-}" = fetch ] || { echo "usage: envoy.sh fetch" >&2; exit 2; }

if [ ! -x "$bin" ]; then
  mkdir -p "$cache"
  tmp=$(mktemp -d "$cache/.envoy.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  echo "[envoy] downloading $ASSET" >&2
  curl -fsSL -o "$tmp/envoy" "https://github.com/envoyproxy/envoy/releases/download/v$VERSION/$ASSET"
  got=$(sha256sum "$tmp/envoy" | cut -d' ' -f1)
  [ "$got" = "$SHA" ] || { echo "[envoy] digest mismatch: got $got, want $SHA" >&2; exit 1; }
  chmod 0755 "$tmp/envoy"
  mkdir -p "$(dirname "$bin")"
  mv "$tmp/envoy" "$bin"
fi
printf '%s\n' "$bin"
