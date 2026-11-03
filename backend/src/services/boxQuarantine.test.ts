import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EC2Client } from '@aws-sdk/client-ec2';
import type { IAMClient } from '@aws-sdk/client-iam';

// In-memory instances, tokens and projects with the Prisma semantics boxQuarantine uses.
const db = {
  instances: new Map<string, Record<string, any>>(),
  tokens: [] as Array<Record<string, any>>,
  projects: [] as Array<Record<string, any>>,
  users: new Map<string, { id: string; googleEmail: string }>([['admin-1', { id: 'admin-1', googleEmail: 'admin@example.com' }]]),
};
const matches = (row: Record<string, any>, where: Record<string, any>) =>
  Object.entries(where).every(([k, v]) => (row[k] ?? null) === v);
const updateMany = (rows: Iterable<Record<string, any>>) => async ({ where, data }: any) => {
  let count = 0;
  for (const row of rows) if (matches(row, where)) { Object.assign(row, data); count++; }
  return { count };
};
const prismaFake = {
  instance: {
    findUnique: async ({ where }: any) => (db.instances.has(where.id) ? { ...db.instances.get(where.id) } : null),
    findMany: async () => [...db.instances.values()].map(r => ({ ...r })),
    updateMany: (args: any) => updateMany(db.instances.values())(args),
    update: async ({ where, data }: any) => Object.assign(db.instances.get(where.id)!, data),
  },
  user: { findUnique: async ({ where }: any) => db.users.get(where.id) ?? null },
  agentToken: { updateMany: (args: any) => updateMany(db.tokens)(args) },
  project: { updateMany: (args: any) => updateMany(db.projects)(args) },
  $transaction: async (arg: any) => (typeof arg === 'function' ? arg(prismaFake) : Promise.all(arg)),
};
vi.mock('../db', () => ({ prisma: prismaFake }));

const dropped: string[] = [];
vi.mock('./agentRegistry', () => ({ dropInstanceAgent: (id: string) => { dropped.push(id); return true; } }));
const notified: Array<[string, string]> = [];
vi.mock('./workspaceEvents', () => ({
  notifyOnSuccess: (r: unknown) => r,
  notifyWorkspaceChange: (owner: string, what: string) => { notified.push([owner, what]); },
}));

const provisioner = { configured: true, referencing: [] as string[], terminated: [] as string[] };
vi.mock('./boxProvisioner', () => ({
  getBoxConfig: () => (provisioner.configured
    ? { region: 'us-east-2', managedTag: 'termag-box', hostSecurityGroupId: 'sg-host', resourcePrefix: 'termag-box' }
    : null),
  awsClientConfig: () => ({ region: 'us-east-2' }),
  findSecurityGroupsReferencing: async () => {
    if (!provisioner.referencing) throw Object.assign(new Error('not allowed (fake)'), { name: 'UnauthorizedOperation' });
    return provisioner.referencing;
  },
  revokeTargets: (host: string | undefined, referencing: string[], box: string) =>
    [...new Set([...(host ? [host] : []), ...referencing])].filter(id => id !== box),
  terminateBox: async (row: { id: string }) => { provisioner.terminated.push(row.id); return true; },
}));

const { quarantineBox, quarantineBoxAnswer, terminateQuarantinedBox, resumeQuarantineAfterLaunch, sweepUncontainedQuarantines, quarantineTiming } = await import('./boxQuarantine');

/**
 * A fake EC2 + IAM pair: records each command, answers like AWS, refuses what
 * `refuse` names. A stop settles at once unless `state.settleAfter` describes
 * are to report `stopping` first; `existing` is what DescribeSnapshots finds.
 */
