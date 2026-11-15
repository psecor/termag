// The redesigned sidebar's keys (chat/listKeys.ts).
import { describe, expect, it } from 'vitest';
import { listKeyAction, moveTo } from './listKeys';

describe('listKeyAction', () => {
  it('maps j/k and the arrows to moves, e to archive and p to pin', () => {
    expect(['j', 'ArrowDown', 'k', 'ArrowUp', 'e', 'p'].map(key => listKeyAction({ key }))).toEqual(['next', 'next', 'prev', 'prev', 'archive', 'pin']);
  });

  it('leaves everything typed into a field, or with a modifier, alone', () => {
    expect(listKeyAction({ key: 'e', typing: true })).toBeNull();
    expect(listKeyAction({ key: 'j', metaKey: true })).toBeNull();
    expect(listKeyAction({ key: 'p', ctrlKey: true })).toBeNull();
    expect(listKeyAction({ key: 'k', altKey: true })).toBeNull();
    expect(listKeyAction({ key: 'E', shiftKey: true })).toBeNull();
    expect(listKeyAction({ key: 'Enter' })).toBeNull();
  });

  it('takes a letter with Caps Lock on (a capital with no Shift), but not with Shift', () => {
    expect(listKeyAction({ key: 'E' })).toBe('archive');
    expect(listKeyAction({ key: 'J' })).toBe('next');
    expect(listKeyAction({ key: 'E', shiftKey: true })).toBeNull();
  });

  it('moves while a key is held, but archives and pins once per press', () => {
    expect(listKeyAction({ key: 'j', repeat: true })).toBe('next');
    expect(listKeyAction({ key: 'e', repeat: true })).toBeNull();
    expect(listKeyAction({ key: 'p', repeat: true })).toBeNull();
  });
});

describe('moveTo', () => {
  it('moves one card, stopping at the ends, and starts at the first (j) or the last (k)', () => {
    expect(moveTo(0, 3, 'next')).toBe(1);
    expect(moveTo(2, 3, 'next')).toBe(2);
    expect(moveTo(0, 3, 'prev')).toBe(0);
    expect(moveTo(-1, 3, 'next')).toBe(0);
    expect(moveTo(-1, 3, 'prev')).toBe(2);
    expect(moveTo(-1, 0, 'next')).toBeNull();
  });
});
