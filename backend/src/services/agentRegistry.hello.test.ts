import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  prisma: {
    instance: {
      update: async () => ({}),
      updateMany: async () => ({ count: 1 }),
    },
    user: {
      findUnique: async () => ({ claudeGatewayEnabled: false }),
    },
  },
}));
vi.mock('./agentRuntime', () => ({
  reconstructUserSessions: async () => {},
  reconstructInstanceSessions: async () => {},
}));
vi.mock('./sshKeySync', () => ({ syncBoxAuthorizedKeys: async () => {} }));

const { registerAgent, instanceAgentTransport, onBoxAgentHello, onBoxAgentFrame } = await import('./agentRegistry');
type BoxAgentHelloEvent = Parameters<Parameters<typeof onBoxAgentHello>[0]>[0];
type BoxAgentFrame = Parameters<Parameters<typeof onBoxAgentFrame>[1]>[0];

class FakeAgentSocket extends EventEmitter {
  readyState = 1;
  sent: Record<string, any>[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  fromAgent(msg: object) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
}

const flush = () => new Promise(r => setTimeout(r, 0));
const SHA = 'a3f1c2d4e5b6a7c8d9e0f1a2b3c4d5e6f7a8b9c0';
const ada = { id: 'u_ada', unixUsername: 'ada' } as any;
const ownedBox = (id: string) => ({ id, name: `ada-${id}`, userId: 'u_ada', kind: 'ec2', status: 'ready' }) as any;
const hello = (capabilities: string[] = []) => ({
  type: 'hello', unixUser: 'ada', home: '/home/ada', hostname: 'box', agentVersion: '1.0.0', capabilities,
});

// The hello is what tells the orchestrator which code a box runs: the
// capabilities decide which RPCs it may send, and the commit decides whether
// a box-update is due (services/boxUpdate). Both must be read off the frame
// and nothing else.
describe('what the hello records about a box agent', () => {
  it('starts unknown, then takes the commit and capabilities the agent announces', async () => {
    const ws = new FakeAgentSocket();
    registerAgent(ada, ws as any, ownedBox('h1'));
    await flush();
    expect(instanceAgentTransport('h1')).toMatchObject({ capabilities: [], agentCommit: null, helloReceived: false });

    ws.fromAgent({
      type: 'hello', unixUser: 'ada', home: '/home/ada', hostname: 'box', agentVersion: '1.0.0',
      agentCommit: SHA, capabilities: ['tmux-create-command-v1', 'box-update-v1'],
    });
    await flush();
    expect(instanceAgentTransport('h1')).toMatchObject({
      capabilities: ['tmux-create-command-v1', 'box-update-v1'],
      agentCommit: SHA,
      helloReceived: true,
    });
  });

  it('an older agent that sends no commit reads as unknown, not as current', async () => {
    const ws = new FakeAgentSocket();
    registerAgent(ada, ws as any, ownedBox('h2'));
    await flush();
    ws.fromAgent({ type: 'hello', unixUser: 'ada', home: '/home/ada', agentVersion: '1.0.0' });
    await flush();
    expect(instanceAgentTransport('h2')).toMatchObject({ capabilities: [], agentCommit: null, helloReceived: true });
  });

  it('a malformed commit is dropped rather than stored', async () => {
    const ws = new FakeAgentSocket();
    registerAgent(ada, ws as any, ownedBox('h3'));
    await flush();
    ws.fromAgent({ type: 'hello', unixUser: 'ada', home: '/home/ada', agentCommit: 'HEAD', capabilities: ['box-update-v1'] });
    await flush();
    expect(instanceAgentTransport('h3')).toMatchObject({ capabilities: ['box-update-v1'], agentCommit: null });
  });

  it('a hello the parser rejects changes nothing', async () => {
    const ws = new FakeAgentSocket();
    registerAgent(ada, ws as any, ownedBox('h4'));
    await flush();
    ws.fromAgent({ type: 'hello', unixUser: 'ada', agentCommit: SHA, capabilities: ['box-update-v1'] }); // no home
    await flush();
    expect(instanceAgentTransport('h4')).toMatchObject({ capabilities: [], agentCommit: null, helloReceived: false });
  });
});

// A clone dispatched on the hello needs the box's home recorded and its
// GitHub broker delivered first; `settled` is what it waits on.
describe('when a box agent hello has settled', () => {
  let events: BoxAgentHelloEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    for (const name of ['CLAUDE_GATEWAY_URL', 'CREDENTIAL_STORE_KMS_KEY_ID', 'GITHUB_BROKER_URL']) {
      vi.stubEnv(name, '');
    }
    events = [];
    unsubscribe = onBoxAgentHello(ev => { events.push(ev); });
  });

