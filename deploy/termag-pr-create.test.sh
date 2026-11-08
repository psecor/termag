#!/bin/sh
# Tests deploy/termag-pr-create, the fixed-argv way agents open a PR.
#
#   * the title file's first line reaches gh as one --title argument and the
#     marked body arrives on stdin, both verbatim: quotes, $(...), backticks
#     and a line reading EOF are data, never shell
#   * extra flags (--draft, --base) pass through; ones that would replace the
#     title or body are refused
#   * a missing or empty file is refused before gh runs
#   * a branch whose remote is the broker URL gets --head <branch> and
#     --repo <broker host>/<the name GitHub reports>, unless --head, --repo or GH_REPO is
#     given; a github.com remote, or no broker, gets nothing added. --head is
#     where git pushes the branch: its upstream's name under
#     push.default=upstream/tracking, or when the push left the upstream's
#     remote-tracking ref at HEAD and not the branch's own; its own name
#     otherwise. The remote's URL is the one configured, so a github.com
#     remote the box rewrites to the broker (insteadOf) gets nothing added
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

# No broker (no GH_HOST, no profile.d file) unless a test sets one, so the
# checkout the tests run from never adds --head/--repo. No BASH_ENV either: on
# a box it is termag-bash-env, which sets GH_HOST to the real broker.
NOHOST="$WORK/no-gh-host"
run() {
  env -u BASH_ENV -u GH_HOST -u GH_REPO TERMAG_PR_CREATE_GH_HOST_FILE="$NOHOST" \
    TERMAG_BOX_ID=b TERMAG_PROJECT=p PATH="$STUB:$PATH" "$BIN/termag-pr-create" "$@"
}

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
# An empty or blank body file fails in termag-pr-body, and gh never starts.
for body in "$WORK/empty" "$WORK/blank"; do
  : > "$GH_LOG"
  run "$WORK/title" "$body" >/dev/null 2>&1
  got=$?
  [ "$got" != 0 ] || fail "refuses the body $body" 'non-zero' "$got"
  [ ! -s "$GH_LOG" ] || fail "gh not run for the body $body" 'gh not run' "$(cat "$GH_LOG")"
done
run "$WORK/title" >/dev/null 2>&1
got=$?
[ "$got" = 2 ] || fail 'one argument is a usage error' 2 "$got"

# ── a remote that is the broker URL gets --head and --repo ──────────────────
# gh stub: `gh api` logs its argv and answers $GH_FULL_NAME (fails when it is
# empty, as a 404 would); `gh pr create` logs as before.
cat > "$STUB/gh" <<'STUBEOF'
#!/bin/sh
if [ "$1" = api ]; then
  echo "$*" >> "$GH_API_LOG"
  [ -n "$GH_FULL_NAME" ] || exit 1
  echo "$GH_FULL_NAME"
  exit 0
fi
for a in "$@"; do printf 'ARG<%s>\n' "$a"; done > "$GH_LOG"
cat > "$GH_STDIN"
STUBEOF
chmod +x "$STUB/gh"
GH_API_LOG="$WORK/gh.api"; export GH_API_LOG
BROKER=github-broker.example.invalid
REPO="$WORK/repo"
git init -q "$REPO"
git -C "$REPO" symbolic-ref HEAD refs/heads/fix/thing
git -C "$REPO" remote add origin "https://$BROKER/example-team/research.git"
printf 'export GH_HOST=%s\n' "$BROKER" > "$WORK/gh-host.sh"

# brun [VAR=value ...] -- [flags]: termag-pr-create in $REPO with the broker
# as GH_HOST and no git config but the repo's.
brun() {
  vars=''
  while [ "$1" != -- ]; do vars="$vars $1"; shift; done
  shift
  : > "$GH_LOG"; : > "$GH_API_LOG"
  # shellcheck disable=SC2086
  (cd "$REPO" && env -u BASH_ENV -u GH_REPO GH_HOST="$BROKER" GH_FULL_NAME=example-org/research \
    TERMAG_PR_CREATE_GH_HOST_FILE="$NOHOST" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    TERMAG_BOX_ID=b TERMAG_PROJECT=p PATH="$STUB:$PATH" $vars \
    "$BIN/termag-pr-create" "$WORK/title" "$WORK/body" "$@") >/dev/null 2>&1
}
args_tail() { sed -n '7,$p' "$GH_LOG" | tr '\n' ' '; }  # after --title T --body-file -

brun -- --draft --base main
want="ARG<--draft> ARG<--base> ARG<main> ARG<--head> ARG<fix/thing> ARG<--repo> ARG<$BROKER/example-org/research> "
[ "$(args_tail)" = "$want" ] || fail 'a broker remote gets --head <branch> --repo <broker>/<canonical name>' "$want" "$(args_tail)"
want="api graphql --hostname $BROKER -f owner=example-team -f name=research -f query=query(\$owner: String!, \$name: String!) { repository(owner: \$owner, name: \$name) { nameWithOwner } } --jq .data.repository.nameWithOwner"
[ "$(cat "$GH_API_LOG")" = "$want" ] || fail 'the canonical name comes from gh api on the broker' "$want" "$(cat "$GH_API_LOG")"

brun GH_FULL_NAME= -- --draft
want="ARG<--draft> ARG<--head> ARG<fix/thing> ARG<--repo> ARG<$BROKER/example-team/research> "
[ "$(args_tail)" = "$want" ] || fail "gh api failing falls back to the remote's owner/repo" "$want" "$(args_tail)"

brun GH_HOST= TERMAG_PR_CREATE_GH_HOST_FILE="$WORK/gh-host.sh" -- --draft
want="ARG<--draft> ARG<--head> ARG<fix/thing> ARG<--repo> ARG<$BROKER/example-org/research> "
[ "$(args_tail)" = "$want" ] || fail 'the broker host read from profile.d without GH_HOST is in --repo, so gh pr create targets the broker' "$want" "$(args_tail)"

