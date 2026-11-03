#!/usr/bin/env bash
# Stage the t3 server tarball box.pkr.hcl uploads (shell-local, on the host
# running packer). A file provisioner needs a source that exists, and most
# bakes have no tarball to hand over, so this always writes $STAGE: a copy of
# $ARTIFACT when it is set, else an empty file, which
# scripts/install-t3-server.sh takes as "no t3 server in this image".
#
# Env:
#   STAGE     output path (gitignored, beside the template)
#   ARTIFACT  the t3_server_artifact variable: a local
#             termag-t3-server-<version>-linux-<arch>.tar.gz, or empty
set -euo pipefail

: "${STAGE:?STAGE is required}"

if [ -z "${ARTIFACT:-}" ]; then
  : > "$STAGE"
  echo "[t3-server] no t3_server_artifact; the image bakes without the t3 server"
  exit 0
fi

[ -s "$ARTIFACT" ] || { echo "[t3-server] t3_server_artifact $ARTIFACT is missing or empty" >&2; exit 1; }
case "$(basename -- "$ARTIFACT")" in
  termag-t3-server-*-linux-arm64.tar.gz) ;;
  *) echo "[t3-server] $ARTIFACT is not a termag-t3-server-<version>-linux-arm64.tar.gz (box images are arm64)" >&2; exit 1 ;;
esac
cp -- "$ARTIFACT" "$STAGE"
echo "[t3-server] staged $ARTIFACT ($(du -h "$STAGE" | cut -f1)); the box checks it against deploy/t3-server.pin"
