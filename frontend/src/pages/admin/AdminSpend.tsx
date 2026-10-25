import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { adminApi, type SpendModel, type SpendPerson, type SpendPool, type SpendPoolCost, type SpendProviderCost } from '../../services/adminApi';
import { ChartCard } from '../dashboard/ChartCard';
import { TICK, GRID_STROKE, SURFACE, BAR_MAX, CHART_HEIGHT, DashTooltip, SeriesLegend } from '../dashboard/chartTheme';
import { shortDate } from '../dashboard/range';
import { DataTable, KeyValues, errorText, fmtPct, fmtTok, pendingText, useAdminPolled, type Column } from './shared';
import { fmtShare, fmtUsd, mixToText, pricesToText, textToMix, textToPrices, windowKeys } from './spendText';

const WINDOWS = [7, 30, 90] as const;
type SpendWindow = typeof WINDOWS[number];
const SERIES_COLORS = ['rgb(88, 166, 255)', 'rgb(63, 185, 80)', 'rgb(188, 140, 255)', 'rgb(246, 185, 59)', 'rgb(139, 148, 158)', 'rgb(248, 81, 73)'];
const SHARE_TEXT: Record<SpendPoolCost['share'], string> = { proportional: 'proportional', usage: 'measured usage', full: 'all of it' };
const SPLIT_TEXT: Record<SpendPoolCost['allocation'], string> = { even: 'split evenly', 'by-tokens': 'split by tokens', 'by-usage': 'split by agent time' };

function Choice<T extends string | number>({ label, value, options, onChange, render }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string }) {
  return (
    <div className="dash-range" role="group" aria-label={label}>
      {options.map(o => <button key={String(o)} type="button" aria-pressed={value === o} onClick={() => onChange(o)}>{render ? render(o) : String(o)}</button>)}
    </div>
  );
}

function poolRule(p: SpendPoolCost): string {
  const share = p.share === 'proportional'
    ? `${fmtPct(p.shareFraction)} share (termag users of ${p.population ?? '?'}${p.populationLabel ? `, ${p.populationLabel}` : ''})`
    : `${SHARE_TEXT[p.share]} (${fmtPct(p.shareFraction)})`;
  const size = p.infra ? `${p.infra.boxes} box${p.infra.boxes === 1 ? '' : 'es'} × ${fmtUsd(p.infra.boxCostUsd)}/yr, ${p.infra.usersPerBox} people each` : `${fmtUsd(p.annualUsd)}/yr`;
  return `${size} · ${share} · ${SPLIT_TEXT[p.allocation]}`;
}

