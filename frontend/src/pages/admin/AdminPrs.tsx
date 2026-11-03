import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { adminApi, type PrBasis, type PrContributor, type PrGroup, type PrReviewer, type PrReviewWindow, type PrView, type PrWindow } from '../../services/adminApi';
import { useAuth } from '../../contexts/AuthContext';
import { ChartCard } from '../dashboard/ChartCard';
import { TICK, GRID_STROKE, SURFACE, BAR_MAX, CHART_HEIGHT, HUE, CURSOR, DashTooltip, SeriesLegend } from '../dashboard/chartTheme';
import { shortDate } from '../dashboard/range';
import { DataTable, KeyValues, fmtAgo, fmtPct, pendingText, useAdminPolled, errorText, type Column } from './shared';
import { groupSummary, groupToText, textToGroup } from './prGroupText';
import { importedTeamsNote, parseTeamsExportFile, teamToText, textToMembers } from './prTeamText';

const VIEW_LABEL: Record<PrView, string> = { credited: 'humans + their agents', humans: 'humans only', all: 'everything (bots too)' };
const VIEW_HELP: Record<PrView, string> = {
  credited: 'human PRs, plus agent PRs credited to the person they were done for',
  humans: 'PRs authored by people; agent and automation PRs left out',
  all: 'every PR, with bots as their own contributors',
};
const CLASS_COLOR = { human: HUE.blue, agent: HUE.purple, automation: HUE.gray };
const CONTRIB_COLOR = HUE.amber;
const APPROVAL_COLOR = { agentOnly: HUE.purple, humanApproved: HUE.green, unapproved: HUE.gray };
const days = (d: number) => `${d} day${d === 1 ? '' : 's'}`;
/** The team dimension's pseudo-group: every ingested repo. */
const ALL_REPOS = '*';
const fmtHours = (h: number | null): string => h == null ? '—' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
const repos = (n: number) => `${n} repo${n === 1 ? '' : 's'}`;
const ofMerged = (n: number, all: number) => `${n}${all ? ` (${fmtPct(n / all)})` : ''}`;

function Choice<T extends string | number>({ label, value, options, onChange, render }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; render?: (v: T) => string }) {
  return (
    <div className="dash-range" role="group" aria-label={label}>
      {options.map(o => <button key={String(o)} type="button" aria-pressed={value === o} onClick={() => onChange(o)}>{render ? render(o) : String(o)}</button>)}
    </div>
  );
}

/** A dropdown for a long option list (the team picker, once the org-tree sync lands 75 of them).
 * Pass `groups` to show optgroups by parent; `options` for a flat list. */