  afterEach(() => {
    unsubscribe();
    vi.unstubAllEnvs();
  });

  const tracked = (p: Promise<void>) => {
    const t = { done: false };
    p.then(() => { t.done = true; });
    return t;
  };

  it('waits for the box to answer every credential step', async () => {
    const ws = new FakeAgentSocket();
    registerAgent(ada, ws as any, ownedBox('s1'));
    ws.fromAgent(hello(['credentials-v1']));
    await flush();

    expect(events).toHaveLength(1);
    const settled = tracked(events[0].settled);
    expect(ws.sent.map(m => [m.type, m.provider])).toEqual([['credentials-remove', 'claude-gateway']]);
    expect(settled.done).toBe(false);

    ws.fromAgent({ requestId: ws.sent[0].requestId, data: {} });
    await flush();
    expect(ws.sent.map(m => [m.type, m.provider])).toEqual([
      ['credentials-remove', 'claude-gateway'],
      ['credentials-remove', 'github'],
    ]);
    expect(settled.done).toBe(false);

    ws.fromAgent({ requestId: ws.sent[1].requestId, data: {} });
    await events[0].settled;
    expect(settled.done).toBe(true);
  });

  it('settles when a credential step fails, as the clone can still try', async () => {
    const ws = new FakeAgentSocket();
    registerAgent(ada, ws as any, ownedBox('s2'));
    ws.fromAgent(hello(['credentials-v1']));
    await flush();
    ws.fromAgent({ requestId: ws.sent[0].requestId, error: 'termag-credentials: refused' });
    await flush();
    ws.fromAgent({ requestId: ws.sent[1].requestId, data: {} });

    await expect(events[0].settled).resolves.toBe(undefined);
  });

  it('sends nothing to an agent without credentials-v1 and settles on the host write alone', async () => {
    const ws = new FakeAgentSocket();
    registerAgent(ada, ws as any, ownedBox('s3'));
    ws.fromAgent(hello(['box-update-v1']));

    await expect(events[0].settled).resolves.toBe(undefined);
    expect(ws.sent).toEqual([]);
  });
});

describe('frames an owned box agent sends unprompted', () => {
  let frames: BoxAgentFrame[];
  let unsubscribe: () => void;

  beforeEach(() => {
    frames = [];
    unsubscribe = onBoxAgentFrame('project-clone-status', f => { frames.push(f); });
  });

  afterEach(() => unsubscribe());

  const report = { type: 'project-clone-status', projectId: 'p1', instanceId: 'f1', attempt: 0, status: 'cloning' };

  it('reach the listener with the box the socket is bound to', async () => {
    const box = ownedBox('f1');
    const ws = new FakeAgentSocket();
    registerAgent(ada, ws as any, box);
    ws.fromAgent(report);

    expect(frames).toEqual([{ instance: box, user: ada, msg: report }]);
  });

  it('carry the socket box even when the frame names another one', async () => {
    const ws = new FakeAgentSocket();
    registerAgent(ada, ws as any, ownedBox('f2'));
    ws.fromAgent(report);

    expect(frames.map(f => [f.instance.id, f.msg.instanceId])).toEqual([['f2', 'f1']]);
  });

  it('reach no listener from a warm box or a legacy per-user agent', async () => {
    const warm = new FakeAgentSocket();
    registerAgent(null, warm as any, { id: 'f3', name: 'warm-f3', userId: null, kind: 'ec2', status: 'warm' } as any);
    warm.fromAgent(report);
    const legacy = new FakeAgentSocket();
    registerAgent(ada, legacy as any, null);
    legacy.fromAgent(report);

    expect(frames).toEqual([]);
  });

  it('reach only the listeners for their type, and none once unsubscribed', async () => {
    const ws = new FakeAgentSocket();
    registerAgent(ada, ws as any, ownedBox('f4'));
    ws.fromAgent({ ...report, type: 'something-else' });
    unsubscribe();
    ws.fromAgent(report);

    expect(frames).toEqual([]);
  });
});
