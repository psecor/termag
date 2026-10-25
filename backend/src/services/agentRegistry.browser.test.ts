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

const { registerAgent, requestBrowserStream, sendBrowserMessage, closeBrowserStream } = await import('./agentRegistry');

// The real socket's close event arrives later, after the close handshake, so
// a replacement for the same key is in the registry before the old socket's
// close handler runs. The fake keeps that order.
class FakeAgentSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; setImmediate(() => this.emit('close')); }
  fromAgent(msg: object) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
}

const settle = () => new Promise((r) => setTimeout(r, 5));
const user = { id: 'u_browser', unixUsername: 'dev' } as any;
const box = (id: string) => ({ id, name: `box-${id}`, userId: user.id, kind: 'ec2', status: 'ready' }) as any;

/** Connects an agent for the box, opens a browser stream on it, and answers the attach the way the agent does. */
async function connectedWithPane(instanceId: string) {
  const ws = new FakeAgentSocket();
  registerAgent(user, ws as any, box(instanceId));
  await settle();
  const events: any[] = [];
  const attached = requestBrowserStream({ userId: user.id, instanceId }, { url: 'http://127.0.0.2/', width: 800, height: 600, paneKey: 'k' }, (m) => events.push(m));
  const attach = ws.sent.find((m) => m.type === 'browser-attach');
  expect(attach).toMatchObject({ url: 'http://127.0.0.2/', width: 800, height: 600, paneKey: 'k' });
  ws.fromAgent({ requestId: attach.requestId, data: { ok: true, streamId: attach.streamId } });
  const streamId = await attached;
  expect(streamId).toBe(attach.streamId);
  return { ws, events, streamId };
}

describe('browser streams in the agent registry', () => {
  it('is fed only by the agent that holds it; another agent naming the stream is told to close it', async () => {
    const { ws, events, streamId } = await connectedWithPane('inst_pane_1');
    const other = new FakeAgentSocket();
    registerAgent({ id: 'u_other', unixUsername: 'other' } as any, other as any, { ...box('inst_other'), userId: 'u_other' });
    await settle();

    ws.fromAgent({ type: 'browser-frame', streamId, data: 'AAAA', width: 800, height: 600 });
    other.fromAgent({ type: 'browser-frame', streamId, data: 'BBBB', width: 800, height: 600 });
    expect(events).toEqual([{ type: 'browser-frame', streamId, data: 'AAAA', width: 800, height: 600 }]);
    expect(other.sent).toContainEqual({ type: 'browser-close', streamId });
    expect(ws.sent.filter((m) => m.type === 'browser-close')).toEqual([]);

    sendBrowserMessage(streamId, { type: 'browser-resize', width: 640, height: 480 });
    expect(ws.sent[ws.sent.length - 1]).toEqual({ type: 'browser-resize', width: 640, height: 480, streamId });
    expect(other.sent.filter((m) => m.type === 'browser-resize')).toEqual([]);
  });

  it('ends the stream when its agent socket is replaced, not only when it disconnects outright', async () => {
    const { ws, events, streamId } = await connectedWithPane('inst_pane_2');

    // A box update: the new agent registers for the same key before the old socket's close is seen.
    const replacement = new FakeAgentSocket();
    registerAgent(user, replacement as any, box('inst_pane_2'));
    expect(ws.readyState).toBe(3);
    await settle();

    expect(events).toEqual([{ type: 'browser-exit', streamId, reason: 'agent disconnected' }]);
    // The viewer's socket closes on that exit and tells the registry; nothing reaches the new agent for a stream it never had.
    closeBrowserStream(streamId);
    sendBrowserMessage(streamId, { type: 'browser-input', event: { kind: 'text', text: 'late' } });
    expect(replacement.sent.filter((m) => typeof m.streamId === 'string')).toEqual([]);
    // The replacement is the live agent for the box: a new pane goes to it.
    const again = requestBrowserStream({ userId: user.id, instanceId: 'inst_pane_2' }, { url: 'http://127.0.0.2/', width: 800, height: 600, paneKey: 'k' }, () => {});
    const attach = replacement.sent.find((m) => m.type === 'browser-attach');
    expect(attach).toBeTruthy();
    replacement.fromAgent({ requestId: attach.requestId, data: { ok: true, streamId: attach.streamId } });
    expect(await again).toBe(attach.streamId);
  });

  it('ends the stream when its agent disconnects, and refuses a stream for a box with no agent', async () => {
    const { ws, events, streamId } = await connectedWithPane('inst_pane_3');
    ws.close();
    await settle();
    expect(events).toEqual([{ type: 'browser-exit', streamId, reason: 'agent disconnected' }]);
    await expect(requestBrowserStream({ userId: user.id, instanceId: 'inst_pane_3' }, { url: 'http://127.0.0.2/', width: 800, height: 600, paneKey: 'k' }, () => {}))
      .rejects.toThrow('Agent not connected');
  });

  it('delivers a page\'s dialog and its end to the stream, from the agent that holds it', async () => {
    const { ws, events, streamId } = await connectedWithPane('inst_pane_5');
    ws.fromAgent({ type: 'browser-dialog', streamId, id: 1, kind: 'confirm', message: 'Delete?' });
    ws.fromAgent({ type: 'browser-dialog-closed', streamId, id: 1 });
    expect(events).toEqual([
      { type: 'browser-dialog', streamId, id: 1, kind: 'confirm', message: 'Delete?' },
      { type: 'browser-dialog-closed', streamId, id: 1 },
    ]);
  });

  it('counts input, navigation, history and a dialog answer as using the box; a resize is the pane following its size', async () => {
    const { streamId } = await connectedWithPane('inst_pane_4');
    noteBoxActivity.mockClear();
    sendBrowserMessage(streamId, { type: 'browser-input', event: { kind: 'text', text: 'hi' } });
    sendBrowserMessage(streamId, { type: 'browser-navigate', url: 'http://127.0.0.2/flags' });
    sendBrowserMessage(streamId, { type: 'browser-history', action: 'back' });
    sendBrowserMessage(streamId, { type: 'browser-dialog-answer', id: 1, accept: true });
    expect(noteBoxActivity).toHaveBeenCalledTimes(4);
    expect(noteBoxActivity).toHaveBeenCalledWith('inst_pane_4');
    sendBrowserMessage(streamId, { type: 'browser-resize', width: 640, height: 480 });
    sendBrowserMessage(streamId, { type: 'browser-frame-ack' });
    expect(noteBoxActivity).toHaveBeenCalledTimes(4);
  });
});
