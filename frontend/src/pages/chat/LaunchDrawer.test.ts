import { describe, expect, it } from 'vitest';
import type { Instance } from '../../types';
import { boxLine, launchableBoxes } from './LaunchDrawer';

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
