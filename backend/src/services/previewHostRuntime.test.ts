// The preview host's environment (services/previewHostRuntime.ts): the domain
// is read the way dispatch reads a Host, so the hand-off URL and the Origin
// checks agree with it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { domainFromEnv } from './previewHostRuntime';

describe('domainFromEnv', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('trims, lowercases and drops leading and trailing dots, as classifyHost does', () => {
    for (const raw of ['previews.test', ' Previews.Test ', 'previews.test.', '.previews.test', '..previews.test..']) {
      vi.stubEnv('PREVIEW_LINKS_DOMAIN', raw);
      expect(domainFromEnv(), raw).toBe('previews.test');
    }
  });

  it('is null when unset or only dots', () => {
    vi.stubEnv('PREVIEW_LINKS_DOMAIN', '');
    expect(domainFromEnv()).toBeNull();
    vi.stubEnv('PREVIEW_LINKS_DOMAIN', '..');
    expect(domainFromEnv()).toBeNull();
  });
});
