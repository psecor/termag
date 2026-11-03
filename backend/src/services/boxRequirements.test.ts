import { beforeEach, describe, expect, it, vi } from 'vitest';

// EC2 as the resolver sees it: GetInstanceTypesFromInstanceRequirements
// answers names (in pages), DescribeInstanceTypes their shapes.
const ec2 = vi.hoisted(() => ({
  sent: [] as Array<{ command: string; input: Record<string, unknown> }>,
  pages: [] as string[][],
  shapes: {} as Record<string, [number, number]>,
  fail: null as Error | null,
}));

vi.mock('@aws-sdk/client-ec2', () => {
  class Command { constructor(readonly input: Record<string, unknown>) {} }
  class GetInstanceTypesFromInstanceRequirementsCommand extends Command {}
  class DescribeInstanceTypesCommand extends Command {}
  class EC2Client {
    async send(cmd: Command) {
      const command = cmd.constructor.name;
      ec2.sent.push({ command, input: cmd.input });
      if (ec2.fail) throw ec2.fail;
      if (command === 'GetInstanceTypesFromInstanceRequirementsCommand') {
        const page = Number(cmd.input.NextToken ?? 0);
        return {
          InstanceTypes: (ec2.pages[page] ?? []).map(InstanceType => ({ InstanceType })),
          NextToken: page + 1 < ec2.pages.length ? String(page + 1) : undefined,
        };
      }
      const names = cmd.input.InstanceTypes as string[];
      return {
        InstanceTypes: names.filter(n => ec2.shapes[n]).map(n => ({
          InstanceType: n, VCpuInfo: { DefaultVCpus: ec2.shapes[n][0] }, MemoryInfo: { SizeInMiB: ec2.shapes[n][1] * 1024 },
        })),
      };
    }
  }
  return { EC2Client, GetInstanceTypesFromInstanceRequirementsCommand, DescribeInstanceTypesCommand };
});

const provisioning = vi.hoisted(() => ({ configured: true }));
vi.mock('./boxProvisioner', () => ({
  getBoxConfig: () => (provisioning.configured ? { region: 'us-east-1' } : null),
  awsClientConfig: () => ({ region: 'us-east-1' }),
}));
vi.mock('./featureFlags', () => ({ stringVariation: vi.fn(), stringVariationForContext: vi.fn() }));

const {
  createRequirementsResolver, describeRequirements, orderCandidates, parseRequirements, parseRequirementsLabel,
  presetFor, requirementsLabel, requirementsResolver, BOX_REQUIREMENT_LIMITS,
} = await import('./boxRequirements');

/** Every arm64 type of the allowed families that 4 vCPU / 32 GiB fits in, as EC2 would list them (unordered). */
const SHAPES: Record<string, [number, number]> = {
  'm8g.2xlarge': [8, 32], 'r7g.xlarge': [4, 32], 'm7g.2xlarge': [8, 32], 'r8g.xlarge': [4, 32],
};

beforeEach(() => {
  ec2.sent = [];
  ec2.pages = [Object.keys(SHAPES)];
  ec2.shapes = { ...SHAPES, 'm8g.xlarge': [4, 16], 'm7g.xlarge': [4, 16], 'r8g.large': [2, 16], 'm8g.large': [2, 8] };
  ec2.fail = null;
  provisioning.configured = true;
});

