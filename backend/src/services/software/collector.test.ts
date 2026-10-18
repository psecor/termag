import { describe, it, expect, vi } from 'vitest';
vi.mock('../../db', () => ({ prisma: {} }));
vi.mock('../agentRegistry', () => ({ inventoryHosts: () => [], sendToAgent: vi.fn(), sendToInstanceAgent: vi.fn() }));
vi.mock('../boxProvisioner', () => ({
  amiTermagSha: (img: { Tags?: { Key?: string; Value?: string }[] }) => img.Tags?.find(t => t.Key === 'TermagSha')?.Value ?? null,
  awsClientConfig: () => ({}), getBoxConfig: () => null,
}));
vi.mock('../termagVersion', () => ({ termagVersion: async () => ({ sha: null, source: 'unknown' }) }));
import { lookupImages, isMissingImageError } from './collector';

const img = (id: string) => ({ ImageId: id, CreationDate: '2026-10-01T00:00:00Z', Tags: [{ Key: 'TermagSha', Value: `sha-${id}` }] });

describe('lookupImages', () => {
  it('survives one deregistered image in a batch', async () => {
    const describe = vi.fn(async (ids: string[]) => {
      if (ids.includes('ami-gone')) throw Object.assign(new Error('InvalidAMIID.NotFound'), { name: 'InvalidAMIID.NotFound' });
      return ids.map(img);
    });
    const out = await lookupImages(['ami-a', 'ami-gone', 'ami-b'], describe);
    expect(out.get('ami-a')).toEqual({ sha: 'sha-ami-a', created: '2026-10-01T00:00:00Z' });
    expect(out.get('ami-b')?.sha).toBe('sha-ami-b');
    expect(out.get('ami-gone')).toEqual({ sha: null, created: null });
    expect(describe).toHaveBeenCalledTimes(4); // the batch, then each id
  });
  it('makes one call when every image exists', async () => {
    const describe = vi.fn(async (ids: string[]) => ids.map(img));
    await lookupImages(['ami-a', 'ami-b'], describe);
    expect(describe).toHaveBeenCalledTimes(1);
  });
});

describe('transient EC2 errors', () => {
  it('leave an image out instead of caching it as unknown', async () => {
    const describe = vi.fn(async (ids: string[]) => {
      if (ids.length > 1) throw Object.assign(new Error('rate exceeded'), { name: 'RequestLimitExceeded' });
      if (ids[0] === 'ami-gone') throw Object.assign(new Error('not found'), { name: 'InvalidAMIID.NotFound' });
      if (ids[0] === 'ami-blip') throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
      return ids.map(img);
    });
    const out = await lookupImages(['ami-a', 'ami-gone', 'ami-blip'], describe);
    expect(out.get('ami-a')?.sha).toBe('sha-ami-a');
    expect(out.get('ami-gone')).toEqual({ sha: null, created: null });
    expect(out.has('ami-blip')).toBe(false);
  });
  it('recognises only EC2 missing-image errors', () => {
    expect(isMissingImageError({ name: 'InvalidAMIID.NotFound' })).toBe(true);
    expect(isMissingImageError({ name: 'InvalidAMIID.Malformed' })).toBe(true);
    expect(isMissingImageError({ name: 'RequestLimitExceeded' })).toBe(false);
    expect(isMissingImageError(new Error('boom'))).toBe(false);
    expect(isMissingImageError(null)).toBe(false);
  });
});
