/**
 * The simple UI's sessions under /api/cli/v1, for the desktop app's sidebar:
 *
 *
 *   GET /chats                         the sessions termag web's sidebar lists, as rows
 *   GET /chats?archived=1              its Archived section instead (`all`: both, each with `archived`)
 *   POST /projects/:id/chat/archive    archive ({ workstream, archived: true }) or reopen (false) a chat; never powers its box
 *   POST /projects/:id/chat/title      rename a chat's session ({ workstream, title }), as a person's title
 *   GET /projects/:id/chat?workstream= one session's history, as GET /api/projects/:id/chat answers it
 *   POST /projects/:id/chat/claim      the desktop's thread takes the session ({ workstream, threadId })
 *   GET /chat/asks?threads=&claudeSession= the asks a desktop thread sent, as web's …/chat/asks answers them
 *
 * Both read the orchestrator, not a box: a session on a parked or stopped box
 * is listed, and its history comes from the stored transcript when the box
 * can't answer (`stored: true`). Nothing here starts a box: a claim needs it
 * up. The rows are
 * services/chatSessionRows.ts's, so the two sidebars list the same sessions
 * under the same names; a status frame on the CLI status socket means a row
 * may have changed.
 *
 * Each is a device sign-in's (a box's own token gets 403: anything on the box
 * could read every session), behind `desktop-app-enabled` for the person
 * (off: 404).
 */
import type { Request, RequestHandler, Response, Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import type { ChatSessionRow } from '../services/chatSessionRows';
import type { CliUser } from '../services/cliStore';
import type { CliAuth } from './cliApi';
import type { RouteResult } from './routeResult';

export interface CliChatRow extends Omit<ChatSessionRow, 'checkout'> {
  archived: boolean;
  /** When it was archived, on an archived row. */
  archivedAt: string | null;
  /** Where the session's turns run on its box (an ask's: the asked checkout); null on a shared row, whose box is someone else's. */
  directory: string | null;
  /** Claude's session id: the stored transcript's current one, else the box's last word on a hand-over, else null. */
  sessionId: string | null;
  /** The viewer's own box, with its state; null on a shared row or a project without one. */
  box: { id: string; name: string; status: string } | null;
  /** The session whose agent spawned this one (GET /api/spawns/parents), which termag web nests it under. */
  spawnParent: { projectId: string; workstream: string } | null;
}

export interface CliChats {
  /** desktop-app-enabled for this person. */
  enabled(user: CliUser): Promise<boolean>;
  list(user: CliUser, opts: { archived: boolean | 'all' }): Promise<CliChatRow[]>;
  /** routes/chats.ts archive or reopen, for this person, without powering the box; `body` unchecked. */
  archive(user: CliUser, projectId: string, body: unknown): Promise<RouteResult>;
  /** A person's rename of the chat's session (services/chatRunner.ts renameSessionFor); `body` unchecked. */
  title(user: CliUser, projectId: string, body: unknown): Promise<RouteResult>;
  /** GET /api/projects/:id/chat's answer for this person; `workstream` is the query's, unchecked. */
  history(user: CliUser, projectId: string, workstream: unknown): Promise<RouteResult>;
  /** The box's answer to the desktop's claim (routes/chat.ts claimChatFor); `body` unchecked. */
  claim(user: CliUser, projectId: string, body: unknown): Promise<RouteResult>;
  /** routes/chatAsks.ts desktopChatAsksFor for this person; `query` unchecked. */
  asks(user: CliUser, query: Request['query']): Promise<RouteResult>;
}

const NOT_FOUND = { error: 'No such CLI endpoint; this termag CLI may be newer than the orchestrator', code: 'not_found' };
const DEVICE_ONLY = {
  error: "A box's own credentials can't read sessions; sign in with `termag login`",
  code: 'forbidden',
};

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

export function mountCliChatRoutes(router: Router, deps: CliChats, bearer: RequestHandler): void {
  const gate: RequestHandler = asyncHandler(async (_req, res, next) => {
    const { user, credential } = cliAuth(res);
    if (credential.kind !== 'device') { res.status(403).json(DEVICE_ONLY); return; }
    if (!(await deps.enabled(user))) { res.status(404).json(NOT_FOUND); return; }
    next();
  });

  router.get('/chats', bearer, gate, asyncHandler(async (req, res) => {
    const archived = req.query.archived === 'all' ? 'all' as const : req.query.archived === '1' || req.query.archived === 'true';
    res.json({ chats: await deps.list(cliAuth(res).user, { archived }) });
  }));

  router.get('/projects/:id/chat', bearer, gate, asyncHandler(async (req, res) => {
    const out = await deps.history(cliAuth(res).user, req.params.id, req.query.workstream);
    res.status(out.status).json(out.body);
  }));

  router.post('/projects/:id/chat/claim', bearer, gate, asyncHandler(async (req, res) => {
    const out = await deps.claim(cliAuth(res).user, req.params.id, req.body);
    res.status(out.status).json(out.body);
  }));

  router.post('/projects/:id/chat/archive', bearer, gate, asyncHandler(async (req, res) => {
    const out = await deps.archive(cliAuth(res).user, req.params.id, req.body);
    res.status(out.status).json(out.body);
  }));

  router.post('/projects/:id/chat/title', bearer, gate, asyncHandler(async (req, res) => {
    const out = await deps.title(cliAuth(res).user, req.params.id, req.body);
    res.status(out.status).json(out.body);
  }));

  router.get('/chat/asks', bearer, gate, asyncHandler(async (req, res) => {
    const out = await deps.asks(cliAuth(res).user, req.query);
    res.status(out.status).json(out.body);
  }));
}
