import { afterEach, describe, expect, it, vi } from 'vitest';
import { notifyOnSuccess, notifyWorkspaceChange, setWorkspaceChangeCallback } from './workspaceEvents';

describe('workspace change events', () => {
  afterEach(() => { setWorkspaceChangeCallback(null); vi.restoreAllMocks(); });

  it('tells the owner on a create (201) and a restore (200), and returns the result untouched', () => {
    const changed = vi.fn();
    setWorkspaceChangeCallback(changed);
    const created = { status: 201, body: { instance: { id: 'box-1' }, claimed: true } };
    expect(notifyOnSuccess(created, 'u1', 'boxes')).toBe(created);
    const restored = { status: 200, body: { id: 'p1', restored: true } };
    expect(notifyOnSuccess(restored, 'u1', 'projects')).toBe(restored);
    expect(changed.mock.calls).toEqual([['u1', 'boxes'], ['u1', 'projects']]);
  });

  it('tells the owner on an accepted power request (202), once per list named', () => {
    const changed = vi.fn();
    setWorkspaceChangeCallback(changed);
    notifyOnSuccess({ status: 202, body: { ok: true, status: 'stopping' } }, 'u1', 'boxes');
    notifyOnSuccess({ status: 200, body: { ok: true, archivedProjects: 1 } }, 'u1', ['boxes', 'projects']);
    expect(changed.mock.calls).toEqual([['u1', 'boxes'], ['u1', 'boxes'], ['u1', 'projects']]);
  });

  it('says nothing for a refusal or a failure', () => {
    const changed = vi.fn();
    setWorkspaceChangeCallback(changed);
    for (const status of [400, 403, 404, 409, 500, 502]) notifyOnSuccess({ status, body: { error: 'no' } }, 'u1', 'projects');
    expect(changed).not.toHaveBeenCalled();
  });

  it('never throws: a failing push is logged and the create still answers', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setWorkspaceChangeCallback(() => { throw new Error('socket gone'); });
    expect(() => notifyWorkspaceChange('u1', 'boxes')).not.toThrow();
    expect(notifyOnSuccess({ status: 201, body: {} }, 'u1', 'projects').status).toBe(201);
    expect(console.error).toHaveBeenCalledWith('[WORKSPACE] boxes change push failed:', 'socket gone');
  });

  it('is a no-op with nothing wired (tests, scripts)', () => {
    expect(() => notifyWorkspaceChange('u1', 'projects')).not.toThrow();
  });
});