export function AdminSpend() {
  const [win, setWin] = useState<SpendWindow>(30);
  const [active, setActive] = useState(false);
  const keys = windowKeys(win);
  const report = useAdminPolled(useCallback(() => adminApi.spendReport(keys.from, keys.to, active), [keys.from, keys.to, active]), 5 * 60_000, { deps: [keys.from, keys.to, active] });
  const trend = useAdminPolled(useCallback(() => adminApi.spendTrend(12), []), 10 * 60_000);
  const r = report.data;

  const poolCols: Column<SpendPerson>[] = (r?.pools ?? []).map(p => ({
    id: `pool:${p.id}`, label: p.name, value: (x: SpendPerson) => x.pools[p.id] ?? 0, align: 'right' as const, render: (x: SpendPerson) => fmtUsd(x.pools[p.id] ?? 0),
    title: `${p.name}: termag's part, ${SPLIT_TEXT[p.allocation]}`,
  }));
  const peopleCols: Column<SpendPerson>[] = [
    { id: 'name', label: 'person', value: x => x.name, render: x => <span>{x.name}{!x.active ? <span className="usage-dim"> · inactive</span> : null}</span> },
    { id: 'tokens', label: 'tokens', value: x => x.tokens, align: 'right', render: x => fmtTok(x.tokens) },
    { id: 'metered', label: 'metered', value: x => x.meteredUsd, align: 'right', render: x => fmtUsd(x.meteredUsd), title: 'tokens × dated prices (estimate)' },
    ...poolCols,
    { id: 'total', label: 'total', value: x => x.totalUsd, align: 'right', render: x => fmtUsd(x.totalUsd) },
    { id: 'share', label: '% of loaded', value: x => x.shareOfLoaded, align: 'right', render: x => fmtShare(x.shareOfLoaded), title: 'annualised spend over the loaded cost of one person' },
    { id: 'top', label: 'top provider', value: x => x.topProvider ?? '' },
  ];
  const provCols: Column<SpendProviderCost>[] = [
    { id: 'provider', label: 'provider', value: x => x.provider, render: x => <span>{x.provider}{x.pool ? <span className="usage-dim"> · {x.pool}</span> : x.pricing === 'unpriced' ? <span className="admin-bad"> · no price</span> : null}</span> },
    { id: 'users', label: 'people', value: x => x.users, align: 'right' },
    { id: 'tokens', label: 'tokens', value: x => x.tokens, align: 'right', render: x => fmtTok(x.tokens) },
    { id: 'cache', label: 'cache reads', value: x => (x.tokens ? x.cacheRead / x.tokens : null), align: 'right', render: x => (x.tokens ? fmtPct(x.cacheRead / x.tokens) : '—'), title: 'share of tokens that are cache reads' },
    { id: 'cost', label: 'cost', value: x => x.costUsd, align: 'right', render: x => fmtUsd(x.costUsd) },
    { id: 'perM', label: '$/M tokens', value: x => x.usdPerMTokens, align: 'right', render: x => fmtUsd(x.usdPerMTokens) },
    { id: 'perMnc', label: '$/M ex. cache reads', value: x => x.usdPerMExcludingCacheReads, align: 'right', render: x => fmtUsd(x.usdPerMExcludingCacheReads), title: 'cost over tokens other than cache reads' },
    { id: 'savings', label: 'cache savings', value: x => x.cacheSavingsUsd, align: 'right', render: x => fmtUsd(x.cacheSavingsUsd), title: 'what cache reads would have cost at the input price, minus what they cost' },
    { id: 'est', label: 'estimated (not counted)', value: x => x.estimatedTokens, align: 'right', render: x => (x.estimatedTokens ? `${fmtTok(x.estimatedTokens)} · ${fmtUsd(x.estimatedCostUsd)}` : '—'), title: 'tmux-poller guesses, priced but kept out of the totals' },
  ];

  const series = useMemo(() => {
    // Metered providers first, then the pools, so the stack order stays put week to week.
    // Keys are namespaced: a pool may share a name with a provider.
    const metered = new Set<string>(); const pools = new Set<string>();
    for (const w of trend.data?.weeks ?? []) { Object.keys(w.metered).forEach(k => metered.add(k)); Object.keys(w.pools).forEach(k => pools.add(k)); }
    return [...[...metered].map(k => ({ id: `m:${k}`, label: k })), ...[...pools].map(k => ({ id: `p:${k}`, label: k }))]
      .map((s, i) => ({ ...s, color: SERIES_COLORS[i % SERIES_COLORS.length] }));
  }, [trend.data]);
  const prefixed = (pre: string, o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`${pre}${k}`, v]));
  const trendRows = (trend.data?.weeks ?? []).map(w => ({ label: shortDate(w.week), ...prefixed('m:', w.metered), ...prefixed('p:', w.pools), total: w.totalUsd, partial: w.days < 7 }));

  const t = r?.totals;
  return (
    <>
      <div className="admin-pr-controls">
        <Choice label="window" value={win} options={WINDOWS} onChange={setWin} render={d => `${d}d`} />
        <Choice label="denominator" value={active ? 'active' : 'all'} options={['all', 'active'] as const} onChange={v => setActive(v === 'active')} render={v => (v === 'all' ? 'all termag users' : 'active users only')} />
      </div>

      <ChartCard title="Spend" value={t ? fmtUsd(t.totalUsd, { compact: true }) : undefined} stale={report.loading}
        subtitle={r ? `${r.window.since} → ${r.window.until} (UTC) · estimate: tokens × prices (Claude at the assumed model mix) plus cost pools · ${r.denominator.users} ${r.denominator.mode === 'all' ? 'termag users' : 'active users'}` : pendingText(report)}>
        {t && r && <KeyValues items={[
          ['per head', `${fmtUsd(t.perHeadUsd)} in the window · ${fmtUsd(t.perHeadMonthlyUsd)} a month`],
          ['share of loaded cost', `${fmtShare(t.shareOfLoaded)} of ${r.denominator.users} × ${fmtUsd(r.config.loadedCostUsd)} a year · ${fmtUsd(t.annualizedUsd, { compact: true })} a year annualised`],
          ['metered', `${fmtUsd(t.meteredUsd)} · ${fmtTok(t.tokens)} tokens in all · ${fmtUsd(t.usdPerMTokens)} per million blended`],
          ['cost pools', `${fmtUsd(t.poolUsd)} (${r.pools.map(p => `${p.name} ${fmtUsd(p.costUsd)}`).join(', ') || 'none'})`],
          ['per person', `median ${fmtUsd(r.distribution.p50)} · p90 ${fmtUsd(r.distribution.p90)} · mean ${fmtUsd(r.distribution.mean)} · max ${fmtUsd(r.distribution.max)}`],
          ['users', `${r.denominator.allUsers} termag users, ${r.denominator.activeUsers} active in the window`],
          ...(r.unpriced.length ? [['unpriced', `${r.unpriced.join(', ')}: some or all tokens have no price row in force and no pool, so they cost nothing here`] as [string, string]] : []),
          ...(t.estimatedTokens ? [['poller estimates', `${fmtTok(t.estimatedTokens)} tokens (${fmtUsd(t.estimatedCostUsd)}) left out of the totals`] as [string, string]] : []),
        ]} />}
      </ChartCard>

      <ChartCard title="Cost pools" subtitle="flat-priced spend: vendor contracts at termag's share, and the internal inference boxes" stale={report.loading}>
        <div className="dash-rows">
          {(r?.pools ?? []).map(p => (
            <div className="dash-row" key={p.id}>
              <span className="dash-row-label">{p.name}</span>
              <span className="dash-row-value">
                {fmtUsd(p.costUsd)} <span className="usage-dim">· {poolRule(p)}
                  {p.tokens ? ` · ${fmtUsd(p.usdPerMTokens)} per million tokens` : p.usdPerActiveUser != null ? ` · ${fmtUsd(p.usdPerActiveUser)} per active user` : ' · no usage seen'}
                  {p.infra ? ` · ${p.infra.peakConcurrent == null ? 'peak concurrency not measured' : `peak ${p.infra.peakConcurrent} at once${p.infra.utilization != null ? ` (${fmtPct(p.infra.utilization)} of capacity)` : ''}`} · ${fmtUsd(p.infra.seatUsdPerMonth)} a seat a month at full load` : ''}
                </span>
                {p.warnings.map(w => <div key={w} className="admin-bad">{w}</div>)}
              </span>
            </div>
          ))}
          {r && !r.pools.length && <div className="usage-dim">no pools</div>}
        </div>
      </ChartCard>

      <ChartCard title="Providers" subtitle="metered at the price table, or a pool's cost split by tokens" stale={report.loading}>
        <DataTable rows={r?.providers ?? []} columns={provCols} rowKey={x => x.provider} defaultSort="cost" dense empty={r ? 'no tokens in this window' : pendingText(report)} />
      </ChartCard>

      <ChartCard title="Weekly spend" subtitle={trend.data ? 'Monday-UTC weeks; the current week is partial' : pendingText(trend)} stale={trend.loading}
        table={trend.data ? { columns: ['week', ...series.map(s => s.label), 'total'], rows: trendRows.map(w => [w.label, ...series.map(s => fmtUsd((w as Record<string, unknown>)[s.id] as number ?? 0)), fmtUsd(w.total)]) } : undefined}>
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <BarChart data={trendRows} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis tick={TICK} tickLine={false} axisLine={false} width={48} tickFormatter={v => fmtUsd(v, { compact: true })} />
            <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={v => fmtUsd(v)} total />} />
            {series.map(s => <Bar key={s.id} dataKey={s.id} name={s.label} stackId="s" fill={s.color} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />)}
          </BarChart>
        </ResponsiveContainer>
        <SeriesLegend series={series} />
      </ChartCard>

      <ChartCard title="People" subtitle={r ? `${r.people.length} ${r.denominator.mode === 'all' ? 'termag users' : 'active users'}; pools split per their rule · % of loaded is the window annualised` : pendingText(report)} stale={report.loading}>
        <DataTable rows={r?.people ?? []} columns={peopleCols} rowKey={x => x.userId} defaultSort="total" dense empty={r ? 'nobody in this window' : pendingText(report)} />
      </ChartCard>

      <SpendModelEditor onSaved={report.refresh} />
    </>
  );
}

