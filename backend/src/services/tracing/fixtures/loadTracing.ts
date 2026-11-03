// Child-process fixture for tracing.test.ts: load services/tracing.ts the way
// index.ts does, second, with an endpoint so the tracer really starts, and
// print which modules that pulled in.
process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
process.env.TERMAG_TRACING = 'on';
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../../tracing');
process.stdout.write(`${JSON.stringify(Object.keys(require.cache))}\n`);
process.exit(0);
