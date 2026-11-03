// Keeps a pg-pool connect callback in its caller's OpenTelemetry context.
//
//
// pg-pool queues a connect behind a busy pool and calls the callback when
// another caller releases a client, so the callback runs in the releaser's
// async context. pool.query, connect-pg-simple's store and Prisma's driver
// adapter all go through that callback. The pg instrumentation binds it to the
// caller's context only while it also makes `pg-pool.connect` spans; with
// ignoreConnectSpans (tracing.ts: about half the database spans, and none
// answers a question) it hands the callback through unbound. Then a request's
// pg spans, and, through express-session's store callback, the rest of its
// handler, are filed under whichever request released the connection.
// sessionContext.integration.test.ts reproduces that with the real store.
import { context } from '@opentelemetry/api';
import { InstrumentationBase, InstrumentationNodeModuleDefinition } from '@opentelemetry/instrumentation';

type Connect = (this: unknown, cb?: unknown) => unknown;
interface PoolModule { prototype: { connect: Connect } }

export class PgPoolContextInstrumentation extends InstrumentationBase {
  constructor() {
    super('termag-pg-pool-context', '1.0.0', {});
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition(
      'pg-pool',
      ['>=2.0.0 <4'],
      (moduleExports: PoolModule) => {
        this._wrap(moduleExports.prototype, 'connect', (original: Connect) => function connect(this: unknown, cb?: unknown) {
          return original.call(this, typeof cb === 'function' ? context.bind(context.active(), cb as (...args: unknown[]) => unknown) : cb);
        });
        return moduleExports;
      },
      (moduleExports: PoolModule) => {
        this._unwrap(moduleExports.prototype, 'connect');
      },
    );
  }
}
