import { describe, expect, it } from 'vitest';
import { chatRevokeError } from './chatRevoke';
import { archivePowerFor, deleteTerminatesBox, otherProjectsFromTotal, reopenPlanFor, reopenRelease } from './chatLifecycle';

const box = (status: string, extra: object = {}) => ({ kind: 'ec2', status, ...extra });

describe('archivePowerFor', () => {
  it('stops the chat\'s box, or hibernates it when it was launched able to', () => {
    expect(archivePowerFor(box('ready'), 0)).toEqual({ action: 'stop' });
    expect(archivePowerFor(box('ready', { hibernationConfigured: true }), 0)).toEqual({ action: 'hibernate' });
  });

  it('leaves the box alone when something else lives there, it is not termag\'s to power, or it is not up', () => {
    expect(archivePowerFor(box('ready'), 1)).toMatchObject({ action: null, reason: 'other projects still use this box' });
    expect(archivePowerFor({ kind: 'external', status: 'ready' }, 0).action).toBeNull();
    expect(archivePowerFor(box('stopped'), 0)).toMatchObject({ action: null, reason: 'the box is already stopped' });
    expect(archivePowerFor(box('provisioning'), 0)).toMatchObject({ action: null, reason: 'the box is provisioning' });
    expect(archivePowerFor(null, 0).action).toBeNull();
  });

  it('stops a box that is still coming up, and does not try to hibernate it', () => {
    expect(archivePowerFor(box('starting'), 0)).toEqual({ action: 'stop' });
    expect(archivePowerFor(box('starting', { hibernationConfigured: true }), 0)).toEqual({ action: 'stop' });
  });
});

describe('reopenRelease', () => {
  it('unarchives only after a connected revoke cleared the parked turn', () => {
    expect(reopenRelease(true, null)).toEqual({ unarchive: true });
  });

  it('stays archived when the connected box did not stop the turn', () => {
    expect(reopenRelease(true, 'Could not stop the chat on workstream main')).toEqual({
      unarchive: false,
      error: 'Could not stop the chat on workstream main',
    });
  });

  it('does not unarchive on the offline fail-open that archive allows', () => {
    // revokeChats returns null when the agent is disconnected, so the queue
    // is still on disk. Hello drops it only while the row stays archived.
    const offline = chatRevokeError(false, []);
    expect(offline).toBeNull();
    expect(reopenRelease(false, offline)).toEqual({ unarchive: false, pending: true });
  });
});

describe('reopenPlanFor', () => {
  it('starts a stopped or hibernated box, and needs nothing from one that is up', () => {
    expect(reopenPlanFor(box('stopped'))).toEqual({ start: true });
    expect(reopenPlanFor(box('hibernated'))).toEqual({ start: true });
    expect(reopenPlanFor(box('ready'))).toEqual({ start: false });
    expect(reopenPlanFor(box('starting'))).toEqual({ start: false });
    expect(reopenPlanFor({ kind: 'external', status: 'ready' })).toEqual({ start: false });
  });

  it('refuses while the box is still going down, and when it is gone', () => {
    expect(reopenPlanFor(box('stopping'))).toMatchObject({ refused: { status: 409 } });
    expect(reopenPlanFor(box('hibernating'))).toMatchObject({ refused: { status: 409 } });
    expect(reopenPlanFor(box('terminated'))).toMatchObject({ refused: { error: expect.stringMatching(/Delete the chat/) } });
    expect(reopenPlanFor(null)).toMatchObject({ refused: { status: 409 } });
  });
});

describe('deleteTerminatesBox', () => {
  it('terminates the chat\'s own box, never one that holds another project or is gone already', () => {
    expect(deleteTerminatesBox(box('stopped'), 0)).toBe(true);
    expect(deleteTerminatesBox(box('hibernated'), 0)).toBe(true);
    expect(deleteTerminatesBox(box('stopped'), 1)).toBe(false);
    expect(deleteTerminatesBox(box('terminated'), 0)).toBe(false);
    expect(deleteTerminatesBox(null, 0)).toBe(false);
  });
});

describe('otherProjectsFromTotal', () => {
  it('drops the chat itself from the count of projects on its box', () => {
    expect(otherProjectsFromTotal(1)).toBe(0);
    expect(otherProjectsFromTotal(3)).toBe(2);
    expect(otherProjectsFromTotal(0)).toBe(0);
  });
});
