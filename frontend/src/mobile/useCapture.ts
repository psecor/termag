// Polls one pane's capture for the phone conversation screen with the
// refresh policy: quick while the agent works, slow
// when it waits or idles, paused while the page is hidden, and an extra
// capture shortly after every status event for the session. Never faster
// than the server's 1/s limit; a 429 is skipped, not surfaced.
import { useCallback, useEffect, useRef, useState } from 'react';
import { sessionsApi } from '../services/api';
import type { AgentStatusValue } from '../types';

export type CaptureError = 'offline' | 'denied' | 'failed';

export interface CaptureState {
  content: string | null;
  styled: boolean;
  error: CaptureError | null;
  /** Wall-clock of the last successful capture. */
  at: number | null;
}

export interface UseCaptureOptions {
  projectId: string | null | undefined;
  role: 'agent' | 'ctrl' | 'review';
  workstream: string;
  status: AgentStatusValue | undefined;
  /** Last status write; a change schedules a capture. */
  statusUpdatedAt: string | undefined;
  enabled: boolean;
  lines?: number;
}

const MIN_GAP_MS = 1100;          // the route's limit is 1/s; stay a hair under
const AFTER_STATUS_MS = 400;      // let the pane repaint after a hook fires

export function intervalFor(status: AgentStatusValue | undefined): number {
  switch (status) {
    case 'working': return 2_000;
    case 'waiting': return 10_000;
    default: return 30_000;
  }
}

export function useCapture(o: UseCaptureOptions): CaptureState & { refresh: () => void } {
  const [state, setState] = useState<CaptureState>({ content: null, styled: false, error: null, at: null });
  const inFlight = useRef(false);
  const lastAt = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped when the pane changes. A response that started under an older
  // generation belongs to the previous pane and is dropped.
  const gen = useRef(0);
  const { projectId, role, workstream, enabled } = o;
  const lines = o.lines ?? 400;

  // Reset when the pane changes so stale text from the previous one never
  // shows: forget the in-flight request and any queued retry (both are for
  // the old pane) and clear the content. `lastAt` stays — the server's limit
  // is per caller, not per pane, so the next capture waits out the gap
  // instead of eating a 429.
  useEffect(() => {
    gen.current++;
    inFlight.current = false;
    if (pending.current) { clearTimeout(pending.current); pending.current = null; }
    setState({ content: null, styled: false, error: null, at: null });
  }, [projectId, role, workstream]);

  const capture = useCallback(async () => {
    if (!projectId || !enabled || inFlight.current) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const since = Date.now() - lastAt.current;
    if (since < MIN_GAP_MS) {
      // Too soon for the server; come back when it is not.
      if (!pending.current) {
        pending.current = setTimeout(() => { pending.current = null; void capture(); }, MIN_GAP_MS - since);
      }
      return;
    }
    const my = gen.current;
    inFlight.current = true;
    try {
      const r = await sessionsApi.capture(projectId, role, { workstream, lines, styled: true });
      if (my !== gen.current) return; // the pane changed while this was in flight
      lastAt.current = Date.now();
      setState({ content: r.content, styled: r.styled, error: null, at: lastAt.current });
    } catch (err) {
      if (my !== gen.current) return;
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 429) {
        // Another caller used this second; try again after the gap rather
        // than waiting for the next poll tick (up to 30s when idle).
        lastAt.current = Date.now();
        if (!pending.current) pending.current = setTimeout(() => { pending.current = null; void capture(); }, MIN_GAP_MS);
        return;
      }
      const error: CaptureError = status === 503 ? 'offline' : status === 404 || status === 403 ? 'denied' : 'failed';
      setState(prev => ({ ...prev, error }));
    } finally {
      if (my === gen.current) inFlight.current = false;
    }
  }, [projectId, role, workstream, lines, enabled]);

  // Steady poll at the status-dependent interval, paused while hidden.
  useEffect(() => {
    if (!enabled || !projectId) return;
    void capture();
    const every = intervalFor(o.status);
    let timer: ReturnType<typeof setInterval> | null = setInterval(() => { void capture(); }, every);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        void capture();
        if (!timer) timer = setInterval(() => { void capture(); }, every);
      } else if (timer) { clearInterval(timer); timer = null; }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [capture, enabled, projectId, o.status]);

  // One extra capture shortly after each status event for this session.
  useEffect(() => {
    if (!enabled || !projectId || !o.statusUpdatedAt) return;
    const t = setTimeout(() => { void capture(); }, AFTER_STATUS_MS);
    return () => clearTimeout(t);
  }, [capture, enabled, projectId, o.statusUpdatedAt]);

  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);

  const refresh = useCallback(() => { void capture(); }, [capture]);
  return { ...state, refresh };
}
