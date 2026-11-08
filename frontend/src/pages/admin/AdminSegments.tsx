/**
 * Segments: the daily engagement ladder per user,
 * computed nightly by the segment tracker. One overview call feeds every card;
 * the per-day user list loads on demand.
 */
import React, { useCallback, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, type TooltipContentProps } from 'recharts';
import type { NameType, ValueType } from 'recharts/types/component/DefaultTooltipContent';
import { adminApi, type SegmentsOverview, type SegmentName } from '../../services/adminApi';
import { ChartCard } from '../dashboard/ChartCard';
import { TICK, GRID_STROKE, BAR_MAX, CHART_HEIGHT, HUE, CURSOR, DashTooltip } from '../dashboard/chartTheme';
import { useAdminPolled, DataTable, type Column } from './shared';

const SEGMENT_ORDER: SegmentName[] = ['New', 'Power', 'Active', 'Passive', 'Dormant'];
const SEGMENT_COLORS: Record<string, string> = {
  New: HUE.amber, Power: HUE.purple, Active: HUE.blue,
  Passive: HUE.teal, Dormant: HUE.gray, Service: HUE.other,
};
/**
 * What each rung means, in ladder order. Restates backend
 * services/segments/rules.ts (RULES, segmentFor), the only place the
 * numbers live; change both together.
 */
const SEGMENT_DEFINITIONS: Partial<Record<SegmentName, string>> = {
  New: 'joined 3 days ago or less (checked first)',
  Power: 'active 5+ of the last 7 days, and 2+ boxes or 5+ projects/workstreams created in the last 30 days',
  Active: 'active 3+ of the last 7 days',
  Passive: 'active 1 or 2 of the last 7 days',
  Dormant: 'no active day in the last 7 days (drawn below the line)',
};
/** Drawn below the zero line on the ladder: users engagement has lost. */
const BELOW: SegmentName[] = ['Dormant'];
const count = (v: number) => String(Math.abs(Math.round(v)));

export function AdminSegments() {
  const poll = useAdminPolled(useCallback(() => adminApi.segments(), []), 5 * 60_000);
  const overview = poll.data;

  return (
    <div className="dash-grid-2">
      <ChartCard title="Engagement ladder"
        subtitle={`per-user segment by day${overview ? ` (${overview.from.slice(5)} → ${overview.to.slice(5)})` : ''}`}
        value={overview ? `${overview.users} users` : '…'} stale={!overview}>
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <BarChart data={trendRows(overview)} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%" stackOffset="sign">
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="date" tick={TICK} tickLine={false} axisLine={false} minTickGap={28} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={26} allowDecimals={false} tickFormatter={count} />
            <ReferenceLine y={0} stroke="var(--text-secondary)" strokeWidth={1} strokeOpacity={0.5} />
            <Tooltip cursor={CURSOR} content={(p: TooltipContentProps<ValueType, NameType>) => (
              <DashTooltip active={p.active} label={p.label} fmt={count}
                payload={p.payload?.map(r => ({ name: String(r.name), color: r.color, dataKey: r.dataKey as string, value: Math.abs(Number(r.value)) }))} />
            )} />
            {SEGMENT_ORDER.map(k => (
              <Bar key={k} dataKey={k} stackId="l" name={k} fill={SEGMENT_COLORS[k]}
                stroke="var(--bg-surface)" strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <SegmentDefinitions />
      </ChartCard>

      <ChartCard title="Today" subtitle={overview?.to} value={undefined} stale={!overview}>
        <HistogramTiles overview={overview} />
        <div className="usage-dim" style={{ marginTop: 8 }}>
          Active day: agent working time ≥ 5 min, human typing, or agent token usage.
          Windows: 3d tenure (New) · 7d cadence (Power 5, Active 3, Passive 1; none is
          Dormant) · 30d for the Power creation test (2 boxes or 5 projects/workstreams).
        </div>
      </ChartCard>

      <ChartCard title="Into and out of engagement"
        subtitle={`7-day flows, ${overview?.transitions?.first?.slice(5) ?? '…'} → ${overview?.transitions?.last?.slice(5) ?? '…'}`}
        value={flowTotal(overview) || '…'} stale={!overview}>
        <FlowTable overview={overview} />
        <div className="usage-dim">Dormant → anywhere means a user came back after 7 or more quiet days.</div>
      </ChartCard>

      <DayListCard overview={overview} />
    </div>
  );
}

function trendRows(overview: SegmentsOverview | null): Array<Record<string, string | number>> {
  return (overview?.days ?? []).map(d => {
    const row: Record<string, string | number> = { date: d.date.slice(5), total: d.total };
    for (const s of SEGMENT_ORDER) row[s] = (d.counts.find(c => c.segment === s)?.n ?? 0) * (BELOW.includes(s) ? -1 : 1);
    return row;
  });
}

/** The rungs' definitions under the ladder, first match wins from the top. */
function SegmentDefinitions() {
  return (
    <div style={{ display: 'grid', gap: 4, marginTop: 8 }}>
      {SEGMENT_ORDER.map(s => (
        <div key={s} className="dash-row">
          <span className="dash-row-label">
            <span aria-hidden style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 6, background: SEGMENT_COLORS[s] }} />
            {s}
          </span>
          <span className="usage-dim">{SEGMENT_DEFINITIONS[s]}</span>
        </div>
      ))}
      <div className="usage-dim dash-card-note">Each user gets the first segment that fits, top to bottom, every UTC day.</div>
    </div>
  );
}

function HistogramTiles({ overview }: { overview: SegmentsOverview | null }) {
  const last = overview ? overview.days[overview.days.length - 1] : undefined;
  if (!last) return <div className="usage-dim">no rows yet</div>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, padding: '6px 2px' }}>
      {SEGMENT_ORDER.map(s => (
        <div key={s}>
          <div style={{ fontSize: '2em', fontWeight: 600 }}>{last.counts.find((c: { segment: string; n: number }) => c.segment === s)?.n ?? 0}</div>
          <div className="usage-dim">{s}</div>
        </div>
      ))}
    </div>
  );
}

