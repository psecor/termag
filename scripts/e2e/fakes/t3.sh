#!/usr/bin/env bash
# Fetch the t3 server (MIT, https://github.com/pingdotgg/t3code) the stand-in
# boxes run for the desktop app's box bridge with E2E_T3: the upstream
# release's per-platform archive, pinned by digest. E2E_T3_COMMAND names
# another build (a fork's) instead.
#
#   t3.sh fetch   download and unpack if missing; print the t3 binary's path
#
# Env: E2E_CACHE_DIR (default ${XDG_CACHE_HOME:-~/.cache}/termag-e2e).
set -euo pipefail

VERSION=0.1.1
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  PLATFORM=darwin-arm64; SHA=8f5f435483266c1e6f46b35336fea134e364100045a8712cb52f41b88e3b0b05 ;;
  Linux-aarch64) PLATFORM=linux-arm64;  SHA=a23729574bec2665d53cfe67997edbf5f29dd592c3b7c3e774aec3dfc5c7e217 ;;
  Linux-x86_64)  PLATFORM=linux-x64;    SHA=33c43ea2f803215662f5a31fdf9e1bca86ab67cac4f2398565c2ba12e17c2185 ;;
  *) echo "t3: no pinned build for $(uname -s) $(uname -m); set E2E_T3_COMMAND" >&2; exit 1 ;;
esac
ASSET=t3-$VERSION-$PLATFORM.tar.gz

cache=${E2E_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/termag-e2e}
# Keyed by the digest, so a cache entry is only ever the pinned archive.
dir="$cache/t3-$VERSION-$SHA"
bin="$dir/t3-$VERSION-$PLATFORM/t3"

[ "${1:-}" = fetch ] || { echo "usage: t3.sh fetch" >&2; exit 2; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

if [ ! -x "$bin" ]; then
  mkdir -p "$cache"
  tmp=$(mktemp -d "$cache/.t3.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  echo "[t3] downloading $ASSET (about 90 MB, once)" >&2
  curl -fsSL -o "$tmp/t3.tar.gz" "https://github.com/pingdotgg/t3code/releases/download/v$VERSION/$ASSET"
  got=$(sha256_of "$tmp/t3.tar.gz")
  [ "$got" = "$SHA" ] || { echo "[t3] digest mismatch: got $got, want $SHA" >&2; exit 1; }
  mkdir "$tmp/out"
  tar -xzf "$tmp/t3.tar.gz" -C "$tmp/out"
  [ -x "$tmp/out/t3-$VERSION-$PLATFORM/t3" ] || { echo "[t3] $ASSET has no t3-$VERSION-$PLATFORM/t3" >&2; exit 1; }
  rm -rf "$dir"
  mv "$tmp/out" "$dir"
fi
printf '%s\n' "$bin"
