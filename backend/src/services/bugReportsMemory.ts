/**
 * An in-memory BugReportStore for the route tests (routes/cliBugReports.test.ts,
 * routes/admin/bugs.test.ts). Filters the way bugReportsPrisma.ts asks
 * Postgres to: case-insensitive substring search, newest first.
 */
import type { BugFilter, BugReportEventRow, BugReportRow, BugReportStore, Reporter } from './bugReports';

export interface MemoryBugReports extends BugReportStore {
  rows: BugReportRow[];
  eventRows: BugReportEventRow[];
  /** Projects as `id → { owner, box, name }`; threads as `id → owner`. */
  projects: Map<string, { userId: string; instanceId: string | null; name: string }>;
  threads: Map<string, string>;
  users: Map<string, string>;
  boxes: Map<string, string>;
}

export function memoryBugReports(now: () => Date = () => new Date()): MemoryBugReports {
  let seq = 0;
  const m: MemoryBugReports = {
    rows: [], eventRows: [], projects: new Map(), threads: new Map(), users: new Map(), boxes: new Map(),

    async countRecent({ boxId, userId }, since) {
      return m.rows.filter(r => r.createdAt >= since && (boxId ? r.boxId === boxId : r.reporterUserId === userId && r.boxId === null)).length;
    },

    async resolveReporter(base, claimed): Promise<Reporter> {
      const p = claimed.projectId ? m.projects.get(claimed.projectId) : undefined;
      const ok = p && p.userId === base.reporterUserId && (!base.boxId || p.instanceId === base.boxId);
      const thread = ok ? claimed.workstream?.match(/^ask-([A-Za-z0-9]{8,40})$/)?.[1] : undefined;
      return {
        ...base,
        boxId: base.boxId ?? (ok ? p!.instanceId : null),
        projectId: ok ? claimed.projectId : null,
        workstream: ok ? claimed.workstream : null,
        threadId: thread && m.threads.get(thread) === base.reporterUserId ? thread : null,
        boxAgentCommit: null,
        boxAgentCapabilities: [],
      };
    },

    async create(input, reporter) {
      const { projectId: _p, workstream: _w, ...fields } = input;
      const row: BugReportRow = {
        ...fields, ...reporter, id: `bug${++seq}`, status: 'new', duplicateOfId: null, linkUrl: null, triagedAt: null,
        createdAt: new Date(now().getTime() + seq),
      };
      m.rows.push(row);
      return row;
    },

    async list(f: BugFilter) {
      const q = f.search?.toLowerCase();
      return m.rows
        .filter(r => (!f.statuses || f.statuses.includes(r.status))
          && (!f.areas || f.areas.includes(r.area))
          && (!f.severities || f.severities.includes(r.severity))
          && (!q || r.id === f.search || [r.title, r.body, r.command ?? '', r.errorOutput ?? ''].some(t => t.toLowerCase().includes(q))))
        .sort((a, b) => Number(b.status === 'new') - Number(a.status === 'new') || b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, f.limit);
    },

    async get(id) { return m.rows.find(r => r.id === id) ?? null; },
    async events(id) { return m.eventRows.filter(e => e.reportId === id); },
    async duplicatesOf(id) { return m.rows.filter(r => r.duplicateOfId === id); },

    async triage(id, change, actorId, at) {
      const r = m.rows.find(x => x.id === id)!;
      r.triagedAt = at;
      if (change.status !== undefined) r.status = change.status;
      if (change.duplicateOfId !== undefined) r.duplicateOfId = change.duplicateOfId;
      if (change.linkUrl !== undefined) r.linkUrl = change.linkUrl;
      m.eventRows.push({
        id: `ev${++seq}`, reportId: id, actorId, createdAt: at, status: change.status ?? null, duplicateOfId: change.duplicateOfId ?? null,
        linkUrl: change.linkUrl === undefined ? null : (change.linkUrl ?? ''), note: change.note ?? null,
      });
      if (change.duplicateOfId) {
        for (const d of m.rows.filter(x => x.duplicateOfId === id)) {
          d.duplicateOfId = change.duplicateOfId;
          d.triagedAt = at;
          m.eventRows.push({
            id: `ev${++seq}`, reportId: d.id, actorId, createdAt: at, status: 'duplicate', duplicateOfId: change.duplicateOfId,
            linkUrl: null, note: `Moved with ${id}, now a duplicate of ${change.duplicateOfId}`,
          });
        }
      }
      return r;
    },

    async countsByStatus() {
      const out: Record<string, number> = {};
      for (const r of m.rows) out[r.status] = (out[r.status] ?? 0) + 1;
      return out;
    },

    async names({ users, boxes, projects }) {
      const pick = <V>(ids: string[], map: Map<string, V>, f: (v: V) => string) =>
        Object.fromEntries(ids.flatMap(id => map.has(id) ? [[id, f(map.get(id)!)]] : []));
      return { users: pick(users, m.users, v => v), boxes: pick(boxes, m.boxes, v => v), projects: pick(projects, m.projects, v => v.name) };
    },
  };
  return m;
}
