import React, { useCallback, useEffect, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { adminApi, type PrBasis, type PrContributor, type PrGroup, type PrView, type PrWindow } from '../../services/adminApi';
import { useAuth } from '../../contexts/AuthContext';
import { ChartCard } from '../dashboard/ChartCard';
import { TICK, GRID_STROKE, SURFACE, BAR_MAX, CHART_HEIGHT, DashTooltip, SeriesLegend } from '../dashboard/chartTheme';
import { shortDate } from '../dashboard/range';
import { DataTable, KeyValues, fmtAgo, fmtPct, pendingText, useAdminPolled, errorText, type Column } from './shared';
import { groupToText, textToGroup } from './prGroupText';

const VIEW_LABEL: Record<PrView, string> = { credited: 'humans + their agents', humans: 'humans only', all: 'everything (bots too)' };
const VIEW_HELP: Record<PrView, string> = {
  credited: 'human PRs, plus agent PRs credited to the person they were done for',
  humans: 'PRs authored by people; agent and automation PRs left out',
  all: 'every PR, with bots as their own contributors',
};
const CLASS_COLOR = { human: 'rgb(88, 166, 255)', agent: 'rgb(188, 140, 255)', automation: 'rgb(139, 148, 158)' };
const CONTRIB_COLOR = 'rgb(246, 185, 59)';

function Choice<T extends string | number>({ label, value, options, onChange, render }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string }) {
  return (
    <div className="dash-range" role="group" aria-label={label}>
      {options.map(o => <button key={String(o)} type="button" aria-pressed={value === o} onClick={() => onChange(o)}>{render ? render(o) : String(o)}</button>)}
    </div>
  );
}

const STATE_TEXT: Record<string, string> = {
  'no-token-owner': 'no GitHub token nominated: nothing is being ingested',
  'owner-not-admin': 'the nominated token owner is no longer an admin: ingestion paused',
  'owner-has-no-github': 'the nominated token owner has no GitHub connected: ingestion paused',
  'rate-limited': 'paused for the GitHub rate limit',
  running: 'ingesting', idle: 'starting', error: 'last run failed',
};

