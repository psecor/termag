import { useCallback, useEffect, useRef, useState } from 'react';
import {
  sessionsApi, SessionRow, projectsApi, usageApi, UsageResponse, worktimeApi, WorktimeResponse,
  WorktimeProjectsResponse, visitsApi, VisitsStats, warpApi, WarpSeries, contextApi, ContextSeries,
  claudeSessionsApi, CloudSessionsResponse, prsApi, PrPipelineResponse, spawnsApi, SpawnUsage,
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
export interface PolledOptions {
  /** Retry interval after an error; defaults to the poll interval. */
  retryMs?: number;
  /**
   * The caller's inputs (a range, a grouping). When they change, the fetcher
   * is run at once and a result still in flight from the old inputs is
   * dropped rather than shown under the new labels. Compared by value, so a
   * caller that passes a fresh arrow each render is not refetched each render.
   */
  deps?: readonly unknown[];
}

export function usePolled<T>(fetcher: () => Promise<T>, intervalMs: number, opts: number | PolledOptions = {}): Polled<T> & { refresh: () => void } {
  const { retryMs = intervalMs, deps = [] } = typeof opts === 'number' ? { retryMs: opts } : opts;
  const [state, setState] = useState<Polled<T>>({ data: null, error: null, fetchedAt: null, loading: true });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const alive = useRef(true);
  // Each (re)start of the effect is a generation; a fetch resolving under an
  // older one is dropped.
  const generation = useRef(0);
  const depsKey = JSON.stringify(deps);

  const schedule = useCallback((ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    if (document.visibilityState === 'hidden') return; // resumed by the visibility handler
    timer.current = setTimeout(() => { void run(); }, ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(async () => {
    const gen = generation.current;
    setState(s => ({ ...s, loading: true }));
    try {
      const data = await fetcherRef.current();
      if (!alive.current || gen !== generation.current) return;
      setState({ data, error: null, fetchedAt: Date.now(), loading: false });
      schedule(intervalMs);
    } catch (error) {
      if (!alive.current || gen !== generation.current) return;
      setState(s => ({ ...s, error, loading: false }));
      schedule(retryMs);
    }
  }, [intervalMs, retryMs, schedule]);

  useEffect(() => {
    alive.current = true;
    generation.current++;
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
    // `depsKey` is the caller's inputs by value, never the fetcher's identity:
    // the dashboard passes a fresh arrow each render and must keep its cadence.
  }, [run, depsKey]);

  // A refresh is newer than any fetch already in flight (one started before a
  // write the caller just made, say): start a generation so that one is dropped.
  return { ...state, refresh: () => { generation.current++; void run(); } };
}

const MIN = 60_000;

export interface DashboardData {
  sessions: Polled<SessionRow[]>;
  projects: Polled<Project[]>;
  usage: Polled<UsageResponse> & { refresh: () => void };
  /** true when tokens are not live: a 503 (no agent, nothing recorded) or `staleSince` set. */
  usageUnavailable: boolean;
  worktime: Polled<WorktimeResponse>;
  worktimeByProject: Polled<WorktimeProjectsResponse>;
  visits: Polled<VisitsStats>;
  warp: Polled<WarpSeries>;
  ctx: Polled<ContextSeries>;
  /** Claude Code cloud sessions on the owner's boxes: active now, and the last 30 days. */
  cloudActive: Polled<CloudSessionsResponse>;
  cloudRecent: Polled<CloudSessionsResponse>;
  /** Spawned agents, limits and box load. */
  spawns: Polled<SpawnUsage>;
  /** The PR pipeline; the backend memoizes per user for 60 s. */
  prs: Polled<PrPipelineResponse> & { refresh: () => void };
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
  // One tmux-list per box behind the active list, like /api/sessions: 30 s.
  const cloudActive = usePolled(() => claudeSessionsApi.list('active'), 30_000);
  const cloudRecent = usePolled(() => claudeSessionsApi.list('recent', 30), 2 * MIN);
  const spawns = usePolled(() => spawnsApi.usage(), MIN);
  const prs = usePolled(() => prsApi.list(), MIN);

  return {
    sessions, projects, usage,
    usageUnavailable: (!usage.loading && httpStatus(usage.error) === 503) || !!usage.data?.staleSince,
    worktime, worktimeByProject, visits, warp, ctx,
    cloudActive, cloudRecent, prs, spawns,
    checkedAt: sessions.fetchedAt,
  };
}
