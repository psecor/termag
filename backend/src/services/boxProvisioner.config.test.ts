import { describe, it, expect } from 'vitest';
import { getBoxConfig, awsClientConfig, revokeTargets, launchCandidates, isCapacityRefusal, withInstanceTypes } from './boxProvisioner';
import { orderCandidates } from './boxRequirements';
import { minimalDefaultDiskGiB } from './boxDiskSize';

const REQUIRED = {
  AWS_REGION: 'us-east-1',
  AGENT_WS_URL: 'wss://termag.example.internal/termag/ws/agent',
  BOX_RESOURCE_PREFIX: 'example-termag-box',
  BOX_PERMISSIONS_BOUNDARY_ARN: 'arn:aws:iam::123456789012:policy/example-termag-box-boundary',
  BOX_VPC_ID: 'vpc-0123',
  BOX_SUBNET_ID: 'subnet-0123',
};

describe('getBoxConfig', () => {
  it('is null until every required variable is present', () => {
    expect(getBoxConfig({})).toBeNull();
    for (const key of Object.keys(REQUIRED)) {
      const env = { ...REQUIRED } as Record<string, string>;
      delete env[key];
      expect(getBoxConfig(env), `missing ${key}`).toBeNull();
    }
  });

  it('no longer requires HOST_SECURITY_GROUP_ID (off-host orchestrators have no host SG)', () => {
    const cfg = getBoxConfig(REQUIRED);
    expect(cfg).not.toBeNull();
    expect(cfg!.hostSecurityGroupId).toBeUndefined();
    expect(cfg!.assumeRoleArn).toBeUndefined();
  });

  it('carries the host SG and provisioner role when set, ignoring blanks', () => {
    const cfg = getBoxConfig({
      ...REQUIRED,
      HOST_SECURITY_GROUP_ID: ' sg-abc ',
      BOX_PROVISIONER_ROLE_ARN: 'arn:aws:iam::123456789012:role/example-termag-box-provisioner',
    });
    expect(cfg!.hostSecurityGroupId).toBe('sg-abc');
    expect(cfg!.assumeRoleArn).toBe('arn:aws:iam::123456789012:role/example-termag-box-provisioner');

    const blank = getBoxConfig({ ...REQUIRED, HOST_SECURITY_GROUP_ID: '', BOX_PROVISIONER_ROLE_ARN: '   ' });
    expect(blank!.hostSecurityGroupId).toBeUndefined();
    expect(blank!.assumeRoleArn).toBeUndefined();
  });

  it('applies defaults for instance type, tag, and root volume', () => {
    const cfg = getBoxConfig(REQUIRED)!;
    expect(cfg.instanceType).toBe('t4g.medium');
    expect(cfg.managedTag).toBe('termag-box');
    expect(cfg.rootVolumeGb).toBe(120);
    expect(cfg.fallbackSubnetIds).toEqual([]);
    expect(cfg.fallbackInstanceTypes).toEqual([]);
  });

  it('parses the fallback lists, dropping blanks, repeats and the primary', () => {
    const cfg = getBoxConfig({
      ...REQUIRED,
      BOX_INSTANCE_TYPE: 'm9g.2xlarge',
      BOX_FALLBACK_SUBNET_IDS: ' subnet-0123, subnet-b ,,subnet-c,subnet-b',
      BOX_FALLBACK_INSTANCE_TYPES: 'm8g.2xlarge, m9g.2xlarge ,m7g.2xlarge',
    })!;
    expect(cfg.fallbackSubnetIds).toEqual(['subnet-b', 'subnet-c']);
    expect(cfg.fallbackInstanceTypes).toEqual(['m8g.2xlarge', 'm7g.2xlarge']);
  });
});

describe('launchCandidates', () => {
  it('is just the primary pair with no fallbacks', () => {
    expect(launchCandidates({ instanceType: 't', fallbackInstanceTypes: [], subnetId: 's', fallbackSubnetIds: [] }))
      .toEqual([{ instanceType: 't', subnetId: 's' }]);
  });

  it('walks every subnet for a type before the next type', () => {
    expect(launchCandidates({ instanceType: 't1', fallbackInstanceTypes: ['t2'], subnetId: 's1', fallbackSubnetIds: ['s2'] }))
      .toEqual([
        { instanceType: 't1', subnetId: 's1' }, { instanceType: 't1', subnetId: 's2' },
        { instanceType: 't2', subnetId: 's1' }, { instanceType: 't2', subnetId: 's2' },
      ]);
  });

  it('starts the subnet walk at `start`, wrapping around, for every type', () => {
    const cfg = { instanceType: 't1', fallbackInstanceTypes: ['t2'], subnetId: 's1', fallbackSubnetIds: ['s2', 's3'] };
    expect(launchCandidates(cfg, 1).map(c => `${c.instanceType} ${c.subnetId}`))
      .toEqual(['t1 s2', 't1 s3', 't1 s1', 't2 s2', 't2 s3', 't2 s1']);
    expect(launchCandidates(cfg, 5).map(c => c.subnetId).slice(0, 3)).toEqual(['s3', 's1', 's2']);
  });
});

