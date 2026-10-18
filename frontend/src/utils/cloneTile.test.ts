import { describe, expect, it } from 'vitest';
import type { Instance } from '../types';
import { cloneHoldCopy, cloneInFlight, cloneTile, setupContext } from './cloneTile';

describe('cloneTile', () => {
  it('opens the terminal for a project that was never a clone and one that finished', () => {
    const open = {
      phase: null, label: null, holdTerminal: false, retry: false, startEmpty: false,
    };
    expect(cloneTile(undefined)).toEqual(open);
    expect(cloneTile(null)).toEqual(open);
    expect(cloneTile('')).toEqual(open);
    expect(cloneTile('none')).toEqual(open);
    expect(cloneTile('ready')).toEqual(open);
  });

  it('shows waiting for box, then cloning, and holds the terminal for both', () => {
    expect(cloneTile('pending')).toEqual({
      phase: 'waiting', label: 'waiting for box', holdTerminal: true, retry: false, startEmpty: false,
    });
    expect(cloneTile('cloning')).toEqual({
      phase: 'cloning', label: 'cloning', holdTerminal: true, retry: false, startEmpty: false,
    });
    expect(cloneInFlight('pending')).toBe(true);
    expect(cloneInFlight('cloning')).toBe(true);
    expect(cloneInFlight('failed')).toBe(false);
    expect(cloneInFlight('ready')).toBe(false);
  });

  it('offers Retry and Start empty only after the clone fails', () => {
    expect(cloneTile('failed')).toEqual({
      phase: 'failed', label: 'clone failed', holdTerminal: true, retry: true, startEmpty: true,
    });
    expect(cloneTile('pending').retry).toBe(false);
    expect(cloneTile('cloning').startEmpty).toBe(false);
  });

  it('holds an unknown status with no badge and no actions', () => {
    expect(cloneTile('garbage')).toEqual({
      phase: null, label: null, holdTerminal: true, retry: false, startEmpty: false,
    });
  });
});

describe('cloneHoldCopy', () => {
  it('names the phase, and the failure line when the clone recorded one', () => {
    expect(cloneHoldCopy('pending', null)).toBe('waiting for box');
    expect(cloneHoldCopy('cloning', null)).toBe('cloning');
    expect(cloneHoldCopy('failed', null)).toBe('clone failed');
    expect(cloneHoldCopy('failed', '  fatal: repository not found  ')).toBe('clone failed: fatal: repository not found');
    expect(cloneHoldCopy('ready', 'stale')).toBe('');
    expect(cloneHoldCopy('garbage', null)).toBe('This project is not ready.');
  });
});

describe('a project waiting on a new box', () => {
  const boxes: Pick<Instance, 'id' | 'status' | 'provisioningError'>[] = [
    { id: 'b-up', status: 'provisioning', provisioningError: null },
    { id: 'b-bad', status: 'failed', provisioningError: 'RunInstances refused' },
  ];

  it('waits while its box boots, and offers Retry once the box failed or is gone', () => {
    expect(cloneTile('pending', setupContext({ instanceId: 'b-up' }, boxes, true)).label).toBe('waiting for box');
    const failed = setupContext({ instanceId: 'b-bad' }, boxes, true);
    expect(cloneTile('pending', failed)).toEqual({
      phase: 'failed', label: 'box failed', holdTerminal: true, retry: true, startEmpty: false,
    });
    expect(cloneHoldCopy('pending', null, failed))
      .toBe('The box failed to launch: RunInstances refused. Retry on the project launches a new one.');
    expect(cloneTile('pending', setupContext({ instanceId: 'b-gone' }, boxes, true)).label).toBe('box failed');
  });

  it('does not read a box as gone before the feed loads, or for a collaborator', () => {
    expect(cloneTile('pending', setupContext({ instanceId: 'b-gone' }, [], false)).label).toBe('waiting for box');
    expect(cloneTile('pending', setupContext({ instanceId: 'b-gone', role: 'collaborator' }, boxes, true)).label)
      .toBe('waiting for box');
  });

  it("calls an empty project's failure a setup failure, with Retry but no Start empty", () => {
    const ctx = setupContext({ instanceId: 'b-up', repoUrl: null }, boxes, true);
    expect(cloneTile('failed', ctx)).toMatchObject({ label: 'setup failed', retry: true, startEmpty: false });
    expect(cloneHoldCopy('failed', 'tmux refused', ctx)).toBe('setup failed: tmux refused');
    expect(cloneTile('failed', setupContext({ instanceId: 'b-up', repoUrl: 'https://github.com/a/b' }, boxes, true)).label)
      .toBe('clone failed');
  });
});
