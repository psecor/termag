import { describe, it, expect } from 'vitest';
import { sshKeyNotice } from './sshKeyNotice';

describe('sshKeyNotice', () => {
  it('names the boxes a key was installed on or removed from', () => {
    expect(sshKeyNotice('added', { updated: ['box-1', 'box-2'], pending: [] }))
      .toEqual({ text: 'Key added. Installed on box-1, box-2.', warn: false });
    expect(sshKeyNotice('removed', { updated: ['box-1'], pending: [] }))
      .toEqual({ text: 'Key removed. Removed from box-1.', warn: false });
  });

  it('says which boxes a removed key still works on, and warns', () => {
    expect(sshKeyNotice('removed', { updated: ['box-1'], pending: ['box-2'] })).toEqual({
      text: 'Key removed. Removed from box-1. box-2 still accepts it until its agent next connects.',
      warn: true,
    });
    expect(sshKeyNotice('removed', { updated: [], pending: ['a', 'b'] }).text)
      .toBe('Key removed. a, b still accept it until their agents next connect.');
  });

  it('lists boxes an added key has not reached without warning', () => {
    expect(sshKeyNotice('added', { updated: [], pending: ['box-2'] })).toEqual({
      text: 'Key added. Not yet on box-2; each is updated when its agent next connects.',
      warn: false,
    });
  });

  it('covers owners with no boxes', () => {
    expect(sshKeyNotice('added', { updated: [], pending: [] }).text).toMatch(/new boxes get it at launch/);
    expect(sshKeyNotice('removed', { updated: [], pending: [] })).toEqual({ text: 'Key removed. You have no boxes to update.', warn: false });
  });

  it('warns when the orchestrator could not check the boxes', () => {
    expect(sshKeyNotice('removed', null)).toEqual({
      text: 'Key removed, but termag could not check your boxes. Each box is updated when its agent next connects.',
      warn: true,
    });
    expect(sshKeyNotice('added', null).warn).toBe(true);
  });
});
