import { useEffect, useRef } from 'react';
import { useProjects } from '../contexts/ProjectContext';
import { useAuth } from '../contexts/AuthContext';
import { useConnection } from '../contexts/ConnectionContext';
import { faviconHref, faviconState } from '../utils/favicon';

export function useStatusFavicon(): void {
  const { projects, statusMap } = useProjects();
  const { user } = useAuth();
  const { state: connectionState } = useConnection();
  const href = faviconHref(faviconState({
    projects,
    statusMap,
    username: user?.unixUsername ?? '',
    offline: connectionState === 'offline',
  }));

  const originalHref = useRef<string | null>(null);

  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    if (originalHref.current === null) originalHref.current = link.getAttribute('href');
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }, [href]);

  useEffect(() => () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link && originalHref.current !== null) link.setAttribute('href', originalHref.current);
  }, []);
}
