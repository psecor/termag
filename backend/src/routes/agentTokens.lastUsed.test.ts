import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findUnique, update } = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn() }));
vi.mock('../db', () => ({ prisma: { agentToken: { findUnique, update } } }));

import { LAST_USED_RETRY_MS, LAST_USED_WRITE_MS, lastUsedDue, resetLastUsedForTests, validateAgentToken } from './agentTokens';

const row = (lastUsedAt: Date | null) => ({
  id: 't1', scope: 'agent', name: 'box', revokedAt: null, expiresAt: null, lastUsedAt, user: { id: 'u1' }, instance: null,
});

describe('lastUsedDue', () => {
  const now = 1_000_000_000;
  it('writes when neither this process nor the row has a write in the last minute', () => {
    expect(lastUsedDue(now, undefined, null)).toBe(true);
    expect(lastUsedDue(now, now - LAST_USED_WRITE_MS, null)).toBe(true);
    expect(lastUsedDue(now, undefined, new Date(now - LAST_USED_WRITE_MS - 1))).toBe(true);
  });
  it('skips when either one wrote within the minute', () => {
    expect(lastUsedDue(now, now - 1_000, null)).toBe(false);
    expect(lastUsedDue(now, undefined, new Date(now - 1_000))).toBe(false); // another orchestrator wrote it
  });
});

describe('validateAgentToken writes lastUsedAt at most once a minute per token', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-11-13T20:00:00Z') });
    resetLastUsedForTests();
    findUnique.mockReset();
    update.mockReset().mockResolvedValue({});
  });

  it('a burst of requests on one token writes once, and again after a minute', async () => {
    findUnique.mockResolvedValue(row(null)); // every request read the row before the first write landed
    for (let i = 0; i < 90; i++) expect(await validateAgentToken('raw')).not.toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: 't1' }, data: { lastUsedAt: new Date('2026-11-13T20:00:00Z') } });

    vi.advanceTimersByTime(LAST_USED_WRITE_MS);
    await validateAgentToken('raw');
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('retries a failed write after a short backoff, not on every request', async () => {
    findUnique.mockResolvedValue(row(null));
    update.mockRejectedValueOnce(new Error('pool exhausted'));
    await validateAgentToken('raw');
    expect(update).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) await Promise.resolve(); // let the swallowed failure arm the backoff

    // Inside the backoff: a busy token must not add a failing write per request.
    vi.advanceTimersByTime(LAST_USED_RETRY_MS - 1);
    await validateAgentToken('raw');
    expect(update).toHaveBeenCalledTimes(1);

    // After it: the write is retried (and this time succeeds).
    vi.advanceTimersByTime(1);
    await validateAgentToken('raw');
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('starts the backoff when the write fails, not when it was issued', async () => {
    findUnique.mockResolvedValue(row(null));
    let failUpdate!: (e: Error) => void;
    update.mockImplementationOnce(() => new Promise((_, reject) => { failUpdate = reject; }));
    await validateAgentToken('raw');
    expect(update).toHaveBeenCalledTimes(1);

    // The write outlives the backoff before rejecting.
    vi.advanceTimersByTime(LAST_USED_RETRY_MS + 2_000);
    failUpdate(new Error('pool exhausted'));
    for (let i = 0; i < 10; i++) await Promise.resolve(); // let the failure arm the backoff

    // A request right after the failure must wait the backoff from failure time.
    await validateAgentToken('raw');
    expect(update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(LAST_USED_RETRY_MS - 1);
    await validateAgentToken('raw');
    expect(update).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await validateAgentToken('raw');
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('does not write when the row already says it was used within the minute', async () => {
    findUnique.mockResolvedValue(row(new Date(Date.now() - 5_000)));
    await validateAgentToken('raw');
    expect(update).not.toHaveBeenCalled();
  });

  it('a revoked token is refused and not touched', async () => {
    findUnique.mockResolvedValue({ ...row(null), revokedAt: new Date() });
    expect(await validateAgentToken('raw')).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });
});
