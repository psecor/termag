/**
 * Saves Slack agent threads (agentSession.ts) to `slack_agent_threads` and
 * `slack_agent_dm_last`, so a deploy or a lease handover keeps which Claude
 * session each thread resumes and whose conversation a channel thread is. The
 * same shape as activeTargets.ts: reads stay on agentSession's maps, every
 * write goes through here (one thread's writes in order), and
 * loadAgentThreadsOrRetry reads the rows back each time the bot connects. A
 * failed write is logged; the map still has it until the process ends.
 *
 * A saved session only helps where the backend's home, which holds Claude's own
 * session files, outlives the process. Where it does not (a container), the
 * resume fails and the turn starts fresh and says so (agentTurn.ts).
 */
import { prisma } from '../db';
import { hydrateAgentThreads, RUN_HOLDER, RUN_STALE_MS, setAgentThreadStore, type AgentThreadStore } from './agentSession';

/** Threads untouched this long are not loaded, and their rows are deleted. */
export const AGENT_THREAD_RETENTION_DAYS = 14;
// Matches agentSession's in-memory cap.
const LOAD_LIMIT = 500;

const writes = new Map<string, Promise<void>>();

/** Waits for the writes queued so far, for the given keys or for all of them. */
export async function flushAgentWrites(keys?: string[]): Promise<void> {
  const pending = keys ? keys.map(k => writes.get(k)).filter(Boolean) : [...writes.values()];
  await Promise.allSettled(pending);
}

function writeInOrder(key: string, what: string, write: () => Promise<unknown>): void {
  const next = (writes.get(key) ?? Promise.resolve())
    .then(write)
    .then(() => {}, err => console.error(`[AGENT] Failed to ${what}:`, (err as Error).message));
  writes.set(key, next);
  void next.then(() => { if (writes.get(key) === next) writes.delete(key); });
}

export const prismaAgentThreadStore: AgentThreadStore = {
  saveThread(channelId, threadTs, fields) {
    writeInOrder(`t:${channelId}:${threadTs}`, 'save an agent thread', async () => {
      // Fenced by the run claim, with the same rule claimRun uses: a late write
      // from this process (draining after a handover) must not overwrite what a
      // live claim elsewhere has saved since. Free, ours, or lapsed (a crashed
      // holder) all take the write.
      const update = () => prisma.slackAgentThread.updateMany({
        where: {
          channelId, threadTs,
          OR: [{ runHolder: null }, { runHolder: RUN_HOLDER }, { runBeatAt: { lt: new Date(Date.now() - RUN_STALE_MS) } }],
        },
        data: fields,
      });
      if ((await update()).count) return;
      try {
        await prisma.slackAgentThread.create({ data: { channelId, threadTs, ...fields } });
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
        // The row appeared meanwhile (often this process's own run claim):
        // the fence decides again, and only a live claim elsewhere keeps it out.
        await update();
      }
    });
  },
  saveDmLast(channelId, last) {
    // No spaceId is a personal session's, which clears whatever space the DM's last one had.
    const row = { ...last, spaceId: last.spaceId ?? null };
    writeInOrder(`d:${channelId}`, 'save a DM\'s last agent session', () => prisma.slackAgentDmLast.upsert({
      where: { channelId },
      update: row,
      create: { channelId, ...row },
    }));
  },
  flush(channelId, threadTs, dmChannel) {
    return flushAgentWrites([`t:${channelId}:${threadTs}`, ...(dmChannel ? [`d:${dmChannel}`] : [])]);
  },
  flushAll() {
    return flushAgentWrites();
  },
  deleteDmLast(channelId) {
    writeInOrder(`d:${channelId}`, 'forget a DM\'s last agent session', () => prisma.slackAgentDmLast.deleteMany({ where: { channelId } }));
  },
  async claimRun(channelId, threadTs, holder) {
    const now = new Date();
    await prisma.slackAgentThread.upsert({
      where: { channelId_threadTs: { channelId, threadTs } }, update: {}, create: { channelId, threadTs },
    });
    // One statement, so two processes claiming at once cannot both win: the
    // second one's WHERE is checked again against the first one's row.
    const claimed = await prisma.slackAgentThread.updateMany({
      where: {
        channelId, threadTs,
        OR: [{ runHolder: null }, { runHolder: holder }, { runBeatAt: { lt: new Date(now.getTime() - RUN_STALE_MS) } }],
      },
      data: { runHolder: holder, runBeatAt: now },
    });
    return claimed.count === 1;
  },
  renewRun(channelId, threadTs, holder) {
    void prisma.slackAgentThread.updateMany({ where: { channelId, threadTs, runHolder: holder }, data: { runBeatAt: new Date() } })
      .catch(err => console.error('[AGENT] Failed to renew a run claim:', (err as Error).message));
  },
  async releaseRun(channelId, threadTs, holder) {
    await prisma.slackAgentThread.updateMany({ where: { channelId, threadTs, runHolder: holder }, data: { runHolder: null, runBeatAt: null } });
  },
};

/** Reads the saved threads back into agentSession's maps, and drops expired rows. */
export async function loadAgentThreads(now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - AGENT_THREAD_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const [threads, dms] = await Promise.all([
    prisma.slackAgentThread.findMany({ where: { updatedAt: { gte: since } }, orderBy: { updatedAt: 'desc' }, take: LOAD_LIMIT }),
    prisma.slackAgentDmLast.findMany(),
  ]);
  hydrateAgentThreads(threads, dms, now.getTime());
  await prisma.slackAgentThread.deleteMany({ where: { updatedAt: { lt: since } } })
    .catch(err => console.error('[AGENT] Failed to prune old agent threads:', (err as Error).message));
  return threads.length;
}

const RETRY_MS = 30_000;
let retry: ReturnType<typeof setTimeout> | null = null;

/**
 * Turns on saving, then loadAgentThreads for the bot's start: waits for the
 * first try, and when it fails keeps trying every 30 s in the background.
 */
export async function loadAgentThreadsOrRetry(): Promise<void> {
  setAgentThreadStore(prismaAgentThreadStore);
  try {
    await loadAgentThreads();
    if (retry) clearTimeout(retry);
    retry = null;
  } catch (err) {
    console.error('[AGENT] Could not load the saved agent threads, trying again in 30 s:', (err as Error).message);
    if (retry) return;
    retry = setTimeout(() => { retry = null; void loadAgentThreadsOrRetry(); }, RETRY_MS);
    retry.unref?.();
  }
}
