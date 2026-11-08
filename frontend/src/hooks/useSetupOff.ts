import { useCallback, useSyncExternalStore } from 'react';
import { boxFeed } from '../services/boxFeed';
import { isSetupOff } from '../utils/boxSetup';

/**
 * Whether the box with this id has termag setup off, from
 * the box feed. False until the feed has the box, or where nothing runs the
 * feed (the phone client): the server's setup_disabled refusal then says why.
 */
export function useSetupOff(instanceId: string | null | undefined): boolean {
  const read = useCallback(
    () => !!instanceId && isSetupOff(boxFeed.getSnapshot().find(b => b.id === instanceId)),
    [instanceId],
  );
  return useSyncExternalStore(boxFeed.subscribe, read);
}