export function AdminPrs({ now }: { now: number }) {
  const { user } = useAuth();
  const groups = useAdminPolled(useCallback(() => adminApi.prGroups(), []), 5 * 60_000);
  const status = useAdminPolled(useCallback(() => adminApi.prStatus(), []), 30_000);
  const [group, setGroup] = useState<string>('');
  const [view, setView] = useState<PrView>('credited');
  const [basis, setBasis] = useState<PrBasis>('merged');
  const [win, setWin] = useState<PrWindow>(30);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ slug: string; name: string; text: string; isNew: boolean } | null>(null);

  useEffect(() => { if (!group && groups.data?.length) setGroup(groups.data[0].slug); }, [group, groups.data]);
  const g = groups.data?.find(x => x.slug === group) ?? null;

  const summary = useAdminPolled(useCallback(() => (group ? adminApi.prSummary(group, view, basis) : Promise.resolve(null)), [group, view, basis]), 5 * 60_000, { deps: [group, view, basis] });
  const contrib = useAdminPolled(useCallback(() => (group ? adminApi.prContributors(group, view, basis, win) : Promise.resolve(null)), [group, view, basis, win]), 5 * 60_000, { deps: [group, view, basis, win] });
  const trend = useAdminPolled(useCallback(() => (group ? adminApi.prTrend(group, view, basis) : Promise.resolve(null)), [group, view, basis]), 10 * 60_000, { deps: [group, view, basis] });

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setErr(null);
    try { await fn(); after?.(); } catch (e) { setErr(errorText(e)); }
  };

  const st = status.data;
  const s = summary.data; const c = contrib.data; const t = trend.data;
  const basisWord = basis === 'merged' ? 'merged' : 'opened';

  const sumCols: Column<NonNullable<typeof s>['windows'][number]>[] = [
    { id: 'days', label: 'window', value: r => r.days, render: r => `${r.days} day${r.days === 1 ? '' : 's'}` },
    { id: 'prs', label: `PRs ${basisWord}`, value: r => r.prs, align: 'right', title: `in this view (${VIEW_LABEL[view]})` },
    { id: 'contributors', label: 'contributors', value: r => r.distribution.contributors, align: 'right' },
    { id: 'p50', label: 'p50', value: r => r.distribution.p50, align: 'right', title: 'PRs per contributor' },
    { id: 'p95', label: 'p95', value: r => r.distribution.p95, align: 'right' },
    { id: 'mean', label: 'mean', value: r => r.distribution.mean, align: 'right' },
    { id: 'max', label: 'max', value: r => r.distribution.max, align: 'right' },
    { id: 'human', label: 'by humans', value: r => r.byClass.human, align: 'right', title: `every author, ${basisWord}` },
    { id: 'agent', label: 'by agents', value: r => r.byClass.agent, align: 'right' },
    { id: 'automation', label: 'by bots', value: r => r.byClass.automation, align: 'right' },
    { id: 'assisted', label: 'agent-assisted', value: r => r.agentAssisted, align: 'right', title: 'an agent wrote or co-authored commits, any author',
      render: r => { const all = r.byClass.human + r.byClass.agent + r.byClass.automation; return `${r.agentAssisted}${all ? ` (${fmtPct(r.agentAssisted / all)})` : ''}`; } },
    { id: 'opened', label: 'opened', value: r => r.opened, align: 'right', title: 'in this view' },
    { id: 'merged', label: 'merged', value: r => r.merged, align: 'right', title: 'in this view' },
  ];
  const contribCols: Column<PrContributor & { rank: number }>[] = [
    { id: 'rank', label: '#', value: r => r.rank, align: 'right' },
    { id: 'login', label: 'contributor', value: r => r.login, render: r => <span>{r.login}{r.termag ? <span className="workstream-bar-badge" title={`termag user ${r.termag.unixUsername}`}>termag</span> : null}</span> },
    { id: 'prs', label: `PRs ${basisWord}`, value: r => r.prs, align: 'right' },
    { id: 'share', label: 'share', value: r => r.share, align: 'right', render: r => fmtPct(r.share) },
    { id: 'agentPrs', label: 'via agents', value: r => r.agentPrs, align: 'right', title: 'agent-authored PRs credited to this person' },
    { id: 'assisted', label: 'agent-assisted', value: r => r.agentAssisted, align: 'right' },
    { id: 'size', label: 'median size', value: r => r.medianSize, align: 'right', title: 'additions + deletions' },
  ];

  const ownerIsMe = st?.tokenOwner?.id === user?.id;
  const backfilling = st && st.repos > 0 && st.backfilled < st.repos;

  return (
    <>
      {err && <div className="admin-error">{err}</div>}
      <ChartCard title="Ingestion"
        subtitle={st ? `${STATE_TEXT[st.ingester.state] ?? st.ingester.state}${st.tokenOwner ? ` · token of ${st.tokenOwner.unixUsername}` : ''}` : pendingText(status)}
        value={st ? `${st.prs.toLocaleString()} PRs` : undefined} stale={status.loading}>
        {st && <KeyValues items={[
          ['repos', `${st.backfilled} of ${st.repos} backfilled (${st.backfillDays} days of history)${st.neverRun ? ` · ${st.neverRun} not started` : ''}`],
          ['last run', `${fmtAgo(st.lastRunAt, now)}${st.ingester.lastDiscoveryAt ? ` · groups resolved ${fmtAgo(st.ingester.lastDiscoveryAt, now)}` : ''}`],
          ['rate limit', st.ingester.rate ? `${st.ingester.rate.remaining} of ${st.ingester.rate.limit} left this hour${st.ingester.pausedUntil ? ` · paused until ${new Date(st.ingester.pausedUntil).toLocaleTimeString()}` : ''}` : '—'],
          ...(st.ingester.lastError ? [['error', st.ingester.lastError] as [string, string]] : []),
          ...(st.errors.length ? [['repo errors', st.errors.slice(0, 3).map(e => `${e.repo}: ${e.error}`).join(' · ') + (st.errors.length > 3 ? ` · +${st.errors.length - 3} more` : '')] as [string, string]] : []),
        ]} />}
        <div className="admin-form">
          {!ownerIsMe && <button type="button" className="btn-ghost btn-tiny" onClick={() => void act(() => adminApi.setPrToken(true), status.refresh)}>use my GitHub token</button>}
          {st?.tokenOwner && <button type="button" className="btn-ghost btn-tiny" onClick={() => void act(() => adminApi.setPrToken(false), status.refresh)}>stop ingesting</button>}
          {st?.tokenOwner && <button type="button" className="btn-ghost btn-tiny" onClick={() => void act(() => adminApi.syncPrs(), () => setTimeout(status.refresh, 3000))}>sync now</button>}
          <span className="usage-dim">The token owner's access decides what is read: topic and pattern members match only public and internal repos; a private repo is read only when a group names it.</span>
        </div>
        {backfilling && <div className="usage-dim dash-card-note">Backfill in progress: counts grow as older PRs arrive. Each repo fills newest first, so the 1- and 7-day numbers settle first.</div>}
      </ChartCard>

      <div className="admin-pr-controls">
        <Choice label="repo group" value={group} options={(groups.data ?? []).map(x => x.slug)} onChange={setGroup} render={slug => groups.data?.find(x => x.slug === slug)?.name ?? slug} />
        <Choice label="view" value={view} options={['credited', 'humans', 'all'] as const} onChange={setView} render={v => VIEW_LABEL[v]} />
        <Choice label="count" value={basis} options={['merged', 'opened'] as const} onChange={setBasis} />
      </div>

      <ChartCard title={g ? `${g.name}: PRs and contributors` : 'PRs and contributors'}
        subtitle={s ? `${s.repos} repos · ${VIEW_HELP[view]} · rolling windows ending now` : pendingText(summary)} stale={summary.loading}>
        <DataTable rows={s?.windows ?? []} columns={sumCols} rowKey={r => String(r.days)} defaultSort="days" defaultDesc={false} dense empty={s ? 'no PRs yet' : pendingText(summary)} />
      </ChartCard>

      <ChartCard title="Top contributors" subtitle={c ? `${c.contributors} contributors, ${c.total} PRs ${basisWord} in ${c.days} day${c.days === 1 ? '' : 's'}` : pendingText(contrib)} stale={contrib.loading}>
        <Choice label="window" value={win} options={[1, 7, 30] as const} onChange={setWin} render={d => `${d}d`} />
        <DataTable rows={(c?.top ?? []).map((r, i) => ({ ...r, rank: i + 1 }))} columns={contribCols} rowKey={r => r.login} defaultSort="rank" defaultDesc={false} dense empty={c ? 'no PRs in this window' : pendingText(contrib)} />
      </ChartCard>

      <ChartCard title="Weekly trend" subtitle={t ? `PRs ${basisWord} per week (Monday, UTC) by author class, and contributors in this view` : pendingText(trend)} stale={trend.loading}
        table={t ? { columns: ['week', 'humans', 'agents', 'bots', 'in view', 'contributors'], rows: t.rows.map(r => [r.week, r.human, r.agent, r.automation, r.prs, r.contributors]) } : undefined}>
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <ComposedChart data={(t?.rows ?? []).map(r => ({ ...r, label: shortDate(r.week) }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis yAxisId="prs" tick={TICK} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
            <YAxis yAxisId="people" orientation="right" tick={TICK} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
            <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} content={<DashTooltip fmt={v => String(v)} />} />
            <Bar yAxisId="prs" dataKey="human" name="by humans" stackId="c" fill={CLASS_COLOR.human} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
            <Bar yAxisId="prs" dataKey="agent" name="by agents" stackId="c" fill={CLASS_COLOR.agent} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
            <Bar yAxisId="prs" dataKey="automation" name="by bots" stackId="c" fill={CLASS_COLOR.automation} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
            <Line yAxisId="people" type="monotone" dataKey="contributors" name="contributors" stroke={CONTRIB_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <SeriesLegend series={[
          { id: 'h', label: 'by humans', color: CLASS_COLOR.human }, { id: 'a', label: 'by agents', color: CLASS_COLOR.agent },
          { id: 'b', label: 'by bots', color: CLASS_COLOR.automation }, { id: 'c', label: 'contributors (right axis)', color: CONTRIB_COLOR },
        ]} />
      </ChartCard>

      <ChartCard title="Repo groups" subtitle="one member per line: repo owner/name · topic name [org] · pattern owner/glob · exclude owner/name" stale={groups.loading}>
        <div className="dash-rows">
          {(groups.data ?? []).map((x: PrGroup) => (
            <div className="dash-row" key={x.slug}>
              <span className="dash-row-label">{x.name}</span>
              <span className="usage-dim">{x.repos.length} repos · {x.repos.reduce((n, r) => n + r.prs, 0).toLocaleString()} PRs · {groupToText(x).split('\n').join(' · ')}</span>
              <button type="button" className="btn-ghost btn-tiny" style={{ marginLeft: 'auto' }} onClick={() => setEditing({ slug: x.slug, name: x.name, text: groupToText(x), isNew: false })}>edit</button>
            </div>
          ))}
        </div>
        {!editing && <button type="button" className="btn-ghost btn-tiny" onClick={() => setEditing({ slug: '', name: '', text: '', isNew: true })}>add group</button>}
        {editing && (
          <div className="admin-pr-editor">
            <div className="admin-form">
              <input value={editing.slug} disabled={!editing.isNew} onChange={e => setEditing({ ...editing, slug: e.target.value })} placeholder="slug (e.g. team-flags)" />
              <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="name" />
            </div>
            <textarea className="admin-mono" rows={6} value={editing.text} onChange={e => setEditing({ ...editing, text: e.target.value })} placeholder={'repo example-org/termag\ntopic some-sdk\npattern example-org/*-relay*\nexclude example-org/some-repo'} />
            <div className="admin-form">
              <button type="button" className="btn-ghost btn-tiny" onClick={() => {
                const parsed = textToGroup(editing.text);
                if ('error' in parsed) { setErr(parsed.error); return; }
                const sort = groups.data?.find(x => x.slug === editing.slug)?.sort ?? 100;
                void act(() => adminApi.savePrGroup({ slug: editing.slug.trim(), name: editing.name.trim() || editing.slug.trim(), sort, ...parsed }), () => { setEditing(null); groups.refresh(); setGroup(editing.slug.trim().toLowerCase()); });
              }}>save</button>
              {!editing.isNew && <button type="button" className="btn-ghost btn-tiny" onClick={() => { if (window.confirm(`Delete the ${editing.name} group? Its PRs stay stored.`)) void act(() => adminApi.deletePrGroup(editing.slug), () => { setEditing(null); setGroup(''); groups.refresh(); }); }}>delete</button>}
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setEditing(null)}>cancel</button>
              <span className="usage-dim">Saving resolves the group on GitHub and starts reading any new repos.</span>
            </div>
          </div>
        )}
      </ChartCard>
    </>
  );
}
