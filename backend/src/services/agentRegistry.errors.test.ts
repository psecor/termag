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
const noteBoxActivity = vi.fn();
vi.mock('./boxActivity', () => ({ noteBoxActivity, isTerminalReport: () => false }));

const { AgentNotConnectedError, AgentReplyError, AgentTransportError, registerAgent, sendToInstanceAgent } = await import('./agentRegistry');

class FakeAgentSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
}

describe('how an agent RPC fails', () => {
  const connect = async (id: string) => {
    const ws = new FakeAgentSocket();
    registerAgent({ id: 'u1', unixUsername: 'dev' } as any, ws as any, { id, name: id, userId: 'u1', kind: 'ec2', status: 'ready' } as any);
    await new Promise(r => setTimeout(r, 0));
    return ws;
  };

  it('an {error} reply rejects as AgentReplyError, with the message as before', async () => {
    const ws = await connect('inst_e1');
    const sent = sendToInstanceAgent('inst_e1', 'tool-update', { component: 'claude', run: 'r' });
    const { requestId } = ws.sent.find(m => m.type === 'tool-update');
    ws.emit('message', Buffer.from(JSON.stringify({ requestId, error: 'unit not loaded' })));
    const err = await sent.catch(e => e);
    expect(err).toBeInstanceOf(AgentReplyError);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('unit not loaded');
  });

  it('a timeout and a dropped socket reject as AgentTransportError', async () => {
    const ws = await connect('inst_e2');
    const timedOut = await sendToInstanceAgent('inst_e2', 'tool-update', {}, 5).catch(e => e);
    expect(timedOut).toBeInstanceOf(AgentTransportError);
    expect(timedOut).not.toBeInstanceOf(AgentNotConnectedError);
    expect(timedOut.message).toBe('Agent request timed out: tool-update');
    const pending = sendToInstanceAgent('inst_e2', 'tool-update', {}, 10_000);
    ws.close();
    const dropped = await pending.catch(e => e);
    expect(dropped).toBeInstanceOf(AgentTransportError);
    expect(dropped.message).toBe('Agent disconnected');
  });

  it('a send to no agent rejects as AgentNotConnectedError', async () => {
    const err = await sendToInstanceAgent('inst_none', 'tool-update', {}).catch(e => e);
    expect(err).toBeInstanceOf(AgentNotConnectedError);
    expect(err.message).toBe('Instance agent not connected');
  });
});
