import { describe, it, expect } from 'vitest';
import { buildSignals, type SignalsInput, type SignalCloud } from './signals';
import type { SessionRow } from '../sessionInventory';
import type { CloudSignalSession, Capacity } from './claudeRunnerQueries';

const now = Date.parse('2026-10-03T12:00:00Z');
const day = 86_400_000;
const d = (msAgo: number) => new Date(now - msAgo);

const base: SignalsInput = {
  instances: [], projects: [], sessions: [], userTokens: [],
  todayKey: '2026-10-03',
  baselineKeys: ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'],
  unknownWorktimeUsernames: [],
};
const box = (over: Partial<SignalsInput['instances'][number]>): SignalsInput['instances'][number] => ({
  id: 'i1', name: 'b1', status: 'ready', kind: 'ec2', createdAt: d(30 * day), connected: true,
  userId: 'u1', unixUsername: 'alice', projectCount: 2, lastProjectActiveAt: d(1 * day), provisioningError: null, ...over,
});
const session = (over: Partial<SessionRow>): SessionRow => ({
  projectId: 'p1', projectName: 'proj', owner: 'alice', ownerUserId: 'u1', access: 'owner', workstream: 'main', role: 'agent',
  session: 'alice-proj-agent', instanceId: 'i1', connected: true, alive: true, status: 'idle', contextTokens: null,
  updatedAt: d(0).toISOString(), waitingReason: null, rateLimited: null, provider: 'claude', lastActiveAt: d(0).toISOString(), ...over,
});

