import { Request, Response, NextFunction } from 'express';
import { validateAgentToken } from '../routes/agentTokens';
import { touchLastSeen } from '../services/admin/adminAccess';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.user) {
    touchLastSeen(req.user.id);
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Accept either a session cookie (browser users) or an Authorization Bearer
 * agent token (programmatic agent access). Used by endpoints that an agent
 * running on a user's machine might need to call directly.
 */
export async function requireAuthOrAgentToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.user) { touchLastSeen(req.user.id); next(); return; }

  const authHeader = req.headers.authorization ?? '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const result = await validateAgentToken(token);
      // An ownerless warm-pool token authenticates a box, not a person, so it
      // gets 401 here: every handler behind this middleware scopes its Prisma
      // queries by req.user.id, and a null owner would widen that to no filter.
      // Admin-scoped tokens are for /api/admin and /mcp/admin only
      // (middleware/admin.ts); they never act as a user. Laptop clients (the
      // CLI and `termag tui`) use /api/cli/v1, not these routes.
      if (result?.user && result.token.scope === 'agent') {
        req.user = result.user;
        req.agentInstanceId = result.instance?.id ?? null;
        next();
        return;
      }
    } catch { /* fall through to 401 */ }
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// Used by the Chrome relay — checks Bearer token from env
export function requireRelayToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (token && token === process.env.RELAY_TOKEN) {
    next();
    return;
  }
  res.status(401).json({ error: 'Invalid relay token' });
}

// Middleware called by WebSocket upgrade — returns userId from session or null
export function sessionUserId(sessionData: Record<string, unknown>): string | null {
  return (sessionData.userId as string) ?? null;
}
