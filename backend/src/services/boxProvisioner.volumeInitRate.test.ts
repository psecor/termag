// The root volume's initialization rate (box-volume-initialization-rate,
// services/boxVolumeInitRate.ts) through the launch: RunInstances gets
// VolumeInitializationRate exactly when a rate is asked for, a refusal of the
// rate relaunches without it, and the launch reports the zone and the rate it
// got for its log line and span.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunInstancesCommand, type EC2Client } from '@aws-sdk/client-ec2';
import { resetSubnetRotationForTests, rootEbs as buildRootEbs, runInstanceWithFallback, type BoxAmi, type BoxConfig } from './boxProvisioner';
import { isVolumeInitRateRefusal, volumeInitRateFrom } from './boxVolumeInitRate';
import {
  effectiveVolumePerformance, isVolumePerformanceRefusal, volumePerformanceFor, volumePerformanceFrom, type VolumePerformance,
} from './boxVolumePerformance';

const cfg: BoxConfig = {
  region: 'us-east-2',
  agentWsUrl: 'wss://termag.example.internal/termag/ws/agent',
  resourcePrefix: 'termag-box',
  permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/termag-box-boundary',
  vpcId: 'vpc-0123',
  subnetId: 'subnet-a',
  fallbackSubnetIds: ['subnet-b'],
  instanceType: 'm8g.2xlarge',
  fallbackInstanceTypes: [],
  managedTag: 'termag',
  rootVolumeGb: 120,
};

const ami: BoxAmi = { imageId: 'ami-1', rootDeviceName: '/dev/sda1', rootVolumeGb: 120, hibernationSupported: false, termagSha: null, createdAt: null };

const ZONES: Record<string, string> = { 'subnet-a': 'us-east-2a', 'subnet-b': 'us-east-2b' };

type RunInput = NonNullable<RunInstancesCommand['input']>;

/** An EC2Client that records RunInstances inputs and answers each with `answer`. */
function fakeEc2(answer: (input: RunInput, n: number) => unknown) {
  const runs: RunInput[] = [];
  const ec2 = {
    send: async (cmd: unknown) => {
      if (!(cmd instanceof RunInstancesCommand)) throw new Error(`unexpected ${String(cmd)}`);
      runs.push(cmd.input);
      const res = answer(cmd.input, runs.length);
      if (res instanceof Error) throw res;
      return res;
    },
  };
  return { ec2: ec2 as unknown as EC2Client, runs };
}

const placed = (input: RunInput) => ({
  Instances: [{ InstanceId: `i-${input.SubnetId}`, Placement: { AvailabilityZone: ZONES[input.SubnetId!] } }],
});

const launch = (ec2: EC2Client, volumeInitRate?: number, volumePerformance?: VolumePerformance) =>
  runInstanceWithFallback(ec2, 'b1', false, {
    ami, name: 'termag-box-1', securityGroupId: 'sg-1', iamRoleName: 'termag-box-1', userData: '#!/bin/sh', cfg, tags: [],
    volumeInitRate, volumePerformance,
  });

const rootEbs = (input: RunInput) => input.BlockDeviceMappings?.[0]?.Ebs;

