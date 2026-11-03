import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '@prisma/client';

const capacity = () => Object.assign(new Error('We currently do not have sufficient capacity'), { name: 'InsufficientInstanceCapacity' });

const SHAPES: Record<string, { vcpus: number; memoryMiB: number; hibernation?: boolean }> = {
  'm8g.2xlarge': { vcpus: 8, memoryMiB: 32768 },
  'm7g.2xlarge': { vcpus: 8, memoryMiB: 32768 },
  'r8g.2xlarge': { vcpus: 8, memoryMiB: 65536 },
  'r7g.2xlarge': { vcpus: 8, memoryMiB: 65536 },
  'm8g.4xlarge': { vcpus: 16, memoryMiB: 65536 },
  'm9g.2xlarge': { vcpus: 8, memoryMiB: 32768 },
};

const ec2 = {
  type: 'm8g.2xlarge',
  // StartInstances refuses these types for capacity; any other error is `startError`.
  noCapacity: new Set<string>(),
  startError: null as Error | null,
  describeTypesError: null as Error | null,
  sent: [] as string[],
};
const client = {
  async send(cmd: { name: string; input: any }) {
    if (cmd.name === 'ModifyInstanceAttribute') {
      ec2.sent.push(`Modify(${cmd.input.InstanceType.Value})`);
      ec2.type = cmd.input.InstanceType.Value;
      return {};
    }
    ec2.sent.push(cmd.name);
    if (cmd.name === 'DescribeInstanceTypes') {
      if (ec2.describeTypesError) throw ec2.describeTypesError;
      return {
        InstanceTypes: (cmd.input.InstanceTypes as string[]).filter(t => SHAPES[t]).map(t => ({
          InstanceType: t, VCpuInfo: { DefaultVCpus: SHAPES[t].vcpus }, MemoryInfo: { SizeInMiB: SHAPES[t].memoryMiB },
          HibernationSupported: SHAPES[t].hibernation ?? true,
        })),
      };
    }
    if (cmd.name === 'StartInstances') {
      if (ec2.startError) throw ec2.startError;
      if (ec2.noCapacity.has(ec2.type)) throw capacity();
      return {};
    }
    throw new Error(`unexpected ${cmd.name}`);
  },
};
vi.mock('@aws-sdk/client-ec2', () => {
  const command = (name: string) => class { constructor(public input: any) {} name = name; };
  return {
    DescribeInstanceTypesCommand: command('DescribeInstanceTypes'),
    ModifyInstanceAttributeCommand: command('ModifyInstanceAttribute'),
    StartInstancesCommand: command('StartInstances'),
    EC2Client: class {},
  };
});

const rowType = new Map<string, string>();
const owners = new Map<string, Record<string, string>>([['u1', { id: 'u1', googleEmail: 'a@example.com', displayName: 'A', unixUsername: 'a', defaultAgentProvider: 'claude' }]]);
vi.mock('../db', () => ({
  prisma: {
    instance: { update: async ({ where, data }: any) => { rowType.set(where.id, data.instanceType); return {}; } },
    user: { findUnique: async ({ where }: any) => owners.get(where.id) ?? null },
  },
}));

const flag = { on: true, reads: [] as string[] };
vi.mock('./featureFlags', () => ({
  boolVariation: async (key: string, user: { id: string }) => { flag.reads.push(`${key}:user:${user.id}`); return flag.on; },
  boolVariationForContext: async (key: string, ctx: { key: string }) => { flag.reads.push(`${key}:ctx:${ctx.key}`); return flag.on; },
}));
vi.mock('./boxProvisioner', async () => {
  const real = await vi.importActual<typeof import('./boxProvisioner')>('./boxProvisioner');
  return {
    isCapacityRefusal: real.isCapacityRefusal,
    getBoxConfig: () => ({ instanceType: 'm9g.2xlarge', fallbackInstanceTypes: ['m8g.2xlarge'] }),
  };
});

const { startFallbackTypes, startOnFallbackType } = await import('./boxStartFallback');

function box(extra: Partial<Instance> = {}): Instance {
  return {
    id: 'inst_1', name: 'box-1', userId: 'u1', kind: 'ec2', status: 'stopped', ec2InstanceId: 'i-0abc',
    instanceType: 'm8g.2xlarge', size: 'large', hibernationConfigured: false, ...extra,
  } as unknown as Instance;
}

beforeEach(() => {
  Object.assign(ec2, { type: 'm8g.2xlarge', noCapacity: new Set(['m8g.2xlarge']), startError: null, describeTypesError: null, sent: [] });
  Object.assign(flag, { on: true, reads: [] });
  rowType.clear();
});

