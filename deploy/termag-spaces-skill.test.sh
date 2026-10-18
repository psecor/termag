#!/bin/sh
# Static checks on the termag-spaces skill that termag-reconcile
# installs for Claude Code and pi: the two copies agree, and the nudge to share
# what an agent makes through a space is in the description, which both agents
# keep in context every session, and in the body. The nudge is about handing a
# file to someone; it must never suggest keeping files out of the repository.
#
# Run: sh deploy/termag-spaces-skill.test.sh
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="$here/claude-skills/termag-spaces/SKILL.md"
PI="$here/pi-skills/termag-spaces/SKILL.md"
failed=0
fail() { printf 'FAIL: %s\n  want: %s\n  got:  %s\n' "$1" "$2" "$3"; failed=1; }

cmp -s "$CLAUDE" "$PI" || fail 'the Claude Code and pi copies are identical' 'no diff' "$(diff "$CLAUDE" "$PI" | head -5)"

description="$(sed -n '2,/^---$/p' "$CLAUDE" | sed -n 's/^description: //p')"
body="$(sed '1,/^---$/d' "$CLAUDE" | tr '\n' ' ' | tr -s ' ')"
nudge='you produce a file someone else will want (a report, screenshots, a dataset, build output), put it in the space and give the `space:path`'

case "$description" in
  *"When this box reaches a space and $nudge."*) ;;
  *) fail 'the description carries the nudge, only for a box that reaches a space' "When this box reaches a space and $nudge." "$description" ;;
esac
case "$body" in
  *"## Sharing what you make When this box reaches at least one space"*"$nudge"*) ;;
  *) fail 'the body has a Sharing what you make section with the nudge' "$nudge" "$(printf '%s' "$body" | head -c 300)" ;;
esac

len="$(printf '%s' "$description" | wc -c | tr -d ' ')"
[ "$len" -le 1024 ] || fail 'the description fits the 1024-character skill limit' '<= 1024' "$len"

got="$(grep -inE 'instead of commit|rather than commit|(do not|don.t|never) commit|out of (git|the repo)|large (or|and) binary|binar(y|ies) (files )?(in|into|to) (the|a) space' "$CLAUDE" || true)"
[ -z "$got" ] || fail 'nothing suggests a space in place of committing large or binary files' '' "$got"

[ "$failed" = 0 ] && echo 'termag-spaces skill: ok'
exit "$failed"
