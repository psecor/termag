import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { AddressInfo } from 'net';
import { asyncHandler, apiErrorHandler, statusForError } from './errors';

function fakeRes(headersSent = false) {
  const res = {
    headersSent,
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: unknown };
}

const req = { method: 'POST', originalUrl: '/termag/api/instances' } as unknown as Request;
const tick = () => new Promise((r) => setImmediate(r));

describe('asyncHandler', () => {
  it('forwards an async rejection to next()', async () => {
    const boom = new Error('db down');
    const next = vi.fn() as unknown as NextFunction;
    asyncHandler(async () => { throw boom; })(req, fakeRes(), next);
    await tick();
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('does not call next() when the handler resolves', async () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeRes();
    asyncHandler(async (_req, r) => { r.json({ ok: true }); })(req, res, next);
    await tick();
    expect(res.body).toEqual({ ok: true });
    expect(next).not.toHaveBeenCalled();
  });

  it('tolerates a synchronous handler', () => {
    const next = vi.fn() as unknown as NextFunction;
    const res = fakeRes();
    asyncHandler((_req, r) => { r.status(204).json(null); })(req, res, next);
    expect(res.statusCode).toBe(204);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('statusForError', () => {
  it('maps a Prisma unique-constraint violation to 409', () => {
    const err = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    expect(statusForError(err)).toEqual({ status: 409, error: 'Already exists' });
  });

  it('maps a Prisma record-not-found to 404', () => {
    expect(statusForError({ code: 'P2025' })).toEqual({ status: 404, error: 'Not found' });
  });

  it('passes through an exposed 4xx http-error with its message', () => {
    const err = Object.assign(new SyntaxError('Unexpected token } in JSON'), { status: 400, expose: true });
    expect(statusForError(err)).toEqual({ status: 400, error: 'Unexpected token } in JSON' });
  });

  it('hides the message of a non-exposed 4xx', () => {
    expect(statusForError({ statusCode: 413, message: 'internal detail' }))
      .toEqual({ status: 413, error: 'Bad request' });
  });

  it('never trusts a 5xx status from the error itself', () => {
    expect(statusForError({ status: 503, expose: true, message: 'leak' }))
      .toEqual({ status: 500, error: 'Internal server error' });
  });

  it('defaults to 500 for anything else', () => {
    expect(statusForError(new Error('nope'))).toEqual({ status: 500, error: 'Internal server error' });
    expect(statusForError('string')).toEqual({ status: 500, error: 'Internal server error' });
    expect(statusForError(undefined)).toEqual({ status: 500, error: 'Internal server error' });
  });
});

describe('apiErrorHandler', () => {
  it('responds with JSON and the mapped status', () => {
    const res = fakeRes();
    const next = vi.fn() as unknown as NextFunction;
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiErrorHandler(Object.assign(new Error('dup'), { code: 'P2002' }), req, res, next);
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Already exists' });
    expect(next).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled(); // a 4xx is not a server failure
    spy.mockRestore();
  });

  it('logs and returns 500 for unexpected errors', () => {
    const res = fakeRes();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiErrorHandler(new Error('db down'), req, res, vi.fn() as unknown as NextFunction);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0][0])).toContain('POST /termag/api/instances');
    spy.mockRestore();
  });

  it('defers to Express when headers were already sent', () => {
    const res = fakeRes(true);
    const next = vi.fn() as unknown as NextFunction;
    const boom = new Error('late');
    apiErrorHandler(boom, req, res, next);
    expect(next).toHaveBeenCalledWith(boom);
    expect(res.body).toBeUndefined();
  });
});

// End-to-end through a real Express 4 app: the exact failure mode this guards
// against is an async rejection that Express never routes to an error
// middleware, leaving the socket open. Fetch would hang, so a resolved response
// with the mapped status is the proof.
describe('asyncHandler + apiErrorHandler in an Express app', () => {
  async function request(app: express.Express, path: string, init?: RequestInit) {
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        signal: AbortSignal.timeout(2000),
      });
      return { status: res.status, body: await res.json() as unknown };
    } finally {
      server.close();
    }
  }

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.get('/dup', asyncHandler(async () => {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }));
    app.get('/boom', asyncHandler(async () => { throw new Error('db down'); }));
    app.post('/echo', (req, res) => { res.json(req.body); });
    app.use(apiErrorHandler);
    return app;
  }

  it('turns an async P2002 rejection into a 409 JSON response', async () => {
    expect(await request(buildApp(), '/dup')).toEqual({ status: 409, body: { error: 'Already exists' } });
  });

  it('turns an unexpected async rejection into a 500 JSON response', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await request(buildApp(), '/boom')).toEqual({ status: 500, body: { error: 'Internal server error' } });
    spy.mockRestore();
  });

  it('answers malformed JSON bodies with a 400 JSON error instead of the HTML page', async () => {
    const { status, body } = await request(buildApp(), '/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name": ',
    });
    expect(status).toBe(400);
    expect(body).toEqual({ error: expect.stringMatching(/JSON/) });
  });
});
