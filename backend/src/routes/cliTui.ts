/**
 * The TUI's routes under /api/cli/v1 (`termag tui`): the lobby's project
 * list, the session list and capture, so a laptop's TUI uses the CLI's
 * credential and ALB bypass rather than bearer auth on the cookie routes.
 *
 * Read-only on purpose: a CLI credential can watch a session but not type into
 * it. send-keys stays off this API until CLI sessions can be revoked; the TUI
 * points at attaching instead.
 *
 * Each route is a thin shell over a CliTui, whose Prisma implementation
 * (routes/cliTuiPrisma.ts) calls the same functions as GET /api/projects,
 * GET /api/sessions and the capture route, rate limits included. Successful bodies are those routes' shapes (tui/src/types.ts
 * mirrors them); failures carry the CLI's `code` as well.
 */
import type { RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import type { CliUser } from '../services/cliStore';
import type { CliAuth } from './cliApi';
import type { RouteResult } from './routeResult';

export interface CliTui {
  lobby(user: CliUser): Promise<unknown[]>;
  /**
   * `boxId` is the box a box credential belongs to, which marks that box's
   * rows: null for a per-user agent token (the host's), undefined for a device
   * sign-in, which like a browser session runs on no host.
   */
  sessions(user: CliUser, boxId: string | null | undefined): Promise<unknown[]>;
  capture(user: CliUser, projectId: string, role: string, query: Record<string, unknown>): Promise<RouteResult>;
}

const CODE_FOR_STATUS: Record<number, string> = {
  400: 'invalid_request',
  403: 'forbidden',
  404: 'not_found',
  429: 'rate_limited',
  503: 'unavailable',
};

/** A shared handler's answer with a CLI `code` on failures. */
export function tuiResult(result: RouteResult): RouteResult {
  if (result.status < 400) return result;
  const body = (result.body ?? {}) as { error?: unknown };
  return {
    status: result.status,
    body: {
      error: typeof body.error === 'string' ? body.error : 'Request failed',
      code: CODE_FOR_STATUS[result.status] ?? 'failed',
    },
  };
}

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

function send(res: Response, result: RouteResult): void {
  const shaped = tuiResult(result);
  res.status(shaped.status).json(shaped.body);
}

export function mountCliTuiRoutes(router: Router, tui: CliTui, bearer: RequestHandler): void {
  router.get('/lobby', bearer, asyncHandler(async (_req, res) => {
    res.json({ projects: await tui.lobby(cliAuth(res).user) });
  }));

  router.get('/sessions', bearer, asyncHandler(async (_req, res) => {
    const { user, credential } = cliAuth(res);
    res.json({ sessions: await tui.sessions(user, credential.kind === 'box' ? credential.boxId : undefined) });
  }));

  router.get('/projects/:id/sessions/:role/capture', bearer, asyncHandler(async (req, res) => {
    send(res, await tui.capture(cliAuth(res).user, req.params.id, req.params.role, req.query as Record<string, unknown>));
  }));
}
