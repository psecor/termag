import { describe, expect, it } from 'vitest';
import { dropLoginParamsFromAddressBar, LAB_PARAM, notePageLocation, pageEntry, readUiMode, routerEntry, shouldOpenSimpleUi, simpleUiDeepLink, simpleUiShareHandoff, UI_MODE_KEY, withoutLoginParams, writeUiMode } from './uiMode';

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

  it('leaves out what an Okta app tile adds, so its landing is the bare workspace URL', () => {
    const okta = '?iss=https%3A%2F%2Fexample.okta.com';
    expect(routerEntry({ pathname: '/termag/', search: okta })).toBe('/');
    expect(routerEntry({ pathname: '/termag', search: okta })).toBe('/');
    expect(routerEntry({ pathname: '/termag/', search: `${okta}&project=p1` })).toBe('/?project=p1');
  });
});

describe('withoutLoginParams', () => {
  it('drops the third-party-initiated login parameters and keeps the rest', () => {
    expect(withoutLoginParams('')).toBe('');
    expect(withoutLoginParams('?')).toBe('');
    expect(withoutLoginParams('?iss=https%3A%2F%2Fexample.okta.com')).toBe('');
    expect(withoutLoginParams('?iss=x&login_hint=a%40b.c&target_link_uri=https%3A%2F%2Fh%2Ftermag%2F')).toBe('');
    expect(withoutLoginParams('?iss=x&project=p1&ws=main')).toBe('?project=p1&ws=main');
  });

  it('returns a query with none of them unchanged, encoding and all', () => {
    expect(withoutLoginParams('?project=p1')).toBe('?project=p1');
    expect(withoutLoginParams('?browserAt=%2Fprojects%2Fx%3Fenv%3Dprod')).toBe('?browserAt=%2Fprojects%2Fx%3Fenv%3Dprod');
  });
});

describe('dropLoginParamsFromAddressBar', () => {
  function page(search: string, state: unknown = null) {
    const calls: Array<[unknown, string]> = [];
    const win = {
      location: { pathname: '/termag/', search, hash: '' },
      history: { state, replaceState: (s: unknown, _t: string, url: string) => { calls.push([s, url]); } },
    } as unknown as Pick<Window, 'location' | 'history'>;
    return { win, calls };
  }

  it('rewrites an Okta landing to the bare workspace URL, keeping the history state', () => {
    const { win, calls } = page('?iss=https%3A%2F%2Fexample.okta.com');
    dropLoginParamsFromAddressBar(win);
    expect(calls).toEqual([[null, '/termag/']]);
    const deep = page('?iss=x&project=p1', { key: 'default' });
    dropLoginParamsFromAddressBar(deep.win);
    expect(deep.calls).toEqual([[{ key: 'default' }, '/termag/?project=p1']]);
  });

  it('leaves every other URL alone', () => {
    const { win, calls } = page('?project=p1');
    dropLoginParamsFromAddressBar(win);
    expect(calls).toEqual([]);
  });
});

const base = { mode: 'simple' as const, entry: '/', here: '/', locationKey: 'default' };

describe('shouldOpenSimpleUi', () => {

  it('opens /chat for a page loaded at the bare workspace URL after the simple UI was last used', () => {
    expect(shouldOpenSimpleUi(base)).toBe(true);
  });

  it('keeps the workspace when the full UI was last used or the flag is off', () => {
    expect(shouldOpenSimpleUi({ ...base, mode: 'full' })).toBe(false);
  });

  it('opens /chat for the Okta app tile\'s landing, /?iss=…', () => {
    // The page entry already leaves the parameter out (routerEntry); the router
    // location may still carry it if the address bar could not be rewritten.
    expect(shouldOpenSimpleUi({ ...base, here: '/?iss=https%3A%2F%2Fexample.okta.com' })).toBe(true);
    expect(shouldOpenSimpleUi({ ...base, mode: 'full', here: '/?iss=https%3A%2F%2Fexample.okta.com' })).toBe(false);
    expect(shouldOpenSimpleUi({ ...base, entry: '/?project=p1', here: '/?iss=x&project=p1' })).toBe(false);
  });

  it('keeps deep links into the workspace', () => {
    expect(shouldOpenSimpleUi({ ...base, entry: '/?project=p1', here: '/?project=p1' })).toBe(false);
    expect(shouldOpenSimpleUi({ ...base, entry: '/settings', here: '/settings' })).toBe(false);
  });

  it('never redirects in-app navigation to / (Lab, the back button)', () => {
    // The page was loaded at /chat and the user followed Lab.
    expect(shouldOpenSimpleUi({ ...base, entry: '/chat' })).toBe(false);
    // The workspace was already shown once in this page.
    expect(shouldOpenSimpleUi({ ...base, entry: null })).toBe(false);
  });

  it('never redirects a / the router navigated to, even before the workspace mounted', () => {
    // Loaded at / on a phone: the mobile redirect sent it to /m first, then
    // the inbox's Lab pushed / again. The entry is still /, the key is not.
    expect(shouldOpenSimpleUi({ ...base, locationKey: 'k3x9q2' })).toBe(false);
  });
});

