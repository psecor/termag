// A span per Prisma operation, in the caller's context.
//
//
// Through the driver adapter (production's PG_IAM_AUTH path), Prisma 5's
// engine calls node-postgres from native code, which loses the caller's
// OpenTelemetry context: the pg instrumentation would record every Prisma
// query as a root span in a trace of its own, or (with requireParentSpan, as
// tracing.ts configures it) not at all. prismaAdapter.integration.test.ts
// pins that. @prisma/instrumentation 5.x would bring a second, older
// OpenTelemetry SDK line. Prisma middleware runs in JavaScript, in the
// caller's async context, so it can open the span itself: model and
// operation, never arguments or SQL. Middleware rather than a client
// extension, because an extended client has no $use, which the workspace
// write notifier (services/workspaceWrites.ts) installs on the same client.
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { PrismaClient } from '@prisma/client';

const tracer = trace.getTracer('termag-prisma');

/** `prisma:User.findMany`, or `prisma:queryRaw` for a raw query. */
export function prismaSpanName(model: string | undefined, operation: string): string {
  return model ? `prisma:${model}.${operation}` : `prisma:${operation}`;
}

/** Wrap every operation of `client` in a CLIENT span, from now on. */
export function installOperationSpans(client: Pick<PrismaClient, '$use'>): void {
  // Only under a span: a query in an untraced sweep would be a root span with
  // no entry, which the trace buffer drops anyway.
  client.$use((params, next) => !trace.getActiveSpan() ? next(params) : tracer.startActiveSpan(prismaSpanName(params.model, params.action), {
    kind: SpanKind.CLIENT,
    attributes: {
      'db.system.name': 'postgresql',
      'db.operation.name': params.action,
      ...(params.model && { 'db.collection.name': params.model }),
    },
  }, async (span) => {
    try {
      return await next(params);
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  }));
}
