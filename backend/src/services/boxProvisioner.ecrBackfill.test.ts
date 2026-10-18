import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rows: Record<string, any>[] = [];
const queries: any[] = [];
vi.mock('../db', () => ({
  prisma: {
    instance: {
      findMany: async (args: any) => {
        queries.push(args.where);
        return rows.filter(r => r.kind === 'ec2' && r.iamRoleName && r.status !== 'terminated');
      },
    },
  },
}));

// role name -> stored ECR inline policy (URL-encoded, as GetRolePolicy returns it)
const policies = new Map<string, string>();
const iam = { sent: [] as { name: string; input: any }[], failRole: null as string | null, goneRole: null as string | null };
vi.mock('@aws-sdk/client-iam', () => {
  const command = (name: string) => class { constructor(public input: any) {} name = name; };
  const noSuchEntity = () => Object.assign(new Error('not found'), { name: 'NoSuchEntityException' });
  return {
    CreateRoleCommand: command('CreateRole'),
    AttachRolePolicyCommand: command('AttachRolePolicy'),
    DetachRolePolicyCommand: command('DetachRolePolicy'),
    PutRolePolicyCommand: command('PutRolePolicy'),
    DeleteRolePolicyCommand: command('DeleteRolePolicy'),
    GetRolePolicyCommand: command('GetRolePolicy'),
    CreateInstanceProfileCommand: command('CreateInstanceProfile'),
    AddRoleToInstanceProfileCommand: command('AddRoleToInstanceProfile'),
    RemoveRoleFromInstanceProfileCommand: command('RemoveRoleFromInstanceProfile'),
    DeleteInstanceProfileCommand: command('DeleteInstanceProfile'),
    DeleteRoleCommand: command('DeleteRole'),
    IAMClient: class {
      async send(cmd: { name: string; input: any }) {
        iam.sent.push(cmd);
        const role = cmd.input.RoleName;
        if (role === iam.goneRole) throw noSuchEntity();
        if (role === iam.failRole) throw new Error('AccessDenied');
        if (cmd.name === 'GetRolePolicy') {
          if (!policies.has(role)) throw noSuchEntity();
          return { PolicyDocument: policies.get(role) };
        }
        if (cmd.name === 'PutRolePolicy') policies.set(role, encodeURIComponent(cmd.input.PolicyDocument));
        if (cmd.name === 'DeleteRolePolicy') policies.delete(role);
        return {};
      }
    },
  };
});

const { backfillBoxEcrPullPolicies, terminateBox } = await import('./boxProvisioner');

const REPO = 'arn:aws:ecr:us-east-1:123456789012:repository';
const BASE_ENV = {
  AWS_REGION: 'us-east-2',
  AGENT_WS_URL: 'wss://termag.example.internal/termag/ws/agent',
  BOX_RESOURCE_PREFIX: 'termag-boxes',
  BOX_PERMISSIONS_BOUNDARY_ARN: 'arn:aws:iam::123456789012:policy/termag-boxes-boundary',
  BOX_VPC_ID: 'vpc-0123',
  BOX_SUBNET_ID: 'subnet-0123',
};
const ECR_ENV = { BOX_ECR_PULL_REPOSITORY_ARNS: `${REPO}/example-org/dev/*,${REPO}/docker.io/*` };
const saved = { ...process.env };

function box(id: string, status = 'ready', extra: Record<string, any> = {}) {
  rows.push({ id, name: id, kind: 'ec2', status, region: null, iamRoleName: `termag-boxes-${id}`, ...extra });
}
const puts = () => iam.sent.filter(c => c.name === 'PutRolePolicy').map(c => c.input.RoleName);

beforeEach(() => {
  rows.length = 0;
  queries.length = 0;
  policies.clear();
  Object.assign(iam, { sent: [], failRole: null, goneRole: null });
  Object.assign(process.env, BASE_ENV, ECR_ENV);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe('backfillBoxEcrPullPolicies', () => {
  it('does nothing when box ECR pull is not configured', async () => {
    delete process.env.BOX_ECR_PULL_REPOSITORY_ARNS;
    box('a');
    await backfillBoxEcrPullPolicies();
    expect(iam.sent).toEqual([]);
    expect(queries).toEqual([]);
  });

  it('writes the policy onto every live ec2 box role that lacks it, and only those', async () => {
    box('a', 'ready');
    box('b', 'stopped');
    box('c', 'warm');
    box('gone', 'terminated');
    box('ext', 'ready', { kind: 'external', iamRoleName: null });
    await backfillBoxEcrPullPolicies();
    expect(queries[0]).toEqual({ kind: 'ec2', iamRoleName: { not: null }, status: { not: 'terminated' } });
    expect(puts()).toEqual(['termag-boxes-a', 'termag-boxes-b', 'termag-boxes-c']);
    const doc = JSON.parse(decodeURIComponent(policies.get('termag-boxes-a')!));
    expect(doc.Statement.find((s: any) => s.Sid === 'BoxEcrPull').Resource).toEqual([`${REPO}/example-org/dev/*`, `${REPO}/docker.io/*`]);
  });

  it('is idempotent: a second run reads and writes nothing new', async () => {
    box('a');
    await backfillBoxEcrPullPolicies();
    iam.sent = [];
    await backfillBoxEcrPullPolicies();
    expect(iam.sent.map(c => c.name)).toEqual(['GetRolePolicy']);
  });

  it('rewrites a policy from an older repository list', async () => {
    box('a');
    await backfillBoxEcrPullPolicies();
    process.env.BOX_ECR_PULL_REPOSITORY_ARNS += `,${REPO}/quay.io/*`;
    iam.sent = [];
    await backfillBoxEcrPullPolicies();
    expect(puts()).toEqual(['termag-boxes-a']);
  });

  it('keeps going past a box whose role errors or has already gone', async () => {
    box('a');
    box('b');
    box('c');
    iam.failRole = 'termag-boxes-a';
    iam.goneRole = 'termag-boxes-b';
    await backfillBoxEcrPullPolicies();
    expect([...policies.keys()]).toEqual(['termag-boxes-c']);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe('terminateBox', () => {
  it('deletes the ECR pull policy before the role, even with the setting now unset', async () => {
    delete process.env.BOX_ECR_PULL_REPOSITORY_ARNS;
    policies.set('termag-boxes-a', '{}');
    await terminateBox({ id: 'a', name: 'a', region: null, iamRoleName: 'termag-boxes-a', ec2InstanceId: null, securityGroupId: null } as any);
    const names = iam.sent.map(c => `${c.name}:${c.input.PolicyName ?? ''}`);
    expect(names).toContain('DeleteRolePolicy:termag-box-ecr-pull');
    expect(names.indexOf('DeleteRolePolicy:termag-box-ecr-pull')).toBeLessThan(names.indexOf('DeleteRole:'));
    expect(policies.has('termag-boxes-a')).toBe(false);
  });
});
