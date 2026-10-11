import { describe, expect, it } from 'vitest';
import { refuseUnreadySessions, SessionGateError } from './sessionGate';

describe('refuseUnreadySessions', () => {
  it('allows sessions for a plain project and for a cloned one', () => {
    expect(refuseUnreadySessions({ id: 'p1', setupStatus: 'none' })).toBe(null);
    expect(refuseUnreadySessions({ id: 'p1', setupStatus: 'ready' })).toBe(null);
  });

  it('refuses while setup owns the directory, saying why', () => {
    expect(refuseUnreadySessions({ id: 'p1', setupStatus: 'pending' })).toEqual({
      setupStatus: 'pending', message: 'This project is waiting for its box to clone the repository.',
    });
    expect(refuseUnreadySessions({ id: 'p1', setupStatus: 'cloning' })).toEqual({
      setupStatus: 'cloning', message: 'This project is still cloning its repository.',
    });
    expect(refuseUnreadySessions({ id: 'p1', setupStatus: 'failed' })).toEqual({
      setupStatus: 'failed', message: "This project's clone failed. Retry it or start empty.",
    });
  });

  it('fails closed on a status it does not know', () => {
    expect(refuseUnreadySessions({ id: 'p1', setupStatus: 'garbage' })).toEqual({
      setupStatus: 'garbage', message: 'This project is in an unknown setup state.',
    });
  });

  it("admits only the setup owner's launch, for this project in the status it read", () => {
    const admission = { projectId: 'p1', from: 'cloning' as const };
    expect(refuseUnreadySessions({ id: 'p1', setupStatus: 'cloning' }, admission)).toBe(null);
    expect(refuseUnreadySessions({ id: 'p1', setupStatus: 'pending' }, admission)?.setupStatus).toBe('pending');
    expect(refuseUnreadySessions({ id: 'p2', setupStatus: 'cloning' }, admission)?.setupStatus).toBe('cloning');
  });
});

describe('SessionGateError', () => {
  it('carries the refusal as its message', () => {
    const err = new SessionGateError({ setupStatus: 'cloning', message: 'This project is still cloning its repository.' });
    expect(err.message).toBe('This project is still cloning its repository.');
    expect(err.refusal.setupStatus).toBe('cloning');
  });
});
