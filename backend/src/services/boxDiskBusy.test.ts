import { beforeEach, describe, expect, it, vi } from 'vitest';

// Open disk-grow rows as boxEvents.openEventWhere selects them: unfinished and under an hour old.
// Runs while the query is in flight: what another request does during the await.
const duringQuery: { fn: (() => void | Promise<void>) | null } = { fn: null };
const rows: Array<{ id?: string; boxId: string; kind: string; finishedAt: Date | null; startedAt: Date }> = [];
vi.mock('../db', () => ({
  prisma: {
    boxEvent: {
      findMany: async ({ where }: any) => { await duringQuery.fn?.(); return rows.filter(r => where.boxId.in.includes(r.boxId) && r.kind === where.kind
        && r.finishedAt === where.finishedAt && r.startedAt >= where.startedAt.gte).map(r => ({ id: r.id ?? `row-${r.boxId}`, boxId: r.boxId })); },
    },
  },
}));
const registered = vi.hoisted(() => new Map<string, (ids: string[]) => Promise<Set<string>>>());
vi.mock('./boxLifecycle', () => ({ registerBoxBusyCheck: (name: string, check: any) => registered.set(name, check) }));

const { diskGrowBusyIds, registerDiskGrowBusyCheck } = await import('./boxDiskBusy');
const { maxGrowMs, recordGrowForTests, reserveGrow, resetGrowsForTests } = await import('./boxDisk');
const { OPEN_EVENT_STALE_MS } = await import('./boxEvents');

beforeEach(() => { rows.length = 0; duringQuery.fn = null; resetGrowsForTests(); });

describe('diskGrowBusyIds', () => {
  it('a grow in this process, or an open disk-grow row from any process, holds the box (Bugbot and Devin on #1214)', async () => {
    const release = reserveGrow('here');
    rows.push({ boxId: 'elsewhere', kind: 'disk-grow', finishedAt: null, startedAt: new Date(Date.now() - 60_000) });
    rows.push({ boxId: 'done', kind: 'disk-grow', finishedAt: new Date(), startedAt: new Date(Date.now() - 60_000) });
    rows.push({ boxId: 'stale', kind: 'disk-grow', finishedAt: null, startedAt: new Date(Date.now() - 2 * 3_600_000) });
    expect([...await diskGrowBusyIds(['here', 'elsewhere', 'done', 'stale', 'idle'])].sort()).toEqual(['elsewhere', 'here']);
    release();
  });

  it('a grow this process has finished doesn\'t hold the box while its row is still being closed (Bugbot on #1214)', async () => {
    recordGrowForTests('b1', { volumeId: 'v', fromGb: 120, toGb: 200, by: 'ada', startedAt: new Date().toISOString(), state: 'done', detail: null, finishedAt: new Date().toISOString(), eventId: 'ev-b1' });
    rows.push({ id: 'ev-b1', boxId: 'b1', kind: 'disk-grow', finishedAt: null, startedAt: new Date() });
    expect([...await diskGrowBusyIds(['b1'])]).toEqual([]);
    // Another grow's open row (another process's) still holds it.
    rows.push({ id: 'ev-other', boxId: 'b1', kind: 'disk-grow', finishedAt: null, startedAt: new Date() });
    expect([...await diskGrowBusyIds(['b1'])]).toEqual(['b1']);
  });

  it('a grow that starts here while the rows are read still holds the box, its old finished row notwithstanding (Bugbot on #1214)', async () => {
    recordGrowForTests('b1', { volumeId: 'v', fromGb: 120, toGb: 200, by: 'ada', startedAt: new Date().toISOString(), state: 'done', detail: null, finishedAt: new Date().toISOString(), eventId: 'ev-b1' });
    rows.push({ id: 'ev-b1', boxId: 'b1', kind: 'disk-grow', finishedAt: null, startedAt: new Date() });
    let release: () => void = () => {};
    duringQuery.fn = () => { release = reserveGrow('b1'); };
    expect([...await diskGrowBusyIds(['b1'])]).toEqual(['b1']);
    release();
  });

  it('a grow ends within the hour an open row counts as running, so the row never lets go of a grow still running (Devin on #1214)', () => {
    expect(maxGrowMs()).toBeLessThan(OPEN_EVENT_STALE_MS);
  });

  it('is the idle sweep\'s `disk-grow` busy check once registered, so an idle stop never cuts off a grow or its retry', async () => {
    registerDiskGrowBusyCheck();
    rows.push({ boxId: 'b1', kind: 'disk-grow', finishedAt: null, startedAt: new Date() });
    expect([...await registered.get('disk-grow')!(['b1', 'b2'])]).toEqual(['b1']);
  });
});