describe('withInstanceTypes', () => {
  const cfg = getBoxConfig({ ...REQUIRED, BOX_INSTANCE_TYPE: 'm9g.2xlarge', BOX_FALLBACK_INSTANCE_TYPES: 'm8g.2xlarge' })!;

  it('leaves the configured types alone without a choice', () => {
    expect(withInstanceTypes(cfg, undefined)).toBe(cfg);
  });

  it("puts the caller's type and fallbacks in place of the configured ones", () => {
    const chosen = withInstanceTypes(cfg, { type: 'r8g.xlarge', fallbacks: ['r7g.xlarge'] });
    expect(chosen.instanceType).toBe('r8g.xlarge');
    expect(chosen.fallbackInstanceTypes).toEqual(['r7g.xlarge']);
    expect(chosen.subnetId).toBe(cfg.subnetId);
    expect(cfg.instanceType).toBe('m9g.2xlarge');
  });

  it("never falls back to the configured types, only the caller's", () => {
    expect(launchCandidates(withInstanceTypes(cfg, { type: 'r8g.xlarge', fallbacks: [] })).map(c => c.instanceType))
      .toEqual(['r8g.xlarge']);
  });

  it('drops blanks, repeats and the primary from the fallbacks', () => {
    expect(withInstanceTypes(cfg, { type: 'r8g.xlarge', fallbacks: [' r7g.xlarge', 'r8g.xlarge', '', 'r7g.xlarge'] }).fallbackInstanceTypes)
      .toEqual(['r7g.xlarge']);
  });

  it('walks a requirements box\'s match on capacity refusals: r8g.xlarge in every subnet, then r7g.xlarge, then the 8 vCPU m types', () => {
    const two = getBoxConfig({ ...REQUIRED, BOX_FALLBACK_SUBNET_IDS: 'subnet-2' })!;
    const [type, ...fallbacks] = orderCandidates({ vcpu: 4, memoryGiB: 32 }, [
      { type: 'm8g.2xlarge', vcpu: 8, memoryMiB: 32768 }, { type: 'r7g.xlarge', vcpu: 4, memoryMiB: 32768 },
      { type: 'r8g.xlarge', vcpu: 4, memoryMiB: 32768 }, { type: 'm7g.2xlarge', vcpu: 8, memoryMiB: 32768 },
    ]);
    expect(launchCandidates(withInstanceTypes(two, { type, fallbacks })).map(c => `${c.instanceType} ${c.subnetId}`)).toEqual([
      `r8g.xlarge ${two.subnetId}`, 'r8g.xlarge subnet-2',
      `r7g.xlarge ${two.subnetId}`, 'r7g.xlarge subnet-2',
      `m8g.2xlarge ${two.subnetId}`, 'm8g.2xlarge subnet-2',
      `m7g.2xlarge ${two.subnetId}`, 'm7g.2xlarge subnet-2',
    ]);
  });

  it('trims the primary type too, and still drops it from the fallbacks', () => {
    const chosen = withInstanceTypes(cfg, { type: ' r8g.xlarge\n', fallbacks: ['r8g.xlarge', 'r7g.xlarge'] });
    expect(chosen.instanceType).toBe('r8g.xlarge');
    expect(chosen.fallbackInstanceTypes).toEqual(['r7g.xlarge']);
  });
});

describe('isCapacityRefusal', () => {
  const err = (name: string, message = name) => Object.assign(new Error(message), { name });

  it('is true for no capacity, a full subnet, or a type the AZ does not offer', () => {
    expect(isCapacityRefusal(err('InsufficientInstanceCapacity'))).toBe(true);
    expect(isCapacityRefusal(err('InsufficientFreeAddressesInSubnet'))).toBe(true);
    expect(isCapacityRefusal(err('Unsupported', 'Your requested instance type (m9g.2xlarge) is not supported in your requested Availability Zone (us-east-2c).'))).toBe(true);
  });

  it('is false for the shared vCPU quota and anything else', () => {
    expect(isCapacityRefusal(err('VcpuLimitExceeded'))).toBe(false);
    expect(isCapacityRefusal(err('Unsupported', 'The requested configuration is currently not supported.'))).toBe(false);
    expect(isCapacityRefusal(err('UnauthorizedOperation'))).toBe(false);
    expect(isCapacityRefusal('InsufficientInstanceCapacity')).toBe(false);
  });
});