describe('startFallbackTypes', () => {
  const shapes = new Map(Object.entries(SHAPES).map(([t, s]) => [t, { vcpus: s.vcpus, memoryMiB: s.memoryMiB, hibernationSupported: s.hibernation ?? true }]));
  const large = ['m8g.2xlarge', 'm7g.2xlarge', 'r8g.2xlarge', 'r7g.2xlarge', 'm8g.4xlarge'];

  it("keeps only the size's types of the same vCPU and memory: no bigger type, no more RAM", () => {
    expect(startFallbackTypes('m8g.2xlarge', large, shapes, false)).toEqual(['m7g.2xlarge']);
  });

  it('walks back to the first type from a box already on a fallback', () => {
    expect(startFallbackTypes('m7g.2xlarge', large, shapes, false)).toEqual(['m8g.2xlarge']);
  });

  it("skips a type the provisioner role can't set (m9g is outside box_resize_instance_types)", () => {
    expect(startFallbackTypes('m8g.2xlarge', ['m9g.2xlarge', 'm8g.2xlarge'], shapes, false)).toEqual([]);
  });

  it("skips a type that can't hibernate for a box that does, but not for one that doesn't", () => {
    const noHib = new Map(shapes);
    noHib.set('m7g.2xlarge', { vcpus: 8, memoryMiB: 32768, hibernationSupported: false });
    expect(startFallbackTypes('m8g.2xlarge', large, noHib, true)).toEqual([]);
    expect(startFallbackTypes('m8g.2xlarge', large, noHib, false)).toEqual(['m7g.2xlarge']);
  });

  it("has nothing when EC2 didn't describe the current type", () => {
    expect(startFallbackTypes('m8g.medium', ['m8g.medium', 'm7g.medium'], shapes, false)).toEqual([]);
  });
});

describe('startOnFallbackType', () => {
  it("retypes a large box to m7g.2xlarge and starts it, recording the type on the row", async () => {
    await expect(startOnFallbackType(client as any, box(), capacity())).resolves.toBe('m7g.2xlarge');
    expect(ec2.sent).toEqual(['DescribeInstanceTypes', 'Modify(m7g.2xlarge)', 'StartInstances']);
    expect(rowType.get('inst_1')).toBe('m7g.2xlarge');
    expect(flag.reads).toEqual(['box-start-type-fallback-enabled:user:u1']);
  });

  it('puts the old type back and throws the first refusal when every candidate is refused', async () => {
    ec2.noCapacity.add('m7g.2xlarge');
    const first = capacity();
    await expect(startOnFallbackType(client as any, box(), first)).rejects.toBe(first);
    expect(ec2.sent).toEqual(['DescribeInstanceTypes', 'Modify(m7g.2xlarge)', 'StartInstances', 'Modify(m8g.2xlarge)']);
    expect(ec2.type).toBe('m8g.2xlarge');
    expect(rowType.get('inst_1')).toBe('m8g.2xlarge');
  });

  it('stops at an error that is not about capacity, and still puts the old type back', async () => {
    ec2.startError = Object.assign(new Error('not allowed'), { name: 'UnauthorizedOperation' });
    await expect(startOnFallbackType(client as any, box(), capacity())).rejects.toThrow('not allowed');
    expect(ec2.type).toBe('m8g.2xlarge');
  });

  it('touches nothing with the flag off', async () => {
    flag.on = false;
    const first = capacity();
    await expect(startOnFallbackType(client as any, box(), first)).rejects.toBe(first);
    expect(ec2.sent).toEqual([]);
  });

  it("rethrows at once for a hibernated box (EC2 can't retype one) and for a refusal that isn't capacity", async () => {
    const first = capacity();
    await expect(startOnFallbackType(client as any, box({ status: 'hibernated' }), first)).rejects.toBe(first);
    const quota = Object.assign(new Error('vCPU limit'), { name: 'VcpuLimitExceeded' });
    await expect(startOnFallbackType(client as any, box(), quota)).rejects.toBe(quota);
    expect(ec2.sent).toEqual([]);
    expect(flag.reads).toEqual([]);
  });

  it("rethrows without retyping when DescribeInstanceTypes fails: no shape, no way to tell what's the same", async () => {
    ec2.describeTypesError = new Error('throttled');
    const first = capacity();
    await expect(startOnFallbackType(client as any, box(), first)).rejects.toBe(first);
    expect(ec2.sent).toEqual(['DescribeInstanceTypes']);
  });

  it('a box with no size walks BOX_INSTANCE_TYPE and its fallbacks', async () => {
    ec2.type = 'm7g.2xlarge';
    ec2.noCapacity = new Set(['m7g.2xlarge']);
    await expect(startOnFallbackType(client as any, box({ size: null, instanceType: 'm7g.2xlarge' }), capacity())).resolves.toBe('m8g.2xlarge');
  });

  it('a pool box (no owner) reads the flag for the pool context', async () => {
    await startOnFallbackType(client as any, box({ userId: null }), capacity());
    expect(flag.reads).toEqual(['box-start-type-fallback-enabled:ctx:termag-warm-pool']);
  });
});
