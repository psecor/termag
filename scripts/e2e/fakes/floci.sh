#!/usr/bin/env bash
# Floci (MIT, https://github.com/floci-io/floci), the local AWS emulator behind
# E2E_FAKE_AWS=1, two ways:
#
# native  (Linux x86_64/aarch64) the image's native-binary layer, downloaded
#         from Docker Hub by digest, checked, and unpacked into the cache. No
#         Docker.
# docker  (macOS, or E2E_FLOCI=docker) the floci/floci image (E2E_FLOCI_IMAGE)
#         run as one container per stack, named termag-e2e-floci-<root suffix>
#         and labelled with the stack root, published on 127.0.0.1 only, with its
#         data dir bind-mounted from the stack root. The Docker socket is never
#         mounted into it, and only that container, by its exact name and only
#         when its label names this root, is ever removed.
#
#   floci.sh fetch                     native: download if missing; print the binary's path
#   floci.sh native-ok                 exit 0 when there is a pinned native build for this machine
#   floci.sh docker-ok                 exit 0 when a Docker daemon answers
#   floci.sh docker-run <root>         docker: start the stack's container in the foreground
#                                      (up.sh runs this as the floci daemon); reads
#                                      <root>/floci/docker.env
#   floci.sh docker-rm <root>          docker: remove the stack's container, if any
#
# Env: E2E_CACHE_DIR (default ${XDG_CACHE_HOME:-~/.cache}/termag-e2e).
set -euo pipefail

VERSION=2.1.0
LAYER=
if [ "$(uname -s)" = Linux ]; then
  case $(uname -m) in
    x86_64)  LAYER=sha256:8a7604b4ba0cae6d072510ae088e4bd19dc37567d885d9f96a3237dfabd1fef7 ;;
    aarch64) LAYER=sha256:373cd93bb106d150cd3583fee84c3b3b646ec9de6b527d04633c530e311a6e58 ;;
  esac
fi

LABEL=termag.e2e.root

# The container of the stack at <root>, if it is ours: named in
# <root>/floci/container, and carrying the root in its label.
ours() {
  local root=$1 name
  [ -r "$root/floci/container" ] || return 1
  name=$(head -n1 "$root/floci/container")
  case $name in termag-e2e-floci-*) ;; *) return 1 ;; esac
  [ "$(docker inspect --type container --format "{{index .Config.Labels \"$LABEL\"}}" "$name" 2>/dev/null)" = "$root" ] || return 1
  printf '%s\n' "$name"
}

# Removes <name> and waits until it is gone. It may already be on its way out
# (--rm, after the docker CLI passed on a TERM), in which case the daemon
# refuses a second removal.
remove() {
  docker rm -f "$1" >/dev/null 2>&1 || true
  for _ in $(seq 1 40); do
    docker inspect --type container "$1" >/dev/null 2>&1 || return 0
    sleep 0.25
  done
  return 1
}

case ${1:-} in
  native-ok) [ -n "$LAYER" ] ;;

  docker-ok) command -v docker >/dev/null 2>&1 && docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 ;;

  docker-run)
    root=${2:?usage: floci.sh docker-run <root>}
    # shellcheck disable=SC1091
    . "$root/floci/docker.env"
    [ -n "${DOCKER_HOST:-}" ] && export DOCKER_HOST
    # A container left by a crashed run of this same stack (ctl.sh restart, or
    # a docker CLI that was killed) holds the name; it is ours, so it goes.
    if old=$(ours "$root"); then remove "$old" || { echo "[floci] could not remove the old container $old" >&2; exit 1; }; fi
    # ec2.mock keeps the EC2 API but starts no instances and no metadata
    # server. Floci listens on all of the container's interfaces; only
    # 127.0.0.1 on this machine is published. The uid is the caller's, so a
    # bind mount on Linux stays deletable.
    exec docker run --rm --name "$FLOCI_CONTAINER" --label "$LABEL=$root" \
      --user "$(id -u):$(id -g)" \
      -p "127.0.0.1:$FLOCI_PORT:4566" \
      -v "$root/floci/data:/app/data" \
      -e FLOCI_DEFAULT_REGION="$FLOCI_REGION" \
      -e FLOCI_SERVICES_EC2_MOCK=true \
      -e FLOCI_STORAGE_PERSISTENT_PATH=/app/data \
      "$FLOCI_IMAGE"
    ;;

  docker-rm)
    root=${2:?usage: floci.sh docker-rm <root>}
    [ -r "$root/floci/container" ] || exit 0
    name=$(head -n1 "$root/floci/container")
    if [ -r "$root/floci/docker.env" ]; then
      # shellcheck disable=SC1091
      DOCKER_HOST=$(. "$root/floci/docker.env" && printf '%s' "${DOCKER_HOST:-}")
      [ -n "$DOCKER_HOST" ] && export DOCKER_HOST
    fi
    if ! command -v docker >/dev/null 2>&1; then
      echo "[floci] no docker CLI to remove container $name with" >&2; exit 1
    fi
    if ! docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
      echo "[floci] Docker is not answering, so container $name (if it still exists) was not removed" >&2; exit 1
    fi
    if target=$(ours "$root"); then
      remove "$target" || { echo "[floci] container $target is still there after docker rm -f" >&2; exit 1; }
      echo "[e2e] removed the Floci container $target" >&2
    elif docker inspect --type container "$name" >/dev/null 2>&1; then
      echo "[floci] container $name is not labelled for $root; left alone" >&2; exit 1
    fi
    ;;

  fetch)
    if [ -z "$LAYER" ]; then
      echo "floci: no native build for $(uname -s) $(uname -m); run it in Docker (E2E_FLOCI=docker)" >&2
      exit 1
    fi
    cache=${E2E_CACHE_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/termag-e2e}
    dir="$cache/floci-$VERSION-${LAYER#sha256:}"
    bin="$dir/app/application"
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
    ;;

  *) echo "usage: floci.sh fetch | native-ok | docker-ok | docker-run <root> | docker-rm <root>" >&2; exit 2 ;;
esac
