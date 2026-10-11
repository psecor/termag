import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  prisma: {
    instance: {
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
    },
  },
}));
vi.mock('./agentRuntime', () => ({
  reconstructUserSessions: async () => {},
  reconstructInstanceSessions: async () => {},
}));
vi.mock('./sshKeySync', () => ({ syncBoxAuthorizedKeys: async () => {} }));

const { registerAgent, rebindInstanceOwner, connectedInstanceIds, disownInstanceAgent, getConnectedAgents } = await import('./agentRegistry');

class FakeAgentSocket extends EventEmitter {
  readyState = 1;
  send() {}
  close() { this.readyState = 3; this.emit('close'); }
}

const flush = () => new Promise(r => setTimeout(r, 0));

const ada = { id: 'u_ada', unixUsername: 'ada' } as any;
const warmBox = (id: string) => ({ id, name: `pool-${id}`, userId: null, kind: 'ec2', status: 'warm' }) as any;
const listedFor = (userId: string) => getConnectedAgents().filter(a => a.userId === userId).map(a => a.instanceId);

describe('rebinding a warm box to its claimer', () => {
  it('lists the box as the claimer\'s, and the undo puts it back to ownerless', async () => {
    registerAgent(null, new FakeAgentSocket() as any, warmBox('w1'));
    await flush();

    const undo = rebindInstanceOwner(warmBox('w1'), ada);
    expect(undo).not.toBeNull();
    expect(listedFor('u_ada')).toEqual(['w1']);

    undo!();
    expect(listedFor('u_ada')).toEqual([]);
  });

  it('returns no undo for an instance with no live agent here', () => {
    expect(rebindInstanceOwner(warmBox('nowhere'), ada)).toBeNull();
  });

  it('leaves a replacement agent alone when the undo comes late', async () => {
    registerAgent(null, new FakeAgentSocket() as any, warmBox('w2'));
    await flush();
    const undo = rebindInstanceOwner(warmBox('w2'), ada);

    // The box redials with its now-owned token before the failed claim unwinds.
    registerAgent(ada, new FakeAgentSocket() as any, { ...warmBox('w2'), userId: 'u_ada', status: 'ready' });
    await flush();
    undo!();
    expect(listedFor('u_ada')).toContain('w2');
  });
});

describe('disowning an abandoned claim', () => {
  it('takes the owner off a replacement agent that redialled with the claimer\'s token mid-RPC', async () => {
    registerAgent(null, new FakeAgentSocket() as any, warmBox('w5'));
    await flush();
    const undo = rebindInstanceOwner(warmBox('w5'), ada);
    // The claim committed, so the redial authenticates as the claimer.
    registerAgent(ada, new FakeAgentSocket() as any, { ...warmBox('w5'), userId: 'u_ada', status: 'ready' });
    await flush();
    undo!(); // the original socket is gone, so this is rightly a no-op
    expect(listedFor('u_ada')).toContain('w5');

    disownInstanceAgent('w5');
    expect(listedFor('u_ada')).not.toContain('w5');
    expect(connectedInstanceIds()).toContain('w5');
  });

  it('leaves an instance with no agent here alone', () => {
    expect(() => disownInstanceAgent('nowhere')).not.toThrow();
  });
});

describe('connectedInstanceIds', () => {
  it('names the instances whose socket is open here, not one that closed', async () => {
    const open = new FakeAgentSocket();
    const closing = new FakeAgentSocket();
    registerAgent(null, open as any, warmBox('w3'));
    registerAgent(null, closing as any, warmBox('w4'));
    await flush();
    closing.close();
    await flush();

    const ids = connectedInstanceIds();
    expect(ids).toContain('w3');
    expect(ids).not.toContain('w4');
  });
});
