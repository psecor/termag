import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

const writes: Array<{ op: string; where: any; data: any }> = [];
/** Makes the connect's status-guarded write miss, as when the row moved since the agent's auth. */
const db = { missConnectGuard: false };
/** Rows a status-guarded write matches, for the write-once readyAt (status provisioning, readyAt null). */
const rows = new Map<string, { status: string; readyAt: Date | null }>();
vi.mock('../db', () => ({
  prisma: {
    instance: {
      update: async (args: any) => { writes.push({ op: 'update', ...args }); return {}; },
      updateMany: async (args: any) => {
        writes.push({ op: 'updateMany', ...args });
        const connectWrite = 'status' in args.where && 'lastConnectedAt' in args.data;
        if ('readyAt' in args.data) {
          const row = rows.get(args.where.id);
          const hit = !!row && row.status === args.where.status && row.readyAt === null;
          if (hit) row!.readyAt = args.data.readyAt;
          return { count: hit ? 1 : 0 };
        }
        return { count: db.missConnectGuard && connectWrite ? 0 : 1 };
      },
    },
  },
}));
vi.mock('./agentRuntime', () => ({
  reconstructUserSessions: async () => {},
  reconstructInstanceSessions: async () => {},
}));
vi.mock('./sshKeySync', () => ({ syncBoxAuthorizedKeys: async () => {} }));
vi.mock('./productEvents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./productEvents')>();
  return { ...actual, recordProductEvent: vi.fn() };
});

const { registerAgent, isInstanceAgentConnected } = await import('./agentRegistry');
const { armBoxStart, resetBoxStartsForTests } = await import('./boxStartLatency');
const { recordProductEvent } = await import('./productEvents');

class FakeAgentSocket extends EventEmitter {
  readyState = 1;
  send() {}
  close() { this.readyState = 3; this.emit('close'); }
}

const flush = () => new Promise(r => setTimeout(r, 0));

const user = { id: 'u1', unixUsername: 'dev' } as any;
const boxWith = (status: string, id = 'inst_1') => ({ id, name: 'box-1', userId: 'u1', kind: 'ec2', status }) as any;

describe('an owned box whose agent drops because the box was stopped', () => {
  it('only stamps agentDisconnectedAt: nothing marks the box failed or rewrites its status', async () => {
    const ws = new FakeAgentSocket();
    registerAgent(user, ws as any, boxWith('stopping'));
    await flush();
    writes.length = 0;

    ws.close();
    await flush();

    expect(isInstanceAgentConnected('inst_1')).toBe(false);
    expect(writes).toEqual([
      { op: 'update', where: { id: 'inst_1' }, data: { agentDisconnectedAt: expect.any(Date) } },
    ]);
  });
});

describe('a connect whose status-guarded write misses', () => {
  it("still records the connect, and drops a stuck-start stop's mark: the box came up", async () => {
    writes.length = 0;
    db.missConnectGuard = true;
    try {
      registerAgent(user, new FakeAgentSocket() as any, boxWith('ready', 'inst_3'));
      await flush();
    } finally {
      db.missConnectGuard = false;
    }
    expect(writes).toContainEqual({ op: 'updateMany', where: { id: 'inst_3' }, data: { lastConnectedAt: expect.any(Date) } });
    expect(writes).toContainEqual({
      op: 'updateMany',
      where: { id: 'inst_3', lifecycleNote: { startsWith: 'Stopped automatically: ' } },
      data: { lifecycleNote: null, autoParkedAt: null, idleWarnedAt: null, idleParkAt: null },
    });
  });
});

describe("a new box's first connect", () => {
  it('records box.ready with the cold provisioning time once, and not on a reconnect', async () => {
    vi.mocked(recordProductEvent).mockClear();
    const createdAt = new Date(Date.now() - 300_000);
    rows.set('inst_new', { status: 'provisioning', readyAt: null });
    const box = { ...boxWith('provisioning', 'inst_new'), createdAt, region: 'us-east-1', imageId: 'ami-1', imageSource: 'published', hibernationConfigured: true, claimedAt: null, parentInstanceId: null };
    registerAgent(user, new FakeAgentSocket() as any, box);
    await flush();
    registerAgent(user, new FakeAgentSocket() as any, box);
    await flush();
    const ready = vi.mocked(recordProductEvent).mock.calls.filter(c => c[0] === 'box.ready');
    expect(ready).toHaveLength(1);
    expect(ready[0][1]).toEqual({ user: 'u1', box: 'inst_new' });
    expect(ready[0][2]).toMatchObject({ boxKind: 'ec2', region: 'us-east-1', imageId: 'ami-1', imageSource: 'published', hibernationConfigured: true, fromPool: false, child: false });
    const sec = (ready[0][2] as { provisionSec: number }).provisionSec;
    expect(sec).toBeGreaterThanOrEqual(300);
    expect(sec).toBeLessThan(305);
  });
});