const blankPool = (sort: number): SpendPool => ({
  name: '', kind: 'contract', providers: [], annualUsd: null, boxes: null, boxCostUsd: null, usersPerBox: null,
  share: 'proportional', shareValue: null, populationLabel: null, populationSize: null, allocation: 'even', startDate: null, endDate: null, note: null, sort,
});
const numOrNull = (s: string): number | null => (s.trim() === '' ? null : Number(s));

/** The model's assumptions: settings, the model mix and price table as text, and the pools as small forms. */
function SpendModelEditor({ onSaved }: { onSaved: () => void }) {
  const model = useAdminPolled(useCallback(() => adminApi.spendModel(), []), 10 * 60_000);
  const [draft, setDraft] = useState<{ loaded: string; headcount: string; mix: string; prices: string; pools: SpendPool[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const load = (m: SpendModel) => setDraft({ loaded: String(m.config.loadedCostUsd), headcount: String(m.config.orgHeadcount), mix: mixToText(m.config.modelMix), prices: pricesToText(m.prices), pools: m.pools });
  useEffect(() => { if (model.data && !draft) load(model.data); }, [model.data, draft]);

  if (!draft) return <ChartCard title="Model" subtitle={pendingText(model)} stale={model.loading}><span /></ChartCard>;
  const setPool = (i: number, patch: Partial<SpendPool>) => setDraft({ ...draft, pools: draft.pools.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

  const save = async () => {
    setErr(null);
    const mixed = textToMix(draft.mix); if ('error' in mixed) { setErr(mixed.error); return; }
    const modelMix = mixed.mix;
    const prices = textToPrices(draft.prices); if ('error' in prices) { setErr(prices.error); return; }
    setSaving(true);
    try {
      const saved = await adminApi.saveSpendModel({ config: { loadedCostUsd: Number(draft.loaded), orgHeadcount: Number(draft.headcount), modelMix }, prices, pools: draft.pools });
      load(saved); model.refresh(); onSaved();
    } catch (e) { setErr(errorText(e)); } finally { setSaving(false); }
  };

  return (
    <ChartCard title="Model" subtitle={`the assumptions behind every number above · last changed ${model.data ? new Date(model.data.updatedAt).toLocaleString() : '…'}`} stale={model.loading}>
      {err && <div className="admin-error">{err}</div>}
      <div className="admin-form">
        <label>loaded cost per person, USD/yr <input value={draft.loaded} onChange={e => setDraft({ ...draft, loaded: e.target.value })} inputMode="numeric" /></label>
        <label>org headcount <input value={draft.headcount} onChange={e => setDraft({ ...draft, headcount: e.target.value })} inputMode="numeric" /></label>
      </div>
      <div className="usage-dim">Assumed model mix, one provider per line (until token rows carry the model):</div>
      <textarea className="admin-mono" rows={2} value={draft.mix} onChange={e => setDraft({ ...draft, mix: e.target.value })} placeholder="claude: claude-opus-5-5=0.8, claude-fable-5-1=0.2" />
      <div className="usage-dim">Prices, USD per million tokens, one per line: provider model effectiveFrom input output cacheRead cacheWrite (model * = any):</div>
      <textarea className="admin-mono" rows={6} value={draft.prices} onChange={e => setDraft({ ...draft, prices: e.target.value })} />
      <div className="usage-dim">Cost pools:</div>
      {draft.pools.map((p, i) => (
        <div className="admin-form" key={p.id ?? `new${i}`}>
          <input value={p.name} onChange={e => setPool(i, { name: e.target.value })} placeholder="name" />
          <select value={p.kind} onChange={e => setPool(i, { kind: e.target.value as SpendPool['kind'] })}><option value="contract">contract</option><option value="infra">infra</option></select>
          <input value={p.providers.join(', ')} onChange={e => setPool(i, { providers: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })} placeholder="providers" title="termag providers the pool covers, comma-separated" />
          {p.kind === 'contract'
            ? <input value={p.annualUsd ?? ''} onChange={e => setPool(i, { annualUsd: numOrNull(e.target.value) })} placeholder="USD/yr" inputMode="numeric" />
            : <>
              <input value={p.boxes ?? ''} onChange={e => setPool(i, { boxes: numOrNull(e.target.value) })} placeholder="boxes (blank: size from peak)" title="boxes running; blank sizes from peak concurrency" inputMode="numeric" />
              <input value={p.boxCostUsd ?? ''} onChange={e => setPool(i, { boxCostUsd: numOrNull(e.target.value) })} placeholder="USD/box/yr" inputMode="numeric" />
              <input value={p.usersPerBox ?? ''} onChange={e => setPool(i, { usersPerBox: numOrNull(e.target.value) })} placeholder="people/box" inputMode="numeric" />
            </>}
          <select value={p.share} onChange={e => setPool(i, { share: e.target.value as SpendPool['share'] })} title="how much of the pool termag carries">
            <option value="proportional">proportional share</option><option value="usage">measured share</option><option value="full">all of it</option>
          </select>
          {p.share === 'proportional' && <>
            <input value={p.populationLabel ?? ''} onChange={e => setPool(i, { populationLabel: e.target.value || null })} placeholder="population (e.g. Engineering)" />
            <input value={p.populationSize ?? ''} onChange={e => setPool(i, { populationSize: numOrNull(e.target.value) })} placeholder="people (blank: headcount)" inputMode="numeric" />
          </>}
          {p.share === 'usage' && <input value={p.shareValue ?? ''} onChange={e => setPool(i, { shareValue: numOrNull(e.target.value) })} placeholder="share 0–1" inputMode="decimal" />}
          <select value={p.allocation} onChange={e => setPool(i, { allocation: e.target.value as SpendPool['allocation'] })} title="how termag's part is split over people">
            <option value="even">split evenly</option><option value="by-tokens">split by tokens</option><option value="by-usage">split by agent time</option>
          </select>
          <button type="button" className="btn-ghost btn-tiny" onClick={() => setDraft({ ...draft, pools: draft.pools.filter((_, j) => j !== i) })}>remove</button>
        </div>
      ))}
      <div className="admin-form">
        <button type="button" className="btn-ghost btn-tiny" onClick={() => setDraft({ ...draft, pools: [...draft.pools, blankPool((draft.pools.length + 1) * 10)] })}>add pool</button>
        <button type="button" className="btn-ghost btn-tiny" disabled={saving} onClick={() => void save()}>{saving ? 'saving…' : 'save model'}</button>
        <button type="button" className="btn-ghost btn-tiny" onClick={() => model.data && load(model.data)}>discard changes</button>
        <span className="usage-dim">Saving replaces the whole model; numbers above recompute from it.</span>
      </div>
    </ChartCard>
  );
}