# An ask clone: the branch tracks origin/main and pushes under its own name
# (push.default=current, or git's default, simple). The push left
# origin/fix/thing at HEAD; origin/main is behind it.
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m base
git -C "$REPO" update-ref refs/remotes/origin/main HEAD
git -C "$REPO" -c user.name=t -c user.email=t@t commit -q --allow-empty -m work
git -C "$REPO" update-ref refs/remotes/origin/fix/thing HEAD
git -C "$REPO" config branch.fix/thing.remote origin
git -C "$REPO" config branch.fix/thing.merge refs/heads/main
want="ARG<--draft> ARG<--head> ARG<fix/thing> ARG<--repo> ARG<$BROKER/example-org/research> "
for pd in current simple ''; do
  if [ -n "$pd" ]; then git -C "$REPO" config push.default "$pd"; else git -C "$REPO" config --unset push.default; fi
  brun -- --draft
  [ "$(args_tail)" = "$want" ] || fail "tracking main, push.default=${pd:-unset}: --head is the branch, not main" "$want" "$(args_tail)"
done
# push.default=upstream (or tracking) pushes to the upstream's name.
git -C "$REPO" config branch.fix/thing.merge refs/heads/fix/thing-upstream
want="ARG<--draft> ARG<--head> ARG<fix/thing-upstream> ARG<--repo> ARG<$BROKER/example-org/research> "
for pd in upstream tracking; do
  git -C "$REPO" config push.default "$pd"
  brun -- --draft
  [ "$(args_tail)" = "$want" ] || fail "push.default=$pd: --head is the upstream branch's name" "$want" "$(args_tail)"
done
git -C "$REPO" config --unset push.default
# `git push -u origin HEAD:review-123`: the upstream is review-123 and the
# push left origin/review-123 at HEAD, with no origin/fix/thing.
git -C "$REPO" update-ref -d refs/remotes/origin/fix/thing
git -C "$REPO" update-ref refs/remotes/origin/review-123 HEAD
git -C "$REPO" config branch.fix/thing.merge refs/heads/review-123
want="ARG<--draft> ARG<--head> ARG<review-123> ARG<--repo> ARG<$BROKER/example-org/research> "
for pd in simple current ''; do
  if [ -n "$pd" ]; then git -C "$REPO" config push.default "$pd"; else git -C "$REPO" config --unset push.default; fi
  brun -- --draft
  [ "$(args_tail)" = "$want" ] || fail "pushed to its upstream review-123, push.default=${pd:-unset}: --head is review-123" "$want" "$(args_tail)"
done
git -C "$REPO" update-ref -d refs/remotes/origin/review-123
git -C "$REPO" update-ref -d refs/remotes/origin/main
git -C "$REPO" config --unset branch.fix/thing.merge
git -C "$REPO" config --unset branch.fix/thing.remote

for flags in '--head x' '--head=x' '-H x' '--repo o/r' '--repo=o/r' '-R o/r' '-Ro/r'; do
  # shellcheck disable=SC2086
  brun -- --draft $flags
  want="ARG<--draft> $(for f in $flags; do printf 'ARG<%s> ' "$f"; done)"
  [ "$(args_tail)" = "$want" ] || fail "$flags given: nothing added" "$want" "$(args_tail)"
  [ ! -s "$GH_API_LOG" ] || fail "$flags given: no gh api" 'no call' "$(cat "$GH_API_LOG")"
done

brun GH_REPO=o/r -- --draft
[ "$(args_tail)" = 'ARG<--draft> ' ] || fail 'GH_REPO set: nothing added' 'ARG<--draft> ' "$(args_tail)"

brun GH_HOST= -- --draft
[ "$(args_tail)" = 'ARG<--draft> ' ] || fail 'no broker (github skipped): nothing added' 'ARG<--draft> ' "$(args_tail)"

git -C "$REPO" remote set-url origin https://github.com/example-org/research.git
brun -- --draft
[ "$(args_tail)" = 'ARG<--draft> ' ] || fail 'a github.com remote: nothing added' 'ARG<--draft> ' "$(args_tail)"
# A box rewrites github.com to the broker (url.<broker>.insteadOf), so git
# reports the broker URL for this remote; gh maps it itself.
git -C "$REPO" config "url.https://$BROKER/.insteadOf" https://github.com/
brun -- --draft
[ "$(args_tail)" = 'ARG<--draft> ' ] || fail 'a github.com remote rewritten to the broker: nothing added' 'ARG<--draft> ' "$(args_tail)"
[ ! -s "$GH_API_LOG" ] || fail 'a github.com remote rewritten to the broker: no gh api' 'no call' "$(cat "$GH_API_LOG")"
git -C "$REPO" config --unset "url.https://$BROKER/.insteadOf"

git -C "$REPO" remote set-url origin "https://$BROKER/example-org/js-core"
brun GH_FULL_NAME=example-org/js-core -- --draft
want="ARG<--draft> ARG<--head> ARG<fix/thing> ARG<--repo> ARG<$BROKER/example-org/js-core> "
[ "$(args_tail)" = "$want" ] || fail 'a broker remote without .git' "$want" "$(args_tail)"

git -C "$REPO" remote rename origin upstream
git -C "$REPO" remote add origin https://github.com/someone/fork.git
git -C "$REPO" config branch.fix/thing.pushRemote upstream
brun GH_FULL_NAME=example-org/js-core -- --draft
[ "$(args_tail)" = "$want" ] || fail "the branch's pushRemote, not origin" "$want" "$(args_tail)"

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
