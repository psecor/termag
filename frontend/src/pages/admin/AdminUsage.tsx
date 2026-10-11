import React, { useCallback, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { adminApi, type AdminRange, type TokenGroup, type WorktimeGroup } from '../../services/adminApi';
import { ChartCard } from '../dashboard/ChartCard';
import { TICK, GRID_STROKE, SURFACE, BAR_MAX, CHART_HEIGHT, DashTooltip } from '../dashboard/chartTheme';
import { groupedChartRows } from './usageRows';
import { fmtK, fmtDurationShort } from '../../utils/format';
import { useAdminPolled, pendingText, fmtMs, fmtTok, fmtPct } from './shared';

const TOKEN_GROUPS: TokenGroup[] = ['day', 'user', 'provider', 'host', 'project'];
const WT_GROUPS: WorktimeGroup[] = ['day', 'user', 'provider', 'project'];
const H = 3_600_000;
const hoursTick = (ms: number) => (ms >= H ? `${Math.round(ms / H)}h` : ms > 0 ? `${Math.round(ms / 60_000)}m` : '0');

function Picker<T extends string>({ value, options, onChange }: { value: T; options: T[]; onChange: (v: T) => void }) {
  return (
    <div className="dash-range" role="group" aria-label="group by">
      {options.map(o => <button key={o} type="button" aria-pressed={value === o} onClick={() => onChange(o)}>{o}</button>)}
    </div>
  );
}

export function AdminUsage({ range }: { range: AdminRange }) {
  const [tg, setTg] = useState<TokenGroup>('user');
  const [wg, setWg] = useState<WorktimeGroup>('user');
  const tokens = useAdminPolled(useCallback(() => adminApi.tokens(range, [tg]), [range, tg]), 5 * 60_000, { deps: [range, tg] });
  const wt = useAdminPolled(useCallback(() => adminApi.worktime(range, [wg]), [range, wg]), 5 * 60_000, { deps: [range, wg] });
  const t = tokens.data; const w = wt.data;
  // Each chart is shaped by the grouping its data carries, not the picker
  // (see groupedChartRows): the previous response stays on screen, dimmed,
  // until the new one lands.
  const { group: tGroup, rows: tRows, chart: tSorted } = groupedChartRows(t, tg, r => r.labels[0]);
  const { group: wGroup, rows: wRows, chart: wSorted } = groupedChartRows(w, wg, r => r.keys[0] || '—');

  return (
    <>
      <ChartCard title="Tokens" subtitle={t ? `${t.range.since} → ${t.range.until} (UTC) · ${t.users} users · ${t.totals.calls} calls · cache ${fmtPct(t.totals.cacheRatio)}${t.totals.estimated ? ` · ${fmtTok(t.totals.estimated)} estimated` : ''}` : pendingText(tokens)}
        value={t ? fmtTok(t.totals.total) : undefined} stale={tokens.loading}
        table={{ columns: [tGroup, 'total', 'input', 'output', 'cache read', 'cache create', 'calls', 'cache %'],
          rows: tRows.map(r => [r.label, fmtTok(r.total), fmtTok(r.input), fmtTok(r.output), fmtTok(r.cacheRead), fmtTok(r.cacheCreate), r.calls, fmtPct(r.cacheRatio)]) }}>
        <Picker value={tg} options={TOKEN_GROUPS} onChange={setTg} />
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <BarChart data={tSorted} layout={tGroup === 'day' ? 'horizontal' : 'vertical'} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
            <CartesianGrid vertical={tGroup !== 'day'} horizontal={tGroup === 'day'} stroke={GRID_STROKE} />
            {tGroup === 'day' ? <>
              <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tick={TICK} tickLine={false} axisLine={false} width={40} tickFormatter={fmtK} />
            </> : <>
              <XAxis type="number" tick={TICK} tickLine={false} axisLine={false} tickFormatter={fmtK} />
              <YAxis type="category" dataKey="label" tick={TICK} tickLine={false} axisLine={false} width={120} interval={0} />
            </>}
            <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={fmtK} total />} />
            <Bar dataKey="input" name="input" stackId="t" fill="rgb(88, 166, 255)" stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
            <Bar dataKey="output" name="output" stackId="t" fill="rgb(63, 185, 80)" stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
            <Bar dataKey="cacheRead" name="cache read" stackId="t" fill="rgb(139, 148, 158)" stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
            <Bar dataKey="cacheCreate" name="cache create" stackId="t" fill="rgb(188, 140, 255)" stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
        {tGroup !== 'day' && tRows.length > 25 && <div className="usage-dim dash-card-note">top 25 of {tRows.length} shown; the table has all</div>}
      </ChartCard>
      <ChartCard title="Working time" subtitle={w ? `${w.range.since} → ${w.range.until} (server-local) · ${w.totals.sessions} agent sessions${w.unknownUsernames.length ? ` · ${w.unknownUsernames.length} unattributed usernames: ${w.unknownUsernames.slice(0, 4).join(', ')}` : ''}` : pendingText(wt)}
        value={w ? `${fmtMs(w.totals.agentMs)} agent · ${fmtMs(w.totals.humanMs)} human` : undefined} stale={wt.loading}
        table={{ columns: [wGroup, 'agent', 'human', 'sessions'], rows: wRows.map(r => [r.label, fmtMs(r.agentMs), fmtMs(r.humanMs), r.sessions]) }}>
        <Picker value={wg} options={WT_GROUPS} onChange={setWg} />
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <BarChart data={wSorted} layout={wGroup === 'day' ? 'horizontal' : 'vertical'} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="25%">
            <CartesianGrid vertical={wGroup !== 'day'} horizontal={wGroup === 'day'} stroke={GRID_STROKE} />
            {wGroup === 'day' ? <>
              <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
              <YAxis tick={TICK} tickLine={false} axisLine={false} width={36} tickFormatter={hoursTick} />
            </> : <>
              <XAxis type="number" tick={TICK} tickLine={false} axisLine={false} tickFormatter={hoursTick} />
              <YAxis type="category" dataKey="label" tick={TICK} tickLine={false} axisLine={false} width={120} interval={0} />
            </>}
            <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={fmtDurationShort} total />} />
            <Bar dataKey="agentMs" name="agents" fill="rgb(88, 166, 255)" stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
            <Bar dataKey="humanMs" name="humans" fill="rgb(246, 185, 59)" stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
    </>
  );
}
