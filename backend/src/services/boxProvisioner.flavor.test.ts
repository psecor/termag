import { describe, it, expect } from 'vitest';
import type { EC2Client } from '@aws-sdk/client-ec2';
import { discoverLatestAmi, resolveMinimalBoxImage, type BoxConfig, type BoxAmi } from './boxProvisioner';
import { flavorOf, flavorSpec, BOX_FLAVORS } from './boxFlavor';
import { amiWithDisk } from './boxProvisioner';

const cfg: BoxConfig = {
  region: 'us-east-2',
  agentWsUrl: 'wss://termag.example.internal/termag/ws/agent',
  resourcePrefix: 'example-termag-box',
  permissionsBoundaryArn: 'arn:aws:iam::123456789012:policy/example-termag-box-boundary',
  vpcId: 'vpc-0123',
  subnetId: 'subnet-0123',
  fallbackSubnetIds: [],
  instanceType: 't4g.medium',
  fallbackInstanceTypes: [],
  managedTag: 'termag-box',
  rootVolumeGb: 120,
};

interface SentCommand { input: { Filters?: Array<{ Name: string; Values: string[] }> } }

/** A stand-in EC2Client that records every command and answers one page of images. */
function fakeEc2(images: Array<Record<string, unknown>>) {
  const sent: SentCommand[] = [];
  const ec2 = {
    send: async (cmd: SentCommand) => {
      sent.push(cmd);
      return { Images: images };
    },
  };
  return { ec2: ec2 as unknown as EC2Client, sent };
}

/** A discoverable box image, sized and tagged as the bake would leave it. */
function IMAGE(id: string, gb: number, tags: Array<{ Key: string; Value: string }> = []) {
  return {
    ImageId: id,
    State: 'available',
    CreationDate: new Date().toISOString(),
    RootDeviceName: '/dev/sda1',
    BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: gb } }],
    Tags: [{ Key: 'App', Value: 'termag' }, ...tags],
  };
}

describe('the flavor specs (services/boxFlavor.ts)', () => {
  it('declares two flavors and degrades the unknown to full', () => {
    expect(Object.keys(BOX_FLAVORS).sort()).toEqual(['full', 'minimal']);
    expect(flavorOf('minimal')).toBe('minimal');
    expect(flavorOf(true)).toBe('minimal');          // the 1.x boolean spelling
    expect(flavorOf('full')).toBe('full');
    expect(flavorOf('yes')).toBe('full');            // fuzzed values ride as full
    expect(flavorOf(undefined)).toBe('full');
    expect(flavorSpec('minimal')).toBe(BOX_FLAVORS.minimal);
    expect(flavorSpec('soon')).toBe(BOX_FLAVORS.full);
  });

  it('full is flag-aware, claimable, and defers to BOX_ROOT_VOLUME_GB', () => {
    const spec = flavorSpec('full');
    expect(spec.id).toBe('full');
    expect(spec.flagAware).toBe(true);
    expect(spec.warmPoolEligible).toBe(true);
    expect(spec.defaultDiskGiB({ BOX_ROOT_VOLUME_GB: '200' } as NodeJS.ProcessEnv)).toBe(200);
  });

  it('minimal is its own image story: cold, flagless, 60 by default', () => {
    const spec = flavorSpec('minimal');
    expect(spec.id).toBe('minimal');
    expect(spec.flagAware).toBe(false);
    expect(spec.warmPoolEligible).toBe(false);
    expect(spec.defaultDiskGiB({} as NodeJS.ProcessEnv)).toBe(60);
    expect(spec.defaultDiskGiB({ BOX_MINIMAL_ROOT_VOLUME_GB: '30' } as NodeJS.ProcessEnv)).toBe(30);
    expect(spec.defaultDiskGiB({ BOX_MINIMAL_ROOT_VOLUME_GB: '30', BOX_ROOT_VOLUME_GB: '200' } as NodeJS.ProcessEnv)).toBe(30);
    expect(spec.defaultDiskGiB({ BOX_ROOT_VOLUME_GB: '40' } as NodeJS.ProcessEnv)).toBe(40);
  });

  it('resolves images through the spec, and a minimal selection input stays unread', async () => {
    const lean = fakeEc2([IMAGE('ami-min', 12, [{ Key: 'Component', Value: 'box-min' }])]);
    const image = await BOX_FLAVORS.minimal.resolveImage({ ec2: lean.ec2, cfg, selection: { kind: 'pinned', amiId: 'ami-something-else' } });
    expect(image).toMatchObject({ source: 'minimal', selected: false });
    expect(image.ami.imageId).toBe('ami-min');
  });

  it('sizing is the launch\'s job: the lean image launches on the disk decided for the box', async () => {
    const lean = fakeEc2([IMAGE('ami-min', 12, [{ Key: 'Component', Value: 'box-min' }])]);
    const image = await resolveMinimalBoxImage(lean.ec2, cfg);
    expect(image.ami.imageId).toBe('ami-min');
    // BOX_MINIMAL_ROOT_VOLUME_GB's 60 default clamps a 12GB snapshot up; an
    // explicit larger ask wins; never under the snapshot.
    expect(amiWithDisk(image.ami, flavorSpec('minimal').defaultDiskGiB({} as NodeJS.ProcessEnv)).rootVolumeGb).toBe(60);
    expect(amiWithDisk(image.ami, 200).rootVolumeGb).toBe(200);
  });

  it('fails a minimal launch loudly when no minimal image is published', async () => {
    const { ec2 } = fakeEc2([]);
    await expect(resolveMinimalBoxImage(ec2, cfg)).rejects.toThrow(/Component=box-min/);
  });

  it('full resolves through the published/pinned/channel chain', async () => {
    // Published selection: the newest Component=box.
    const pub = fakeEc2([IMAGE('ami-full', 8, [{ Key: 'Component', Value: 'box' }])]);
    const image = await BOX_FLAVORS.full.resolveImage({ ec2: pub.ec2, cfg, selection: { kind: 'published' } });
    expect(pub.sent[0].input.Filters).toContainEqual({ Name: 'tag:Component', Values: ['box'] });
    expect(image.ami.imageId).toBe('ami-full');
    expect(image).toMatchObject({ source: 'published', selected: false });
  });

  it('full with a pinned selection stays on resolveBoxImage\'s chain (an unknown pin falls back to published)', async () => {
    const pinned = fakeEc2([IMAGE('ami-full', 8, [{ Key: 'Component', Value: 'box' }]), IMAGE('ami-pin', 50, [{ Key: 'Component', Value: 'box-pinned' }])]);
    // pickSelectedImage accepts box|box-candidate components with an AMI id that exists self-owned;
    // the fake returns both and the pinned lookup names one — a pin miss falls back to published.
    const image = await BOX_FLAVORS.full.resolveImage({ ec2: pinned.ec2, cfg, selection: { kind: 'pinned', amiId: 'ami-missing' } });
    expect(image.source).toBe('fallback:pinned:ami-missing');
    expect(image.selected).toBe(false);
  });
});

describe('discoverLatestAmi component (the spec\'s machinery)', () => {
  it('defaults to the full bake (Component=box) and records the image\'s own snapshot size', async () => {
    const { ec2, sent } = fakeEc2([IMAGE('ami-full', 8, [{ Key: 'Component', Value: 'box' }])]);
    const ami = await discoverLatestAmi(ec2, cfg);
    expect(sent[0].input.Filters).toContainEqual({ Name: 'tag:Component', Values: ['box'] });
    expect(ami.imageId).toBe('ami-full');
    expect(ami.imageGb).toBe(8);
  });
});
