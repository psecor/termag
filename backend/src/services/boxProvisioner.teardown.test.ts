import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '@prisma/client';

// ── An in-memory Instance table with the Prisma semantics the provisioner uses ──

const rows = new Map<string, Record<string, any>>();
/** Makes prisma.instance.update throw for the data it matches. */
let failUpdate: ((data: Record<string, any>) => boolean) | null = null;

function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === 'AND') return (v as any[]).every(w => matches(row, w));
    if (k === 'OR') return (v as any[]).some(w => matches(row, w));
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('not' in v) return row[k] !== v.not;
      if ('lt' in v) return row[k] != null && row[k] < v.lt;
    }
    if (v instanceof Date) return row[k] instanceof Date && row[k].getTime() === v.getTime();
    return (row[k] ?? null) === v;
  });
}

const byAttemptThenCreated = (a: Record<string, any>, b: Record<string, any>) => {
  const at = a.cleanupAttemptedAt?.getTime() ?? -Infinity;
  const bt = b.cleanupAttemptedAt?.getTime() ?? -Infinity;
  return at - bt || a.createdAt.getTime() - b.createdAt.getTime();
};

vi.mock('../db', () => ({
  prisma: {
    instance: {
      update: async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (!row) throw new Error('Record to update not found');
        if (failUpdate?.(data)) throw new Error('connection terminated unexpectedly');
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: any) => {
        let count = 0;
        for (const row of rows.values()) if (matches(row, where)) { Object.assign(row, data); count++; }
        return { count };
      },
      findMany: async ({ where, take }: any) =>
        [...rows.values()].filter(r => matches(r, where)).sort(byAttemptThenCreated).slice(0, take).map(r => ({ ...r })),
    },
  },
}));
vi.mock('./sshKeySync', () => ({ ownerAuthorizedKeyLines: async () => [] }));

// ── Fake EC2 + IAM, with the NotFound / DeleteConflict behavior of the real ones ──

const aws = {
  instances: new Map<string, string>(),
  sgs: new Set<string>(),
  roles: new Map<string, { inline: Set<string>; attached: Set<string> }>(),
  profiles: new Map<string, Set<string>>(),
  fail: new Map<string, string>(),   // command name -> error name it throws
  before: new Map<string, () => void>(), // command name -> runs once, before it is handled
  sent: [] as string[],
  seq: 0,
};
const awsError = (name: string) => Object.assign(new Error(name), { name });

function command(name: string) {
  return class { name = name; constructor(public input: any) {} };
}

vi.mock('@aws-sdk/client-ec2', () => {
  const names = ['DescribeImages', 'CreateSecurityGroup', 'AuthorizeSecurityGroupIngress', 'RevokeSecurityGroupIngress',
    'DeleteSecurityGroup', 'RunInstances', 'TerminateInstances', 'DescribeInstances', 'DescribeSecurityGroups'];
  const mod: Record<string, unknown> = Object.fromEntries(names.map(n => [`${n}Command`, command(n)]));
  mod.EC2Client = class {
    async send(cmd: { name: string; input: any }) {
      aws.sent.push(cmd.name);
      const hook = aws.before.get(cmd.name);
      if (hook) { aws.before.delete(cmd.name); hook(); }
      const forced = aws.fail.get(cmd.name);
      if (forced) throw awsError(forced);
      const i = cmd.input;
      switch (cmd.name) {
        case 'DescribeImages':
          return { Images: [{ ImageId: 'ami-1', CreationDate: '2026-10-01T00:00:00Z', RootDeviceName: '/dev/sda1', BlockDeviceMappings: [] }] };
        case 'CreateSecurityGroup': { const id = `sg-${++aws.seq}`; aws.sgs.add(id); return { GroupId: id }; }
        case 'RunInstances': { const id = `i-${++aws.seq}`; aws.instances.set(id, 'running'); return { Instances: [{ InstanceId: id }] }; }
        case 'DescribeInstances': {
          const state = aws.instances.get(i.InstanceIds[0]);
          if (!state) throw awsError('InvalidInstanceID.NotFound');
          return { Reservations: [{ Instances: [{ State: { Name: state }, PrivateDnsName: 'ip-10-0-0-1.internal' }] }] };
        }
        case 'TerminateInstances':
          if (!aws.instances.has(i.InstanceIds[0])) throw awsError('InvalidInstanceID.NotFound');
          aws.instances.set(i.InstanceIds[0], 'terminated');
          return {};
        case 'DescribeSecurityGroups': return { SecurityGroups: [] };
        case 'DeleteSecurityGroup':
          if (!aws.sgs.delete(i.GroupId)) throw awsError('InvalidGroup.NotFound');
          return {};
        default: return {};
      }
    }
  };
  return mod;
});

