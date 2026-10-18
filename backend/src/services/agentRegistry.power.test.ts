import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

const writes: Array<{ op: string; where: any; data: any }> = [];
vi.mock('../db', () => ({
  prisma: {
    instance: {
      update: async (args: any) => { writes.push({ op: 'update', ...args }); return {}; },
      updateMany: async (args: any) => { writes.push({ op: 'updateMany', ...args }); return { count: 1 }; },
    },
  },
}));
vi.mock('./agentRuntime', () => ({
  reconstructUserSessions: async () => {},
  reconstructInstanceSessions: async () => {},
}));
vi.mock('./sshKeySync', () => ({ syncBoxAuthorizedKeys: async () => {} }));

const { registerAgent, isInstanceAgentConnected } = await import('./agentRegistry');

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

describe('an owned box whose agent connects after a start', () => {
  const clears = () => writes.filter(w => w.op === 'updateMany' && 'provisioningError' in w.data);

  it('makes it ready and clears a start-timeout error left on the row', async () => {
    writes.length = 0;
    registerAgent(user, new FakeAgentSocket() as any, boxWith('starting', 'inst_2'));
    await flush();
    expect(writes).toContainEqual({
      op: 'updateMany', where: { id: 'inst_2', status: 'starting' }, data: { status: 'ready', lastConnectedAt: expect.any(Date) },
    });
    expect(clears()).toEqual([{ op: 'updateMany', where: { id: 'inst_2', status: 'ready' }, data: { provisioningError: null } }]);
  });

  it('leaves the error of a ready box alone, e.g. a stop EC2 never carried out', async () => {
    writes.length = 0;
    registerAgent(user, new FakeAgentSocket() as any, boxWith('ready', 'inst_3'));
    await flush();
    expect(clears()).toEqual([]);
  });
});
