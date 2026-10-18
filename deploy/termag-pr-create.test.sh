#!/bin/sh
# Tests deploy/termag-pr-create, the fixed-argv way agents open a PR.
#
#   * the title file's first line reaches gh as one --title argument and the
#     marked body arrives on stdin, both verbatim: quotes, $(...), backticks
#     and a line reading EOF are data, never shell
#   * extra flags (--draft, --base) pass through; ones that would replace the
#     title or body are refused
#   * a missing or empty file is refused before gh runs
#
# Run: sh deploy/termag-pr-create.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

# The script and termag-pr-body side by side, as termag-reconcile installs them.
BIN="$WORK/bin"
mkdir -p "$BIN"
cp "$HERE/termag-pr-create" "$HERE/termag-pr-body" "$BIN/"
chmod +x "$BIN/termag-pr-create" "$BIN/termag-pr-body"

# gh stub: one argument per line, then stdin.
STUB="$WORK/stub"
mkdir -p "$STUB"
cat > "$STUB/gh" <<'STUBEOF'
#!/bin/sh
for a in "$@"; do printf 'ARG<%s>\n' "$a"; done > "$GH_LOG"
cat > "$GH_STDIN"
STUBEOF
chmod +x "$STUB/gh"
GH_LOG="$WORK/gh.args"; GH_STDIN="$WORK/gh.stdin"; export GH_LOG GH_STDIN
PWNED="$WORK/pwned"

run() { env TERMAG_BOX_ID=b TERMAG_PROJECT=p PATH="$STUB:$PATH" "$BIN/termag-pr-create" "$@"; }

# ── hostile title and body are data ─────────────────────────────────────────
printf '%s\n' "fix: \"quoted\" \$(touch $PWNED) \`touch $PWNED\` 'single'" 'second line ignored' > "$WORK/title"
printf '%s\n' 'Summary' 'EOF' "\$(touch $PWNED)" "\`touch $PWNED\`" "'; touch $PWNED; '" > "$WORK/body"
: > "$GH_LOG"
run "$WORK/title" "$WORK/body" --draft --base main
got=$?
[ "$got" = 0 ] || fail 'exits 0' 0 "$got"
[ ! -e "$PWNED" ] || fail 'nothing in the title or body runs' 'no file' 'created'

want="$(printf '%s\n' 'ARG<pr>' 'ARG<create>' 'ARG<--title>' \
  "ARG<fix: \"quoted\" \$(touch $PWNED) \`touch $PWNED\` 'single'>" \
  'ARG<--body-file>' 'ARG<->' 'ARG<--draft>' 'ARG<--base>' 'ARG<main>')"
got="$(cat "$GH_LOG")"
[ "$got" = "$want" ] || fail 'gh gets the title as one argument and the flags' "$want" "$got"

want="$(printf '%s\n' "$(cat "$WORK/body")" | env TERMAG_BOX_ID=b TERMAG_PROJECT=p "$BIN/termag-pr-body")"
got="$(cat "$GH_STDIN")"
[ "$got" = "$want" ] || fail 'gh reads the marked body verbatim' "$want" "$got"
case "$got" in *"
EOF
"*) : ;; *) fail 'a body line reading EOF survives' 'EOF line' "$got" ;; esac

# ── a body file named like a flag ───────────────────────────────────────────
printf 'dash body\n' > "$WORK/-body"
(cd "$WORK" && run title -body)
got="$(sed -n 2p "$GH_STDIN")"
[ "$got" = 'dash body' ] || fail 'a body file starting with - is a file' 'dash body' "$got"

# ── refused flags ───────────────────────────────────────────────────────────
for flag in --title -t --body -b --body-file -F --fill -f --fill-first --template -T --web -w --title=x --body=x; do
  : > "$GH_LOG"
  run "$WORK/title" "$WORK/body" "$flag" >/dev/null 2>&1
  got=$?
  [ "$got" = 2 ] || fail "$flag is refused" 2 "$got"
  [ ! -s "$GH_LOG" ] || fail "$flag never reaches gh" 'gh not run' "$(cat "$GH_LOG")"
done

# ── missing and empty files ─────────────────────────────────────────────────
: > "$WORK/empty"
printf '   \n' > "$WORK/blank"
for case in "$WORK/absent $WORK/body" "$WORK/title $WORK/absent" "$WORK/empty $WORK/body" "$WORK/blank $WORK/body"; do
  : > "$GH_LOG"
  # shellcheck disable=SC2086
  run $case >/dev/null 2>&1
  got=$?
  [ "$got" = 2 ] || fail "refuses $case" 2 "$got"
  [ ! -s "$GH_LOG" ] || fail "gh not run for $case" 'gh not run' "$(cat "$GH_LOG")"
done
run "$WORK/title" >/dev/null 2>&1
got=$?
[ "$got" = 2 ] || fail 'one argument is a usage error' 2 "$got"

# ── gh's exit status is the script's ────────────────────────────────────────
cat > "$STUB/gh" <<'STUBEOF'
#!/bin/sh
cat >/dev/null
exit 4
STUBEOF
run "$WORK/title" "$WORK/body" >/dev/null 2>&1
got=$?
[ "$got" = 4 ] || fail "gh's failure is passed on" 4 "$got"

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo 'termag-pr-create: all tests passed'
