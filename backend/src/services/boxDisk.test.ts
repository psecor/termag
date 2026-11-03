import { beforeEach, describe, expect, it, vi } from 'vitest';

const ec2 = {
  sent: [] as Array<{ name: string; input: any }>,
  // Modification states DescribeVolumesModifications answers with, one per call (the last repeats).
  states: [] as string[],
  neverModified: false,
  modifyRefusal: null as string | null,
};
vi.mock('@aws-sdk/client-ec2', () => {
  const command = (name: string) => class { constructor(public input: any) {} name = name; };
  return {
    DescribeInstancesCommand: command('DescribeInstances'),
    DescribeVolumesCommand: command('DescribeVolumes'),
    DescribeVolumesModificationsCommand: command('DescribeVolumesModifications'),
    ModifyVolumeCommand: command('ModifyVolume'),
    EC2Client: class {
      async send(cmd: { name: string; input: any }) {
        ec2.sent.push({ name: cmd.name, input: cmd.input });
        if (cmd.name === 'DescribeInstances') {
          return { Reservations: [{ Instances: [{ RootDeviceName: '/dev/sda1', BlockDeviceMappings: [
            { DeviceName: '/dev/sdb', Ebs: { VolumeId: 'vol-data' } },
            { DeviceName: '/dev/sda1', Ebs: { VolumeId: 'vol-root' } },
          ] }] }] };
        }
        if (cmd.name === 'DescribeVolumes') return { Volumes: [{ Size: 152, VolumeType: 'gp3' }] };
        if (cmd.name === 'DescribeVolumesModifications') {
          if (ec2.neverModified) throw Object.assign(new Error('none'), { name: 'InvalidVolumeModification.NotFound' });
          const state = ec2.states.length > 1 ? ec2.states.shift()! : ec2.states[0];
          return { VolumesModifications: [{ ModificationState: state, Progress: 10, TargetSize: 304, StartTime: new Date('2026-10-27T00:00:00Z') }] };
        }
        if (cmd.name === 'ModifyVolume' && ec2.modifyRefusal) throw new Error(ec2.modifyRefusal);
        return {};
      }
    },
  };
});
vi.mock('./boxProvisioner', () => ({ getBoxConfig: () => ({ region: 'us-east-2' }), awsClientConfig: () => ({ region: 'us-east-2' }) }));
vi.mock('./featureFlags', () => ({ boolVariation: async () => false }));
// box_events, as boxEvents.ts writes it.
const boxEvents: Array<Record<string, any>> = [];
vi.mock('./boxEvents', () => ({
  createBoxEvent: async (e: any) => { const r = { id: `ev${boxEvents.length + 1}`, boxId: e.box.id, boxName: e.box.name, kind: e.kind, actorId: e.actorId, actorRole: e.actorRole, from: e.from, to: e.to, phase: e.phase, detail: e.detail, finishedAt: null, error: null }; boxEvents.push(r); return r; },
  advanceBoxEvent: async (id: string, phase: string) => Object.assign(boxEvents.find(e => e.id === id)!, { phase }),
  finishBoxEvent: async (id: string, o: any) => Object.assign(boxEvents.find(e => e.id === id)!, { phase: o.phase, error: o.error ?? null, finishedAt: new Date(), detail: { ...boxEvents.find(e => e.id === id)!.detail, ...o.detail } }),
}));

const agent = {
  capabilities: ['disk-grow-v1'] as string[] | null,
  replies: [] as any[],
  calls: 0,
};
vi.mock('./agentRegistry', () => ({
  instanceAgentTransport: () => (agent.capabilities ? { capabilities: agent.capabilities } : null),
  sendToInstanceAgent: async (_id: string, type: string) => {
    expect(type).toBe('disk-grow');
    agent.calls++;
    return agent.replies.length > 1 ? agent.replies.shift() : agent.replies[0];
  },
}));

const { describeRootVolume, growRefusal, lastGrow, parseGrowBody, resetGrowsForTests, startGrow } = await import('./boxDisk');

const box = { id: 'inst_1', kind: 'ec2', status: 'ready', ec2InstanceId: 'i-0abc', region: null };
const fast = { pollMs: 1, modifyTimeoutMs: 1_000, fsRetryMs: 1, fsAttempts: 3 };

async function settled(id: string) {
  await vi.waitFor(() => { expect(['done', 'failed']).toContain(lastGrow(id)?.state); });
  return lastGrow(id)!;
}

