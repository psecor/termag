import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));

const { cleanUpFailedPoolLaunch } = await import('./boxProvisioner');

describe('a failed environment-pool launch tears its resources down (Bugbot on #1453)', () => {
  it('tears down the box a failed launch left terminated: its security group, role and any instance', async () => {
    const row = { id: 'p1', status: 'terminated', cleanedUpAt: null, provisioningError: 'RunInstances: InsufficientInstanceCapacity', securityGroupId: 'sg-1', iamRoleName: 'termag-boxes-p1', ec2InstanceId: null };
    const terminate = vi.fn(async () => true);
    await cleanUpFailedPoolLaunch('p1', { find: async () => row as any, terminate });
    expect(terminate).toHaveBeenCalledWith(row);
  });

  it('leaves a row the launch did not fail: quarantined (its own containment runs), already cleaned up, or gone', async () => {
    const terminate = vi.fn(async () => true);
    await cleanUpFailedPoolLaunch('p1', { find: async () => ({ id: 'p1', status: 'quarantined' }) as any, terminate });
    await cleanUpFailedPoolLaunch('p1', { find: async () => null, terminate });
    await cleanUpFailedPoolLaunch('p1', { find: async () => ({ id: 'p1', status: 'terminated', cleanedUpAt: new Date(), provisioningError: 'x' }) as any, terminate });
    expect(terminate).not.toHaveBeenCalled();
  });
});
