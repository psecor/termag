#!/bin/sh
set -u

SHIM="$(cd "$(dirname "$0")" && pwd)/xclip-shim.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

BIN="$WORK/bin"
mkdir -p "$BIN" "$WORK/home/.cache/termag"
cp "$SHIM" "$BIN/xclip"
chmod 755 "$BIN/xclip"

HOME="$WORK/home"
export HOME
SLOT="$HOME/.cache/termag/clipboard.png"
PNG="$WORK/tiny.png"
printf '\211PNG\r\n\032\n\000\000\000\015IHDR\000\000\000\001\000\000\000\001\010\006\000\000\000\037\025\304\211\000\000\000\012IDATx\234c\000\001\000\000\005\000\001\015\012\055\264\000\000\000\000IEND\256B\140\202' > "$PNG"

failures=0
fail() {
  echo "FAIL: $1"
  failures=$((failures + 1))
}

out="$("$BIN/xclip" -selection clipboard -t TARGETS -o 2>/dev/null)" && rc=0 || rc=$?
[ "$rc" -eq 1 ] || fail 'no mailbox: probe should exit 1'
[ -z "$out" ] || fail 'no mailbox: probe should print nothing'
"$BIN/xclip" -selection clipboard -t image/png -o >/dev/null 2>&1 && fail 'no mailbox: read should exit 1'

cp "$PNG" "$SLOT"
out="$("$BIN/xclip" -selection clipboard -t TARGETS -o)" || fail 'fresh mailbox: probe should exit 0'
[ "$out" = 'image/png' ] || fail "fresh mailbox: probe printed '$out', expected 'image/png'"

"$BIN/xclip" -selection clipboard -t image/png -o > "$WORK/read.png" || fail 'fresh mailbox: read should exit 0'
cmp -s "$PNG" "$WORK/read.png" || fail 'fresh mailbox: read bytes differ from the mailbox bytes'
[ ! -e "$SLOT" ] || fail 'fresh mailbox: read should consume the mailbox'

cp "$PNG" "$SLOT"
touch -d '-2 minutes' "$SLOT"
"$BIN/xclip" -selection clipboard -t TARGETS -o >/dev/null 2>&1 && fail 'stale mailbox: probe should exit 1'
rm -f "$SLOT"

cp "$PNG" "$SLOT"
out="$("$BIN/xclip" -selection clipboard -t text/plain -o 2>/dev/null)" && fail 'text target: should exit 1'
[ -z "$out" ] || fail 'text target: should print nothing'

probe="$(PATH="$BIN:$PATH" sh -c 'xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)" || wl-paste -l 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)"')"
[ "$probe" = 'image/png' ] || fail "Claude Code probe pipeline printed '$probe', expected 'image/png'"

# shellcheck disable=SC2016
read_cmd='xclip -selection clipboard -t image/png -o > "$1" 2>/dev/null || xclip -selection clipboard -t image/bmp -o > "$1" 2>/dev/null || wl-paste --type image/png > "$1" 2>/dev/null || wl-paste --type image/bmp > "$1"'
PATH="$BIN:$PATH" sh -c "$read_cmd" sh "$WORK/pipeline.png" || fail 'Claude Code read pipeline should exit 0'
cmp -s "$PNG" "$WORK/pipeline.png" || fail 'Claude Code read pipeline wrote different bytes'

if [ "$failures" -ne 0 ]; then
  echo "$failures assertion(s) failed"
  exit 1
fi
echo 'all xclip-shim assertions passed'
