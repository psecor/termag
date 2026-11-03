// Attributes about the request, on its server span. Not on the active span: inside a
// route-level handler that is the express handler's span. The http
// instrumentation keeps the server span in the context's RPC metadata, and
// serverSpanMiddleware, mounted first in index.ts, binds it to the request
// while the request's own context is still the active one. Middleware after
// the session stack can run in another request's async context
// (connect-pg-simple's pool, index.ts), so reading the active context there
// could name the wrong request's span; the request object can't.
// Ids only, never an email or a name. A no-op outside a traced request.
import { context, type Attributes, type Context, type Span } from '@opentelemetry/api';
import { getRPCMetadata } from '@opentelemetry/core';
import type { NextFunction, Request, Response } from 'express';

const serverSpans = new WeakMap<object, Span>();

/** Bind the server span in `ctx` to `req`, unless one is bound already: the first binding, made at the top of the stack, wins. */
export function bindServerSpan(req: object, ctx: Context = context.active()): void {
  if (serverSpans.has(req)) return;
  const span = getRPCMetadata(ctx)?.span;
  if (span) serverSpans.set(req, span);
}

/** First in the middleware stack, ahead of anything that can lose the request's context. */
export function serverSpanMiddleware(req: Request, _res: Response, next: NextFunction): void {
  bindServerSpan(req);
  next();
}

export function setServerSpanAttributes(req: object, attributes: Attributes): void {
  const span = serverSpans.get(req);
  if (span?.isRecording()) span.setAttributes(attributes);
}