function SelectChoice<T extends string>({ label, value, options, groups, onChange, render }: {
  label: string; value: T; onChange: (v: T) => void; render?: (v: T) => string;
  options?: readonly T[]; groups?: Array<{ label: string; options: readonly T[] }>;
}) {
  const opt = (o: T) => <option key={String(o)} value={o}>{render ? render(o) : String(o)}</option>;
  const empty = (options?.length ?? 0) === 0 && !groups?.length;
  return (
    <label className="admin-pr-select">
      <span className="usage-dim">{label}</span>
      <select value={value} onChange={e => onChange(e.target.value as T)} aria-label={label}>
        {empty && <option value="">(none)</option>}
        {groups ? groups.map(g => <optgroup key={g.label} label={g.label}>{g.options.map(opt)}</optgroup>) : (options ?? []).map(opt)}
      </select>
    </label>
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
  const teams = useAdminPolled(useCallback(() => adminApi.prTeams(), []), 5 * 60_000);
  const status = useAdminPolled(useCallback(() => adminApi.prStatus(), []), 30_000);
  const [dimension, setDimension] = useState<'groups' | 'teams'>('groups');
  const [team, setTeam] = useState<string>('');
  const [group, setGroup] = useState<string>('');
  const [view, setView] = useState<PrView>('credited');
  const [basis, setBasis] = useState<PrBasis>('merged');
  const [win, setWin] = useState<PrWindow>(30);
  const [rwin, setRwin] = useState<PrWindow>(30);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ slug: string; name: string; text: string; isNew: boolean } | null>(null);
  const [teamEdit, setTeamEdit] = useState<{ key: string; name: string; parent: string; text: string; isNew: boolean } | null>(null);
  const [teamsNote, setTeamsNote] = useState<string | null>(null);

  useEffect(() => { if (!group && groups.data?.length) setGroup(groups.data[0].slug); }, [group, groups.data]);
  useEffect(() => { if (!team && teams.data?.length) setTeam((teams.data.find(t => !t.hidden) ?? teams.data[0]).key); }, [team, teams.data]);
  const g = groups.data?.find(x => x.slug === group) ?? null;
  const inTeam = dimension === 'teams' && !!team && !!group;
  /** The all-repos pseudo-group reports 0 repos; say "all repos" instead. */
  const scopeRepos = (n: number) => (inTeam && group === ALL_REPOS ? 'all repos' : repos(n));
  // A leftover `*` from the teams dimension must never reach a repo-group query.
  const effectiveGroup = dimension === 'groups' && group === ALL_REPOS ? (groups.data?.[0]?.slug ?? '') : group;
  const teamName = teams.data?.find(t => t.key === team)?.name ?? team;
  // 75 teams is a lot for one list: group them under their parent team, with the rest under "Top level".
  const teamGroups = useMemo(() => {
    const list = (teams.data ?? []).filter(t => !t.hidden);
    const byKey = new Map(list.map(t => [t.key, t]));
    const buckets = new Map<string, typeof list>();
    for (const t of list) {
      const parent = t.parent && byKey.has(t.parent) ? t.parent : '';
      buckets.set(parent, [...(buckets.get(parent) ?? []), t]);
    }
    return [...buckets.entries()].map(([parent, ts]) => ({ label: parent ? (byKey.get(parent)?.name ?? parent) : 'Top level', options: ts.map(t => t.key) }));
  }, [teams.data]);

  const summary = useAdminPolled(useCallback(() => {
    if (inTeam) return adminApi.prTeamSummary(team, effectiveGroup, view, basis);
    return effectiveGroup ? adminApi.prSummary(effectiveGroup, view, basis) : Promise.resolve(null);
  }, [inTeam, team, effectiveGroup, view, basis]), 5 * 60_000, { deps: [inTeam, team, effectiveGroup, view, basis] });
  const contrib = useAdminPolled(useCallback(() => {
    if (inTeam) return adminApi.prTeamMembers(team, effectiveGroup, view, basis, win);
    return effectiveGroup ? adminApi.prContributors(effectiveGroup, view, basis, win) : Promise.resolve(null);
  }, [inTeam, team, effectiveGroup, view, basis, win]), 5 * 60_000, { deps: [inTeam, team, effectiveGroup, view, basis, win] });
  const trend = useAdminPolled(useCallback(() => {
    if (inTeam) return adminApi.prTeamTrend(team, effectiveGroup, view, basis);
    return effectiveGroup ? adminApi.prTrend(effectiveGroup, view, basis) : Promise.resolve(null);
  }, [inTeam, team, effectiveGroup, view, basis]), 10 * 60_000, { deps: [inTeam, team, effectiveGroup, view, basis] });
  const teamRepos = useAdminPolled(useCallback(() => (inTeam ? adminApi.prTeamRepos(team, effectiveGroup, view, basis, win) : Promise.resolve(null)), [inTeam, team, effectiveGroup, view, basis, win]), 5 * 60_000, { deps: [inTeam, team, effectiveGroup, view, basis, win] });
  const reviewsGiven = useAdminPolled(useCallback(() => (inTeam ? adminApi.prTeamReviews(team, effectiveGroup, 'given') : Promise.resolve(null)), [inTeam, team, effectiveGroup]), 5 * 60_000, { deps: [inTeam, team, effectiveGroup] });
  const reviewsReceived = useAdminPolled(useCallback(() => (inTeam ? adminApi.prTeamReviews(team, effectiveGroup, 'received') : Promise.resolve(null)), [inTeam, team, effectiveGroup]), 5 * 60_000, { deps: [inTeam, team, effectiveGroup] });
  const reviewersGiven = useAdminPolled(useCallback(() => (inTeam ? adminApi.prTeamReviewers(team, effectiveGroup, 'given', rwin) : Promise.resolve(null)), [inTeam, team, effectiveGroup, rwin]), 5 * 60_000, { deps: [inTeam, team, effectiveGroup, rwin] });
  const reviewersReceived = useAdminPolled(useCallback(() => (inTeam ? adminApi.prTeamReviewers(team, effectiveGroup, 'received', rwin) : Promise.resolve(null)), [inTeam, team, effectiveGroup, rwin]), 5 * 60_000, { deps: [inTeam, team, effectiveGroup, rwin] });
  const teamRtrend = useAdminPolled(useCallback(() => (inTeam ? adminApi.prTeamReviewTrend(team, effectiveGroup) : Promise.resolve(null)), [inTeam, team, effectiveGroup]), 10 * 60_000, { deps: [inTeam, team, effectiveGroup] });
  const reviews = useAdminPolled(useCallback(() => (!inTeam && effectiveGroup ? adminApi.prReviews(effectiveGroup) : Promise.resolve(null)), [inTeam, effectiveGroup]), 5 * 60_000, { deps: [inTeam, effectiveGroup] });
  const reviewers = useAdminPolled(useCallback(() => (!inTeam && effectiveGroup ? adminApi.prReviewers(effectiveGroup, rwin) : Promise.resolve(null)), [inTeam, effectiveGroup, rwin]), 5 * 60_000, { deps: [inTeam, effectiveGroup, rwin] });
  const rtrend = useAdminPolled(useCallback(() => (!inTeam && effectiveGroup ? adminApi.prReviewTrend(effectiveGroup) : Promise.resolve(null)), [inTeam, effectiveGroup]), 10 * 60_000, { deps: [inTeam, effectiveGroup] });

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

  const reviewCols: Column<PrReviewWindow>[] = [
    { id: 'days', label: 'window', value: r => r.days, render: r => days(r.days) },
    { id: 'reviews', label: 'reviews', value: r => r.reviews, align: 'right', title: 'one person on one PR, however many rounds' },
    { id: 'reviewers', label: 'reviewers', value: r => r.distribution.contributors, align: 'right' },
    { id: 'p50', label: 'p50', value: r => r.distribution.p50, align: 'right', title: 'reviews per reviewer' },
    { id: 'p95', label: 'p95', value: r => r.distribution.p95, align: 'right' },
    { id: 'mean', label: 'mean', value: r => r.distribution.mean, align: 'right' },
    { id: 'max', label: 'max', value: r => r.distribution.max, align: 'right' },
    { id: 'approved', label: 'approved', value: r => r.approved, align: 'right' },
    { id: 'changes', label: 'changes asked', value: r => r.changesRequested, align: 'right' },
    { id: 'commentOnly', label: 'comments only', value: r => r.commentOnly, align: 'right' },
    { id: 'inline', label: 'inline comments', value: r => r.inlineComments, align: 'right', title: 'review comments by people' },
    { id: 'cp50', label: 'comments/PR p50', value: r => r.mergedComments.p50, align: 'right', title: 'comments by people per PR merged in the window, conversation plus inline' },
    { id: 'cp95', label: 'p95', value: r => r.mergedComments.p95, align: 'right' },
    { id: 'cmax', label: 'max', value: r => r.mergedComments.max, align: 'right' },
    { id: 'bots', label: 'by bots', value: r => r.mergedComments.botShare, align: 'right', render: r => fmtPct(r.mergedComments.botShare), title: 'share of the comments on those PRs that bots wrote' },
  ];
  const reviewerCols: Column<PrReviewer & { rank: number }>[] = [
    { id: 'rank', label: '#', value: r => r.rank, align: 'right' },
    { id: 'login', label: 'reviewer', value: r => r.login, render: r => <span>{r.login}{r.termag ? <span className="workstream-bar-badge" title={`termag user ${r.termag.unixUsername}`}>termag</span> : null}</span> },
    { id: 'reviews', label: 'reviews', value: r => r.reviews, align: 'right' },
    { id: 'deciding', label: 'deciding approvals', value: r => r.decidingApprovals, align: 'right', title: 'merged PRs where theirs was the last human approval before the merge' },
    { id: 'stale', label: 'stale PRs picked up', value: r => r.stalePickups, align: 'right', title: 'PRs they reviewed first, after the PR had waited 3 days or more since it was ready' },
    { id: 'firstReview', label: 'to first review', value: r => r.medianHoursToFirstReview, align: 'right', render: r => (r.askedReviews ? `${fmtHours(r.medianHoursToFirstReview)} (${r.askedReviews})` : '—'),
      title: 'median time from being asked by name to their first review, over the reviews they were asked for (count in brackets); team requests and unasked reviews are not timed' },
    { id: 'authors', label: 'authors helped', value: r => r.authorsHelped, align: 'right' },
    { id: 'approved', label: 'approved', value: r => r.approved, align: 'right' },
    { id: 'changes', label: 'changes asked', value: r => r.changesRequested, align: 'right' },
    { id: 'commentOnly', label: 'comments only', value: r => r.commentOnly, align: 'right' },
    { id: 'inline', label: 'inline comments', value: r => r.inlineComments, align: 'right' },
  ];
  // Given reviews: the review-side columns only (comments-per-PR and the approval split are about the PRs).
  const givenReviewCols: Column<PrReviewWindow>[] = reviewCols.filter(c => !['cp50', 'cp95', 'cmax', 'bots'].includes(c.id));
  // Received reviews include bots: show their class, so they can be told apart and filtered.
  const teamReviewerCols: Column<PrReviewer & { rank: number }>[] = [reviewerCols[0], { id: 'cls', label: 'class', value: r => r.cls, title: 'human, agent or automation' }, ...reviewerCols.slice(1)];
  const agentCols: Column<PrReviewWindow>[] = [
    { id: 'days', label: 'window', value: r => r.days, render: r => days(r.days) },
    { id: 'merged', label: 'merged', value: r => r.agent.merged, align: 'right', title: 'in repos where the agent has approved' },
    { id: 'agentOnly', label: 'agent only', value: r => r.agent.agentOnly, align: 'right', render: r => ofMerged(r.agent.agentOnly, r.agent.merged), title: 'approved by the agent, no human approval before the merge' },
    { id: 'both', label: 'human + agent', value: r => r.agent.humanAndAgent, align: 'right', render: r => ofMerged(r.agent.humanAndAgent, r.agent.merged) },
    { id: 'human', label: 'human only', value: r => r.agent.humanOnly, align: 'right', render: r => ofMerged(r.agent.humanOnly, r.agent.merged) },
    { id: 'none', label: 'unapproved', value: r => r.agent.none, align: 'right', render: r => ofMerged(r.agent.none, r.agent.merged), title: 'merged with no approval before the merge' },
    { id: 'unread', label: 'reviews not read', value: r => r.agent.unread, align: 'right', title: 'merged PRs whose reviews the backfill has not read yet, or with more than 100 reviews, left out' },
  ];
  const rv = reviews.data; const rs = reviewers.data; const rt = rtrend.data;
  const rg = reviewsGiven.data; const rr = reviewsReceived.data; const rgs = reviewersGiven.data; const rrs = reviewersReceived.data; const rtt = teamRtrend.data;

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
          ['reviews', `${st.reviewsBackfilled} of ${st.backfilled} backfilled repos have reviews (${st.reviewDays} days of history)`],
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
        <Choice label="dimension" value={dimension} options={['groups', 'teams'] as const} onChange={d => { setDimension(d); if (d === 'teams') setGroup(ALL_REPOS); else if (group === ALL_REPOS) setGroup(groups.data?.[0]?.slug ?? ''); }} render={d => d === 'groups' ? 'repo groups' : 'teams'} />
        <SelectChoice label="repo group" value={group} options={dimension === 'teams' ? [ALL_REPOS, ...(groups.data ?? []).map(x => x.slug)] : (groups.data ?? []).map(x => x.slug)} onChange={setGroup} render={slug => slug === ALL_REPOS ? 'all repos' : groups.data?.find(x => x.slug === slug)?.name ?? slug} />
        {dimension === 'teams' && <SelectChoice label="team" value={team} groups={teamGroups} onChange={setTeam} render={k => teams.data?.find(t => t.key === k)?.name ?? k} />}
        <Choice label="view" value={view} options={['credited', 'humans', 'all'] as const} onChange={setView} render={v => VIEW_LABEL[v]} />
        <Choice label="count" value={basis} options={['merged', 'opened'] as const} onChange={setBasis} />
      </div>

      <ChartCard title={inTeam ? `${teamName} in ${g?.name ?? group}: PRs and members` : g ? `${g.name}: PRs and contributors` : 'PRs and contributors'}
        subtitle={s ? `${inTeam && group === ALL_REPOS ? 'all repos' : `${s.repos} repos`} · ${inTeam ? 'the team roster (sub-teams included)' : VIEW_HELP[view]} · rolling windows ending now` : pendingText(summary)} stale={summary.loading}>
        <DataTable rows={s?.windows ?? []} columns={sumCols} rowKey={r => String(r.days)} defaultSort="days" defaultDesc={false} dense empty={s ? 'no PRs yet' : pendingText(summary)} />
      </ChartCard>

      <ChartCard title={inTeam ? 'Members' : 'Top contributors'} subtitle={c ? (inTeam ? `${c.contributors} on the team, ${c.total} PRs ${basisWord} in ${c.days} day${c.days === 1 ? '' : 's'} (zeros included)` : `${c.contributors} contributors, ${c.total} PRs ${basisWord} in ${c.days} day${c.days === 1 ? '' : 's'}`) : pendingText(contrib)} stale={contrib.loading}>
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
            <Tooltip cursor={CURSOR} content={<DashTooltip fmt={v => String(v)} />} />
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

      {inTeam && <ChartCard title="PRs by repo" subtitle={teamRepos.data ? `${teamRepos.data.repos.length} repos · PRs ${basisWord} by the team in ${teamRepos.data.days} day${teamRepos.data.days === 1 ? '' : 's'}` : pendingText(teamRepos)} stale={teamRepos.loading}>
        <DataTable rows={(teamRepos.data?.repos ?? []).map((r, i) => ({ ...r, rank: i + 1 }))} columns={[
          { id: 'rank', label: '#', value: r => r.rank, align: 'right' },
          { id: 'repo', label: 'repo', value: r => r.repo },
          { id: 'prs', label: `PRs ${basisWord}`, value: r => r.prs, align: 'right' },
          { id: 'contributors', label: 'contributors', value: r => r.contributors, align: 'right' },
        ]} rowKey={r => r.repo} defaultSort="rank" defaultDesc={false} dense empty={teamRepos.data ? 'no PRs in this window' : pendingText(teamRepos)} />
      </ChartCard>}

      {inTeam && <>
        <ChartCard title="Reviews given" subtitle={rg ? `${scopeRepos(rg.repos)} · reviews by the team (sub-teams included) · rolling windows ending now` : pendingText(reviewsGiven)} stale={reviewsGiven.loading}>
          <DataTable rows={rg?.windows ?? []} columns={givenReviewCols} rowKey={r => String(r.days)} defaultSort="days" defaultDesc={false} dense empty={rg ? 'no reviews yet' : pendingText(reviewsGiven)} />
        </ChartCard>

        <ChartCard title="Members as reviewers" subtitle={rgs ? `${rgs.reviewers} on the team, ${rgs.reviews} reviews in ${days(rgs.days)} (zeros included)` : pendingText(reviewersGiven)} stale={reviewersGiven.loading}>
          <Choice label="review window" value={rwin} options={[1, 7, 30] as const} onChange={setRwin} render={d => `${d}d`} />
          <DataTable rows={(rgs?.top ?? []).map((r, i) => ({ ...r, rank: i + 1 }))} columns={reviewerCols} rowKey={r => r.login} defaultSort="rank" defaultDesc={false} dense empty={rgs ? 'no reviewers on the team' : pendingText(reviewersGiven)} />
        </ChartCard>

        <ChartCard title="Reviews received" subtitle={rr ? `${scopeRepos(rr.repos)} · reviews on the team's PRs, all reviewers · rolling windows ending now` : pendingText(reviewsReceived)} stale={reviewsReceived.loading}>
          <DataTable rows={rr?.windows ?? []} columns={reviewCols} rowKey={r => String(r.days)} defaultSort="days" defaultDesc={false} dense empty={rr ? 'no reviews yet' : pendingText(reviewsReceived)} />
        </ChartCard>

        <ChartCard title="Who reviewed the team" subtitle={rrs ? `${rrs.reviewers} reviewers, ${rrs.reviews} reviews in ${days(rrs.days)}` : pendingText(reviewersReceived)} stale={reviewersReceived.loading}>
          <Choice label="review window" value={rwin} options={[1, 7, 30] as const} onChange={setRwin} render={d => `${d}d`} />
          <DataTable rows={(rrs?.top ?? []).map((r, i) => ({ ...r, rank: i + 1 }))} columns={teamReviewerCols} rowKey={r => r.login} defaultSort="rank" defaultDesc={false} dense empty={rrs ? 'no reviews in this window' : pendingText(reviewersReceived)} />
        </ChartCard>

        <ChartCard title="Weekly reviews (given / received)" subtitle={rtt ? 'reviews the team gave (by its members) and received (on its PRs) per week (Monday, UTC), and the reviewers on each side' : pendingText(teamRtrend)} stale={teamRtrend.loading}
          table={rtt ? { columns: ['week', 'given', 'received', 'reviewers given', 'reviewers received'], rows: rtt.rows.map(r => [r.week, r.given, r.received, r.reviewersGiven, r.reviewersReceived]) } : undefined}>
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <ComposedChart data={(rtt?.rows ?? []).map(r => ({ ...r, label: shortDate(r.week) }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
              <CartesianGrid vertical={false} stroke={GRID_STROKE} />
              <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
              <YAxis yAxisId="reviews" tick={TICK} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
              <Tooltip cursor={CURSOR} content={<DashTooltip fmt={v => String(v)} />} />
              <Line yAxisId="reviews" type="monotone" dataKey="given" name="given" stroke={CLASS_COLOR.human} strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line yAxisId="reviews" type="monotone" dataKey="received" name="received" stroke={CLASS_COLOR.agent} strokeWidth={2} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <SeriesLegend series={[
            { id: 'g', label: 'given by the team', color: CLASS_COLOR.human },
            { id: 'r', label: 'received on its PRs', color: CLASS_COLOR.agent },
          ]} />
        </ChartCard>
      </>}

      {!inTeam && (<>
        <ChartCard title="Reviews" subtitle={rv ? `${repos(rv.repos)} · every PR in the group, people as reviewers (never the author) · rolling windows ending now` : pendingText(reviews)} stale={reviews.loading}>
        <DataTable rows={rv?.windows ?? []} columns={reviewCols} rowKey={r => String(r.days)} defaultSort="days" defaultDesc={false} dense empty={rv ? 'no reviews yet' : pendingText(reviews)} />
      </ChartCard>

      <ChartCard title="Top reviewers" subtitle={rs ? `${rs.reviewers} reviewers, ${rs.reviews} reviews in ${days(rs.days)}` : pendingText(reviewers)} stale={reviewers.loading}>
        <Choice label="review window" value={rwin} options={[1, 7, 30] as const} onChange={setRwin} render={d => `${d}d`} />
        <DataTable rows={(rs?.top ?? []).map((r, i) => ({ ...r, rank: i + 1 }))} columns={reviewerCols} rowKey={r => r.login} defaultSort="rank" defaultDesc={false} dense empty={rs ? 'no reviews in this window' : pendingText(reviewers)} />
      </ChartCard>

      <ChartCard title="Approval agent" subtitle={rv ? `merged PRs by how they were approved, in the ${repos(rv.windows[0]?.agent.repos ?? 0)} where ${rv.approvalAgentLogins.join(', ')} has approved` : pendingText(reviews)} stale={reviews.loading}>
        <DataTable rows={rv?.windows ?? []} columns={agentCols} rowKey={r => String(r.days)} defaultSort="days" defaultDesc={false} dense empty={rv ? 'no merged PRs yet' : pendingText(reviews)} />
      </ChartCard>

      <ChartCard title="Weekly reviews" subtitle={rt ? 'merged PRs per week (Monday, UTC) by approval, in the agent\'s repos, and reviewers in the group' : pendingText(rtrend)} stale={rtrend.loading}
        table={rt ? { columns: ['week', 'agent only', 'human-approved', 'unapproved', 'reviews', 'reviewers'], rows: rt.rows.map(r => [r.week, r.agentOnly, r.humanApproved, r.unapproved, r.reviews, r.reviewers]) } : undefined}>
        <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
          <ComposedChart data={(rt?.rows ?? []).map(r => ({ ...r, label: shortDate(r.week) }))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="20%">
            <CartesianGrid vertical={false} stroke={GRID_STROKE} />
            <XAxis dataKey="label" tick={TICK} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={24} />
            <YAxis yAxisId="prs" tick={TICK} tickLine={false} axisLine={false} width={36} allowDecimals={false} />
            <YAxis yAxisId="people" orientation="right" tick={TICK} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
            <Tooltip cursor={CURSOR} content={<DashTooltip fmt={v => String(v)} />} />
            <Bar yAxisId="prs" dataKey="agentOnly" name="agent only" stackId="a" fill={APPROVAL_COLOR.agentOnly} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
            <Bar yAxisId="prs" dataKey="humanApproved" name="human-approved" stackId="a" fill={APPROVAL_COLOR.humanApproved} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
            <Bar yAxisId="prs" dataKey="unapproved" name="unapproved" stackId="a" fill={APPROVAL_COLOR.unapproved} stroke={SURFACE} strokeWidth={1} maxBarSize={BAR_MAX} isAnimationActive={false} />
            <Line yAxisId="people" type="monotone" dataKey="reviewers" name="reviewers" stroke={CONTRIB_COLOR} strokeWidth={2} dot={false} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
        <SeriesLegend series={[
          { id: 'a', label: 'agent only', color: APPROVAL_COLOR.agentOnly }, { id: 'h', label: 'human-approved', color: APPROVAL_COLOR.humanApproved },
          { id: 'u', label: 'unapproved', color: APPROVAL_COLOR.unapproved }, { id: 'r', label: 'reviewers (right axis)', color: CONTRIB_COLOR },
        ]} />
      </ChartCard>
      </>)}

      <ChartCard title="Repo groups" subtitle="one member per line: repo owner/name · topic name [org] · pattern owner/glob · path owner/name file-glob (with share owner/name 20% and key owner/name AIC) · exclude owner/name" stale={groups.loading}>
        <div className="dash-rows">
          {(groups.data ?? []).map((x: PrGroup) => (
            <div className="dash-row" key={x.slug}>
              <span className="dash-row-label">{x.name}</span>
              <span className="usage-dim">{x.repos.length} repos · {x.repos.reduce((n, r) => n + r.prs, 0).toLocaleString()} PRs · {groupSummary(x)}</span>
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

      <ChartCard title="Teams" subtitle="one GitHub login per line; the roster scopes the team view (sub-teams roll up)" stale={teams.loading}>
        <div className="dash-rows">
          {(teams.data ?? []).map(t => (
            <div className="dash-row" key={t.key}>
              <span className="dash-row-label">{t.name}</span>
              <span className="usage-dim">{t.members.length} current{t.manual.length ? ` · ${t.manual.length} manual` : ''}{t.former ? ` · ${t.former} former` : ''}{t.parent ? ` · under ${t.parent}` : ''}{t.hidden ? ' · hidden' : ''}</span>
              <button type="button" className="btn-ghost btn-tiny" style={{ marginLeft: 'auto' }} onClick={() => setTeamEdit({ key: t.key, name: t.name, parent: t.parent ?? '', text: teamToText(t.manual), isNew: false })}>edit</button>
            </div>
          ))}
        </div>
        {!teamEdit && <>
          <button type="button" className="btn-ghost btn-tiny" onClick={() => setTeamEdit({ key: '', name: '', parent: '', text: '', isNew: true })}>add team</button>
          <button type="button" className="btn-ghost btn-tiny" style={{ marginLeft: '0.5rem' }} onClick={() => void act(() => adminApi.syncPrTeams(), () => { teams.refresh(); setTimeout(teams.refresh, 2500); })}>sync from org-tree</button>
          {/* The org-tree's teams-export.json, for a deployment that reaches neither the export file nor the API. */}
          <label className="btn-ghost btn-tiny" style={{ marginLeft: '0.5rem', cursor: 'pointer' }} title="Sync from the org-tree's teams-export.json">
            import export…
            <input type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={e => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              setTeamsNote(null);
              void act(async () => {
                const parsed = parseTeamsExportFile(await file.text());
                if ('error' in parsed) throw new Error(parsed.error);
                const r = await adminApi.importPrTeams(parsed.json);
                setTeamsNote(importedTeamsNote(r));
              }, () => teams.refresh());
            }} />
          </label>
          {teamsNote && <span className="usage-dim" style={{ marginLeft: '0.5rem' }}>{teamsNote}</span>}
        </>}
        {teamEdit && (
          <div className="admin-pr-editor">
            <div className="admin-form">
              <input value={teamEdit.key} disabled={!teamEdit.isNew} onChange={e => setTeamEdit({ ...teamEdit, key: e.target.value })} placeholder="key (e.g. platform-team)" />
              <input value={teamEdit.name} onChange={e => setTeamEdit({ ...teamEdit, name: e.target.value })} placeholder="name" />
              <input value={teamEdit.parent} onChange={e => setTeamEdit({ ...teamEdit, parent: e.target.value })} placeholder="parent team key (optional)" />
            </div>
            <textarea className="admin-mono" rows={6} value={teamEdit.text} onChange={e => setTeamEdit({ ...teamEdit, text: e.target.value })} placeholder={'octocat\nfirst-last\nhubot'} />
            <div className="admin-form">
              <button type="button" className="btn-ghost btn-tiny" onClick={() => {
                const parsed = textToMembers(teamEdit.text);
                if ('error' in parsed) { setErr(parsed.error); return; }
                const key = teamEdit.key.trim().toLowerCase();
                const existing = teams.data?.find(t => t.key === key);
                const sort = existing?.sort ?? 100;
                void act(() => adminApi.savePrTeam({ key, name: teamEdit.name.trim() || key, parent: teamEdit.parent.trim().toLowerCase() || null, hidden: existing?.hidden ?? false, sort, members: parsed.members }), () => { setTeamEdit(null); teams.refresh(); setTeam(key); setDimension('teams'); });
              }}>save</button>
              {!teamEdit.isNew && <button type="button" className="btn-ghost btn-tiny" onClick={() => { if (window.confirm(`Delete the ${teamEdit.name} team? Its PRs stay stored.`)) void act(() => adminApi.deletePrTeam(teamEdit.key), () => { setTeamEdit(null); teams.refresh(); setTeam(''); }); }}>delete</button>}
              <button type="button" className="btn-ghost btn-tiny" onClick={() => setTeamEdit(null)}>cancel</button>
              <span className="usage-dim">Members are GitHub logins. Effective dates come from the org-tree sync (a later step); until then the roster is approximate.</span>
            </div>
          </div>
        )}
      </ChartCard>
    </>
  );
}
