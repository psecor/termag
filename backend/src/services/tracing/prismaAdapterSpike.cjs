// Child-process fixture for prismaAdapter.integration.test.ts: does a Prisma
// query through the driver adapter (PrismaPg over a node-postgres pool, the
// production PG_IAM_AUTH path) keep the caller's OpenTelemetry context, so
// that the pg instrumentation records it as a child of the request's span?
// Plain CommonJS on purpose: the instrumentation patches modules through
// require, which vitest's own loader would bypass. Prints one JSON line.
'use strict';
const { trace, context } = require('@opentelemetry/api');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { PgInstrumentation } = require('@opentelemetry/instrumentation-pg');

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();
registerInstrumentations({
  tracerProvider: provider,
  instrumentations: [new PgInstrumentation({ requireParentSpan: process.env.SPIKE_REQUIRE_PARENT !== '0', enhancedDatabaseReporting: false, ignoreConnectSpans: true })],
});

// Only now: the instrumentation patches pg as it loads.
const { Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

async function main() {
  const pool = new Pool({ connectionString: process.env.SPIKE_DB_URL, max: 2 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const tracer = trace.getTracer('spike');
  const entries = [];
  // Two requests at once, so a context that leaks from one to the other shows.
  await Promise.all(['a', 'b'].map((name) => tracer.startActiveSpan(`entry-${name}`, async (span) => {
    entries.push({ name, spanId: span.spanContext().spanId, traceId: span.spanContext().traceId });
    await prisma.user.count();
    await prisma.user.findMany({ take: 1, where: { displayName: `nobody-${name}` } });
    await prisma.$queryRawUnsafe('SELECT 1');
    span.end();
  })));
  // A query outside any span: requireParentSpan must leave it untraced.
  await prisma.user.count();
  await prisma.$disconnect();
  await pool.end();
  const spans = exporter.getFinishedSpans().filter((s) => s.instrumentationScope.name.includes('pg'));
  const result = spans.map((s) => ({
    name: s.name,
    parent: s.parentSpanContext ? s.parentSpanContext.spanId : null,
    traceId: s.spanContext().traceId,
    text: s.attributes['db.query.text'] || s.attributes['db.statement'] || null,
  }));
  process.stdout.write(JSON.stringify({ entries, spans: result }) + '\n');
}

main().catch((err) => { process.stderr.write(String(err && err.stack || err) + '\n'); process.exit(1); });
