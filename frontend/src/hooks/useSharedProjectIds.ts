// Which of the caller's own projects are shared with someone, for the
// "● Sharing" button on their rows in the Projects list: one GET
// /api/projects/:id/shares per owned project.
//
// It loads again only when the set of owned projects changes, not on every
// new project list. ProjectContext replaces the list on each reload, every
// 2 s while a clone is in flight, and keying this on the list sent every
// owned project's /shares on each one: 5 requests a second from one tab
// with 11 projects (server traces, 2026-11-03).
//
// A failed read keeps what was known about that project and is tried again
// on its own, after RETRY_FIRST_MS and then twice as long each time, up to
// RETRY_MAX_MS. With box sharing off, the badge is what shows the Share
// menu item, and so the way to revoke.
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { sharingApi } from '../services/api';

export const RETRY_FIRST_MS = 5_000;
export const RETRY_MAX_MS = 60_000;

interface OwnedProject {
  id: string;
  role?: 'owner' | 'collaborator';
}

/** The owned projects' ids, sorted, as one string: the same set gives the same key. */
export function ownedProjectsKey(projects: readonly OwnedProject[]): string {
  return projects.filter(p => p.role !== 'collaborator').map(p => p.id).sort().join('\n');
}

export function useSharedProjectIds(
  projects: readonly OwnedProject[],
  userId: string | null,
): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
  const [shared, setShared] = useState<Set<string>>(() => new Set());
  const key = ownedProjectsKey(projects);

  useEffect(() => {
    if (!userId) return;
    const owned = new Set(key ? key.split('\n') : []);
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const load = (ids: string[], nextDelay: number) => {
      Promise.all(ids.map(id => sharingApi.listShares(id).then(
        data => ({ id, shared: Array.isArray(data) && data.length > 0 }),
        () => ({ id, shared: null }),
      ))).then(results => {
        if (!current) return;
        setShared(prev => {
          const next = new Set([...prev].filter(id => owned.has(id)));
          for (const r of results) {
            if (r.shared === true) next.add(r.id);
            else if (r.shared === false) next.delete(r.id);
          }
          return next;
        });
        const failed = results.filter(r => r.shared === null).map(r => r.id);
        if (failed.length > 0) {
          retry = setTimeout(() => load(failed, Math.min(nextDelay * 2, RETRY_MAX_MS)), nextDelay);
        }
      });
    };

    load([...owned], RETRY_FIRST_MS);
    return () => { current = false; clearTimeout(retry); };
  }, [key, userId]);

  return [shared, setShared];
}
