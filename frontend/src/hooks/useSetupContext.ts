import { useEffect, useSyncExternalStore } from 'react';
import { boxFeed } from '../services/boxFeed';
import type { Project } from '../types';
import { setupContext, type SetupContext } from '../utils/cloneTile';

/** setupContext over the shared box feed, which MainLayout keeps running. */
export function useSetupContext(project: Pick<Project, 'instanceId' | 'repoUrl' | 'role'> | null | undefined): SetupContext {
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const loaded = useSyncExternalStore(boxFeed.subscribe, boxFeed.hasLoaded);
  const id = project?.instanceId ?? null;
  const missing = !!id && loaded && !boxes.some(b => b.id === id);
  useEffect(() => {
    if (missing && id) boxFeed.lookFor(id);
  }, [missing, id]);
  return project ? setupContext(project, boxes, !!id && boxFeed.isGone(id)) : {};
}
