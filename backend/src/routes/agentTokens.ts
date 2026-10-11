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

  // Update lastUsedAt (fire and forget)
  prisma.agentToken.update({
    where: { id: token.id },
    data: { lastUsedAt: new Date() },
  }).catch(() => {});

  return {
    user: token.user,
    instance: token.instance,
    token: { id: token.id, scope: token.scope, name: token.name },
  };
}
