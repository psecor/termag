#!/usr/bin/env bash
# Bundle the checkout being baked so the box gets the termag source with its
# full history and nothing else. A git bundle is objects + refs: no .git/config
# (so no credentials, which a copied checkout from a CI runner would carry), no
# node_modules, nothing untracked. setup.sh clones it to ~termag/src/termag, so
# the tree on the box is exactly the commit the AMI's TermagSha tag names.
#
# Why history rather than an archive: git log/blame/bisect on the box are a real
# aid to an agent reasoning about why code looks the way it does, and a shallow
# clone has none. CI therefore checks out with fetch-depth: 0, and this refuses
# to bundle a shallow checkout rather than ship an empty history.
#
# Runs on the host running packer (shell-local provisioner). Env:
#   BUNDLE  output path. A sidecar "$BUNDLE.origin" gets this checkout's origin
#           URL, if any, so setup.sh can point the clone's remote at the real
#           repo instead of at the bundle file.
set -euo pipefail

: "${BUNDLE:?BUNDLE is required}"

if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  echo "[bundle] checkout is shallow; refusing to bundle without history (CI: actions/checkout fetch-depth: 0)" >&2
  exit 1
fi

# HEAD alone clones out detached. Naming the branch too, when there is one
# (always, on the CI runner), gives the box a branch to sit on.
branch=$(git symbolic-ref -q --short HEAD || true)
git bundle create "$BUNDLE" HEAD ${branch:+"$branch"}
git remote get-url origin > "$BUNDLE.origin" 2>/dev/null || : > "$BUNDLE.origin"

echo "[bundle] $(git rev-parse HEAD)${branch:+ ($branch)} -> $BUNDLE ($(du -h "$BUNDLE" | cut -f1)), origin: $(cat "$BUNDLE.origin")"
