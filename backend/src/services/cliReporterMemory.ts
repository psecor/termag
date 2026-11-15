/**
 * In-memory ResolveReporter and names for the route tests of bug reports and
 * feedback: the same rules as services/cliReporterPrisma.ts, over maps.
 */
import { threadIdOf, type Reporter, type ResolveReporter } from './cliReporter';

export interface MemoryReporterWorld {
  /** Projects as `id → { owner, box, name }`; threads as `id → owner`. */
  projects: Map<string, { userId: string; instanceId: string | null; name: string }>;
  threads: Map<string, string>;
  users: Map<string, string>;
  boxes: Map<string, string>;
}

export function memoryReporterWorld(): MemoryReporterWorld {
  return { projects: new Map(), threads: new Map(), users: new Map(), boxes: new Map() };
}

export function memoryResolveReporter(w: MemoryReporterWorld): ResolveReporter {
  return async (base, claimed): Promise<Reporter> => {
    const p = claimed.projectId ? w.projects.get(claimed.projectId) : undefined;
    const ok = p && p.userId === base.reporterUserId && (!base.boxId || p.instanceId === base.boxId);
    const thread = ok ? threadIdOf(claimed.workstream) : null;
    return {
      ...base,
      boxId: base.boxId ?? (ok ? p!.instanceId : null),
      projectId: ok ? claimed.projectId : null,
      workstream: ok ? claimed.workstream : null,
      threadId: thread && w.threads.get(thread) === base.reporterUserId ? thread : null,
      boxAgentCommit: null,
      boxAgentCapabilities: [],
    };
  };
}

export function memoryNames(w: MemoryReporterWorld) {
  return async ({ users, boxes, projects }: { users: string[]; boxes: string[]; projects: string[] }) => {
    const pick = <V>(ids: string[], map: Map<string, V>, f: (v: V) => string) =>
      Object.fromEntries(ids.flatMap(id => map.has(id) ? [[id, f(map.get(id)!)]] : [])) as Record<string, string>;
    return { users: pick(users, w.users, v => v), boxes: pick(boxes, w.boxes, v => v), projects: pick(projects, w.projects, v => v.name) };
  };
}
