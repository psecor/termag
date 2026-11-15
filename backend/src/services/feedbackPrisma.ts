/**
 * The Prisma FeedbackStore (services/feedback.ts). The
 * reporter and names come from the code bug reports use (cliReporterPrisma.ts).
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../db';
import { reporterNames, resolveCliReporter } from './cliReporterPrisma';
import type { FeedbackFilter, FeedbackRow, FeedbackStore } from './feedback';

type Row = Prisma.FeedbackGetPayload<Record<string, never>>;

function view(r: Row): FeedbackRow {
  return {
    ...r,
    credential: r.credential === 'box' ? 'box' : 'device',
    kind: r.kind as FeedbackRow['kind'],
    status: r.status as FeedbackRow['status'],
  };
}

function where(f: Omit<FeedbackFilter, 'limit'>): Prisma.FeedbackWhereInput {
  const and: Prisma.FeedbackWhereInput[] = [];
  if (f.statuses) and.push({ status: { in: f.statuses } });
  if (f.kinds) and.push({ kind: { in: f.kinds } });
  if (f.search) and.push({ OR: [{ id: f.search }, { body: { contains: f.search, mode: 'insensitive' } }] });
  return and.length ? { AND: and } : {};
}

export const prismaFeedback: FeedbackStore = {
  async countRecent({ boxId, userId }, since) {
    return prisma.feedback.count({
      where: boxId ? { boxId, createdAt: { gte: since } } : { reporterUserId: userId, boxId: null, createdAt: { gte: since } },
    });
  },

  resolveReporter: resolveCliReporter,

  async create(input, reporter) {
    const { projectId: _p, workstream: _w, ...fields } = input;
    return view(await prisma.feedback.create({ data: { ...fields, ...reporter } }));
  },

  async list(filter) {
    return (await prisma.feedback.findMany({ where: where(filter), orderBy: { createdAt: 'desc' }, take: filter.limit })).map(view);
  },

  async get(id) {
    const r = await prisma.feedback.findUnique({ where: { id } });
    return r ? view(r) : null;
  },

  async setStatus(id, status, actorId, at) {
    const seen = status === 'seen';
    return view(await prisma.feedback.update({
      where: { id },
      data: { status, seenAt: seen ? at : null, seenById: seen ? actorId : null },
    }));
  },

  async countsByStatus() {
    const rows = await prisma.feedback.groupBy({ by: ['status'], _count: { _all: true } });
    return Object.fromEntries(rows.map(r => [r.status, r._count._all]));
  },

  names: reporterNames,
};
