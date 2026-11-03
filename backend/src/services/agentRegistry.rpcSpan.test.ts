import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';

vi.mock('../db', () => ({
  prisma: { instance: { update: async () => ({}), updateMany: async () => ({ count: 1 }) } },
}));
vi.mock('./agentRuntime', () => ({ reconstructUserSessions: async () => {}, reconstructInstanceSessions: async () => {} }));
vi.mock('./sshKeySync', () => ({ syncBoxAuthorizedKeys: async () => {} }));
vi.mock('./boxActivity', () => ({ noteBoxActivity: vi.fn(), isTerminalReport: () => false }));
vi.mock('./tracing/state', async (orig) => ({ ...(await orig<typeof import('./tracing/state')>()), tracingRegistered: () => true }));

const { registerAgent, rpcSpanAttributes, sendToAgent, sendToInstanceAgent } = await import('./agentRegistry');

const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(provider);
const tracer = provider.getTracer('test');

class FakeAgentSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.emit('close'); }
}

const BOX = 'cmbox0000000000000000000a';
const ws = new FakeAgentSocket();
registerAgent({ id: 'u1', unixUsername: 'dev' } as any, ws as any, { id: BOX, name: 'b', userId: 'u1', kind: 'ec2', status: 'ready' } as any);
await new Promise(r => setTimeout(r, 0));

const reply = (type: string, msg: Record<string, unknown>) => {
  const { requestId } = ws.sent.filter(m => m.type === type).pop();
  ws.emit('message', Buffer.from(JSON.stringify({ requestId, ...msg })));
};

/** `fn` inside a request's span; the spans that ended, by name. */
async function inRequest(fn: () => Promise<unknown>) {
  const request = tracer.startSpan('POST /api/x', { kind: SpanKind.SERVER }, ROOT_CONTEXT);
  await context.with(trace.setSpan(ROOT_CONTEXT, request), fn);
  request.end();
  const spans = exporter.getFinishedSpans();
  return { request, rpc: spans.filter(s => s.name === 'termag.box.rpc') };
}

beforeEach(() => { exporter.reset(); ws.sent.length = 0; });

describe('termag.box.rpc', () => {
  it('is a child of the awaiting span, with the method, the box and ok', async () => {
    const { request, rpc } = await inRequest(async () => {
      const sent = sendToInstanceAgent(BOX, 'unsaved-work', { path: '/home/termag/secret-path' });
      reply('unsaved-work', { data: { dirty: false } });
      expect(await sent).toEqual({ dirty: false });
    });
    expect(rpc).toHaveLength(1);
    expect(rpc[0].parentSpanContext?.spanId).toBe(request.spanContext().spanId);
    expect(rpc[0].attributes).toEqual({ 'termag.rpc.method': 'unsaved-work', 'termag.box': BOX, 'termag.rpc.outcome': 'ok' });
    expect(JSON.stringify(rpc[0].attributes)).not.toContain('secret-path');
  });

  it('records an error reply as error, and a timeout as timeout', async () => {
    const { rpc } = await inRequest(async () => {
      const sent = sendToInstanceAgent(BOX, 'box-update', {});
      reply('box-update', { error: 'unit not loaded' });
      await expect(sent).rejects.toThrow('unit not loaded');
      await expect(sendToInstanceAgent(BOX, 'tmux-list', {}, 5)).rejects.toThrow('Agent request timed out: tmux-list');
    });
    expect(rpc.map(s => [s.attributes['termag.rpc.method'], s.attributes['termag.rpc.outcome'], s.status.code])).toEqual([
      ['box-update', 'error', SpanStatusCode.ERROR],
      ['tmux-list', 'timeout', SpanStatusCode.ERROR],
    ]);
  });

  it('opens no span with nothing awaiting it in a span, and none for an agent that isn\'t connected', async () => {
    const sent = sendToInstanceAgent(BOX, 'tmux-list', {});
    reply('tmux-list', { data: [] });
    await sent;
    await expect(sendToAgent('nobody', 'tmux-list')).rejects.toThrow('Agent not connected');
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('names a legacy agent by its user, and an unexpected method as other', () => {
    expect(rpcSpanAttributes({ kind: 'user-agent', user: { id: 'u1' } } as any, 'tmux-list')).toEqual({ 'termag.rpc.method': 'tmux-list', 'termag.user': 'u1' });
    expect(rpcSpanAttributes({ kind: 'warm-box', instance: { id: BOX } } as any, 'Read File /etc/passwd')).toEqual({ 'termag.rpc.method': 'other', 'termag.box': BOX });
  });
});
