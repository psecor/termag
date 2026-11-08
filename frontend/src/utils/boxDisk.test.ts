import { describe, expect, it } from 'vitest';
import { boxDiskLabel, diskInputError, diskNote, diskShown, diskToSend, type BoxDiskOptions } from './boxDisk';

const DISK: BoxDiskOptions = { minGiB: 50, maxGiB: 300, defaultGiB: 120, diskGiB: 120 };
const REPO_DISK: BoxDiskOptions = { ...DISK, diskGiB: 250 };

describe('what the disk field shows', () => {
  it('shows what the server says a box for the repository gets until the person types', () => {
    expect(diskShown(DISK, null)).toBe('120');
    expect(diskShown(REPO_DISK, null)).toBe('250');
    expect(diskShown(REPO_DISK, '80')).toBe('80');
    expect(diskShown(REPO_DISK, '')).toBe('');
  });
});

describe('what the disk field sends', () => {
  it('sends nothing until the person types, so the server\'s order (the repo file, else 120) applies', () => {
    expect(diskToSend(REPO_DISK, null)).toBeUndefined();
    expect(diskToSend(null, '200')).toBeUndefined();
  });

  it('sends what was typed, as a number, when it is in range', () => {
    expect(diskToSend(DISK, '200')).toBe(200);
    expect(diskToSend(DISK, ' 50 ')).toBe(50);
    expect(diskToSend(DISK, '300')).toBe(300);
  });

  it('sends nothing for what it refuses', () => {
    for (const typed of ['', '49', '301', '120.5', 'big', '1e2']) expect(diskToSend(DISK, typed), typed).toBeUndefined();
  });
});

describe('the disk field\'s error', () => {
  it('names the range for anything that is not a whole number in it', () => {
    for (const typed of ['', '49', '301', '120.5', 'big']) expect(diskInputError(DISK, typed), typed).toBe('A whole number of GB from 50 to 300');
  });

  it('is nothing before the person types, or for a number in range', () => {
    expect(diskInputError(DISK, null)).toBeNull();
    expect(diskInputError(DISK, '200')).toBeNull();
    expect(diskInputError(null, 'big')).toBeNull();
  });
});

describe('the note under it: only when another disk makes the box slow to come', () => {
  it('says another disk launches a new box when a ready one is waiting', () => {
    expect(diskNote(DISK, '200', true)).toBe('A 200 GB disk means launching a new box, a few minutes; the ready ones have 120 GB.');
    expect(diskNote(REPO_DISK, null, true)).toBe('A 250 GB disk means launching a new box, a few minutes; the ready ones have 120 GB.');
  });

  it('says nothing for the default disk, a smaller one the server raises and can still claim, with no ready box (it is slow either way), or for a value it refuses', () => {
    expect(diskNote(DISK, null, true)).toBeNull();
    expect(diskNote(DISK, '120', true)).toBeNull();
    // A smaller one is raised to the image's 120 GB before the pool is asked, so a warm box may still be claimed.
    expect(diskNote(DISK, '80', true)).toBeNull();
    expect(diskNote({ ...DISK, diskGiB: 80 }, null, true)).toBeNull();
    expect(diskNote(DISK, '200', false)).toBeNull();
    expect(diskNote(DISK, '500', true)).toBeNull();
    expect(diskNote(null, '200', true)).toBeNull();
  });
});

describe('a box\'s disk where its size is shown', () => {
  it('reads "200 GB disk", and nothing for a box from before disks were recorded', () => {
    expect(boxDiskLabel(200)).toBe('200 GB disk');
    expect(boxDiskLabel(null)).toBeNull();
    expect(boxDiskLabel(undefined)).toBeNull();
  });
});
