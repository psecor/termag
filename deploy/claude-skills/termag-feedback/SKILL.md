---
name: termag-feedback
description: 'Log a person''s feedback about termag itself with `termag feedback` when they say something in the chat about termag - praise, a complaint, a confusion or a wish about termag''s UI, chat, sidebar, asks, spaces, boxes, the CLI or the agents it runs ("the sidebar is confusing", "I wish asks showed progress", "spaces are great"): log it in their words, say in one line that you did, and carry on with what they asked. Not for feedback about their own code, their repository, or another product (Claude Code, GitHub, Slack), and not for a bug you hit yourself (that is termag-bug-report). Never include secrets.'
---

# Logging feedback about termag

termag's admins read every piece of feedback at `/admin/feedback`. What a
person says about termag in passing, in a chat, is the most honest feedback
termag gets, and it is lost unless you log it. Logging is one command; it
doesn't change what you do next.

## When to use it

Log it when the person, in this chat, says something **about termag itself**:

- praise: "spaces are great, sharing that handoff took seconds";
- a complaint or a confusion: "the sidebar is confusing", "I never know
  which box a session is on";
- a wish or an idea: "I wish asks showed progress", "it would be nice if the
  chat remembered my last project";
- something termag made hard, slow or surprising for them, even when it
  worked.

termag here is the product you are running in: its web and simple UI, the
chat, the sidebar, asks, spaces, boxes, previews, automations, the `termag`
CLI, and how it runs agents. Log what they said once per remark, even when
it is mixed into a longer message about other work.

Don't log:

- feedback about **their own code**, repository, PR or design ("this API is
  confusing" about the service they are building);
- feedback about **another product**, even one termag uses: Claude Code
  itself, the model, GitHub, Slack, AWS. When it is unclear
  whether they mean termag or the tool inside it, log it only if it is about
  how termag presents or runs it;
- a termag bug **you** ran into while working (a command failing, a refusal):
  that is `termag bug report` (the termag-bug-report skill). When the person
  reports a termag bug in their own words, log it here as `--kind problem`,
  in their words; file a bug report too only if you reproduced it;
- your own opinions of termag, or what you guess they think. Only what the
  person said;
- the same remark again when they repeat it in this session.

## How

1. **Pick a directory of your own**: your session's scratchpad directory if
   you have one, else make one with `mktemp -d`. Not a fixed path such as
   `/tmp/termag-feedback.md`: other sessions on the box write theirs there
   too, and one would log another's words.

2. **Write what they said to a file there with your file-writing tool**
   (Write), not with `echo`, `printf` or a heredoc: the person's words are
   data, and a shell would run any `$(…)` or backticks in them. For example,
   `<dir>/feedback.md`:

   ```
   I wish asks showed their progress in the sidebar
   ```

3. **Log it from that file**, on stdin, with the directory's full path for
   `<dir>`:

   ```sh
   termag feedback --kind idea - < <dir>/feedback.md
   ```

- Never put their words in the command line itself, quoted or not. On stdin,
  quotes, `$`, backticks and a leading dash are all just text.
- The text is what they said, in their words or close to them, with enough
  context to stand alone: name the part of termag ("in the simple UI's
  sidebar, the asks are hard to find"). Don't add your interpretation.
- `--kind`: `praise`, `problem` (a complaint, a confusion, something that got
  in their way), `idea` (a wish or a suggestion), or `other` (the default).

The CLI attaches its version, your agent and model, and this session's
project and workstream; the orchestrator adds the person and the box. It
prints the feedback's id. Each box can log 20 an hour.

## Never include secrets

No tokens, keys, cookies, passwords or credentials, and nothing from their
code or private data beyond what the remark needs. Replace anything like that
with `<redacted>` first. The CLI replaces secret-shaped strings it recognises
with `[redacted: …]`, but it only recognises some shapes. Don't rely on it.

## Then carry on

Say so in one short line, and go on with what they asked: "Logged that as
feedback for termag's team." Don't ask them to confirm first, don't
discuss the feedback unless they want to, and don't stop the task for it.

If `termag feedback` fails (`At most 20 pieces of feedback an hour …`, `Not
signed in …`), say in that same line that you couldn't log it and why, and
carry on. Don't retry in a loop.
