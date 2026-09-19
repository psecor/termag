import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SessionRow, WorktimeProjectRow, ContextSeries } from '../../services/api';
import type { Project } from '../../types';
import { PROVIDERS } from '../../providers/registry';
import { fmtAge, fmtDurationShort, fmtK } from '../../utils/format';
import { HUMAN } from '../../utils/worktime';
import { contextLevel } from '../../utils/thresholds';
import { ownAgentRows } from './triage';
import { projectHref } from './AttentionSection';
import { ChartCard } from './ChartCard';
import { SeriesLegend, opaque } from './chartTheme';
import type { RangeKeys } from './range';

interface Props {
  rows: WorktimeProjectRow[] | null;
  sessions: SessionRow[] | null;
  projects: Project[] | null;
  ctx: ContextSeries | null;
  keys: RangeKeys;
  now: number;
  stale: boolean;
}

interface Line {
  key: string;
  projectId: string | null;
  name: string;
  color: string | null;
  kind: string;
  byProvider: Record<string, number>;
  agentMs: number;
  humanMs: number;
  workstreams: Set<string>;
  // live
  status: SessionRow['status'] | null;
  waiting: number;
  working: number;
  alive: number;
  ctxNow: number;
  ctxPeak: number;
  lastActiveAt: string | null;
}

const STATUS_DOT: Record<string, string> = {
  working: 'var(--success)', waiting: 'var(--warning)', idle: 'var(--danger)', not_running: 'var(--text-muted)',
};
const SHOW = 12;

/**
 * The per-project table: effort in the selected range (agent time stacked by
 * provider, your time) joined with what's happening right now (live status,
 * current + peak context, last activity). Every row links to the project.
 */