function FlowTable({ overview }: { overview: SegmentsOverview | null }) {
  const flows = (overview?.transitions?.flows ?? [])
    .map(f => ({ from: f.from, to: f.to, n: f.n }));
  const columns: Array<Column<{ from: string; to: string; n: number }>> = [
    { id: 'flow', label: 'flow', value: r => `${r.from} → ${r.to}` },
    { id: 'n', label: 'moves', value: r => r.n, align: 'right' },
  ];
  return <DataTable rows={flows} columns={columns} rowKey={r => r.from + '>' + r.to}
    defaultSort="flow" empty="no 7-day flows yet" dense />;
}

/** The per-day user list, lazily loaded (adminApi.segmentUsers). */
function DayListCard({ overview }: { overview: SegmentsOverview | null }) {
  const [state, setState] = useState<{ loading: boolean; day?: string; rows: Array<{ username: string | null; segment: string }> }>({ loading: false, rows: [] });
  const load = useCallback(async (overview: SegmentsOverview | null) => {
    if (!overview) return;
    setState(s => ({ ...s, loading: true, day: overview.to }));
    try {
      const r = await adminApi.segmentUsers(overview.to);
      const rows = r.users.map(u => ({ username: u.username, segment: u.segment }))
        .sort((a, b) => a.segment.localeCompare(b.segment) || (a.username ?? '').localeCompare(b.username ?? ''));
      setState({ loading: false, day: r.date, rows });
    } catch { setState(s => ({ ...s, loading: false })); }
  }, []);
  const columns: Array<Column<{ username: string | null; segment: string }>> = [
    { id: 'user', label: 'user', value: r => r.username ?? '—' },
    { id: 'segment', label: 'segment', value: r => r.segment },
  ];
  return (
    <ChartCard title="Who is where" subtitle={overview?.to} value={overview ? `${overview.users} tracked` : '…'} stale={!overview}>
      <div className="dash-range" role="group" aria-label="load user list">
        <button type="button" onClick={async () => { setState(s => ({ ...s, loading: true })); await load(overview); }}>
          list today's per-user segments
        </button>
      </div>
      <DataTable rows={state.rows} columns={columns} rowKey={r => (r.username ?? '') + String(0)}
        defaultSort="user" empty="no day loaded" dense search="filter users" storageKey="segments-users" resetKey={state.day} />
      <div className="usage-dim">{overview?.tracker
        ? `tracker ${overview.tracker.state}${overview.tracker.lastRunAt ? ` · ran ${overview.tracker.lastRunAt.slice(11, 16)}Z` : ''}` : '…'}</div>
    </ChartCard>
  );
}

function flowTotal(overview: SegmentsOverview | null): string {
  return String((overview?.transitions.flows ?? []).reduce((s, f) => s + f.n, 0));
}
