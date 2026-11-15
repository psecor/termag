import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '@prisma/client';

const fallback = vi.fn();
vi.mock('./boxStartFallback', () => ({ startOnFallbackType: (...a: unknown[]) => fallback(...a) }));
vi.mock('./boxProvisioner', () => ({
  getBoxConfig: () => ({ region: 'us-east-2' }),
  awsClientConfig: (_cfg: unknown, region: string) => ({ region }),
}));

const { ec2For, startBox } = await import('./ec2Box');

const box = { id: 'i1', name: 'b', ec2InstanceId: 'i-0abc', region: 'us-west-2', status: 'stopped' } as unknown as Instance;
const capacity = () => Object.assign(new Error('Insufficient capacity.'), { name: 'InsufficientInstanceCapacity' });

function ec2(fail?: Error) {
  const sent: string[] = [];
  return { sent, send: vi.fn(async (cmd: { constructor: { name: string }; input: unknown }) => { sent.push(cmd.constructor.name); if (fail) throw fail; return {}; }) };
}

describe('startBox: the one StartInstances of a stopped box, for boxPower, the pool claim and the refresh', () => {
  it('starts it, with no fallback needed', async () => {
    const c = ec2();
    await expect(startBox(c as any, box)).resolves.toEqual({ fallbackType: null });
    expect(c.sent).toEqual(['StartInstancesCommand']);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('walks to a same-shape type when EC2 has no capacity for its own', async () => {
    fallback.mockResolvedValueOnce('m7g.xlarge');
    const refusal = capacity();
    await expect(startBox(ec2(refusal) as any, box)).resolves.toEqual({ fallbackType: 'm7g.xlarge' });
    expect(fallback).toHaveBeenCalledWith(expect.anything(), box, refusal);
  });

  it('throws what the fallback throws (the first refusal when nothing else starts)', async () => {
    const refusal = capacity();
    fallback.mockRejectedValueOnce(refusal);
    await expect(startBox(ec2(refusal) as any, box)).rejects.toBe(refusal);
  });

  it('rethrows at once without the fallback (a resize walks its own types)', async () => {
    fallback.mockClear();
    const refusal = capacity();
    await expect(startBox(ec2(refusal) as any, box, { fallback: false })).rejects.toBe(refusal);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("ec2For: the box's own region, else the configured one", () => {
    expect((ec2For(box) as any).config).toBeDefined();
    expect(() => ec2For({ region: null })).not.toThrow();
  });
});
