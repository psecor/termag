/**
 * Agent-to-agent asks under /api/cli/v1.
 *
 *   POST /ask                       ask a project's workstream; 202 with the
 *                                   thread and message ids (any CLI credential)
 *   GET  /ask/messages/:id?wait=N   the message's state, waiting up to N s
 *                                   (max 50) for it to finish; a finished
 *                                   message's reply goes to a poll waiting
 *                                   for it and is never stored
 *   GET  /ask/inbox                 the caller's messages still submitted or
 *                                   working, or finished in the last day
 *   GET  /ask/targets               every project workstream the caller may
 *                                   ask, as A2A AgentCards (the extended card:
 *                                   per caller, behind the same credential)
 *   POST /ask/messages/:id/cancel   cancel a submitted or working message and
 *                                   stop its run (the asker or the target
 *                                   project's owner)
 *   PUT  /ask/runs/:id/bundle       the target box uploads the run's commits
 *   POST /ask/runs/:id/result       the target box reports the run's end
 *
 * Every route sits under /api/cli/v1 because that is the prefix the ALB lets
 * through from boxes (cli_box) and laptops (CLI JWT); nothing here needs a
 * terraform change. The two /runs routes take only a box token, and only the
 * box the message was sent to (services/askService.ts checks the latter).
 */
import express, { type RequestHandler, type Response, type Router } from 'express';
import { asyncHandler } from '../middleware/errors';
import type { CliUser } from '../services/cliStore';
import {
  MAX_BUNDLE_BYTES,
  MAX_WAIT_SEC,
  isMessageId,
  parseAskBody,
  parseRunResult,
  type AskRequest,
  type RunResult,
} from '../services/agentMessages';
import type { CliAuth } from './cliApi';
import type { RouteResult } from './routeResult';

export interface CliAsk {
  ask(user: CliUser, senderInstanceId: string | null, req: AskRequest): Promise<RouteResult>;
  getMessage(user: CliUser, messageId: string, waitSec: number): Promise<RouteResult>;
  inbox(user: CliUser): Promise<RouteResult>;
  targets(user: CliUser): Promise<RouteResult>;
  cancel(user: CliUser, messageId: string): Promise<RouteResult>;
  recordBundle(boxId: string, messageId: string, data: Buffer): Promise<RouteResult>;
  recordResult(boxId: string, messageId: string, result: RunResult): Promise<RouteResult>;
}

function cliAuth(res: Response): CliAuth {
  return res.locals.cliAuth as CliAuth;
}

function send(res: Response, result: RouteResult): void {
  res.status(result.status).json(result.body);
}

function badRequest(res: Response, error: string): void {
  res.status(400).json({ error, code: 'invalid_request' });
}

/** The box a box credential belongs to, or a 403 already sent. */
function boxOnly(res: Response): string | null {
  const { credential } = cliAuth(res);
  if (credential.kind === 'box' && credential.boxId) return credential.boxId;
  res.status(403).json({ error: 'box agents only: this route takes the target box\'s token', code: 'forbidden' });
  return null;
}

/** `?wait=` in seconds, clamped to [0, MAX_WAIT_SEC]; absent or junk is 0. */
export function parseWait(raw: unknown): number {
  const n = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), MAX_WAIT_SEC);
}

export function mountCliAskRoutes(router: Router, ask: CliAsk, bearer: RequestHandler): void {
  router.post('/ask', bearer, asyncHandler(async (req, res) => {
    const parsed = parseAskBody(req.body);
    if ('error' in parsed) { badRequest(res, parsed.error); return; }
    const { user, credential } = cliAuth(res);
    send(res, await ask.ask(user, credential.kind === 'box' ? credential.boxId : null, parsed));
  }));

  router.get('/ask/messages/:id', bearer, asyncHandler(async (req, res) => {
    if (!isMessageId(req.params.id)) { badRequest(res, 'not a message id'); return; }
    send(res, await ask.getMessage(cliAuth(res).user, req.params.id, parseWait(req.query.wait)));
  }));

  router.post('/ask/messages/:id/cancel', bearer, asyncHandler(async (req, res) => {
    if (!isMessageId(req.params.id)) { badRequest(res, 'not a message id'); return; }
    send(res, await ask.cancel(cliAuth(res).user, req.params.id));
  }));

  router.get('/ask/inbox', bearer, asyncHandler(async (_req, res) => {
    send(res, await ask.inbox(cliAuth(res).user));
  }));

  router.get('/ask/targets', bearer, asyncHandler(async (_req, res) => {
    send(res, await ask.targets(cliAuth(res).user));
  }));

  // Mounted after the global express.json(), which leaves an octet-stream body alone.
  const raw = express.raw({ type: 'application/octet-stream', limit: MAX_BUNDLE_BYTES });
  router.put('/ask/runs/:id/bundle', bearer, raw, asyncHandler(async (req, res) => {
    const boxId = boxOnly(res);
    if (!boxId) return;
    if (!isMessageId(req.params.id)) { badRequest(res, 'not a run id'); return; }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      badRequest(res, 'the body must be a git bundle sent as application/octet-stream');
      return;
    }
    send(res, await ask.recordBundle(boxId, req.params.id, req.body));
  }));

  router.post('/ask/runs/:id/result', bearer, asyncHandler(async (req, res) => {
    const boxId = boxOnly(res);
    if (!boxId) return;
    if (!isMessageId(req.params.id)) { badRequest(res, 'not a run id'); return; }
    const parsed = parseRunResult(req.body);
    if ('error' in parsed) { badRequest(res, parsed.error); return; }
    send(res, await ask.recordResult(boxId, req.params.id, parsed));
  }));
}
