// Where the request being handled came from, for the `surface` attribute on
// the flag context's user (services/featureFlags.ts): the browser (`web`, or
// `mobile` on the phone client), the CLI, the TUI, metaterm, or Slack. Held in
// an AsyncLocalStorage, so a flag read deep in a service sees it without every
// caller passing it on. Unset outside a request (sweeps, timers, box agent and
// browser WebSocket messages), and the attribute is then left out.
import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';
import { clientFromHeaders, type ClientKind } from './software/versions';
import { setServerSpanAttributes } from './tracing/requestSpan';

export type Surface = ClientKind | 'slack';

const store = new AsyncLocalStorage<Surface>();

export function currentSurface(): Surface | undefined {
  return store.getStore();
}

export function withSurface<T>(surface: Surface, fn: () => T): T {
  return store.run(surface, fn);
}

/**
 * Runs `fn` as code outside a request does, with no surface: for a flag a
 * request reads on behalf of a sweep, which must see the sweep's context.
 */
export function withoutSurface<T>(fn: () => T): T {
  return store.exit(fn);
}

// Express: the surface of the client the headers name, classified as the
// Software tab's client versions are (clientFromHeaders), or none. A request
// with no recognised client runs with no surface rather than one inherited
// from elsewhere: index.ts mounts this again after the session middleware,
// whose pg-backed store can resume a request in another request's context.
export function surfaceMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers['x-termag-client'];
  const client = clientFromHeaders(typeof header === 'string' ? header : undefined, req.headers['user-agent']);
  // The same value on the request's server span, where a trace query joins it
  // to the flag evaluations under it.
  if (client) setServerSpanAttributes(req, { 'termag.surface': client.kind });
  if (client) store.run(client.kind, () => next());
  else store.exit(() => next());
}

// Slack (Bolt global middleware, slack/app.ts): every listener runs as `slack`.
export async function slackSurfaceMiddleware({ next }: { next: () => Promise<void> }): Promise<void> {
  await store.run('slack', next);
}
