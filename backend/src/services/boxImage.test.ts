import { describe, expect, it, vi } from 'vitest';

vi.mock('./featureFlags', () => ({ stringVariation: vi.fn(async () => '') }));

const {
  BOX_IMAGE_FLAG, PUBLISHED_IMAGE, boxImageSelectionFor, boxImageSource, fallbackImageSource,
  parseBoxImageFlag, pickSelectedImage, selectionKey,
} = await import('./boxImage');
const { stringVariation } = await import('./featureFlags');

const AMI = 'ami-0123456789abcdef0';
const image = (over: Record<string, unknown> = {}, tags: Record<string, string> = {}) => ({
  ImageId: AMI,
  State: 'available',
  CreationDate: '2026-10-01T00:00:00.000Z',
  ...over,
  Tags: Object.entries({ App: 'termag', Component: 'box-candidate', ...tags }).map(([Key, Value]) => ({ Key, Value })),
});

describe('parseBoxImageFlag', () => {
  it('reads empty, missing and whitespace as the published image, without a warning', () => {
    for (const v of ['', '   ', undefined, null]) {
      expect(parseBoxImageFlag(v)).toEqual({ selection: PUBLISHED_IMAGE, warning: null });
    }
  });

  it('reads an AMI id as a pin, in both id lengths', () => {
    expect(parseBoxImageFlag(AMI).selection).toEqual({ kind: 'pinned', amiId: AMI });
    expect(parseBoxImageFlag(' ami-12345678 ').selection).toEqual({ kind: 'pinned', amiId: 'ami-12345678' });
  });

  it('reads anything else that is a channel name as a channel', () => {
    expect(parseBoxImageFlag('hibernation').selection).toEqual({ kind: 'channel', channel: 'hibernation' });
    expect(parseBoxImageFlag('m9g-test-2').selection).toEqual({ kind: 'channel', channel: 'm9g-test-2' });
  });

  it.each([
    ['a malformed AMI id', 'ami-xyz'],
    ['an upper-case channel', 'Hibernation'],
    ['a channel with a space', 'two words'],
    ['a channel starting with a dash', '-x'],
    ['a channel over 32 characters', 'a'.repeat(33)],
  ])('falls back to published with a warning for %s', (_name, value) => {
    const parsed = parseBoxImageFlag(value);
    expect(parsed.selection).toEqual(PUBLISHED_IMAGE);
    expect(parsed.warning).toContain(BOX_IMAGE_FLAG);
  });

  it('falls back to published for a non-string value (a misconfigured flag variation)', () => {
    expect(parseBoxImageFlag(true)).toMatchObject({ selection: PUBLISHED_IMAGE, warning: expect.stringContaining('not a string') });
  });
});

describe('the recorded source', () => {
  it('names what was chosen, and what was asked for on a fallback', () => {
    expect(boxImageSource(PUBLISHED_IMAGE)).toBe('published');
    expect(boxImageSource({ kind: 'channel', channel: 'hibernation' })).toBe('channel:hibernation');
    expect(boxImageSource({ kind: 'pinned', amiId: AMI })).toBe('pinned');
    expect(fallbackImageSource({ kind: 'channel', channel: 'hibernation' })).toBe('fallback:channel:hibernation');
    expect(fallbackImageSource({ kind: 'pinned', amiId: AMI })).toBe(`fallback:pinned:${AMI}`);
  });

  it('keys two pins apart', () => {
    expect(selectionKey({ kind: 'pinned', amiId: 'ami-11111111' })).not.toBe(selectionKey({ kind: 'pinned', amiId: 'ami-22222222' }));
  });
});

describe('pickSelectedImage', () => {
  const channel = { kind: 'channel', channel: 'hibernation' } as const;
  const pin = { kind: 'pinned', amiId: AMI } as const;

  it('takes the newest image of the channel', () => {
    const older = image({ ImageId: 'ami-11111111', CreationDate: '2026-09-01T00:00:00.000Z' }, { Channel: 'hibernation' });
    const newer = image({ ImageId: 'ami-22222222', CreationDate: '2026-10-05T00:00:00.000Z' }, { Channel: 'hibernation' });
    const other = image({ ImageId: 'ami-33333333', CreationDate: '2026-10-09T00:00:00.000Z' }, { Channel: 'other' });
    expect(pickSelectedImage([older, other, newer], channel)).toEqual({ image: newer });
  });

  it('takes a pinned image, published or candidate', () => {
    expect(pickSelectedImage([image()], pin)).toEqual({ image: image() });
    const published = image({}, { Component: 'box' });
    expect(pickSelectedImage([published], pin)).toEqual({ image: published });
  });

  it.each([
    ['nothing matches', [] as ReturnType<typeof image>[], 'no self-owned image'],
    ['the image is not available', [image({ State: 'pending' })], 'not an available termag box image'],
    ['the image is not ours', [image({}, { App: 'someone-else' })], 'not an available termag box image'],
    ['the image is an orchestrator image', [image({}, { Component: 'orchestrator' })], 'not an available termag box image'],
  ])('refuses a pin when %s', (_name, images, reason) => {
    const picked = pickSelectedImage(images, pin);
    expect(picked).toEqual({ reason: expect.stringContaining(reason) });
  });

  it('ignores channel images that are not box images', () => {
    expect(pickSelectedImage([image({}, { Channel: 'hibernation', Component: 'box-base' })], channel))
      .toEqual({ reason: expect.stringContaining('not an available termag box image') });
  });
});

describe('boxImageSelectionFor', () => {
  const ada = { id: 'u_ada', googleEmail: 'ada@example.com', displayName: 'Ada', unixUsername: 'ada', defaultAgentProvider: 'claude' };

  it('reads the flag for the user, and the box when there is one, with "" as the fallback', async () => {
    vi.mocked(stringVariation).mockResolvedValueOnce('hibernation');
    const box = { id: 'b1', name: 'ada-b1', kind: 'ec2' };
    expect(await boxImageSelectionFor(ada, box)).toEqual({ kind: 'channel', channel: 'hibernation' });
    expect(stringVariation).toHaveBeenCalledWith(BOX_IMAGE_FLAG, ada, '', box);
  });

  it('warns about and ignores a value it cannot use', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(stringVariation).mockResolvedValueOnce('ami-nope');
    expect(await boxImageSelectionFor(ada)).toEqual(PUBLISHED_IMAGE);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('using the published box image'));
    warn.mockRestore();
  });
});
