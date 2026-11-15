// The person's projects for New session's project pill:
// GET /api/user-projects, read while `active` (user-projects-enabled) and again on reload()
// (a Send told the project was archived meanwhile). A failed read leaves New session on the
// repository picker, which still works: the server attaches the checkout to a project itself.
import { useCallback, useEffect, useRef, useState } from 'react';
import { userProjectsApi, type UserProjectView } from '../services/api';
import type { ProjectsState } from '../pages/chat/ProjectPicker';

export function useUserProjectList(active: boolean): ProjectsState & { reload: () => void; upsert: (project: UserProjectView) => void } {
  const [state, setState] = useState<ProjectsState>({ kind: 'loading' });
  const [reads, setReads] = useState(0);
  const request = useRef(0);
  useEffect(() => {
    if (!active) return;
    const id = ++request.current;
    userProjectsApi.list()
      .then(projects => { if (request.current === id) setState({ kind: 'ready', projects }); })
      .catch(() => { if (request.current === id) setState({ kind: 'failed' }); });
  }, [active, reads]);
  // A retry after a failure shows Loading again; a refresh of a list already read keeps it on screen meanwhile.
  const reload = useCallback(() => {
    setState(s => (s.kind === 'failed' ? { kind: 'loading' } : s));
    setReads(n => n + 1);
  }, []);
  // A project just made (or unarchived) here goes first at once, as the most recently active, without waiting on a read.
  const upsert = useCallback((project: UserProjectView) => {
    request.current++;
    setState(s => ({ kind: 'ready', projects: [project, ...(s.kind === 'ready' ? s.projects.filter(p => p.id !== project.id) : [])] }));
  }, []);
  return { ...state, reload, upsert };
}
