import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BAZEL_CACHE_SETTINGS, GENERATION_PATTERN, bazelCacheApply, bazelCacheOriginFromEnv, bazelCacheUrl, parseBazelCacheConfig,
} from './bazelCache';

const ORIGIN = 'https://termag-bazel-cache-123456789012-us-east-2-an.s3.us-east-2.amazonaws.com';
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('bazelCacheOriginFromEnv', () => {
  it('takes an https S3 bucket origin, with or without the trailing slash', () => {
    expect(bazelCacheOriginFromEnv({ BAZEL_CACHE_URL: ORIGIN })).toBe(ORIGIN);
    expect(bazelCacheOriginFromEnv({ BAZEL_CACHE_URL: ` ${ORIGIN}/ ` })).toBe(ORIGIN);
  });

  it('is null when unset', () => {
    expect(bazelCacheOriginFromEnv({})).toBeNull();
    expect(bazelCacheOriginFromEnv({ BAZEL_CACHE_URL: '  ' })).toBeNull();
  });

  it.each([
    ['plain http', 'http://b-1.s3.us-east-2.amazonaws.com'],
    ['a host that is not S3', 'https://bazel-cache.termag.example.internal'],
    ['a look-alike host', 'https://b-1.s3.us-east-2.amazonaws.com.example.com'],
    ['a bucket with dots', 'https://my.bucket.s3.us-east-2.amazonaws.com'],
    ['the path-style endpoint', 'https://s3.us-east-2.amazonaws.com/termag-bazel-cache'],
    ['a path', `${ORIGIN}/g/2026w45`],
    ['a query', `${ORIGIN}/?x=1`],
    ['a fragment', `${ORIGIN}/#x`],
    ['a port', 'https://b-1.s3.us-east-2.amazonaws.com:8443'],
    ['credentials', 'https://u:p@b-1.s3.us-east-2.amazonaws.com'],
    ['not a URL', 'not a url'],
  ])('refuses %s, logged and treated as unset', (_what, url) => {
    expect(bazelCacheOriginFromEnv({ BAZEL_CACHE_URL: url })).toBeNull();
    expect(error).toHaveBeenCalled();
  });
});

describe('generations', () => {
  it.each(['2026w01', '2026w45', '2026w53', '2026w45-1', '2026w45-12'])('accepts %s', g => expect(GENERATION_PATTERN.test(g)).toBe(true));
  it.each(['2026w00', '2026w54', '2026W45', '26w45', '2026w45-0', '2026w45-123', '2026w45/..', '../2026w45', '2026w45\n'])('refuses %j', g => expect(GENERATION_PATTERN.test(g)).toBe(false));

  it('builds the URL from the origin and a valid generation only', () => {
    expect(bazelCacheUrl(ORIGIN, '2026w45')).toBe(`${ORIGIN}/g/2026w45`);
    expect(() => bazelCacheUrl(ORIGIN, '../x')).toThrow();
  });
});

describe('parseBazelCacheConfig', () => {
  it('gives every default for {}, null and non-objects', () => {
    for (const v of [{}, null, undefined, [], 'x', 3]) expect(parseBazelCacheConfig(v)).toEqual(DEFAULT_BAZEL_CACHE_SETTINGS);
    expect(DEFAULT_BAZEL_CACHE_SETTINGS).toEqual({
      remoteTimeoutSeconds: 5, remoteRetries: 1, jobs: 200, downloadOutputs: 'toplevel', flushGeneration: 0, goHostModcache: false,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('takes each field inside its range', () => {
    expect(parseBazelCacheConfig({ remoteTimeoutSeconds: 60, remoteRetries: 0, jobs: 8, downloadOutputs: 'all', flushGeneration: 2 ** 31 - 1, goHostModcache: true }))
      .toEqual({ remoteTimeoutSeconds: 60, remoteRetries: 0, jobs: 8, downloadOutputs: 'all', flushGeneration: 2 ** 31 - 1, goHostModcache: true });
    expect(parseBazelCacheConfig({ remoteTimeoutSeconds: 1, remoteRetries: 5, jobs: 400 })).toMatchObject({ remoteTimeoutSeconds: 1, remoteRetries: 5, jobs: 400 });
  });

  it.each([
    ['remoteTimeoutSeconds', [0, 61, 2.5, '5', null]],
    ['remoteRetries', [-1, 6, 1.5, '1']],
    ['jobs', [7, 401, 100.5, '200']],
    ['downloadOutputs', ['minimal', 'TOPLEVEL', 1, null]],
    ['flushGeneration', [-1, 2 ** 31, 1.5, '3']],
    ['goHostModcache', ['true', 1, null]],
  ] as const)('falls back for a bad %s alone, with a warning', (field, bads) => {
    for (const bad of bads) {
      warn.mockClear();
      const got = parseBazelCacheConfig({ [field]: bad, jobs: field === 'jobs' ? bad : 100 });
      expect(got[field]).toEqual(DEFAULT_BAZEL_CACHE_SETTINGS[field]);
      if (field !== 'jobs') expect(got.jobs).toBe(100);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(field));
    }
  });

  it('ignores unknown keys: a served url or bucket changes nothing', () => {
    const served = parseBazelCacheConfig({ url: 'https://evil.example.com/g/2026w45', bucket: 'evil', remoteCache: 'grpc://x', jobs: 100 });
    expect(served).toEqual({ ...DEFAULT_BAZEL_CACHE_SETTINGS, jobs: 100 });
    expect(Object.keys(served)).not.toContain('url');
    expect(JSON.stringify(bazelCacheApply(`${ORIGIN}/g/2026w45`, served))).not.toContain('evil');
  });
});

describe('bazelCacheApply', () => {
  it('is exactly the tech spec payload, minus seq', () => {
    expect(bazelCacheApply(`${ORIGIN}/g/2026w45`, DEFAULT_BAZEL_CACHE_SETTINGS)).toEqual({
      url: `${ORIGIN}/g/2026w45`, flushGeneration: 0, remoteTimeoutSeconds: 5, remoteRetries: 1, jobs: 200, downloadOutputs: 'toplevel', goHostModcache: false,
    });
  });
});
