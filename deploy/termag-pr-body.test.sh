#!/bin/sh
# Tests deploy/termag-pr-body, the wrapper agents pipe a PR body through.
#
#   * the body sits between the BEGIN/END markers, then the hidden termag
#     line and the visible footer
#   * box comes from --box, TERMAG_BOX_ID, IMDS, then the hostname
#   * project comes from --project, TERMAG_PROJECT, the termag project path
#     (workstream worktrees included), then the git checkout's name
#   * a marked body is unwrapped first, so a second pass doesn't stack
#   * values can't close the HTML comment
#   * a missing or blank body exits 1 and prints nothing, so it can't blank
#     a PR; a bot's text on the footer line doesn't double the footer
#
# Run: sh deploy/termag-pr-body.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/termag-pr-body"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

# curl and hostname stubs: IMDS answers only when IMDS_ID is set.
STUB="$WORK/stub"
mkdir -p "$STUB"
cat > "$STUB/curl" <<'EOF'
#!/bin/sh
[ -n "${IMDS_ID:-}" ] || exit 7
case "$*" in
  *api/token*) printf 'tok' ;;
  *instance-id*) printf '%s' "$IMDS_ID" ;;
esac
EOF
cat > "$STUB/hostname" <<'EOF'
#!/bin/sh
printf 'host-1\n'
EOF
chmod +x "$STUB/curl" "$STUB/hostname"

run() { env -u TERMAG_BOX_ID -u TERMAG_PROJECT -u TERMAG_ASK_THREAD PATH="$STUB:$PATH" "$SCRIPT" "$@"; }

# ── the shape ───────────────────────────────────────────────────────────────
got="$(printf 'Summary\n\n- one\n' | run --box i-0abc --project web)"
want="$(printf '%s\n' '<!-- TERMAG_PR_BODY_BEGIN -->' 'Summary' '' '- one' '<!-- TERMAG_PR_BODY_END -->' '' \
  '<!-- termag: box=i-0abc project=web -->' '<sub>Opened from termag</sub>')"
[ "$got" = "$want" ] || fail 'wraps the body and adds the footer' "$want" "$got"

got="$(printf 'x\n' | run --box b --project p --ask th_123 | grep '^<!-- termag:')"
[ "$got" = '<!-- termag: box=b project=p ask=th_123 -->' ] || fail '--ask is added' 'ask=th_123' "$got"
got="$(printf 'x\n' | env -u TERMAG_BOX_ID -u TERMAG_PROJECT TERMAG_ASK_THREAD=thr0000000001 PATH="$STUB:$PATH" "$SCRIPT" --box b --project p | grep '^<!-- termag:')"
[ "$got" = '<!-- termag: box=b project=p ask=thr0000000001 -->' ] || fail "an ask run's TERMAG_ASK_THREAD is the default --ask" 'ask=thr0000000001' "$got"

printf 'from a file\n' > "$WORK/body.md"
got="$(run --box b --project p "$WORK/body.md" | sed -n 2p)"
[ "$got" = 'from a file' ] || fail 'reads FILE' 'from a file' "$got"

# ── box ─────────────────────────────────────────────────────────────────────
got="$(printf 'x' | env -u TERMAG_PROJECT TERMAG_BOX_ID=env-box PATH="$STUB:$PATH" "$SCRIPT" --project p | grep -o 'box=[^ ]*')"
[ "$got" = 'box=env-box' ] || fail 'TERMAG_BOX_ID' 'box=env-box' "$got"

got="$(printf 'x' | IMDS_ID=i-0123456789abcdef0 run --project p | grep -o 'box=[^ ]*')"
[ "$got" = 'box=i-0123456789abcdef0' ] || fail 'IMDS instance id' 'box=i-0123456789abcdef0' "$got"

got="$(printf 'x' | run --project p | grep -o 'box=[^ ]*')"
[ "$got" = 'box=host-1' ] || fail 'hostname fallback' 'box=host-1' "$got"

# ── project ─────────────────────────────────────────────────────────────────
PROJ="$WORK/home/termag/projects/my-app"
mkdir -p "$PROJ/.worktrees/feature-x/src"
got="$(cd "$PROJ" && printf 'x' | run --box b | grep -o 'project=[^ ]*')"
[ "$got" = 'project=my-app' ] || fail 'project from the termag path' 'project=my-app' "$got"
got="$(cd "$PROJ/.worktrees/feature-x/src" && printf 'x' | run --box b | grep -o 'project=[^ ]*')"
[ "$got" = 'project=my-app' ] || fail 'project from a workstream worktree' 'project=my-app' "$got"