describe('buildSignals', () => {
  it('flags idle, disconnected, stuck and failed boxes', () => {
    const out = buildSignals({ ...base, instances: [
      box({ id: 'idle', lastProjectActiveAt: d(10 * day) }),
      box({ id: 'off', connected: false, lastProjectActiveAt: d(2 * day) }),
      box({ id: 'idle-off', connected: false, lastProjectActiveAt: d(12 * day) }),
      box({ id: 'stuck', status: 'provisioning', createdAt: d(20 * 60_000) }),
      box({ id: 'fresh', status: 'provisioning', createdAt: d(5 * 60_000) }),
      box({ id: 'failed', status: 'failed', provisioningError: 'boom' }),
      box({ id: 'gone', status: 'terminated' }),
      box({ id: 'empty-off', connected: false, projectCount: 0 }),
    ] }, now);
    expect(out.map(s => s.kind + ':' + s.instanceId)).toEqual(expect.arrayContaining([
      'box_idle:idle', 'box_disconnected:off', 'box_stuck:stuck', 'box_failed:failed',
    ]));
    expect(out.find(s => s.instanceId === 'fresh')).toBeUndefined();
    expect(out.find(s => s.instanceId === 'gone')).toBeUndefined();
    expect(out.find(s => s.instanceId === 'empty-off')).toBeUndefined();
    expect(out.find(s => s.instanceId === 'off')!.severity).toBe('warning');
    // Idle wins over disconnected for the same box: one signal, with the offline note folded in.
    expect(out.filter(s => s.instanceId === 'idle-off').map(s => s.kind)).toEqual(['box_idle']);
    expect(out.find(s => s.instanceId === 'idle-off')!.detail).toContain('agent offline');
  });

  it('flags long waits, rate limits and context danger on connected agent panes only', () => {
    const out = buildSignals({ ...base, sessions: [
      session({ session: 'w', status: 'waiting', updatedAt: d(45 * 60_000).toISOString(), waitingReason: 'approval' }),
      session({ session: 'wc', status: 'waiting', updatedAt: d(3 * 3_600_000).toISOString() }),
      session({ session: 'short', status: 'waiting', updatedAt: d(5 * 60_000).toISOString() }),
      session({ session: 'rl', rateLimited: 'resets 3pm' }),
      session({ session: 'ctx', status: 'working', contextTokens: 1_200_000 }),
      session({ session: 'ctrl', role: 'ctrl', status: 'waiting', updatedAt: d(5 * 3_600_000).toISOString() }),
      session({ session: 'offline', connected: false, status: 'waiting', updatedAt: d(5 * 3_600_000).toISOString() }),
    ] }, now);
    const ids = out.map(s => s.id);
    expect(ids).toEqual(expect.arrayContaining(['agent_waiting:w', 'agent_waiting:wc', 'agent_rate_limited:rl', 'agent_context:ctx']));
    expect(ids.some(i => i.endsWith(':short') || i.endsWith(':ctrl') || i.endsWith(':offline'))).toBe(false);
    expect(out.find(s => s.id === 'agent_waiting:wc')!.severity).toBe('critical');
    expect(out[0].id).toBe('agent_waiting:wc'); // critical first
  });

  it('flags token burn against the trailing median and both cache-ratio extremes', () => {
    const days = (tokens: number[], input: number, cacheRead: number) => Object.fromEntries(
      [...base.baselineKeys, base.todayKey].map((k, i) => [k, { tokens: tokens[i] ?? 0, input, cacheRead }]));
    const out = buildSignals({ ...base, userTokens: [
      { userId: 'u1', unixUsername: 'burn', days: days([1e6, 1e6, 1e6, 1e6, 3.5e6], 1e6, 1e5) },
      { userId: 'u2', unixUsername: 'quiet', days: days([1e5, 1e5, 1e5, 1e5, 5e5], 1e3, 0) },
      { userId: 'u3', unixUsername: 'cached', days: days([1e6, 1e6, 1e6, 1e6, 1e6], 1e5, 9e5) },
    ] }, now);
    const burn = out.find(s => s.kind === 'token_burn');
    expect(burn).toMatchObject({ userId: 'u1', severity: 'critical' });
    expect(out.find(s => s.kind === 'cache_ratio_low')).toMatchObject({ userId: 'u1' });
    expect(out.find(s => s.kind === 'cache_ratio_high')).toMatchObject({ userId: 'u3', severity: 'good' });
    expect(out.find(s => s.userId === 'u2')).toBeUndefined();
  });

  it('groups stale projects per user and reports unattributed worktime usernames', () => {
    const out = buildSignals({ ...base,
      projects: [
        { id: 'a', name: 'old1', userId: 'u1', unixUsername: 'alice', archived: false, lastActiveAt: d(40 * day), kind: 'normal' },
        { id: 'b', name: 'old2', userId: 'u1', unixUsername: 'alice', archived: false, lastActiveAt: d(31 * day), kind: 'normal' },
        { id: 'c', name: 'archived', userId: 'u1', unixUsername: 'alice', archived: true, lastActiveAt: d(90 * day), kind: 'normal' },
        { id: 'd', name: 'metaterm', userId: 'u1', unixUsername: 'alice', archived: false, lastActiveAt: d(90 * day), kind: 'metaterm' },
        { id: 'e', name: 'fresh', userId: 'u2', unixUsername: 'bob', archived: false, lastActiveAt: d(1 * day), kind: 'normal' },
      ],
      unknownWorktimeUsernames: ['jo-ann'],
    }, now);
    expect(out.filter(s => s.kind === 'project_stale')).toHaveLength(1);
    expect(out.find(s => s.kind === 'project_stale')!.title).toContain('2 stale projects');
    expect(out.find(s => s.kind === 'worktime_unattributed')!.detail).toContain('jo-ann');
  });

  it('does not call a box idle while it serves cloud sessions', () => {
    const out = buildSignals({ ...base, instances: [
      box({ id: 'cloud-only', projectCount: 0, lastProjectActiveAt: null, lastCloudRunAt: d(2 * 3_600_000) }),
      box({ id: 'cloud-old', projectCount: 0, lastProjectActiveAt: null, lastCloudRunAt: d(9 * day) }),
      box({ id: 'both', lastProjectActiveAt: d(10 * day), lastCloudRunAt: d(1 * day) }),
    ] }, now);
    expect(out.find(s => s.instanceId === 'cloud-only')).toBeUndefined();
    expect(out.find(s => s.instanceId === 'both')).toBeUndefined();
    expect(out.find(s => s.instanceId === 'cloud-old')?.kind).toBe('box_idle');
  });
});

