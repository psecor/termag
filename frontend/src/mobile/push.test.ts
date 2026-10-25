import { afterEach, describe, expect, it, vi } from 'vitest';
import { routerPathFor, pushSupport, staleNotificationTags, subscriptionBody, urlBase64ToUint8Array, withTimeout } from './push';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

const full = { hasServiceWorker: true, hasPushManager: true, hasNotification: true };

describe('pushSupport', () => {
  it('asks iOS Safari to install first, even though it hides the Push API there', () => {
    expect(pushSupport({ userAgent: IPHONE, standalone: false, maxTouchPoints: 5, hasServiceWorker: true, hasPushManager: false, hasNotification: false })).toBe('needs-install');
  });

  it('supports the installed iOS app and Android Chrome', () => {
    expect(pushSupport({ userAgent: IPHONE, standalone: true, maxTouchPoints: 5, ...full })).toBe('supported');
    expect(pushSupport({ userAgent: ANDROID, standalone: false, maxTouchPoints: 5, ...full })).toBe('supported');
  });

  it('reports a browser without the APIs as unsupported', () => {
    expect(pushSupport({ userAgent: ANDROID, standalone: false, maxTouchPoints: 5, ...full, hasPushManager: false })).toBe('unsupported');
    expect(pushSupport({ userAgent: IPHONE, standalone: true, maxTouchPoints: 5, ...full, hasNotification: false })).toBe('unsupported');
  });
});

describe('urlBase64ToUint8Array', () => {
  it('decodes URL-safe base64 without padding', () => {
    expect(Array.from(urlBase64ToUint8Array('-_8'))).toEqual([0xfb, 0xff]);
    expect(Array.from(urlBase64ToUint8Array('AQID'))).toEqual([1, 2, 3]);
  });
});

describe('subscriptionBody', () => {
  it('keeps only the endpoint and keys', () => {
    const sub = { toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/x', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }) };
    expect(subscriptionBody(sub)).toEqual({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } });
  });

  it('refuses an incomplete subscription', () => {
    expect(subscriptionBody({ toJSON: () => ({ endpoint: 'https://x' }) })).toBeNull();
  });
});

describe('staleNotificationTags', () => {
  it('closes session notifications whose session stopped waiting, and leaves others', () => {
    const resolved = new Set(['box-a|alice-dx-agent', '|alice-ex-agent']);
    expect(staleNotificationTags(['box-a|alice-cx-agent', 'box-a|alice-dx-agent', '|alice-ex-agent', 'termag-test', undefined], resolved))
      .toEqual(['box-a|alice-dx-agent', '|alice-ex-agent']);
  });

  it('keeps every notification before any status has arrived (the app just opened)', () => {
    expect(staleNotificationTags(['box-a|alice-cx-agent', 'box-a|alice-dx-agent#lq3x2'], new Set())).toEqual([]);
  });

  it('reads the session from a per-push tag', () => {
    const resolved = new Set(['box-a|alice-dx-agent', 'termag-test']);
    expect(staleNotificationTags(['box-a|alice-cx-agent#lq3x1', 'box-a|alice-dx-agent#lq3x2', 'termag-test#lq3x3'], resolved))
      .toEqual(['box-a|alice-dx-agent#lq3x2']);
  });
});

describe('routerPathFor', () => {
  it('strips the /termag basename and keeps the query', () => {
    expect(routerPathFor(new URL('http://h/termag/m/p/abc?ws=x'))).toBe('/m/p/abc?ws=x');
    expect(routerPathFor(new URL('http://h/elsewhere'))).toBeNull();
  });
});

describe('withTimeout', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('passes a settled promise through', async () => {
    await expect(withTimeout(Promise.resolve('sub'), 100, () => null)).resolves.toBe('sub');
    await expect(withTimeout(Promise.reject(new Error('denied')), 100, () => null)).rejects.toThrow('denied');
  });

  it('falls back when the browser never answers', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<string>(() => {}), 8000, () => null);
    vi.advanceTimersByTime(8000);
    await expect(pending).resolves.toBeNull();
  });

  it('rejects when the fallback throws', async () => {
    vi.useFakeTimers();
    const pending = withTimeout(new Promise<string>(() => {}), 20000, () => { throw new Error('no answer'); });
    vi.advanceTimersByTime(20000);
    await expect(pending).rejects.toThrow('no answer');
  });
});
