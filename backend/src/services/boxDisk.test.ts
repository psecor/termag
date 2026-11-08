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
// A finished grow records the new size on the box (Instance.diskGiB).
const instanceUpdates: Array<{ where: any; data: any }> = [];
vi.mock('../db', () => ({ prisma: { instance: { update: async (a: any) => { instanceUpdates.push(a); return {}; } } } }));
// box_events, as boxEvents.ts writes it.
const boxEvents: Array<Record<string, any>> = [];
vi.mock('./boxEvents', () => ({
  // The real rule: open and under an hour old.
  eventOpen: (row: { startedAt: Date; finishedAt: Date | null }, nowMs = Date.now()) => !row.finishedAt && nowMs - row.startedAt.getTime() < 3_600_000,
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

const {
  cooldownRefusal, describeRootVolume, diskView, growErrorMessage, growRefusal, growRunning, lastGrow, OWNER_MAX_GB, parseGrowBody, parseOwnerGrowBody,
  reserveGrow, resetGrowsForTests, startGrow, waitForGrow,
} = await import('./boxDisk');

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
  instanceUpdates.length = 0;
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

describe('owner grows', () => {
  const volume = { volumeId: 'vol-root', sizeGb: 152, volumeType: 'gp3', modification: null };
  const now = Date.parse('2026-11-03T12:00:00Z');
  const modifiedAt = (iso: string, state = 'completed') => ({ ...volume, modification: { state, progress: 100, targetSizeGb: 152, startedAt: iso } });

  it('caps an owner at the creation range’s top, 300 GB, and never below what the disk already has', () => {
    expect(OWNER_MAX_GB).toBe(300);
    expect(parseOwnerGrowBody({ sizeGb: 300 }, volume, now)).toEqual({ sizeGb: 300 });
    expect(parseOwnerGrowBody({ sizeGb: 301 }, volume, now)).toEqual({ error: expect.stringMatching(/up to 300 GB/), code: 'invalid_disk' });
    expect(parseOwnerGrowBody({ sizeGb: 100 }, volume, now)).toEqual({ error: expect.stringMatching(/can't shrink/), code: 'invalid_disk' });
    expect(parseOwnerGrowBody({ sizeGb: '200' }, volume, now)).toHaveProperty('code', 'invalid_disk');
  });

  it('refuses a second change inside EBS’s six hours, saying when the next one is allowed', () => {
    const recent = modifiedAt('2026-11-03T10:00:00Z');
    expect(cooldownRefusal(recent, now)).toBe(
      'EBS allows one change to a disk every six hours. This one was last changed at 2026-11-03 10:00 UTC, so it can grow again after 2026-11-03 16:00 UTC.');
    expect(parseOwnerGrowBody({ sizeGb: 200 }, recent, now)).toEqual({ error: cooldownRefusal(recent, now), code: 'disk_cooldown' });
    // Six hours on, or a modification that failed, leaves the volume free.
    expect(cooldownRefusal(modifiedAt('2026-11-03T05:59:00Z'), now)).toBeNull();
    expect(cooldownRefusal(modifiedAt('2026-11-03T10:00:00Z', 'failed'), now)).toBeNull();
    expect(cooldownRefusal(volume, now)).toBeNull();
  });

  it('says EC2’s own rate refusal plainly', () => {
    const err = Object.assign(new Error("You've reached the maximum modification rate per volume limit. Wait at least 6 hours between modifications per EBS volume."), { name: 'VolumeModificationRateExceeded' });
    expect(growErrorMessage(err)).toBe('EBS allows one change to a disk every six hours, and this one was changed less than six hours ago. Try again later.');
    expect(growErrorMessage(new Error('something else'))).toBe('EC2 refused the change: something else');
  });

  it('writes the owner’s row with actorRole owner and records the new size on the box', async () => {
    boxEvents.length = 0;
    await startGrow({ ...box, name: 'olive' }, volume, 200, 'ada', fast, 'u-ada', 'owner');
    expect(await settled('inst_1')).toMatchObject({ state: 'done' });
    await new Promise(r => setTimeout(r, 5));
    expect(boxEvents[0]).toMatchObject({ kind: 'disk-grow', actorId: 'u-ada', actorRole: 'owner', from: '152 GB', to: '200 GB', phase: 'done' });
    expect(instanceUpdates).toContainEqual({ where: { id: 'inst_1' }, data: { diskGiB: 200 } });
  });

  it('waitForGrow resolves once the box’s grow has finished, and at once when none runs', async () => {
    await expect(waitForGrow('inst_1', { pollMs: 1, timeoutMs: 1_000 })).resolves.toBeNull();
    ec2.states = ['modifying', 'modifying', 'optimizing'];
    await startGrow(box, volume, 200, 'ada', fast, 'u-ada', 'owner');
    expect(await waitForGrow('inst_1', { pollMs: 1, timeoutMs: 1_000 })).toMatchObject({ state: 'done' });
  });

  it('waitForGrow throws when the grow is still running at its limit, so a resize never stops the box under it (Bugbot on #1214)', async () => {
    ec2.states = ['modifying'];
    await startGrow(box, volume, 200, 'ada', { ...fast, modifyTimeoutMs: 60_000 }, 'u-ada', 'owner');
    await expect(waitForGrow('inst_1', { pollMs: 1, timeoutMs: 20 })).rejects.toThrow(/still growing.*not stopped/);
  });

  it('a reservation counts as a running grow from before the volume is read, and lets go once released (Devin on #1214)', () => {
    const release = reserveGrow('inst_1');
    expect(growRunning('inst_1')).toBe(true);
    expect(growRefusal(box, ['disk-grow-v1'])).toMatch(/already running/);
    release();
    expect(growRunning('inst_1')).toBe(false);
  });

  it('offers a same-size retry after a grow whose file system step failed, even inside the six hours (Devin on #1214)', async () => {
    agent.replies = [{ ok: false, error: 'the agent went away' }];
    await startGrow(box, volume, 200, 'ada', fast, 'u-ada', 'owner');
    await settled('inst_1');
    // EBS has grown the volume to 200 GB within the hour; only the file system step is left.
    const grown = { ...volume, sizeGb: 200, modification: { state: 'optimizing', progress: 50, targetSizeGb: 200, startedAt: '2026-11-03T11:30:00Z' } };
    const view = diskView({ ...box, diskGiB: 120 }, ['disk-grow-v1'], grown, now);
    expect(view.refusal).toMatch(/six hours/);
    expect(view.retry).toEqual({ sizeGb: 200, error: 'the agent went away' });
    expect(parseOwnerGrowBody({ sizeGb: 200 }, grown, now)).toEqual({ sizeGb: 200 });
    // No retry when the box can't run the step, or the last grow didn't fail at the volume's size.
    expect(diskView({ ...box, status: 'stopped', diskGiB: 120 }, ['disk-grow-v1'], grown, now).retry).toBeNull();
    expect(diskView({ ...box, diskGiB: 120 }, ['disk-grow-v1'], { ...grown, sizeGb: 250 }, now).retry).toBeNull();
  });

  it('offers the retry from the disk-grow row after a restart lost the grow in memory (Devin on #1214)', () => {
    const grown = { ...volume, sizeGb: 200, modification: { state: 'completed', progress: 100, targetSizeGb: 200, startedAt: '2026-11-03T11:30:00Z' } };
    const failed = { phase: 'failed', finishedAt: new Date(now - 60_000), startedAt: new Date(now - 600_000), error: 'growpart: FAILED', detail: { toGb: 200 } };
    expect(diskView({ ...box, diskGiB: 120 }, ['disk-grow-v1'], grown, now, failed).retry).toEqual({ sizeGb: 200, error: 'growpart: FAILED' });
    // Cut off mid-grow by a restart: open past the stale hour, and no grow in this process.
    const cutOff = { phase: 'filesystem', finishedAt: null, startedAt: new Date(now - 2 * 3_600_000), error: null, detail: { toGb: 200 } };
    expect(diskView({ ...box, diskGiB: 120 }, ['disk-grow-v1'], grown, now, cutOff).retry).toEqual({ sizeGb: 200, error: expect.stringMatching(/cut off/) });
    // Done, or for another size: nothing to finish.
    expect(diskView({ ...box, diskGiB: 120 }, ['disk-grow-v1'], grown, now, { ...failed, phase: 'done', error: null }).retry).toBeNull();
    expect(diskView({ ...box, diskGiB: 120 }, ['disk-grow-v1'], grown, now, { ...failed, detail: { toGb: 250 } }).retry).toBeNull();
  });

  it('a fresh open row is a grow still running (maybe in another process): no retry, and a grow is refused (Cursor on #1214)', () => {
    const grown = { ...volume, sizeGb: 200, modification: { state: 'optimizing', progress: 50, targetSizeGb: 200, startedAt: '2026-11-03T11:50:00Z' } };
    const running = { phase: 'filesystem', finishedAt: null, startedAt: new Date(now - 600_000), error: null, detail: { toGb: 200 } };
    const view = diskView({ ...box, diskGiB: 120 }, ['disk-grow-v1'], grown, now, running);
    expect(view.retry).toBeNull();
    expect(view.refusal).toBe('a grow is already running on this box');
  });

  it('diskView: the size, the owner’s cap, why a grow is refused now and the last grow', async () => {
    const view = diskView({ ...box, diskGiB: 120 }, ['disk-grow-v1'], volume, now);
    expect(view).toEqual({ sizeGb: 152, maxGb: 300, refusal: null, grow: null, retry: null });
    expect(diskView({ ...box, status: 'stopped', diskGiB: 120 }, ['disk-grow-v1'], volume, now).refusal).toMatch(/stopped; start it first/);
    expect(diskView({ ...box, diskGiB: 120 }, ['disk-grow-v1'], modifiedAt('2026-11-03T10:00:00Z'), now).refusal).toMatch(/six hours/);
    expect(diskView({ ...box, diskGiB: 120 }, ['disk-grow-v1'], { ...volume, sizeGb: 300 }, now).refusal).toMatch(/already 300 GB/);
    // EC2 couldn't be asked: the recorded size, and no grow.
    expect(diskView({ ...box, diskGiB: 120 }, ['disk-grow-v1'], { error: 'boom' }, now)).toEqual({ sizeGb: 120, maxGb: 300, refusal: 'Could not read the disk: boom', grow: null, retry: null });
    await startGrow(box, volume, 200, 'ada', fast, 'u-ada', 'owner');
    await settled('inst_1');
    expect(diskView({ ...box, diskGiB: 200 }, ['disk-grow-v1'], { ...volume, sizeGb: 200 }, now).grow).toMatchObject({ fromGb: 152, toGb: 200, state: 'done', running: false });
  });
});
