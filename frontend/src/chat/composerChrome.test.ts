import { beforeEach, describe, expect, it } from 'vitest';
import { chromeFromHistory, composerChrome, forgetChrome, noChrome, rememberChrome, rememberedChrome, updateRememberedChrome } from './composerChrome';

const untrusted = chromeFromHistory({ trust: { trusted: false, reason: null, mode: 'default' }, canTrust: true, imageInput: true, model: 'opus' });

beforeEach(() => forgetChrome());

describe('composerChrome', () => {
  it('reserves on a first open while loading, and only then', () => {
    expect(composerChrome({ live: null, remembered: null, loading: true })).toEqual({ chrome: noChrome, reserve: true });
    expect(composerChrome({ live: null, remembered: null, loading: false }).reserve).toBe(false);
    expect(composerChrome({ live: untrusted, remembered: null, loading: true }).reserve).toBe(false);
  });

  it('draws what was kept until the answer, then the answer', () => {
    const answered = { ...untrusted, imageInput: false };
    expect(composerChrome({ live: null, remembered: untrusted, loading: true })).toEqual({ chrome: untrusted, reserve: false });
    expect(composerChrome({ live: answered, remembered: untrusted, loading: false }).chrome).toBe(answered);
  });
});

describe('rememberChrome', () => {
  it('keeps each chat apart, and updates only a chat it kept', () => {
    rememberChrome('p1|main', untrusted);
    expect(rememberedChrome('p1|main')).toBe(untrusted);
    expect(rememberedChrome('p1|other')).toBeNull();
    updateRememberedChrome('p1|main', { trust: { trusted: true, reason: 'trusted' } as never });
    expect(rememberedChrome('p1|main')?.trust?.trusted).toBe(true);
    updateRememberedChrome('p2|main', { canTrust: true });
    expect(rememberedChrome('p2|main')).toBeNull();
  });

  it('reads a history answer as the composer does (no model is Sonnet)', () => {
    expect(chromeFromHistory({})).toEqual({ ...noChrome, model: 'sonnet' });
    expect(untrusted).toMatchObject({ canTrust: true, imageInput: true, effortInput: false, model: 'opus' });
    expect(chromeFromHistory({ imageInput: false, pdfInput: true }).pdfInput).toBe(false);
    expect(chromeFromHistory({ imageInput: true, pdfInput: true }).pdfInput).toBe(true);
  });
});
