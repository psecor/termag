#!/bin/sh
# Static checks on the termag-feedback skill that
# termag-reconcile installs for Claude Code and pi: the two copies agree and
# are in the reconcile table, the description says when to log (a person's
# words about termag) and when not to (their own code, another product, a bug
# the agent hit), the body has the in-their-words, no-secrets and carry-on
# rules, and every flag it shows is one `termag feedback` takes.
#
# Run: sh deploy/termag-feedback-skill.test.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="$here/claude-skills/termag-feedback/SKILL.md"
PI="$here/pi-skills/termag-feedback/SKILL.md"
failed=0
fail() { printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3"; failed=1; }

[ -f "$CLAUDE" ] || fail 'the Claude Code copy exists' "$CLAUDE" '(missing)'
[ -f "$PI" ] || fail 'the pi copy exists' "$PI" '(missing)'
cmp -s "$CLAUDE" "$PI" || fail 'the Claude Code and pi copies are identical' 'no diff' "$(diff "$CLAUDE" "$PI" | head -5)"

# shellcheck disable=SC2016  # $HOME is literal in the reconcile table
for row in 'claude-skills/termag-feedback/SKILL.md:$HOME/.claude/skills/termag-feedback/SKILL.md:644:file:noenable:feature' \
  'pi-skills/termag-feedback/SKILL.md:$HOME/.pi/agent/skills/termag-feedback/SKILL.md:644:file:noenable:feature'; do
  grep -qF "$row" "$here/termag-reconcile" || fail 'termag-reconcile installs the skill' "$row" '(not in the table)'
done

name="$(sed -n '2,/^---$/p' "$CLAUDE" | sed -n 's/^name: //p')"
[ "$name" = termag-feedback ] || fail 'the skill is named termag-feedback' termag-feedback "$name"
# Strict YAML: a description holding ': ' is single-quoted ('' for '); see backend/src/skillFrontmatter.test.ts.
description="$(sed -n '2,/^---$/p' "$CLAUDE" | sed -n 's/^description: //p' | sed "s/^'\(.*\)'\$/\1/; s/''/'/g")"
body="$(sed '1,/^---$/d' "$CLAUDE" | tr '\n' ' ' | tr -s ' ')"

for needle in '`termag feedback`' "feedback about termag itself" 'praise, a complaint' 'a wish' \
  'the sidebar is confusing' 'I wish asks showed progress' 'in their words' 'say in one line that you did, and carry on' \
  'Not for feedback about their own code' 'another product' 'termag-bug-report' 'Never include secrets'; do
  case "$description" in *"$needle"*) ;; *) fail "the description says: $needle" "$needle" "$description" ;; esac
done
len="$(printf '%s' "$description" | wc -c | tr -d ' ')"
[ "$len" -le 1024 ] || fail 'the description fits the 1024-character skill limit' '<= 1024' "$len"

# has LABEL TEXT NEEDLE...: every needle appears in TEXT, in order.
has() {
  label="$1" rest="$2"; shift 2
  for needle in "$@"; do
    case "$rest" in
      *"$needle"*) rest="${rest#*"$needle"}" ;;
      *) fail "$label" "$needle" "(not found after the previous needle)"; return 0 ;;
    esac
  done
}
has 'when to log, and when not to' "$body" '## When to use it' '**about termag itself**' "Don't log:" \
  '**their own code**' '**another product**' 'a termag bug **you** ran into' 'termag-bug-report skill' 'Only what the person said'
has 'how: in their words, with a kind' "$body" '## How' 'in their words' "Don't add your interpretation" \
  '`praise`, `problem`' '`idea`' '`other` (the default)'
has 'how: the words go through a file of its own, never the shell' "$body" '## How' 'a directory of your own' 'mktemp -d' \
  'Not a fixed path' 'with your file-writing tool' 'not with `echo`, `printf` or a heredoc' \
  'termag feedback --kind idea - < <dir>/feedback.md' 'Never put their words in the command line'
# Every session on a box shares /tmp: no example logs from a fixed path there.
fixed="$(grep -nE -- '- < /tmp/' "$CLAUDE" || true)"
[ -z "$fixed" ] || fail 'the skill logs from a directory of its own, not a fixed /tmp path' '- < <dir>/…' "$fixed"
# The person's words are data: no example passes text to termag feedback as an argument (only `-`, on stdin).
inline="$(grep -nE 'termag feedback( --kind [a-z]+)? +[^-[:space:]]|termag feedback .*(-- |["'"'"'`])' "$CLAUDE" | grep -v '^[0-9]*:description:' || true)"
[ -z "$inline" ] || fail 'the skill never puts the words on the command line' '(only - < file)' "$inline"
has 'never include secrets' "$body" '## Never include secrets' 'No tokens, keys' '[redacted: …]' "Don't rely on it"
has 'say so and carry on' "$body" '## Then carry on' 'one short line' "don't stop the task for it" 'If `termag feedback` fails' "Don't retry in a loop"

# Every option the skill shows is one the CLI takes.
spec="$here/../cli/src/feedback.ts"
for opt in $(grep -oE -- '--[a-z][a-z-]+' "$CLAUDE" | sort -u); do
  [ "$opt" = --kind ] || fail 'the skill shows only options termag feedback takes' '--kind' "$opt"
  grep -qF -- "$(printf '%s' "$opt" | sed 's/^--//'): { type:" "$spec" || fail "cli/src/feedback.ts still declares $opt" "$opt" '(not an option)'
done
# The messages it quotes are the orchestrator's.
grep -qF 'pieces of feedback an hour from' "$here/../backend/src/routes/cliFeedback.ts" || fail 'the rate-limit message is still the route'"'"'s' 'pieces of feedback an hour from' '(missing)'
# The bug-report skill sends a person's feature request here.
grep -qF 'termag-feedback' "$here/claude-skills/termag-bug-report/SKILL.md" || fail 'termag-bug-report points to this skill' 'termag-feedback' '(missing)'

[ "$failed" = 0 ] && echo 'termag-feedback skill: ok'
exit "$failed"