describe('requirements in a environment.json: whole numbers, at least 1, within the limits', () => {
  it('takes { vcpu, memoryGiB }', () => {
    expect(parseRequirements({ vcpu: 4, memoryGiB: 32 })).toEqual({ ok: true, requirements: { vcpu: 4, memoryGiB: 32 } });
    expect(parseRequirements({ vcpu: 8, memoryGiB: 32 }).ok).toBe(true);
    expect(parseRequirements({ vcpu: 2, memoryGiB: 8 }).ok).toBe(true);
  });

  it.each([
    [{ vcpu: 4 }, '"memoryGiB" must be a whole number'],
    [{ memoryGiB: 32 }, '"vcpu" must be a whole number'],
    [{ vcpu: 0, memoryGiB: 32 }, '"vcpu" must be a whole number of at least 1'],
    [{ vcpu: 2.5, memoryGiB: 32 }, '"vcpu" must be a whole number'],
    [{ vcpu: '4', memoryGiB: 32 }, '"vcpu" must be a whole number'],
    [{ vcpu: 4, memoryGiB: -1 }, '"memoryGiB" must be a whole number of at least 1'],
    [{ vcpu: 16, memoryGiB: 32 }, `16 vCPU is over the ${BOX_REQUIREMENT_LIMITS.maxVcpu} vCPU limit`],
    [{ vcpu: 4, memoryGiB: 64 }, `64 GiB is over the ${BOX_REQUIREMENT_LIMITS.maxMemoryGiB} GiB limit`],
    [{ vcpu: 4, memoryGiB: 32, gpu: 1 }, '"gpu" is not a requirement termag knows'],
    [[4, 32], 'not a size or'],
  ])('refuses %j: %s', (value, why) => {
    const parsed = parseRequirements(value);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.why).toContain(why);
  });

  it('records them on the row as 4vcpu-32gib, and reads that back', () => {
    expect(requirementsLabel({ vcpu: 4, memoryGiB: 32 })).toBe('4vcpu-32gib');
    expect(parseRequirementsLabel('4vcpu-32gib')).toEqual({ vcpu: 4, memoryGiB: 32 });
    expect(parseRequirementsLabel('medium')).toBeNull();
    expect(parseRequirementsLabel('16vcpu-32gib')).toBeNull();
    expect(parseRequirementsLabel(null)).toBeNull();
    expect(describeRequirements({ vcpu: 4, memoryGiB: 32 })).toBe('4 vCPU, 32 GB');
  });
});

describe('the launch order: fewest vCPUs, then least memory, then the newer generation', () => {
  const candidates = Object.entries(SHAPES).map(([type, [vcpu, gib]]) => ({ type, vcpu, memoryMiB: gib * 1024 }));

  it('puts 4 vCPU / 32 GiB on r8g.xlarge, then r7g.xlarge, then the 8 vCPU m types', () => {
    expect(orderCandidates({ vcpu: 4, memoryGiB: 32 }, candidates)).toEqual(['r8g.xlarge', 'r7g.xlarge', 'm8g.2xlarge', 'm7g.2xlarge']);
  });

  it('keeps the presets\' shapes on their m types: 2/8 is m8g.large, 8/32 m8g.2xlarge', () => {
    const all = [
      { type: 'm8g.large', vcpu: 2, memoryMiB: 8192 }, { type: 'm7g.large', vcpu: 2, memoryMiB: 8192 },
      { type: 'r8g.large', vcpu: 2, memoryMiB: 16384 }, ...candidates,
    ];
    expect(orderCandidates({ vcpu: 2, memoryGiB: 8 }, all).slice(0, 3)).toEqual(['m8g.large', 'm7g.large', 'r8g.large']);
    expect(orderCandidates({ vcpu: 8, memoryGiB: 32 }, all)).toEqual(['m8g.2xlarge', 'm7g.2xlarge']);
  });

  it('drops a type that does not fit, or is outside the families, whatever EC2 sent', () => {
    expect(orderCandidates({ vcpu: 4, memoryGiB: 32 }, [
      { type: 'm8g.xlarge', vcpu: 4, memoryMiB: 16 * 1024 },
      { type: 'x2gd.xlarge', vcpu: 4, memoryMiB: 64 * 1024 },
      { type: 'c8g.2xlarge', vcpu: 8, memoryMiB: 16 * 1024 },
      { type: 'r8g.2xlarge', vcpu: 8, memoryMiB: 64 * 1024 },
      { type: 'r7g.xlarge', vcpu: 4, memoryMiB: 32 * 1024 },
    ])).toEqual(['r7g.xlarge']);
  });

  it('is a preset when it starts with a preset\'s type', () => {
    expect(presetFor(['m8g.xlarge', 'm7g.xlarge'], {})).toBe('medium');
    expect(presetFor(['r8g.xlarge'], {})).toBeNull();
  });
});