describe('an owned box whose agent connects after a start', () => {
  const clears = () => writes.filter(w => w.op === 'updateMany' && 'provisioningError' in w.data);

  it('makes it ready and clears a start-timeout error left on the row', async () => {
    writes.length = 0;
    resetBoxStartsForTests();
    vi.mocked(recordProductEvent).mockClear();
    const requested = Date.now() - 90_000;
    armBoxStart({ id: 'inst_2', status: 'hibernated', userId: 'u1' }, 'user', requested);
    registerAgent(user, new FakeAgentSocket() as any, boxWith('starting', 'inst_2'));
    await flush();
    expect(writes).toContainEqual({
      op: 'updateMany', where: { id: 'inst_2', status: 'starting' }, data: { status: 'ready', lastConnectedAt: expect.any(Date), lastReadyAt: expect.any(Date), idleWarnedAt: null, idleParkAt: null, downSince: null },
    });
    expect(clears()).toEqual([{ op: 'updateMany', where: { id: 'inst_2', status: 'ready' }, data: { provisioningError: null } }]);
    expect(recordProductEvent).toHaveBeenCalledWith('box.resumed', { user: 'u1', box: 'inst_2' }, {
      from: 'hibernate', outcome: 'ready', source: 'user',
      durationSec: expect.any(Number), hourUtc: new Date(requested).getUTCHours(),
      by: null, afterAutoPark: false, parkedMinutes: null, downMinutes: null, boxKind: null, region: null, imageId: null,
      imageSource: null, hibernationConfigured: null, fromPool: null, child: null,
    });
    const detail = vi.mocked(recordProductEvent).mock.calls[0][2] as { durationSec: number };
    expect(detail.durationSec).toBeGreaterThanOrEqual(90);
    expect(detail.durationSec).toBeLessThan(95);
  });

  it('leaves the error of a ready box alone, e.g. a stop EC2 never carried out', async () => {
    writes.length = 0;
    registerAgent(user, new FakeAgentSocket() as any, boxWith('ready', 'inst_3'));
    await flush();
    expect(clears()).toEqual([]);
  });
});

describe("the owner's box list hears about a box's agent coming and going", () => {
  it('pushes a boxes change on connect and on disconnect, and none for a warm box with no owner', async () => {
    const { setWorkspaceChangeCallback } = await import('./workspaceEvents');
    const told: Array<[string, string]> = [];
    setWorkspaceChangeCallback((owner, what) => { told.push([owner, what]); });
    try {
      const ws = new FakeAgentSocket();
      registerAgent(user, ws as any, boxWith('starting', 'inst_notify'));
      await flush();
      expect(told).toEqual([['u1', 'boxes']]);

      ws.close();
      await flush();
      expect(told).toEqual([['u1', 'boxes'], ['u1', 'boxes']]);

      told.length = 0;
      registerAgent(null, new FakeAgentSocket() as any, { ...boxWith('warming', 'warm_notify'), userId: null });
      await flush();
      expect(told).toEqual([]);
    } finally {
      setWorkspaceChangeCallback(null);
    }
  });

  it("tells a box's owner as of the disconnect: a claim in place gains one, a return to the pool loses one", async () => {
    const { setWorkspaceChangeCallback } = await import('./workspaceEvents');
    const { rebindInstanceOwner, disownInstanceAgent } = await import('./agentRegistry');
    const told: Array<[string, string]> = [];
    setWorkspaceChangeCallback((owner, what) => { told.push([owner, what]); });
    try {
      const warm = { ...boxWith('warm', 'warm_claimed'), userId: null };
      const claimed = new FakeAgentSocket();
      registerAgent(null, claimed as any, warm);
      await flush();
      const claimer = { id: 'u2', unixUsername: 'claimer' } as any;
      rebindInstanceOwner({ ...warm, userId: 'u2' }, claimer);
      claimed.close();
      await flush();
      expect(told).toEqual([['u2', 'boxes']]);

      told.length = 0;
      const returned = new FakeAgentSocket();
      registerAgent(user, returned as any, boxWith('ready', 'inst_returned'));
      await flush();
      told.length = 0;
      disownInstanceAgent('inst_returned');
      returned.close();
      await flush();
      expect(told).toEqual([]);
    } finally {
      setWorkspaceChangeCallback(null);
    }
  });

  it("does not push a disconnect for a replaced socket's close, only the new socket's connect", async () => {
    const { setWorkspaceChangeCallback } = await import('./workspaceEvents');
    const told: Array<[string, string]> = [];
    setWorkspaceChangeCallback((owner, what) => { told.push([owner, what]); });
    try {
      // A real socket's close event comes after close() returns, so the new
      // socket is already in the map when the old one's close is handled.
      class AsyncCloseSocket extends FakeAgentSocket {
        close() { this.readyState = 3; setTimeout(() => this.emit('close'), 0); }
      }
      const first = new AsyncCloseSocket();
      registerAgent(user, first as any, boxWith('ready', 'inst_replaced'));
      await flush();
      told.length = 0;
      registerAgent(user, new FakeAgentSocket() as any, boxWith('ready', 'inst_replaced'));
      await flush();
      await flush();
      expect(first.readyState).toBe(3);
      expect(told).toEqual([['u1', 'boxes']]);
    } finally {
      setWorkspaceChangeCallback(null);
    }
  });
});
