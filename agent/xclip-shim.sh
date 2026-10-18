#!/bin/sh
# Fake xclip, installed as ~/.local/bin/xclip by the termag per-user agent.
# termag boxes are headless, so a real xclip has no display and no clipboard to
# read. Instead the agent drops the image pasted in the browser into
# ~/.cache/termag/clipboard.png and then types Ctrl+V into the agent pane;
# Claude Code's Linux image paste probes with `-t TARGETS -o` and reads with
# `-t image/png -o`, which is all this answers. Everything else, text targets
# included, fails like an empty clipboard so nothing else changes behavior.

SLOT="${TERMAG_CLIPBOARD_DIR:-$HOME/.cache/termag}/clipboard.png"

target=""
out=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    -t|-target|--target)
      shift
      target="${1:-}"
      ;;
    -o|-out|--output)
      out=1
      ;;
  esac
  if [ "$#" -gt 0 ]; then
    shift
  fi
done

if [ "$out" -ne 1 ]; then
  exit 1
fi

fresh() {
  [ -s "$SLOT" ] || return 1
  [ -n "$(find "$SLOT" -mmin -1 2>/dev/null)" ]
}

case "$target" in
  TARGETS)
    fresh || exit 1
    echo 'image/png'
    ;;
  image/png)
    fresh || exit 1
    cat "$SLOT" || exit 1
    rm -f "$SLOT"
    ;;
  *)
    exit 1
    ;;
esac
