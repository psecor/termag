/**
 * Whether a project's main workstream was ever used, from the working time
 * banked for it (WorkTimeEntry): an agent's turns or a person typing in its
 * panes. The simple UI folds away the unused main of a project that has ask
 * threads (frontend/src/chat/simpleChat.ts askPlaceholderProjects); this is
 * the "no turns" half of that, beside the transcript and the session title.
 *
 * WorkTimeEntry.project is the name parsed from the tmux session, so main's
 * time is banked under the project's own name, and another workstream's under
 * `<project>-<workstream>` (services/worktimeProjects.ts): only an exact match
 * is main's. The username is the session's too, so agent time carries the
 * tmux-safe form (`.` and `:` folded to `_`, services/tmux.ts tmuxSafeName),
 * and human time the raw one: both count.
 */
import { prisma } from '../db';
import { workTimeInstanceId } from './worktimeProjects';

export interface MainRef {
  /** The project owner's unix user, whose sessions bank the time. */
  username: string;
  project: string;
  instanceId: string | null;
}

/** A unix username as a tmux session name carries it. */
const tmuxFolded = (username: string) => username.replace(/[.:]/g, '_');

/** Keyed by the folded username, so the raw and the tmux-safe rows of one person meet. */
export function mainUseKey(ref: MainRef): string {
  return `${tmuxFolded(ref.username)}\0${ref.project}\0${workTimeInstanceId(ref.instanceId)}`;
}

/** The keys (mainUseKey) of the mains that have any working time, read in one query. */
export async function usedMains(refs: readonly MainRef[]): Promise<Set<string>> {
  if (!refs.length) return new Set();
  const rows = await prisma.workTimeEntry.groupBy({
    by: ['username', 'project', 'instanceId'],
    where: {
      project: { in: [...new Set(refs.map(r => r.project))] },
      username: { in: [...new Set(refs.flatMap(r => [r.username, tmuxFolded(r.username)]))] },
      totalMs: { gt: 0 },
    },
  });
  const wanted = new Set(refs.map(mainUseKey));
  return new Set(rows.map(r => mainUseKey(r)).filter(k => wanted.has(k)));
}
