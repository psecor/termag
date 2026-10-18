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

const { registerAgent, sendToInstanceAgent } = await import('./agentRegistry');

class FakeAgentSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
}

describe('box activity from agent RPCs', () => {
  it('does not count a send-keys as someone using the box: reconnect reconstruction sends them too', async () => {
    const ws = new FakeAgentSocket();
    registerAgent({ id: 'u1', unixUsername: 'dev' } as any, ws as any, { id: 'inst_1', name: 'box-1', userId: 'u1', kind: 'ec2', status: 'ready' } as any);
    await new Promise(r => setTimeout(r, 0));
    noteBoxActivity.mockClear();

    const sent = sendToInstanceAgent('inst_1', 'tmux-send-keys', { sessionName: 'dev-proj-agent', keys: 'claude --continue', withEnter: true });
    const { requestId } = ws.sent.find(m => m.type === 'tmux-send-keys');
    ws.emit('message', Buffer.from(JSON.stringify({ requestId, data: {} })));
    await sent;

    expect(noteBoxActivity).not.toHaveBeenCalled();
  });
});
