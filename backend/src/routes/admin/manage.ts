/**
 * Admin management: admin-scoped tokens (org-wide), who is an admin, and the
 * audit log. Mounted inside adminRouter, so requireAdmin already ran.
 */
import { Router } from 'express';
import { prisma } from '../../db';
import { asyncHandler } from '../../middleware/errors';
import { requireAdminSession } from '../../middleware/admin';
import { generateToken, hashToken } from '../agentTokens';
import { adminUsersConfig, isAdminUser } from '../../services/admin/adminAccess';
import { isAdminEmail } from '../../auth/adminUsers';
import { parseRange } from '../../services/admin/range';

export const ADMIN_TOKEN_DEFAULT_DAYS = 90;
export const ADMIN_TOKEN_MAX_DAYS = 365;

/** Pure: validate the mint request body. */
export function parseMintBody(body: unknown): { name: string; expiresDays: number | null } | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };
  const { name, expiresDays } = body as { name?: unknown; expiresDays?: unknown };
  if (typeof name !== 'string' || !name.trim() || name.length > 80) return { error: 'name (1-80 chars) required' };
  if (expiresDays === undefined) return { name: name.trim(), expiresDays: ADMIN_TOKEN_DEFAULT_DAYS };
  if (expiresDays === null) return { name: name.trim(), expiresDays: null };
  if (typeof expiresDays !== 'number' || !Number.isInteger(expiresDays) || expiresDays < 1 || expiresDays > ADMIN_TOKEN_MAX_DAYS) {
    return { error: `expiresDays must be an integer 1-${ADMIN_TOKEN_MAX_DAYS}, or null for no expiry` };
  }
  return { name: name.trim(), expiresDays };
}

export function manageRouter(): Router {
  const router = Router();

  router.get('/tokens', asyncHandler(async (_req, res) => {
    const tokens = await prisma.agentToken.findMany({
      where: { scope: 'admin' },
      include: { user: { select: { id: true, unixUsername: true, googleEmail: true, role: true, adminSource: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(tokens.map(t => ({
      id: t.id, name: t.name, tokenPrefix: t.tokenPrefix, scope: t.scope,
      createdAt: t.createdAt.toISOString(), lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      expiresAt: t.expiresAt?.toISOString() ?? null, revokedAt: t.revokedAt?.toISOString() ?? null,
      expired: !!t.expiresAt && t.expiresAt.getTime() <= Date.now(),
      // Admin tokens are always minted for a person, but the column is nullable (warm-pool box tokens).
      owner: t.user ? { id: t.user.id, unixUsername: t.user.unixUsername, email: t.user.googleEmail, stillAdmin: isAdminUser(t.user) } : null,
    })));
  }));

  // Mint an admin token for the CALLER. Tokens are owned by a person so the
  // audit log names them and so losing admin disables the token. Session only:
  // a token must not be able to mint tokens.
  router.post('/tokens', requireAdminSession, asyncHandler(async (req, res) => {
    const parsed = parseMintBody(req.body);
    if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return; }
    const raw = generateToken();
    const token = await prisma.agentToken.create({
      data: {
        name: parsed.name, scope: 'admin', tokenHash: hashToken(raw), tokenPrefix: raw.substring(0, 13) + '...',
        userId: req.user!.id,
        expiresAt: parsed.expiresDays ? new Date(Date.now() + parsed.expiresDays * 86_400_000) : null,
      },
    });
    res.status(201).json({ id: token.id, name: token.name, token: raw, tokenPrefix: token.tokenPrefix, scope: 'admin',
      createdAt: token.createdAt.toISOString(), expiresAt: token.expiresAt?.toISOString() ?? null });
  }));

  router.delete('/tokens/:id', requireAdminSession, asyncHandler(async (req, res) => {
    const result = await prisma.agentToken.updateMany({ where: { id: req.params.id, scope: 'admin', revokedAt: null }, data: { revokedAt: new Date() } });
    if (result.count === 0) { res.status(404).json({ error: 'Token not found' }); return; }
    res.json({ ok: true });
  }));

  router.get('/admins', asyncHandler(async (_req, res) => {
    const users = await prisma.user.findMany({ select: { id: true, unixUsername: true, googleEmail: true, displayName: true, role: true, adminSource: true, lastSeenAt: true } });
    const config = adminUsersConfig();
    res.json({
      envConfigured: config.exact.size + config.domains.size > 0,
      admins: users.filter(u => isAdminUser(u)).map(u => ({
        id: u.id, unixUsername: u.unixUsername, email: u.googleEmail, displayName: u.displayName,
        source: u.role === 'admin' ? (u.adminSource ?? 'grant') : 'env',
        lastSeenAt: u.lastSeenAt?.toISOString() ?? null,
        // env-listed admins cannot be demoted here; the list is authoritative for them.
        demotable: !isAdminEmail(config, u.googleEmail),
      })),
    });
  }));

  // Grant or revoke. Session only (see requireAdminSession). Refuses to demote
  // env-listed admins (edit ADMIN_USERS) and refuses self-demotion (no
  // lock-outs by accident).
  router.put('/admins/:userId', requireAdminSession, asyncHandler(async (req, res) => {
    const { role } = req.body as { role?: unknown };
    if (role !== 'admin' && role !== 'member') { res.status(400).json({ error: "role must be 'admin' or 'member'" }); return; }
    const target = await prisma.user.findUnique({ where: { id: req.params.userId } });
    if (!target) { res.status(404).json({ error: 'User not found' }); return; }
    if (role === 'member') {
      if (target.id === req.user!.id) { res.status(400).json({ error: 'You cannot demote yourself' }); return; }
      if (isAdminEmail(adminUsersConfig(), target.googleEmail)) { res.status(400).json({ error: 'This admin comes from ADMIN_USERS; remove them there' }); return; }
    }
    // An env-listed user stays env-sourced, so a later ADMIN_USERS removal
    // still demotes them; only off-list grants are recorded as 'grant'.
    const onEnvList = isAdminEmail(adminUsersConfig(), target.googleEmail);
    const updated = await prisma.user.update({
      where: { id: target.id },
      data: role === 'admin' ? { role: 'admin', adminSource: onEnvList ? 'env' : 'grant' } : { role: 'member', adminSource: null },
      select: { id: true, unixUsername: true, role: true, adminSource: true },
    });
    res.json(updated);
  }));

  router.get('/audit', asyncHandler(async (req, res) => {
    const range = parseRange(req.query as Record<string, unknown>);
    if ('error' in range) { res.status(400).json({ error: range.error }); return; }
    const limit = Math.min(1000, Math.max(1, parseInt((req.query.limit as string) ?? '200', 10) || 200));
    const rows = await prisma.adminAuditLog.findMany({
      where: { at: { gte: range.sinceTs, lt: range.untilTs }, ...(typeof req.query.actorId === 'string' ? { actorId: req.query.actorId } : {}) },
      orderBy: { at: 'desc' }, take: limit,
    });
    const actors = await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.actorId))] } }, select: { id: true, unixUsername: true } });
    const name = new Map(actors.map(a => [a.id, a.unixUsername]));
    res.json({ rows: rows.map(r => ({ ...r, at: r.at.toISOString(), actor: name.get(r.actorId) ?? r.actorId })), limit });
  }));

  return router;
}
