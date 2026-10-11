import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ prisma: {} }));
vi.mock('./agentRuntime', () => ({
  reconstructUserSessions: async () => {},
  reconstructInstanceSessions: async () => {},
}));

const { registerAgent, requestTerminalStream, closeTerminalStream } = await import('./agentRegistry');

class FakeAgentSocket extends EventEmitter {
  readyState = 1; // WebSocket.OPEN
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
  fromAgent(msg: object) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
  closesFor(streamId: string) { return this.sent.filter(m => m.type === 'terminal-close' && m.streamId === streamId); }
}

let n = 0;
function connectAgent() {
  const user = { id: `u${++n}`, unixUsername: `dev${n}` } as any;
  const ws = new FakeAgentSocket();
  registerAgent(user, ws as any, null);
  return { user, ws };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('terminal data from agents', () => {
  it('closes a stream the agent spawned after the attach RPC timed out', async () => {
    const { user, ws } = connectAgent();
    const attach = requestTerminalStream(user.id, 'dev-proj-agent', 80, 24, () => {});
    const rejected = expect(attach).rejects.toThrow('Agent request timed out: terminal-attach');
    const { streamId } = ws.sent.find(m => m.type === 'terminal-attach');

    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    // The agent's attach finishes late; tmux redraws on attach, so data follows.
    ws.fromAgent({ type: 'terminal-data', streamId, data: 'late redraw' });

    expect(ws.closesFor(streamId)).toHaveLength(1);
  });

  it('leaves a live stream alone and delivers its data', async () => {
    const { user, ws } = connectAgent();
    const onData = vi.fn();
    const attach = requestTerminalStream(user.id, 'dev-proj-agent', 80, 24, onData);
    const { requestId, streamId } = ws.sent.find(m => m.type === 'terminal-attach');
    ws.fromAgent({ requestId, data: { ok: true, streamId } });
    await expect(attach).resolves.toBe(streamId);

    ws.fromAgent({ type: 'terminal-data', streamId, data: 'hello' });

    expect(onData).toHaveBeenCalledWith(expect.objectContaining({ data: 'hello' }));
    expect(ws.closesFor(streamId)).toHaveLength(0);
  });

  it('does not let another agent write into a stream it does not hold', async () => {
    const owner = connectAgent();
    const other = connectAgent();
    const onData = vi.fn();
    const attach = requestTerminalStream(owner.user.id, 'dev-proj-agent', 80, 24, onData);
    const { requestId, streamId } = owner.ws.sent.find(m => m.type === 'terminal-attach');
    owner.ws.fromAgent({ requestId, data: { ok: true, streamId } });
    await attach;

    other.ws.fromAgent({ type: 'terminal-data', streamId, data: 'injected' });
    owner.ws.fromAgent({ type: 'terminal-data', streamId, data: 'real' });

    expect(onData.mock.calls.map(([m]) => m.data)).toEqual(['real']);
    expect(owner.ws.closesFor(streamId)).toHaveLength(0);
  });

  it('re-sends close for output that was in flight when the browser closed', async () => {
    const { user, ws } = connectAgent();
    const attach = requestTerminalStream(user.id, 'dev-proj-agent', 80, 24, () => {});
    const { requestId, streamId } = ws.sent.find(m => m.type === 'terminal-attach');
    ws.fromAgent({ requestId, data: { ok: true, streamId } });
    await attach;

    closeTerminalStream(streamId);
    ws.fromAgent({ type: 'terminal-data', streamId, data: 'in flight' });

    // One from closeTerminalStream, one for the straggler; the agent ignores unknown ids.
    expect(ws.closesFor(streamId)).toHaveLength(2);
  });
});
