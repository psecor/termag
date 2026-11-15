// A session card's Archive (chat/cardActions.ts).
import { describe, expect, it } from 'vitest';
import { archiveConfirm, archivedBox, archiveToast, archiveWay, liveSiblings, reopenSettling, sessionLink, sessionMenuItems, toastTitle, unreadWhy } from './cardActions';

const row = (over: Partial<Parameters<typeof archiveWay>[0]> = {}) => ({
  shared: false, kind: 'normal' as const, workstream: 'main', workstreamId: 'w-main', ...over,
});

describe('archiveWay', () => {
  it("uses the chat archive only for a checkout's last live session, run by the chat runner", () => {
    expect(archiveWay(row(), { chatRunner: true, liveSiblings: 0 })).toBe('chat');
    // A main beside live worktrees: the chat archive would take them too.
    expect(archiveWay(row(), { chatRunner: true, liveSiblings: 2 })).toBe('session');
    // Lab's main: the chat archive isn't its.
    expect(archiveWay(row(), { chatRunner: false, liveSiblings: 0 })).toBe('session');
  });

  it('has nothing to archive on a main not yet saved, which the chat archive would take whole', () => {
    expect(archiveWay(row({ workstreamId: null }), { chatRunner: true, liveSiblings: 0 })).toBeNull();
  });

  it('marks any other session of the person own', () => {
    expect(archiveWay(row({ workstream: 'cmdk-phone', workstreamId: 'w-1' }), { chatRunner: true, liveSiblings: 0 })).toBe('session');
  });

  it("archives nothing that isn't theirs or has no session row yet", () => {
    expect(archiveWay(row({ shared: true }), { chatRunner: true, liveSiblings: 0 })).toBeNull();
    expect(archiveWay(row({ kind: 'automation' }), { chatRunner: true, liveSiblings: 0 })).toBeNull();
    expect(archiveWay(row({ kind: 'cloud' }), { chatRunner: true, liveSiblings: 0 })).toBeNull();
    expect(archiveWay(row({ workstream: 'cmdk', workstreamId: null }), { chatRunner: true, liveSiblings: 0 })).toBeNull();
  });
});

describe('liveSiblings', () => {
  it("counts the checkout's other sessions still in the list, one marked archived but still working included", () => {
    // The sidebar's rows, Archived's taken out: p|b is marked archived but works, so it's listed and counts.
    const listed = [{ projectId: 'p', key: 'p|main' }, { projectId: 'p', key: 'p|b' }, { projectId: 'q', key: 'q|main' }];
    expect(liveSiblings(listed[0], listed)).toBe(1);
    expect(liveSiblings(listed[2], listed)).toBe(0);
  });
});

describe('reopenSettling', () => {
  it("is a reopen refused while the box is still on its way down or up, which Undo asks again", () => {
    const refused = (error: string, status = 409) => ({ response: { status, data: { error } } });
    expect(reopenSettling(refused('The box is still stopping. Reopen the chat once it has.'))).toBe(true);
    expect(reopenSettling(refused('The box is still starting. Reopen the chat once it has.'))).toBe(true);
    expect(reopenSettling(refused("This chat's box is gone, and its history with it. Delete the chat instead."))).toBe(false);
    expect(reopenSettling(refused('The box is still stopping.', 500))).toBe(false);
    expect(reopenSettling(new Error('network'))).toBe(false);
  });
});

describe("Archive's words", () => {
  it('names what was archived, and what its box did', () => {
    expect(archiveToast('Deploy check for #1735')).toEqual({ title: 'Archived “Deploy check for #1735”', status: 'info' });
    expect(archiveToast('Aurora', { stopping: 'demo-box' })).toEqual({
      title: 'Archived “Aurora”', description: 'demo-box is stopping: nothing else runs on it.', status: 'info',
    });
    expect(archiveToast('Aurora', { failed: 'EC2 refused the stop' })).toMatchObject({ description: 'Its box is still running: EC2 refused the stop', status: 'error' });
  });

  it("reads the archive's answer: a stop under way, one that failed, or none", () => {
    expect(archivedBox({ action: 'stop', status: 'stopping' }, 'demo-box')).toEqual({ stopping: 'demo-box' });
    expect(archivedBox({ action: 'stop', error: 'EC2 refused the stop' }, 'demo-box')).toEqual({ failed: 'EC2 refused the stop' });
    expect(archivedBox({ action: null }, null)).toBeNull();
    // A stop the dry run couldn't name (it wasn't read) still says the box is stopping.
    expect(archivedBox({ action: 'stop', status: 'stopping' }, null)).toEqual({ stopping: null });
    expect(archiveToast('Aurora', { stopping: null }).description).toBe('Its box is stopping: nothing else runs on it.');
    expect(archivedBox(undefined, null)).toBeNull();
  });

  it('keeps a long title to one line', () => {
    expect(toastTitle('x'.repeat(60))).toBe(`${'x'.repeat(47)}…`);
    expect(toastTitle('  short  ')).toBe('short');
  });

  it("asks too when the dry run couldn't be read, since the box may stop", () => {
    expect(archiveConfirm('Aurora', null)).toMatchObject({ heading: 'Archive it?', confirm: 'Archive' });
    expect(archiveConfirm('Aurora', null).body).toContain('If nothing does, archiving it stops the box');
  });

  it('asks first in words that say the box stops, and that Undo brings it back', () => {
    expect(archiveConfirm('Aurora vs RDS', 'demo-box')).toEqual({
      heading: 'Archive and stop its box?',
      body: '“Aurora vs RDS” is the only thing on its box, demo-box, so archiving it stops the box. Undo, or Reopen from Archived, starts it again.',
      confirm: 'Archive and stop the box',
    });
  });
});

describe("a card's session menu", () => {
  it('is about the session, in order: Rename, Pin, Mark as unread, Copy link, Open in termag desktop, Archive', () => {
    expect(sessionMenuItems({ canRename: true, pinned: false, unread: 'unread', desktop: true, archive: true }).map(i => i.label))
      .toEqual(['Rename…', 'Pin to top', 'Mark as unread', 'Copy link', 'Open in termag desktop', 'Archive']);
  });

  it('offers only what applies, and says why it cannot be unread yet', () => {
    const items = sessionMenuItems({ canRename: false, pinned: null, unread: { why: unreadWhy('working') }, desktop: false, archive: false });
    expect(items.map(i => i.label)).toEqual(['Mark as unread', 'Copy link']);
    expect(items[0]).toMatchObject({ disabled: true, hint: 'Once it has finished its turn' });
    expect(sessionMenuItems({ canRename: true, pinned: true, unread: 'read', desktop: false, archive: false }).map(i => i.label))
      .toEqual(['Rename…', 'Unpin', 'Mark as read', 'Copy link']);
    expect(unreadWhy('off')).toBe('Only one that stopped in the last 8 hours');
    // An automation's run is never unread, so the item isn't there at all.
    expect(sessionMenuItems({ canRename: true, pinned: null, unread: null, desktop: false, archive: false }).map(i => i.label)).toEqual(['Rename…', 'Copy link']);
  });

  it('copies a link with the page origin and termag base path', () => {
    expect(sessionLink('https://app.example', '/termag/', '/chat/p/x?ws=y')).toBe('https://app.example/termag/chat/p/x?ws=y');
  });
});
