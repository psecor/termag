/**
 * The orphan sweep: find spawns whose
 * parent session went away while they still matter, and give them a foster
 * parent (the nearest living ancestor, else the user's orphan home), or mark
 * them orphaned so the dashboard and the briefing gather them. Leader work,
 * once a minute from the spawn sweep, behind spawn-lifecycle-enabled for the
 * child's user and box. The rules are in spawnOrphans.ts.
 */
import { prisma } from '../db';
import { isProjectAgentConnected, sendForProject } from './agentRegistry';
import { boolVariation } from './featureFlags';
import { recordSpawnEvent } from './spawnEvents';
import {
  PARENT_GONE_MISSES, chooseAdopter, effectiveParent, needsParent, parentGone, parseOrphanHome,
  type Candidate, type ParentRef,
} from './spawnOrphans';
import * as tmux from './tmux';

const PAGE = 500;
/** How far up a tree the ancestor walk goes: deeper than any depth limit allows. */
const MAX_WALK = 12;
const WORKING = ['starting', 'running', 'blocked', 'needs_input'];

function orphanPage(cursor: string | undefined) {
  return prisma.agentSpawn.findMany({
    where: {
      retiredAt: null,
      // A browser-spawned root has no parent, but once the owner moves it into a session it has a foster.
      AND: [
        { OR: [{ parentProjectId: { not: null } }, { fosterProjectId: { not: null } }] },
        { OR: [{ state: { in: WORKING }, endedAt: null }, { reportedAt: { not: null }, nudgedAt: null }, { orphanedAt: { not: null } }] },
      ],
    },
    orderBy: { id: 'asc' },
    take: PAGE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
}

/** Consecutive minutes a root's parent pane has been missing, per spawn. A restart starts again, which only delays. */
const misses = new Map<string, number>();

interface Look {
  projectLive: boolean;
  workstreamLive: boolean;
  /** The session's own spawn row, when an agent started it. */
  spawn: { id: string; endedAt: Date | null; retiredAt: Date | null; parentProjectId: string | null; parentWorkstream: string | null; parentRole: string | null; fosterProjectId: string | null; fosterWorkstream: string | null; fosterRole: string | null; state: string; reportedAt: Date | null; nudgedAt: Date | null } | null;
  /** Its pane is in its box's tmux-list; null when the box could not be asked. */
  sessionLive: boolean | null;
}

/** Everything one tick needs to know about a session, asked at most once a tick. */
function looker() {
  const lists = new Map<string, Promise<Set<string> | null>>();
  // A null instanceId is the orchestrator host, served by the user's own agent.
  const sessionsOn = (userId: string, instanceId: string | null) => {
    const key = `${userId}|${instanceId ?? ''}`;
    if (!lists.has(key)) {
      lists.set(key, isProjectAgentConnected({ userId, instanceId })
        ? sendForProject({ userId, instanceId }, 'tmux-list', {}, 5000)
          .then(r => new Set(((r as { sessions?: unknown })?.sessions as string[] | undefined) ?? []))
          .catch(() => null)
        : Promise.resolve(null));
    }
    return lists.get(key)!;
  };
  const looks = new Map<string, Promise<Look>>();
  return (userId: string, ref: ParentRef): Promise<Look> => {
    const key = `${userId}|${ref.projectId}|${ref.workstream}|${ref.role}`;
    if (!looks.has(key)) {
      looks.set(key, (async () => {
        const [p, spawn] = await Promise.all([
          prisma.project.findFirst({
            where: { id: ref.projectId, userId },
            select: { name: true, archived: true, instanceId: true, user: { select: { unixUsername: true } }, workstreams: { where: { name: ref.workstream, archived: false }, select: { name: true } } },
          }),
          prisma.agentSpawn.findFirst({
            where: { userId, childProjectId: ref.projectId, childWorkstream: ref.workstream, state: { not: 'failed' } },
            orderBy: { createdAt: 'desc' },
            select: { id: true, endedAt: true, retiredAt: true, parentProjectId: true, parentWorkstream: true, parentRole: true, fosterProjectId: true, fosterWorkstream: true, fosterRole: true, state: true, reportedAt: true, nudgedAt: true },
          }),
        ]);
        if (!p) return { projectLive: false, workstreamLive: false, spawn, sessionLive: null };
        const set = await sessionsOn(userId, p.instanceId);
        const session = tmux.sessionName(p.user.unixUsername, p.name, ref.role as Parameters<typeof tmux.sessionName>[2], ref.workstream);
        return {
          projectLive: !p.archived,
          workstreamLive: ref.workstream === 'main' || p.workstreams.length > 0,
          spawn,
          sessionLive: set ? set.has(session) : null,
        };
      })());
    }
    return looks.get(key)!;
  };
}

// Ended is not enough: the end sweep never clears endedAt, and reconnect
// reconstruction (or a launch) can bring the same pane back. Only a retired
// spawn (its workstream removed) is gone whatever tmux says.
const alive = (l: Look) => l.projectLive && l.workstreamLive && !l.spawn?.retiredAt && l.sessionLive === true;

export async function runOrphanTick(now: number = Date.now()): Promise<{ adopted: number; orphaned: number }> {
  const rows: Awaited<ReturnType<typeof orphanPage>> = [];
  for (let cursor: string | undefined; ;) {
    const page = await orphanPage(cursor);
    rows.push(...page);
    if (page.length < PAGE) break;
    cursor = page[page.length - 1].id;
  }
  if (!rows.length) { misses.clear(); return { adopted: 0, orphaned: 0 }; }
  const users = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map(r => r.userId))] } } })).map(u => [u.id, u]));
  const boxes = new Map((await prisma.instance.findMany({
    where: { id: { in: [...new Set(rows.map(r => r.childInstanceId).filter((id): id is string => !!id))] } },
    select: { id: true, name: true, kind: true },
  })).map(b => [b.id, b]));
  const gate = new Map<string, Promise<boolean>>();
  const on = (userId: string, boxId: string | null) => {
    const key = `${userId}|${boxId ?? ''}`;
    if (!gate.has(key)) gate.set(key, boolVariation('spawn-lifecycle-enabled', users.get(userId)!, false, boxId ? boxes.get(boxId) ?? null : null));
    return gate.get(key)!;
  };
  const look = looker();

  let adopted = 0, orphaned = 0;
  const seen = new Set<string>();
  for (const s of rows) {
    seen.add(s.id);
    const user = users.get(s.userId);
    const parent = effectiveParent(s);
    if (!user || !parent || !(await on(s.userId, s.childInstanceId))) continue;
    if (!needsParent(s)) {
      misses.delete(s.id);
      // Orphaned once, but nothing left for anyone to hear (it ended, or retired): off the Orphans list.
      if (s.orphanedAt) await prisma.agentSpawn.updateMany({ where: { id: s.id, orphanedAt: s.orphanedAt }, data: { orphanedAt: null } });
      continue;
    }
    try {
      const l = await look(s.userId, parent);
      // A spawned parent's pane is the end sweep's to judge (it ends the spawn), and a root's is
      // judged here. An ended one is gone only while its pane is still missing: a pane brought
      // back keeps its children, and a box that can't be asked decides nothing.
      const ended = !!l.spawn?.endedAt && !l.spawn.retiredAt;
      if (ended && l.projectLive && l.workstreamLive && l.sessionLive !== false) {
        if (s.orphanedAt && l.sessionLive) await prisma.agentSpawn.updateMany({ where: { id: s.id, orphanedAt: s.orphanedAt }, data: { orphanedAt: null } });
        continue;
      }
      const verdict = parentGone({
        projectLive: l.projectLive,
        workstreamLive: l.workstreamLive,
        spawnGone: !!(l.spawn && (l.spawn.endedAt || l.spawn.retiredAt)),
        sessionLive: l.spawn ? true : l.sessionLive,
        // Already orphaned: gone until its pane is seen again.
        misses: s.orphanedAt ? PARENT_GONE_MISSES : misses.get(s.id) ?? 0,
      });
      if (!verdict.gone) {
        if (verdict.misses) misses.set(s.id, verdict.misses); else misses.delete(s.id);
        if (s.orphanedAt && verdict.misses === 0) {
          // Its parent is back (its pane returned): nobody need adopt it.
          await prisma.agentSpawn.updateMany({ where: { id: s.id, orphanedAt: s.orphanedAt }, data: { orphanedAt: null } });
        }
        continue;
      }
      misses.delete(s.id);

      // Nearest first: the original parent's line upward, through fosters. A browser-spawned root has none.
      const ancestors: Candidate[] = [];
      const visited = new Set<string>([`${s.childProjectId}|${s.childWorkstream}`]);
      let ref: ParentRef | null = s.parentProjectId ? { projectId: s.parentProjectId, workstream: s.parentWorkstream ?? 'main', role: s.parentRole ?? 'agent' } : null;
      for (let i = 0; ref && i < MAX_WALK && !visited.has(`${ref.projectId}|${ref.workstream}`); i++) {
        visited.add(`${ref.projectId}|${ref.workstream}`);
        const a = await look(s.userId, ref);
        ancestors.push({ ...ref, alive: ref.role === 'agent' && alive(a) });
        ref = a.spawn ? effectiveParent(a.spawn) : null;
      }
      const homeRef = parseOrphanHome(user.spawnOrphanHome);
      const home = homeRef ? { ...homeRef, role: 'agent', alive: alive(await look(s.userId, { ...homeRef, role: 'agent' })) } : null;
      const self = s.childProjectId ? { projectId: s.childProjectId, workstream: s.childWorkstream, role: 'agent' } : null;
      const pick = chooseAdopter(ancestors, home, self);

      if (pick.by === 'none') {
        if (s.orphanedAt) continue;
        const done = await prisma.agentSpawn.updateMany({
          where: { id: s.id, orphanedAt: null, fosterProjectId: s.fosterProjectId, fosterWorkstream: s.fosterWorkstream },
          data: { orphanedAt: new Date(now) },
        });
        if (done.count !== 1) continue;
        orphaned++;
        console.log(`[SPAWN] ${s.childProjectName}/${s.childWorkstream} orphaned: no living ancestor or orphan home (${s.id})`);
        await recordSpawnEvent({
          kind: 'orphaned', spawnId: s.id, rootSpawnId: s.rootSpawnId, userId: s.userId, instanceId: s.childInstanceId,
          parentProjectId: parent.projectId, parentWorkstream: parent.workstream,
          detail: { wasFostered: !!s.fosterProjectId, homeSet: !!homeRef },
        });
        continue;
      }
      if (pick.projectId === parent.projectId && pick.workstream === parent.workstream) continue;
      if ((await adoptSpawn(s, pick, pick.by, now)).ok) adopted++;
    } catch (err) {
      console.warn(`[SPAWN] orphan check of ${s.childProjectName}/${s.childWorkstream} failed (${s.id}):`, (err as Error).message);
    }
  }
  for (const id of misses.keys()) if (!seen.has(id)) misses.delete(id);
  return { adopted, orphaned };
}

