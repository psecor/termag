---
name: termag-bug-report
description: 'Report a termag bug with `termag bug report` when a termag command or feature behaves wrongly - an unexpected error, a refusal with no reason, a crash, or wrong output from `termag`, spaces, asks, publish, boxes, the chat or the broker, including one you worked around: file it, then carry on. Not for your own mistakes, the repository''s failing tests, or a third-party outage. File one report per bug with a minimal repro and no secrets, carry on with a workaround, and put the report id in your handoff.'
---

# Reporting a termag bug

termag's maintainers triage these at `/admin/bugs`. A report filed where the
bug happened, with the command and its error, is worth more than a line in a
handoff that nobody reads again. Reports are write-only from the CLI: you
file them, and the admins read them and mark duplicates, so file the bug you
hit even if someone may have filed it already.

## When to use it

File one when **termag itself** behaves wrongly:

- a `termag` command fails unexpectedly, crashes, or prints wrong output
  (`termag space put` over an existing file answering 403);
- termag refuses something and gives no reason, or a reason that doesn't fit
  (publish refusing a bundle with an empty reason);
- a termag service in the path breaks a normal tool (`gh pr list --search`
  failing through the GitHub broker, the automation classifier denying
  `box stop`);
- the chat, an ask, a box or a space does something its docs say it doesn't.
- termag got in your way and you found a workaround. File it anyway, then
  carry on: the next agent hits the same bug, and a workaround nobody reports
  never gets fixed. For example, publish refusing your commits as a secret
  because of a test fixture already on main (you rewrote the fixture or split
  the commit), or publish recreating a merged PR's branch as a duplicate PR
  (you closed the duplicate by hand).

Don't file one for:

- your own mistakes: a wrong flag, a typo, a path that doesn't exist;
- the repository's tests or build failing;
- a third-party outage (GitHub, the model provider, AWS) that termag only
  passes on;
- a feature request. Mention it in your reply to the user instead.

## How

1. **Write a minimal repro** into a file, in Markdown: the command, what you
   expected, what happened, and the exact error text. Note anything that
   seems to matter (the box, the space, the PR number, whether it fails every
   time).

2. **File it**, one report per bug:

   ```sh
   termag bug report --title "space put over an existing file answers 403" \
     --area spaces --severity medium \
     --command "termag space put notes.md improve-termag:handoffs/x.md" \
     --error-file /tmp/put-error.txt - < /tmp/bug-body.md
   ```

   - `--area`: spaces, asks, publish, boxes, chat, cli, broker or other.
   - `--severity`: `high` when it blocks the task with no workaround, `medium`
     when there's a workaround (the default), `low` for a nuisance.
   - `--error-file`: the command's error output, saved to a file.

   The CLI attaches its own version, your agent and model, and this session's
   project and workstream. The orchestrator adds the box and its agent. It
   prints the report's id. Each box can file 20 an hour.

## Never include secrets

No tokens, keys, cookies or credentials in the title, the body, the command or
the error file. Replace them with `<redacted>` before filing. Anything
secret-shaped the CLI recognises is replaced with `[redacted: …]` before the
report leaves the box, and the CLI says so, but it only recognises some
shapes. Don't rely on it.

## Then carry on

Filing doesn't end your task. If there's a workaround (write the space file
under a new name, run `gh` without `--search`), use it, say in the report that
it works, and finish the task. Put the report id in your handoff and your reply
to the user: "Filed termag bug cmx…: space put over an existing file answers
403; wrote to a new file instead."

## When the command fails

`termag bug report` failing is no reason to stop your task. Say in your reply
that you couldn't file it and why (`At most 20 bug reports an hour …`, `Not
signed in …`), and put the repro in your handoff instead.
