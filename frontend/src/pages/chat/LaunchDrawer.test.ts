import { describe, expect, it } from 'vitest';
import type { Instance } from '../../types';
import type { BoxSizeOptions } from '../../utils/boxSize';
import { boxLine, launchableBoxes, newBoxDetails, newBoxNamed, newBoxSummary, newBoxTitle } from './LaunchDrawer';

const box = (status: Instance['status'], projects?: Instance['projects']) =>
  ({ id: status, name: status, kind: 'ec2', ec2InstanceId: `i-${status}`, status, createdAt: '', projects }) as Instance;

describe('launchableBoxes', () => {
  it('offers boxes that are up, coming up, or asleep, and not failed or going away', () => {
    const all = (['ready', 'provisioning', 'awaiting-agent', 'starting', 'hibernated', 'stopped', 'failed', 'stopping', 'hibernating', 'terminated'] as const).map(s => box(s));
    expect(launchableBoxes(all).map(b => b.status)).toEqual(['ready', 'provisioning', 'awaiting-agent', 'starting', 'hibernated', 'stopped']);
  });

  it('offers an asleep box only when the start route could wake it', () => {
    const external = { ...box('stopped'), id: 'ext', kind: 'external', ec2InstanceId: null } as Instance;
    const noInstance = { ...box('hibernated'), id: 'gone', ec2InstanceId: null } as Instance;
    expect(launchableBoxes([external, noInstance, box('stopped')]).map(b => b.id)).toEqual(['stopped']);
  });
});

describe('boxLine', () => {
  it('says how many sessions a running box has', () => {
    expect(boxLine(box('ready'), false)).toBe('Running');
    expect(boxLine(box('ready', [{ id: '1', name: 'a' }]), false)).toBe('Running · 1 session');
    expect(boxLine(box('ready', [{ id: '1', name: 'a' }, { id: '2', name: 'b' }]), false)).toBe('Running · 2 sessions');
  });

  it('says an asleep box wakes when picked, and that one waking is', () => {
    expect(boxLine(box('hibernated'), false)).toBe('Hibernated · wakes when you pick it');
    expect(boxLine(box('stopped'), false)).toBe('Stopped · wakes when you pick it');
    expect(boxLine(box('hibernated'), true)).toBe('Waking up…');
    expect(boxLine(box('starting'), false)).toBe('Waking up…');
    expect(boxLine(box('provisioning'), false)).toBe('Coming up…');
  });

  it('ends with the box\'s size when it has one', () => {
    expect(boxLine({ ...box('ready'), size: 'small' }, false)).toBe('Running · small');
    expect(boxLine({ ...box('ready', [{ id: '1', name: 'a' }]), size: 'medium' }, false)).toBe('Running · 1 session · medium');
    expect(boxLine({ ...box('stopped'), size: 'large' }, false)).toBe('Stopped · wakes when you pick it · large');
    expect(boxLine({ ...box('ready'), size: null }, false)).toBe('Running');
  });

  it('names a box sized by its repository\'s requirements by the type it got, as the lists do (Bugbot, #1002)', () => {
    expect(boxLine({ ...box('ready'), size: '4vcpu-32gib', instanceType: 'r8g.xlarge' }, false)).toBe('Running · r8g.xlarge');
    // Before EC2 has said which type, the requirements themselves, never the raw label.
    expect(boxLine({ ...box('starting'), size: '4vcpu-32gib', instanceType: null, diskGiB: 200 }, false)).toBe('Waking up… · 4 vCPU, 32 GB · 200 GB disk');
    // A preset stays its name, and a box with no size shows none, whatever its type.
    expect(boxLine({ ...box('ready'), size: 'medium', instanceType: 'm8g.xlarge' }, false)).toBe('Running · medium');
    expect(boxLine({ ...box('ready'), size: null, instanceType: 't4g.medium' }, false)).toBe('Running');
  });

  it('ends with the disk it was made with after the size, and alone without one', () => {
    expect(boxLine({ ...box('ready'), size: 'medium', diskGiB: 200 }, false)).toBe('Running · medium · 200 GB disk');
    expect(boxLine({ ...box('stopped'), size: null, diskGiB: 120 }, false)).toBe('Stopped · wakes when you pick it · 120 GB disk');
    expect(boxLine({ ...box('ready'), size: 'small', diskGiB: null }, false)).toBe('Running · small');
  });
});

