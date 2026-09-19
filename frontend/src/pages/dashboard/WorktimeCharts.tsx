import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import type { WorktimeResponse } from '../../services/api';
import { PROVIDERS, ProviderConfig } from '../../providers/registry';
import { fmtDuration, fmtDurationShort } from '../../utils/format';
import { HUMAN, mergeWtDays, activeWtProviders, WtDayData } from '../../utils/worktime';
import { ChartCard } from './ChartCard';
import { TICK, GRID_STROKE, SURFACE, BAR_MAX, CHART_HEIGHT, DashTooltip, SeriesLegend, opaque } from './chartTheme';
import { RangeKeys, shortDate } from './range';

const H = 3_600_000;
const hoursTick = (ms: number) => (ms >= H ? `${Math.round(ms / H)}h` : ms > 0 ? `${Math.round(ms / 60_000)}m` : '0');

interface Props { wt: WorktimeResponse | null; keys: RangeKeys; stale: boolean }

/** Horizontal stacked bar for a single period (Today has no hourly resolution). */
function StackedRow({ data, providers, maxMs }: { data: WtDayData; providers: ProviderConfig[]; maxMs: number }) {
  const total = providers.reduce((s, p) => s + (data[p.id]?.totalMs ?? 0), 0);
  const fillPct = maxMs > 0 ? Math.min((total / maxMs) * 100, 100) : 0;
  return (
    <div className="wt-stacked-bar" style={{ height: 16 }}>
      <div className="wt-stacked-bar-track">
        <div className="wt-stacked-bar-fill" style={{ width: `${fillPct}%` }}>
          {providers.map(p => {
            const ms = data[p.id]?.totalMs ?? 0;
            if (ms <= 0 || total <= 0) return null;
            return <div key={p.id} className="wt-stacked-bar-seg" style={{ width: `${(ms / total) * 100}%`, background: opaque(p.color.base) }} title={`${p.displayName}: ${fmtDurationShort(ms)}`} />;
          })}
        </div>
      </div>
    </div>
  );
}

export function WorktimeCharts({ wt, keys, stale }: Props) {
  const human = PROVIDERS[HUMAN];
  if (!wt) {
    return (
      <div className="dash-grid-2">
        <ChartCard title="Agents" subtitle="working time by provider" stale><div className="dash-placeholder" style={{ height: CHART_HEIGHT }} /></ChartCard>
        <ChartCard title="You" subtitle="active time" stale><div className="dash-placeholder" style={{ height: CHART_HEIGHT }} /></ChartCard>
      </div>
    );
  }
  const agentProviders = activeWtProviders(wt).filter(p => p.id !== HUMAN);
  const series = agentProviders.map(p => ({ id: p.id, label: p.displayName, color: opaque(p.color.base) }));

  // Daily rows for the range (server-local keys).
  const rows = keys.worktime.map(d => {
    const dw = wt.days[d] ?? {};
    const r: Record<string, number | string> = { date: d, label: shortDate(d) };
    for (const p of agentProviders) r[p.id] = dw[p.id]?.totalMs ?? 0;
    r[HUMAN] = dw[HUMAN]?.totalMs ?? 0;
    return r;
  });
  const merged = mergeWtDays(wt, keys.worktime);
  const agentTotal = agentProviders.reduce((s, p) => s + (merged[p.id]?.totalMs ?? 0), 0);
  const humanTotal = merged[HUMAN]?.totalMs ?? 0;
  const dayCount = keys.isToday ? 1 : keys.worktime.length;
  const perDay = (ms: number) => keys.isToday ? '' : `avg ${fmtDurationShort(ms / dayCount)}/day`;

  const agentTable = {
    columns: ['date', ...agentProviders.map(p => p.displayName), 'total'],
    rows: rows.map(r => [r.label as string, ...agentProviders.map(p => fmtDurationShort(r[p.id] as number)), fmtDurationShort(agentProviders.reduce((s, p) => s + (r[p.id] as number), 0))]),
  };
  const humanTable = { columns: ['date', 'active'], rows: rows.map(r => [r.label as string, fmtDurationShort(r[HUMAN] as number)]) };

  if (keys.isToday) {
    // Today: one stacked row per side plus per-provider lines. 8h = full scale.
    const scale = 8 * H;
    return (
      <div className="dash-grid-2">
        <ChartCard title="Agents" subtitle="working time today" value={fmtDuration(agentTotal)} stale={stale} table={agentTable}>
          <StackedRow data={merged} providers={agentProviders} maxMs={scale} />
          <div className="dash-rows">
            {agentProviders.map(p => {
              const ms = merged[p.id]?.totalMs ?? 0;
              if (ms <= 0) return null;
              return (
                <div className="dash-row" key={p.id}>
                  <i className="attn-dot" style={{ background: opaque(p.color.base) }} />
                  <span className="dash-row-label">{p.displayName}</span>
                  <span className="dash-row-value">{fmtDuration(ms)}</span>
                  <span className="usage-dim">{merged[p.id]?.sessions ?? 0} ses</span>
                </div>
              );
            })}
            {agentTotal === 0 && <div className="usage-dim">no agent time banked yet today</div>}
          </div>
          <SeriesLegend series={series} />
        </ChartCard>
        <ChartCard title="You" subtitle="active time today" value={fmtDuration(humanTotal)} stale={stale} table={humanTable}>
          <StackedRow data={{ [HUMAN]: merged[HUMAN] ?? { totalMs: 0, sessions: 0 } }} providers={[human]} maxMs={scale} />
          <div className="dash-rows">
            <div className="dash-row">
              <i className="attn-dot" style={{ background: opaque(human.color.bright) }} />
              <span className="dash-row-label">typing / interacting</span>
              <span className="dash-row-value">{fmtDuration(humanTotal)}</span>
            </div>
          </div>
        </ChartCard>
      </div>
    );
  }

  return (
    <div className="dash-grid-2">
      <ChartCard title="Agents" subtitle={`working time by provider, ${keys.label}`} value={fmtDuration(agentTotal)} stale={stale} table={agentTable}>
        <div className="usage-dim dash-card-note">{perDay(agentTotal)}</div>
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={36} tickFormatter={hoursTick} />
            <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={fmtDurationShort} total />} />
            {agentProviders.map(p => (
              <Bar key={p.id} dataKey={p.id} name={p.displayName} stackId="agents" fill={opaque(p.color.base)}
                stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
            ))}
          </BarChart>
        </ResponsiveContainer>
        <SeriesLegend series={series} />
      </ChartCard>
      <ChartCard title="You" subtitle={`active time, ${keys.label}`} value={fmtDuration(humanTotal)} stale={stale} table={humanTable}>
        <div className="usage-dim dash-card-note">{perDay(humanTotal)}</div>
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={36} tickFormatter={hoursTick} />
            <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={fmtDurationShort} />} />
            <Bar dataKey={HUMAN} name="You" fill={opaque(human.color.bright)} maxBarSize={BAR_MAX} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </div>
  );
}
