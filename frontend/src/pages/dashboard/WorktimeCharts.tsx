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

/**
 * Horizontal stacked bar for a single period (Today has no hourly resolution).
 * Segments render in `providers` order, so the caller decides what sits at
 * the base (here: your own time first, agents after it).
 */
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
            const color = p.id === HUMAN ? p.color.bright : p.color.base;
            return <div key={p.id} className="wt-stacked-bar-seg" style={{ width: `${(ms / total) * 100}%`, background: opaque(color) }} title={`${p.displayName}: ${fmtDurationShort(ms)}`} />;
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * Agents and you on ONE chart, one time axis: for each day a pair of bars side
 * by side — the agents' working time (stacked by provider) and your active
 * time — so the two magnitudes read directly against each other. The two used
 * to be separate cards with independent y-axes, which made a 40-minute human
 * bar tower over a 6-hour agent bar; sharing the axis puts them in context and
 * halves the space.
 */
export function WorktimeCharts({ wt, keys, stale }: Props) {
  const human = PROVIDERS[HUMAN];
  if (!wt) {
    return (
      <ChartCard title="Activity" subtitle="agents beside your active time" stale>
        <div className="dash-placeholder" style={{ height: CHART_HEIGHT }} />
      </ChartCard>
    );
  }
  const agentProviders = activeWtProviders(wt).filter(p => p.id !== HUMAN);
  // Legend / table order: agents, then you (left-to-right order of the bars).
  const stack: ProviderConfig[] = [...agentProviders, human];
  const colorOf = (p: ProviderConfig) => opaque(p.id === HUMAN ? p.color.bright : p.color.base);
  const series = stack.map(p => ({ id: p.id, label: p.id === HUMAN ? 'You' : p.displayName, color: colorOf(p) }));

  // Daily rows for the range (server-local keys).
  const rows = keys.worktime.map(d => {
    const dw = wt.days[d] ?? {};
    const r: Record<string, number | string> = { date: d, label: shortDate(d) };
    for (const p of stack) r[p.id] = dw[p.id]?.totalMs ?? 0;
    return r;
  });
  const merged = mergeWtDays(wt, keys.worktime);
  const agentTotal = agentProviders.reduce((s, p) => s + (merged[p.id]?.totalMs ?? 0), 0);
  const humanTotal = merged[HUMAN]?.totalMs ?? 0;
  const dayCount = keys.isToday ? 1 : keys.worktime.length;
  const headline = `${fmtDuration(agentTotal)} agents · ${fmtDuration(humanTotal)} you`;
  const perDay = keys.isToday ? '' : `avg ${fmtDurationShort(agentTotal / dayCount)} agents · ${fmtDurationShort(humanTotal / dayCount)} you per day`;

  const table = {
    columns: ['date', ...agentProviders.map(p => p.displayName), 'agents', 'you'],
    rows: rows.map(r => [
      r.label as string,
      ...agentProviders.map(p => fmtDurationShort(r[p.id] as number)),
      fmtDurationShort(agentProviders.reduce((s, p) => s + (r[p.id] as number), 0)),
      fmtDurationShort(r[HUMAN] as number),
    ]),
  };

  if (keys.isToday) {
    // Today: one stacked row (you at the base, agents after) on the 8h scale,
    // then a line per contributor.
    const scale = 8 * H;
    return (
      <ChartCard title="Activity" subtitle="agents beside your active time, today" value={headline} stale={stale} table={table}>
        {/* Two rows on the same 8h scale: agents, then you directly under. */}
        <StackedRow data={merged} providers={agentProviders} maxMs={scale} />
        <StackedRow data={{ [HUMAN]: merged[HUMAN] ?? { totalMs: 0, sessions: 0 } }} providers={[human]} maxMs={scale} />
        <div className="dash-rows">
          {agentProviders.map(p => {
            const ms = merged[p.id]?.totalMs ?? 0;
            if (ms <= 0) return null;
            return (
              <div className="dash-row" key={p.id}>
                <i className="attn-dot" style={{ background: colorOf(p) }} />
                <span className="dash-row-label">{p.displayName}</span>
                <span className="dash-row-value">{fmtDuration(ms)}</span>
                <span className="usage-dim">{merged[p.id]?.sessions ?? 0} ses</span>
              </div>
            );
          })}
          {agentTotal === 0 && <div className="usage-dim">no agent time banked yet today</div>}
          <div className="dash-row">
            <i className="attn-dot" style={{ background: colorOf(human) }} />
            <span className="dash-row-label">you — typing / interacting</span>
            <span className="dash-row-value">{fmtDuration(humanTotal)}</span>
          </div>
        </div>
        <SeriesLegend series={series} />
      </ChartCard>
    );
  }

  return (
    <ChartCard title="Activity" subtitle={`agents beside your active time, ${keys.label}`} value={headline} stale={stale} table={table}>
      <div className="usage-dim dash-card-note">{perDay}</div>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={TICK} tickLine={false} axisLine={false} width={36} tickFormatter={hoursTick} />
          <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={fmtDurationShort} total />} />
          {/* Two bars per day, side by side: the agents (one stack, a segment per
              provider) and you. Same axis, so the heights compare directly. */}
          {agentProviders.map(p => (
            <Bar key={p.id} dataKey={p.id} name={p.displayName} stackId="agents" fill={colorOf(p)}
              stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
          ))}
          <Bar dataKey={HUMAN} name="You" fill={colorOf(human)} maxBarSize={BAR_MAX} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      <SeriesLegend series={series} />
    </ChartCard>
  );
}
