import { afterEach, describe, it, expect } from 'vitest';
import { installedAppMode, installedOnTouch, isAppleMobile, isStandalone, setInstalledAppEnabled, mobileHrefFromWorkspaceSearch, readOptOut, shouldRedirectToMobile, writeOptOut, MOBILE_OPT_OUT_KEY } from './redirect';

describe('shouldRedirectToMobile', () => {
  it('needs the flag, a phone-like viewport and no opt-out', () => {
    expect(shouldRedirectToMobile({ flagOn: true, phoneLike: true, optedOut: false })).toBe(true);
    expect(shouldRedirectToMobile({ flagOn: false, phoneLike: true, optedOut: false })).toBe(false);
    expect(shouldRedirectToMobile({ flagOn: true, phoneLike: false, optedOut: false })).toBe(false);
    expect(shouldRedirectToMobile({ flagOn: true, phoneLike: true, optedOut: true })).toBe(false);
  });

  it('always redirects an app installed on a touch device, unless this window opted out', () => {
    expect(shouldRedirectToMobile({ flagOn: false, phoneLike: false, optedOut: false, installed: true })).toBe(true);
    expect(shouldRedirectToMobile({ flagOn: false, phoneLike: true, optedOut: true, installed: true })).toBe(false);
    expect(shouldRedirectToMobile({ flagOn: false, phoneLike: true, optedOut: false, installed: false })).toBe(false);
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
  afterEach(() => setInstalledAppEnabled(false));

  it('applies the installed-app rules only with mobile-installed-app-enabled on', () => {
    setInstalledAppEnabled(false);
    expect(installedOnTouch(installedPhone)).toBe(true);
    expect(installedAppMode(installedPhone)).toBe(false);
    setInstalledAppEnabled(true);
    expect(installedAppMode(installedPhone)).toBe(true);
    expect(installedAppMode({ matchMedia: () => ({ matches: false }) })).toBe(false);
  });
});