function fakeAws() {
  const sent: Array<{ name: string; input: any }> = [];
  const refuse = new Map<string, string>();
  let snapshots = 0;
  const state = { ec2: 'running' as string, settleAfter: 0 };
  const existing: Array<{ SnapshotId: string; VolumeId: string; State?: string }> = [];
  const send = async (cmd: { constructor: { name: string }; input: any }) => {
    const name = cmd.constructor.name.replace(/Command$/, '');
    sent.push({ name, input: cmd.input });
    const err = refuse.get(name);
    if (err) throw Object.assign(new Error(`${err} (fake)`), { name: err });
    switch (name) {
      case 'DescribeInstances':
        if (state.ec2 === 'stopping' && state.settleAfter-- <= 0) state.ec2 = 'stopped';
        return { Reservations: [{ Instances: [{ State: { Name: state.ec2 }, BlockDeviceMappings: [
          { DeviceName: '/dev/sda1', Ebs: { VolumeId: 'vol-root' } },
          { DeviceName: '/dev/sdf', Ebs: { VolumeId: 'vol-data' } },
        ] }] }] };
      case 'DescribeSecurityGroups':
        return { SecurityGroups: [{
          GroupId: 'sg-box',
          IpPermissions: [{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, UserIdGroupPairs: [{ GroupId: 'sg-alb' }] }],
          IpPermissionsEgress: [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }],
        }] };
      case 'StopInstances': state.ec2 = 'stopping'; return {};
      case 'DescribeSnapshots': return { Snapshots: existing };
      case 'CreateSnapshot': return { SnapshotId: `snap-${++snapshots}` };
      default: return {};
    }
  };
  const clients = { ec2: { send } as unknown as EC2Client, iam: { send } as unknown as IAMClient };
  return { sent, refuse, state, existing, clients, names: () => sent.map(c => c.name) };
}

const admin = { id: 'admin-1', googleEmail: 'admin@example.com' };

function seedBox(extra: Record<string, any> = {}) {
  const row = {
    id: 'box-1', name: 'jackbox01', userId: 'owner-1', kind: 'ec2', status: 'ready', region: 'us-east-2',
    ec2InstanceId: 'i-0123456789abcdef0', securityGroupId: 'sg-box', iamRoleName: 'termag-box-box-1',
    hibernationConfigured: false, rehibernatePending: false,
    quarantinedAt: null, quarantinedById: null, quarantineReason: null, quarantineFromStatus: null, quarantineSteps: null,
    ...extra,
  };
  db.instances.set(row.id, row);
  return row;
}
const row = () => db.instances.get('box-1')!;
const outcomes = () => Object.fromEntries((row().quarantineSteps as any[]).map(s => [s.step, s.outcome]));

beforeEach(() => {
  db.instances.clear();
  db.tokens = [{ id: 't1', instanceId: 'box-1', revokedAt: null }, { id: 't2', instanceId: 'other', revokedAt: null }];
  db.projects = [{ id: 'p1', instanceId: 'box-1', archived: false }];
  dropped.length = 0;
  notified.length = 0;
  Object.assign(provisioner, { configured: true, referencing: ['sg-host', 'sg-old-host'], terminated: [] });
  Object.assign(quarantineTiming, { stopWaitMs: 0, pollMs: 0 });
});

