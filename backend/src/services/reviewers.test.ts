import { describe, it, expect } from 'vitest';
import { classifyReviewerPane, isReviewerId, reviewerForForeground, reviewerLaunch, reviewerName, REVIEWER_IDS } from './reviewers';
import { probeReviewPane, reviewLaunchCommand } from './review';

const F = '"$HOME/.termag/review-prompts/a-p-review.md"';

describe('reviewers', () => {
  it('offers Devin, Claude and Cursor under their registry names', () => {
    expect(REVIEWER_IDS).toEqual(['devin', 'claude', 'cursor']);
    expect(REVIEWER_IDS.map(reviewerName)).toEqual(['Devin', 'Claude', 'Cursor']);
    expect(isReviewerId('claude')).toBe(true);
    expect(isReviewerId('codex')).toBe(false);
    expect(isReviewerId(undefined)).toBe(false);
  });
  it('launches each in its read-only-as-possible mode on the prompt file', () => {
    expect(reviewerLaunch('devin', F)).toBe(`devin --permission-mode smart --prompt-file ${F}`);
    expect(reviewerLaunch('claude', F)).toBe(`claude --permission-mode plan "$(cat ${F})"`);
    expect(reviewerLaunch('cursor', F)).toBe(`cursor-agent --mode plan --auto-review "$(cat ${F})"`);
    expect(reviewLaunchCommand('a-p-review', 'claude')).toBe(reviewerLaunch('claude', F));
    expect(reviewLaunchCommand('a-p-review')).toBe(reviewerLaunch('devin', F));
  });
  it('recognises each from the pane foreground command', () => {
    expect(reviewerForForeground('devin')).toBe('devin');
    expect(reviewerForForeground('claude')).toBe('claude');
    expect(reviewerForForeground('cursor-agent')).toBe('cursor');
    expect(reviewerForForeground('zsh')).toBeNull();
    expect(reviewerForForeground(null)).toBeNull();
  });
});

// Pane bottoms as captured from real runs on a box (2026-10-13).
const CLAUDE_WORKING = `  View PR 326 summary
  ⎿  $ gh pr view 326 --repo example-org/termag
✢ Elucidating… (5s · ↓ 191 tokens)
                                                                          ◐ medium · /effort
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏸ plan mode on (shift+tab to cycle) · PR #343 · esc to interrupt · ← for agents`;
const CLAUDE_DONE = `  I only read gh pr view 326, not the diff, and I changed no files and posted nothing to
  GitHub.
✻ Brewed for 15s · done 4:39 AM
────────────────────────────────────────
❯
────────────────────────────────────────
  ⏸ plan mode on (shift+tab to cycle) · PR #343 · ← for agents`;
const CLAUDE_ASKING = `  ⎿  $ rm /tmp/x
────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below
 Delete the empty test file in /tmp
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 rm /tmp/x
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No
 Esc to cancel · Tab to amend`;
const CLAUDE_THEME = ` To change this later, run /theme
     Auto (match terminal)
 ❯ ✔ Dark mode
     Light mode
     Dark mode (colorblind-friendly)
     Light mode (colorblind-friendly)
     Dark mode (ANSI colors only)
     Light mode (ANSI colors only)
 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1  function greet() {
  2 -  console.log("Hello, World!");
  2 +  console.log("Hello, Claude!");
  3  }
 ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  Syntax theme: Monokai Extended (ctrl+t to disable)`;
const CURSOR_WORKING = `  $ gh pr view 326 4.6s
    … 69 output lines hidden · ctrl+o to expand
 ⠘⠆ Running  1.39k tokens
  → Add a follow-up                                                           ctrl+c to stop
  Plan (shift+tab to cycle)
  Auto Balance · 21.8%                                                           Auto-review
  ~/termag/projects/termag/.worktrees/termag-review-templates · termag-review-templates ·
  #343`;
const CURSOR_DONE = `  cautiously approve, noting implementation correctness wasn’t assessed because the diff
  was intentionally not read.
  → Add a follow-up
  Plan (shift+tab to cycle)
  Auto Balance · 22.4%                                                           Auto-review
  ~/termag/projects/termag/.worktrees/termag-review-templates · termag-review-templates ·
  #343`;
