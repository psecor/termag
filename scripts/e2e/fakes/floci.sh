#!/usr/bin/env bash
# Fetch Floci (MIT, https://github.com/floci-io/floci), the local AWS emulator
# behind E2E_FAKE_AWS=1, without Docker: the image's native-binary layer is
# downloaded from Docker Hub by digest, checked, and unpacked into the cache.
#
#   floci.sh fetch   download if missing; print the binary's path
#
# Env: E2E_CACHE_DIR (default ${XDG_CACHE_HOME:-~/.cache}/termag-e2e).
set -euo pipefail

VERSION=2.1.0
case $(uname -m) in
  x86_64)  LAYER=sha256:8a7604b4ba0cae6d072510ae088e4bd19dc37567d885d9f96a3237dfabd1fef7 ;;
  aarch64) LAYER=sha256:373cd93bb106d150cd3583fee84c3b3b646ec9de6b527d04633c530e311a6e58 ;;
  *) echo "floci: no pinned build for $(uname -m)" >&2; exit 1 ;;
esac

cache=${E2E_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/termag-e2e}
dir="$cache/floci-$VERSION-${LAYER#sha256:}"
bin="$dir/app/application"

[ "${1:-}" = fetch ] || { echo "usage: floci.sh fetch" >&2; exit 2; }

if [ ! -x "$bin" ]; then
  mkdir -p "$cache"
  tmp=$(mktemp -d "$cache/.floci.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  echo "[floci] downloading floci/floci:$VERSION ($(uname -m)) layer ${LAYER:7:12}" >&2
  token=$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:floci/floci:pull" | jq -r .token)
  curl -fsSL -H "Authorization: Bearer $token" -o "$tmp/layer.tgz" \
    "https://registry-1.docker.io/v2/floci/floci/blobs/$LAYER"
  got="sha256:$(sha256sum "$tmp/layer.tgz" | cut -d' ' -f1)"
  [ "$got" = "$LAYER" ] || { echo "[floci] digest mismatch: got $got, want $LAYER" >&2; exit 1; }
  tar -xzf "$tmp/layer.tgz" -C "$tmp" app/application
  mkdir -p "$dir/app"
  mv "$tmp/app/application" "$bin"
fi
printf '%s\n' "$bin"
