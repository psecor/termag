import { describe, expect, it } from 'vitest';
import type { CloudSession } from '../types';
import { cloudByBox, cloudCountLabel, cloudDotStatus, cloudElsewhere, cloudLabel, cloudStateLabel, cloudTitle, fmtDurationSec, platformLabel } from './cloudSessions';
import { statusKey } from './statusKey';

const session = (over: Partial<CloudSession> = {}): CloudSession => ({
  key: 'cse_01A', sessionId: 'cse_01A', url: 'https://claude.ai/code/session_01A', seq: 3, name: 'Claude Cloud 3', title: 'Fix the auth bug', clientPlatform: 'web_claude_ai',
  state: 'running', exitReason: null, queuedReason: null, queuedSince: null,
  current: { orderId: 'ord.1', instanceId: 'box-a', boxName: 'ada-box', slot: 2, sessionName: 'ada-claude-runner-s2-ord_d1-r', startedAt: '2026-10-08T10:00:00.000Z', endedAt: null, durationSec: null, exitStatus: null, exitReason: null, alive: true, usage: null, checkoutBytes: null, kept: null },
  runs: [], firstSeenAt: '2026-10-08T10:00:00.000Z', lastSeenAt: '2026-10-08T10:05:00.000Z', eventCount: 2, ...over,
});

describe('cloudDotStatus', () => {
  it('reads the status map under the runner tmux name for a running session, idle when nothing posted yet', () => {
    const s = session();
    expect(cloudDotStatus(s, { [statusKey('box-a', 'ada-claude-runner-s2-ord_d1-r')]: { status: 'working', updatedAt: 'x' } })).toBe('working');
    expect(cloudDotStatus(s, {})).toBe('idle');
  });
  it('is not running for a starting or queued session, whatever the map says', () => {
    const map = { [statusKey('box-a', 'ada-claude-runner-s2-ord_d1-r')]: { status: 'working' as const, updatedAt: 'x' } };
    expect(cloudDotStatus(session({ state: 'starting' }), map)).toBe('not_running');
    expect(cloudDotStatus(session({ state: 'queued', current: null }), map)).toBe('not_running');
  });
});

describe('labels', () => {
  it('names the state, with the exit reason for an ended session, and the platform', () => {
    expect(cloudStateLabel(session())).toBe('running');
    expect(cloudStateLabel(session({ state: 'ended', exitReason: 'completed' }))).toBe('ended · completed');
    expect(cloudStateLabel(session({ state: 'lost', exitReason: 'lost' }))).toBe('lost');
    expect(platformLabel('web_claude_ai')).toBe('web');
    expect(platformLabel('ios')).toBe('iOS');
    expect(platformLabel('something_new')).toBe('something_new');
    expect(platformLabel(null)).toBeNull();
    expect(cloudTitle(session({ title: null }))).toBe('untitled session');
  });
  it('labels a session by its fixed name, with the title after it when there is one', () => {
    expect(cloudLabel(session())).toBe('Claude Cloud 3 · Fix the auth bug');
    expect(cloudLabel(session({ title: null }))).toBe('Claude Cloud 3');
    expect(cloudLabel(session({ seq: null, name: 'Claude Cloud', title: null }))).toBe('Claude Cloud');
    expect(cloudCountLabel(0)).toBe('');
    expect(cloudCountLabel(2)).toBe('2 cloud');
    expect(fmtDurationSec(null)).toBe('—');
    expect(fmtDurationSec(42)).toBe('42s');
    expect(fmtDurationSec(600)).toBe('10m');
    expect(fmtDurationSec(5400)).toBe('1h 30m');
  });
});

describe('cloudByBox', () => {
  it('groups active sessions by their box, slot order, queued ones apart, ended ones out', () => {
    const { byBox, queued } = cloudByBox([
      session({ key: 'a', current: { ...session().current!, slot: 3 } }),
      session({ key: 'b', current: { ...session().current!, slot: 2 } }),
      session({ key: 'c', state: 'starting', current: { ...session().current!, instanceId: 'box-b', boxName: 'other' } }),
      session({ key: 'q', state: 'queued', current: null, queuedReason: 'no box' }),
      session({ key: 'e', state: 'ended', exitReason: 'completed' }),
    ]);
    expect(byBox.get('box-a')!.map(s => s.key)).toEqual(['b', 'a']);
    expect(byBox.get('box-b')!.map(s => s.key)).toEqual(['c']);
    expect(queued.map(s => s.key)).toEqual(['q']);
  });
});

describe('cloudElsewhere', () => {
  it('finds the runs whose box is not in the current list', () => {
    const { byBox } = cloudByBox([session({ key: 'a' }), session({ key: 'b', current: { ...session().current!, instanceId: 'box-gone' } })]);
    expect(cloudElsewhere(byBox, new Set(['box-a'])).map(s => s.key)).toEqual(['b']);
    expect(cloudElsewhere(byBox, new Set(['box-a', 'box-gone']))).toEqual([]);
  });
});