describe('buildSignals: cloud sessions and the orchestrator', () => {
  const capacity = (over: Partial<Capacity> = {}): Capacity => ({
    max: 3, boxes: [], owners: {}, totals: { eligibleBoxes: 0, slotsUsed: 0, slotsFree: 0 }, generatedAt: d(0).toISOString(), ...over,
  });
  // Each fixture session is one run; `runs` and `lostRuns` mirror the session's own fields unless a case says otherwise.
  const cs = (over: Partial<CloudSignalSession>): CloudSignalSession => {
    const base: CloudSignalSession = {
      key: 'cse_A', sessionId: 'cse_A', userId: 'u1', owner: 'alice', state: 'running', instanceId: 'i1', boxName: 'b1', slot: 2,
      startedAt: d(3_600_000), endedAt: null, exitReason: null, started: true, queuedSince: null, queuedReason: null, live: null, lostRuns: [], runs: [], ...over,
    };
    if (!over.runs && base.instanceId && base.startedAt) base.runs = [{ orderId: base.key, instanceId: base.instanceId, boxName: base.boxName ?? '?', startedAt: base.startedAt, endedAt: base.endedAt, started: base.started, kept: false }];
    if (!over.lostRuns && base.state === 'lost' && base.instanceId && base.endedAt) base.lostRuns = [{ instanceId: base.instanceId, boxName: base.boxName ?? '?', endedAt: base.endedAt }];
    return base;
  };
  const cloud = (sessions: CloudSignalSession[], cap: Capacity = capacity()): SignalCloud => ({ sessions, capacity: cap });

  it('flags queued sessions by how long they have waited, with the owner\'s box states, and owners at the cap', () => {
    const cap = capacity({ owners: {
      u1: { owner: 'alice', eligibleBoxes: 1, slotsUsed: 3, slotsFree: 0, atCap: true, boxes: '1 ready · full' },
      u2: { owner: 'bob', eligibleBoxes: 0, slotsUsed: 0, slotsFree: 0, atCap: false, boxes: '1 stopped' },
    } });
    const out = buildSignals({ ...base, cloud: cloud([
      cs({ key: 'q-warn', state: 'queued', queuedSince: d(6 * 60_000), queuedReason: 'every box full', instanceId: null, boxName: null }),
      cs({ key: 'q-crit', userId: 'u2', owner: 'bob', state: 'queued', queuedSince: d(20 * 60_000), queuedReason: 'no ready box', instanceId: null }),
      cs({ key: 'q-fresh', userId: 'u3', owner: 'cat', state: 'queued', queuedSince: d(60_000), queuedReason: 'no ready box', instanceId: null }),
    ], cap) }, now);
    expect(out.find(s => s.id === 'cloud_queued:q-warn')).toMatchObject({ severity: 'warning', userId: 'u1' });
    expect(out.find(s => s.id === 'cloud_queued:q-warn')!.detail).toContain('1 ready · full');
    expect(out.find(s => s.id === 'cloud_queued:q-crit')).toMatchObject({ severity: 'critical' });
    expect(out.find(s => s.id === 'cloud_queued:q-crit')!.detail).toContain('1 stopped');
    expect(out.find(s => s.id === 'cloud_queued:q-fresh')).toBeUndefined();
    expect(out.find(s => s.kind === 'cloud_boxes_full')).toMatchObject({ userId: 'u1', severity: 'notice' });
    expect(out.filter(s => s.kind === 'cloud_boxes_full')).toHaveLength(1);
  });

  it('emits one cap signal per owner however many of their sessions queue', () => {
    const cap = capacity({ owners: { u1: { owner: 'alice', eligibleBoxes: 1, slotsUsed: 3, slotsFree: 0, atCap: true, boxes: '1 ready · full' } } });
    const out = buildSignals({ ...base, cloud: cloud([
      cs({ key: 'q1', state: 'queued', queuedSince: d(6 * 60_000), queuedReason: 'full', instanceId: null, boxName: null, startedAt: null }),
      cs({ key: 'q2', state: 'queued', queuedSince: d(7 * 60_000), queuedReason: 'full', instanceId: null, boxName: null, startedAt: null }),
    ], cap) }, now);
    expect(out.filter(s => s.kind === 'cloud_boxes_full')).toHaveLength(1);
    expect(out.filter(s => s.kind === 'cloud_queued')).toHaveLength(2);
    expect(new Set(out.map(s => s.id)).size).toBe(out.length);
  });

  it('flags a running session waiting on its owner, from the live entry, with the project thresholds', () => {
    const out = buildSignals({ ...base, cloud: cloud([
      cs({ key: 'w', live: { status: 'waiting', waitingReason: 'approval', contextTokens: null, rateLimited: null, updatedAt: d(45 * 60_000) } }),
      cs({ key: 'wc', live: { status: 'waiting', waitingReason: null, contextTokens: null, rateLimited: null, updatedAt: d(3 * 3_600_000) } }),
      cs({ key: 'short', live: { status: 'waiting', waitingReason: null, contextTokens: null, rateLimited: null, updatedAt: d(60_000) } }),
      cs({ key: 'busy', live: { status: 'working', waitingReason: null, contextTokens: null, rateLimited: null, updatedAt: d(3 * 3_600_000) } }),
      cs({ key: 'starting', state: 'starting', started: false, live: { status: 'waiting', waitingReason: null, contextTokens: null, rateLimited: null, updatedAt: d(3 * 3_600_000) } }),
    ]) }, now);
    const ids = out.map(s => s.id);
    expect(ids).toEqual(expect.arrayContaining(['cloud_waiting:w', 'cloud_waiting:wc']));
    expect(ids.some(i => i.endsWith(':short') || i.endsWith(':busy') || i.endsWith(':starting'))).toBe(false);
    expect(out.find(s => s.id === 'cloud_waiting:wc')).toMatchObject({ severity: 'critical', instanceId: 'i1' });
    expect(out.find(s => s.id === 'cloud_waiting:w')!.detail).toContain('approval');
  });

  it('raises the pane kinds for a running cloud session over the context line or rate limited', () => {
    const out = buildSignals({ ...base, cloud: cloud([
      cs({ key: 'ctx', live: { status: 'working', waitingReason: null, contextTokens: 1_200_000, rateLimited: null, updatedAt: d(60_000) } }),
      cs({ key: 'rl', live: { status: 'idle', waitingReason: null, contextTokens: 10_000, rateLimited: 'resets 3pm', updatedAt: d(60_000) } }),
      cs({ key: 'fine', live: { status: 'working', waitingReason: null, contextTokens: 10_000, rateLimited: null, updatedAt: d(60_000) } }),
    ]) }, now);
    expect(out.find(s => s.id === 'agent_context:cloud:ctx')).toMatchObject({ kind: 'agent_context', severity: 'warning', instanceId: 'i1' });
    expect(out.find(s => s.id === 'agent_rate_limited:cloud:rl')).toMatchObject({ kind: 'agent_rate_limited', detail: 'resets 3pm' });
    expect(out.filter(s => s.id.endsWith(':fine'))).toHaveLength(0);
  });

  it('groups lost runs of the last day per box, and notices a box whose runs never post started', () => {
    const out = buildSignals({ ...base, cloud: cloud([
      cs({ key: 'l1', state: 'lost', exitReason: 'lost', endedAt: d(2 * 3_600_000), started: false, startedAt: d(5 * 3_600_000) }),
      cs({ key: 'l2', state: 'lost', exitReason: 'lost', endedAt: d(5 * 3_600_000), started: true, startedAt: d(6 * 3_600_000) }),
      cs({ key: 'old', state: 'lost', exitReason: 'lost', endedAt: d(3 * day), started: true, startedAt: d(4 * day) }),
      // Box i2: two runs, none ever posted started, the older one well past the grace.
      cs({ key: 's1', instanceId: 'i2', boxName: 'b2', state: 'ended', exitReason: 'completed', endedAt: d(day), started: false, startedAt: d(2 * day) }),
      cs({ key: 's2', instanceId: 'i2', boxName: 'b2', state: 'starting', started: false, startedAt: d(60_000) }),
      // Box i3: one fresh starting run, too young to judge.
      cs({ key: 'fresh', instanceId: 'i3', boxName: 'b3', state: 'starting', started: false, startedAt: d(60_000) }),
    ]) }, now);
    const lost = out.find(s => s.kind === 'cloud_lost');
    expect(lost).toMatchObject({ instanceId: 'i1', severity: 'warning', metric: 2 });
    expect(lost!.title).toContain('2 cloud runs lost on b1');
    // A session resumed under a new order after a loss: the current run is fine, the earlier loss still counts.
    const resumed = buildSignals({ ...base, cloud: cloud([
      cs({ key: 'r', state: 'running', lostRuns: [{ instanceId: 'i9', boxName: 'b9', endedAt: d(3_600_000) }] }),
    ]) }, now);
    expect(resumed.find(s => s.kind === 'cloud_lost')).toMatchObject({ instanceId: 'i9', metric: 1 });
    // A run that started before the window and posted started then is not an unreported start.
    const oldStart = buildSignals({ ...base, cloud: cloud([
      cs({ key: 'o', instanceId: 'i4', boxName: 'b4', state: 'ended', exitReason: 'completed', endedAt: d(day), started: true, startedAt: d(9 * day) }),
    ]) }, now);
    expect(oldStart.find(s => s.kind === 'cloud_stale_box')).toBeUndefined();
    expect(out.filter(s => s.kind === 'cloud_stale_box').map(s => s.instanceId)).toEqual(['i2']);
    // i1 has runs with started: not stale.
    expect(out.find(s => s.id === 'cloud_stale_box:i1')).toBeUndefined();
  });

  it('calls the orchestrator down when the unit does not answer, is not connected, or has not polled for five minutes', () => {
    const o = (over: Partial<NonNullable<SignalsInput['orchestrator']>>) => ({ configured: true, available: true, connected: true, lastPollAt: d(10_000), reason: null, ...over });
    expect(buildSignals({ ...base, orchestrator: o({}) }, now).find(s => s.kind === 'orchestrator_down')).toBeUndefined();
    expect(buildSignals({ ...base, orchestrator: o({ available: false, reason: 'ECONNREFUSED' }) }, now).find(s => s.kind === 'orchestrator_down')).toMatchObject({ severity: 'critical' });
    expect(buildSignals({ ...base, orchestrator: o({ connected: false }) }, now).find(s => s.kind === 'orchestrator_down')!.detail).toContain('last poll of Anthropic failed');
    expect(buildSignals({ ...base, orchestrator: o({ lastPollAt: d(6 * 60_000) }) }, now).find(s => s.kind === 'orchestrator_down')!.detail).toContain('6m ago');
    expect(buildSignals({ ...base, orchestrator: o({ lastPollAt: d(3 * 60_000) }) }, now).find(s => s.kind === 'orchestrator_down')).toBeUndefined();
    // A host without the orchestrator has nothing to judge.
    expect(buildSignals({ ...base, orchestrator: o({ configured: false, available: false }) }, now).find(s => s.kind === 'orchestrator_down')).toBeUndefined();
  });

});