vi.mock('@aws-sdk/client-iam', () => {
  const names = ['CreateRole', 'AttachRolePolicy', 'DetachRolePolicy', 'PutRolePolicy', 'DeleteRolePolicy', 'ListRolePolicies',
    'CreateInstanceProfile', 'AddRoleToInstanceProfile', 'RemoveRoleFromInstanceProfile', 'DeleteInstanceProfile', 'DeleteRole'];
  const mod: Record<string, unknown> = Object.fromEntries(names.map(n => [`${n}Command`, command(n)]));
  mod.IAMClient = class {
    async send(cmd: { name: string; input: any }) {
      aws.sent.push(cmd.name);
      const hook = aws.before.get(cmd.name);
      if (hook) { aws.before.delete(cmd.name); hook(); }
      const forced = aws.fail.get(cmd.name);
      if (forced) throw awsError(forced);
      const i = cmd.input;
      const role = () => {
        const r = aws.roles.get(i.RoleName);
        if (!r) throw awsError('NoSuchEntityException');
        return r;
      };
      const profile = () => {
        const p = aws.profiles.get(i.InstanceProfileName);
        if (!p) throw awsError('NoSuchEntityException');
        return p;
      };
      switch (cmd.name) {
        case 'CreateRole': aws.roles.set(i.RoleName, { inline: new Set(), attached: new Set() }); return {};
        case 'AttachRolePolicy': role().attached.add(i.PolicyArn); return {};
        case 'DetachRolePolicy': if (!role().attached.delete(i.PolicyArn)) throw awsError('NoSuchEntityException'); return {};
        case 'PutRolePolicy': role().inline.add(i.PolicyName); return {};
        case 'DeleteRolePolicy': if (!role().inline.delete(i.PolicyName)) throw awsError('NoSuchEntityException'); return {};
        case 'ListRolePolicies': return { PolicyNames: [...role().inline], IsTruncated: false };
        case 'CreateInstanceProfile': aws.profiles.set(i.InstanceProfileName, new Set()); return {};
        case 'AddRoleToInstanceProfile': role(); profile().add(i.RoleName); return {};
        case 'RemoveRoleFromInstanceProfile': role(); if (!profile().delete(i.RoleName)) throw awsError('NoSuchEntityException'); return {};
        case 'DeleteInstanceProfile': profile(); aws.profiles.delete(i.InstanceProfileName); return {};
        case 'DeleteRole': {
          const r = role();
          const inProfile = [...aws.profiles.values()].some(p => p.has(i.RoleName));
          if (r.inline.size || r.attached.size || inProfile) throw awsError('DeleteConflictException');
          aws.roles.delete(i.RoleName);
          return {};
        }
        default: return {};
      }
    }
  };
  return mod;
});

const { terminateBox, sweepUncleanedTeardowns, provisionPoolBox } = await import('./boxProvisioner');

