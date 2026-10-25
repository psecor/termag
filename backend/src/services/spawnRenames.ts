/**
 * Keep agent_spawns in step with a rename. A spawn row names its child, its
 * parent and its foster by project id plus workstream name (and keeps the
 * child's project name and the parent's session for display), so a renamed
 * workstream or project would otherwise break the tree's parent links, the
 * status history's watched sessions and the dashboard's links. Best effort:
 * a failure is logged and never fails the rename.
 */
import { prisma } from '../db';
import { parseOrphanHome } from './spawnOrphans';
import * as tmux from './tmux';

type Role = Parameters<typeof tmux.sessionName>[2];

/** Parents' session names, rebuilt from the project's current name. */
async function reparentSessions(userId: string, unixUsername: string, projectId: string, projectName: string, workstream?: string): Promise<void> {
  const rows = await prisma.agentSpawn.findMany({
    where: { userId, parentProjectId: projectId, ...(workstream ? { parentWorkstream: workstream } : {}), parentSession: { not: null } },
    select: { id: true, parentWorkstream: true, parentRole: true },
  });
  for (const r of rows) {
    await prisma.agentSpawn.update({
      where: { id: r.id },
      data: { parentSession: tmux.sessionName(unixUsername, projectName, (r.parentRole ?? 'agent') as Role, r.parentWorkstream ?? 'main') },
    });
  }
}

export async function renameSpawnWorkstream(
  user: { id: string; unixUsername: string }, project: { id: string; name: string }, from: string, to: string,
): Promise<void> {
  try {
    const userId = user.id;
    await prisma.agentSpawn.updateMany({ where: { userId, childProjectId: project.id, childWorkstream: from }, data: { childWorkstream: to } });
    await prisma.agentSpawn.updateMany({ where: { userId, parentProjectId: project.id, parentWorkstream: from }, data: { parentWorkstream: to } });
    await prisma.agentSpawn.updateMany({ where: { userId, fosterProjectId: project.id, fosterWorkstream: from }, data: { fosterWorkstream: to } });
    await reparentSessions(userId, user.unixUsername, project.id, project.name, to);
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { spawnOrphanHome: true } });
    const home = parseOrphanHome(u?.spawnOrphanHome);
    if (home && home.projectId === project.id && home.workstream === from) {
      await prisma.user.update({ where: { id: userId }, data: { spawnOrphanHome: { projectId: project.id, workstream: to } } });
    }
  } catch (err) {
    console.warn(`[SPAWN] could not carry the rename ${project.name}/${from} → ${to} into agent_spawns:`, (err as Error).message);
  }
}

export async function renameSpawnProject(user: { id: string; unixUsername: string }, projectId: string, newName: string): Promise<void> {
  try {
    await prisma.agentSpawn.updateMany({ where: { userId: user.id, childProjectId: projectId }, data: { childProjectName: newName } });
    await reparentSessions(user.id, user.unixUsername, projectId, newName);
  } catch (err) {
    console.warn(`[SPAWN] could not carry the project rename to ${newName} into agent_spawns:`, (err as Error).message);
  }
}
