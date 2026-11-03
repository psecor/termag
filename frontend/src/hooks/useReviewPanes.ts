import { useCallback, useEffect, useMemo, useState } from 'react';
import { reviewApi } from '../services/api';
import type { AgentStatus } from '../types';
import { overlayCovered, reviewPanes, type PaneOverlay, type ReviewPane } from '../utils/reviewPanes';

/** How long an optimistic entry may wait for the push that covers it. */
export const PANE_OVERLAY_MS = 8000;

/**
 * The active workstream's review panes for the desktop:
 * a ReviewDock each under the ctrl terminal. Their state rides the agent
 * session's status (`reviews`, written only by the backend's review sweep);
 * nothing polls. A small optimistic overlay per pane
 * bridges the POST→push gap for one just started, and hides one just
 * stopped until the clearing push lands. Expanded is per pane, and remembered
 * per project+workstream across switches.
 */
export function useReviewPanes({ projectId, workstream, owner, projectName, status }: {
  projectId: string | null;
  workstream: string;
  owner: string;
  projectName: string | null;
  /** The workstream's agent session's status. */
  status: Pick<AgentStatus, 'review' | 'reviews'> | undefined;
}) {
  const key = projectId ? `${projectId}/${workstream}` : '';
  // `${key}|${session}`; `${key}|*` asks for the first pane (a focus event naming none).
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({});
  const [overlays, setOverlays] = useState<Record<string, Record<string, PaneOverlay>>>({});
  const names = useMemo(
    () => (projectName ? { owner, project: projectName, workstream } : null),
    [owner, projectName, workstream],
  );
  const truth = useMemo(() => (names ? reviewPanes(status, names) : []), [status, names]);
  const overlay = overlays[key];
  const panes = useMemo(() => (names ? reviewPanes(status, names, overlay) : []), [status, names, overlay]);

  // Drop an entry once the pushed truth covers it, and every entry on a timer
  // in case the push never lands (an offline browser, an agent that never
  // reports, a stop that failed). Two effects: the timer depends on the
  // overlay alone, so the agent's own status pushes (tokens, working) do not
  // keep re-arming it and hide a pane for good (Bugbot, #786).
  const keepOnly = useCallback((keep: (session: string, o: PaneOverlay) => boolean) => setOverlays(prev => {
    const here = prev[key];
    if (!here) return prev;
    const left = Object.fromEntries(Object.entries(here).filter(([session, o]) => keep(session, o)));
    if (Object.keys(left).length === Object.keys(here).length) return prev;
    const next = { ...prev };
    if (Object.keys(left).length) next[key] = left; else delete next[key];
    return next;
  }), [key]);
  useEffect(() => {
    if (!overlay) return;
    if (Object.entries(overlay).some(([session, o]) => overlayCovered(o, session, truth))) {
      keepOnly((session, o) => !overlayCovered(o, session, truth));
    }
  }, [overlay, truth, keepOnly]);
  useEffect(() => {
    if (!overlay || Object.keys(overlay).length === 0) return;
    const t = setTimeout(() => keepOnly(() => false), PANE_OVERLAY_MS);
    return () => clearTimeout(t);
  }, [overlay, keepOnly]);

  // A request for the first pane wins over its last toggle, until the next toggle or Collapse all.
  const isExpanded = useCallback((p: ReviewPane, i: number): boolean =>
    (i === 0 && expandedMap[`${key}|*`] === true) || (expandedMap[`${key}|${p.session}`] ?? false),
  [expandedMap, key]);

  const toggle = useCallback((p: ReviewPane, i: number) => {
    const open = isExpanded(p, i);
    setExpandedMap(prev => {
      const next = { ...prev, [`${key}|${p.session}`]: !open };
      delete next[`${key}|*`];
      return next;
    });
  }, [isExpanded, key]);

  const collapseAll = useCallback(() => {
    setExpandedMap(prev => {
      const next = { ...prev };
      for (const p of panes) next[`${key}|${p.session}`] = false;
      delete next[`${key}|*`];
      return next;
    });
  }, [panes, key]);

  /** A focus event (status strip, search, PR overlay): open the pane it names, else the first. */
  const expandFor = useCallback((pid: string, ws: string, session?: string) => {
    setExpandedMap(prev => ({ ...prev, [`${pid}/${ws}|${session ?? '*'}`]: true }));
  }, []);

  const onStarted = useCallback((r: { pr: number; url: string | null; session: string; slot?: number; reviewer?: string }) => {
    const review: ReviewPane = {
      state: 'reviewing', pr: r.pr, url: r.url, reviewer: r.reviewer, at: new Date().toISOString(), doneAt: null, seenAt: null,
      session: r.session, slot: r.slot ?? 1,
    };
    setOverlays(prev => ({ ...prev, [key]: { ...prev[key], [r.session]: { review } } }));
    setExpandedMap(prev => ({ ...prev, [`${key}|${r.session}`]: true }));
  }, [key]);

  const stop = useCallback((session: string) => {
    if (!projectId) return;
    setOverlays(prev => ({ ...prev, [key]: { ...prev[key], [session]: 'cleared' } }));
    reviewApi.stop(projectId, workstream, session).catch(() => {});
  }, [projectId, workstream, key]);

  const openCount = panes.filter((p, i) => isExpanded(p, i)).length;
  return { panes, isExpanded, toggle, collapseAll, expandFor, onStarted, stop, openCount };
}