describe('simpleUiShareHandoff', () => {
  const on = { mode: 'simple' as const };
  const link = '?project=p1&ws=feature-x&browser=open&browserShare=cshare0000000001&browserAt=%2Fprojects%2Fx%3Fenv%3Dprod';

  it('takes a share link its owner opened to the chat, with the handoff for its side panel', () => {
    expect(simpleUiShareHandoff({ ...on, search: link }))
      .toBe('/chat/p/p1?ws=feature-x&browser=open&browserShare=cshare0000000001&browserAt=%2Fprojects%2Fx%3Fenv%3Dprod');
    expect(simpleUiShareHandoff({ ...on, search: '?project=p%2F1&browser=open' })).toBe('/chat/p/p%2F1?ws=main&browser=open');
    // An environment's port link (browserPortHref) carries the page to open.
    expect(simpleUiShareHandoff({ ...on, search: '?project=p1&ws=main&browser=open&browserUrl=http%3A%2F%2Flocalhost%3A5174%2F' }))
      .toBe('/chat/p/p1?ws=main&browser=open&browserUrl=http%3A%2F%2Flocalhost%3A5174%2F');
  });

  it('leaves it to the workspace when the full UI was last, or either flag is off', () => {
    expect(simpleUiShareHandoff({ ...on, mode: 'full', search: link })).toBeNull();
  });

  it('leaves every other workspace URL alone', () => {
    expect(simpleUiShareHandoff({ ...on, search: '' })).toBeNull();
    expect(simpleUiShareHandoff({ ...on, search: '?project=p1&ws=feature-x' })).toBeNull();
    expect(simpleUiShareHandoff({ ...on, search: '?browser=open&browserShare=cshare0000000001' })).toBeNull();
  });
});

describe('simpleUiDeepLink', () => {
  const loaded = (here: string) => ({ ...base, entry: here, here });

  it('opens the chat of the session a Lab link names, for a page loaded there by a chat person', () => {
    expect(simpleUiDeepLink(loaded('/?project=p1'))?.href).toBe('/chat/p/p1');
    expect(simpleUiDeepLink(loaded('/?project=p1&ws=feat'))).toEqual({ projectId: 'p1', workstream: 'feat', href: '/chat/p/p1?ws=feat' });
    expect(simpleUiDeepLink(loaded('/?project=p1&ws=main'))?.href).toBe('/chat/p/p1');
    expect(simpleUiDeepLink(loaded('/?project=p1&ws=fix-the-flag'))?.href).toBe('/chat/p/p1?ws=fix-the-flag');
    expect(simpleUiDeepLink(loaded('/?ws=a%20b&project=p%2F1'))?.href).toBe('/chat/p/p%2F1?ws=a%20b');
  });

  it('does so for an Okta tile\'s deep link too, the router location still carrying ?iss=', () => {
    expect(simpleUiDeepLink({ ...base, entry: '/?project=p1', here: '/?iss=x&project=p1' })?.href).toBe('/chat/p/p1');
  });

  it('keeps Lab when Lab is the person\'s choice', () => {
    expect(simpleUiDeepLink({ ...loaded('/?project=p1'), mode: 'full' })).toBeNull();
  });

  it('keeps Lab for a link with no chat equivalent', () => {
    expect(simpleUiDeepLink(loaded('/'))).toBeNull();
    expect(simpleUiDeepLink(loaded('/?ws=feat'))).toBeNull();
    expect(simpleUiDeepLink(loaded('/?project='))).toBeNull();
    expect(simpleUiDeepLink(loaded('/?project=p1&branchOff=1'))).toBeNull();
    expect(simpleUiDeepLink(loaded('/settings?project=p1'))).toBeNull();
    expect(simpleUiDeepLink(loaded('/automations/p1'))).toBeNull();
  });

  it('keeps Lab for a link that opens it on purpose (Open in Lab)', () => {
    expect(simpleUiDeepLink(loaded(`/?project=p1&ws=feat&${LAB_PARAM}=1`))).toBeNull();
  });

  it('never redirects in-app navigation to a session in Lab', () => {
    // The page was loaded at /chat, and the chat's Open in Lab navigated here.
    expect(simpleUiDeepLink({ ...base, entry: '/chat', here: '/?project=p1' })).toBeNull();
    expect(simpleUiDeepLink({ ...base, entry: null, here: '/?project=p1' })).toBeNull();
    expect(simpleUiDeepLink({ ...loaded('/?project=p1'), locationKey: 'k3x9q2' })).toBeNull();
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
