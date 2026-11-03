import { describe, it, expect } from 'vitest';
import {
  amiSupportsHibernation,
  amiTermagSha,
  amiWithDisk,
  planHibernation,
  resolveRootDevice,
} from './boxProvisioner';

describe('resolveRootDevice', () => {
  // The AMI shape DescribeImages returns, trimmed to what sizing reads.
  const ami = (rootDeviceName: string, mappings: { DeviceName?: string; Ebs?: { VolumeSize?: number } }[]) =>
    ({ RootDeviceName: rootDeviceName, BlockDeviceMappings: mappings });

  it('keeps the configured size when the AMI is smaller', () => {
    expect(resolveRootDevice(ami('/dev/sda1', [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: 50 } }]), 120))
      .toEqual({ deviceName: '/dev/sda1', volumeGb: 120 });
  });

  it('raises the size to the AMI snapshot when the AMI is bigger (the 2026-09-16 failure)', () => {
    // An orchestrator still on BOX_ROOT_VOLUME_GB=50 launching the 120GB image:
    // EC2 rejected this outright before the floor came from the AMI.
    expect(resolveRootDevice(ami('/dev/sda1', [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: 120 } }]), 50))
      .toEqual({ deviceName: '/dev/sda1', volumeGb: 120 });
  });

  it('names the device from the AMI, not a hardcoded /dev/sda1', () => {
    // Mapping the wrong device attaches a second volume instead of resizing the
    // root, so the box would boot at the snapshot's size with a stray disk.
    expect(resolveRootDevice(ami('/dev/xvda', [{ DeviceName: '/dev/xvda', Ebs: { VolumeSize: 200 } }]), 120))
      .toEqual({ deviceName: '/dev/xvda', volumeGb: 200 });
  });

  it('ignores mappings for non-root devices', () => {
    expect(resolveRootDevice(ami('/dev/sda1', [
      { DeviceName: '/dev/sdb', Ebs: { VolumeSize: 500 } },
      { DeviceName: '/dev/sda1', Ebs: { VolumeSize: 120 } },
    ]), 50)).toEqual({ deviceName: '/dev/sda1', volumeGb: 120 });
  });

  it('falls back to the configured size when the AMI reports no size', () => {
    for (const mappings of [[], [{ DeviceName: '/dev/sda1' }], [{ DeviceName: '/dev/sda1', Ebs: {} }]]) {
      expect(resolveRootDevice(ami('/dev/sda1', mappings), 120).volumeGb).toBe(120);
    }
  });

  it('falls back to /dev/sda1 when the AMI reports no root device', () => {
    expect(resolveRootDevice({ BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: 120 } }] }, 50))
      .toEqual({ deviceName: '/dev/sda1', volumeGb: 120 });
    expect(resolveRootDevice({ RootDeviceName: '  ', BlockDeviceMappings: [] }, 120).deviceName).toBe('/dev/sda1');
  });

  it('never returns NaN when BOX_ROOT_VOLUME_GB is not a number', () => {
    // parseInt('') is NaN, and Math.max(NaN, 120) would be NaN — EC2 would
    // reject the launch with an opaque error.
    expect(resolveRootDevice(ami('/dev/sda1', [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: 120 } }]), NaN))
      .toEqual({ deviceName: '/dev/sda1', volumeGb: 120 });
  });
});

describe('amiTermagSha', () => {
  const sha = 'a3f1c2d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c0';
  it('reads the full sha from the TermagSha tag', () => {
    expect(amiTermagSha({ Tags: [{ Key: 'App', Value: 'termag' }, { Key: 'TermagSha', Value: sha }] })).toBe(sha);
    expect(amiTermagSha({ Tags: [{ Key: 'TermagSha', Value: ` ${sha.toUpperCase()} ` }] })).toBe(sha);
  });
  it('is null without the tag or with something that is not a commit', () => {
    expect(amiTermagSha({})).toBe(null);
    expect(amiTermagSha({ Tags: [{ Key: 'TermagSha', Value: 'unknown' }] })).toBe(null);
    expect(amiTermagSha({ Tags: [{ Key: 'TermagSha', Value: sha.slice(0, 12) }] })).toBe(null);
  });
});

describe('amiSupportsHibernation', () => {
  it('reads the Hibernation=supported tag the bake sets', () => {
    expect(amiSupportsHibernation({ Tags: [{ Key: 'App', Value: 'termag' }, { Key: 'Hibernation', Value: 'supported' }] })).toBe(true);
    expect(amiSupportsHibernation({ Tags: [{ Key: 'Hibernation', Value: 'no' }] })).toBe(false);
    expect(amiSupportsHibernation({})).toBe(false);
  });
});

describe('planHibernation', () => {
  const ami = { rootVolumeGb: 120, hibernationSupported: true };
  const m9g2xl = { hibernationSupported: true, memoryMiB: 32 * 1024 };

  it('configures hibernation and grows the root by the RAM size', () => {
    expect(planHibernation(true, ami, m9g2xl)).toEqual({ configured: true, rootVolumeGb: 152, reason: null });
    expect(planHibernation(true, ami, { hibernationSupported: true, memoryMiB: 3900 }).rootVolumeGb).toBe(124);
  });

  it('stays off, quietly, when not enabled', () => {
    expect(planHibernation(false, ami, m9g2xl)).toEqual({ configured: false, rootVolumeGb: 120, reason: null });
  });

  it('stays off, saying why, when the AMI, the type or its description is missing support', () => {
    expect(planHibernation(true, { ...ami, hibernationSupported: false }, m9g2xl).reason).toMatch(/AMI is not tagged Hibernation=supported/);
    expect(planHibernation(true, ami, null).reason).toMatch(/could not describe/);
    expect(planHibernation(true, ami, { ...m9g2xl, hibernationSupported: false }).reason).toMatch(/does not support/);
    expect(planHibernation(true, ami, { hibernationSupported: true, memoryMiB: 0 })).toMatchObject({ configured: false, rootVolumeGb: 120 });
  });
});

describe('amiWithDisk: the disk a box was asked for, as its root volume', () => {
  const ami = { imageId: 'ami-1', rootDeviceName: '/dev/sda1', rootVolumeGb: 120, imageGb: 120, hibernationSupported: true, termagSha: null, createdAt: null };

  it('sizes the root to the disk asked for, above the image or below the configured floor', () => {
    expect(amiWithDisk(ami, 200).rootVolumeGb).toBe(200);
    expect(amiWithDisk({ ...ami, imageGb: 60 }, 80).rootVolumeGb).toBe(80);
  });

  it('never goes under the image\'s snapshot, which EC2 refuses: 50 on the 120 GB image is 120', () => {
    expect(amiWithDisk(ami, 50).rootVolumeGb).toBe(120);
  });

  it('keeps the AMI as it is with no disk asked for', () => {
    expect(amiWithDisk(ami, null)).toBe(ami);
    expect(amiWithDisk(ami, undefined)).toBe(ami);
  });

  it('takes the root size as the floor for an AMI that does not report its image size', () => {
    const { imageGb: _, ...bare } = ami;
    expect(amiWithDisk(bare, 50).rootVolumeGb).toBe(120);
  });

  it('is what hibernation adds the RAM to: 200 GB on a 32 GB type is a 232 GB root', () => {
    expect(planHibernation(true, amiWithDisk(ami, 200), { hibernationSupported: true, memoryMiB: 32 * 1024 }).rootVolumeGb).toBe(232);
  });
});
