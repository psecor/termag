import { Router, RequestHandler } from 'express';
import { prisma } from '../db';
import { randomBytes, createHash } from 'crypto';
import { requireAuth } from '../middleware/auth';
import { ValidatedAgentToken } from '../services/instanceLifecycle';

/** validateAgentToken's result: the identity plus the token row's own metadata, for scope checks. */
export interface ValidatedAgentTokenWithMeta extends ValidatedAgentToken {
  token: { id: string; scope: string; name: string };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return 'tmag_' + randomBytes(32).toString('hex');
}

export function agentTokensRouter(): Router {
  const router = Router();

  // List all tokens for the current user (token value not included, just metadata)
  const list: RequestHandler = async (req, res) => {
    const tokens = await prisma.agentToken.findMany({
      where: { userId: req.user!.id, revokedAt: null, scope: 'agent' },
      select: { id: true, name: true, tokenPrefix: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json(tokens);
  };

  // Create a new token — returns the raw token ONCE
  const create: RequestHandler = async (req, res) => {
    const { name } = req.body;
    if (!name) { res.status(400).json({ error: 'name required' }); return; }

    const rawToken = generateToken();
    const tokenHash = hashToken(rawToken);
    const tokenPrefix = rawToken.substring(0, 13) + '...'; // "tmag_a1b2c3d4..."

    const token = await prisma.agentToken.create({
      data: {
        name,
        tokenHash,
        tokenPrefix,
        userId: req.user!.id,
      },
    });

    // Return the raw token — this is the only time it's visible
    res.status(201).json({
      id: token.id,
      name: token.name,
      token: rawToken,
      tokenPrefix,
      createdAt: token.createdAt,
    });
  };

  // Revoke a token
  const revoke: RequestHandler = async (req, res) => {
    const result = await prisma.agentToken.updateMany({
      where: { id: req.params.id, userId: req.user!.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count === 0) { res.status(404).json({ error: 'Token not found' }); return; }
    res.json({ ok: true });
  };

  router.get('/', requireAuth, list);
  router.post('/', requireAuth, create);
  router.delete('/:id', requireAuth, revoke);

  return router;
}

/**
 * Validate an agent token from a WebSocket or API request.
 * Returns { user, instance, token } if valid, or null if the token is bad,
 * revoked or expired. `instance` is null for legacy per-user tokens; `user` is
 * null for a warm-pool token whose box has no owner yet; `token` carries
 * id/scope/name so callers can enforce scope. Scope is NOT checked here:
 * /ws/agent, the agent-facing REST routes and /api/cli/v1 accept only
 * 'agent', requireAdmin accepts only 'admin'.
 */
export async function validateAgentToken(rawToken: string): Promise<ValidatedAgentTokenWithMeta | null> {
  const tokenHash = hashToken(rawToken);
  const token = await prisma.agentToken.findUnique({
    where: { tokenHash },
    include: { user: true, instance: true },
  });

  if (!token || token.revokedAt) return null;
  if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return null;

  touchLastUsed(token.id, token.lastUsedAt);

  return {
    user: token.user,
    instance: token.instance,
    token: { id: token.id, scope: token.scope, name: token.name },
  };
}

/** How often a token's lastUsedAt is written: the token list shows it to the minute. */
export const LAST_USED_WRITE_MS = 60_000;
/**
 * How soon a failed write is retried. A database refusing writes must not get
 * one write per request — that is the amplification this throttle exists to
 * prevent — but the full-minute throttle would hide the token's use long after
 * a short incident. The list shows last use to the minute, so ten seconds is
 * invisible there.
 */
export const LAST_USED_RETRY_MS = 10_000;
const lastUsedWritten = new Map<string, number>(); // token id → when this process last wrote it
const lastUsedRetryAt = new Map<string, number>(); // token id → earliest retry after a failed write

/**
 * Pure: whether a request at `now` should write lastUsedAt, given the last
 * write this process made and the value the row holds. The row's value covers
 * another orchestrator's writes (two during an overlapping deploy); the
 * process's own covers a burst of requests that all read the row before the
 * first write landed.
 */
export function lastUsedDue(now: number, wroteAt: number | undefined, stored: Date | null): boolean {
  const prev = Math.max(wroteAt ?? 0, stored?.getTime() ?? 0);
  return now - prev >= LAST_USED_WRITE_MS;
}

/**
 * Records that a token was used, at most once a minute per token (fire and
 * forget); a failed write backs off LAST_USED_RETRY_MS rather than a minute.
 * It used to be a write on every CLI and agent request: about 90 a minute
 * from one busy CLI client on 2026-11-13, each one a pooled connection.
 */
function touchLastUsed(tokenId: string, stored: Date | null, now = Date.now()): void {
  if (now < (lastUsedRetryAt.get(tokenId) ?? 0)) return;
  if (!lastUsedDue(now, lastUsedWritten.get(tokenId), stored)) return;
  // live tokens are far fewer; this only bounds a leak
  if (lastUsedWritten.size > 10_000 || lastUsedRetryAt.size > 10_000) { lastUsedWritten.clear(); lastUsedRetryAt.clear(); }
  lastUsedWritten.set(tokenId, now);
  prisma.agentToken.update({ where: { id: tokenId }, data: { lastUsedAt: new Date(now) } })
    // A failure must neither retry on every request nor wait the full minute:
    // forget this attempt and back off briefly, unless a newer attempt has
    // already superseded it.
    .catch(() => {
      if (lastUsedWritten.get(tokenId) !== now) return;
      lastUsedWritten.delete(tokenId);
      // Back off from the failure, not the request: a write that takes longer
      // than the backoff to reject would otherwise leave the deadline in the past.
      lastUsedRetryAt.set(tokenId, Date.now() + LAST_USED_RETRY_MS);
    });
}

/** Test-only: forget the writes this process made. */
export function resetLastUsedForTests(): void { lastUsedWritten.clear(); lastUsedRetryAt.clear(); }
