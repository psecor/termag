import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SHARE_ROLE, initials, SHARE_ROLES, shareAbilities, spaceShareActions, spaceShareLink } from './spaceShare';

describe('shareAbilities', () => {
  it('lets an owner add people, manage and add boxes', () => {
    expect(shareAbilities('owner', false)).toEqual({ addPeople: 'yes', manage: true, addBoxes: true });
  });

  it('lets an editor add their boxes and nothing else, a viewer nothing', () => {
    expect(shareAbilities('editor', false)).toEqual({ addPeople: 'not_owner', manage: false, addBoxes: true });
    expect(shareAbilities('viewer', false)).toEqual({ addPeople: 'not_owner', manage: false, addBoxes: false });
    expect(shareAbilities(undefined, false)).toEqual({ addPeople: 'not_owner', manage: false, addBoxes: false });
  });

  it('lets no one change a read-only space', () => {
    expect(shareAbilities('owner', true)).toEqual({ addPeople: 'not_owner', manage: false, addBoxes: false });
  });
});

describe('the role picker', () => {
  it('starts on Can edit, first in the list', () => {
    expect(DEFAULT_SHARE_ROLE).toBe('editor');
    expect(SHARE_ROLES[0]).toBe('editor');
  });
});

describe('spaceShareLink', () => {
  it('is the space\'s simple-UI page under the base, its name encoded', () => {
    expect(spaceShareLink('https://t.example', '/termag/', 'improve-termag')).toBe('https://t.example/termag/chat/files/improve-termag');
    expect(spaceShareLink('https://t.example', '/', 'a b')).toBe('https://t.example/chat/files/a%20b');
  });
});

describe('initials', () => {
  it('takes two words of a name, else of an email\'s local part', () => {
    expect(initials('Priya Natarajan')).toBe('PN');
    expect(initials('jordan.lee@example.com')).toBe('JL');
    expect(initials('sam@example.com')).toBe('S');
    expect(initials('')).toBe('?');
  });
});

describe('spaceShareActions: the space menu\'s Share space (item 3 of the head\'s ⋮)', () => {
  it('is one item, Share space, with a line under it like New agent\'s and New tab\'s', () => {
    const open = vi.fn();
    const items = spaceShareActions('notes', open);
    expect(items.map(a => [a.label, a.hint, Boolean(a.disabled)])).toEqual([['Share space', 'People and boxes with access to notes', false]]);
    items[0].onSelect();
    expect(open).toHaveBeenCalledWith('notes');
  });

  it('is nothing for "No space"', () => {
    expect(spaceShareActions(null, vi.fn())).toEqual([]);
  });
});