beforeEach(() => {
  Object.assign(ec2, { sent: [], states: ['optimizing'], neverModified: false, modifyRefusal: null });
  Object.assign(agent, { capabilities: ['disk-grow-v1'], replies: [{ ok: true, partition: 'grown', beforeGb: 148, afterGb: 297 }], calls: 0 });
  resetGrowsForTests();
});

describe('growRefusal', () => {
  it('lets a ready EC2 box whose agent can grow its file system through', () => {
    expect(growRefusal(box, ['disk-grow-v1'])).toBeNull();
  });
  it('refuses external, non-ready, offline and old-agent boxes', () => {
    expect(growRefusal({ ...box, kind: 'external' }, ['disk-grow-v1'])).toMatch(/EC2/);
    expect(growRefusal({ ...box, ec2InstanceId: null }, ['disk-grow-v1'])).toMatch(/EC2/);
    expect(growRefusal({ ...box, status: 'hibernated' }, ['disk-grow-v1'])).toMatch(/hibernated/);
    expect(growRefusal(box, null)).toMatch(/not connected/);
    expect(growRefusal(box, ['host-sample-v1'])).toMatch(/too old/);
  });
});

describe('parseGrowBody', () => {
  const vol = { sizeGb: 152 };
  it('takes a whole number at least the current size', () => {
    expect(parseGrowBody({ sizeGb: 304 }, vol)).toEqual({ sizeGb: 304 });
    expect(parseGrowBody({ sizeGb: 152 }, vol)).toEqual({ sizeGb: 152 });
  });
  it('refuses a shrink, a fraction, a string and more than EBS allows', () => {
    expect(parseGrowBody({ sizeGb: 100 }, vol)).toEqual({ error: expect.stringMatching(/can't shrink/) });
    expect(parseGrowBody({ sizeGb: 200.5 }, vol)).toHaveProperty('error');
    expect(parseGrowBody({ sizeGb: '304' }, vol)).toHaveProperty('error');
    expect(parseGrowBody({ sizeGb: 20_000 }, vol)).toHaveProperty('error');
    expect(parseGrowBody(null, vol)).toHaveProperty('error');
  });
});

describe('describeRootVolume', () => {
  it('picks the root device’s volume, not another attached one', async () => {
    const v = await describeRootVolume(box);
    expect(v).toEqual({ volumeId: 'vol-root', sizeGb: 152, volumeType: 'gp3',
      modification: { state: 'optimizing', progress: 10, targetSizeGb: 304, startedAt: '2026-10-27T00:00:00.000Z' } });
  });
  it('reads a volume that was never modified as no modification', async () => {
    ec2.neverModified = true;
    expect((await describeRootVolume(box)).modification).toBeNull();
  });
});

describe('startGrow', () => {
  const volume = { volumeId: 'vol-root', sizeGb: 152, volumeType: 'gp3', modification: null };

  it('modifies the volume, waits for optimizing, then has the agent grow the file system', async () => {
    ec2.states = ['modifying', 'modifying', 'optimizing'];
    const rec = await startGrow(box, volume, 304, 'admin1', fast);
    expect(rec).toMatchObject({ volumeId: 'vol-root', fromGb: 152, toGb: 304, by: 'admin1', state: 'modifying' });
    expect(ec2.sent.find(s => s.name === 'ModifyVolume')?.input).toEqual({ VolumeId: 'vol-root', Size: 304 });
    const done = await settled('inst_1');
    expect(done).toMatchObject({ state: 'done', detail: 'file system 148 → 297 GB (partition grown)' });
    expect(agent.calls).toBe(1);
  });

  it('writes a disk-grow row in box_events, advanced to filesystem and closed done', async () => {
    boxEvents.length = 0;
    ec2.states = ['optimizing'];
    await startGrow({ ...box, name: 'olive' }, volume, 304, 'admin1', fast, 'u-admin');
    await settled('inst_1');
    await new Promise(r => setTimeout(r, 5));
    expect(boxEvents).toEqual([expect.objectContaining({
      boxId: 'inst_1', boxName: 'olive', kind: 'disk-grow', actorId: 'u-admin', actorRole: 'admin', from: '152 GB', to: '304 GB',
      phase: 'done', error: null, finishedAt: expect.any(Date),
      detail: expect.objectContaining({ volumeId: 'vol-root', fromGb: 152, toGb: 304, by: 'admin1', result: expect.stringContaining('partition grown') }),
    })]);
  });

  it('asks the agent again while the kernel has not seen the new size', async () => {
    agent.replies = [{ ok: true, partition: 'unchanged', beforeGb: 148, afterGb: 148 }, { ok: true, partition: 'grown', beforeGb: 148, afterGb: 297 }];
    await startGrow(box, volume, 304, 'admin1', fast);
    expect(await settled('inst_1')).toMatchObject({ state: 'done' });
    expect(agent.calls).toBe(2);
  });

  it('gives up after the attempts and says to ask again', async () => {
    agent.replies = [{ ok: true, partition: 'unchanged', beforeGb: 148, afterGb: 148 }];
    await startGrow(box, volume, 304, 'admin1', fast);
    expect(await settled('inst_1')).toMatchObject({ state: 'failed', detail: expect.stringMatching(/ask again/) });
    expect(agent.calls).toBe(3);
  });

  it('re-runs only the file system step when asked for the size the volume already has', async () => {
    agent.replies = [{ ok: true, partition: 'unchanged', beforeGb: 297, afterGb: 297 }];
    await startGrow(box, { ...volume, sizeGb: 304 }, 304, 'admin1', fast);
    expect(ec2.sent.some(s => s.name === 'ModifyVolume')).toBe(false);
    expect(await settled('inst_1')).toMatchObject({ state: 'done' });
  });

  it('keeps trying on a same-size retry while the file system is still short of the volume', async () => {
    // The volume went to 304 GB before a restart or a failed step; the file system is still 148 GB.
    agent.replies = [{ ok: true, partition: 'unchanged', beforeGb: 148, afterGb: 148 }, { ok: true, partition: 'grown', beforeGb: 148, afterGb: 297 }];
    await startGrow(box, { ...volume, sizeGb: 304 }, 304, 'admin1', fast);
    expect(await settled('inst_1')).toMatchObject({ state: 'done', detail: 'file system 148 → 297 GB (partition grown)' });
    expect(agent.calls).toBe(2);
  });

  it('does not report a same-size retry done when the file system never reaches the volume', async () => {
    agent.replies = [{ ok: true, partition: 'unchanged', beforeGb: 148, afterGb: 148 }];
    await startGrow(box, { ...volume, sizeGb: 304 }, 304, 'admin1', fast);
    expect(await settled('inst_1')).toMatchObject({ state: 'failed', detail: expect.stringMatching(/ask again/) });
    expect(agent.calls).toBe(3);
  });

  it('records a failed modification and never calls the agent', async () => {
    ec2.states = ['failed'];
    await startGrow(box, volume, 304, 'admin1', fast);
    expect(await settled('inst_1')).toMatchObject({ state: 'failed', detail: expect.stringMatching(/modification failed/) });
    expect(agent.calls).toBe(0);
  });

  it('records the agent’s error', async () => {
    agent.replies = [{ ok: false, error: 'growpart: FAILED' }];
    await startGrow(box, volume, 304, 'admin1', fast);
    expect(await settled('inst_1')).toMatchObject({ state: 'failed', detail: 'growpart: FAILED' });
  });

  it('records an agent that went away before the file system step', async () => {
    agent.capabilities = null;
    await startGrow(box, volume, 304, 'admin1', fast);
    expect(await settled('inst_1')).toMatchObject({ state: 'failed', detail: expect.stringMatching(/went away/) });
  });

  it('throws EC2’s refusal, keeps no in-memory grow, and closes its box_events row failed with the error', async () => {
    boxEvents.length = 0;
    ec2.modifyRefusal = 'You have reached the maximum modification rate per volume limit.';
    await expect(startGrow(box, volume, 304, 'admin1', fast)).rejects.toThrow(/maximum modification rate/);
    expect(lastGrow('inst_1')).toBeNull();
    await new Promise(r => setTimeout(r, 5));
    expect(boxEvents).toEqual([expect.objectContaining({ kind: 'disk-grow', phase: 'failed', error: expect.stringMatching(/EC2 refused the modification: You have reached/) })]);
  });

  it('refuses a second grow while one runs', async () => {
    ec2.states = ['modifying'];
    await startGrow(box, volume, 304, 'admin1', { ...fast, modifyTimeoutMs: 60_000 });
    expect(growRefusal(box, ['disk-grow-v1'])).toMatch(/already running/);
  });
});
