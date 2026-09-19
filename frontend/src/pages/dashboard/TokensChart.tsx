import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { UsageResponse } from '../../services/api';
import { PROVIDERS } from '../../providers/registry';
import { dayTokens, fmtK, EMPTY_USAGE_DAY } from '../../utils/format';
import { median } from '../../utils/dates';
import { ChartCard } from './ChartCard';
import { TICK, GRID_STROKE, SURFACE, BAR_MAX, CHART_HEIGHT, DashTooltip, SeriesLegend, opaque } from './chartTheme';
import { RangeKeys, shortDate } from './range';

interface Props { usage: UsageResponse | null; unavailable: boolean; keys: RangeKeys; stale: boolean }

export function TokensChart({ usage, unavailable, keys, stale }: Props) {
  if (!usage) {
    return (
      <ChartCard title="Tokens" subtitle={unavailable ? 'agent offline — token data unavailable' : 'loading…'} stale>
        <div className="dash-placeholder" style={{ height: CHART_HEIGHT }} />
      </ChartCard>
    );
  }
  const byProvider = usage.providers ?? {};
  const providers = Object.values(PROVIDERS).filter(p => {
    const d = byProvider[p.id];
    return d && keys.utc.some(k => d[k] && dayTokens(d[k]) > 0);
  });
  const series = providers.map(p => ({ id: p.id, label: p.displayName, color: opaque(p.color.base) }));
  const rows = keys.utc.map(d => {
    const r: Record<string, number | string> = { date: d, label: shortDate(d) };
    for (const p of providers) r[p.id] = dayTokens(byProvider[p.id]?.[d] ?? EMPTY_USAGE_DAY);
    r.total = dayTokens(usage.days[d] ?? EMPTY_USAGE_DAY);
    return r;
  });
  const total = rows.reduce((s, r) => s + (r.total as number), 0);
  // "Typical day": median of active days in the trailing baseline (excludes today's partial day).
  const baseline = keys.priorUtc.map(d => usage.days[d]).filter(d => d && d.calls > 0).map(d => dayTokens(d!));
  const typical = baseline.length >= 3 ? median(baseline) : null;
  const est = providers.some(p => p.usagePrecision === 'estimated');
  const table = {
    columns: ['date', ...providers.map(p => p.displayName), 'total'],
    rows: rows.map(r => [r.label as string, ...providers.map(p => fmtK(r[p.id] as number)), fmtK(r.total as number)]),
  };
  const subtitle = `${keys.label}${est ? ' · some providers estimated' : ''}${unavailable ? ' · agent offline, showing last scan' : ''}`;

  if (keys.isToday) {
    const ratio = typical && typical > 0 ? total / typical : null;
    return (
      <ChartCard title="Tokens" subtitle={subtitle} value={fmtK(total)} stale={stale || unavailable} table={table}>
        <div className="dash-rows">
          {providers.map(p => (
            <div className="dash-row" key={p.id}>
              <i className="attn-dot" style={{ background: opaque(p.color.base) }} />
              <span className="dash-row-label">{p.displayName}{p.usagePrecision === 'estimated' ? ' (est)' : ''}</span>
              <span className="dash-row-value">{fmtK(rows[0][p.id] as number)}</span>
            </div>
          ))}
          {providers.length === 0 && <div className="usage-dim">no tokens recorded today</div>}
          {typical != null && (
            <div className="dash-row">
              <i className="attn-dot" style={{ background: 'transparent' }} />
              <span className="dash-row-label">typical day</span>
              <span className="dash-row-value">{fmtK(typical)}</span>
              <span className="usage-dim">{ratio != null ? `today is ${ratio.toFixed(1)}×` : ''}</span>
            </div>
          )}
        </div>
        <SeriesLegend series={series} />
      </ChartCard>
    );
  }

  return (
    <ChartCard title="Tokens" subtitle={subtitle} value={fmtK(total)} stale={stale || unavailable} table={table}>
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart data={rows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
          <CartesianGrid vertical={false} stroke={GRID_STROKE} />
          <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={TICK} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => fmtK(v)} />
          <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={fmtK} total />} />
          {typical != null && (
            <ReferenceLine y={typical} stroke="var(--text-secondary)" strokeWidth={1} ifOverflow="extendDomain"
              label={{ value: `typical ${fmtK(typical)}`, position: 'insideTopRight', fill: 'var(--text-secondary)', fontSize: 10 }} />
          )}
          {providers.map(p => (
            <Bar key={p.id} dataKey={p.id} name={p.displayName} stackId="tok" fill={opaque(p.color.base)}
              stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <SeriesLegend series={series} />
    </ChartCard>
  );
}
