import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));

// No module mocked but the database: bazelCacheDelivery.ts and
// credentialDelivery.ts are in a cycle through agentRegistry.ts, and
// credentialDelivery.ts reads the capability while it loads. Loaded from the
// bazel-cache side first, that read once hit a module still initializing.
describe('loading the bazel-cache delivery first', () => {
  it('leaves credentialDelivery.ts with the bazel-cache provider gated on bazel-cache-v2', async () => {
    const delivery = await import('./bazelCacheDelivery');
    const { providersFor } = await import('./credentialDelivery');
    expect(delivery.BAZEL_CACHE_CAPABILITY).toBe('bazel-cache-v2');
    expect(providersFor(['credentials-v1', 'bazel-cache-v2'])).toContain('bazel-cache');
    expect(providersFor(['credentials-v1'])).not.toContain('bazel-cache');
  });
});
