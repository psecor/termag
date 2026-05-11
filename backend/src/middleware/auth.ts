import { Request, Response, NextFunction } from 'express';
import { validateAgentToken } from '../routes/agentTokens';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.user) {
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
  if (req.user) { next(); return; }

  const authHeader = req.headers.authorization ?? '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const user = await validateAgentToken(token);
      if (user) {
        req.user = user as Express.User;
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
