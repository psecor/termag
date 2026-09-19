/**
 * Per-project view over WorkTimeEntry rows.
 *
 * WorkTimeEntry.project is the project NAME as parsed from the tmux session by
 * status.ts (`^(.+?)-(.+)-agent$`), which folds a non-main workstream into the
 * name: the session `psecor-termag-feature-agent` banks time under project
 * `termag-feature`. Both project and workstream names may contain dashes, so
 * splitting is ambiguous; instead we resolve against the user's real project
 * names — exact match first, else the LONGEST project name that prefixes the
 * field (`ic-okr-viewer-small-fixes` → `ic-okr-viewer` / `small-fixes`, not
 * `ic` / `okr-viewer-small-fixes`). Same reconstruct-don't-parse stance as
 * sessionResolver.matchSession.
 */

export interface WorktimeEntryLike {
  project: string;
  provider: string;
  date: string;
  totalMs: number;
  sessions: number;
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
  if (names.includes(field)) return { projectName: field, workstream: 'main' };
  let best: string | null = null;
  for (const n of names) {
    if (field.startsWith(n + '-') && (best === null || n.length > best.length)) best = n;
  }
  if (best === null) return null;
  return { projectName: best, workstream: field.slice(best.length + 1) };
}

export function toWorktimeProjectRows(
  entries: readonly WorktimeEntryLike[],
  projects: readonly { id: string; name: string }[],
): WorktimeProjectRow[] {
  const idByName = new Map(projects.map(p => [p.name, p.id]));
  const names = projects.map(p => p.name);
  return entries.map(e => {
    const r = resolveWorktimeProject(e.project, names);
    return {
      projectId: r ? idByName.get(r.projectName) ?? null : null,
      projectName: r ? r.projectName : e.project,
      workstream: r ? r.workstream : 'main',
      provider: e.provider,
      date: e.date,
      totalMs: e.totalMs,
      sessions: e.sessions,
    };
  });
}
