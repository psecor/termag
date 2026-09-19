import { useCallback, useEffect, useRef, useState } from 'react';
import {
  sessionsApi, SessionRow, projectsApi, usageApi, UsageResponse, worktimeApi, WorktimeResponse,
  WorktimeProjectsResponse, visitsApi, VisitsStats, warpApi, WarpSeries, contextApi, ContextSeries,
} from '../../services/api';
import type { Project } from '../../types';

export interface Polled<T> {
  data: T | null;
  error: unknown | null;
  fetchedAt: number | null;
  loading: boolean;
}

/**
 * Poll a fetcher on an interval. Keeps the last good payload across errors
 * (the UI dims rather than blanks), pauses while the tab is hidden, and
 * refetches as soon as it becomes visible again. `retryMs` is the cadence used
 * after an error, so a 503 from an offline agent is re-probed sooner than the
 * normal interval without hammering.
 */
export function usePolled<T>(fetcher: () => Promise<T>, intervalMs: number, retryMs = intervalMs): Polled<T> & { refresh: () => void } {
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, fetchedAt: null, loading: true });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const alive = useRef(true);

  const schedule = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    if (document.visibilityState === 'hidden') return; // resumed by the visibility handler
    timer.current = setTimeout(() => { void run(); }, ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(async () => {
    setState(s => ({ ...s, loading: true }));
    try {
      const data = await fetcherRef.current();
      if (!alive.current) return;
      setState({ data, error: null, fetchedAt: Date.now(), loading: false });
      schedule(intervalMs);
    } catch (error) {
      if (!alive.current) return;
      setState(s => ({ ...s, error, loading: false }));
      schedule(retryMs);
    }
  }, [intervalMs, retryMs, schedule]);

  useEffect(() => {
    alive.current = true;
    void run();
    const onVis = () => {
      if (document.visibilityState === 'visible') void run();
      else if (timer.current) clearTimeout(timer.current);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVis);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [run]);

  return { ...state, refresh: () => { void run(); } };
}

const MIN = 60_000;

export interface DashboardData {
  sessions: Polled<SessionRow[]>;
  projects: Polled<Project[]>;
  usage: Polled<UsageResponse>;
  /** true when the last usage fetch was a 503 (agent offline) */
  usageUnavailable: boolean;
  worktime: Polled<WorktimeResponse>;
  worktimeByProject: Polled<WorktimeProjectsResponse>;
  visits: Polled<VisitsStats>;
  warp: Polled<WarpSeries>;
  ctx: Polled<ContextSeries>;
  /** Most recent successful sessions fetch — the "checked Xs ago" stamp. */
  checkedAt: number | null;
}

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

export function useDashboardData(): DashboardData {
  // /api/sessions does one tmux-list RPC per host (5s timeout) — 30s is the floor.
  const sessions = usePolled(() => sessionsApi.list(), 30_000);
  const projects = usePolled(() => projectsApi.list(), MIN);
  const usage = usePolled(() => usageApi.get(), 5 * MIN, MIN);
  const worktime = usePolled(() => worktimeApi.get(30), 5 * MIN);
  const worktimeByProject = usePolled(() => worktimeApi.byProject(30), 5 * MIN);
  const visits = usePolled(() => visitsApi.stats(30), 5 * MIN);
  const warp = usePolled(() => warpApi.series(30), 5 * MIN);
  const ctx = usePolled(() => contextApi.series(30), 5 * MIN);

  return {
    sessions, projects, usage,
    usageUnavailable: !usage.loading && httpStatus(usage.error) === 503,
    worktime, worktimeByProject, visits, warp, ctx,
    checkedAt: sessions.fetchedAt,
  };
}
