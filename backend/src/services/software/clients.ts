/**
 * Client versions: the latest version
 * each user was seen with, per client kind. Recorded when a response
 * finishes, so both session users (req.user) and CLI bearer users
 * (res.locals.cliAuth) are known; at most once an hour per user and kind.
 *
 * The desktop app also counts as opened: its
 * requests send `client.opened` with `view: desktop`, at most once every four
 * hours per user, as the browser's own `client.opened` comes again after four
 * hours away. The desktop has no way to say it was launched, so this counts
 * the four-hour windows a person used it in.
 *
 * Both throttles are in memory, per orchestrator process: a restart, or a
 * second process during a deploy, can write or send once more.
 */
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../../db';
import { recordProductEvent } from '../productEvents';
import { clientFromHeaders, desktopFromUserAgent, type DesktopClient } from './versions';

const WRITE_EVERY_MS = 3600_000;
const OPEN_EVERY_MS = 4 * 3600_000;
const lastWrite = new Map<string, { at: number; value: string }>();
const lastOpen = new Map<string, { at: number; value: string }>();

/** Whether `key` is due: never within `everyMs` of the last time, unless `value` changed since. Marks it done when it is. */
function due(last: Map<string, { at: number; value: string }>, key: string, value: string, everyMs: number, now: number): boolean {
  const prev = last.get(key);
  if (prev && prev.value === value && now - prev.at < everyMs) return false;
  last.set(key, { at: now, value });
  return true;
}

export async function recordClient(userId: string, kind: string, version: string, now = Date.now()): Promise<boolean> {
  if (!due(lastWrite, `${userId}:${kind}`, version, WRITE_EVERY_MS, now)) return false;
  await prisma.clientVersion.upsert({
    where: { userId_kind: { userId, kind } },
    create: { userId, kind, version, lastSeenAt: new Date(now) },
    update: { version, lastSeenAt: new Date(now) },
  });
  return true;
}

/** `client.opened` for the desktop app, at most once every four hours per user, whatever the version. */
export function recordDesktopOpen(userId: string, desktop: DesktopClient, now = Date.now()): boolean {
  if (!due(lastOpen, userId, '', OPEN_EVERY_MS, now)) return false;
  recordProductEvent('client.opened', { user: userId }, {
    view: 'desktop', version: desktop.version, channel: desktop.channel, platform: desktop.platform,
  });
  return true;
}

/** Test hook: forget every write and open. */
export function resetClientThrottlesForTests(): void {
  lastWrite.clear();
  lastOpen.clear();
}

export function clientVersionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-termag-client'];
  const client = clientFromHeaders(typeof header === 'string' ? header : undefined, req.headers['user-agent']);
  if (client) {
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const userId = (req.user as { id?: string } | undefined)?.id ?? (res.locals.cliAuth as { user?: { id?: string } } | undefined)?.user?.id;
      if (!userId) return;
      recordClient(userId, client.kind, client.version).catch(() => {});
      const desktop = client.kind === 'desktop' ? desktopFromUserAgent(req.headers['user-agent']) : null;
      if (desktop) recordDesktopOpen(userId, desktop);
    });
  }
  next();
}
