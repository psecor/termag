import { describe, expect, it } from 'vitest';
import { boxImageBadge, boxNameTitle } from './boxImage';

describe('boxImageBadge', () => {
  it('marks nothing for the published image or an unrecorded one', () => {
    expect(boxImageBadge('ami-0123456789abcdef0', 'published')).toBe(null);
    expect(boxImageBadge(null, null)).toBe(null);
    expect(boxImageBadge(undefined, undefined)).toBe(null);
  });

  it('names the channel, with the image id in the title', () => {
    expect(boxImageBadge('ami-0123456789abcdef0', 'channel:hibernation')).toEqual({
      label: 'hibernation', title: 'candidate image ami-0123456789abcdef0 (channel hibernation)', fallback: false,
    });
  });

  it('marks a pin', () => {
    expect(boxImageBadge('ami-0123456789abcdef0', 'pinned')).toMatchObject({ label: 'pinned', fallback: false });
  });

  it('says when the asked-for image was unusable', () => {
    expect(boxImageBadge('ami-0aaaaaaaaaaaaaaaa', 'fallback:channel:hibernation')).toEqual({
      label: 'published',
      title: 'box-image channel:hibernation was unusable; launched from the published image ami-0aaaaaaaaaaaaaaaa',
      fallback: true,
    });
  });
});

describe('boxNameTitle', () => {
  it('joins what is known', () => {
    expect(boxNameTitle('ip-10-0-0-1.ec2.internal', 'ami-0123456789abcdef0')).toBe('ip-10-0-0-1.ec2.internal · image ami-0123456789abcdef0');
    expect(boxNameTitle(null, 'ami-0123456789abcdef0')).toBe('image ami-0123456789abcdef0');
    expect(boxNameTitle(null, null)).toBe(undefined);
  });
});
