import { describe, it, expect } from 'vitest';
import { installedAppMode, installedOnTouch, isAppleMobile, isStandalone, mobileHrefFromWorkspaceSearch, phoneChatSession, phoneLandingHref, readOptOut, shouldRedirectToMobile, writeOptOut, MOBILE_OPT_OUT_KEY } from './redirect';

describe('shouldRedirectToMobile', () => {
  it('needs a phone-like viewport and no opt-out', () => {
    expect(shouldRedirectToMobile({ phoneLike: true, optedOut: false })).toBe(true);
    expect(shouldRedirectToMobile({ phoneLike: false, optedOut: false })).toBe(false);
    expect(shouldRedirectToMobile({ phoneLike: true, optedOut: true })).toBe(false);
  });

  it('always redirects an app installed on a touch device, unless this window opted out', () => {
    expect(shouldRedirectToMobile({ phoneLike: false, optedOut: false, installed: true })).toBe(true);
    expect(shouldRedirectToMobile({ phoneLike: true, optedOut: true, installed: true })).toBe(false);
    expect(shouldRedirectToMobile({ phoneLike: false, optedOut: false, installed: false })).toBe(false);
  });
});

function env(queries: Record<string, boolean>, standalone?: boolean) {
  return { matchMedia: (q: string) => ({ matches: !!queries[q] }), navigator: { standalone } };
}

describe('isStandalone / installedOnTouch', () => {
  it('reads display-mode, and iOS navigator.standalone', () => {
    expect(isStandalone(undefined)).toBe(false);
    expect(isStandalone(env({}))).toBe(false);
    expect(isStandalone(env({ '(display-mode: standalone)': true }))).toBe(true);
    expect(isStandalone(env({ '(display-mode: fullscreen)': true }))).toBe(true);
    expect(isStandalone(env({}, true))).toBe(true);
  });

  it('only counts a touch device: a desktop install keeps the workspace', () => {
    expect(installedOnTouch(env({ '(display-mode: standalone)': true }))).toBe(false);
    expect(installedOnTouch(env({ '(display-mode: standalone)': true, '(pointer: coarse)': true }))).toBe(true);
    expect(installedOnTouch(env({ '(pointer: coarse)': true }))).toBe(false);
  });

  it('tolerates a throwing matchMedia', () => {
    const broken = { matchMedia: () => { throw new Error('no'); } };
    expect(isStandalone(broken)).toBe(false);
    expect(installedOnTouch(broken)).toBe(false);
  });
});

describe('mobileHrefFromWorkspaceSearch', () => {
  it('maps the workspace deep link onto the conversation route', () => {
    expect(mobileHrefFromWorkspaceSearch('')).toBe('/m');
    expect(mobileHrefFromWorkspaceSearch('?project=abc')).toBe('/m/p/abc');
    expect(mobileHrefFromWorkspaceSearch('?project=abc&ws=main')).toBe('/m/p/abc');
    expect(mobileHrefFromWorkspaceSearch('?project=abc&ws=feat-64')).toBe('/m/p/abc?ws=feat-64');
  });
});

describe('phoneLandingHref', () => {
  const on = (search: string, hasChat = false) => phoneLandingHref({ search, phoneChat: true, hasChat });
  const off = (search: string, hasChat = false) => phoneLandingHref({ search, phoneChat: false, hasChat });

  it('flag on: the workspace URL opens the chat', () => {
    expect(on('')).toBe('/chat');
    expect(on('?')).toBe('/chat');
    expect(on('?iss=https%3A%2F%2Fexample.okta.com')).toBe('/chat');
  });

  it('flag on: a link to a session the chat can show opens its chat', () => {
    expect(on('?project=abc', true)).toBe('/chat/p/abc');
    expect(on('?project=abc&ws=main', true)).toBe('/chat/p/abc');
    expect(on('?project=abc&ws=fix-64', true)).toBe('/chat/p/abc?ws=fix-64');
    expect(on('?project=a%2Fb&ws=x%20y', true)).toBe('/chat/p/a%2Fb?ws=x%20y');
  });

  it('flag on: a link to a session the chat cannot show (MetaTerm, an automation\'s main, unlisted, a failed read) stays on /m', () => {
    expect(on('?project=abc', false)).toBe('/m/p/abc');
    expect(on('?project=abc&ws=fix-64', false)).toBe('/m/p/abc?ws=fix-64');
  });

  it('flag on: a link that opens Lab on purpose, or carries what the chat has no equivalent for, stays on /m', () => {
    expect(on('?project=abc&lab=1', true)).toBe('/m/p/abc');
    expect(on('?lab=1', true)).toBe('/m');
    expect(on('?prs=needs_you', true)).toBe('/m');
    expect(on('?ws=x', true)).toBe('/m');
    expect(on('?project=abc&ws=x&branchOff=1', true)).toBe('/m/p/abc?ws=x');
    expect(on('?project=abc&ws=x&browser=open&browserShare=s1', true)).toBe('/m/p/abc?ws=x');
  });

  it('flag off: every landing is today\'s /m route', () => {
    expect(off('')).toBe('/m');
    expect(off('?project=abc', true)).toBe('/m/p/abc');
    expect(off('?project=abc&ws=fix-64', true)).toBe('/m/p/abc?ws=fix-64');
    expect(off('?project=abc&lab=1', true)).toBe('/m/p/abc');
  });
});

describe('phoneChatSession', () => {
  it('names the session of a plain link to one', () => {
    expect(phoneChatSession('?project=abc')).toEqual({ projectId: 'abc', workstream: 'main' });
    expect(phoneChatSession('?project=abc&ws=fix-64')).toEqual({ projectId: 'abc', workstream: 'fix-64' });
    expect(phoneChatSession('?project=abc&iss=https%3A%2F%2Fexample.okta.com')).toEqual({ projectId: 'abc', workstream: 'main' });
  });

  it('is null for the workspace URL, a Lab-on-purpose link and other parameters', () => {
    expect(phoneChatSession('')).toBeNull();
    expect(phoneChatSession('?ws=x')).toBeNull();
    expect(phoneChatSession('?project=abc&lab=1')).toBeNull();
    expect(phoneChatSession('?project=abc&branchOff=1')).toBeNull();
  });
});

describe('opt-out storage', () => {
  it('round-trips through a Storage-like object and tolerates failures', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
    expect(readOptOut(storage)).toBe(false);
    writeOptOut(storage, true);
    expect(store.get(MOBILE_OPT_OUT_KEY)).toBe('1');
    expect(readOptOut(storage)).toBe(true);
    writeOptOut(storage, false);
    expect(readOptOut(storage)).toBe(false);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
    expect(readOptOut(broken)).toBe(false);
    expect(() => writeOptOut(broken, true)).not.toThrow();
  });
});

describe('isAppleMobile', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1';
  const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
  it('spots iPhones and iPads, including an iPad that claims to be a Mac', () => {
    expect(isAppleMobile(IPHONE, 5)).toBe(true);
    expect(isAppleMobile(IPAD_DESKTOP, 5)).toBe(true);
    expect(isAppleMobile(IPAD_DESKTOP, 0)).toBe(false);
    expect(isAppleMobile(ANDROID, 5)).toBe(false);
  });
});

describe('installedAppMode', () => {
  const installedPhone = {
    matchMedia: (q: string) => ({ matches: q === '(display-mode: standalone)' || q === '(pointer: coarse)' }),
  };
  it('applies the installed-app rules to an app installed on a touch device', () => {
    expect(installedAppMode(installedPhone)).toBe(true);
    expect(installedAppMode({ matchMedia: () => ({ matches: false }) })).toBe(false);
  });
});
