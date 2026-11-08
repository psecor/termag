// Whether the user can open `space`, for a space's link (/chat/files/<space>,
// its New tab) and its explorer. The sidebar's list of spaces is loaded once
// and reloaded only on some changes, so a space missing from it is not taken
// for "no access": the server is asked (GET /api/spaces/:space, which also
// claims an invite) and only its 404 means no access. An answer for a space the
// list lacks reloads the list, so the sidebar catches up. Any other failure (a
// network error, a 5xx) reads as reachable: the explorer then shows its own
// error, and a failed list never marks every space unreachable. While the list
// is still loading the answer is 'checking', so nothing is requested early.
import { useEffect, useState } from 'react';
import { spacesApi } from '../services/api';

export type SpaceReach = 'yes' | 'no' | 'checking';
type Answer = 'yes' | 'no' | 'unknown';

interface SpacesLike { enabled?: boolean; loaded: boolean; spaces: ReadonlyArray<{ name: string }>; reload?: () => void }

// One question per space at a time, shared by the New tab and the explorer beside it.
const asking = new Map<string, Promise<Answer>>();

function ask(space: string, reload: (() => void) | undefined): Promise<Answer> {
  let answer = asking.get(space);
  if (!answer) {
    answer = spacesApi.get(space).then(
      () => { reload?.(); return 'yes' as const; },
      (err: { response?: { status?: number } }) => (err?.response?.status === 404 ? 'no' as const : 'unknown' as const),
    ).finally(() => asking.delete(space));
    asking.set(space, answer);
  }
  return answer;
}

export function useSpaceReach(spaces: SpacesLike, space: string): SpaceReach {
  const listed = spaces.spaces.some(s => s.name === space);
  const [asked, setAsked] = useState<{ space: string; answer: Answer } | null>(null);
  const reload = spaces.reload;
  // Asked again whenever the list loads without it (a reload that still lacks it does not).
  const needed = spaces.loaded && !listed;
  useEffect(() => {
    if (!needed) return;
    let live = true;
    void ask(space, reload).then(answer => { if (live) setAsked({ space, answer }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space, needed]);
  if (listed) return 'yes';
  // Still loading the list: nothing is asked for yet, so a link opened before access
  // leaves no failed listing behind in the explorer's cache.
  if (!spaces.loaded) return 'checking';
  if (asked?.space !== space) return 'checking';
  return asked.answer === 'no' ? 'no' : 'yes';
}
