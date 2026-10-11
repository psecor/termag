// The review pane's status for one workstream, derived from the status
// channel: the pane's state rides the AGENT session's status (`review`,
// written only by the backend's review sweep.md), so the
// phone polls nothing. A pane started from the desktop shows up here too, and
// one whose shell exits disappears when the sweep publishes the clear. A
// tiny optimistic overlay covers the start POST→push gap and hides a
// just-stopped pane until the clearing push lands.
import { useCallback, useEffect, useState } from 'react';
import { useProjects } from '../contexts/ProjectContext';
import { statusKey } from '../utils/statusKey';
import type { ReviewStatus } from '../utils/review';
import type { SessionReview } from '../types';

const OVERLAY_MS = 8_000;

export interface UseReview {
  /** Null while no review pane is known to the sweep. */
  status: ReviewStatus | null;
  /** No longer a poll; the status channel pushes. Kept for stop-failure paths. */
  refresh: () => void;
  /** Right after POST: show the tab before the first push confirms it. */
  markStarted: (r: { pr: number; url: string | null; session: string }) => void;
  markStopped: () => void;
}

export function useReview(opts: {
  projectId: string | null | undefined;
  instanceId: string | null | undefined;
  workstream: string;
  /** The AGENT session's tmux name — the review rides its status. */
  agentSession?: string;
  /** The REVIEW session's tmux name, reported back in `status.session`. */
  reviewSession?: string;
  enabled: boolean;
}): UseReview {
  const { projectId, instanceId, workstream, agentSession, reviewSession, enabled } = opts;
  const { statusMap } = useProjects();
  const meta = enabled && agentSession
    ? statusMap[statusKey(instanceId, agentSession)]?.review ?? null
    : null;
  const [overlayKind, setOverlayKind] = useState<'started' | 'stopped' | null>(null);
  const [overlayReview, setOverlayReview] = useState<SessionReview | null>(null);

  // The overlay that the pushed truth covers goes away; a timer caps it in
  // case the push never lands (offline browser, an agent that never reports,
  // or a backend too old to have the sweep).
  useEffect(() => {
    if (overlayKind === null) return;
    const covered = overlayKind === 'stopped' ? meta == null : meta != null;
    const clear = () => { setOverlayKind(null); setOverlayReview(null); };
    if (covered) { clear(); return; }
    const t = setTimeout(clear, OVERLAY_MS);
    return () => clearTimeout(t);
  }, [overlayKind, meta]);

  const markStarted = useCallback((r: { pr: number; url: string | null; session: string }) => {
    setOverlayKind('started');
    setOverlayReview({ state: 'reviewing', pr: r.pr, url: r.url, at: new Date().toISOString(), doneAt: null, seenAt: null });
  }, []);
  const markStopped = useCallback(() => { setOverlayKind('stopped'); setOverlayReview(null); }, []);
  const refresh = useCallback(() => { /* the status channel is the refresh */ }, [projectId, instanceId, workstream, enabled]);

  const shown = overlayKind === 'stopped' ? null : overlayReview ?? meta;
  const status: ReviewStatus | null = shown
    ? {
        session: reviewSession ?? '',
        connected: true as const,
        alive: true as const,
        running: shown.state === 'reviewing' || shown.state === 'waiting' || shown.state === 'done',
        state: shown.state,
        pr: shown.pr,
        url: shown.url,
        startedAt: null,
      }
    : null;
  return { status, refresh, markStarted, markStopped };
}
