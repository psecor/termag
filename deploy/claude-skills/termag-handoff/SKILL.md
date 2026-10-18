---
name: termag-handoff
description: Write a handoff for the next agent and hand this termag session off (clear, compact or restart, optionally on another agent). Use when termag types "[termag] Hand off requested", when the user asks to hand off, start fresh with a handoff, or restart the agent (new MCP servers, tools, settings or another provider), or when your context is large and the work is at a natural break.
---

# Handing off a termag session

A handoff replaces this conversation for the next agent in this pane. termag
clears or restarts the pane and gives the next agent your handoff as its first
prompt. Write it for someone who
has the repository but none of this conversation.

## When termag asks

termag types `[termag] Hand off requested: … handoffId <id>`. Then:

1. Stop. Do not start new work, and do not finish a half-done change unless it
   takes a step or two. Say in the handoff what is unfinished instead.
2. Write the handoff (format below).
3. Call `mcp__metaterm__handoff_written` with that `handoffId` and the text as
   `body`.
4. End your turn. termag acts once the pane is idle.

If the tool says the text looks like a secret, rewrite it without the value
(name where the secret lives instead) and call it again.

## When you or the user start it

Call `mcp__metaterm__handoff` with:

- `mode`: `clear` (default; the smallest context), `compact`, or `restart`.
  Restart is the only one that loads new MCP servers, tools or settings, and
  the only one that can change `provider`.
- `body`: the handoff, written first, so termag does not have to ask for it.
- `note` (optional): one line for the next agent.

Propose it to the user before calling it unless they asked. Claude Code asks
for approval on every call. After it returns, end your turn and do nothing
else.

## The format

Markdown, at most about 32,000 characters, usually far less. Use these
sections, and leave one out only when it would be empty:

```
## Goal
1–3 lines: what this line of work is trying to achieve.

## State
Done / in progress / blocked. Branch, last commit, PR and its checks.
Uncommitted changes, and whether they matter.

## Decisions
Each with a one-line why. Mark the user's own decisions as theirs.

## Open questions
Each with what or who it is waiting on.

## Gotchas
Traps found: commands that mislead, flaky tests, environment quirks.

## Next steps
Numbered, the first one concrete enough to start on immediately.

## Refs
Files, docs, PRs, Jira keys, commands worth rerunning.
```

Write the facts the next agent cannot cheaply recover: decisions and their
reasons, what was tried and failed, what the user asked for in their own
words. Skip what `git log`, `git diff` or the code already says. Never paste
secrets, tokens or long terminal output; a short excerpt of an error is fine.
