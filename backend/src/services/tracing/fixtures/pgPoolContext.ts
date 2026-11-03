// Child-process fixture for pgPoolContext.test.ts: pg-pool with a fake client
// (no database), one connection, two callers in two contexts. The second
// caller's connect is queued until the first releases; whose context does its
// callback run in? Run by tsx, so the instrumentations patch pg-pool through
// require. Prints one JSON line.
import { EventEmitter } from 'events';
import { context, createContextKey, ROOT_CONTEXT } from '@opentelemetry/api';

process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
process.env.TERMAG_TRACING = 'on';
/* eslint-disable @typescript-eslint/no-require-imports */
require('../../tracing');
const Pool = require('pg-pool') as new (options: object) => {
  connect(cb: (err: Error | undefined, client: unknown, release: () => void) => void): void;
};
/* eslint-enable @typescript-eslint/no-require-imports */

class FakeClient extends EventEmitter {
  connect(cb: (err?: Error) => void) { setImmediate(() => cb()); }
  query(_text: unknown, _values: unknown, cb: (err: Error | null, res: unknown) => void) { setImmediate(() => cb(null, { rows: [] })); }
  end(cb?: () => void) { cb?.(); }
}

const who = createContextKey('fixture.caller');
const pool = new Pool({ Client: FakeClient, max: 1 });
const seen: Record<string, unknown> = {};
context.with(ROOT_CONTEXT.setValue(who, 'first'), () => {
  pool.connect((_err, _client, release) => {
    seen.first = context.active().getValue(who);
    // Released from the first caller's context, with the second one queued.
    setTimeout(release, 20);
  });
});
context.with(ROOT_CONTEXT.setValue(who, 'second'), () => {
  pool.connect((_err, _client, release) => {
    seen.second = context.active().getValue(who);
    release();
    process.stdout.write(`${JSON.stringify(seen)}\n`);
    process.exit(0);
  });
});
