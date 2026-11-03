// Child-process fixture for prismaAdapter.integration.test.ts: the adapter
// path again (PrismaPg over a pg pool), with installOperationSpans on the
// client. Each operation should be a child of the request it ran in. Run by
// tsx. Prints one JSON line.
import { trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register({ contextManager: new AsyncLocalStorageContextManager() });

/* eslint-disable @typescript-eslint/no-require-imports */
const { Pool } = require('pg') as typeof import('pg');
const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg');
const { installOperationSpans } = require('../prismaSpans') as typeof import('../prismaSpans');
/* eslint-enable @typescript-eslint/no-require-imports */

async function main() {
  const pool = new Pool({ connectionString: process.env.SPIKE_DB_URL, max: 2 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  installOperationSpans(prisma);
  const tracer = trace.getTracer('fixture');
  const entries: Record<string, string> = {};
  await Promise.all(['a', 'b'].map(name => tracer.startActiveSpan(`entry-${name}`, async (span) => {
    entries[span.spanContext().spanId] = name;
    await prisma.user.count();
    await prisma.user.findMany({ take: 1, where: { displayName: `nobody-${name}` } });
    span.end();
  })));
  await prisma.$disconnect();
  await pool.end();
  const spans = exporter.getFinishedSpans().filter(s => s.name.startsWith('prisma:')).map(s => ({
    name: s.name, entry: entries[s.parentSpanContext?.spanId ?? ''] ?? null, attributes: s.attributes,
  }));
  process.stdout.write(`${JSON.stringify({ spans })}\n`);
}

main().catch((err) => { process.stderr.write(`${(err as Error).stack}\n`); process.exit(1); });
