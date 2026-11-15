/**
 * An in-memory FeedbackStore for the route tests (routes/cliFeedback.test.ts,
 * routes/admin/feedback.test.ts). Filters the way feedbackPrisma.ts asks
 * Postgres to: case-insensitive substring search, newest first.
 */
import { memoryNames, memoryReporterWorld, memoryResolveReporter, type MemoryReporterWorld } from './cliReporterMemory';
import type { FeedbackFilter, FeedbackRow, FeedbackStore } from './feedback';

export interface MemoryFeedback extends FeedbackStore, MemoryReporterWorld {
  rows: FeedbackRow[];
}

export function memoryFeedback(now: () => Date = () => new Date()): MemoryFeedback {
  let seq = 0;
  const world = memoryReporterWorld();
  const m: MemoryFeedback = {
    rows: [], ...world,
    resolveReporter: memoryResolveReporter(world),
    names: memoryNames(world),

    async countRecent({ boxId, userId }, since) {
      return m.rows.filter(r => r.createdAt >= since && (boxId ? r.boxId === boxId : r.reporterUserId === userId && r.boxId === null)).length;
    },

    async create(input, reporter) {
      const { projectId: _p, workstream: _w, ...fields } = input;
      const row: FeedbackRow = { ...fields, ...reporter, id: `fb${++seq}`, status: 'new', seenAt: null, seenById: null, createdAt: new Date(now().getTime() + seq) };
      m.rows.push(row);
      return row;
    },

    async list(f: FeedbackFilter) {
      const q = f.search?.toLowerCase();
      return m.rows
        .filter(r => (!f.statuses || f.statuses.includes(r.status))
          && (!f.kinds || f.kinds.includes(r.kind))
          && (!q || r.id === f.search || r.body.toLowerCase().includes(q)))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, f.limit);
    },

    async get(id) { return m.rows.find(r => r.id === id) ?? null; },

    async setStatus(id, status, actorId, at) {
      const r = m.rows.find(x => x.id === id)!;
      r.status = status;
      r.seenAt = status === 'seen' ? at : null;
      r.seenById = status === 'seen' ? actorId : null;
      return r;
    },

    async countsByStatus() {
      const out: Record<string, number> = {};
      for (const r of m.rows) out[r.status] = (out[r.status] ?? 0) + 1;
      return out;
    },
  };
  return m;
}
