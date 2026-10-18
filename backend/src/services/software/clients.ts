/**
 * Client versions: the latest version
 * each user was seen with, per client kind. Recorded when a response
 * finishes, so both session users (req.user) and CLI bearer users
 * (res.locals.cliAuth) are known; at most once an hour per user and kind.
 */
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../../db';
import { clientFromHeaders } from './versions';

const WRITE_EVERY_MS = 3600_000;
const lastWrite = new Map<string, { at: number; version: string }>();

export async function recordClient(userId: string, kind: string, version: string, now = Date.now()): Promise<boolean> {
  const key = `${userId}:${kind}`;
  const prev = lastWrite.get(key);
  if (prev && prev.version === version && now - prev.at < WRITE_EVERY_MS) return false;
  lastWrite.set(key, { at: now, version });
  await prisma.clientVersion.upsert({
    where: { userId_kind: { userId, kind } },
    create: { userId, kind, version, lastSeenAt: new Date(now) },
    update: { version, lastSeenAt: new Date(now) },
  });
  return true;
}

export function clientVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-termag-client'];
  const client = clientFromHeaders(typeof header === 'string' ? header : undefined, req.headers['user-agent']);
  if (client) {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const userId = (req.user as { id?: string } | undefined)?.id ?? (res.locals.cliAuth as { user?: { id?: string } } | undefined)?.user?.id;
      if (userId) recordClient(userId, client.kind, client.version).catch(() => {});
    });
  }
  next();
}
