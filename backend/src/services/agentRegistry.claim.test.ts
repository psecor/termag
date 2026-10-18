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

const {
  registerAgent, rebindInstanceOwner, connectedInstanceIds, disownInstanceAgent, getConnectedAgents,
  instanceAgentSettled, settleClaimedOwner, onAgentHello, notifyInstanceClaimed,
} = await import('./agentRegistry');

class FakeAgentSocket extends EventEmitter {
  readyState = 1;
  send() {}
  close() { this.readyState = 3; this.emit('close'); }
  fromAgent(msg: object) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
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

// The ask queue sends only to a settled connection, and a claim brings no hello to settle one.
describe('settling a claimed box', () => {
  it('is unsettled when rebound, and settled once the claim says its delivery finished', async () => {
    registerAgent(null, new FakeAgentSocket() as any, warmBox('w6'));
    await flush();
    expect(instanceAgentSettled('w6')).toBe(false);

    const claimed = warmBox('w6');
    rebindInstanceOwner(claimed, ada);
    expect(instanceAgentSettled('w6')).toBe(false);
    settleClaimedOwner(claimed);
    expect(instanceAgentSettled('w6')).toBe(true);
  });

  it('leaves a replacement agent to its own hello', async () => {
    registerAgent(null, new FakeAgentSocket() as any, warmBox('w7'));
    await flush();
    const claimed = warmBox('w7');
    rebindInstanceOwner(claimed, ada);
    registerAgent(ada, new FakeAgentSocket() as any, { ...warmBox('w7'), userId: 'u_ada', status: 'ready' });
    await flush();

    settleClaimedOwner(claimed);
    expect(instanceAgentSettled('w7')).toBe(false);
  });

  it('a rebind after settling starts unsettled again', async () => {
    registerAgent(null, new FakeAgentSocket() as any, warmBox('w8'));
    await flush();
    const first = warmBox('w8');
    rebindInstanceOwner(first, ada);
    settleClaimedOwner(first);
    rebindInstanceOwner(warmBox('w8'), ada);
    expect(instanceAgentSettled('w8')).toBe(false);
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

const durableHello = {
  type: 'hello', unixUser: 'ada', home: '/home/ada', capabilities: ['chat-durable-v1'],
};

describe('a claimed warm box opens the chat gate', () => {
  it('a warm hello has no user, and the claim re-fires listeners with the owner and the capability', async () => {
    const hellos: Array<{ userId: string | null; instanceId: string | null; capabilities: string[] }> = [];
    const unsub = onAgentHello(ev => hellos.push({ userId: ev.userId, instanceId: ev.instanceId, capabilities: [...ev.capabilities] }));
    const ws = new FakeAgentSocket();
    registerAgent(null, ws as any, warmBox('w9'));
    await flush();
    ws.fromAgent(durableHello);
    await flush();
    expect(hellos).toEqual([{ userId: null, instanceId: 'w9', capabilities: ['chat-durable-v1'] }]);

    rebindInstanceOwner(warmBox('w9'), ada);
    expect(hellos).toHaveLength(1);
    notifyInstanceClaimed('w9');
    expect(hellos.at(-1)).toEqual({ userId: 'u_ada', instanceId: 'w9', capabilities: ['chat-durable-v1'] });
    unsub();
  });

  it('a hello that arrives after the rebind names the owner', async () => {
    const hellos: Array<string | null> = [];
    const unsub = onAgentHello(ev => hellos.push(ev.userId));
    const ws = new FakeAgentSocket();
    registerAgent(null, ws as any, warmBox('w10'));
    await flush();
    rebindInstanceOwner(warmBox('w10'), ada);
    ws.fromAgent(durableHello);
    await flush();
    expect(hellos).toEqual(['u_ada']);
    unsub();
  });

  it('does not notify a box that is still ownerless', () => {
    const hellos: unknown[] = [];
    const unsub = onAgentHello(ev => hellos.push(ev));
    notifyInstanceClaimed('missing');
    expect(hellos).toEqual([]);
    unsub();
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
