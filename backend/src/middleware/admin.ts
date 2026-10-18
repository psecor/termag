/**
 * requireAdmin — the gate on /api/admin/* and /mcp/admin.
 *
 * Accepts either
 *   - a cookie session whose user is an admin (users.role or ADMIN_USERS), or
 *   - `Authorization: Bearer tmag_…` with scope 'admin', unexpired, unrevoked,
 *     whose OWNER is still an admin (demoting a user disables their tokens).
 * Non-admins get 404, not 403, so the surface's existence isn't advertised —
 * the same convention assertSessionAccess uses for sessions.
 *
 * Every request that passes writes an admin_audit_log row on response finish
 * (reads included). Audit writes are fire-and-forget; a failed audit insert is
 * logged, never surfaced to the caller.
 */
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../db';
import { validateAgentToken } from '../routes/agentTokens';
import { isAdminUser, touchLastSeen } from '../services/admin/adminAccess';

declare global {
  namespace Express {
    interface Request {
      /** Set when the request authenticated with an admin-scoped bearer token. */
      adminTokenId?: string;
      /** Set by the MCP mount: tool calls audit themselves, so skip the per-request REST row. */
      skipAudit?: boolean;
    }
  }
}

export function notFound(res: Response): void {
  res.status(404).json({ error: 'Not found' });
}

/**
 * For actions that create or widen privilege (minting admin tokens, granting
 * admin): only a signed-in admin session may do them. An admin bearer token is
 * a read credential held by a model or a script; letting it mint more tokens
 * or promote users would turn a leaked or prompt-injected token into durable
 * privilege. Runs after requireAdmin.
 */
export function requireAdminSession(req: Request, res: Response, next: NextFunction): void {
  if (req.adminTokenId) {
    res.status(403).json({ error: 'This action needs a signed-in admin session, not an admin token' });
    return;
  }
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    const authHeader = req.headers.authorization ?? '';
    if (authHeader.startsWith('Bearer ')) {
      try {
        const result = await validateAgentToken(authHeader.slice(7));
        if (result && result.token.scope === 'admin') {
          req.user = result.user as Express.User;
          req.adminTokenId = result.token.id;
        } else if (result) {
          // A real token of the wrong scope identifies a caller who is not an
          // admin here; same 404 as a signed-in non-admin, not a 401 hint.
          notFound(res);
          return;
        }
      } catch { /* treated as unauthenticated below */ }
    }
  }
  if (!req.user) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (!isAdminUser(req.user)) { notFound(res); return; }

  touchLastSeen(req.user.id); // bearer-only (MCP) admins count as seen too
  if (!req.skipAudit) attachAudit(req, res);
  next();
}

function attachAudit(req: Request, res: Response): void {
  const actorId = req.user!.id;
  const tokenId = req.adminTokenId ?? null;
  const action = `${req.method} ${req.baseUrl}${req.path}`;
  const args = summarizeArgs(req);
  res.once('finish', () => {
    recordAudit({ actorId, tokenId, surface: 'rest', action, args, outcome: auditOutcome(res.statusCode), status: res.statusCode });
  });
}

/** ok (2xx/3xx) · denied (401/403) · not_found (404) · rejected (other 4xx: bad input, rate limit) · error (5xx). */
export type AuditOutcome = 'ok' | 'denied' | 'not_found' | 'rejected' | 'error';
export function auditOutcome(status: number): AuditOutcome {
  if (status < 400) return 'ok';
  if (status === 401 || status === 403) return 'denied';
  if (status === 404) return 'not_found';
  if (status < 500) return 'rejected';
  return 'error';
}

export interface AuditEntry {
  actorId: string;
  tokenId: string | null;
  surface: 'rest' | 'mcp';
  action: string;
  args: Record<string, unknown> | null;
  outcome: AuditOutcome;
  status?: number | null;
}

export function recordAudit(entry: AuditEntry): void {
  prisma.adminAuditLog.create({
    data: {
      actorId: entry.actorId,
      tokenId: entry.tokenId,
      surface: entry.surface,
      action: entry.action,
      args: entry.args === null ? undefined : (entry.args as object),
      outcome: entry.outcome,
      status: entry.status ?? null,
    },
  }).catch(err => console.error('[ADMIN] audit write failed:', (err as Error).message));
}

// Query string + route params, and the body's keys with scalar values. Never
// the body wholesale: a future action route might carry something secret.
export function summarizeArgs(req: Pick<Request, 'query' | 'params' | 'body'>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(req.query ?? {})) out[k] = v;
  for (const [k, v] of Object.entries(req.params ?? {})) out[k] = v;
  if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
    for (const [k, v] of Object.entries(req.body as Record<string, unknown>)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) {
        out[k] = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v;
      } else {
        out[k] = Array.isArray(v) ? `[${v.length} items]` : '{…}';
      }
    }
  }
  return Object.keys(out).length ? out : null;
}