beforeEach(() => {
  resetSubnetRotationForTests();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('the root volume initialization rate at launch', () => {
  it('asks for no rate while the flag is off, as before', async () => {
    const { ec2, runs } = fakeEc2(placed);
    const got = await launch(ec2, undefined);
    expect(runs).toHaveLength(1);
    expect(rootEbs(runs[0])).not.toHaveProperty('VolumeInitializationRate');
    expect(rootEbs(runs[0])).toMatchObject({ VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true });
    expect(got).toMatchObject({ instanceId: 'i-subnet-a', subnetId: 'subnet-a', availabilityZone: 'us-east-2a' });
    expect(got.volumeInitRate).toBeUndefined();
  });

  it('puts the rate on the root device and reports it with the zone', async () => {
    const { ec2, runs } = fakeEc2(placed);
    const got = await launch(ec2, 200);
    expect(rootEbs(runs[0])?.VolumeInitializationRate).toBe(200);
    expect(got).toMatchObject({ availabilityZone: 'us-east-2a', volumeInitRate: 200 });
  });

  it('reports the zone of the subnet the rotation started in', async () => {
    const { ec2 } = fakeEc2(placed);
    await launch(ec2, 200);
    const second = await launch(ec2, 200);
    expect(second).toMatchObject({ subnetId: 'subnet-b', availabilityZone: 'us-east-2b', volumeInitRate: 200 });
  });

  it('relaunches without the rate when EBS refuses it, and says so', async () => {
    const refusal = Object.assign(new Error('The requested volume initialization rate cannot be provisioned at this time.'), { name: 'InvalidParameterValue' });
    const { ec2, runs } = fakeEc2((input, n) => (n === 1 ? refusal : placed(input)));
    const got = await launch(ec2, 300);
    expect(runs).toHaveLength(2);
    expect(rootEbs(runs[0])?.VolumeInitializationRate).toBe(300);
    expect(rootEbs(runs[1])).not.toHaveProperty('VolumeInitializationRate');
    expect(runs[1].SubnetId).toBe(runs[0].SubnetId);
    expect(got.volumeInitRate).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('refused the 300 MiB/s volume initialization rate'));
  });

  it('does not swallow other errors as a rate refusal', async () => {
    const { ec2, runs } = fakeEc2(() => Object.assign(new Error('not authorized'), { name: 'UnauthorizedOperation' }));
    await expect(launch(ec2, 200)).rejects.toThrow('not authorized');
    expect(runs).toHaveLength(1);
  });
});

describe('volumeInitRateFrom', () => {
  it('is off for 0, negatives and non-numbers', () => {
    for (const raw of [0, -5, NaN, Infinity, '200', null, undefined, true]) expect(volumeInitRateFrom(raw)).toBeUndefined();
  });

  it('clamps into the 100..300 MiB/s EBS accepts, whole', () => {
    expect(volumeInitRateFrom(1)).toBe(100);
    expect(volumeInitRateFrom(200)).toBe(200);
    expect(volumeInitRateFrom(249.6)).toBe(250);
    expect(volumeInitRateFrom(1000)).toBe(300);
  });
});

describe('isVolumeInitRateRefusal', () => {
  it('matches the rate in the name or message only', () => {
    expect(isVolumeInitRateRefusal(new Error('volume initialization rate quota exceeded'))).toBe(true);
    expect(isVolumeInitRateRefusal(Object.assign(new Error('x'), { name: 'VolumeInitializationRateLimitExceeded' }))).toBe(true);
    expect(isVolumeInitRateRefusal(new Error('InsufficientInstanceCapacity'))).toBe(false);
  });
});

// The root volume's throughput and IOPS (box-root-volume-performance,
// services/boxVolumePerformance.ts): parsed and clamped from the flag, fitted
// to the volume's size, put on the same Ebs block as the rate, and dropped on
// a refusal.
describe('the root volume throughput and IOPS at launch', () => {
  it('sets neither while the flag is off, and reports the baseline', async () => {
    const { ec2, runs } = fakeEc2(placed);
    const got = await launch(ec2, undefined, undefined);
    expect(rootEbs(runs[0])).not.toHaveProperty('Throughput');
    expect(rootEbs(runs[0])).not.toHaveProperty('Iops');
    expect(got.volumePerformance).toBeUndefined();
    expect(effectiveVolumePerformance(got.volumePerformance)).toEqual({ throughput: 125, iops: 3000 });
  });

  it('puts both and the rate on the one root Ebs block', async () => {
    const { ec2, runs } = fakeEc2(placed);
    const got = await launch(ec2, 300, { throughput: 500, iops: 6000 });
    expect(runs).toHaveLength(1);
    expect(rootEbs(runs[0])).toEqual({
      VolumeSize: 120, VolumeType: 'gp3', Encrypted: true, DeleteOnTermination: true,
      VolumeInitializationRate: 300, Throughput: 500, Iops: 6000,
    });
    expect(got).toMatchObject({ volumeInitRate: 300, volumePerformance: { throughput: 500, iops: 6000 } });
  });

  it('sets throughput alone at the free 3,000 IOPS', async () => {
    const { ec2, runs } = fakeEc2(placed);
    await launch(ec2, undefined, { throughput: 500 });
    expect(rootEbs(runs[0])).toMatchObject({ Throughput: 500 });
    expect(rootEbs(runs[0])).not.toHaveProperty('Iops');
  });

  it('builds the hibernation launch\'s bigger volume with the same values', () => {
    const ebs = buildRootEbs({
      ami, hibernation: { configured: true, rootVolumeGb: 152 } as never, volumeInitRate: 200, volumePerformance: { throughput: 400, iops: 4000 },
    }, true);
    expect(ebs).toMatchObject({ VolumeSize: 152, VolumeInitializationRate: 200, Throughput: 400, Iops: 4000 });
  });

  it('relaunches at the baseline when EBS refuses them, keeping the rate', async () => {
    const refusal = Object.assign(new Error('Throughput (MiB/s) to iops ratio of 0.3 is too high'), { name: 'InvalidParameterValue' });
    const { ec2, runs } = fakeEc2((input, n) => (n === 1 ? refusal : placed(input)));
    const got = await launch(ec2, 200, { throughput: 750 });
    expect(runs).toHaveLength(2);
    expect(rootEbs(runs[1])).not.toHaveProperty('Throughput');
    expect(rootEbs(runs[1])?.VolumeInitializationRate).toBe(200);
    expect(got).toMatchObject({ volumeInitRate: 200 });
    expect(got.volumePerformance).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('refused the root volume\'s 750 MiB/s and 3000 IOPS'));
  });

  it('drops the rate and then the throughput when EBS refuses each in turn', async () => {
    const rate = new Error('The requested volume initialization rate cannot be provisioned at this time.');
    const perf = Object.assign(new Error('The parameter iops is not supported here'), { name: 'InvalidParameterCombination' });
    const { ec2, runs } = fakeEc2((input, n) => (n === 1 ? rate : n === 2 ? perf : placed(input)));
    const got = await launch(ec2, 300, { iops: 6000 });
    expect(runs).toHaveLength(3);
    expect(rootEbs(runs[1])).toMatchObject({ Iops: 6000 });
    expect(rootEbs(runs[1])).not.toHaveProperty('VolumeInitializationRate');
    expect(rootEbs(runs[2])).not.toHaveProperty('Iops');
    expect(got.volumeInitRate).toBeUndefined();
    expect(got.volumePerformance).toBeUndefined();
  });

  it('does not treat an IOPS-sounding error as a refusal when none was asked for', async () => {
    const { ec2, runs } = fakeEc2(() => Object.assign(new Error('iops quota'), { name: 'InvalidParameterCombination' }));
    await expect(launch(ec2, undefined, undefined)).rejects.toThrow('iops quota');
    expect(runs).toHaveLength(1);
  });
});

