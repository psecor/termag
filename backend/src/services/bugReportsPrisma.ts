/**
 * The Prisma BugReportStore (services/bugReports.ts).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { getInstanceAgent } from './agentRegistry';
import { threadIdOf, type BugFilter, type BugReportEventRow, type BugReportRow, type BugReportStore, type BugStatus } from './bugReports';

type Row = Prisma.BugReportGetPayload<Record<string, never>>;

function view(r: Row): BugReportRow {
  return {
    ...r,
    credential: r.credential === 'box' ? 'box' : 'device',
    severity: r.severity as BugReportRow['severity'],
    area: r.area as BugReportRow['area'],
    status: r.status as BugStatus,
  };
}

function where(f: Omit<BugFilter, 'limit'>): Prisma.BugReportWhereInput {
  const and: Prisma.BugReportWhereInput[] = [];
  if (f.statuses) and.push({ status: { in: f.statuses } });
  if (f.areas) and.push({ area: { in: f.areas } });
  if (f.severities) and.push({ severity: { in: f.severities } });
  if (f.search) {
    const contains = { contains: f.search, mode: 'insensitive' as const };
    and.push({ OR: [{ id: f.search }, { title: contains }, { body: contains }, { command: contains }, { errorOutput: contains }] });
  }
  return and.length ? { AND: and } : {};
}

export const prismaBugReports: BugReportStore = {
  async countRecent({ boxId, userId }, since) {
    return prisma.bugReport.count({
      where: boxId ? { boxId, createdAt: { gte: since } } : { reporterUserId: userId, boxId: null, createdAt: { gte: since } },
    });
  },

  async resolveReporter(base, claimed) {
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
  },

  async create(input, reporter) {
    const { projectId: _p, workstream: _w, ...fields } = input;
    return view(await prisma.bugReport.create({ data: { ...fields, ...reporter } }));
  },

  async list(filter) {
    // New first, then the rest, and the cap after that order: cut by date
    // alone, older new reports fell off a long list while the badge counted them.
    const base = where(filter);
    const fresh = await prisma.bugReport.findMany({ where: { AND: [base, { status: 'new' }] }, orderBy: { createdAt: 'desc' }, take: filter.limit });
    const rest = fresh.length < filter.limit
      ? await prisma.bugReport.findMany({ where: { AND: [base, { status: { not: 'new' } }] }, orderBy: { createdAt: 'desc' }, take: filter.limit - fresh.length })
      : [];
    return [...fresh, ...rest].map(view);
  },

  async get(id) {
    const r = await prisma.bugReport.findUnique({ where: { id } });
    return r ? view(r) : null;
  },

  async events(id) {
    return prisma.bugReportEvent.findMany({ where: { reportId: id }, orderBy: { createdAt: 'asc' } }) as Promise<BugReportEventRow[]>;
  },

  async duplicatesOf(id) {
    return (await prisma.bugReport.findMany({ where: { duplicateOfId: id }, orderBy: { createdAt: 'desc' } })).map(view);
  },

  async triage(id, change, actorId, at) {
    return prisma.$transaction(async tx => {
      const data: Prisma.BugReportUpdateInput = { triagedAt: at };
      if (change.status !== undefined) data.status = change.status;
      if (change.duplicateOfId !== undefined) data.duplicateOfId = change.duplicateOfId;
      if (change.linkUrl !== undefined) data.linkUrl = change.linkUrl;
      const updated = await tx.bugReport.update({ where: { id }, data });
      if (change.duplicateOfId) {
        // This report's own duplicates move to its new original, so none chain.
        const moved = await tx.bugReport.findMany({ where: { duplicateOfId: id }, select: { id: true } });
        if (moved.length) {
          await tx.bugReport.updateMany({ where: { duplicateOfId: id }, data: { duplicateOfId: change.duplicateOfId, triagedAt: at } });
          await tx.bugReportEvent.createMany({
            data: moved.map(r => ({
              reportId: r.id, actorId, createdAt: at, status: 'duplicate', duplicateOfId: change.duplicateOfId!,
              linkUrl: null, note: `Moved with ${id}, now a duplicate of ${change.duplicateOfId}`,
            })),
          });
        }
      }
      await tx.bugReportEvent.create({
        data: {
          reportId: id, actorId, createdAt: at,
          status: change.status ?? null,
          duplicateOfId: change.duplicateOfId ?? null,
          linkUrl: change.linkUrl === undefined ? null : (change.linkUrl ?? ''),
          note: change.note ?? null,
        },
      });
      return view(updated);
    });
  },

  async countsByStatus() {
    const rows = await prisma.bugReport.groupBy({ by: ['status'], _count: { _all: true } });
    return Object.fromEntries(rows.map(r => [r.status, r._count._all]));
  },

  async names({ users, boxes, projects }) {
    const [u, b, p] = await Promise.all([
      users.length ? prisma.user.findMany({ where: { id: { in: users } }, select: { id: true, googleEmail: true } }) : [],
      boxes.length ? prisma.instance.findMany({ where: { id: { in: boxes } }, select: { id: true, name: true } }) : [],
      projects.length ? prisma.project.findMany({ where: { id: { in: projects } }, select: { id: true, name: true } }) : [],
    ]);
    return {
      users: Object.fromEntries(u.map(x => [x.id, x.googleEmail])),
      boxes: Object.fromEntries(b.map(x => [x.id, x.name])),
      projects: Object.fromEntries(p.map(x => [x.id, x.name])),
    };
  },
};
