import React, { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { UsageResponse } from '../../services/api';
import { PROVIDERS } from '../../providers/registry';
import { dayTokens, fmtK, fmtAge, EMPTY_USAGE_DAY } from '../../utils/format';
import { median } from '../../utils/dates';
import { ChartCard } from './ChartCard';
import { TICK, GRID_STROKE, SURFACE, BAR_MAX, CHART_HEIGHT, DashTooltip, SeriesLegend, opaque } from './chartTheme';
import { RangeKeys, shortDate } from './range';
import { projectSeries, unattributedInRange, oldSchemaHosts } from './usageProjects';

type Mode = 'provider' | 'project';
const MODE_KEY = 'termag:dashboardTokensMode';

interface Props {
  usage: UsageResponse | null;
  unavailable: boolean;
  keys: RangeKeys;
  stale: boolean;
  now: number;
  onRescan?: () => Promise<void> | void;
}

interface Series { id: string; label: string; color: string; est?: boolean }

export function TokensChart({ usage, unavailable, keys, stale, now, onRescan }: Props) {
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem(MODE_KEY) as Mode) || 'project');
  const [rescanning, setRescanning] = useState(false);
  const pick = (m: Mode) => { setMode(m); localStorage.setItem(MODE_KEY, m); };

  if (!usage) {
    return (
      <ChartCard title="Tokens" subtitle={unavailable ? 'no agent connected and nothing recorded yet' : 'loading…'} stale>
        <div className="dash-placeholder" style={{ height: CHART_HEIGHT }} />
      </ChartCard>
    );
  }

  // ── Series for the chosen mode ──────────────────────────────────────────
  let series: Series[];
  let valueFor: (id: string, date: string) => number;
  if (mode === 'provider') {
    const byProvider = usage.providers ?? {};
    const providers = Object.values(PROVIDERS).filter(p => {
      const d = byProvider[p.id];
      return d && keys.utc.some(k => d[k] && dayTokens(d[k]) > 0);
    });
    series = providers.map(p => ({ id: p.id, label: p.displayName, color: opaque(p.color.base), est: p.usagePrecision === 'estimated' }));
    valueFor = (id, date) => dayTokens(byProvider[id]?.[date] ?? EMPTY_USAGE_DAY);
  } else {
    const ps = projectSeries(usage, keys.utc, 8);
    series = ps.map(s => ({ id: s.id, label: s.label, color: s.color }));
    const lookup = new Map(ps.map(s => [s.id, s.days]));
    valueFor = (id, date) => dayTokens(lookup.get(id)?.[date] ?? EMPTY_USAGE_DAY);
  }

  const rows = keys.utc.map(d => {
    const r: Record<string, number | string> = { date: d, label: shortDate(d) };
    for (const s of series) r[s.id] = valueFor(s.id, d);
    r.total = dayTokens(usage.days[d] ?? EMPTY_USAGE_DAY);
    return r;
  });
  const total = rows.reduce((s, r) => s + (r.total as number), 0);
  // "Typical day": median of active days in the trailing baseline (excludes today's partial day).
  const baseline = keys.priorUtc.map(d => usage.days[d]).filter(d => d && d.calls > 0).map(d => dayTokens(d!));
  const typical = baseline.length >= 3 ? median(baseline) : null;

  // ── Annotations ─────────────────────────────────────────────────────────
  const notes: string[] = [keys.label];
  const est = Object.values(PROVIDERS).some(p => p.usagePrecision === 'estimated' && usage.providers?.[p.id] && keys.utc.some(k => dayTokens(usage.providers![p.id][k] ?? EMPTY_USAGE_DAY) > 0));
  if (est) notes.push('some providers estimated');
  const unattr = unattributedInRange(usage, keys.utc);
  if (unattr > 0 && total > 0) {
    const old = oldSchemaHosts(usage);
    notes.push(`${Math.round((unattr / total) * 100)}% unattributed${old.length ? ` (old agent on ${old.join(', ')})` : ''}`);
  }
  if (usage.staleSince) notes.push(`last scan ${fmtAge(now - Date.parse(usage.staleSince))} ago`);
  const subtitle = notes.join(' · ');

  const table = {
    columns: ['date', ...series.map(s => s.label), 'total'],
    rows: rows.map(r => [r.label as string, ...series.map(s => fmtK(r[s.id] as number)), fmtK(r.total as number)]),
  };

  const controls = (
    <div className="dash-toggle" role="group" aria-label="stack tokens by">
      <button type="button" aria-pressed={mode === 'project'} onClick={() => pick('project')}>by project</button>
      <button type="button" aria-pressed={mode === 'provider'} onClick={() => pick('provider')}>by provider</button>
      {onRescan && (
        <button type="button" className="dash-toggle-action" disabled={rescanning} title="Ask every connected agent to rescan now"
          onClick={async () => { setRescanning(true); try { await onRescan(); } finally { setRescanning(false); } }}>
          {rescanning ? 'scanning…' : 'rescan'}
        </button>
      )}
    </div>
  );

  if (keys.isToday) {
    const ratio = typical && typical > 0 ? total / typical : null;
    return (
      <ChartCard title="Tokens" subtitle={subtitle} value={fmtK(total)} stale={stale || unavailable} table={table}>
        {controls}
        <div className="dash-rows">
          {series.map(s => (
            <div className="dash-row" key={s.id}>
              <i className="attn-dot" style={{ background: s.color }} />
              <span className="dash-row-label">{s.label}{s.est ? ' (est)' : ''}</span>
              <span className="dash-row-value">{fmtK(rows[0][s.id] as number)}</span>
            </div>
          ))}
          {series.length === 0 && <div className="usage-dim">no tokens recorded today</div>}
          {typical != null && (
            <div className="dash-row">
              <i className="attn-dot" style={{ background: 'transparent' }} />
              <span className="dash-row-label">typical day</span>
              <span className="dash-row-value">{fmtK(typical)}</span>
              <span className="usage-dim">{ratio != null ? `today is ${ratio.toFixed(1)}×` : ''}</span>
            </div>
          )}
        </div>
      </ChartCard>
    );
  }

  return (
    <ChartCard title="Tokens" subtitle={subtitle} value={fmtK(total)} stale={stale || unavailable} table={table}>
      {controls}
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
          {series.map(s => (
            <Bar key={s.id} dataKey={s.id} name={s.label} stackId="tok" fill={s.color}
              stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
      <SeriesLegend series={series} />
    </ChartCard>
  );
}
