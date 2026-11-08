/**
 * Freezing a channel's termag threads at link and unlink, on `slack_agent_threads.frozenAt` (M2):
 *
 * - at link, every thread in the channel, operator `personal` threads too,
 *   so a personal session never runs inside a space channel, and any space
 *   thread an earlier link's failed unlink freeze left behind. The same-space
 *   no-op's repeat (`repeat`) skips `space` threads, which are then the live
 *   link's own;
 * - at unlink, the channel's `space` threads.
 *
 * A thread already frozen keeps its first `frozenAt`. The rows are the
 * source of truth; this process's in-memory bindings (slack/session/claims.ts)
 * are updated too, so a thread loaded here sees the freeze at once. Another
 * process sees it when it reads the row.
 */
import { prisma } from '../../db';
import { setThreadBinding, threadBindingOf, threadKey } from '../../slack/session/claims';
import { isPersonalBinding, parseThreadScope, type ThreadBinding } from '../../slack/session/scope';
import type { ThreadFreezer } from './link';

type Where = { channelId: string; frozenAt: null; scope?: string | { not: string } };

async function freeze(where: Where, at: Date): Promise<number> {
  const threads = await prisma.slackAgentThread.findMany({
    where, select: { channelId: true, threadTs: true, scope: true, spaceId: true, routeSeq: true },
  });
  if (!threads.length) return 0;
  const done = await prisma.slackAgentThread.updateMany({ where: { ...where, threadTs: { in: threads.map(t => t.threadTs) } }, data: { frozenAt: at } });
  for (const t of threads) {
    const key = threadKey(t.channelId, t.threadTs);
    // A binding this process holds is the newest; otherwise threadBindingOf
    // answers PERSONAL_BINDING for any unloaded thread, so build it from the row
    // instead, or a space or router thread would be written back as personal.
    const held = threadBindingOf(key);
    const binding: ThreadBinding = isPersonalBinding(held)
      ? { scope: parseThreadScope(t.scope), spaceId: t.spaceId ?? null, routeSeq: t.routeSeq ?? 0, frozenAt: null }
      : held;
    if (!binding.frozenAt) setThreadBinding(key, { ...binding, frozenAt: at });
  }
  return done.count;
}

export const prismaThreadFreezer: ThreadFreezer = {
  freezeAtLink: (channelId, _spaceName, at, opts) =>
    freeze({ channelId, frozenAt: null, ...(opts?.repeat ? { scope: { not: 'space' } } : {}) }, at),
  freezeAtUnlink: (channelId, _spaceName, at) => freeze({ channelId, frozenAt: null, scope: 'space' }, at),
  spaceThreadCount: channelId => prisma.slackAgentThread.count({ where: { channelId, frozenAt: null, scope: 'space' } }),
};
