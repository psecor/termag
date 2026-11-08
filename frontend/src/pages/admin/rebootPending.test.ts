import { describe, expect, it } from 'vitest';
import { pendingFor, rebootCellText, rebootPanelText, rebootSince, rebootWhy } from './rebootPending';

const cell = (version: string | null, raw: string | null, state: 'pending' | 'current' | 'unknown') => ({ version, raw, path: null, state, observedAt: '2026-11-03T10:00:00Z' });
const now = Date.parse('2026-11-03T12:10:00Z');

describe('reboot pending', () => {
  it('reads since and why from the row', () => {
    const raw = 'since 2026-11-03T06:10:00Z · kernel 6.8.0-1068-aws installed · packages: linux-base';
    expect(rebootSince(raw)).toBe('2026-11-03T06:10:00Z');
    expect(rebootWhy(raw)).toBe('kernel 6.8.0-1068-aws installed · packages: linux-base');
    expect(rebootSince('reboot-required')).toBeNull();
    expect(rebootWhy('booted 2026-11-01T08:00:00Z')).toBeNull();
  });
  it('says how long in minutes, hours or days', () => {
    expect(pendingFor('since 2026-11-03T12:00:00Z', now)).toBe('10 min');
    expect(pendingFor('since 2026-11-03T06:10:00Z', now)).toBe('6 h');
    expect(pendingFor('since 2026-10-30T12:10:00Z', now)).toBe('4 d');
    expect(pendingFor(null, now)).toBeNull();
  });
  it('the cell and the panel', () => {
    expect(rebootCellText(cell('pending', 'since 2026-11-03T06:10:00Z', 'pending'), now)).toBe('pending · 6 h');
    expect(rebootCellText(cell('pending', 'reboot-required', 'pending'), now)).toBe('pending');
    expect(rebootCellText(cell('no', 'booted 2026-11-01T08:00:00Z', 'current'), now)).toBe('no');
    expect(rebootPanelText(cell('no', null, 'current'), now)).toBeNull();
    expect(rebootPanelText(undefined, now)).toBeNull();
    expect(rebootPanelText(cell('pending', 'reboot-required', 'pending'), now)).toBe('Reboot pending: reboot-required. The next boot (a park and start, a resize) takes it.');
  });
});