describe('quarantineBox', () => {
  it('cuts a running box off, stops it and then snapshots every volume, in that order', async () => {
    seedBox();
    const aws = fakeAws();
    const res = await quarantineBox('box-1', admin, 'scanner: credential stealer', aws.clients);

    expect(res.status).toBe(200);
    expect(row()).toMatchObject({
      status: 'quarantined', quarantinedById: 'admin-1', quarantineReason: 'scanner: credential stealer', quarantineFromStatus: 'ready',
    });
    expect(db.tokens.find(t => t.id === 't1')!.revokedAt).toBeInstanceOf(Date);
    expect(db.tokens.find(t => t.id === 't2')!.revokedAt).toBeNull();
    expect(dropped).toEqual(['box-1']);
    expect(aws.names()).toEqual([
      'DescribeInstances', 'CreateTags', 'PutRolePolicy',
      'DescribeSecurityGroups', 'RevokeSecurityGroupIngress', 'RevokeSecurityGroupEgress',
      'RevokeSecurityGroupIngress', 'RevokeSecurityGroupIngress',
      'StopInstances', 'DescribeInstances', 'DescribeSnapshots', 'CreateSnapshot', 'CreateSnapshot',
    ]);
    expect(outcomes()).toEqual({ tokens: 'done', tag: 'done', iam: 'done', network: 'done', snapshot: 'done', stop: 'done' });
    // The project stays put: it is evidence too, and only the terminate archives it.
    expect(db.projects[0].archived).toBe(false);
  });

  it('denies everything to the box role and tags what it sends with ASCII only', async () => {
    seedBox();
    const aws = fakeAws();
    await quarantineBox('box-1', admin, 'stealer — see the incident', aws.clients);
    const put = aws.sent.find(c => c.name === 'PutRolePolicy')!.input;
    expect(put).toMatchObject({ RoleName: 'termag-box-box-1', PolicyName: 'termag-quarantine-deny-all' });
    expect(JSON.parse(put.PolicyDocument).Statement[0]).toMatchObject({ Effect: 'Deny', Action: '*', Resource: '*' });
    const tags = aws.sent.find(c => c.name === 'CreateTags')!.input.Tags;
    expect(tags).toContainEqual({ Key: 'QuarantineReason', Value: 'stealer ? see the incident' });
    const snap = aws.sent.find(c => c.name === 'CreateSnapshot')!.input;
    expect(snap.TagSpecifications[0].Tags).toContainEqual({ Key: 'Retain', Value: 'true' });
  });

  it('removes the box SG rules exactly as described and the :3040 rule on every SG that admits it', async () => {
    seedBox();
    const aws = fakeAws();
    await quarantineBox('box-1', admin, 'r', aws.clients);
    const revokes = aws.sent.filter(c => c.name.startsWith('RevokeSecurityGroup')).map(c => c.input);
    expect(revokes[0]).toEqual({ GroupId: 'sg-box', IpPermissions: [expect.objectContaining({ FromPort: 443 })] });
    expect(revokes[1]).toEqual({ GroupId: 'sg-box', IpPermissions: [expect.objectContaining({ IpProtocol: '-1' })] });
    expect(revokes.slice(2).map(r => r.GroupId)).toEqual(['sg-host', 'sg-old-host']);
    expect(revokes[2].IpPermissions[0]).toMatchObject({ FromPort: 3040, UserIdGroupPairs: [{ GroupId: 'sg-box' }] });
  });

  it('leaves the network step failed when it could not find every group that admits the box, so a retry looks again', async () => {
    seedBox();
    const aws = fakeAws();
    provisioner.referencing = null as any;
    await quarantineBox('box-1', admin, 'r', aws.clients);
    expect(outcomes().network).toBe('failed');
    expect((row().quarantineSteps as any[]).find(s => s.step === 'network').detail).toMatch(/tried the host security group only/);

    provisioner.referencing = ['sg-host', 'sg-old-host'];
    const retry = fakeAws();
    await quarantineBox('box-1', admin, 'r', retry.clients);
    expect(retry.sent.filter(c => c.name === 'RevokeSecurityGroupIngress').map(c => c.input.GroupId)).toContain('sg-old-host');
    expect(outcomes().network).toBe('done');
  });

  it('keeps going past a step the IAM grant refuses, and records it as failed', async () => {
    seedBox();
    const aws = fakeAws();
    aws.refuse.set('CreateTags', 'UnauthorizedOperation');
    aws.refuse.set('CreateSnapshot', 'UnauthorizedOperation');
    const res = await quarantineBox('box-1', admin, 'r', aws.clients);
    expect(res.status).toBe(200);
    expect((res.body as any).failed).toEqual(['tag', 'snapshot']);
    expect(outcomes()).toMatchObject({ tag: 'failed', iam: 'done', network: 'done', snapshot: 'failed', stop: 'done' });
    expect((row().quarantineSteps as any[]).find(s => s.step === 'tag').detail).toMatch(/UnauthorizedOperation/);
  });

  it('a retry runs only what did not finish, and never snapshots a volume twice', async () => {
    seedBox();
    const first = fakeAws();
    first.refuse.set('StopInstances', 'UnauthorizedOperation');
    await quarantineBox('box-1', admin, 'first reason', first.clients);
    expect(outcomes().stop).toBe('failed');

    const retry = fakeAws();
    const res = await quarantineBox('box-1', admin, 'second reason', retry.clients);
    expect(res.status).toBe(200);
    expect(retry.names()).toEqual(['DescribeInstances', 'StopInstances']);
    expect(outcomes()).toEqual({ tokens: 'done', tag: 'done', iam: 'done', network: 'done', snapshot: 'done', stop: 'done' });
    expect(row().quarantineReason).toBe('first reason');
    const snaps = (row().quarantineSteps as any[]).find(s => s.step === 'snapshot').snapshots;
    expect(snaps.map((s: any) => s.volumeId)).toEqual(['vol-root', 'vol-data']);
  });

  it('snapshots only the volumes a partial run missed', async () => {
    seedBox();
    const first = fakeAws();
    let calls = 0;
    const send = first.clients.ec2.send.bind(first.clients.ec2);
    (first.clients.ec2 as any).send = async (cmd: any) => {
      if (cmd.constructor.name === 'CreateSnapshotCommand' && ++calls === 2) throw Object.assign(new Error('throttled'), { name: 'RequestLimitExceeded' });
      return send(cmd);
    };
    await quarantineBox('box-1', admin, 'r', first.clients);
    expect(outcomes().snapshot).toBe('failed');

    const retry = fakeAws();
    await quarantineBox('box-1', admin, 'r', retry.clients);
    expect(retry.sent.filter(c => c.name === 'CreateSnapshot').map(c => c.input.VolumeId)).toEqual(['vol-data']);
    const snaps = (row().quarantineSteps as any[]).find(s => s.step === 'snapshot').snapshots;
    expect(snaps.map((s: any) => s.volumeId)).toEqual(['vol-root', 'vol-data']);
  });

  it('writes each step and each snapshot id as it lands, so a restart mid-run loses none', async () => {
    seedBox();
    const aws = fakeAws();
    let midRun: any[] | null = null;
    const send = aws.clients.ec2.send.bind(aws.clients.ec2);
    (aws.clients.ec2 as any).send = async (cmd: any) => {
      if (cmd.constructor.name === 'CreateSnapshotCommand' && cmd.input.VolumeId === 'vol-data') midRun = structuredClone(row().quarantineSteps);
      return send(cmd);
    };
    await quarantineBox('box-1', admin, 'r', aws.clients);
    expect(midRun!.map(s => s.step)).toEqual(['tokens', 'tag', 'iam', 'network', 'stop', 'snapshot']);
    const snap = midRun!.find(s => s.step === 'snapshot');
    expect(snap.outcome).toBe('failed');
    expect(snap.snapshots.map((x: any) => x.volumeId)).toEqual(['vol-root']);
    expect(outcomes().snapshot).toBe('done');
  });

  it('a retry by another admin still tags the admin who quarantined the box', async () => {
    db.users.set('admin-2', { id: 'admin-2', googleEmail: 'second@example.com' });
    seedBox();
    const first = fakeAws();
    first.refuse.set('CreateTags', 'UnauthorizedOperation');
    await quarantineBox('box-1', admin, 'r', first.clients);

    const retry = fakeAws();
    await quarantineBox('box-1', { id: 'admin-2', googleEmail: 'second@example.com' }, 'r', retry.clients);
    expect(retry.sent.find(c => c.name === 'CreateTags')!.input.Tags).toContainEqual({ Key: 'QuarantinedBy', Value: 'admin@example.com' });
    expect(row().quarantinedById).toBe('admin-1');
  });

  it('does not ask EC2 to stop a box that is already stopped', async () => {
    seedBox({ status: 'stopped' });
    const aws = fakeAws();
    aws.state.ec2 = 'stopped';
    await quarantineBox('box-1', admin, 'r', aws.clients);
    expect(aws.names()).not.toContain('StopInstances');
    expect(outcomes().stop).toBe('skipped');
    expect(row().quarantineFromStatus).toBe('stopped');
  });

  it('hibernates a hibernation-capable box so its memory is kept, and falls back to a stop if EC2 refuses', async () => {
    seedBox({ hibernationConfigured: true });
    const aws = fakeAws();
    await quarantineBox('box-1', admin, 'r', aws.clients);
    expect(aws.sent.find(c => c.name === 'StopInstances')!.input).toEqual({ InstanceIds: ['i-0123456789abcdef0'], Hibernate: true });

    db.instances.clear();
    seedBox({ hibernationConfigured: true });
    const refused = fakeAws();
    const send = refused.clients.ec2.send.bind(refused.clients.ec2);
    (refused.clients.ec2 as any).send = async (cmd: any) => {
      if (cmd.constructor.name === 'StopInstancesCommand' && cmd.input.Hibernate) {
        throw Object.assign(new Error('Instance is not ready to hibernate yet'), { name: 'UnsupportedOperation' });
      }
      return send(cmd);
    };
    await quarantineBox('box-1', admin, 'r', refused.clients);
    expect(refused.sent.filter(c => c.name === 'StopInstances').map(c => c.input)).toEqual([{ InstanceIds: ['i-0123456789abcdef0'] }]);
    expect(outcomes().stop).toBe('done');
  });

  it('a self-managed box gets its tokens revoked and every AWS step skipped', async () => {
    seedBox({ kind: 'external', ec2InstanceId: null, securityGroupId: null, iamRoleName: null });
    const aws = fakeAws();
    await quarantineBox('box-1', admin, 'r', aws.clients);
    expect(aws.sent).toEqual([]);
    expect(outcomes()).toEqual({ tokens: 'done', tag: 'skipped', iam: 'skipped', network: 'skipped', snapshot: 'skipped', stop: 'skipped' });
    expect(db.tokens.find(t => t.id === 't1')!.revokedAt).toBeInstanceOf(Date);
  });

  it('contains the instance a launch recorded after the request read the row', async () => {
    seedBox({ status: 'provisioning', ec2InstanceId: null });
    const original = prismaFake.instance.findUnique;
    let reads = 0;
    prismaFake.instance.findUnique = async (args: any) => {
      // The launch writes its instance between the request's read and the claim.
      if (++reads === 2) db.instances.get('box-1')!.ec2InstanceId = 'i-late';
      return original(args);
    };
    try {
      const aws = fakeAws();
      await quarantineBox('box-1', admin, 'r', aws.clients);
      expect(aws.sent.find(c => c.name === 'StopInstances')!.input).toEqual({ InstanceIds: ['i-late'] });
      expect(outcomes()).toMatchObject({ tag: 'done', snapshot: 'done', stop: 'done' });
    } finally {
      prismaFake.instance.findUnique = original;
    }
  });

  it('contains the instance a launch recorded while the run was skipping the AWS steps', async () => {
    seedBox({ status: 'provisioning', ec2InstanceId: null });
    const original = prismaFake.instance.update;
    let writes = 0;
    prismaFake.instance.update = async (args: any) => {
      // After the run read the row and found no instance: the launch's follow-up can't run yet.
      if (++writes === 2) db.instances.get('box-1')!.ec2InstanceId = 'i-late';
      return original(args);
    };
    try {
      const aws = fakeAws();
      const res = await quarantineBox('box-1', admin, 'r', aws.clients);
      expect(res.status).toBe(200);
      expect(aws.sent.find(c => c.name === 'StopInstances')!.input).toEqual({ InstanceIds: ['i-late'] });
      expect(outcomes()).toEqual({ tokens: 'done', tag: 'done', iam: 'done', network: 'done', snapshot: 'done', stop: 'done' });
    } finally {
      prismaFake.instance.update = original;
    }
  });

  it('a launch that lands after the run re-runs the skipped AWS steps as the admin who quarantined it', async () => {
    seedBox({ status: 'provisioning', ec2InstanceId: null });
    await quarantineBox('box-1', admin, 'mid-launch', fakeAws().clients);
    expect(outcomes()).toMatchObject({ tokens: 'done', tag: 'skipped', snapshot: 'skipped', stop: 'skipped' });

    row().ec2InstanceId = 'i-late';
    const aws = fakeAws();
    const { EC2Client } = await import('@aws-sdk/client-ec2');
    const send = vi.spyOn(EC2Client.prototype, 'send').mockImplementation(((cmd: any) => aws.clients.ec2.send(cmd)) as any);
    const { IAMClient } = await import('@aws-sdk/client-iam');
    const iamSend = vi.spyOn(IAMClient.prototype, 'send').mockImplementation(((cmd: any) => aws.clients.iam.send(cmd)) as any);
    try {
      await resumeQuarantineAfterLaunch('box-1', 0);
    } finally {
      send.mockRestore();
      iamSend.mockRestore();
    }
    expect(aws.names()).toContain('StopInstances');
    expect(outcomes()).toEqual({ tokens: 'done', tag: 'done', iam: 'done', network: 'done', snapshot: 'done', stop: 'done' });
    expect(aws.sent.find(c => c.name === 'CreateTags')!.input.Tags).toContainEqual({ Key: 'QuarantinedBy', Value: 'admin@example.com' });
  });

  it('the provisioning sweep contains an instance whose launch follow-up was lost to a restart', async () => {
    seedBox({ status: 'provisioning', ec2InstanceId: null });
    await quarantineBox('box-1', admin, 'mid-launch', fakeAws().clients);
    // The launch recorded its instance, and the process restarted before its follow-up ran.
    row().ec2InstanceId = 'i-late';

    const aws = fakeAws();
    const { EC2Client } = await import('@aws-sdk/client-ec2');
    const send = vi.spyOn(EC2Client.prototype, 'send').mockImplementation(((cmd: any) => aws.clients.ec2.send(cmd)) as any);
    const { IAMClient } = await import('@aws-sdk/client-iam');
    const iamSend = vi.spyOn(IAMClient.prototype, 'send').mockImplementation(((cmd: any) => aws.clients.iam.send(cmd)) as any);
    try {
      // Too soon: a run that just claimed the box may still be going on another process.
      expect(await sweepUncontainedQuarantines(row().quarantinedAt.getTime() + 1000)).toBe(0);
      expect(aws.sent).toEqual([]);
      const later = row().quarantinedAt.getTime() + 15 * 60_000;
      expect(await sweepUncontainedQuarantines(later)).toBe(1);
      expect(outcomes()).toEqual({ tokens: 'done', tag: 'done', iam: 'done', network: 'done', snapshot: 'done', stop: 'done' });
      // Contained now, so the next tick leaves it alone.
      expect(await sweepUncontainedQuarantines(later)).toBe(0);
    } finally {
      send.mockRestore();
      iamSend.mockRestore();
    }
  });

  it('waits for the stop to settle before it snapshots, so the disks are copied quiet', async () => {
    Object.assign(quarantineTiming, { stopWaitMs: 60_000, pollMs: 1 });
    seedBox();
    const aws = fakeAws();
    aws.state.settleAfter = 2;
    await quarantineBox('box-1', admin, 'r', aws.clients);
    const afterStop = aws.names().slice(aws.names().indexOf('StopInstances') + 1);
    expect(afterStop).toEqual(['DescribeInstances', 'DescribeInstances', 'DescribeInstances', 'DescribeSnapshots', 'CreateSnapshot', 'CreateSnapshot']);
    expect(outcomes().snapshot).toBe('done');
    expect((row().quarantineSteps as any[]).find(s => s.step === 'snapshot').detail).not.toMatch(/taken while/);
  });

  it('still snapshots a box the stop failed on, at once and saying it was running', async () => {
    // A refused stop never settles the instance, so waiting would only give it longer to change its disks.
    Object.assign(quarantineTiming, { stopWaitMs: 60_000, pollMs: 1 });
    seedBox();
    const aws = fakeAws();
    aws.refuse.set('StopInstances', 'UnauthorizedOperation');
    await quarantineBox('box-1', admin, 'r', aws.clients);
    expect(outcomes()).toMatchObject({ stop: 'failed', snapshot: 'done' });
    expect((row().quarantineSteps as any[]).find(s => s.step === 'snapshot').detail).toMatch(/taken while EC2 still reported it running/);
    const afterStop = aws.names().slice(aws.names().indexOf('StopInstances') + 1);
    expect(afterStop).toEqual(['DescribeInstances', 'DescribeSnapshots', 'CreateSnapshot', 'CreateSnapshot']);
  });

  it('does not snapshot again a volume EC2 already has this quarantine\'s snapshot of', async () => {
    seedBox();
    const aws = fakeAws();
    aws.existing.push({ SnapshotId: 'snap-lost', VolumeId: 'vol-root', State: 'pending' });
    await quarantineBox('box-1', admin, 'r', aws.clients);
    const lookup = aws.sent.find(c => c.name === 'DescribeSnapshots')!.input;
    expect(lookup.Filters).toEqual([
      { Name: 'tag:QuarantinedInstance', Values: ['i-0123456789abcdef0'] },
      { Name: 'tag:Quarantined', Values: [row().quarantinedAt.toISOString()] },
    ]);
    expect(aws.sent.filter(c => c.name === 'CreateSnapshot').map(c => c.input.VolumeId)).toEqual(['vol-data']);
    const snaps = (row().quarantineSteps as any[]).find(s => s.step === 'snapshot').snapshots;
    expect(snaps).toEqual([
      { volumeId: 'vol-root', device: '/dev/sda1', snapshotId: 'snap-lost' },
      { volumeId: 'vol-data', device: '/dev/sdf', snapshotId: 'snap-1' },
    ]);
  });

  it('snapshots every volume when the lookup of earlier ones is refused', async () => {
    seedBox();
    const aws = fakeAws();
    aws.refuse.set('DescribeSnapshots', 'UnauthorizedOperation');
    await quarantineBox('box-1', admin, 'r', aws.clients);
    expect(aws.sent.filter(c => c.name === 'CreateSnapshot')).toHaveLength(2);
    expect(outcomes().snapshot).toBe('done');
  });

  it('the sweep finishes a run cut short between the stop and the snapshot, and tries a box at most once per retry window', async () => {
    seedBox({ id: 'box-cut' });
    db.instances.delete('box-1');
    const cut = db.instances.get('box-cut')!;
    Object.assign(cut, { status: 'quarantined', quarantinedAt: new Date(Date.parse('2026-10-23T18:00:00Z')), quarantinedById: 'admin-1', quarantineReason: 'r',
      quarantineSteps: ['tokens', 'tag', 'iam', 'network', 'stop'].map(step => ({ step, outcome: 'done', detail: '', at: '2026-10-23T18:00:01Z' })) });
    const aws = fakeAws();
    aws.state.ec2 = 'stopped';
    const { EC2Client } = await import('@aws-sdk/client-ec2');
    const send = vi.spyOn(EC2Client.prototype, 'send').mockImplementation(((cmd: any) => aws.clients.ec2.send(cmd)) as any);
    // Every write of the results fails, so the run never looks finished.
    const update = prismaFake.instance.update;
    prismaFake.instance.update = async () => { throw new Error('db down'); };
    try {
      const later = cut.quarantinedAt.getTime() + 15 * 60_000;
      expect(await sweepUncontainedQuarantines(later)).toBe(1);
      expect(aws.names()).toEqual(['DescribeInstances', 'DescribeInstances', 'DescribeSnapshots', 'CreateSnapshot', 'CreateSnapshot']);
      // Not again on the next tick, which would take another set of snapshots.
      expect(await sweepUncontainedQuarantines(later + 60_000)).toBe(0);
      expect(aws.sent.filter(c => c.name === 'CreateSnapshot')).toHaveLength(2);
    } finally {
      prismaFake.instance.update = update;
      send.mockRestore();
    }
  });

  it('answers the request while the snapshot still waits out the stop, and the run carries on', async () => {
    Object.assign(quarantineTiming, { stopWaitMs: 60_000, pollMs: 5 });
    seedBox();
    const aws = fakeAws();
    aws.state.settleAfter = 1_000_000;
    const res = await quarantineBoxAnswer('box-1', admin, 'r', 20, aws.clients);
    expect(res).toEqual({ status: 202, body: { id: 'box-1', status: 'quarantined', running: true } });
    // The owner's list was told at the claim, not left until the snapshots end.
    expect(notified).toEqual([['owner-1', 'boxes'], ['owner-1', 'projects']]);
    expect(outcomes()).toMatchObject({ tokens: 'done', stop: 'done' });
    expect(outcomes().snapshot).toBeUndefined();
    aws.state.settleAfter = 0;
    await vi.waitFor(() => expect(outcomes().snapshot).toBe('done'));
  });

  it('answers with the run itself when it finishes in time', async () => {
    seedBox();
    const res = await quarantineBoxAnswer('box-1', admin, 'r', 5_000, fakeAws().clients);
    expect(res.status).toBe(200);
    expect((res.body as any).failed).toEqual([]);
  });

  it('refuses a terminated box and answers a conflict when the row moved under it', async () => {
    seedBox({ status: 'terminated' });
    expect((await quarantineBox('box-1', admin, 'r', fakeAws().clients)).status).toBe(409);
    expect((await quarantineBox('nope', admin, 'r', fakeAws().clients)).status).toBe(404);

    seedBox();
    const original = prismaFake.instance.findUnique;
    prismaFake.instance.findUnique = async (args: any) => {
      const r = await original(args);
      if (r) db.instances.get('box-1')!.status = 'stopping';
      return r;
    };
    try {
      expect((await quarantineBox('box-1', admin, 'r', fakeAws().clients)).status).toBe(409);
      expect(db.tokens.find(t => t.id === 't1')!.revokedAt).toBeNull();
    } finally {
      prismaFake.instance.findUnique = original;
    }
  });
});

describe('terminateQuarantinedBox', () => {
  it('terminates only a quarantined box, archives its projects and tears the EC2 down', async () => {
    seedBox();
    expect((await terminateQuarantinedBox('box-1', admin)).status).toBe(409);
    expect(provisioner.terminated).toEqual([]);

    await quarantineBox('box-1', admin, 'r', fakeAws().clients);
    const res = await terminateQuarantinedBox('box-1', admin);
    expect(res).toEqual({ status: 200, body: { ok: true, archivedProjects: 1 } });
    expect(row().status).toBe('terminated');
    expect(row().quarantineSteps).not.toBeNull();
    expect(db.projects[0].archived).toBe(true);
    expect(provisioner.terminated).toEqual(['box-1']);
  });
});
