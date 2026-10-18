import { describe, expect, it, vi } from 'vitest';
import { SpacesUnavailableError, spaceResourceNames, spaceResourcesResolver, type IdentitySource } from './spaceConfig';

describe('spaceResourceNames', () => {
  it('matches the names terraform creates in orchestrator/spaces.tf', () => {
    expect(spaceResourceNames('123456789012', 'us-east-2')).toEqual({
      accountId: '123456789012',
      region: 'us-east-2',
      bucket: 'termag-spaces-123456789012-us-east-2-an',
      roleArn: 'arn:aws:iam::123456789012:role/termag-spaces-presigner',
      kmsKeyId: 'arn:aws:kms:us-east-2:123456789012:alias/termag-spaces',
    });
  });

  it('refuses an identity that cannot name a bucket', () => {
    expect(() => spaceResourceNames('12345', 'us-east-2')).toThrow(SpacesUnavailableError);
    expect(() => spaceResourceNames('123456789012', 'US_EAST')).toThrow(SpacesUnavailableError);
  });
});

function source(over: Partial<IdentitySource> = {}): IdentitySource {
  return { region: async () => 'us-east-2', accountId: async () => '123456789012', ...over };
}

describe('spaceResourcesResolver', () => {
  it('reads the identity once', async () => {
    const accountId = vi.fn(async () => '123456789012');
    const resolve = spaceResourcesResolver(source({ accountId }));
    await resolve();
    await Promise.all([resolve(), resolve()]);
    expect(accountId).toHaveBeenCalledTimes(1);
    expect((await resolve()).bucket).toBe('termag-spaces-123456789012-us-east-2-an');
  });

  it('needs a region', async () => {
    await expect(spaceResourcesResolver(source({ region: async () => undefined }))()).rejects.toThrow(/AWS_REGION/);
  });

  it('retries a failed lookup only after the back-off', async () => {
    let t = 0;
    const accountId = vi.fn(async () => { throw new Error('no credentials'); });
    const resolve = spaceResourcesResolver(source({ accountId }), { retryMs: 1000, now: () => t });
    await expect(resolve()).rejects.toBeInstanceOf(SpacesUnavailableError);
    await expect(resolve()).rejects.toThrow(/no credentials/);
    expect(accountId).toHaveBeenCalledTimes(1);
    t = 1001;
    accountId.mockImplementationOnce(async () => '123456789012');
    expect((await resolve()).accountId).toBe('123456789012');
  });
});
