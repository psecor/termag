import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));

const { cleanUpFailedPoolLaunch } = await import('./boxProvisioner');

describe('a failed environment-pool launch tears its resources down (Bugbot on #1453)', () => {
  it('terminates the box a failed launch left env-failed: its security group, role and any instance', async () => {
    const row = { id: 'p1', status: 'env-failed', securityGroupId: 'sg-1', iamRoleName: 'termag-boxes-p1', ec2InstanceId: null };
    const terminate = vi.fn(async () => true);
    await cleanUpFailedPoolLaunch('p1', { find: async () => row as any, terminate });
    expect(terminate).toHaveBeenCalledWith(row);
  });

  it('leaves a row the launch did not fail: quarantined (its own containment runs), or gone', async () => {
    const terminate = vi.fn(async () => true);
    await cleanUpFailedPoolLaunch('p1', { find: async () => ({ id: 'p1', status: 'quarantined' }) as any, terminate });
    await cleanUpFailedPoolLaunch('p1', { find: async () => null, terminate });
    expect(terminate).not.toHaveBeenCalled();
  });
});
