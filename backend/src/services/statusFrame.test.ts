import { describe, expect, it } from 'vitest';
import { statusFrame } from './statusFrame';

const at = new Date('2026-10-28T14:05:00.000Z');

describe('statusFrame', () => {
  it('carries what termag events reads: status, waitingReason, stoppedAt and the box', () => {
    const frame = JSON.parse(statusFrame('alice-web-agent', {
      status: 'waiting', updatedAt: at, waitingReason: 'approval', stoppedAt: new Date('2026-10-28T13:00:00.000Z'), instanceId: 'box1',
    }));
    expect(frame).toEqual({
      type: 'status', session: 'alice-web-agent', status: 'waiting', updatedAt: '2026-10-28T14:05:00.000Z',
      waitingReason: 'approval', stoppedAt: '2026-10-28T13:00:00.000Z', instanceId: 'box1',
    });
  });

  it('leaves stoppedAt out for a session that never came to rest, and keeps a hydrated null', () => {
    expect(JSON.parse(statusFrame('alice-web-agent', { status: 'working', updatedAt: at }))).not.toHaveProperty('stoppedAt');
    expect(JSON.parse(statusFrame('alice-web-agent', { status: 'idle', updatedAt: at, stoppedAt: null })).stoppedAt).toBeNull();
  });
});
