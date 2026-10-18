import { describe, expect, it } from 'vitest';
import { cliWsUrl } from './api.js';
import { applyStatusFrame, parseFrame } from './statusSocket.js';
import type { SessionRow } from './types.js';

describe('cliWsUrl', () => {
  it('switches scheme and targets the CLI socket paths, with no token in the URL', () => {
    expect(cliWsUrl('http://h:3040/termag', 'status')).toBe('ws://h:3040/termag/api/cli/v1/ws/status');
    expect(cliWsUrl('https://h/termag/', 'terminal', new URLSearchParams({ session: 'u-p-agent' }))).toBe('wss://h/termag/api/cli/v1/ws/terminal?session=u-p-agent');
  });
});

describe('parseFrame', () => {
  it('accepts status and heartbeat frames, from strings or buffers, rejects the rest', () => {
    expect(parseFrame(JSON.stringify({ type: 'heartbeat', ts: 5 }))).toEqual({ type: 'heartbeat', ts: 5 });
    expect(parseFrame(JSON.stringify({ type: 'status', session: 's', status: 'working' }))).toMatchObject({ type: 'status', session: 's' });
    expect(parseFrame(Buffer.from(JSON.stringify({ type: 'status', session: 's', status: 'idle' })))).toMatchObject({ status: 'idle' });
    expect(parseFrame(JSON.stringify({ type: 'status' }))).toBeNull();
    expect(parseFrame('nope')).toBeNull();
    expect(parseFrame(42)).toBeNull();
  });
});

describe('applyStatusFrame', () => {
  const row: SessionRow = {
    projectId: 'p', projectName: 'p', owner: 'u', access: 'owner', workstream: 'main', role: 'agent', session: 'u-p-agent',
    instanceId: null, connected: true, alive: true, status: 'idle', contextTokens: 10, updatedAt: null,
    waitingReason: null, rateLimited: null, provider: 'claude', lastActiveAt: '',
  };
  it('takes the review state from a frame and keeps it when a frame omits review', () => {
    const map = { 'p/main/agent': row };
    const reviewing = applyStatusFrame(map, { type: 'status', session: 'u-p-agent', status: 'idle', review: { state: 'reviewing' } });
    expect(reviewing['p/main/agent'].reviewState).toBe('reviewing');
    expect(applyStatusFrame(reviewing, { type: 'status', session: 'u-p-agent', status: 'working' })['p/main/agent'].reviewState).toBe('reviewing');
    expect(applyStatusFrame(reviewing, { type: 'status', session: 'u-p-agent', status: 'idle', review: null })['p/main/agent'].reviewState).toBeNull();
  });
  // The map is keyed by project/workstream/role (see model.ts), never by session name.
  it('updates the row with that session name and keeps fields the frame omits', () => {
    const map = { 'p/main/agent': row };
    const next = applyStatusFrame(map, { type: 'status', session: 'u-p-agent', status: 'waiting', waitingReason: 'approval' });
    expect(next['p/main/agent']).toMatchObject({ status: 'waiting', waitingReason: 'approval', contextTokens: 10, alive: true });
    expect(next).not.toBe(map);
  });
  it('matches by box when the frame names one; same-named sessions elsewhere are untouched', () => {
    const map = { 'pA/main/agent': { ...row, projectId: 'pA', instanceId: 'A' }, 'pB/main/agent': { ...row, projectId: 'pB', instanceId: 'B' } };
    const next = applyStatusFrame(map, { type: 'status', session: 'u-p-agent', instanceId: 'B', status: 'working' });
    expect(next['pA/main/agent'].status).toBe('idle');
    expect(next['pB/main/agent'].status).toBe('working');
    // an older backend's frame (no instanceId) updates every row with that name
    const both = applyStatusFrame(map, { type: 'status', session: 'u-p-agent', status: 'working' });
    expect([both['pA/main/agent'].status, both['pB/main/agent'].status]).toEqual(['working', 'working']);
  });
  it('ignores sessions the poll has not seen', () => {
    const map = { 'p/main/agent': row };
    expect(applyStatusFrame(map, { type: 'status', session: 'other', status: 'working' })).toBe(map);
  });
});