const PREFIX = 'termag-e2e-box';
const ENV = {
  AWS_REGION: 'us-east-2',
  AGENT_WS_URL: 'ws://127.0.0.1:3040/termag/ws/agent',
  BOX_RESOURCE_PREFIX: PREFIX,
  BOX_PERMISSIONS_BOUNDARY_ARN: 'arn:aws:iam::000000000000:policy/boundary',
  BOX_VPC_ID: 'vpc-1',
  BOX_SUBNET_ID: 'subnet-1',
};
const SSM = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore';
const NOW = new Date('2026-10-06T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

/** A terminated box whose EC2 instance, SG, role, profile and policies all still exist. */
function liveBox(id: string, extra: Record<string, any> = {}): Instance {
  const roleName = `${PREFIX}-${id}`;
  const ec2InstanceId = `i-${id}`;
  const securityGroupId = `sg-${id}`;
  aws.instances.set(ec2InstanceId, 'running');
  aws.sgs.add(securityGroupId);
  aws.roles.set(roleName, { inline: new Set(['termag-git-token-read', 'termag-box-ecr-pull']), attached: new Set([SSM]) });
  aws.profiles.set(roleName, new Set([roleName]));
  return seed(id, { ec2InstanceId, securityGroupId, iamRoleName: roleName, iamInstanceProfileName: roleName, ...extra });
}

function seed(id: string, extra: Record<string, any> = {}): Instance {
  const row = {
    id, name: `box-${id}`, userId: 'u1', kind: 'ec2', status: 'terminated', region: 'us-east-2',
    ec2InstanceId: null, securityGroupId: null, iamRoleName: null, iamInstanceProfileName: null, hostname: null, provisioningError: null,
    createdAt: minutesAgo(120), terminatedAt: minutesAgo(60), cleanedUpAt: null, cleanupAttemptedAt: null,
    ...extra,
  };
  rows.set(id, row);
  return { ...row } as unknown as Instance;
}

const awsIsEmpty = () => {
  expect([...aws.instances.values()].every(s => s === 'terminated')).toBe(true);
  expect(aws.sgs.size).toBe(0);
  expect(aws.roles.size).toBe(0);
  expect(aws.profiles.size).toBe(0);
};

beforeEach(() => {
  rows.clear();
  failUpdate = null;
  aws.instances.clear(); aws.sgs.clear(); aws.roles.clear(); aws.profiles.clear(); aws.fail.clear(); aws.before.clear();
  aws.sent = []; aws.seq = 0;
  for (const k of Object.keys(process.env)) if (k.startsWith('BOX_') || k === 'HOST_SECURITY_GROUP_ID') delete process.env[k];
  Object.assign(process.env, ENV);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('terminateBox', () => {
  it('deletes every resource and stamps cleanedUpAt', async () => {
    const box = liveBox('a');
    expect(await terminateBox(box)).toBe(true);
    awsIsEmpty();
    expect(rows.get('a')!.cleanedUpAt).toBeInstanceOf(Date);
    expect(rows.get('a')!.cleanupAttemptedAt).toBeInstanceOf(Date);
  });

  it('deletes every inline policy the role has, including ones this file never names', async () => {
    const box = liveBox('a');
    aws.roles.get(`${PREFIX}-a`)!.inline.add('added-by-hand');
    expect(await terminateBox(box)).toBe(true);
    expect(aws.roles.size).toBe(0);
  });

  it('treats resources that are already gone as done, without retrying the SG delete', async () => {
    // Every handle recorded, nothing left in AWS: a re-run of a finished teardown.
    const box = seed('a', { ec2InstanceId: 'i-gone', securityGroupId: 'sg-gone', iamRoleName: `${PREFIX}-a` });
    expect(await terminateBox(box)).toBe(true);
    expect(rows.get('a')!.cleanedUpAt).toBeInstanceOf(Date);
    expect(aws.sent.filter(n => n === 'DeleteSecurityGroup')).toHaveLength(1);
    expect(aws.sent).not.toContain('DescribeInstances');
  });

  it('finishes a teardown an earlier run cut short', async () => {
    const box = liveBox('a');
    // The first run got as far as terminating the instance and deleting the SG.
    aws.instances.set('i-a', 'terminated');
    aws.sgs.delete('sg-a');
    expect(await terminateBox(box)).toBe(true);
    awsIsEmpty();
  });

  it('tears down the deterministic role when the launch never recorded it', async () => {
    const box = liveBox('a', { iamRoleName: null, iamInstanceProfileName: null });
    expect(await terminateBox(box)).toBe(true);
    expect(aws.roles.size).toBe(0);
    expect(aws.profiles.size).toBe(0);
  });

  it('leaves cleanedUpAt unset when a step fails, so the sweep retries', async () => {
    const box = liveBox('a');
    aws.fail.set('DeleteRole', 'AccessDenied');
    expect(await terminateBox(box)).toBe(false);
    expect(rows.get('a')!.cleanedUpAt).toBeNull();
    expect(rows.get('a')!.cleanupAttemptedAt).toBeInstanceOf(Date);
    // Steps after the failure's predecessors still ran.
    expect(aws.sgs.size).toBe(0);
  });

  it('falls back to the git-token and ECR pull policy names when listing inline policies fails', async () => {
    const box = liveBox('a');
    aws.fail.set('ListRolePolicies', 'AccessDenied');
    expect(await terminateBox(box)).toBe(true);
    expect(aws.roles.size).toBe(0);
  });

  it('does not stamp a row whose handles changed while it ran', async () => {
    const box = liveBox('a');
    // A launch still in flight recorded a newer instance after this snapshot.
    rows.get('a')!.ec2InstanceId = 'i-later';
    expect(await terminateBox(box)).toBe(false);
    expect(rows.get('a')!.cleanedUpAt).toBeNull();
  });

  it('leaves a row in the sweep when a launch creates the instance profile after teardown deleted it', async () => {
    const roleName = `${PREFIX}-a`;
    // The launch had recorded its role but not yet created the profile.
    const box = liveBox('a', { iamInstanceProfileName: null });
    aws.profiles.delete(roleName);
    aws.roles.get(roleName)!.attached.clear();
    aws.roles.get(roleName)!.inline.clear();
    // Teardown's profile steps found nothing; the launch creates and records it
    // now, then fails AddRoleToInstanceProfile because teardown deletes the role.
    aws.before.set('DetachRolePolicy', () => {
      aws.profiles.set(roleName, new Set());
      rows.get('a')!.iamInstanceProfileName = roleName;
    });
    expect(await terminateBox(box)).toBe(false);
    expect(rows.get('a')!.cleanedUpAt).toBeNull();
    expect(aws.profiles.size).toBe(1);

    expect(await terminateBox({ ...rows.get('a')! } as Instance)).toBe(true);
    awsIsEmpty();
  });

  it('does nothing when box provisioning is not configured', async () => {
    const box = liveBox('a');
    delete process.env.BOX_SUBNET_ID;
    expect(await terminateBox(box)).toBe(false);
    expect(aws.sent).toEqual([]);
    expect(rows.get('a')!.cleanupAttemptedAt).toBeNull();
  });
});

describe('sweepUncleanedTeardowns', () => {
  const settle = () => new Promise(r => setTimeout(r, 20));

  it('re-runs teardown for a terminated box that was never cleaned up', async () => {
    liveBox('a');
    expect(await sweepUncleanedTeardowns(NOW)).toBe(1);
    await settle();
    awsIsEmpty();
    expect(rows.get('a')!.cleanedUpAt).toBeInstanceOf(Date);
  });

  it('skips cleaned, live, external, recently terminated and recently attempted boxes', async () => {
    liveBox('cleaned', { cleanedUpAt: minutesAgo(50) });
    liveBox('live', { status: 'ready', terminatedAt: null });
    seed('external', { kind: 'external' });
    liveBox('fresh', { terminatedAt: minutesAgo(2) });
    liveBox('inflight', { cleanupAttemptedAt: minutesAgo(3) });
    expect(await sweepUncleanedTeardowns(NOW)).toBe(0);
    expect(aws.sent).toEqual([]);
  });

  it('includes a terminated row from before terminatedAt existed', async () => {
    liveBox('old', { terminatedAt: null });
    expect(await sweepUncleanedTeardowns(NOW)).toBe(1);
  });

  it('retries a failed attempt once the window has passed', async () => {
    liveBox('a', { cleanupAttemptedAt: minutesAgo(11) });
    expect(await sweepUncleanedTeardowns(NOW)).toBe(1);
  });

  it('honors BOX_TEARDOWN_RETRY_SECONDS', async () => {
    process.env.BOX_TEARDOWN_RETRY_SECONDS = '30';
    liveBox('a', { terminatedAt: minutesAgo(1), cleanupAttemptedAt: minutesAgo(1) });
    expect(await sweepUncleanedTeardowns(NOW)).toBe(1);
  });

  it('takes a few per tick, never-attempted first, then the longest since an attempt', async () => {
    liveBox('tried-long-ago', { cleanupAttemptedAt: minutesAgo(500) });
    liveBox('tried-recently', { cleanupAttemptedAt: minutesAgo(20) });
    liveBox('never-1');
    liveBox('never-2');
    const seeded = new Map([...rows.values()].map(r => [r.id, r.cleanupAttemptedAt?.getTime()]));
    expect(await sweepUncleanedTeardowns(NOW)).toBe(3);
    const claimed = [...rows.values()].filter(r => r.cleanupAttemptedAt?.getTime() !== seeded.get(r.id)).map(r => r.id).sort();
    expect(claimed).toEqual(['never-1', 'never-2', 'tried-long-ago']);
  });

  it('starts one teardown when two sweeps race for the same row', async () => {
    liveBox('a');
    const [first, second] = await Promise.all([sweepUncleanedTeardowns(NOW), sweepUncleanedTeardowns(NOW)]);
    expect(first + second).toBe(1);
  });

  it('does nothing when box provisioning is not configured', async () => {
    liveBox('a');
    delete process.env.AWS_REGION;
    expect(await sweepUncleanedTeardowns(NOW)).toBe(0);
  });
});

describe('launchBox records each handle as it is created', () => {
  const pool = (id: string) => provisionPoolBox({
    instance: seed(id, { status: 'warming', userId: null, terminatedAt: null, region: null }) as Instance,
    token: 'tmag_test',
    poolSpecHash: 'hash',
  });

  it('records the SG and the role before a failed RunInstances, so teardown finds both', async () => {
    aws.fail.set('RunInstances', 'InsufficientInstanceCapacity');
    expect(await pool('a')).toBe(false);
    const row = rows.get('a')!;
    expect(row).toMatchObject({ status: 'failed', region: 'us-east-2', securityGroupId: 'sg-1', iamRoleName: `${PREFIX}-a`, ec2InstanceId: null });

    row.status = 'terminated';
    expect(await terminateBox({ ...row } as Instance)).toBe(true);
    awsIsEmpty();
  });

  it('records the role as soon as it exists, before its profile', async () => {
    aws.fail.set('CreateInstanceProfile', 'LimitExceeded');
    expect(await pool('a')).toBe(false);
    expect(rows.get('a')).toMatchObject({ securityGroupId: 'sg-1', iamRoleName: `${PREFIX}-a`, iamInstanceProfileName: null });
  });

  it('records the instance profile as soon as it exists, before adding the role to it', async () => {
    aws.fail.set('AddRoleToInstanceProfile', 'ServiceFailure');
    expect(await pool('a')).toBe(false);
    expect(rows.get('a')).toMatchObject({ iamRoleName: `${PREFIX}-a`, iamInstanceProfileName: `${PREFIX}-a` });
  });

  it('records the SG even when the host ingress rule fails', async () => {
    process.env.HOST_SECURITY_GROUP_ID = 'sg-host';
    aws.fail.set('AuthorizeSecurityGroupIngress', 'RulesPerSecurityGroupLimitExceeded');
    expect(await pool('a')).toBe(false);
    expect(rows.get('a')).toMatchObject({ securityGroupId: 'sg-1', iamRoleName: null });
  });

  it('records the instance and its DNS on success', async () => {
    expect(await pool('a')).toBe(true);
    expect(rows.get('a')).toMatchObject({ ec2InstanceId: 'i-2', hostname: 'ip-10-0-0-1.internal', status: 'warming' });
    // A pool box never reads anyone's box-image flag: it is always the published image.
    expect(rows.get('a')).toMatchObject({ imageId: 'ami-1', imageSource: 'published' });
  });

  it('does not fail a running box when only the hostname write fails', async () => {
    failUpdate = data => 'hostname' in data;
    expect(await pool('a')).toBe(true);
    expect(rows.get('a')).toMatchObject({ ec2InstanceId: 'i-2', hostname: null, status: 'warming', provisioningError: null });
  });

  it('reopens a finished teardown when a launch records a resource after it', async () => {
    seed('a', { status: 'terminated', cleanedUpAt: minutesAgo(1) });
    // The launch for this row is still running and creates its SG now.
    aws.fail.set('CreateRole', 'ServiceFailure');
    await provisionPoolBox({ instance: { ...rows.get('a')! } as Instance, token: 'tmag_test', poolSpecHash: 'hash' });
    const row = rows.get('a')!;
    expect(row.securityGroupId).toBe('sg-1');
    expect(row.cleanedUpAt).toBeNull();
    // ...and the failure does not move it out of `terminated`, where the sweep looks.
    expect(row.status).toBe('terminated');
  });
});