describe('buildSignals: box updates', () => {
  it('warns on a failed update run within a week and notices a restart deferred for a day', () => {
    const out = buildSignals({ ...base, instances: [
      box({ id: 'failed', update: { at: d(3_600_000), outcome: 'failed', detail: 'pull=current reconcile=clean deps=failed agent=blocked:deps' } }),
      box({ id: 'old-fail', update: { at: d(9 * day), outcome: 'failed', detail: null } }),
      box({ id: 'deferred', update: { at: d(2 * day), outcome: 'deferred', detail: 'pull=pulled:2 reconcile=clean deps=unchanged agent=deferred:runner' } }),
      box({ id: 'fresh-defer', update: { at: d(3_600_000), outcome: 'deferred', detail: null } }),
      box({ id: 'rebooted', agentCommit: 'b'.repeat(40), update: { at: d(2 * day), outcome: 'deferred', detail: null, commit: 'b'.repeat(40) } }),
      box({ id: 'still-old', agentCommit: 'a'.repeat(40), update: { at: d(2 * day), outcome: 'deferred', detail: null, commit: 'b'.repeat(40) } }),
      box({ id: 'offline-defer', connected: false, agentCommit: null, update: { at: d(2 * day), outcome: 'deferred', detail: null, commit: 'b'.repeat(40) } }),
      box({ id: 'ok', update: { at: d(3_600_000), outcome: 'updated', detail: null } }),
    ] }, now);
    expect(out.find(s => s.id === 'box_update_failed:failed')).toMatchObject({ severity: 'warning' });
    expect(out.find(s => s.id === 'box_update_failed:failed')!.detail).toContain('deps=failed');
    expect(out.find(s => s.id === 'box_update_failed:old-fail')).toBeUndefined();
    expect(out.find(s => s.id === 'box_update_deferred:deferred')).toMatchObject({ severity: 'notice' });
    expect(out.find(s => s.id === 'box_update_deferred:fresh-defer')).toBeUndefined();
    expect(out.find(s => s.id === 'box_update_deferred:rebooted')).toBeUndefined();
    expect(out.find(s => s.id === 'box_update_deferred:still-old')).toMatchObject({ severity: 'notice' });
    expect(out.find(s => s.id === 'box_update_deferred:offline-defer')).toMatchObject({ severity: 'notice' });
    expect(out.filter(s => s.instanceId === 'ok' && s.kind.startsWith('box_update'))).toHaveLength(0);
  });
});

