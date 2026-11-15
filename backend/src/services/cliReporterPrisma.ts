/**
 * The Prisma ResolveReporter (services/cliReporter.ts): the claimed project
 * only when it is the reporter's, and for a box token on that box; the box
 * from the project for a sign-in; the ask thread when it is the reporter's;
 * and what the orchestrator knows of the box's agent right now. Shared by bug
 * reports and feedback.
 */
import { prisma } from '../db';
import { getInstanceAgent } from './agentRegistry';
import { threadIdOf, type ResolveReporter } from './cliReporter';

export const resolveCliReporter: ResolveReporter = async (base, claimed) => {
  let boxId = base.boxId;
  let projectId: string | null = null;
  let workstream: string | null = null;
  let threadId: string | null = null;
  if (claimed.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: claimed.projectId, userId: base.reporterUserId },
      select: { id: true, instanceId: true },
    });
    // A box credential speaks only for its own box's projects.
    if (project && (!base.boxId || project.instanceId === base.boxId)) {
      projectId = project.id;
      boxId = boxId ?? project.instanceId;
      workstream = claimed.workstream;
      const thread = threadIdOf(claimed.workstream);
      if (thread) {
        const t = await prisma.agentThread.findFirst({ where: { id: thread, originUserId: base.reporterUserId }, select: { id: true } });
        threadId = t?.id ?? null;
      }
    }
  }
  const agent = boxId ? getInstanceAgent(boxId) : null;
  return {
    ...base, boxId, projectId, workstream, threadId,
    boxAgentCommit: agent?.agentCommit ?? null,
    boxAgentCapabilities: agent ? [...agent.capabilities].sort() : [],
  };
};

/** Emails, box names and project names for the ids, for the admin pages. */
export async function reporterNames({ users, boxes, projects }: { users: string[]; boxes: string[]; projects: string[] }) {
  const [u, b, p] = await Promise.all([
    users.length ? prisma.user.findMany({ where: { id: { in: users } }, select: { id: true, googleEmail: true } }) : [],
    boxes.length ? prisma.instance.findMany({ where: { id: { in: boxes } }, select: { id: true, name: true } }) : [],
    projects.length ? prisma.project.findMany({ where: { id: { in: projects } }, select: { id: true, name: true } }) : [],
  ]);
  return {
    users: Object.fromEntries(u.map(x => [x.id, x.googleEmail])) as Record<string, string>,
    boxes: Object.fromEntries(b.map(x => [x.id, x.name])) as Record<string, string>,
    projects: Object.fromEntries(p.map(x => [x.id, x.name])) as Record<string, string>,
  };
}
