import { beforeEach, describe, expect, it } from 'vitest';
import { context, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { Prisma } from '@prisma/client';
import { installOperationSpans, prismaSpanName } from './prismaSpans';

type Middleware = Prisma.Middleware;

// Registered once: prismaSpans.ts holds a tracer from the global API, which
// trace.disable() would orphan.
const exporter = new InMemorySpanExporter();
const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
trace.setGlobalTracerProvider(provider);

function setup() {
  let middleware: Middleware | null = null;
  installOperationSpans({ $use: (mw: Middleware) => { middleware = mw; } } as never);
  const run = (params: Partial<Prisma.MiddlewareParams>, next: () => Promise<unknown>) =>
    middleware!({ action: 'findMany', args: {}, dataPath: [], runInTransaction: false, ...params } as Prisma.MiddlewareParams, next);
  return { exporter, tracer: provider.getTracer('test'), run };
}

beforeEach(() => { exporter.reset(); });

describe('Prisma operation spans', () => {
  it('names the span by model and operation', () => {
    expect(prismaSpanName('User', 'findMany')).toBe('prisma:User.findMany');
    expect(prismaSpanName(undefined, 'queryRaw')).toBe('prisma:queryRaw');
  });

  it('opens a CLIENT span under the caller\'s span, with no arguments', async () => {
    const { exporter, tracer, run } = setup();
    await tracer.startActiveSpan('GET /api/projects', async (entry) => {
      await run({ model: 'Project', action: 'findMany', args: { where: { name: 'secret-name' } } }, async () => []);
      entry.end();
    });
    const [op, entry] = exporter.getFinishedSpans();
    expect(op.name).toBe('prisma:Project.findMany');
    expect(op.parentSpanContext?.spanId).toBe(entry.spanContext().spanId);
    expect(op.attributes).toEqual({ 'db.system.name': 'postgresql', 'db.operation.name': 'findMany', 'db.collection.name': 'Project' });
    expect(JSON.stringify(op.attributes)).not.toContain('secret-name');
  });

  it('records a failure and rethrows it', async () => {
    const { exporter, tracer, run } = setup();
    await tracer.startActiveSpan('GET /x', async (entry) => {
      await expect(run({ model: 'User', action: 'create' }, async () => { throw new Error('unique'); })).rejects.toThrow('unique');
      entry.end();
    });
    const [op] = exporter.getFinishedSpans();
    expect(op.status.code).toBe(SpanStatusCode.ERROR);
    expect(op.events.map(e => e.name)).toEqual(['exception']);
  });

  it('opens nothing outside a span', async () => {
    const { exporter, run } = setup();
    expect(await run({ model: 'User', action: 'count' }, async () => 3)).toBe(3);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});
