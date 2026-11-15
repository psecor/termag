import { useCallback, useEffect, useRef, useState } from 'react';
import { boxesApi } from '../services/api';
import { placementKey, type PlacementView } from '../chat/boxPlacement';

/** A repository typed into a URL field settles before the placement is asked about, as the box sizes are. */
const REPO_SETTLE_MS = 300;
/** An ask that hasn't answered by then reads as failed: Auto is New box, so a Send waiting on it goes. */
export const PLACEMENT_TIMEOUT_MS = 10_000;

export interface BoxPlacementState {
  /**
   * The answer for these repositories; null while they are asked about. An
   * answer for others (the repositories just changed) is never used: it could
   * send the session to the box picked for the last ones.
   */
  view: PlacementView | null;
  /** The ask for these repositories failed, and there is no answer for them. */
  failed: boolean;
  /**
   * The answer is for another size, and the ask for this size failed: where
   * New box comes from (the pool, by size) isn't known, so it reads as a launch.
   */
  sizeStale: boolean;
  /** Ask again (the picker's Retry). */
  retry: () => void;
}

/**
 * Where Runs on: Auto would put this New session (GET /api/boxes/placement),
 * read while `active` (box-placement-enabled) for the repositories and the
 * size New box would launch at, or for the project New session picked
 * (`userProjectId`). Read again when they
 * change, when `boxesKey` does (a box woke, went to sleep or came and went),
 * and on retry().
 */
export function useBoxPlacement(active: boolean, repos: readonly string[], size: string | null, boxesKey: string, userProjectId: string | null = null): BoxPlacementState {
  const project = userProjectId ?? '';
  const key = `${placementKey(repos, size)}|${project}`;
  // An answer holds for its repositories (and project): a new size (New box's, once its sizes are read) only refreshes
  // where New box comes from, so the last answer for these repositories stays while it is asked again, and Auto doesn't
  // fall back to checking. Each answer and failure is kept with the repositories it was for.
  const repoKey = `${placementKey(repos, null)}|${project}`;
  const [answer, setAnswer] = useState<{ repoKey: string; key: string; view: PlacementView } | null>(null);
  const answerRef = useRef(answer);
  answerRef.current = answer;
  // The exact ask (repositories and size) that failed last, cleared as each new ask starts: what `sizeStale` reads.
  const [failedKey, setFailedKey] = useState<string | null>(null);
  // Repositories whose asks have all failed with no answer to show: Auto is New box (Send works, with Retry) until
  // one answers, whatever is asked meanwhile. A failure with an answer held (a size-only refresh) never sets it.
  const [failedRepos, setFailedRepos] = useState<string | null>(null);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setFailedKey(null);
    const fail = () => {
      setFailedKey(key);
      if (answerRef.current?.repoKey !== repoKey) setFailedRepos(repoKey);
    };
    const [list, sized, asked] = key.split('|');
    const giveUp = setTimeout(() => { if (!cancelled) fail(); }, PLACEMENT_TIMEOUT_MS);
    const timer = setTimeout(() => {
      boxesApi.placement(list ? list.split(',') : [], sized || null, asked || null)
        .then(v => { if (!cancelled) { clearTimeout(giveUp); setAnswer({ repoKey, key, view: v }); setFailedKey(null); setFailedRepos(null); } })
        .catch(() => { if (!cancelled) fail(); });
    }, list ? REPO_SETTLE_MS : 0);
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(giveUp); };
  }, [active, key, boxesKey, tries]); // eslint-disable-line react-hooks/exhaustive-deps
  const retry = useCallback(() => { setTries(n => n + 1); }, []);
  // A refresh for the same repositories that failed keeps their answer (a box woke, say): only no answer reads as failed.
  const view = answer?.repoKey === repoKey ? answer.view : null;
  const failed = failedRepos === repoKey && !view;
  const sizeStale = !!view && answer?.key !== key && failedKey === key;
  return { view, failed, sizeStale, retry };
}