const CURSOR_ASKING = `  $ gh pr view 326 Waiting for approval...
────────────────────────────────────────
 $  gh pr view 326 in .
 Run this command?
 Not in allowlist: gh
  → Run (once) (y)
    Add Shell(gh) to allowlist? (tab)
    Run Everything (shift+tab)
    Skip & tell the agent what to do instead (esc or n)`;
const CURSOR_TRUST = `  │  Do you trust the contents of this directory?                                          │
  │                                                                                        │
  │    /home/a/p                                                                           │
  │  ▶ [a] Trust this workspace                                                            │
  │    [q] Quit                                                                            │
  │  Use arrow keys to navigate, Enter to select, or press the key shown                   │
  ╰────────────────────────────────────────────────────────────────────────────────────────╯`;

describe('classifyReviewerPane', () => {
  it('reads Claude', () => {
    expect(classifyReviewerPane('claude', 'claude', CLAUDE_WORKING)).toBe('reviewing');
    expect(classifyReviewerPane('claude', 'claude', CLAUDE_DONE)).toBe('done');
    expect(classifyReviewerPane('claude', 'claude', CLAUDE_ASKING)).toBe('waiting');
    expect(classifyReviewerPane('claude', 'claude', CLAUDE_THEME)).toBe('waiting');
    expect(classifyReviewerPane('claude', 'zsh', CLAUDE_WORKING)).toBe('exited');
  });
  it('reads Cursor', () => {
    expect(classifyReviewerPane('cursor', 'cursor-agent', CURSOR_WORKING)).toBe('reviewing');
    expect(classifyReviewerPane('cursor', 'cursor-agent', CURSOR_DONE)).toBe('done');
    expect(classifyReviewerPane('cursor', 'cursor-agent', CURSOR_ASKING)).toBe('waiting');
    expect(classifyReviewerPane('cursor', 'cursor-agent', CURSOR_TRUST)).toBe('waiting');
  });
  it('a reviewer is only foreground as itself', () => {
    expect(classifyReviewerPane('devin', 'claude', CLAUDE_WORKING)).toBe('exited');
    expect(classifyReviewerPane('cursor', 'claude', CURSOR_WORKING)).toBe('exited');
  });
  it('a quoted pattern high in the review is content, not chrome', () => {
    const quoted = `${CLAUDE_ASKING}\n${'  review text\n'.repeat(20)}${CLAUDE_DONE}`;
    expect(classifyReviewerPane('claude', 'claude', quoted)).toBe('done');
  });
});

describe('probeReviewPane recovers the reviewer', () => {
  const host = { userId: 'u', instanceId: 'i' };
  const fake = (opt: string | null, fg: string, pane: string) => async (_h: unknown, type: string) => {
    if (type === 'tmux-has-session') return { exists: true };
    if (type === 'tmux-foreground-cmd') return { cmd: fg };
    if (type === 'tmux-capture') return { content: pane };
    if (type === 'tmux-get-user-option') return { value: opt };
    throw new Error(type);
  };
  it('from the tmux option after a restart', async () => {
    const p = await probeReviewPane(fake('5 - claude', 'claude', CLAUDE_ASKING), host, 's-review', null);
    expect(p).toMatchObject({ reviewer: 'claude', state: 'waiting', pr: 5, recovered: { pr: 5, url: null, reviewer: 'claude' } });
  });
  it('from the foreground command when the option predates the picker', async () => {
    const p = await probeReviewPane(fake('7', 'cursor-agent', CURSOR_WORKING), host, 's-review', null);
    expect(p).toMatchObject({ reviewer: 'cursor', state: 'reviewing', pr: 7 });
  });
  it('the record wins, and an exited pane keeps it', async () => {
    const p = await probeReviewPane(fake(null, 'zsh', ''), host, 's-review', { pr: 3, url: null, reviewer: 'claude' });
    expect(p).toMatchObject({ reviewer: 'claude', state: 'exited', recovered: null });
  });
  it('Devin when nothing says otherwise', async () => {
    const p = await probeReviewPane(fake('9', 'zsh', ''), host, 's-review', null);
    expect(p).toMatchObject({ reviewer: 'devin', state: 'exited', pr: 9 });
  });
});
