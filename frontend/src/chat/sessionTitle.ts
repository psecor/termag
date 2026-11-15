// One title per session:
// the sidebar row, the header, the phone
// layout's header, ⌘K, the browser tab and the browser's own notification all
// call sessionTitle, and no surface appends " · <workstream>" to it. The
// server's push titles take the same order (backend services/sessionTitle.ts).
import type { Project, Workstream } from '../types';

export interface TitledSession {
  projectName: string;
  /** The workstream's name: `main`, a branch-off's, or an ask's `ask-<thread id>`. */
  workstream: string;
  /** The stored title (Workstream.sessionTitle), whoever set it. */
  sessionTitle?: string | null;
  /** Who set it: `person` (a rename) or `claude`; absent or null from before the source was kept, which was Claude's. */
  sessionTitleSource?: string | null;
  /** An ask thread's chat: the thread's own title. */
  askTitle?: string | null;
  /** An ask thread's chat: the thread's id. Set, Claude's title never names it (#743). */
  askThreadId?: string | null;
}

/**
 * A session's title, by the first that holds: a person's rename; an ask
 * thread's own title; Claude's title; else the project's name for `main` and
 * the workstream's name for any other session. An ask's chat skips Claude's
 * title: callers name their threads (#743), so an untitled one is called by
 * its thread id (`ask-<thread id>`), never by anything derived.
 */
export function sessionTitle(s: TitledSession): string {
  const own = s.sessionTitle?.trim() || null;
  if (own && s.sessionTitleSource === 'person') return own;
  const ask = s.askTitle?.trim() || null;
  if (ask) return ask;
  if (s.askThreadId) return s.workstream;
  if (own) return own;
  return s.workstream === 'main' ? s.projectName : s.workstream;
}

/** The title of a project's workstream, from the project list's rows. */
export function workstreamTitle(project: Pick<Project, 'name'>, workstream: string, ws: Pick<Workstream, 'sessionTitle' | 'sessionTitleSource' | 'askThread'> | null | undefined): string {
  return sessionTitle({
    projectName: project.name, workstream,
    sessionTitle: ws?.sessionTitle, sessionTitleSource: ws?.sessionTitleSource,
    askTitle: ws?.askThread?.title, askThreadId: ws?.askThread?.id,
  });
}

/**
 * The branch the header shows as a chip: the session's recorded branch
 * (Workstream.branch) when it isn't the repository's default, which is the
 * branch the project's `main` checks out. Null for `main`, and for a session
 * on the default branch, so the common case stays quiet.
 */
export function branchChip(project: Pick<Project, 'workstreams'>, workstream: string): string | null {
  if (workstream === 'main') return null;
  const own = project.workstreams?.find(w => w.name === workstream)?.branch?.trim();
  if (!own) return null;
  const base = project.workstreams?.find(w => w.name === 'main')?.branch?.trim();
  return own === base ? null : own;
}
