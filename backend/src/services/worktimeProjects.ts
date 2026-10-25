/**
 * Per-project view over WorkTimeEntry rows.
 *
 * WorkTimeEntry.project is the project NAME as parsed from the tmux session by
 * status.ts (`^(.+?)-(.+)-agent$`), which folds a non-main workstream into the
 * name: the session `psecor-termag-feature-agent` banks time under project
 * `termag-feature`. Both project and workstream names may contain dashes, so
 * splitting is ambiguous; instead we resolve against the user's real project
 * names — exact match first, else the LONGEST project name that prefixes the
 * field (`ic-sample-app-small-fixes` → `ic-sample-app` / `small-fixes`, not
 * `ic` / `sample-app-small-fixes`). Same reconstruct-don't-parse stance as
 * sessionResolver.matchSession.
 */

/**
 * The project value a Claude Code cloud session's working time is banked
 * under. A runner session matches no
 * project, so status.ts banks it here. The colon keeps it out of every real
 * project's way: project names are `[A-Za-z0-9_-]+` (routes/projects.ts),
 * and the resolver below answers for it before any prefix match.
 */
export const CLOUD_WORKTIME_PROJECT = 'claude:cloud';
/** What that value reads as in a per-project view. */
export const CLOUD_WORKTIME_LABEL = 'Claude Cloud';

export interface WorktimeEntryLike {
  project: string;
  provider: string;
  date: string;
  totalMs: number;
  sessions: number;
  /** Absent or "" is a legacy row, or the orchestrator. */
  instanceId?: string | null;
}

export function workTimeInstanceId(instanceId: string | null | undefined): string {
  return instanceId ? instanceId : '';
}

export function workTimeIdentity(
  username: string,
  project: string,
  provider: string,
  date: string,
  instanceId: string | null | undefined,
): { username: string; project: string; provider: string; date: string; instanceId: string } {
  return { username, project, provider, date, instanceId: workTimeInstanceId(instanceId) };
}

export interface WorktimeProjectRow {
  /** null when the name resolves to no current project (renamed / archived). */
  projectId: string | null;
  projectName: string;
  workstream: string;
  provider: string;
  /** 'YYYY-MM-DD', server-local — same convention as GET /api/worktime. */
  date: string;
  totalMs: number;
  sessions: number;
}

export function resolveWorktimeProject(
  field: string,
  names: readonly string[],
): { projectName: string; workstream: string } | null {
  if (field === CLOUD_WORKTIME_PROJECT) return { projectName: CLOUD_WORKTIME_LABEL, workstream: 'main' };
  if (names.includes(field)) return { projectName: field, workstream: 'main' };
  let best: string | null = null;
  for (const n of names) {
    if (field.startsWith(n + '-') && (best === null || n.length > best.length)) best = n;
  }
  if (best === null) return null;
  return { projectName: best, workstream: field.slice(best.length + 1) };
}

function projectIdForEntry(
  projectName: string,
  instanceId: string | null | undefined,
  projects: readonly { id: string; name: string; instanceId?: string | null }[],
): string | null {
  const sameName = projects.filter(p => p.name === projectName);
  if (sameName.length === 0) return null;
  const key = workTimeInstanceId(instanceId);
  if (key !== '') return sameName.find(p => p.instanceId === key)?.id ?? null;
  if (sameName.length === 1 && sameName[0].instanceId === undefined) return sameName[0].id;
  const orchestrator = sameName.filter(p => p.instanceId == null);
  if (orchestrator.length === 1 && sameName.every(p => p.instanceId !== undefined)) return orchestrator[0].id;
  if (sameName.length === 1) return sameName[0].id;
  return null;
}

export function toWorktimeProjectRows(
  entries: readonly WorktimeEntryLike[],
  projects: readonly { id: string; name: string; instanceId?: string | null }[],
): WorktimeProjectRow[] {
  const names = projects.map(p => p.name);
  return entries.map(e => {
    const r = resolveWorktimeProject(e.project, names);
    return {
      projectId: r ? projectIdForEntry(r.projectName, e.instanceId, projects) : null,
      projectName: r ? r.projectName : e.project,
      workstream: r ? r.workstream : 'main',
      provider: e.provider,
      date: e.date,
      totalMs: e.totalMs,
      sessions: e.sessions,
    };
  });
}
