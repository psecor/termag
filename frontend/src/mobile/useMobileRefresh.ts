// What "refresh" means on the phone client: reopen the
// status socket and probe the backend (retryConnection, the same as the
// offline banner's Retry), re-read the project list, and whatever the screen
// adds (the PR list, a capture). Every part is attempted; none blocks another.
import { useCallback } from 'react';
import { retryConnection } from '../contexts/ConnectionContext';
import { useProjects } from '../contexts/ProjectContext';

export function useMobileRefresh(extra?: () => unknown): () => Promise<void> {
  const { reloadProjects } = useProjects();
  return useCallback(async () => {
    await Promise.allSettled([retryConnection(), reloadProjects(), Promise.resolve().then(() => extra?.())]);
  }, [reloadProjects, extra]);
}

/** "Reload app": a standalone window has no browser reload. */
export function reloadApp(): void {
  window.location.reload();
}
