import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EC2Client } from '@aws-sdk/client-ec2';
import { hibernationEnabledFor, resolveBoxImage, type BoxConfig } from './boxProvisioner';

const cfg = { rootVolumeGb: 120 } as BoxConfig;

const img = (id: string, created: string, tags: Record<string, string>) => ({
  ImageId: id,
  State: 'available',
  CreationDate: created,
  RootDeviceName: '/dev/sda1',
  BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: 120 } }],
  Tags: Object.entries({ App: 'termag', ...tags }).map(([Key, Value]) => ({ Key, Value })),
});

const PUBLISHED = img('ami-0aaaaaaaaaaaaaaaa', '2026-10-10T00:00:00.000Z', { Component: 'box', TermagSha: 'a'.repeat(40) });
const CANDIDATE = img('ami-0bbbbbbbbbbbbbbbb', '2026-10-11T00:00:00.000Z', {
  Component: 'box-candidate', Channel: 'hibernation', Hibernation: 'supported', TermagSha: 'b'.repeat(40),
});

/** Answers DescribeImages the way EC2 does for these inputs: published by Component, channel by Channel, a pin by id. */
function fakeEc2(images: ReturnType<typeof img>[], opts: { failSelected?: boolean } = {}) {
  const calls: any[] = [];
  const tagOf = (i: ReturnType<typeof img>, k: string) => i.Tags.find(t => t.Key === k)?.Value;
  const ec2 = {
    send: vi.fn(async (cmd: { input: any }) => {
      const input = cmd.input;
      calls.push(input);
      if (input.ImageIds) {
        if (opts.failSelected) throw Object.assign(new Error('Invalid id'), { name: 'InvalidAMIID.NotFound' });
        return { Images: images.filter(i => input.ImageIds.includes(i.ImageId)) };
      }
      const filters: { Name: string; Values: string[] }[] = input.Filters;
      if (opts.failSelected && filters.some(f => f.Name === 'tag:Channel')) throw new Error('throttled');
      return {
        Images: images.filter(i => filters.every(f =>
          f.Name === 'state' ? f.Values.includes(i.State) : f.Values.includes(tagOf(i, f.Name.slice('tag:'.length)) ?? ''))),
      };
    }),
  };
  return { ec2: ec2 as unknown as EC2Client, calls };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('resolveBoxImage', () => {
  it('launches the newest published image when the flag is empty, and asks for nothing else', async () => {
    const { ec2, calls } = fakeEc2([PUBLISHED, CANDIDATE]);
    const r = await resolveBoxImage(ec2, cfg, { kind: 'published' });
    expect(r).toMatchObject({ source: 'published', selected: false, ami: { imageId: PUBLISHED.ImageId, termagSha: 'a'.repeat(40) } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ Owners: ['self'], Filters: expect.arrayContaining([{ Name: 'tag:Component', Values: ['box'] }]) });
  });

  it('launches the newest image of a channel, self-owned only', async () => {
    const { ec2, calls } = fakeEc2([PUBLISHED, CANDIDATE]);
    const r = await resolveBoxImage(ec2, cfg, { kind: 'channel', channel: 'hibernation' });
    expect(r).toMatchObject({ source: 'channel:hibernation', selected: true, ami: { imageId: CANDIDATE.ImageId, hibernationSupported: true } });
    expect(calls[0]).toMatchObject({ Owners: ['self'] });
  });

  it('launches a pinned image', async () => {
    const { ec2, calls } = fakeEc2([PUBLISHED, CANDIDATE]);
    const r = await resolveBoxImage(ec2, cfg, { kind: 'pinned', amiId: CANDIDATE.ImageId });
    expect(r).toMatchObject({ source: 'pinned', selected: true, ami: { imageId: CANDIDATE.ImageId } });
    expect(calls[0]).toEqual({ ImageIds: [CANDIDATE.ImageId], Owners: ['self'] });
  });

  it('falls back to the published image, with a warning, for a channel with no image', async () => {
    const { ec2 } = fakeEc2([PUBLISHED, CANDIDATE]);
    const r = await resolveBoxImage(ec2, cfg, { kind: 'channel', channel: 'nope' });
    expect(r).toMatchObject({ source: 'fallback:channel:nope', selected: false, ami: { imageId: PUBLISHED.ImageId } });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('launching from the published box image'));
  });

  it('falls back for a pin that is not a termag box image', async () => {
    const foreign = img('ami-0cccccccccccccccc', '2026-10-11T00:00:00.000Z', { Component: 'orchestrator' });
    const { ec2 } = fakeEc2([PUBLISHED, foreign]);
    const r = await resolveBoxImage(ec2, cfg, { kind: 'pinned', amiId: foreign.ImageId });
    expect(r).toMatchObject({ source: `fallback:pinned:${foreign.ImageId}`, selected: false, ami: { imageId: PUBLISHED.ImageId } });
  });

  it('falls back when the lookup itself fails (an id EC2 does not know throws)', async () => {
    const { ec2 } = fakeEc2([PUBLISHED, CANDIDATE], { failSelected: true });
    expect(await resolveBoxImage(ec2, cfg, { kind: 'pinned', amiId: 'ami-0dddddddddddddddd' }))
      .toMatchObject({ source: 'fallback:pinned:ami-0dddddddddddddddd', ami: { imageId: PUBLISHED.ImageId } });
    expect(await resolveBoxImage(ec2, cfg, { kind: 'channel', channel: 'hibernation' }))
      .toMatchObject({ source: 'fallback:channel:hibernation', ami: { imageId: PUBLISHED.ImageId } });
  });

  it('still fails the launch when there is no published image to fall back to', async () => {
    const { ec2 } = fakeEc2([]);
    await expect(resolveBoxImage(ec2, cfg, { kind: 'channel', channel: 'hibernation' })).rejects.toThrow('No box AMI found');
  });
});

describe('hibernationEnabledFor', () => {
  it('follows box-hibernation-enabled for the published image, and a fallback is the published image', () => {
    expect(hibernationEnabledFor(false, { selected: false })).toBe(false);
    expect(hibernationEnabledFor(true, { selected: false })).toBe(true);
  });

  it('lets an image the box-image flag chose hibernate with box-hibernation-enabled off, so its tag decides', () => {
    expect(hibernationEnabledFor(false, { selected: true })).toBe(true);
  });
});
