import { describe, it, expect, afterEach } from 'vitest';
import { isAutoProvisionFirstBoxEnabled, pickFreeBoxName } from './boxProvisioner';

const ORIGINAL = process.env.AUTO_PROVISION_FIRST_BOX;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.AUTO_PROVISION_FIRST_BOX;
  else process.env.AUTO_PROVISION_FIRST_BOX = ORIGINAL;
});

describe('isAutoProvisionFirstBoxEnabled', () => {
  it('is off by default (unset)', () => {
    delete process.env.AUTO_PROVISION_FIRST_BOX;
    expect(isAutoProvisionFirstBoxEnabled()).toBe(false);
  });

  it('accepts true / 1 / yes (case-insensitive, trimmed)', () => {
    for (const v of ['true', 'TRUE', ' true ', '1', 'yes', 'YES']) {
      process.env.AUTO_PROVISION_FIRST_BOX = v;
      expect(isAutoProvisionFirstBoxEnabled()).toBe(true);
    }
  });

  it('treats anything else as off', () => {
    for (const v of ['false', '0', 'no', '', 'off', 'enabled']) {
      process.env.AUTO_PROVISION_FIRST_BOX = v;
      expect(isAutoProvisionFirstBoxEnabled()).toBe(false);
    }
  });
});

describe('pickFreeBoxName', () => {
  it('returns the base name when nothing is taken', () => {
    expect(pickFreeBoxName(new Set(), 'default')).toBe('default');
  });

  it('skips a name still held by a terminated box (the bug: re-provision after terminate)', () => {
    // Terminated rows keep occupying the (userId, name) unique index, so the
    // base name is unavailable even though the user has zero active boxes.
    expect(pickFreeBoxName(new Set(['default']), 'default')).toBe('default-2');
  });

  it('finds the first free suffix past a run of taken names', () => {
    expect(pickFreeBoxName(new Set(['default', 'default-2', 'default-3']), 'default')).toBe('default-4');
  });

  it('ignores gaps and returns the lowest free suffix', () => {
    expect(pickFreeBoxName(new Set(['default', 'default-3']), 'default')).toBe('default-2');
  });
});
