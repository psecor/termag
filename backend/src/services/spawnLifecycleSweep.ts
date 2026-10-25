/**
 * The lifecycle sweep: park finished delegates that
 * sat idle, and retire parked ones whose work has landed or waited out the
 * delay, never losing work. Leader work, once a minute from the spawn sweep,
 * behind spawn-lifecycle-enabled for the child's user and box.
 */
import { prisma } from '../db';
import { boolVariation } from './featureFlags';
import { checkoutCheck, parkSpawn, retireSpawn } from './spawnActions';
import { spawnLimitsFor } from './spawnBudget';
import { lifecycleStep, retireNow } from './spawnLifecycle';
import { getStatus } from './status';
import * as tmux from './tmux';

const MIN = 60_000;
/** A parked spawn's checkout is read at most this often: it is an RPC to the box. */
const CHECK_EVERY_MS = 10 * MIN;
const lastChecked = new Map<string, number>();
const PAGE = 500;

function lifecyclePage(cursor: string | undefined) {
  return prisma.agentSpawn.findMany({
    where: {
      retiredAt: null, state: 'done', reportedAt: { not: null }, childProjectId: { not: null },
      NOT: { parkedAt: { not: null }, relationship: { not: 'delegate' } },
    },
    orderBy: { id: 'asc' },
    take: PAGE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

export async function runLifecycleTick(now: number = Date.now()): Promise<{ parked: number; retired: number }> {
  // Every candidate, in pages: a parked peer needs nothing more (peers only
  // park) and is left out, and a kept delegate stays in for its rechecks, so a
  // fixed first page would starve newer spawns once enough of those pile up.
  const rows: Awaited<ReturnType<typeof lifecyclePage>> = [];
  for (let cursor: string | undefined; ;) {
    const page = await lifecyclePage(cursor);
    rows.push(...page);
    if (page.length < PAGE) break;
    cursor = page[page.length - 1].id;
  }
  if (!rows.length) return { parked: 0, retired: 0 };
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.userId))] } } })).map(u => [u.id, u]));
  const boxes = new Map((await prisma.instance.findMany({
    where: { id: { in: [...new Set(rows.map(r => r.childInstanceId).filter((id): id is string => !!id))] } },
    select: { id: true, name: true, kind: true },
  })).map(b => [b.id, b]));
  // The flag and the limits are read per (user, box), once per tick.
  const gate = new Map<string, Promise<{ on: boolean; parkIdleMs: number; retireAfterMs: number }>>();
  const gateFor = (userId: string, boxId: string | null) => {
    const key = `${userId}|${boxId ?? ''}`;
    if (!gate.has(key)) {
      const user = users.get(userId)!;
      const box = boxId ? boxes.get(boxId) ?? null : null;
      gate.set(key, (async () => {
        const [on, limits] = await Promise.all([boolVariation('spawn-lifecycle-enabled', user, false, box), spawnLimitsFor(user, box)]);
        return { on, parkIdleMs: limits.parkIdleMinutes * MIN, retireAfterMs: limits.retireAfterDays * 24 * 60 * MIN };
      })());
    }
    return gate.get(key)!;
  };

  let parked = 0, retired = 0;
  for (const s of rows) {
    const user = users.get(s.userId);
    if (!user) continue;
    const g = await gateFor(s.userId, s.childInstanceId);
    if (!g.on) continue;
    const status = getStatus(tmux.sessionName(user.unixUsername, s.childProjectName, 'agent', s.childWorkstream), s.childInstanceId);
    const step = lifecycleStep(s, { paneStatus: status.status, paneSince: status.updatedAt.getTime(), parkIdleMs: g.parkIdleMs, now });
    // A stale cooldown must not follow a spawn that left the retire path (resumed, re-parked later).
    if (step !== 'retire') lastChecked.delete(s.id);
    try {
      if (step === 'park') {
        if ((await parkSpawn(s, 'sweep')).ok) parked++;
      } else if (step === 'retire') {
        if (now - (lastChecked.get(s.id) ?? 0) < CHECK_EVERY_MS) continue;
        lastChecked.set(s.id, now);
        const check = await checkoutCheck(s);
        const decision = retireNow(check, { prMerged: false, parkedForMs: now - s.parkedAt!.getTime(), retireAfterMs: g.retireAfterMs });
        if (decision.retire) {
          if ((await retireSpawn(s, 'sweep', check)).ok) { retired++; lastChecked.delete(s.id); }
        } else if (decision.kept) {
          await retireSpawn(s, 'sweep', check); // records why it is kept
        } else if (s.keptReason) {
          // Safe now, only waiting out the delay: the old reason no longer holds.
          await prisma.agentSpawn.update({ where: { id: s.id }, data: { keptReason: null } });
        }
      }
    } catch (err) {
      console.warn(`[SPAWN] lifecycle of ${s.childProjectName}/${s.childWorkstream} failed (${s.id}):`, (err as Error).message);
    }
  }
  const seen = new Set(rows.map(r => r.id));
  for (const id of lastChecked.keys()) if (!seen.has(id)) lastChecked.delete(id);
  return { parked, retired };
}
