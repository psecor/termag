import { describe, expect, it } from 'vitest';
import { notePageLocation, pageEntry, readUiMode, routerEntry, shouldOpenSimpleUi, UI_MODE_KEY, writeUiMode } from './uiMode';

function memory(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: k => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, v); },
    removeItem: k => { m.delete(k); },
    clear: () => m.clear(),
    key: i => [...m.keys()][i] ?? null,
    get length() { return m.size; },
  };
}

describe('readUiMode / writeUiMode', () => {
  it('is the full UI until the simple one is recorded, and remembers the last one', () => {
    const s = memory();
    expect(readUiMode(s)).toBe('full');
    writeUiMode(s, 'simple');
    expect(s.getItem(UI_MODE_KEY)).toBe('simple');
    expect(readUiMode(s)).toBe('simple');
    writeUiMode(s, 'full');
    expect(readUiMode(s)).toBe('full');
  });

  it('reads anything else, no storage, or a throwing storage as the full UI', () => {
    expect(readUiMode(null)).toBe('full');
    expect(readUiMode({ getItem: () => 'weird' })).toBe('full');
    expect(readUiMode({ getItem: () => { throw new Error('denied'); } })).toBe('full');
    expect(() => writeUiMode({ setItem: () => { throw new Error('quota'); } }, 'simple')).not.toThrow();
  });
});

describe('routerEntry', () => {
  it('strips the /termag basename and keeps the query', () => {
    expect(routerEntry({ pathname: '/termag/', search: '' })).toBe('/');
    expect(routerEntry({ pathname: '/termag', search: '' })).toBe('/');
    expect(routerEntry({ pathname: '/termag/', search: '?project=p1' })).toBe('/?project=p1');
    expect(routerEntry({ pathname: '/termag/chat', search: '' })).toBe('/chat');
    expect(routerEntry({ pathname: '/termagic/', search: '?' })).toBe('/termagic/');
  });
});

const base = { flagOn: true, mode: 'simple' as const, entry: '/', here: '/', locationKey: 'default' };

describe('shouldOpenSimpleUi', () => {

  it('opens /chat for a page loaded at the bare workspace URL after the simple UI was last used', () => {
    expect(shouldOpenSimpleUi(base)).toBe(true);
  });

  it('keeps the workspace when the full UI was last used or the flag is off', () => {
    expect(shouldOpenSimpleUi({ ...base, mode: 'full' })).toBe(false);
    expect(shouldOpenSimpleUi({ ...base, flagOn: false })).toBe(false);
  });

  it('keeps deep links into the workspace', () => {
    expect(shouldOpenSimpleUi({ ...base, entry: '/?project=p1', here: '/?project=p1' })).toBe(false);
    expect(shouldOpenSimpleUi({ ...base, entry: '/settings', here: '/settings' })).toBe(false);
  });

  it('never redirects in-app navigation to / (Full UI, the back button)', () => {
    // The page was loaded at /chat and the user followed Full UI.
    expect(shouldOpenSimpleUi({ ...base, entry: '/chat' })).toBe(false);
    // The workspace was already shown once in this page.
    expect(shouldOpenSimpleUi({ ...base, entry: null })).toBe(false);
  });

  it('never redirects a / the router navigated to, even before the workspace mounted', () => {
    // Loaded at / on a phone: the mobile redirect sent it to /m first, then
    // the inbox's Full UI pushed / again. The entry is still /, the key is not.
    expect(shouldOpenSimpleUi({ ...base, locationKey: 'k3x9q2' })).toBe(false);
  });
});

describe('notePageLocation', () => {
  it('keeps the entry on the location the page was loaded at', () => {
    const before = pageEntry();
    notePageLocation('default');
    expect(pageEntry()).toBe(before);
  });

  it('forgets the entry once the router has navigated, so going back to / is in-app', () => {
    notePageLocation('k3x9q2');
    expect(pageEntry()).toBeNull();
    // Back to the first history entry: its key is `default` again, but the
    // page has navigated, so it stays the workspace.
    expect(shouldOpenSimpleUi({ ...base, entry: pageEntry() })).toBe(false);
  });
});
