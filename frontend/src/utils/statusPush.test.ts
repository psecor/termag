import { describe, expect, it } from 'vitest';
import { statusFromPush } from './statusPush';

describe('statusFromPush', () => {
  it('keeps the handoff, the milestone and the review', () => {
    const handoff = { id: 'h1', state: 'resetting', mode: 'compact', at: '2026-10-18T07:37:13.098Z' };
    const s = statusFromPush({
      type: 'status', session: 's', status: 'idle', updatedAt: '2026-10-18T07:37:13.098Z',
      handoff, milestone: { kind: 'pr' }, review: { state: 'running' },
    });
    expect(s.handoff).toEqual(handoff);
    expect(s.milestone).toEqual({ kind: 'pr' });
    expect(s.review).toEqual({ state: 'running' });
  });

  it('turns an absent handoff into null', () => {
    expect(statusFromPush({ status: 'working', updatedAt: 'x' }).handoff).toBeNull();
  });
});
