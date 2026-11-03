#!/bin/sh
# Static checks on the termag-bug-report skill that
# termag-reconcile installs for Claude Code and pi: the two copies agree and
# are in the reconcile table, the description says when to file and when not
# to, the body has the minimal-repro, no-secrets, one-per-bug and carry-on
# rules, every flag it shows is one `termag bug report` takes, agent-ask and
# agent-orchestrator point to it, and none of them sends an agent to read
# reports back: they are write-only from the CLI.
#
# Run: sh deploy/termag-bug-report-skill.test.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="$here/claude-skills/termag-bug-report/SKILL.md"
PI="$here/pi-skills/termag-bug-report/SKILL.md"
failed=0
fail() { printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3"; failed=1; }

[ -f "$CLAUDE" ] || fail 'the Claude Code copy exists' "$CLAUDE" '(missing)'
[ -f "$PI" ] || fail 'the pi copy exists' "$PI" '(missing)'
cmp -s "$CLAUDE" "$PI" || fail 'the Claude Code and pi copies are identical' 'no diff' "$(diff "$CLAUDE" "$PI" | head -5)"

# shellcheck disable=SC2016  # $HOME is literal in the reconcile table
for row in 'claude-skills/termag-bug-report/SKILL.md:$HOME/.claude/skills/termag-bug-report/SKILL.md:644:file' \
  'pi-skills/termag-bug-report/SKILL.md:$HOME/.pi/agent/skills/termag-bug-report/SKILL.md:644:file'; do
  grep -qF "$row" "$here/termag-reconcile" || fail 'termag-reconcile installs the skill' "$row" '(not in the table)'
done

name="$(sed -n '2,/^---$/p' "$CLAUDE" | sed -n 's/^name: //p')"
[ "$name" = termag-bug-report ] || fail 'the skill is named termag-bug-report' termag-bug-report "$name"
# Strict YAML: a description holding ': ' is single-quoted ('' for '); see backend/src/skillFrontmatter.test.ts.
description="$(sed -n '2,/^---$/p' "$CLAUDE" | sed -n 's/^description: //p' | sed "s/^'\(.*\)'\$/\1/; s/''/'/g")"
body="$(sed '1,/^---$/d' "$CLAUDE" | tr '\n' ' ' | tr -s ' ')"

for needle in '`termag bug report`' 'a refusal with no reason' 'a crash' 'wrong output' \
  'Not for your own mistakes' "the repository's failing tests" 'a third-party outage' \
  'including one you worked around: file it, then carry on' \
  'one report per bug' 'no secrets' 'workaround' 'report id in your handoff'; do
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
has 'when to file, and when not to' "$body" '## When to use it' '**termag itself**' 'refuses something and gives no reason' \
  'you found a workaround. File it anyway' "Don't file one for:" 'your own mistakes' "the repository's tests or build failing" 'a third-party outage'
has 'write-only, duplicates are the admins'"'"'' "$body" 'write-only from the CLI' 'mark duplicates' 'even if someone may have filed it already'
has 'a minimal repro, then one report per bug' "$body" '## How' '**Write a minimal repro**' 'what you expected, what happened' 'the exact error text' \
  'one report per bug' 'termag bug report --title'
has 'never include secrets' "$body" '## Never include secrets' 'No tokens, keys' '[redacted: …]' "Don't rely on it"
has 'carry on with a workaround and name the id' "$body" '## Then carry on' 'workaround' 'Put the report id in your handoff'

# Every option the skill shows is one the CLI takes (--search is gh's, in the
# broker example).
spec="$here/../cli/src/bug.ts"
for opt in $(grep -oE -- '--[a-z][a-z-]+' "$CLAUDE" | grep -vx -- '--search' | sort -u); do
  case "$opt" in
    --title|--area|--severity|--command|--error-file) ;;
    *) fail 'the skill shows only options termag bug report takes' '--title --area --severity --command --error-file' "$opt" ;;
  esac
  grep -qF -- "$(printf '%s' "$opt" | sed 's/^--//'): { type:" "$spec" \
    || grep -qF -- "'$(printf '%s' "$opt" | sed 's/^--//')': { type:" "$spec" \
    || fail "cli/src/bug.ts still declares $opt" "$opt" '(not an option in bug.ts)'
done
# The messages it quotes are the orchestrator's and the CLI's.
grep -qF 'bug reports an hour from' "$here/../backend/src/routes/cliBugReports.ts" || fail 'the rate-limit message is still the route'"'"'s' 'bug reports an hour from' '(missing)'

grep -qF '`termag-bug-report` skill' "$here/claude-skills/agent-ask/SKILL.md" || fail 'agent-ask points to the skill' '`termag-bug-report` skill' '(missing)'
grep -qF '`termag-bug-report` skill' "$here/claude-skills/agent-orchestrator/SKILL.md" || fail 'agent-orchestrator points to the skill' '`termag-bug-report` skill' '(missing)'

# There is no `termag bug list`, and no search step before filing.
for f in "$CLAUDE" "$here/claude-skills/agent-ask/SKILL.md" "$here/claude-skills/agent-orchestrator/SKILL.md"; do
  hit="$(grep -nE 'bug list|bug ls|[Ss]earch first' "$f" || true)"
  [ -z "$hit" ] || fail "$(basename "$(dirname "$f")") sends no agent to read reports back" '(no bug list, no search first)' "$hit"
done

[ "$failed" = 0 ] && echo 'termag-bug-report skill: ok'
exit "$failed"