describe('volumePerformanceFrom', () => {
  it('is off for non-objects, empty objects and values at or below the baseline', () => {
    for (const raw of [null, undefined, 0, 500, 'x', [], [500], {}, { throughput: 125, iops: 3000 }, { throughput: '500' }, { iops: NaN }, { throughput: -1 }]) {
      expect(volumePerformanceFrom(raw), JSON.stringify(raw)).toBeUndefined();
    }
  });

  it('keeps each field above the baseline, whole, and leaves the other out', () => {
    expect(volumePerformanceFrom({ throughput: 500, iops: 6000 })).toEqual({ throughput: 500, iops: 6000 });
    expect(volumePerformanceFrom({ throughput: 499.6 })).toEqual({ throughput: 500 });
    expect(volumePerformanceFrom({ iops: 4000, throughput: 100 })).toEqual({ iops: 4000 });
  });

  it('clamps to gp3\'s 1000 MiB/s and 16,000 IOPS', () => {
    expect(volumePerformanceFrom({ throughput: 5000, iops: 100000 })).toEqual({ throughput: 1000, iops: 16000 });
  });
});

describe('volumePerformanceFor', () => {
  it('passes values that fit the volume through', () => {
    expect(volumePerformanceFor({ throughput: 500, iops: 6000 }, 120)).toEqual({ throughput: 500, iops: 6000 });
  });

  it('lowers throughput to 0.25 MiB/s per IOPS, counting the free 3,000', () => {
    expect(volumePerformanceFor({ throughput: 1000 }, 120)).toEqual({ throughput: 750 });
    expect(volumePerformanceFor({ throughput: 1000, iops: 3500 }, 120)).toEqual({ throughput: 875, iops: 3500 });
  });

  it('caps IOPS at 500 per GiB, then throughput to fit', () => {
    expect(volumePerformanceFor({ throughput: 1000, iops: 16000 }, 10)).toEqual({ iops: 5000, throughput: 1000 });
    expect(volumePerformanceFor({ throughput: 1000, iops: 16000 }, 7)).toEqual({ iops: 3500, throughput: 875 });
  });

  it('is off when nothing is left above the baseline, or nothing was asked', () => {
    expect(volumePerformanceFor({ iops: 4000 }, 6)).toBeUndefined();
    expect(volumePerformanceFor(undefined, 120)).toBeUndefined();
  });
});

describe('isVolumePerformanceRefusal', () => {
  it('matches throughput or IOPS as a word only', () => {
    expect(isVolumePerformanceRefusal(new Error('Throughput must be at most 0.25 MiB/s per IOPS'))).toBe(true);
    expect(isVolumePerformanceRefusal(new Error('Iops is not valid for this volume'))).toBe(true);
    expect(isVolumePerformanceRefusal(new Error('InsufficientInstanceCapacity'))).toBe(false);
    expect(isVolumePerformanceRefusal(new Error('Invalid IAM Instance Profile name'))).toBe(false);
  });
});