describe('awsClientConfig', () => {
  it('uses ambient credentials when no provisioner role is configured', () => {
    expect(awsClientConfig({ region: 'us-east-1' })).toEqual({ region: 'us-east-1' });
  });

  it('honours a per-instance region override', () => {
    expect(awsClientConfig({ region: 'us-east-1' }, 'us-west-2')).toEqual({ region: 'us-west-2' });
  });

  it('attaches an assume-role credential provider when a provisioner role is configured', () => {
    const cfg = awsClientConfig({
      region: 'us-east-1',
      assumeRoleArn: 'arn:aws:iam::123456789012:role/example-termag-box-provisioner',
    });
    expect(cfg.region).toBe('us-east-1');
    expect(typeof cfg.credentials).toBe('function');
  });
});

describe('revokeTargets', () => {
  it('falls back to the configured host SG when discovery found nothing', () => {
    expect(revokeTargets('sg-host', [], 'sg-box')).toEqual(['sg-host']);
  });

  it('revokes from every referencing SG with HOST_SECURITY_GROUP_ID unset (container orchestrator tearing down an EC2-era box)', () => {
    expect(revokeTargets(undefined, ['sg-oldhost', 'sg-other'], 'sg-box')).toEqual(['sg-oldhost', 'sg-other']);
  });

  it('de-duplicates the configured host SG against the discovered set', () => {
    expect(revokeTargets('sg-host', ['sg-host', 'sg-other'], 'sg-box')).toEqual(['sg-host', 'sg-other']);
  });

  it('never targets the box SG itself and is empty when there is nothing to revoke', () => {
    expect(revokeTargets(undefined, ['sg-box'], 'sg-box')).toEqual([]);
    expect(revokeTargets('sg-box', [], 'sg-box')).toEqual([]);
    expect(revokeTargets(undefined, [], 'sg-box')).toEqual([]);
  });
});

describe('minimalDefaultDiskGiB (services/boxDiskSize.ts, the --minimal flavor\u2019s fallback disk)', () => {
  // getBoxConfig dropped its own minimal field when disks moved to the box:
  // the flavor\u2019s default is a disk-decision fallback now, not a launch floor.
  it('defaults a lean box to 60, the box-min bake\u2019s root size', () => {
    expect(minimalDefaultDiskGiB({} as NodeJS.ProcessEnv)).toBe(60);
  });

  it('takes BOX_MINIMAL_ROOT_VOLUME_GB when set validly, whatever the full default says', () => {
    expect(minimalDefaultDiskGiB({ BOX_MINIMAL_ROOT_VOLUME_GB: '30' } as NodeJS.ProcessEnv)).toBe(30);
    expect(minimalDefaultDiskGiB({ BOX_MINIMAL_ROOT_VOLUME_GB: '30', BOX_ROOT_VOLUME_GB: '200' } as NodeJS.ProcessEnv)).toBe(30);
    expect(minimalDefaultDiskGiB({ BOX_MINIMAL_ROOT_VOLUME_GB: '80', BOX_ROOT_VOLUME_GB: '40' } as NodeJS.ProcessEnv)).toBe(80);
  });

  it('clamps down to a smaller BOX_ROOT_VOLUME_GB when BOX_MINIMAL_ROOT_VOLUME_GB is unset', () => {
    expect(minimalDefaultDiskGiB({ BOX_ROOT_VOLUME_GB: '40' } as NodeJS.ProcessEnv)).toBe(40);
    expect(minimalDefaultDiskGiB({} as NodeJS.ProcessEnv)).toBe(60);
  });

  it('never poisons with a NaN', () => {
    expect(minimalDefaultDiskGiB({ BOX_MINIMAL_ROOT_VOLUME_GB: 'soon' } as NodeJS.ProcessEnv)).toBe(60);
    expect(minimalDefaultDiskGiB({ BOX_ROOT_VOLUME_GB: 'soon' } as NodeJS.ProcessEnv)).toBe(60);
    expect(minimalDefaultDiskGiB({ BOX_ROOT_VOLUME_GB: '40', BOX_MINIMAL_ROOT_VOLUME_GB: 'soon' } as NodeJS.ProcessEnv)).toBe(40);
  });
});