describe('newBoxSummary', () => {
  const SIZES: BoxSizeOptions = {
    enabled: true, default: 'medium', defaultSize: 'medium',
    sizes: [
      { size: 'small', vcpus: 2, memoryGiB: 8, instanceType: 'm8g.large' },
      { size: 'medium', vcpus: 4, memoryGiB: 16, instanceType: 'm8g.xlarge' },
      { size: 'large', vcpus: 8, memoryGiB: 32, instanceType: 'm8g.2xlarge' },
    ],
  };
  const DISK = { minGiB: 50, maxGiB: 300, defaultGiB: 120, diskGiB: 120 };
  const fields = { name: 'web', defaultName: 'web', sizes: SIZES, picked: null, disk: DISK, typed: null };
  /** What the trigger and the choice show, then their tooltip's lines. */
  const say = (s: ReturnType<typeof newBoxSummary>) => [newBoxTitle(s), ...newBoxDetails(s)];

  it('is plain New box while nothing was changed, with the defaults in its tooltip', () => {
    expect(newBoxSummary(fields)).toEqual({ customized: false, name: 'web', settings: 'Medium · 120 GB disk', poolDiskGiB: null });
    expect(newBoxNamed(newBoxSummary(fields))).toBe(false);
    expect(say(newBoxSummary(fields))).toEqual(['New box', 'A new box of its own', 'Medium · 120 GB disk', 'From the warm pool when there is one']);
    // Picking or typing what was offered anyway changes nothing.
    expect(newBoxSummary({ ...fields, picked: 'medium', typed: '120', name: ' web ' }).customized).toBe(false);
  });

  it('goes by the box\'s name once its name, size or disk is changed, with what was picked in the tooltip', () => {
    expect(say(newBoxSummary({ ...fields, name: 'termag-21' }))).toEqual(['termag-21', 'termag-21, a new box', 'Medium · 120 GB disk', 'From the warm pool when there is one']);
    expect(say(newBoxSummary({ ...fields, picked: 'large' }))).toEqual(['web', 'web, a new box', 'Large · 120 GB disk', 'From the warm pool when there is one']);
  });

  it('never promises the warm pool for a disk bigger than its boxes have, picked or the repository\'s (Devin, #1480)', () => {
    const launched = 'Launched new: the warm pool\'s boxes have 120 GB disks';
    expect(newBoxSummary({ ...fields, typed: '200' }).poolDiskGiB).toBe(120);
    expect(say(newBoxSummary({ ...fields, typed: '200' }))).toEqual(['web', 'web, a new box', 'Medium · 200 GB disk', launched]);
    // A repository's .termag/environment.json asking for 200 GB: nothing changed, and still launched.
    expect(say(newBoxSummary({ ...fields, disk: { ...DISK, diskGiB: 200 } }))).toEqual(['New box', 'A new box of its own', 'Medium · 200 GB disk', launched]);
    // Typing the pool's disk back, or one that isn't a size yet, says nothing it can't keep.
    expect(newBoxSummary({ ...fields, disk: { ...DISK, diskGiB: 200 }, typed: '120' }).poolDiskGiB).toBeNull();
    expect(newBoxSummary({ ...fields, typed: '9000' }).poolDiskGiB).toBeNull();
    // A smaller one may still be claimed: the server raises it to the image's snapshot (120 GB) first.
    expect(say(newBoxSummary({ ...fields, typed: '80' }))).toEqual(['web', 'web, a new box', 'Medium · 80 GB disk', 'From the warm pool when there is one']);
  });

  it('lists no disk while the one typed is not a size the server takes, and still counts it as a change', () => {
    expect(newBoxSummary({ ...fields, typed: '9000' })).toEqual({ customized: true, name: 'web', settings: 'Medium', poolDiskGiB: null });
    expect(newBoxSummary({ ...fields, typed: '' })).toEqual({ customized: true, name: 'web', settings: 'Medium', poolDiskGiB: null });
  });

  it('names a repository\'s own type, and leaves out what the server has not said', () => {
    const repo = { ...SIZES, defaultRequirements: { vcpu: 4, memoryGiB: 32, instanceType: 'r8g.xlarge' } };
    expect(newBoxSummary({ ...fields, sizes: repo }).settings).toBe('r8g.xlarge · 120 GB disk');
    expect(newBoxSummary({ ...fields, sizes: repo, picked: 'small' })).toEqual({ customized: true, name: 'web', settings: 'Small · 120 GB disk', poolDiskGiB: null });
    // Sizes off, or the answer not in yet: no size; no disk either until it comes.
    expect(say(newBoxSummary({ ...fields, sizes: null }))).toEqual(['New box', 'A new box of its own', '120 GB disk', 'From the warm pool when there is one']);
    expect(say(newBoxSummary({ ...fields, sizes: null, disk: null }))).toEqual(['New box', 'A new box of its own', 'From the warm pool when there is one']);
  });

  it('stays New box while the name is emptied, with what was picked in the tooltip', () => {
    const s = newBoxSummary({ ...fields, name: '', picked: 'large' });
    expect(s.customized).toBe(true);
    expect(newBoxNamed(s)).toBe(false);
    expect(say(s)).toEqual(['New box', 'A new box of its own', 'Large · 120 GB disk', 'From the warm pool when there is one']);
  });
});