describe('buildSignals: host pressure', () => {
  const host = (over: Partial<NonNullable<SignalsInput['instances'][number]['host']>>) => ({ diskUsedPct: 40, memUsedPct: 30, load1: 1.5, keptCheckouts: 0, sampledAt: d(60_000), ...over });
  it('warns at 85% disk or 90% memory, critical at 95% disk, only on a fresh sample, beside the other box signals', () => {
    const out = buildSignals({ ...base, instances: [
      box({ id: 'fine', host: host({}) }),
      box({ id: 'disk', host: host({ diskUsedPct: 93, keptCheckouts: 2 }) }),
      box({ id: 'full', host: host({ diskUsedPct: 96 }) }),
      box({ id: 'mem', host: host({ memUsedPct: 92 }) }),
      box({ id: 'stale', host: host({ diskUsedPct: 99, sampledAt: d(2 * 3_600_000) }) }),
      box({ id: 'both', host: host({ diskUsedPct: 90 }), lastProjectActiveAt: d(10 * day) }),
    ] }, now);
    const p = (id: string) => out.find(s => s.kind === 'box_pressure' && s.instanceId === id);
    expect(p('fine')).toBeUndefined();
    expect(p('disk')).toMatchObject({ severity: 'warning' });
    expect(p('disk')!.detail).toContain('2 kept cloud checkouts');
    expect(p('full')).toMatchObject({ severity: 'critical' });
    expect(p('mem')).toMatchObject({ severity: 'warning' });
    expect(p('stale')).toBeUndefined();
    // Pressure and idle are different faults: both fire for the same box.
    expect(out.filter(s => s.instanceId === 'both').map(s => s.kind).sort()).toEqual(['box_idle', 'box_pressure']);
  });

  it('notices kept checkouts from what the box holds now, so a rescued one stops the notice', () => {
    const out = buildSignals({ ...base, instances: [
      box({ id: 'kept', host: host({ keptCheckouts: 2 }) }),
      box({ id: 'rescued', host: host({ keptCheckouts: 0 }) }),
      box({ id: 'stale', host: host({ keptCheckouts: 3, sampledAt: d(2 * 3_600_000) }) }),
    ] }, now);
    const kept = out.filter(s => s.kind === 'cloud_kept_checkout');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ instanceId: 'kept', severity: 'notice', metric: 2 });
    expect(kept[0].title).toContain('2 cloud checkouts kept on b1');
  });
});
