import { useEffect, useRef, useSyncExternalStore } from 'react';
import { instancesApi } from '../services/api';
import { boxFeed } from '../services/boxFeed';
import { boxStatusBus } from '../utils/boxStatusBus';
import { SelectBoxStarter } from '../utils/selectBoxStart';
import { openStartGate, readStoredOpen, storedOpenKey, subscribeStoredOpen } from '../chat/storedOpen';
import type { Project } from '../types';

const selectBoxStarter = new SelectBoxStarter(
  id => instancesApi.start(id),
  () => boxFeed.reload(),
  boxStatusBus,
);

/**
 * Start the open project's box when it is stopped or hibernated
 * (utils/selectBoxStart.ts). Decided once per open of a project and
 * workstream (and box: a project moved onto a parked box while open is a new
 * decision), from a box list fetched since the feed last started, never the
 * copy kept from before a stop: a box can park while the workspace is
 * unmounted. A box that goes down while its project stays open is not
 * started again until someone opens it again. A project whose box is not in
 * the list waits for it rather than spending the open: someone else's box
 * never arrives, so it is never asked. The caller must keep boxFeed running.
 *
 * `showsStored`: the open view shows a chat's stored transcript (the simple
 * UI's SDK chat, chat/storedOpen.ts). The decision then waits for its history:
 * a stored transcript is shown and the box is left parked, and only a chat
 * with nothing stored starts it.
 */
export function useStartParkedBoxOnOpen(
  project: Pick<Project, 'id' | 'instanceId'> | undefined,
  workstream: string,
  showsStored = false,
): void {
  const storedKey = showsStored && project ? storedOpenKey(project.id, workstream) : null;
  const stored = useSyncExternalStore(subscribeStoredOpen, () => (storedKey ? readStoredOpen(storedKey) : null));
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const fresh = useSyncExternalStore(boxFeed.subscribe, boxFeed.isFresh);
  const decided = useRef<string | null>(null);
  const instanceId = project?.instanceId ?? null;
  const openKey = project && instanceId ? `${project.id}|${workstream}|${instanceId}` : null;

  useEffect(() => {
    if (!openKey) { decided.current = null; return; }
    if (!fresh || decided.current === openKey) return;
    const box = boxes.find(b => b.id === instanceId);
    if (!box) return;
    const gate = storedKey ? openStartGate(stored) : 'start';
    if (gate === 'wait') return;
    decided.current = openKey;
    if (gate === 'skip') return;
    void selectBoxStarter.open(box);
  }, [fresh, openKey, boxes, instanceId, storedKey, stored]);
}
