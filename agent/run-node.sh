#!/usr/bin/env bash
# Shared runtime selection for the box agent, clones, CLI and updater. nvm install can
# refresh lts/* to a version that is not installed; a floating default must not
# prevent the agent from starting with a Node already on the box. This does not
# install anything or change aliases. --print-node is the updater's preflight.

CHECKOUT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd) || exit 1

usable_node() {
  [ -n "$1" ] && [ -x "$1" ] && "$1" --version >/dev/null 2>&1
}

find_node() {
  local node tried
  node="$CHECKOUT/node/bin/node"
  tried="$node"
  if usable_node "$node"; then
    printf '%s\n' "$node"
    return 0
  fi
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # No auto-use of a project's .nvmrc, and no network-backed alias refresh.
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&1
    if node=$(nvm which default 2>/dev/null); then
      tried="$tried, $node"
      if usable_node "$node"; then
        printf '%s\n' "$node"
        return 0
      fi
    fi
  fi
  # nvm which node picks only one version, even if its binary is broken or
  # its directory is an incomplete install. Try actual binaries newest-first.
  while IFS= read -r node; do
    [ -e "$node" ] || continue
    tried="$tried, $node"
    if usable_node "$node"; then
      printf '%s\n' "$node"
      return 0
    fi
  done < <(printf '%s\n' "$NVM_DIR"/versions/node/v*/bin/node | LC_ALL=C sort -Vr)
  if node=$(command -v node); then
    tried="$tried, $node"
    if usable_node "$node"; then
      printf '%s\n' "$node"
      return 0
    fi
  fi
  echo "termag: no usable Node.js; checked: $tried; nvm default may be uninstalled" >&2
  return 1
}

if ! node=$(find_node); then
  exit 127
fi
if [ "${1:-}" = --print-node ]; then
  printf '%s\n' "$node"
  exit 0
fi
# npm, Codex, and /usr/bin/env node in children need the selected runtime too.
PATH="$(dirname -- "$node"):$PATH"
export PATH
exec "$node" "$@"
