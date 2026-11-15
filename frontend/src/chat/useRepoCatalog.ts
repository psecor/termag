// The person's GitHub repositories, flat, for New session's project menu:
// its "From owner/repo" rows and the repositories step of + New project and Add a repository. Read once while
// `active` (the menu has been opened), and again on retry().
import { useCallback, useEffect, useRef, useState } from 'react';
import { githubReposApi } from '../services/api';
import { catalogFromWire } from '../utils/repoPick';

export interface CatalogEntry { fullName: string; defaultBranch: string }

export type RepoCatalogState =
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'ready'; repos: CatalogEntry[] };

export function useRepoCatalog(active: boolean): RepoCatalogState & { retry: () => void } {
  const [state, setState] = useState<RepoCatalogState>({ kind: 'loading' });
  const [tries, setTries] = useState(0);
  const asked = useRef(-1);
  // Only an unmount drops an answer: the menu closing mid-read must not, or the read would never be made again.
  // Set again on every mount: Strict Mode unmounts and remounts once, and the read made first must still land.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!active || asked.current === tries) return;
    asked.current = tries;
    const tryNo = tries;
    githubReposApi.list(tryNo > 0)
      .then(body => {
        if (!mounted.current) return;
        const catalog = catalogFromWire(body);
        if (!catalog.ok) { setState({ kind: 'failed' }); return; }
        setState({ kind: 'ready', repos: catalog.groups.flatMap(g => g.repos.map(r => ({ fullName: r.fullName, defaultBranch: r.defaultBranch }))) });
      })
      .catch(() => { if (mounted.current) setState({ kind: 'failed' }); });
  }, [active, tries]);
  const retry = useCallback(() => { setState({ kind: 'loading' }); setTries(n => n + 1); }, []);
  return { ...state, retry };
}
