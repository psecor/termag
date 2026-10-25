import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The serializable transaction, with the rows the owner holds as it sees them.
const tx = {
  instance: { findMany: vi.fn(), create: vi.fn() },
  agentToken: { create: vi.fn() },
};
vi.mock('../db', () => ({ prisma: { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) } }));

import { STUCK_AFTER_MS, pickFreeBoxName, provisionNewBox } from './boxProvisioner';
import { PROVISIONING_FAILURE_WINDOW_MS } from './claudeRunnerSpawn';

const user = { id: 'u1', googleEmail: 'ada@example.com', unixUsername: 'ada', displayName: 'Ada' };
const onItsWay = {
  id: 'p', name: 'claude-20261007', kind: 'ec2', status: 'provisioning', ec2InstanceId: null, lastConnectedAt: null, createdAt: new Date(),
};

describe('pickFreeBoxName', () => {
  it('takes the base when free, else the first free -2, -3, …, dodging terminated rows too', () => {
    expect(pickFreeBoxName(new Set(), 'claude-20261007')).toBe('claude-20261007');
    expect(pickFreeBoxName(new Set(['claude-20261007']), 'claude-20261007')).toBe('claude-20261007-2');
    expect(pickFreeBoxName(new Set(['claude-20261007', 'claude-20261007-2']), 'claude-20261007')).toBe('claude-20261007-3');
  });
});

describe('the auto-box failure hold', () => {
  it('assumes the stuck sweep window the provisioner actually uses', () => {
    expect(PROVISIONING_FAILURE_WINDOW_MS).toBe(STUCK_AFTER_MS);
  });
});

describe('provisionNewBox: the re-check inside the transaction', () => {
  beforeEach(() => {
    // Enough of a box config for isBoxProvisioningConfigured(); nothing here launches.
    for (const [k, v] of Object.entries({
      AWS_REGION: 'us-east-2', AGENT_WS_URL: 'wss://example.test/termag/ws/agent', BOX_RESOURCE_PREFIX: 'termag-boxes',
      BOX_PERMISSIONS_BOUNDARY_ARN: 'arn:aws:iam::123456789012:policy/boundary', BOX_VPC_ID: 'vpc-1', BOX_SUBNET_ID: 'subnet-1',
    })) vi.stubEnv(k, v);
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it('asks stillNeeded with the rows the transaction sees, and creates nothing when it says no', async () => {
    tx.instance.findMany.mockResolvedValue([onItsWay]);
    const stillNeeded = vi.fn(() => false);
    await expect(provisionNewBox(user, 'claude-20261007', stillNeeded, { image: { kind: 'published' }, hibernation: false })).resolves.toBeNull();
    expect(stillNeeded).toHaveBeenCalledWith([onItsWay]);
    expect(tx.instance.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'u1', status: { not: 'terminated' } },
    }));
    expect(tx.instance.create).not.toHaveBeenCalled();
    expect(tx.agentToken.create).not.toHaveBeenCalled();
  });

  it('creates nothing without a box configuration either, and never asks', async () => {
    vi.unstubAllEnvs();
    vi.stubEnv('BOX_VPC_ID', '');
    const stillNeeded = vi.fn(() => true);
    await expect(provisionNewBox(user, 'claude-20261007', stillNeeded, { image: { kind: 'published' }, hibernation: false })).resolves.toBeNull();
    expect(stillNeeded).not.toHaveBeenCalled();
    expect(tx.instance.create).not.toHaveBeenCalled();
  });
});
