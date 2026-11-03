/**
 * Your typing is banked under your own day (services/humanActivity.ts with
 * services/userTimeZone.ts): a span across your midnight is split between the
 * two days, and the session counts on the day it ended.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const zones = vi.hoisted(() => ({} as Record<string, string>));
vi.mock('../db', () => ({ prisma: { workTimeEntry: { upsert: vi.fn(async () => ({})) } } }));
vi.mock('./userTimeZone', () => ({ timeZoneFor: (username: string) => zones[username] }));

const { prisma } = await import('../db');
const { recordHeartbeat, stopHumanActivityTracker } = await import('./humanActivity');

type Upsert = { where: { username_project_provider_date_instanceId: { date: string } }; update: { totalMs: { increment: number }; sessions?: { increment: number } } };
const upserts = () => vi.mocked(prisma.workTimeEntry.upsert).mock.calls.map(c => c[0] as unknown as Upsert);
const banked = () => upserts().map(u => [u.where.username_project_provider_date_instanceId.date, u.update.totalMs.increment, u.update.sessions?.increment ?? 0]);

/** Types every minute from `fromIso` for `minutes`, then lets the span end. */
function typeFor(fromIso: string, minutes: number) {
  vi.setSystemTime(new Date(fromIso));
  recordHeartbeat('jane.doe', 'termag', 'box-1');
  for (let i = 0; i < minutes; i += 1) {
    vi.advanceTimersByTime(60_000);
    recordHeartbeat('jane.doe', 'termag', 'box-1');
  }
  stopHumanActivityTracker();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.mocked(prisma.workTimeEntry.upsert).mockClear();
  for (const k of Object.keys(zones)) delete zones[k];
});
afterEach(() => vi.useRealTimers());

describe('your typing, banked by your day', () => {
  it('lands on your day, not the orchestrator\'s, when your zone is known', () => {
    zones['jane.doe'] = 'America/New_York';
    typeFor('2026-10-30T01:00:00Z', 10); // 9 PM to 9:10 PM on the 29th in New York
    expect(banked()).toEqual([['2026-10-29', 10 * 60_000, 1]]);
  });

  it('is split at your midnight, the session counted on the day it ended', () => {
    zones['jane.doe'] = 'America/New_York';
    typeFor('2026-10-30T03:50:00Z', 20); // 11:50 PM to 12:10 AM
    expect(banked()).toEqual([
      ['2026-10-29', 10 * 60_000, 0],
      ['2026-10-30', 10 * 60_000, 1],
    ]);
  });

  it("keeps the orchestrator's day when no zone is known", () => {
    typeFor('2026-10-30T01:00:00Z', 10);
    const end = new Date('2026-10-30T01:10:00Z');
    const local = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
    expect(banked()).toEqual([[local, 10 * 60_000, 1]]);
  });
});
