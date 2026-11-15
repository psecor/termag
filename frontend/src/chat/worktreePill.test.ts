import { describe, expect, it } from 'vitest';
import { followsWords } from './PermissionPicker';
import { worktreePillWords } from '../pages/chat/WorktreePill';

describe('the worktree pill (chat-session-permissions-enabled)', () => {
  it('says which code the session gets, and what a press switches it to', () => {
    expect(worktreePillWords({ worktree: 'termag-22', target: 'termag-22', of: 'termag', fetchedFrom: 'origin/main' })).toEqual({
      label: 'Worktree of termag-22',
      lead: 'A worktree of termag-22, your checkout of termag',
      sub: 'A new branch from origin/main, fetched now, with no clone. Click for a new checkout instead.',
    });
    expect(worktreePillWords({ worktree: 'termag-22', target: 'termag-22', of: 'termag', fetchedFrom: null }).sub).toContain("from termag-22's checkout");
    expect(worktreePillWords({ worktree: 'webapp', target: 'webapp', of: 'webapp', fetchedFrom: null }).lead).toBe('A worktree of webapp');
    expect(worktreePillWords({ worktree: null, target: 'termag-22', of: 'termag', fetchedFrom: null })).toEqual({
      label: 'New checkout',
      lead: 'A new checkout of termag',
      sub: 'A fresh clone, as a checkout of its own. Click to make it a worktree of termag-22 instead.',
    });
  });
});

describe("a worktree session's permission words (chat-session-permissions-enabled)", () => {
  const w = { checkout: 'termag-22', project: 'termag', trusted: true, fetched: false };

  it('names the setting and the checkout, never just "As <checkout>"', () => {
    expect(followsWords(w).label).toBe('Full access · from termag-22');
    expect(followsWords({ ...w, trusted: false }).label).toBe('Read only · from termag-22');
  });

  it('names the checkout with its project, so it never reads as the box', () => {
    expect(followsWords(w).sub).toBe("A worktree runs with its checkout's permissions: termag-22, your checkout of termag, is trusted, so this session runs commands and edits files without asking.");
    expect(followsWords({ ...w, trusted: false }).sub).toBe("A worktree runs with its checkout's permissions, and termag-22, your checkout of termag, isn't trusted. Trust termag-22 from the session to run commands.");
    expect(followsWords({ ...w, trusted: false, fetched: true }).sub).toContain('Freshly fetched code stays read only, even if termag-22 is trusted later.');
    // A checkout named as its project, or outside projects, says its name once.
    expect(followsWords({ ...w, project: 'termag-22' }).sub).toMatch(/permissions: termag-22 is trusted/);
    expect(followsWords({ ...w, project: null, trusted: false }).sub).toMatch(/and termag-22 isn't trusted/);
  });
});
