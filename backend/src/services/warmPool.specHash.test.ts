import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));

const { poolSpecHash } = await import('./warmPool');

describe('poolSpecHash', () => {
  const spec = { amiId: 'ami-1', instanceType: 'm9g.2xlarge', warmCloudInit: '#!/bin/bash\n' };

  it('is unchanged for a pool launched without hibernation, so deploying this rolls nothing over', () => {
    // sha256("ami-1\nm9g.2xlarge\n" + sha256("#!/bin/bash\n")), the formula before hibernation existed.
    const before = '3fc57c809480fa0449e36071031bc2a43a46c42a0c1809edc85cc6538c845906';
    expect(poolSpecHash(spec)).toBe(before);
    expect(poolSpecHash({ ...spec, hibernation: false })).toBe(before);
  });

  it('changes when launches become hibernation-capable, so the pool rolls onto boxes that can hibernate', () => {
    expect(poolSpecHash({ ...spec, hibernation: true })).not.toBe(poolSpecHash(spec));
  });
});
