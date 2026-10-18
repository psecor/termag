/**
 * Error plumbing for Express 4 route handlers.
 *
 * Express 4 does not catch a rejected promise from an `async` handler. The
 * rejection surfaces as a process-level `unhandledRejection` (which index.ts
 * logs and swallows to stay alive) and the request is never answered, so the
 * client — or the nginx/ALB in front of us — sits there until its timeout
 * fires. That is exactly how a Prisma unique-constraint error inside
 * POST /api/instances showed up as a 504 (#59 fixed that one handler).
 *
 * Two pieces close the gap for everything else:
 *
 *   - `asyncHandler(fn)` wraps a handler so a rejection is forwarded to
 *     `next(err)` instead of escaping.
 *   - `apiErrorHandler` is the app's final middleware. It turns whatever
 *     reaches it into a JSON `{ error }` response with a sensible status,
 *     replacing Express's default HTML error page.
 *
 * Kept free of prisma/express-app imports so it stays unit-testable.
 */
import { ErrorRequestHandler, RequestHandler } from 'express';

export function asyncHandler(fn: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export interface HttpError {
  status: number;
  error: string;
}

// Prisma's PrismaClientKnownRequestError carries a string `code`. Duck-typed
// rather than `instanceof` so this module does not depend on the generated
// client (and a stale client can't break the mapping).
const PRISMA_STATUS: Record<string, HttpError> = {
  P2002: { status: 409, error: 'Already exists' },
  P2025: { status: 404, error: 'Not found' },
};

/** Map an arbitrary thrown value to the HTTP status + message to send. */
export function statusForError(err: unknown): HttpError {
  if (err && typeof err === 'object') {
    const e = err as {
      code?: unknown; status?: unknown; statusCode?: unknown; expose?: unknown; message?: unknown;
    };
    if (typeof e.code === 'string' && PRISMA_STATUS[e.code]) return PRISMA_STATUS[e.code];

    // http-errors convention (body-parser's malformed-JSON error is one):
    // a 4xx the client caused. `expose` marks the message as safe to return.
    const status = typeof e.status === 'number' ? e.status
      : typeof e.statusCode === 'number' ? e.statusCode
      : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      const error = e.expose === true && typeof e.message === 'string' && e.message
        ? e.message
        : 'Bad request';
      return { status, error };
    }
  }
  return { status: 500, error: 'Internal server error' };
}

export const apiErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    // Too late to change the response; let Express close the connection.
    next(err);
    return;
  }
  const { status, error } = statusForError(err);
  if (status >= 500) {
    console.error(
      `[HTTP] ${req.method} ${req.originalUrl} failed:`,
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
  }
  res.status(status).json({ error });
};