if command -v git >/dev/null 2>&1; then
  REPO="$WORK/elsewhere/checkout"
  mkdir -p "$REPO/sub"
  git -C "$REPO" init -q
  got="$(cd "$REPO/sub" && printf 'x' | run --box b | grep -o 'project=[^ ]*')"
  [ "$got" = 'project=checkout' ] || fail 'project from the git checkout' 'project=checkout' "$got"
fi

got="$(cd "$PROJ" && printf 'x' | env -u TERMAG_BOX_ID TERMAG_PROJECT=from-env PATH="$STUB:$PATH" "$SCRIPT" --box b | grep -o 'project=[^ ]*')"
[ "$got" = 'project=from-env' ] || fail 'TERMAG_PROJECT wins over the path' 'project=from-env' "$got"

# ── idempotent ──────────────────────────────────────────────────────────────
once="$(printf 'Body\n' | run --box b --project p)"
twice="$(printf '%s\n' "$once" | run --box b --project p)"
[ "$once" = "$twice" ] || fail 'a second pass does not stack' "$once" "$twice"
got="$(printf '%s\n' "$twice" | grep -c 'TERMAG_PR_BODY_BEGIN')"
[ "$got" = 1 ] || fail 'one BEGIN marker after two passes' 1 "$got"

# Text someone added on GitHub around the marked block survives a re-wrap.
edited="$(printf '%s\n' 'Note above' '' "$once" '' 'Added below the footer' '' 'second para')"
got="$(printf '%s\n' "$edited" | run --box b2 --project p)"
want="$(printf '%s\n' 'Note above' '' '<!-- TERMAG_PR_BODY_BEGIN -->' 'Body' '<!-- TERMAG_PR_BODY_END -->' '' \
  '<!-- termag: box=b2 project=p -->' '<sub>Opened from termag</sub>' '' 'Added below the footer' '' 'second para')"
[ "$got" = "$want" ] || fail 'keeps text before BEGIN and after the footer' "$want" "$got"
again="$(printf '%s\n' "$got" | run --box b2 --project p)"
[ "$again" = "$got" ] || fail 'a re-wrap with outside text is stable' "$got" "$again"

# A bot appended onto the footer line: one footer after a re-wrap, its text kept.
botted="$(printf '%s\n' "$once" | sed 's|^<sub>Opened from termag</sub>$|&<!-- preview-link -->|'; printf '%s\n' 'Preview: https://x')"
got="$(printf '%s\n' "$botted" | run --box b --project p)"
want="$(printf '%s\n' "$once" '' '<!-- preview-link -->' 'Preview: https://x')"
[ "$got" = "$want" ] || fail 'text a bot put on the footer line keeps one footer' "$want" "$got"
again="$(printf '%s\n' "$got" | run --box b --project p)"
[ "$again" = "$got" ] || fail 'a re-wrap after a bot footer is stable' "$got" "$again"

# ── a missing or blank body is an error, with nothing on stdout ─────────────
: > "$WORK/empty.md"
printf ' \n\t\n' > "$WORK/blank.md"
mkdir -p "$WORK/adir"
for case in "$WORK/absent.md" "$WORK/empty.md" "$WORK/blank.md" "$WORK/adir"; do
  out="$(run --box b --project p "$case" 2>"$WORK/err")"
  got=$?
  [ "$got" = 1 ] || fail "exits 1 for $case" 1 "$got"
  [ -z "$out" ] || fail "prints nothing for $case" '' "$out"
  grep -q '^termag-pr-body: ' "$WORK/err" || fail "says why for $case" 'termag-pr-body: ...' "$(cat "$WORK/err")"
done
out="$(printf '' | run --box b --project p 2>/dev/null)"
got=$?
[ "$got" = 1 ] && [ -z "$out" ] || fail 'an empty stdin is an error' '1, no output' "$got, $out"
err="$(run --box b --project p "$WORK/absent.md" 2>&1 >/dev/null)"
[ "$err" = "termag-pr-body: no body file: $WORK/absent.md" ] || fail 'names the missing file' "no body file: $WORK/absent.md" "$err"

# The skill's recipe: a missing body leaves the marked file empty and gh unrun.
run --box b --project p "$WORK/absent.md" > "$WORK/marked.md" 2>/dev/null && : > "$WORK/gh.ran"
[ ! -e "$WORK/gh.ran" ] || fail 'the recipe stops before gh pr edit' 'gh not run' 'gh ran'

# ── values can't close the comment ──────────────────────────────────────────
got="$(printf 'x' | run --box 'b -->' --project 'p<x>' --ask 'a b' | grep '^<!-- termag:')"
want='<!-- termag: box=b_--_ project=p_x_ ask=a_b -->'
[ "$got" = "$want" ] || fail 'values are sanitised' "$want" "$got"

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo 'termag-pr-body: all tests passed'
