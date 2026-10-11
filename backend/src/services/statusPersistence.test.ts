import { describe, it, expect } from 'vitest';
import {
  AUTO_IDLE_MS, HYDRATE_MAX_AGE_MS, hydrateStatus, persistRetryDelayMs, rowIsNewer, shouldPersist, toRow, WORKING_REFRESH_MS,
  type SessionStatusRow,
} from './statusPersistence';
import { MILESTONE_TTL_MS } from './milestone';
import type { AgentStatus } from '../types/index';

const NOW = Date.parse('2026-10-06T12:00:00Z');

function row(over: Partial<SessionStatusRow> = {}): SessionStatusRow {
  return {
    instanceKey: 'box-1', session: 'alice-proj-agent', status: 'waiting', updatedAt: new Date(NOW - 60_000),
    workingStartedAt: null, provider: null, source: null, message: null, waitingReason: null,
    threadId: null, contextTokens: null, rateLimited: null, milestone: null,
    ...over,
  };
}

function st(over: Partial<AgentStatus> = {}): AgentStatus {
  return { status: 'working', updatedAt: new Date(NOW), instanceId: 'box-1', ...over };
}

describe('persistRetryDelayMs', () => {
  it('doubles from 5 s and caps at 5 min', () => {
    expect([1, 2, 3, 4].map(persistRetryDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(persistRetryDelayMs(7)).toBe(300_000);
    expect(persistRetryDelayMs(50)).toBe(300_000);
  });
});

describe('toRow', () => {
  it('maps a box status with its open span and milestone', () => {
    const at = new Date(NOW - 1000);
    const r = toRow('box-1', 's-agent', st({
      source: 'pi-ext:pi', contextTokens: 1234, rateLimited: 'resets 3pm',
      milestone: { kind: 'pr_created', url: 'https://github.com/o/r/pull/1', at, contextTokens: 900 },
    }), { startedAt: NOW - 5000, provider: 'pi' });
    expect(r).toMatchObject({
      instanceKey: 'box-1', session: 's-agent', status: 'working',
      workingStartedAt: new Date(NOW - 5000), provider: 'pi', source: 'pi-ext:pi',
      contextTokens: 1234, rateLimited: 'resets 3pm',
      milestone: { kind: 'pr_created', url: 'https://github.com/o/r/pull/1', at: at.toISOString(), contextTokens: 900 },
    });
  });

  it('keys the orchestrator as the empty instance and leaves absent fields null', () => {
    const r = toRow(null, 's-agent', st({ status: 'idle', instanceId: null }), undefined);
    expect(r).toMatchObject({ instanceKey: '', workingStartedAt: null, provider: null, milestone: null, contextTokens: null });
  });
});

describe('shouldPersist', () => {
  it('writes the first status it sees and every transition', () => {
    expect(shouldPersist(undefined, st(), undefined, NOW)).toBe(true);
    expect(shouldPersist(st({ status: 'working' }), st({ status: 'waiting' }), NOW, NOW)).toBe(true);
  });

  it('does not write a repeated working hook inside the refresh window', () => {
    expect(shouldPersist(st({ message: 'Bash' }), st({ message: 'Edit' }), NOW - 10_000, NOW)).toBe(false);
  });

  it('refreshes a working row once per WORKING_REFRESH_MS so auto-idle re-arms near the right time', () => {
    expect(shouldPersist(st(), st(), NOW - WORKING_REFRESH_MS, NOW)).toBe(true);
  });

  it('does not refresh an unchanged waiting/idle row', () => {
    expect(shouldPersist(st({ status: 'waiting' }), st({ status: 'waiting' }), NOW - 10 * WORKING_REFRESH_MS, NOW)).toBe(false);
  });

  it.each([
    ['contextTokens', { contextTokens: 1 }, { contextTokens: 2 }],
    ['rateLimited', { rateLimited: null }, { rateLimited: 'resets 3pm' }],
    ['waitingReason', { status: 'waiting' as const, waitingReason: 'approval' as const }, { status: 'waiting' as const, waitingReason: 'user_input' as const }],
    ['source', {}, { source: 'cursor-poller' }],
    ['milestone', {}, { milestone: { kind: 'pr_merged' as const, url: null, at: new Date(NOW), contextTokens: null } }],
  ])('writes a %s change', (_name, a, b) => {
    expect(shouldPersist(st({ status: 'idle', ...a }), st({ status: 'idle', ...b }), NOW, NOW)).toBe(true);
  });

  it('treats undefined and null meta as the same value', () => {
    expect(shouldPersist(st({ status: 'idle', rateLimited: undefined }), st({ status: 'idle', rateLimited: null }), NOW, NOW)).toBe(false);
  });
});

describe('hydrateStatus', () => {
  it('brings a waiting session back as waiting, with its meta and instance', () => {
    const [h] = hydrateStatus([row({ waitingReason: 'approval', contextTokens: 5000, rateLimited: 'resets 3pm', message: 'Needs approval' })], NOW);
    expect(h).toMatchObject({
      instanceId: 'box-1', session: 'alice-proj-agent', rewrite: false,
      status: { status: 'waiting', instanceId: 'box-1', waitingReason: 'approval', contextTokens: 5000, rateLimited: 'resets 3pm', message: 'Needs approval' },
    });
    expect(h.span).toBeUndefined();
    expect(h.autoIdleInMs).toBeUndefined();
  });

  it('maps the empty instance key back to the orchestrator (null)', () => {
    expect(hydrateStatus([row({ instanceKey: '' })], NOW)[0]).toMatchObject({ instanceId: null, status: { instanceId: null } });
  });

  it('skips rows older than the max age and rows with an unknown status', () => {
    expect(hydrateStatus([
      row({ updatedAt: new Date(NOW - HYDRATE_MAX_AGE_MS - 1) }),
      row({ status: 'exploded' }),
    ], NOW)).toEqual([]);
  });

  it('resumes a working span from workingStartedAt and re-arms auto-idle for the remaining time', () => {
    const [h] = hydrateStatus([row({
      status: 'working', updatedAt: new Date(NOW - 60_000),
      workingStartedAt: new Date(NOW - 30 * 60_000), provider: 'pi',
    })], NOW);
    expect(h.status.status).toBe('working');
    expect(h.span).toEqual({ startedAt: NOW - 30 * 60_000, provider: 'pi' });
    expect(h.autoIdleInMs).toBe(AUTO_IDLE_MS - 60_000);
    expect(h.bank).toBeUndefined();
    expect(h.rewrite).toBe(false);
  });

  it('defaults a working span to updatedAt and claude when the row lacks them', () => {
    const [h] = hydrateStatus([row({ status: 'working', updatedAt: new Date(NOW - 1000) })], NOW);
    expect(h.span).toEqual({ startedAt: NOW - 1000, provider: 'claude' });
  });

  it('auto-idles a working session whose deadline passed during the downtime, banking up to the deadline', () => {
    const updatedAt = NOW - AUTO_IDLE_MS - 60_000;
    const [h] = hydrateStatus([row({
      status: 'working', updatedAt: new Date(updatedAt), workingStartedAt: new Date(updatedAt - 10 * 60_000), provider: 'claude',
    })], NOW);
    expect(h.status).toMatchObject({ status: 'idle', message: 'Auto-idled after inactivity', updatedAt: new Date(updatedAt + AUTO_IDLE_MS) });
    expect(h.bank).toEqual({ startedAt: updatedAt - 10 * 60_000, provider: 'claude', endedAt: updatedAt + AUTO_IDLE_MS });
    expect(h.span).toBeUndefined();
    expect(h.autoIdleInMs).toBeUndefined();
    expect(h.rewrite).toBe(true);
  });

  it('restores a pending milestone with Date `at` and re-arms its expiry', () => {
    const at = new Date(NOW - 10 * 60_000);
    const [h] = hydrateStatus([row({
      status: 'idle',
      milestone: { kind: 'pr_created', url: 'https://github.com/o/r/pull/7', at: at.toISOString(), contextTokens: 80_000 },
    })], NOW);
    expect(h.status.milestone).toEqual({ kind: 'pr_created', url: 'https://github.com/o/r/pull/7', at, contextTokens: 80_000 });
    expect(h.milestoneExpiresInMs).toBe(MILESTONE_TTL_MS - 10 * 60_000);
    expect(h.rewrite).toBe(false);
  });

  it('drops an expired milestone and asks for the row to be rewritten', () => {
    const [h] = hydrateStatus([row({
      milestone: { kind: 'pr_merged', url: null, at: new Date(NOW - MILESTONE_TTL_MS).toISOString(), contextTokens: null },
    })], NOW);
    expect(h.status.milestone).toBeNull();
    expect(h.milestoneExpiresInMs).toBeUndefined();
    expect(h.rewrite).toBe(true);
  });

  it('drops a malformed milestone or waitingReason rather than restoring garbage', () => {
    const [h] = hydrateStatus([row({ milestone: { kind: 'nope', at: 'x' }, waitingReason: 'bogus' })], NOW);
    expect(h.status.milestone).toBeNull();
    expect(h.status.waitingReason).toBeNull();
    expect(h.rewrite).toBe(true);
  });

  it('round-trips toRow → hydrateStatus for a waiting session', () => {
    const entry = st({ status: 'waiting', updatedAt: new Date(NOW - 5000), waitingReason: 'user_input', source: 'pi-ext:pi', contextTokens: 42 });
    const [h] = hydrateStatus([toRow('box-1', 'alice-proj-agent', entry, undefined)], NOW);
    expect(h.status).toMatchObject({ status: 'waiting', updatedAt: entry.updatedAt, waitingReason: 'user_input', source: 'pi-ext:pi', contextTokens: 42 });
  });
});

describe('rowIsNewer', () => {
  const [h] = hydrateStatus([row({ status: 'idle', updatedAt: new Date(NOW - 1_000) })], NOW);
  const mem = (ms: number): AgentStatus => ({ status: 'working', updatedAt: new Date(ms), instanceId: null });

  it('takes the row when nothing is held, or what is held is older', () => {
    expect(rowIsNewer(h, undefined)).toBe(true);
    expect(rowIsNewer(h, mem(NOW - 2_000))).toBe(true);
  });

  it('keeps an entry as new as the row or newer', () => {
    expect(rowIsNewer(h, mem(NOW - 1_000))).toBe(false);
    expect(rowIsNewer(h, mem(NOW))).toBe(false);
  });

  it('compares against the write, not the deadline a stale working row is idled at', () => {
    const written = NOW - AUTO_IDLE_MS - 30_000;
    const [stale] = hydrateStatus([row({ status: 'working', updatedAt: new Date(written) })], NOW);
    expect(stale.status).toMatchObject({ status: 'idle', updatedAt: new Date(written + AUTO_IDLE_MS) });
    expect(rowIsNewer(stale, mem(written + 20_000))).toBe(false);
    expect(rowIsNewer(stale, mem(written - 1_000))).toBe(true);
  });
});