type AdoptRow = {
  id: string; userId: string; rootSpawnId: string | null; childProjectName: string; childWorkstream: string; childInstanceId: string | null;
  fosterProjectId: string | null; fosterWorkstream: string | null; orphanedAt: Date | null;
};

/**
 * Hand a spawn to a new foster: compare-and-set on the foster it had and on
 * whether it was orphaned, so two adopters (the sweep and a person, or two
 * agents) cannot both win, and an agent cannot take one the sweep has just
 * given back to its parent. Its report stays unread if it was, so the nudge
 * goes to the foster.
 */
export async function adoptSpawn(s: AdoptRow, to: ParentRef, by: 'ancestor' | 'home' | 'owner' | 'agent', now: number = Date.now()): Promise<{ ok: boolean }> {
  const done = await prisma.agentSpawn.updateMany({
    where: { id: s.id, retiredAt: null, fosterProjectId: s.fosterProjectId, fosterWorkstream: s.fosterWorkstream, orphanedAt: s.orphanedAt },
    data: { fosterProjectId: to.projectId, fosterWorkstream: to.workstream, fosterRole: to.role, adoptedAt: new Date(now), adoptedBy: by, orphanedAt: null },
  });
  if (done.count !== 1) return { ok: false };
  misses.delete(s.id);
  console.log(`[SPAWN] ${s.childProjectName}/${s.childWorkstream} adopted by ${to.projectId}/${to.workstream} (${by}, ${s.id})`);
  await recordSpawnEvent({
    kind: 'adopted', spawnId: s.id, rootSpawnId: s.rootSpawnId, userId: s.userId, reason: by, instanceId: s.childInstanceId,
    parentProjectId: to.projectId, parentWorkstream: to.workstream,
    detail: { wasFostered: !!s.fosterProjectId },
  });
  return { ok: true };
}
