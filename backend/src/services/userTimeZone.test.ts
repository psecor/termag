/**
 * A person's time zone (services/userTimeZone.ts): what a client reports is
 * checked, kept in memory for banking under both forms of their username, and
 * written to User.timeZone only when it changes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prisma = vi.hoisted(() => ({
  user: { update: vi.fn(async () => ({})), findMany: vi.fn(async () => [] as Array<{ id?: string; unixUsername: string; timeZone: string | null }>) },
}));
vi.mock('../db', () => ({ prisma }));

const { forgetUserTimeZones, loadUserTimeZones, noteUserTimeZone, timeZoneFor, validTimeZone } = await import('./userTimeZone');

const jane = { id: 'u1', unixUsername: 'jane.doe', timeZone: null };

beforeEach(() => {
  forgetUserTimeZones();
  prisma.user.update.mockClear();
  prisma.user.findMany.mockReset();
});

describe('validTimeZone', () => {
  it('takes an IANA zone and nothing else', () => {
    expect(validTimeZone('America/New_York')).toBe('America/New_York');
    expect(validTimeZone('UTC')).toBe('UTC');
    for (const bad of ['Mars/Olympus', '', 'x'.repeat(100), 42, null, undefined, ['UTC']]) {
      expect(validTimeZone(bad), String(bad)).toBeNull();
    }
  });
});

describe('noteUserTimeZone', () => {
  it('records a reported zone once, for the raw and the tmux-folded username', () => {
    expect(noteUserTimeZone(jane, 'America/New_York')).toBe('America/New_York');
    expect(noteUserTimeZone(jane, 'America/New_York')).toBe('America/New_York');
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { timeZone: 'America/New_York' } });
    // Human time is banked under the raw name; agent time under the tmux-safe one.
    expect(timeZoneFor('jane.doe')).toBe('America/New_York');
    expect(timeZoneFor('jane_doe')).toBe('America/New_York');
  });

  it('tries a failed write again on the next report, then stops once it lands', async () => {
    prisma.user.update.mockRejectedValueOnce(new Error('db down'));
    noteUserTimeZone(jane, 'America/New_York');
    await new Promise(r => setTimeout(r, 0));
    // Banking uses the zone at once; the row didn't get it, so the next report writes again.
    expect(timeZoneFor('jane.doe')).toBe('America/New_York');
    noteUserTimeZone(jane, 'America/New_York');
    await new Promise(r => setTimeout(r, 0));
    noteUserTimeZone(jane, 'America/New_York');
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
  });

  it('writes again when the zone changes, after the write before it', async () => {
    noteUserTimeZone(jane, 'America/New_York');
    noteUserTimeZone(jane, 'Europe/Dublin');
    await new Promise(r => setTimeout(r, 0));
    expect(prisma.user.update).toHaveBeenCalledTimes(2);
    expect(prisma.user.update).toHaveBeenLastCalledWith({ where: { id: 'u1' }, data: { timeZone: 'Europe/Dublin' } });
    expect(timeZoneFor('jane_doe')).toBe('Europe/Dublin');
  });

  it("answers the recorded zone for a report that isn't one, and records nothing", () => {
    expect(noteUserTimeZone(jane, undefined)).toBeUndefined();
    expect(noteUserTimeZone({ ...jane, timeZone: 'Asia/Kolkata' }, 'not a zone')).toBe('Asia/Kolkata');
    expect(prisma.user.update).not.toHaveBeenCalled();
    // The request's own row seeds what banking reads.
    expect(timeZoneFor('jane.doe')).toBe('Asia/Kolkata');
  });
});

describe('loadUserTimeZones', () => {
  it('reads every recorded zone, so banking after a restart uses them', async () => {
    prisma.user.findMany.mockResolvedValueOnce([{ id: 'u2', unixUsername: 'sam.lee', timeZone: 'America/Los_Angeles' }, { id: 'u3', unixUsername: 'old', timeZone: 'Not/AZone' }]);
    await loadUserTimeZones();
    expect(prisma.user.findMany).toHaveBeenCalledWith({ where: { timeZone: { not: null } }, select: { id: true, unixUsername: true, timeZone: true } });
    expect(timeZoneFor('sam_lee')).toBe('America/Los_Angeles');
    expect(timeZoneFor('old')).toBeUndefined();
    expect(timeZoneFor('nobody')).toBeUndefined();
  });

  it("doesn't replace a zone reported while it was reading", async () => {
    let answer: (rows: Array<{ id?: string; unixUsername: string; timeZone: string | null }>) => void = () => {};
    prisma.user.findMany.mockReturnValueOnce(new Promise(resolve => { answer = resolve; }) as never);
    const loading = loadUserTimeZones();
    noteUserTimeZone(jane, 'Europe/Dublin');
    answer([{ id: 'u1', unixUsername: 'jane.doe', timeZone: 'America/New_York' }]);
    await loading;
    expect(timeZoneFor('jane.doe')).toBe('Europe/Dublin');
    expect(timeZoneFor('jane_doe')).toBe('Europe/Dublin');
  });
});
