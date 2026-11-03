// A space's people and boxes, for the full UI's Members &
// boxes tab and the simple UI's Share dialog: one load of both lists, and
// every change through `act`, which reloads them after it and turns a
// failure into `error`. `sharing` is the server's word on
// spaces-sharing-enabled for the caller (GET /members), the same value
// POST /members checks, so the add form and the 403 can't disagree.
import { useCallback, useEffect, useRef, useState } from 'react';
import { spacesApi, type SpaceBoxGrant, type SpaceInvite, type SpaceMember } from '../services/api';
import { errorMessage } from '../services/spaceTransfer';

export interface SpaceMembers {
  loaded: boolean;
  members: SpaceMember[];
  /** Pending invites; the server sends them to owners only. */
  invites: SpaceInvite[];
  boxes: SpaceBoxGrant[];
  /** Whether the caller may add people; null until loaded. */
  sharing: boolean | null;
  error: string;
  note: string;
  setError: (message: string) => void;
  setNote: (message: string) => void;
  reload: () => Promise<void>;
  /**
   * Runs `fn`, then `after` and a reload. A failure becomes `error` (its
   * message, else `fallback`) and nothing after it runs. True when it worked.
   */
  act: (fn: () => Promise<unknown>, fallback: string, after?: () => void) => Promise<boolean>;
}

export function useSpaceMembers(space: string): SpaceMembers {
  const [members, setMembers] = useState<SpaceMember[]>([]);
  const [invites, setInvites] = useState<SpaceInvite[]>([]);
  const [boxes, setBoxes] = useState<SpaceBoxGrant[]>([]);
  const [sharing, setSharing] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  // A reload for a space the dialog has moved off (a rename) must not land.
  const current = useRef(space);
  current.current = space;

  const reload = useCallback(async () => {
    try {
      const [m, b] = await Promise.all([spacesApi.members(space), spacesApi.boxes(space)]);
      if (current.current !== space) return;
      setMembers(m.members);
      setInvites(m.invites);
      setSharing(m.sharing);
      setBoxes(b.boxes);
      setLoaded(true);
    } catch (err) {
      if (current.current === space) setError(errorMessage(err, 'Could not load members'));
    }
  }, [space]);

  useEffect(() => { void reload(); }, [reload]);

  const act = useCallback(async (fn: () => Promise<unknown>, fallback: string, after?: () => void) => {
    setError('');
    setNote('');
    try {
      await fn();
    } catch (err) {
      setError(errorMessage(err, fallback));
      return false;
    }
    after?.();
    await reload();
    return true;
  }, [reload]);

  return { loaded, members, invites, boxes, sharing, error, note, setError, setNote, reload, act };
}
