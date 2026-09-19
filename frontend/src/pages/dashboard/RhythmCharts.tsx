import React from 'react';
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { VisitsStats, WarpSeries } from '../../services/api';
import { fmtDuration, fmtDurationShort } from '../../utils/format';
import { utcHourToLocalLabel } from '../../utils/dates';
import { SWITCH_COLOR, WARP_COLOR } from '../../utils/worktime';
import { ChartCard } from './ChartCard';
import { TICK, GRID_STROKE, BAR_MAX, CHART_HEIGHT, DashTooltip } from './chartTheme';
import { RangeKeys, shortDate } from './range';

interface Props { visits: VisitsStats | null; warp: WarpSeries | null; keys: RangeKeys; stale: boolean }

const one = (v: number) => v.toFixed(1);

/** User-wide rhythm: how often you switched projects, and how much time read as "in flow". */
export function RhythmCharts({ visits, warp, keys, stale }: Props) {
  const xLabel = keys.isToday ? 'local hours' : keys.label;

  const switchRows = visits
    ? keys.isToday
      ? visits.perHourToday.map((n, h) => ({ label: utcHourToLocalLabel(h), switches: n }))
      : keys.utc.map(d => ({ label: shortDate(d), switches: visits.days.find(x => x.date === d)?.switches ?? 0 }))
    : [];
  const switchTotal = switchRows.reduce((s, r) => s + r.switches, 0);

  const flowRows = warp
    ? keys.isToday
      ? warp.hoursToday.map(h => ({ label: utcHourToLocalLabel(h.hour), warp: h.meanWarp, active: h.activeMinutes }))
      : keys.utc.map(d => { const x = warp.days.find(y => y.date === d); return { label: shortDate(d), warp: x?.meanWarp ?? 0, active: x?.activeMinutes ?? 0 }; })
    : [];
  const activeMin = flowRows.reduce((s, r) => s + r.active, 0);
  const withData = flowRows.filter(r => r.active > 0);
  const meanWarp = withData.length ? withData.reduce((s, r) => s + r.warp, 0) / withData.length : 0;

  return (
    <div className="dash-grid-2">
      <ChartCard title="Project switches" subtitle={xLabel} value={visits ? String(switchTotal) : '…'} stale={stale || !visits}
        table={{ columns: [keys.isToday ? 'hour' : 'date', 'switches'], rows: switchRows.map(r => [r.label, r.switches]) }}>
        <div className="usage-dim dash-card-note">{visits ? `avg dwell ${fmtDuration(visits.meanDwellMs)} between switches (30d)` : ''}</div>
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <BarChart data={switchRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
            <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={v => String(v)} />} />
            <Bar dataKey="switches" name="switches" fill={SWITCH_COLOR} maxBarSize={BAR_MAX} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      <ChartCard title="Flow speed" subtitle={xLabel} value={warp ? `${one(meanWarp)}c` : '…'} stale={stale || !warp}
        table={{ columns: [keys.isToday ? 'hour' : 'date', 'mean warp', 'active min'], rows: flowRows.map(r => [r.label, one(r.warp), r.active]) }}>
        <div className="usage-dim dash-card-note">{warp ? `${fmtDurationShort(activeMin * 60_000)} in flow (warp ≥ 1c)` : ''}</div>
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <LineChart data={flowRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={28} tickFormatter={(v: number) => `${v}c`} />
            <Tooltip cursor={{ stroke: 'var(--border)' }} content={<DashTooltip fmt={v => `${one(v)}c`} />} />
            <Line type="monotone" dataKey="warp" name="mean warp" stroke={WARP_COLOR} strokeWidth={2} dot={false}
              activeDot={{ r: 4, stroke: 'var(--bg-surface)', strokeWidth: 2, fill: WARP_COLOR }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