export function ProjectBreakdown({ rows, sessions, projects, ctx, keys, now, stale }: Props) {
  const [all, setAll] = useState(false);

  const lines = useMemo(() => {
    const byId = new Map((projects ?? []).map(p => [p.id, p]));
    const map = new Map<string, Line>();
    const line = (projectId: string | null, name: string): Line => {
      const key = projectId ?? `name:${name}`;
      let l = map.get(key);
      if (!l) {
        const p = projectId ? byId.get(projectId) : undefined;
        l = {
          key, projectId, name: p?.name ?? name, color: p?.color ?? null, kind: p?.kind ?? 'normal',
          byProvider: {}, agentMs: 0, humanMs: 0, workstreams: new Set(),
          status: null, waiting: 0, working: 0, alive: 0, ctxNow: 0, ctxPeak: 0, lastActiveAt: p?.lastActiveAt ?? null,
        };
        map.set(key, l);
      }
      return l;
    };
    for (const r of rows ?? []) {
      if (!keys.worktime.includes(r.date)) continue;
      const l = line(r.projectId, r.projectName);
      l.workstreams.add(r.workstream);
      if (r.provider === HUMAN) l.humanMs += r.totalMs;
      else { l.agentMs += r.totalMs; l.byProvider[r.provider] = (l.byProvider[r.provider] ?? 0) + r.totalMs; }
    }
    // Live state from own agent rows — include projects with live sessions even if
    // they banked no time in the range (that's exactly the "stale" case).
    const rank: Record<string, number> = { working: 0, waiting: 1, idle: 2, not_running: 3 };
    for (const s of ownAgentRows(sessions)) {
      if (!s.connected) continue;
      const l = line(s.projectId, s.projectName);
      l.workstreams.add(s.workstream);
      if (l.status === null || rank[s.status] < rank[l.status]) l.status = s.status;
      if (s.status === 'waiting') l.waiting++;
      if (s.status === 'working') l.working++;
      if (s.alive) l.alive++;
      if (s.contextTokens && s.contextTokens > l.ctxNow) l.ctxNow = s.contextTokens;
      if (!l.lastActiveAt || s.lastActiveAt > l.lastActiveAt) l.lastActiveAt = s.lastActiveAt;
    }
    for (const p of ctx?.projects ?? []) {
      const l = map.get(p.projectId);
      if (!l) continue;
      const peak = keys.isToday
        ? Math.max(0, ...p.hoursToday.map(h => h.peakTokens))
        : Math.max(0, ...p.days.filter(d => keys.utc.includes(d.date)).map(d => d.peakTokens));
      l.ctxPeak = Math.max(l.ctxPeak, peak);
    }
    const out = [...map.values()].filter(l => l.agentMs > 0 || l.humanMs > 0 || l.alive > 0 || l.ctxNow > 0);
    out.sort((a, b) => b.agentMs - a.agentMs || b.humanMs - a.humanMs || (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''));
    return out;
  }, [rows, sessions, projects, ctx, keys]);

  const providersUsed = Object.values(PROVIDERS).filter(p => p.id !== HUMAN && lines.some(l => (l.byProvider[p.id] ?? 0) > 0));
  const series = providersUsed.map(p => ({ id: p.id, label: p.displayName, color: opaque(p.color.base) }));
  const maxMs = Math.max(1, ...lines.map(l => Math.max(l.agentMs, l.humanMs)));
  const shown = all ? lines : lines.slice(0, SHOW);
  const totalAgent = lines.reduce((s, l) => s + l.agentMs, 0);

  const table = {
    columns: ['project', 'agent', ...providersUsed.map(p => p.displayName), 'you', 'status', 'ctx now', 'ctx peak', 'last active'],
    rows: lines.map(l => [
      l.name, fmtDurationShort(l.agentMs), ...providersUsed.map(p => fmtDurationShort(l.byProvider[p.id] ?? 0)),
      fmtDurationShort(l.humanMs), l.status ?? '—', l.ctxNow ? fmtK(l.ctxNow) : '—', l.ctxPeak ? fmtK(l.ctxPeak) : '—',
      l.lastActiveAt ? fmtAge(now - Date.parse(l.lastActiveAt)) : '—',
    ]),
  };

  return (
    <ChartCard title="By project" subtitle={`effort ${keys.label} · live state now`} value={fmtDurationShort(totalAgent)} stale={stale || rows === null} table={table}>
      {lines.length === 0 ? (
        <div className="usage-dim">{rows === null ? 'loading…' : 'no activity in this range'}</div>
      ) : (
        <div className="pb-table" role="table">
          <div className="pb-head" role="row">
            <span>project</span><span>agents</span><span>you</span><span>now</span><span>ctx</span><span>last active</span>
          </div>
          {shown.map(l => {
            const lvl = contextLevel(l.ctxNow);
            const age = l.lastActiveAt ? now - Date.parse(l.lastActiveAt) : null;
            const inner = (
              <>
                <span className="pb-name">
                  <i className="attn-dot" style={{ background: l.color ?? 'var(--text-muted)' }} />
                  <span className="pb-name-text">{l.name}</span>
                  {l.workstreams.size > 1 && <span className="usage-dim">↳{l.workstreams.size}</span>}
                  {l.kind === 'metaterm' && <span className="usage-dim">⚡</span>}
                </span>
                <span className="pb-bar" title={providersUsed.map(p => `${p.displayName}: ${fmtDurationShort(l.byProvider[p.id] ?? 0)}`).join(' · ')}>
                  <span className="pb-track">
                    {providersUsed.map(p => {
                      const ms = l.byProvider[p.id] ?? 0;
                      if (ms <= 0) return null;
                      return <i key={p.id} style={{ width: `${(ms / maxMs) * 100}%`, background: opaque(p.color.base) }} />;
                    })}
                  </span>
                  <span className="pb-val">{l.agentMs > 0 ? fmtDurationShort(l.agentMs) : '—'}</span>
                </span>
                <span className="pb-bar" title={`You: ${fmtDurationShort(l.humanMs)}`}>
                  <span className="pb-track">
                    {l.humanMs > 0 && <i style={{ width: `${(l.humanMs / maxMs) * 100}%`, background: opaque(PROVIDERS[HUMAN].color.bright) }} />}
                  </span>
                  <span className="pb-val">{l.humanMs > 0 ? fmtDurationShort(l.humanMs) : '—'}</span>
                </span>
                <span className="pb-now" title={l.status ?? 'no live session'}>
                  {l.status ? <i className="attn-dot" style={{ background: STATUS_DOT[l.status] }} /> : <i className="attn-dot" style={{ background: 'transparent', border: '1px solid var(--border)' }} />}
                  <span className="usage-dim">{l.status === 'waiting' && l.waiting > 1 ? `${l.waiting} waiting` : l.status === 'working' && l.working > 1 ? `${l.working} working` : (l.status ?? '').replace('_', ' ')}</span>
                </span>
                <span className={`pb-ctx ctx-${lvl}`} title={l.ctxPeak ? `peak in range ${fmtK(l.ctxPeak)}` : ''}>
                  {l.ctxNow ? fmtK(l.ctxNow) : l.ctxPeak ? <span className="usage-dim">↑{fmtK(l.ctxPeak)}</span> : <span className="usage-dim">—</span>}
                </span>
                <span className="pb-age usage-dim">{age != null && Number.isFinite(age) ? fmtAge(age) : '—'}</span>
              </>
            );
            return l.projectId
              ? <Link key={l.key} className="pb-row" role="row" to={projectHref(l.projectId)}>{inner}</Link>
              : <div key={l.key} className="pb-row pb-row--unlinked" role="row">{inner}</div>;
          })}
          {lines.length > SHOW && (
            <button type="button" className="btn-ghost btn-tiny pb-more" onClick={() => setAll(a => !a)}>
              {all ? 'show fewer' : `+${lines.length - SHOW} more projects`}
            </button>
          )}
        </div>
      )}
      <SeriesLegend series={series} />
    </ChartCard>
  );
}
