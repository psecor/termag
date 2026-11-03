/**
 * /api/worktime in the reader's zone (routes/worktime.ts): the web UI sends
 * its zone, termag records it for banking (services/userTimeZone.ts), counts
 * the days back from the person's today, and says which day that is.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const prisma = vi.hoisted(() => ({
  workTimeEntry: { findMany: vi.fn(async () => [] as unknown[]) },
  project: { findMany: vi.fn(async () => [] as unknown[]) },
  user: { update: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
}));
vi.mock('../db', () => ({ prisma }));
const signedIn = vi.hoisted(() => ({ timeZone: null as string | null }));
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'u1', unixUsername: 'jane.doe', timeZone: signedIn.timeZone };
    next();
  },
}));

const { worktimeRouter } = await import('./worktime');
const { forgetUserTimeZones, timeZoneFor } = await import('../services/userTimeZone');

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use('/api/worktime', worktimeRouter());
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/worktime`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const NOW = new Date('2026-10-30T01:30:00Z'); // 9:30 PM on the 29th in New York
const serverDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const since = () => (prisma.workTimeEntry.findMany.mock.calls.at(-1)?.[0] as unknown as { where: { date: { gte: string } } }).where.date.gte;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  forgetUserTimeZones();
  signedIn.timeZone = null;
  prisma.workTimeEntry.findMany.mockClear();
  prisma.user.update.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('GET /api/worktime', () => {
  it("reads the days in the reader's zone, records it, and says which day is today", async () => {
    prisma.workTimeEntry.findMany.mockResolvedValueOnce([
      { date: '2026-10-29', provider: 'claude', totalMs: 60_000, sessions: 1 },
      { date: '2026-10-29', provider: 'human', totalMs: 30_000, sessions: 2 },
    ]);
    const res = await fetch(`${base}?days=2&tz=America%2FNew_York`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      today: '2026-10-29',
      days: { '2026-10-29': { claude: { totalMs: 60_000, sessions: 1 }, human: { totalMs: 30_000, sessions: 2 } } },
    });
    expect(since()).toBe('2026-10-27');
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { timeZone: 'America/New_York' } });
    expect(timeZoneFor('jane_doe')).toBe('America/New_York');
  });

  it('uses the recorded zone when the reader sends none', async () => {
    signedIn.timeZone = 'America/New_York';
    const body = await (await fetch(`${base}?days=2`)).json() as { today: string };
    expect(body.today).toBe('2026-10-29');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("keeps the orchestrator's day with no zone, and ignores one that isn't", async () => {
    const body = await (await fetch(`${base}?days=2&tz=Mars%2FOlympus`)).json() as { today: string };
    expect(body.today).toBe(serverDay(NOW));
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('GET /api/worktime/projects', () => {
  it("counts back from the reader's today too, and says which day it is", async () => {
    const res = await fetch(`${base}/projects?days=7&tz=America%2FNew_York`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ days: 7, today: '2026-10-29', rows: [] });
    expect(since()).toBe('2026-10-22');
  });
});
