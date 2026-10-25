/**
 * The TUI's routes under /api/cli/v1 (`termag tui`): the lobby's project
 * list, the session list and capture, so a laptop's TUI uses the CLI's
 * credential and ALB bypass rather than bearer auth on the cookie routes.
 *
 * No typing through HTTP on purpose: a CLI credential can watch a session but
 * send-keys stays off this API; the TUI points at attaching instead. A
 * handoff (POST /projects/:id/handoff) is not send-keys: the server types only
 * its own fixed lines, into the owner's own agent pane, behind
 * agent-handoff-enabled. Attaching streams through the CLI's terminal
 * socket (routes/cliWs.ts), and while keys flow there the TUI posts the
 * heartbeat below, the one write here, for human-activity attribution.
 *
 * GET /prs is the PR pipeline (GET /api/prs) for the lobby's PR pills, and
 * only for a device sign-in (`termag login`): never for a box credential.
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
  /** POST /api/status/heartbeat's body: { project: <name>, instanceId? }. */
  heartbeat(user: CliUser, body: unknown): RouteResult | Promise<RouteResult>;
  /** GET /api/prs's answer (routes/prs.ts prsLister): the lobby's PR pills. */
  prs(user: CliUser): Promise<RouteResult>;
  /**
   * Hand one workstream's agent off (routes/handoffs.ts cliHandoffFor).
   * `boxId` is the box a box credential belongs to,
   * which may hand off only its own box's projects (null: a per-user token,
   * the host's); undefined for a device sign-in, which reaches all of them.
   */
  handoff(user: CliUser, projectId: string, body: unknown, boxId: string | null | undefined): Promise<RouteResult>;
  /** One handoff's state, for `termag handoff --wait` and the TUI. */
  handoffState(user: CliUser, id: string): Promise<RouteResult>;
}

const CODE_FOR_STATUS: Record<number, string> = {
  400: 'invalid_request',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'refused',
  429: 'rate_limited',
  502: 'upstream_failed',
  503: 'unavailable',
  504: 'upstream_timeout',
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

/** The refusal's own `code`, when it set one, over tuiResult's status-derived one. */
function pickCode(body: unknown): { code?: string } {
  const code = (body as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? { code } : {};
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

  // A handoff answers with its own codes and fields (handoff_open carries the
  // open handoff's id, …), which the CLI names to the user: keep them. A box
  // credential reaches only its own box's projects: its token is readable by
  // anything on the box (an ask's run among them), and a handoff
  // resets a pane and puts a note in the next agent's first prompt.
  router.post('/projects/:id/handoff', bearer, asyncHandler(async (req, res) => {
    const { user, credential } = cliAuth(res);
    const result = await tui.handoff(user, req.params.id, req.body, credential.kind === 'box' ? credential.boxId : undefined);
    const shaped = tuiResult(result);
    res.status(shaped.status).json(result.status >= 400 ? { ...(result.body as object), ...(shaped.body as object), ...pickCode(result.body) } : shaped.body);
  }));

  router.get('/handoffs/:id', bearer, asyncHandler(async (req, res) => {
    send(res, await tui.handoffState(cliAuth(res).user, req.params.id));
  }));

  router.post('/heartbeat', bearer, asyncHandler(async (req, res) => {
    send(res, await tui.heartbeat(cliAuth(res).user, req.body));
  }));

  // The user's pull requests, read from GitHub as them: a device sign-in only.
  // A box's agent token is readable by anything running on the box, and the
  // PR list spans every repository the user's GitHub token reaches.
  router.get('/prs', bearer, asyncHandler(async (_req, res) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind !== 'device') {
      res.status(403).json({ error: 'Pull requests need a device sign-in: run `termag login` here.', code: 'device_sign_in_required' });
      return;
    }
    send(res, await tui.prs(user));
  }));
}
