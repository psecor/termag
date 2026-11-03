// The box a session runs on, in words (simpleChat.boxLabel), for the
// tooltips that tell same-named sessions on different boxes apart.
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { boxFeed } from '../services/boxFeed';
import type { InboxRow } from '../mobile/inbox';
import { boxLabel } from './simpleChat';

export function useBoxOf(): (row: Pick<InboxRow, 'instanceId' | 'shared' | 'owner'>) => string | null {
  const boxes = useSyncExternalStore(boxFeed.subscribe, boxFeed.getSnapshot);
  const nameOf = useMemo(() => new Map(boxes.map(b => [b.id, b.name])), [boxes]);
  return useCallback(r => boxLabel(r, r.instanceId ? nameOf.get(r.instanceId) : null), [nameOf]);
}
