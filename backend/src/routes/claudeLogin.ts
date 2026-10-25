/**
 * Claude Enterprise sign-in for the simple UI (agent/claude-login.js).
 *
 *   GET    /api/projects/:id/claude-login       the phase a browser may see
 *   POST   /api/projects/:id/claude-login       start, owner only
 *   POST   /api/projects/:id/claude-login/code  one paste, owner only
 *   DELETE /api/projects/:id/claude-login       cancel, owner only
 *
 * The paste is checked here and forwarded once. It is not logged, stored, or
 * returned. Responses are the sanitized view only.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../middleware/errors';
import { refuseParkedBox } from '../middleware/parkedBox';
import { isProjectAgentConnected, projectAgentCapabilities, sendForProject } from '../services/agentRegistry';
import {
  createAttemptGate, loginCodeError, loginEmail, loginRpcFailure, loginTargetError, sanitizeLoginView,
  type LoginView,
} from '../services/claudeLogin';
import { projectSessionAccess, SessionAccessError } from '../services/sessionAccess';

type Result = { status: number; body: unknown };

const START_LIMIT = 5;
const SUBMIT_LIMIT = 8;
const WINDOW_MS = 10 * 60 * 1000;
// start: auth status (8s) + URL wait (20s) + another status read (8s) ≈ 36s.
// submit: result wait (25s) + process exit (5s) + status read (8s) ≈ 38s.
// Shorter than that, a login that is still inside its normal wait answers 504.
const LOGIN_RPC_MS = 45_000;

function attemptKey(userId: string, projectId: string): string {
  return `${userId}\0${projectId}`;
}

function offlineView(): LoginView {
  return {
    phase: 'offline',
    loggedIn: false,
    authMethod: 'none',
    error: 'Waiting for this box to come online.',
  };
}

async function targetFor(userId: string, projectId: string): Promise<{ host: { userId: string; instanceId: string | null }; owner: boolean } | Result> {
  try {
    const access = (await projectSessionAccess(userId, projectId))('agent', 'main');
    return { host: access.host, owner: access.isOwner };
  } catch (err) {
    if (err instanceof SessionAccessError) return { status: err.status, body: { error: err.message } };
    throw err;
  }
}

function isResult(x: { host: { userId: string; instanceId: string | null }; owner: boolean } | Result): x is Result {
  return 'status' in x && 'body' in x;
}

function gate(ok: boolean): Result | null {
  if (ok) return null;
  return { status: 429, body: { error: 'Too many sign-in attempts. Wait a few minutes and try again.', code: 'rate-limited' } };
}

export function claudeLoginRouter(): Router {
  const starts = createAttemptGate(START_LIMIT, WINDOW_MS);
  const submits = createAttemptGate(SUBMIT_LIMIT, WINDOW_MS);
  const router = Router();

  router.get('/:id/claude-login', requireAuth, asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const target = await targetFor(req.user!.id, req.params.id);
    if (isResult(target)) { res.status(target.status).json(target.body); return; }
    const connected = isProjectAgentConnected(target.host);
    const problem = loginTargetError({
      instanceId: target.host.instanceId,
      connected,
      capabilities: projectAgentCapabilities(target.host),
    });
    if (problem?.body.code === 'offline') { res.json(target.owner ? offlineView() : sanitizeLoginView({ loggedIn: false }, false)); return; }
    if (problem) { res.status(problem.status).json(problem.body); return; }
    try {
      const raw = await sendForProject(target.host, 'claude-login-status', {}, 15_000);
      res.json(sanitizeLoginView(raw, target.owner));
    } catch (err) {
      const failure = loginRpcFailure(err instanceof Error ? err.message : '');
      res.status(failure.status).json(failure.body);
    }
  }));

  router.post('/:id/claude-login', requireAuth, refuseParkedBox('id'), asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const target = await targetFor(req.user!.id, req.params.id);
    if (isResult(target)) { res.status(target.status).json(target.body); return; }
    if (!target.owner) { res.status(403).json({ error: 'Only the owner of this box can sign in to Claude.', code: 'owner' }); return; }
    const limited = gate(starts(attemptKey(req.user!.id, req.params.id)));
    if (limited) { res.status(limited.status).json(limited.body); return; }
    const problem = loginTargetError({
      instanceId: target.host.instanceId,
      connected: isProjectAgentConnected(target.host),
      capabilities: projectAgentCapabilities(target.host),
    });
    if (problem) { res.status(problem.status).json(problem.body); return; }
    try {
      const raw = await sendForProject(target.host, 'claude-login-start', { email: loginEmail(req.user!.googleEmail) }, LOGIN_RPC_MS);
      res.json(sanitizeLoginView(raw, true));
    } catch (err) {
      const failure = loginRpcFailure(err instanceof Error ? err.message : '');
      res.status(failure.status).json(failure.body);
    }
  }));

  router.post('/:id/claude-login/code', requireAuth, refuseParkedBox('id'), asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const target = await targetFor(req.user!.id, req.params.id);
    if (isResult(target)) { res.status(target.status).json(target.body); return; }
    if (!target.owner) { res.status(403).json({ error: 'Only the owner of this box can sign in to Claude.', code: 'owner' }); return; }
    // After access, so a bad paste is not a 400 that skips the 404 and the owner check.
    const rejected = loginCodeError(req.body?.code);
    if (rejected) { res.status(400).json({ error: rejected, code: 'bad-code' }); return; }
    const limited = gate(submits(attemptKey(req.user!.id, req.params.id)));
    if (limited) { res.status(limited.status).json(limited.body); return; }
    const problem = loginTargetError({
      instanceId: target.host.instanceId,
      connected: isProjectAgentConnected(target.host),
      capabilities: projectAgentCapabilities(target.host),
    });
    if (problem) { res.status(problem.status).json(problem.body); return; }
    try {
      const raw = await sendForProject(target.host, 'claude-login-submit', { code: String(req.body.code).trim() }, LOGIN_RPC_MS);
      res.json(sanitizeLoginView(raw, true));
    } catch (err) {
      const failure = loginRpcFailure(err instanceof Error ? err.message : '');
      res.status(failure.status).json(failure.body);
    }
  }));

  router.delete('/:id/claude-login', requireAuth, refuseParkedBox('id'), asyncHandler(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const target = await targetFor(req.user!.id, req.params.id);
    if (isResult(target)) { res.status(target.status).json(target.body); return; }
    if (!target.owner) { res.status(403).json({ error: 'Only the owner of this box can sign in to Claude.', code: 'owner' }); return; }
    const problem = loginTargetError({
      instanceId: target.host.instanceId,
      connected: isProjectAgentConnected(target.host),
      capabilities: projectAgentCapabilities(target.host),
    });
    if (problem) { res.status(problem.status).json(problem.body); return; }
    try {
      const raw = await sendForProject(target.host, 'claude-login-cancel', {}, 10_000);
      res.json(sanitizeLoginView(raw, true));
    } catch (err) {
      const failure = loginRpcFailure(err instanceof Error ? err.message : '');
      res.status(failure.status).json(failure.body);
    }
  }));

  return router;
}
