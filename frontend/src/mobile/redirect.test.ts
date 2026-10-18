import { describe, it, expect } from 'vitest';
import { mobileHrefFromWorkspaceSearch, readOptOut, shouldRedirectToMobile, writeOptOut, MOBILE_OPT_OUT_KEY } from './redirect';

describe('shouldRedirectToMobile', () => {
  it('needs the flag, a phone-like viewport and no opt-out', () => {
    expect(shouldRedirectToMobile({ flagOn: true, phoneLike: true, optedOut: false })).toBe(true);
    expect(shouldRedirectToMobile({ flagOn: false, phoneLike: true, optedOut: false })).toBe(false);
    expect(shouldRedirectToMobile({ flagOn: true, phoneLike: false, optedOut: false })).toBe(false);
    expect(shouldRedirectToMobile({ flagOn: true, phoneLike: true, optedOut: true })).toBe(false);
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
