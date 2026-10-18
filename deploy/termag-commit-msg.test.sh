#!/bin/sh
# Tests deploy/termag-commit-msg, the commit-msg hook a box's git template
# carries, with a real git and init.templateDir set the way termag-reconcile
# sets it.
#
#   * a repository inited or cloned on the box gets the hook, a worktree uses it
#   * a commit gets `Generated-by: termag` once, joining an existing trailer block
#   * an existing Generated-by trailer is kept; an empty message adds nothing
#   * pre-commit's legacy chaining still runs it
#   * `termag.trailer false` turns it off
#
# Run: sh deploy/termag-commit-msg.test.sh
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/termag-commit-msg"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v git >/dev/null 2>&1 || { echo "SKIP: git not installed"; exit 0; }

failures=0
fail() {
  echo "FAIL: $1"
  echo "      want: $2"
  echo "      got:  $3"
  failures=$((failures + 1))
}

TEMPLATE="$WORK/template"
mkdir -p "$TEMPLATE/hooks"
cp "$SCRIPT" "$TEMPLATE/hooks/commit-msg"
chmod 755 "$TEMPLATE/hooks/commit-msg"

export HOME="$WORK/home"
export GIT_CONFIG_NOSYSTEM=1
unset GIT_CONFIG_GLOBAL
mkdir -p "$HOME"
git config --global user.name 'T Est'
git config --global user.email 't@example.com'
git config --global init.defaultBranch main
git config --global init.templateDir "$TEMPLATE"

REPO="$WORK/repo"
git init -q "$REPO"
cd "$REPO" || exit 1
[ -x .git/hooks/commit-msg ] || fail 'git init copies the hook' 'executable .git/hooks/commit-msg' 'absent'

trailers() { git log -1 --format='%(trailers:key=Generated-by,valueonly)' "$@" | sed '/^$/d'; }

# ── the trailer ─────────────────────────────────────────────────────────────
echo a > a && git add a && git commit -qm 'feat: a' >/dev/null 2>&1
got="$(trailers)"
[ "$got" = termag ] || fail 'commit gets the trailer' termag "$got"
got="$(git log -1 --format=%B | sed -n 1p)"
[ "$got" = 'feat: a' ] || fail 'subject is untouched' 'feat: a' "$got"

echo b > a && git commit -qam "$(printf 'fix: b\n\nGenerated-by: someone-else')" >/dev/null 2>&1
got="$(trailers)"
[ "$got" = someone-else ] || fail 'an existing trailer is kept, not doubled' someone-else "$got"

echo c > a && git commit -qam "$(printf 'fix: c\n\nCo-Authored-By: X <x@example.com>')" >/dev/null 2>&1
got="$(git log -1 --format='%(trailers:only,unfold)' | sed '/^$/d' | tr '\n' '|')"
[ "$got" = 'Co-Authored-By: X <x@example.com>|Generated-by: termag|' ] \
  || fail 'joins the existing trailer block' 'Co-Authored-By then Generated-by' "$got"

# An empty message: the hook must not give it a body (git would then commit).
printf '' > "$WORK/empty"
"$TEMPLATE/hooks/commit-msg" "$WORK/empty"
got="$(cat "$WORK/empty")"
[ -z "$got" ] || fail 'an empty message stays empty' '' "$got"
printf '# only a comment\n' > "$WORK/comment"
"$TEMPLATE/hooks/commit-msg" "$WORK/comment"
got="$(cat "$WORK/comment")"
[ "$got" = '# only a comment' ] || fail 'a comment-only message stays as is' '# only a comment' "$got"

# ── clones and worktrees ────────────────────────────────────────────────────
git clone -q "$REPO" "$WORK/clone" 2>/dev/null
[ -x "$WORK/clone/.git/hooks/commit-msg" ] || fail 'git clone copies the hook' 'present' 'absent'

git worktree add -q "$REPO/.worktrees/ws" -b ws >/dev/null 2>&1
(cd "$REPO/.worktrees/ws" && echo g > a && git commit -qam 'feat: g' >/dev/null 2>&1)
got="$(trailers ws)"
[ "$got" = termag ] || fail 'a worktree commit gets the trailer' termag "$got"

# ── pre-commit's legacy chaining ────────────────────────────────────────────
# pre-commit install --hook-type commit-msg renames an existing hook to
# commit-msg.legacy and runs it first; a stand-in for its hook does the same.
mv .git/hooks/commit-msg .git/hooks/commit-msg.legacy
cat > .git/hooks/commit-msg <<'EOF'
#!/bin/sh
"$(dirname "$0")/commit-msg.legacy" "$@" || exit
EOF
chmod +x .git/hooks/commit-msg
echo h > a && git commit -qam 'feat: h' >/dev/null 2>&1
got="$(trailers)"
[ "$got" = termag ] || fail 'still runs as commit-msg.legacy' termag "$got"

# ── off switch ──────────────────────────────────────────────────────────────
git config termag.trailer false
echo i > a && git commit -qam 'feat: i' >/dev/null 2>&1
got="$(trailers)"
[ -z "$got" ] || fail 'termag.trailer false skips it' '' "$got"

if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo 'termag-commit-msg: all tests passed'
