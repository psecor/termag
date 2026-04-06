import { Request, Response, NextFunction } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.user) {
    next();
    return;
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