describe('the resolver, against EC2', () => {
  it('asks EC2 for arm64 matches in the allowed families, every page, and describes them', async () => {
    ec2.pages = [Object.keys(SHAPES).slice(0, 2), Object.keys(SHAPES).slice(2)];
    const real = await requirementsResolver.resolve({ vcpu: 4, memoryGiB: 32 });
    expect(real).toEqual({ ok: true, choice: { type: 'r8g.xlarge', fallbacks: ['r7g.xlarge', 'm8g.2xlarge', 'm7g.2xlarge'] }, preset: null });
    const asked = ec2.sent.filter(s => s.command === 'GetInstanceTypesFromInstanceRequirementsCommand');
    expect(asked).toHaveLength(2);
    expect(asked[0].input).toEqual({
      ArchitectureTypes: ['arm64'],
      VirtualizationTypes: ['hvm'],
      InstanceRequirements: {
        VCpuCount: { Min: 4, Max: 8 },
        MemoryMiB: { Min: 32768, Max: 32768 },
        AllowedInstanceTypes: ['m8g.*', 'r8g.*', 'm7g.*', 'r7g.*'],
        BareMetal: 'excluded',
        BurstablePerformance: 'excluded',
      },
      NextToken: undefined,
    });
    expect(asked[1].input.NextToken).toBe('1');
    expect(ec2.sent.filter(s => s.command === 'DescribeInstanceTypesCommand')).toHaveLength(1);
  });

  it('caches a resolution: the second box with the same requirements asks EC2 nothing', async () => {
    let clock = 0;
    const aws = { matching: vi.fn(async () => Object.keys(SHAPES)), describe: vi.fn(async (names: readonly string[]) => names.map(type => ({ type, vcpu: SHAPES[type][0], memoryMiB: SHAPES[type][1] * 1024 }))) };
    const resolver = createRequirementsResolver(() => aws, { now: () => clock, ttlMs: 1000 });
    await resolver.resolve({ vcpu: 4, memoryGiB: 32 });
    await resolver.resolve({ vcpu: 4, memoryGiB: 32 });
    expect(aws.matching).toHaveBeenCalledTimes(1);
    await resolver.resolve({ vcpu: 8, memoryGiB: 32 });
    expect(aws.matching).toHaveBeenCalledTimes(2);
    clock = 1001;
    await resolver.resolve({ vcpu: 4, memoryGiB: 32 });
    expect(aws.matching).toHaveBeenCalledTimes(3);
  });

  it('is a preset when the cheapest match is one: 4 vCPU / 16 GiB is medium', async () => {
    ec2.pages = [['m8g.xlarge', 'm7g.xlarge', 'r8g.xlarge']];
    const resolver = createRequirementsResolver(() => ({
      matching: async () => ec2.pages[0],
      describe: async names => names.map(type => ({ type, vcpu: ec2.shapes[type][0], memoryMiB: ec2.shapes[type][1] * 1024 })),
    }));
    expect(await resolver.resolve({ vcpu: 4, memoryGiB: 16 })).toMatchObject({ ok: true, preset: 'medium', choice: { type: 'm8g.xlarge' } });
  });

  it('warns, and caches nothing, when EC2 refuses (the IAM grant without the action) or has no match', async () => {
    const aws = { matching: vi.fn(async (): Promise<string[]> => { throw new Error('not authorized to perform: ec2:GetInstanceTypesFromInstanceRequirements'); }), describe: vi.fn(async () => []) };
    const resolver = createRequirementsResolver(() => aws);
    expect(await resolver.resolve({ vcpu: 4, memoryGiB: 32 })).toEqual({ ok: false, warning: expect.stringContaining('EC2 could not match it (not authorized') });
    await resolver.resolve({ vcpu: 4, memoryGiB: 32 });
    expect(aws.matching).toHaveBeenCalledTimes(2);
    aws.matching.mockResolvedValue([]);
    expect(await resolver.resolve({ vcpu: 4, memoryGiB: 32 })).toEqual({ ok: false, warning: '4 vCPU, 32 GB: no m8g/r8g/m7g/r7g type has that' });
    expect(await createRequirementsResolver(() => null).resolve({ vcpu: 4, memoryGiB: 32 })).toMatchObject({ ok: false, warning: expect.stringContaining('no box provisioning') });
  });
});
